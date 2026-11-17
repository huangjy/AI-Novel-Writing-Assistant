export class SubscriptionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SubscriptionError";
  }
}

const terminalCodes = new Set([
  "COPILOT_AUTH_REQUIRED", "COPILOT_ACCESS_DENIED", "COPILOT_SUBSCRIPTION_UNAVAILABLE",
  "COPILOT_RATE_LIMITED", "COPILOT_MODEL_UNSUPPORTED", "COPILOT_CREDENTIAL_UNAVAILABLE",
  "COPILOT_BINDING_INVALID", "COPILOT_INVALID_UPSTREAM", "COPILOT_STREAM_INTERRUPTED",
  "COPILOT_OUTPUT_LIMIT_REACHED",
]);

export function terminalSubscriptionError(error: unknown, depth = 0): SubscriptionError | null {
  if (!error || typeof error !== "object" || depth > 6) return null;
  if (error instanceof SubscriptionError && terminalCodes.has(error.code)) return error;
  return terminalSubscriptionError((error as { cause?: unknown }).cause, depth + 1);
}
