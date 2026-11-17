import { randomUUID } from "node:crypto";

// Copilot validates this compatibility identity for catalog and inference requests.
export function createCopilotRequestHeaders(): Record<string, string> {
  return {
    "Editor-Version": "vscode/1.110.1",
    "Editor-Plugin-Version": "copilot-chat/0.38.2",
    "Copilot-Integration-Id": "vscode-chat",
    "User-Agent": "GitHubCopilotChat/0.38.2",
    "X-GitHub-Api-Version": "2025-10-01",
    "X-Request-Id": randomUUID(),
  };
}
