import { FileCredentialVault } from "../../platform/security/credentials";
import {
  AuthorizationService, CopilotCredentials, createAuthorizationRouter, GitHubCopilotGateway, PrismaAccountStore,
} from "../../modules/authorization";

const store = new PrismaAccountStore();
const vault = new FileCredentialVault();
const gateway = new GitHubCopilotGateway();
export const copilotCredentials = new CopilotCredentials(store, vault, gateway);
export const authorizationService = new AuthorizationService(store, vault, gateway, copilotCredentials);
export const authorizationRouter = createAuthorizationRouter(authorizationService);
