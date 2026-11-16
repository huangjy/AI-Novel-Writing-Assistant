import type { CopilotAccountState, CopilotModel, SubscriptionCatalogState } from "@ai-novel/shared/types/authorization";

export const COPILOT_ACCOUNT_ID = "github_copilot";
export interface AccountRecord {
  id: string;
  service: string;
  githubUserId: string | null;
  login: string | null;
  state: string;
  encryptedCredential: string | null;
  credentialRevision: number;
  bootstrapCompleted: boolean;
  catalogState: string;
  catalogJson: string;
}
export interface AccountStore {
  get(): Promise<AccountRecord | null>;
  initialize(): Promise<AccountRecord>;
  update(revision: number, patch: Partial<Pick<AccountRecord,
    "githubUserId" | "login" | "state" | "encryptedCredential" | "catalogState" | "catalogJson"
  >>, incrementRevision?: boolean): Promise<AccountRecord>;
  bindings(): Promise<Array<{ provider: string; displayName: string | null }>>;
}
export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}
export interface CopilotAccess {
  token: string;
  expiresAt: number;
  origin: string;
  revision: number;
}
export interface CopilotGateway {
  startDevice(signal?: AbortSignal): Promise<DeviceCode>;
  pollDevice(code: string, signal?: AbortSignal): Promise<{ token?: string; pending?: boolean; slowDown?: boolean }>;
  user(token: string, signal?: AbortSignal): Promise<{ id: string; login: string }>;
  exchange(token: string, signal?: AbortSignal): Promise<Omit<CopilotAccess, "revision">>;
  models(access: CopilotAccess, signal?: AbortSignal): Promise<CopilotModel[]>;
}
export interface CredentialVault {
  seal(plaintext: string, context: string, allowCreate: boolean): string;
  open(encrypted: string, context: string): string;
}
export function accountState(record: AccountRecord | null): CopilotAccountState {
  return (record?.state ?? "signed_out") as CopilotAccountState;
}
export function catalogState(record: AccountRecord | null): SubscriptionCatalogState {
  return (record?.catalogState ?? "refresh_required") as SubscriptionCatalogState;
}

export class CopilotError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "CopilotError";
  }
}
export function authorizationRequired(): CopilotError {
  return new CopilotError("COPILOT_AUTH_REQUIRED", "请在设置的授权中心登录 GitHub Copilot。", 401);
}
export function revisionConflict(): CopilotError {
  return new CopilotError("COPILOT_REVISION_CONFLICT", "授权状态已变化，请刷新后再试。", 409);
}
