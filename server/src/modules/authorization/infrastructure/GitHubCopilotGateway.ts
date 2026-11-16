import { z } from "zod";
import type { CopilotModel } from "@ai-novel/shared/types/authorization";
import { CopilotError, authorizationRequired, type CopilotAccess, type CopilotGateway } from "../domain/contracts";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const deviceSchema = z.object({
  device_code: z.string().min(1), user_code: z.string().min(1),
  verification_uri: z.string().url(), expires_in: z.number().positive(), interval: z.number().positive().default(5),
});
const tokenSchema = z.object({ token: z.string().min(1), expires_at: z.number().positive() });
const userSchema = z.object({ id: z.union([z.number(), z.string()]), login: z.string().min(1) });
const modelSchema = z.object({
  id: z.string().min(1), name: z.string().nullish(), model_picker_enabled: z.boolean().optional(),
  supported_endpoints: z.array(z.string()).default([]).catch([]),
  capabilities: z.object({
    type: z.string().optional(),
    limits: z.object({
      max_prompt_tokens: z.number().positive().optional().catch(undefined),
      max_context_window_tokens: z.number().positive().optional().catch(undefined),
      max_output_tokens: z.number().positive().optional().catch(undefined),
    }).nullish(),
    supports: z.object({
      tool_calls: z.boolean().optional().catch(undefined), parallel_tool_calls: z.boolean().optional().catch(undefined),
      structured_outputs: z.boolean().optional().catch(undefined), reasoning_effort: z.array(z.string()).optional().catch(undefined),
    }).nullish(),
  }).nullish(),
});

export function validateCopilotOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || (url.hostname !== "api.githubcopilot.com" && !url.hostname.endsWith(".githubcopilot.com"))
      || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new CopilotError("COPILOT_INVALID_UPSTREAM", "Copilot 返回了不受支持的服务地址。", 502);
  }
}

export function parseCopilotModels(payload: unknown): CopilotModel[] {
  const parsed = z.object({ data: z.array(modelSchema).max(5000) }).safeParse(payload);
  if (!parsed.success) throw new CopilotError("COPILOT_CATALOG_INVALID", "模型目录格式无法识别，请刷新模型后重试。", 502);
  const seen = new Set<string>();
  return parsed.data.data.filter(model => {
    if (seen.has(model.id) || model.model_picker_enabled === false) return false;
    seen.add(model.id);
    return model.capabilities?.type !== "embeddings";
  }).map(model => {
    const paths = model.supported_endpoints;
    const supports = model.capabilities?.supports;
    const limits = model.capabilities?.limits;
    return {
      id: model.id, name: model.name ?? model.id, supportedEndpoints: paths,
      transport: paths.some(p => p === "/chat/completions" || p === "/v1/chat/completions") ? "chat"
        : paths.some(p => p === "/responses" || p === "/v1/responses") ? "responses" : null,
      supportsTools: supports?.tool_calls === true || supports?.parallel_tool_calls === true,
      supportsStructuredOutput: supports?.structured_outputs === true,
      reasoningEfforts: supports?.reasoning_effort ?? [],
      maxContext: limits?.max_prompt_tokens ?? limits?.max_context_window_tokens,
      maxOutputTokens: limits?.max_output_tokens,
    };
  });
}

