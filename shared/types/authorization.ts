export type CopilotAccountState =
  | "signed_out"
  | "authorized"
  | "reauthorization_required"
  | "subscription_unavailable"
  | "credential_unavailable";

export type AuthorizationSessionState = "pending" | "succeeded" | "denied" | "expired" | "cancelled" | "failed";
export type SubscriptionCatalogState = "ready" | "refresh_required" | "unavailable";
export type CopilotTransport = "chat" | "responses";

export interface CopilotModel {
  id: string;
  name: string;
  transport: CopilotTransport | null;
  supportedEndpoints: string[];
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  maxContext?: number;
  maxOutputTokens?: number;
  reasoningEfforts: string[];
}

export interface AuthorizationSession {
  id: string;
  state: AuthorizationSessionState;
  verificationUri: string;
  userCode?: string;
  expiresAt: number;
  pollIntervalMs: number;
  error?: string;
  code?: string;
}

export interface CopilotAccountSummary {
  id: string;
  state: CopilotAccountState;
  login: string | null;
  credentialRevision: number;
  catalogState: SubscriptionCatalogState;
  models: CopilotModel[];
  bindings: Array<{ provider: string; displayName: string | null }>;
  activeSession: AuthorizationSession | null;
}
