import type { CopilotAccountState, CopilotAccountSummary } from "@ai-novel/shared/types/authorization";
import type { ProviderConnectionType } from "@ai-novel/shared/types/llm";

export const ACCOUNT_STATE_LABELS: Record<CopilotAccountState, string> = {
  signed_out: "未登录", authorized: "已授权", reauthorization_required: "需重新授权",
  subscription_unavailable: "订阅不可用", credential_unavailable: "授权密钥不可用",
};

export function canSwitchCopilotAccount(account?: Pick<CopilotAccountSummary, "state" | "login">): boolean {
  return account?.state === "signed_out" && Boolean(account.login);
}

export function subscriptionModelOptions(account?: CopilotAccountSummary, hidden: string[] = [], current = ""): string[] {
  return (account?.models ?? []).filter(model => model.transport && (!hidden.includes(model.id) || model.id === current)).map(model => model.id);
}

export function connectionPayload(connectionType: ProviderConnectionType, authorizationAccountId?: string) {
  return connectionType === "copilot_subscription" ? {
    connectionType, authorizationAccountId, key: undefined, baseURL: undefined, imageModel: undefined, authMode: "none" as const,
  } : { connectionType, authorizationAccountId: undefined };
}

export function showProvider(provider: { isActive: boolean; isConfigured: boolean; kind: string; connectionType?: string }): boolean {
  return provider.isActive && (provider.isConfigured || provider.kind === "custom" || provider.connectionType === "copilot_subscription");
}