export class GitHubCopilotGateway implements CopilotGateway {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      const response = await this.fetcher(url, {
        ...init, signal, redirect: "error",
        headers: { Accept: "application/json", "User-Agent": "AI-Novel-Writing-Assistant", ...init.headers },
      });
      if (response.status === 401) throw authorizationRequired();
      if (response.status === 403) throw new CopilotError("COPILOT_ACCESS_DENIED", "GitHub Copilot 拒绝访问，请检查订阅与组织授权。", 403);
      if (!response.ok) throw new CopilotError("COPILOT_UPSTREAM_UNAVAILABLE", "GitHub Copilot 暂时无法连接，请稍后重试。", 502);
      const text = await response.text();
      if (text.length > 4_000_000) throw new Error();
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof CopilotError) throw error;
      if (init.signal?.aborted) throw init.signal.reason;
      throw new CopilotError("COPILOT_UPSTREAM_UNAVAILABLE", "GitHub Copilot 暂时无法连接，请稍后重试。", 502);
    }
  }

  async startDevice(signal?: AbortSignal) {
    const parsed = deviceSchema.safeParse(await this.json("https://github.com/login/device/code", {
      method: "POST", signal, body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }),
    }));
    if (!parsed.success) throw new CopilotError("COPILOT_DEVICE_INVALID", "无法获取 GitHub 登录信息，请重新发起登录。", 502);
    const value = parsed.data;
    const uri = new URL(value.verification_uri);
    if (uri.origin !== "https://github.com" || uri.username || uri.password || uri.search || uri.hash) {
      throw new CopilotError("COPILOT_DEVICE_INVALID", "GitHub 验证地址无法识别，请重新发起登录。", 502);
    }
    return {
      deviceCode: value.device_code, userCode: value.user_code, verificationUri: uri.href,
      expiresIn: Math.min(value.expires_in, 1800), interval: Math.max(value.interval, 1),
    };
  }

  async pollDevice(code: string, signal?: AbortSignal) {
    const parsed = z.object({
      access_token: z.string().min(1).optional(), error: z.string().optional(),
    }).safeParse(await this.json("https://github.com/login/oauth/access_token", {
      method: "POST", signal, body: new URLSearchParams({
        client_id: CLIENT_ID, device_code: code, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }));
    if (!parsed.success) throw new CopilotError("COPILOT_DEVICE_INVALID", "GitHub 登录响应无法识别。", 502);
    const value = parsed.data;
    if (value.error === "authorization_pending") return { pending: true };
    if (value.error === "slow_down") return { pending: true, slowDown: true };
    if (value.error === "access_denied") throw new CopilotError("COPILOT_LOGIN_DENIED", "GitHub 授权被拒绝，请重新登录。");
    if (value.error === "expired_token") throw new CopilotError("COPILOT_LOGIN_EXPIRED", "登录码已过期，请重新发起登录。");
    if (!value.access_token) throw new CopilotError("COPILOT_LOGIN_FAILED", "GitHub 登录未完成，请重新发起登录。");
    return { token: value.access_token };
  }

  async user(token: string, signal?: AbortSignal) {
    const value = userSchema.safeParse(await this.json("https://api.github.com/user", {
      signal, headers: { Authorization: `token ${token}` },
    }));
    if (!value.success) throw new CopilotError("COPILOT_USER_INVALID", "无法确认 GitHub 账户身份。", 502);
    return { id: String(value.data.id), login: value.data.login };
  }

  async exchange(token: string, signal?: AbortSignal) {
    const headers = { Authorization: `token ${token}` };
    const value = tokenSchema.safeParse(await this.json("https://api.github.com/copilot_internal/v2/token", { signal, headers }));
    if (!value.success || value.data.expires_at * 1000 <= Date.now()) {
      throw new CopilotError("COPILOT_TOKEN_INVALID", "无法取得有效的 Copilot 令牌，请检查订阅后重新授权。", 502);
    }
    const metadata = z.object({ endpoints: z.object({ api: z.string() }).optional() }).safeParse(
      await this.json("https://api.github.com/copilot_internal/user", { signal, headers }),
    );
    if (!metadata.success) throw new CopilotError("COPILOT_ENDPOINT_INVALID", "无法确认 Copilot 服务地址。", 502);
    return {
      token: value.data.token, expiresAt: value.data.expires_at * 1000,
      origin: validateCopilotOrigin(metadata.data.endpoints?.api ?? "https://api.githubcopilot.com"),
    };
  }

  async models(access: CopilotAccess, signal?: AbortSignal) {
    return parseCopilotModels(await this.json(`${validateCopilotOrigin(access.origin)}/models`, {
      signal, headers: { Authorization: `Bearer ${access.token}` },
    }));
  }
}
