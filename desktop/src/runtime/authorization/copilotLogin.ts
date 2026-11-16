const COPILOT_DEVICE_LOGIN_URL = "https://github.com/login/device";

export async function openCopilotDeviceLogin(
  event: unknown,
  expectedSender: unknown,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  const sender = event && typeof event === "object" && "sender" in event ? event.sender : null;
  if (!expectedSender || sender !== expectedSender) throw new Error("Untrusted authorization request.");
  await openExternal(COPILOT_DEVICE_LOGIN_URL);
}
