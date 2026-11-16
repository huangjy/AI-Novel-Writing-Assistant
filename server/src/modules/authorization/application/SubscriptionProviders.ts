import { randomUUID } from "node:crypto";
import type { CopilotModel } from "@ai-novel/shared/types/authorization";
import type { ProviderConnectionType } from "@ai-novel/shared/types/llm";
import { COPILOT_ACCOUNT_ID, CopilotError, authorizationRequired, type AccountRecord } from "../domain/contracts";
import { CopilotCredentials, readSavedModels } from "./CopilotCredentials";

export interface BoundProvider {
  provider: string;
  displayName: string | null;
  model: string | null;
  isActive: boolean;
  connectionType?: string;
  authorizationAccountId?: string | null;
  hiddenModels?: string;
}
export interface SubscriptionProviderInput {
  name?: string; displayName?: string; model?: string; key?: string; baseURL?: string; imageModel?: string;
  authorizationAccountId?: string | null; isActive?: boolean; reasoningEnabled?: boolean;
  reasoningEffort?: string; hiddenModels?: string[]; concurrencyLimit?: number; requestIntervalMs?: number;
}
export interface BindingRepository {
  get(provider: string): Promise<BoundProvider | null>;
  create(provider: string, input: SubscriptionProviderInput): Promise<BoundProvider>;
  save(provider: string, input: SubscriptionProviderInput): Promise<BoundProvider>;
  bootstrap(revision: number): Promise<void>;
  publish(revision: number, models: string[]): Promise<void>;
}

export function projectSubscriptionBinding(provider: BoundProvider, account: AccountRecord | null) {
  const hidden = (() => {
    try {
      const value: unknown = JSON.parse(provider.hiddenModels ?? "[]");
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  })();
  const models = readSavedModels(account).filter(m => m.transport && (!hidden.includes(m.id) || m.id === provider.model)).map(m => m.id);
  const authorized = provider.authorizationAccountId === COPILOT_ACCOUNT_ID && account?.state === "authorized";
  const ready = Boolean(provider.isActive && authorized && account?.catalogState === "ready" && provider.model && models.includes(provider.model));
  return {
    connectionType: "copilot_subscription" as ProviderConnectionType,
    authorizationAccountId: provider.authorizationAccountId ?? null,
    authorizationState: account?.state ?? "signed_out",
    authorizationLogin: account?.login ?? null,
    readiness: !authorized ? "needs_authorization" : ready ? "ready" : "needs_model",
    isConfigured: ready, models, requiresApiKey: false, supportsImageGeneration: false,
    supportsReasoningEffort: false,
    currentBaseURL: "", defaultBaseURL: "", currentImageModel: null, imageModels: [] as string[],
  };
}

export class SubscriptionProviders {
  constructor(readonly credentials: CopilotCredentials, private readonly repository: BindingRepository) {}
  async snapshot() { return this.credentials.store.get(); }
  async projection(provider: BoundProvider) { return projectSubscriptionBinding(provider, await this.snapshot()); }

  private async validate(input: SubscriptionProviderInput, existing?: BoundProvider | null): Promise<SubscriptionProviderInput> {
    if (input.key || input.baseURL || input.imageModel
      || (input.authorizationAccountId != null && input.authorizationAccountId !== COPILOT_ACCOUNT_ID)) {
      throw new CopilotError("COPILOT_BINDING_INVALID", "订阅连接只能绑定授权中心账户，不能填写 API Key、API 地址或图像模型。");
    }
    const account = await this.credentials.store.get();
    if (!account) throw authorizationRequired();
    const model = input.model ?? existing?.model ?? "";
    if (account.state === "authorized") await this.credentials.model(model);
    else if (!existing || model !== existing.model) throw authorizationRequired();
    if (input.hiddenModels?.includes(model)) throw new CopilotError("COPILOT_BINDING_INVALID", "当前模型不能隐藏，请先切换默认模型。");
    return { ...input, model, authorizationAccountId: COPILOT_ACCOUNT_ID };
  }

  async create(input: SubscriptionProviderInput): Promise<BoundProvider> {
    const checked = await this.validate(input);
    return this.repository.create(`custom_copilot_${randomUUID().replace(/-/g, "").slice(0, 12)}`, checked);
  }
  async update(provider: string, input: SubscriptionProviderInput): Promise<BoundProvider> {
    const existing = await this.repository.get(provider);
    if (!existing) throw new CopilotError("COPILOT_BINDING_INVALID", "未找到这个模型厂商。", 404);
    return this.repository.save(provider, await this.validate(input, existing));
  }
  async bootstrap(): Promise<void> {
    const account = await this.credentials.store.get();
    if (!account || account.state !== "authorized") throw authorizationRequired();
    await this.repository.bootstrap(account.credentialRevision);
  }
  async refreshModels(signal?: AbortSignal): Promise<CopilotModel[]> {
    const access = await this.credentials.access(signal);
    const models = await this.credentials.refreshModels(signal);
    await this.credentials.assertCurrent(access.revision);
    await this.repository.publish(access.revision, models.filter(m => m.transport).map(m => m.id));
    return models;
  }
  access(signal?: AbortSignal) { return this.credentials.access(signal); }
  model(id: string) { return this.credentials.model(id); }
  invalidateToken() { this.credentials.invalidateToken(); }
  onInvalidated(listener: () => void) { return this.credentials.onInvalidated(listener); }
  async assertBinding(provider: string, revision: number): Promise<void> {
    const record = await this.repository.get(provider);
    if (!record?.isActive || record.connectionType !== "copilot_subscription" || record.authorizationAccountId !== COPILOT_ACCOUNT_ID) {
      throw new CopilotError("COPILOT_BINDING_INVALID", "此厂商的订阅绑定已停用或变更，请刷新模型配置。", 409);
    }
    await this.credentials.assertCurrent(revision);
  }
}
