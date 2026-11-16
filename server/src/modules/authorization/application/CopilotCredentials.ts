import { z } from "zod";
import type { CopilotModel } from "@ai-novel/shared/types/authorization";
import {
  authorizationRequired, CopilotError, revisionConflict,
  type AccountRecord, type AccountStore, type CopilotAccess, type CopilotGateway, type CredentialVault,
} from "../domain/contracts";

const savedModelsSchema = z.array(z.object({
  id: z.string(), name: z.string(), transport: z.enum(["chat", "responses"]).nullable(),
  supportedEndpoints: z.array(z.string()), supportsTools: z.boolean(), supportsStructuredOutput: z.boolean(),
  maxContext: z.number().positive().optional(), maxOutputTokens: z.number().positive().optional(),
  reasoningEfforts: z.array(z.string()),
})).max(5000);

export function readSavedModels(record: AccountRecord | null): CopilotModel[] {
  try { return savedModelsSchema.parse(JSON.parse(record?.catalogJson ?? "[]")); } catch { return []; }
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class CopilotCredentials {
  private cached: CopilotAccess | null = null;
  private pending: { revision: number; promise: Promise<CopilotAccess>; controller: AbortController } | null = null;
  private readonly invalidationListeners = new Set<() => void>();

  constructor(
    readonly store: AccountStore,
    private readonly vault: CredentialVault,
    private readonly gateway: CopilotGateway,
    private readonly now: () => number = Date.now,
  ) {}

  onInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  invalidate(): void {
    this.cached = null;
    this.pending?.controller.abort(authorizationRequired());
    this.pending = null;
    for (const listener of this.invalidationListeners) listener();
  }

  seed(access: CopilotAccess): void { this.cached = access; }
  invalidateToken(): void { this.cached = null; }

  async assertCurrent(revision: number): Promise<AccountRecord> {
    const record = await this.store.get();
    if (!record || record.state !== "authorized" || record.credentialRevision !== revision || !record.encryptedCredential) {
      throw authorizationRequired();
    }
    return record;
  }

  private async refresh(record: AccountRecord, signal: AbortSignal): Promise<CopilotAccess> {
    let token: string;
    try {
      token = this.vault.open(record.encryptedCredential!, record.id);
    } catch {
      await this.store.update(record.credentialRevision, { state: "credential_unavailable" });
      throw new CopilotError("COPILOT_CREDENTIAL_UNAVAILABLE", "无法读取授权密钥，请恢复原凭据目录，或退出后重新授权。", 409);
    }
    const start = this.now();
    try {
      const exchanged = await this.gateway.exchange(token, signal);
      signal.throwIfAborted();
      await this.assertCurrent(record.credentialRevision);
      const access = { ...exchanged, revision: record.credentialRevision };
      this.cached = access;
      console.info("[subscription.token_refresh]", JSON.stringify({ outcome: "success", revision: access.revision, durationMs: this.now() - start }));
      return access;
    } catch (error) {
      if (error instanceof CopilotError && error.code === "COPILOT_AUTH_REQUIRED") {
        await this.store.update(record.credentialRevision, { state: "reauthorization_required" }).catch(() => undefined);
      }
      console.info("[subscription.token_refresh]", JSON.stringify({ outcome: "failed", durationMs: this.now() - start }));
      throw error;
    }
  }

  async access(signal?: AbortSignal): Promise<CopilotAccess> {
    signal?.throwIfAborted();
    const record = await this.store.get();
    if (record?.state === "credential_unavailable") {
      throw new CopilotError("COPILOT_CREDENTIAL_UNAVAILABLE", "请恢复授权密钥，或退出后重新授权。", 409);
    }
    if (!record || record.state !== "authorized" || !record.encryptedCredential) throw authorizationRequired();
    if (this.cached?.revision === record.credentialRevision && this.cached.expiresAt > this.now() + 60_000) return this.cached;
    if (!this.pending || this.pending.revision !== record.credentialRevision) {
      const controller = new AbortController();
      const pending = { revision: record.credentialRevision, controller, promise: this.refresh(record, controller.signal) };
      this.pending = pending;
      void pending.promise.finally(() => {
        if (this.pending === pending) this.pending = null;
      }).catch(() => undefined);
    }
    const result = await waitFor(this.pending.promise, signal);
    signal?.throwIfAborted();
    await this.assertCurrent(result.revision);
    return result;
  }

  async refreshModels(signal?: AbortSignal): Promise<CopilotModel[]> {
    const access = await this.access(signal);
    const start = this.now();
    try {
      const models = await this.gateway.models(access, signal);
      await this.assertCurrent(access.revision);
      await this.store.update(access.revision, {
        catalogJson: JSON.stringify(models), catalogState: models.some(m => m.transport) ? "ready" : "unavailable",
      });
      console.info("[subscription.catalog]", JSON.stringify({ outcome: "success", modelCount: models.length, durationMs: this.now() - start }));
      return models;
    } catch (error) {
      await this.store.update(access.revision, { catalogState: "refresh_required" }).catch(() => undefined);
      console.info("[subscription.catalog]", JSON.stringify({ outcome: "failed", durationMs: this.now() - start }));
      throw error;
    }
  }

  async model(id: string): Promise<CopilotModel> {
    const record = await this.store.get();
    if (!record || record.state !== "authorized") throw authorizationRequired();
    const model = readSavedModels(record).find(candidate => candidate.id === id);
    if (!model?.transport || record.catalogState !== "ready") {
      throw new CopilotError("COPILOT_MODEL_UNSUPPORTED", "该模型不可用，请在模型与厂商中刷新并选择受支持的模型。");
    }
    return model;
  }
}
