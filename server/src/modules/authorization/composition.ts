import { FileCredentialVault } from "../../platform/security/credentials";
import { SubscriptionProxy } from "../../platform/llm/subscription-proxy";
import { AuthorizationService } from "./application/AuthorizationService";
import { CopilotCredentials } from "./application/CopilotCredentials";
import { SubscriptionProviders } from "./application/SubscriptionProviders";
import { GitHubCopilotGateway } from "./infrastructure/GitHubCopilotGateway";
import { PrismaAccountStore } from "./infrastructure/PrismaAccountStore";
import { PrismaSubscriptionBindings } from "./infrastructure/PrismaSubscriptionBindings";

function createRuntime() {
  const store = new PrismaAccountStore(), vault = new FileCredentialVault(), gateway = new GitHubCopilotGateway();
  const credentials = new CopilotCredentials(store, vault, gateway);
  const authorization = new AuthorizationService(store, vault, gateway, credentials);
  const providers = new SubscriptionProviders(credentials, new PrismaSubscriptionBindings());
  const proxy = new SubscriptionProxy(providers);
  authorization.setAuthorizedHandler(async () => { await providers.bootstrap(); await providers.refreshModels(); });
  return { authorization, credentials, providers, proxy };
}
let runtime: ReturnType<typeof createRuntime> | undefined;
export function getCopilotRuntime(): ReturnType<typeof createRuntime> {
  return runtime ??= createRuntime();
}
