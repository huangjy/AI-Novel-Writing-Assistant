import { getLines, getMessages } from "@langchain/core/utils/event_source_parse";
import type { CopilotModel } from "@ai-novel/shared/types/authorization";
import { z } from "zod";
import { AccountRequestQueue } from "./AccountRequestQueue";
import { createCopilotRequestHeaders } from "./CopilotRequestHeaders";
import { SubscriptionError } from "./SubscriptionError";

export const SUBSCRIPTION_BASE_URL = "https://copilot.internal.invalid/v1";
export interface SubscriptionAccess {
  token: string;
  origin: string;
  expiresAt: number;
  revision: number;
}
export interface SubscriptionPort {
  access(signal?: AbortSignal): Promise<SubscriptionAccess>;
  model(id: string): Promise<CopilotModel>;
  assertBinding(provider: string, revision: number): Promise<void>;
  invalidateToken(): void;
  onInvalidated(listener: () => void): () => void;
}

function upstreamOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || (url.hostname !== "api.githubcopilot.com" && !url.hostname.endsWith(".githubcopilot.com"))) {
    throw new SubscriptionError("COPILOT_INVALID_UPSTREAM", "Copilot 服务地址不受支持。", 502);
  }
  return url.origin;
}

export class SubscriptionProxy {
  private readonly controllers = new Set<AbortController>();
  private readonly queue: AccountRequestQueue;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly port: SubscriptionPort,
    private readonly fetcher: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.queue = new AccountRequestQueue(now);
    this.unsubscribe = port.onInvalidated(() => {
      for (const controller of this.controllers) {
        controller.abort(new SubscriptionError("COPILOT_AUTH_REQUIRED", "授权状态已变化，请重新选择可用账户。", 409));
      }
    });
  }

  close(): void {
    this.unsubscribe();
    for (const controller of this.controllers) controller.abort();
  }

  fetchFor(provider: string, expectedModel: string, timeoutMs?: number,
    verifiedCapabilities?: Pick<CopilotModel, "supportsTools" | "supportsStructuredOutput">): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== new URL(SUBSCRIPTION_BASE_URL).origin || request.method !== "POST"
        || !["/v1/chat/completions", "/v1/responses"].includes(url.pathname) || url.search) {
        throw new SubscriptionError("COPILOT_MODEL_UNSUPPORTED", "该订阅连接只支持项目内的文本模型请求。");
      }
      const parsed = z.object({
        model: z.string().min(1), stream: z.boolean().optional(), tools: z.array(z.unknown()).optional(),
        response_format: z.object({ type: z.string() }).passthrough().optional(),
      }).passthrough().safeParse(await request.json());
      if (!parsed.success || parsed.data.model !== expectedModel) {
        throw new SubscriptionError("COPILOT_MODEL_UNSUPPORTED", "订阅请求的模型或参数不匹配。");
      }
      const body = parsed.data;
      const model = await this.port.model(expectedModel);
      const expectedPath = model.transport === "chat" ? "/v1/chat/completions" : model.transport === "responses" ? "/v1/responses" : null;
      if (url.pathname !== expectedPath || (body.tools?.length && !(verifiedCapabilities?.supportsTools ?? model.supportsTools))
        || (body.response_format?.type === "json_schema" && !(verifiedCapabilities?.supportsStructuredOutput ?? model.supportsStructuredOutput))) {
        throw new SubscriptionError("COPILOT_MODEL_UNSUPPORTED", "该模型不支持所选协议或输出能力，请选择其他可用模型。");
      }
      const controller = new AbortController();
      const deadline = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(
        new SubscriptionError("COPILOT_STREAM_INTERRUPTED", "Copilot 生成等待超时，请稍后重试。", 504),
      ), timeoutMs) : undefined;
      const abort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      this.controllers.add(controller);
      let release: (() => void) | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let finished = false;
      const started = Date.now();
      let queueWaitMs = 0;
      let outcome = "failed";
      let errorCode: string | undefined;
      let httpStatus: number | undefined;
      const finish = async () => {
        if (finished) return;
        finished = true;
        if (deadline) clearTimeout(deadline);
        request.signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", onAbort);
        this.controllers.delete(controller);
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
        release?.();
        const reason = controller.signal.reason;
        console.info("[subscription.request]", JSON.stringify({
          provider, model: expectedModel, outcome: controller.signal.aborted ? "cancelled" : outcome,
          code: errorCode ?? (reason instanceof SubscriptionError ? reason.code : undefined),
          httpStatus, transport: model.transport, queueWaitMs, durationMs: Date.now() - started,
        }));
      };
      const onAbort = () => { void finish(); };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        release = await this.queue.acquire(controller.signal);
        if (finished) release();
        queueWaitMs = Date.now() - started;
        controller.signal.throwIfAborted();
        const access = await this.port.access(controller.signal);
        await this.port.assertBinding(provider, access.revision);
        controller.signal.throwIfAborted();
        const path = model.supportedEndpoints.find(endpoint => model.transport === "chat"
          ? endpoint === "/chat/completions" || endpoint === "/v1/chat/completions"
          : endpoint === "/responses" || endpoint === "/v1/responses");
        if (!path) throw new SubscriptionError("COPILOT_MODEL_UNSUPPORTED", "模型没有可用的文本传输端点。");
        // Copilot Responses rejects the sampling temperature supplied by the generic SDK.
        const upstreamBody = model.transport === "responses" ? { ...body, temperature: undefined } : body;
        const response = await this.fetcher(`${upstreamOrigin(access.origin)}${path}`, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: {
            ...createCopilotRequestHeaders(),
            Authorization: `Bearer ${access.token}`, "Content-Type": "application/json",
            Accept: body.stream ? "text/event-stream" : "application/json",
          },
          body: JSON.stringify(upstreamBody),
        });
        httpStatus = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401) {
            this.port.invalidateToken();
            throw new SubscriptionError("COPILOT_AUTH_REQUIRED", "Copilot 令牌失效，请重试；持续失败时请重新授权。", 409);
          }
          if (response.status === 429) {
            this.queue.coolDown(response.headers.get("retry-after"));
            throw new SubscriptionError("COPILOT_RATE_LIMITED", "Copilot 请求受限，请等待额度恢复后重试。", 429);
          }
          if (response.status === 403) throw new SubscriptionError("COPILOT_ACCESS_DENIED", "Copilot 拒绝访问，请检查订阅、模型权限和组织策略。", 403);
          throw new SubscriptionError("COPILOT_MODEL_UNSUPPORTED", "Copilot 拒绝了模型请求，请刷新模型并检查模型能力。", response.status);
        }
        if (!response.body) throw new SubscriptionError("COPILOT_STREAM_INTERRUPTED", "模型响应为空，请重试。", 502);
        reader = response.body.getReader();
        let terminal = !body.stream;
        const decoder = new TextDecoder();
        let jsonText = "";
        const parseEvents = getLines(getMessages(event => {
          if (event.data === "[DONE]" && model.transport === "chat") { terminal = true; return; }
          if (!event.data) return;
          let value: { type?: string; error?: unknown; response?: { status?: string } };
          try { value = JSON.parse(event.data); } catch {
            throw new SubscriptionError("COPILOT_STREAM_INTERRUPTED", "Copilot 返回了无法读取的流式响应，请重试。", 502);
          }
          if (value.error || value.type === "error" || value.type === "response.failed" || value.type === "response.incomplete") {
            throw new SubscriptionError("COPILOT_STREAM_INTERRUPTED", "Copilot 生成中断，请检查模型状态后重试。", 502);
          }
          if (value.type === "response.completed" && value.response?.status === "completed") terminal = true;
        }));
        const stream = new ReadableStream<Uint8Array>({
          pull: async output => {
            try {
              controller.signal.throwIfAborted();
              const next = await reader!.read();
              controller.signal.throwIfAborted();
              if (next.done) {
                if (body.stream) parseEvents(new Uint8Array(), true);
                else {
                  try {
                    const value = JSON.parse(jsonText + decoder.decode());
                    if (!value || typeof value !== "object" || value.error) throw new Error();
                  } catch {
                    throw new SubscriptionError("COPILOT_STREAM_INTERRUPTED", "Copilot 返回了无法读取的响应，请重试。", 502);
                  }
                }
                if (!terminal) throw new SubscriptionError("COPILOT_STREAM_INTERRUPTED", "模型流在完成前断开，请重试。", 502);
                outcome = "success";
                await finish(); output.close();
              } else {
                if (body.stream) parseEvents(next.value);
                else {
                  jsonText += decoder.decode(next.value, { stream: true });
                  if (jsonText.length > 32 * 1024 * 1024) {
                    throw new SubscriptionError("COPILOT_STREAM_INTERRUPTED", "Copilot 响应超过安全读取上限，请缩小生成范围。", 502);
                  }
                }
                output.enqueue(next.value);
              }
            } catch (error) {
              const safe = controller.signal.aborted ? controller.signal.reason
                : error instanceof SubscriptionError ? error
                  : new SubscriptionError("COPILOT_STREAM_INTERRUPTED", "Copilot 响应流无法继续读取，请重试。", 502);
              errorCode = safe instanceof SubscriptionError ? safe.code : "COPILOT_STREAM_INTERRUPTED";
              await finish(); output.error(safe);
            }
          },
          cancel: async reason => {
            if (body.stream && terminal) outcome = "success";
            if (!terminal) controller.abort(reason);
            await finish();
          },
        }, { highWaterMark: 0 });
        return new Response(stream, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? (body.stream ? "text/event-stream" : "application/json") },
        });
      } catch (error) {
        errorCode = error instanceof SubscriptionError ? error.code : "COPILOT_UPSTREAM_UNAVAILABLE";
        await finish();
        if (error instanceof SubscriptionError || controller.signal.aborted) throw controller.signal.reason ?? error;
        throw new SubscriptionError("COPILOT_UPSTREAM_UNAVAILABLE", "Copilot 连接失败，请稍后重试。", 502);
      }
    };
  }
}
