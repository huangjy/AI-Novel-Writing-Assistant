import { createAuthorizationRouter, getCopilotRuntime } from "../../modules/authorization";
const runtime = getCopilotRuntime();
export const copilotCredentials = runtime.credentials;
export const authorizationService = runtime.authorization;
export const authorizationRouter = createAuthorizationRouter(authorizationService);
