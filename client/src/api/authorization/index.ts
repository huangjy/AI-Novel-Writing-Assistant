import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { AuthorizationSession, CopilotAccountSummary } from "@ai-novel/shared/types/authorization";
import { apiClient } from "../client";

const root = "/authorization";
const inline = { errorPresentation: "inline" as const };
export async function getCopilotAccount() {
  return (await apiClient.get<ApiResponse<CopilotAccountSummary>>(`${root}/accounts/github-copilot`, inline)).data;
}
export async function startCopilotLogin(replaceAccount = false) {
  return (await apiClient.post<ApiResponse<AuthorizationSession>>(`${root}/accounts/github-copilot/login-sessions`,
    { idempotencyKey: crypto.randomUUID(), replaceAccount }, inline)).data;
}
export async function getAuthorizationSession(id: string) {
  return (await apiClient.get<ApiResponse<AuthorizationSession>>(`${root}/login-sessions/${encodeURIComponent(id)}`, inline)).data;
}
export async function cancelAuthorizationSession(id: string) {
  return (await apiClient.post<ApiResponse<AuthorizationSession>>(`${root}/login-sessions/${encodeURIComponent(id)}/cancel`, {}, inline)).data;
}
export async function logoutCopilot(credentialRevision: number) {
  return (await apiClient.post<ApiResponse<CopilotAccountSummary>>(`${root}/accounts/github-copilot/logout`,
    { credentialRevision }, inline)).data;
}
export async function refreshCopilotModels() {
  return (await apiClient.post<ApiResponse<CopilotAccountSummary>>(`${root}/accounts/github-copilot/refresh-models`, {}, inline)).data;
}
