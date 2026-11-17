const { fixture: authorizationFixture } = require("../authorization/fixtures.cjs");
const { SubscriptionProxy, SUBSCRIPTION_BASE_URL } = require("../../dist/platform/llm/subscription-proxy");
const { ChatOpenAI } = require("@langchain/openai");
const models = [
  { id: "chat-model", name: "Chat", transport: "chat", supportedEndpoints: ["/chat/completions"],
    supportsTools: true, supportsStructuredOutput: true, reasoningEfforts: [] },
  { id: "responses-model", name: "Responses", transport: "responses", supportedEndpoints: ["/responses"],
    supportsTools: true, supportsStructuredOutput: true, reasoningEfforts: [] },
];
async function fixture(t, fetcher) {
  const auth = authorizationFixture();
  auth.gateway.models = async () => models;
  const login = await auth.service.start("proxy-login-request"); await auth.service.poll(login.id);
  await auth.credentials.refreshModels();
  const bindings = new Set(["provider-a", "provider-b"]);
  const port = {
    access: signal => auth.credentials.access(signal), model: id => auth.credentials.model(id),
    invalidateToken: () => auth.credentials.invalidateToken(),
    onInvalidated: callback => auth.credentials.onInvalidated(callback),
    async assertBinding(provider, revision) {
      if (!bindings.has(provider)) throw new Error("invalid binding");
      await auth.credentials.assertCurrent(revision);
    },
  };
  const calls = [];
  const proxy = new SubscriptionProxy(port, async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, init, body });
    return fetcher ? fetcher(url, init, body) : chatResponse();
  });
  t.after(() => { proxy.close(); auth.service.close(); });
  const sdk = (provider = "provider-a", model = "chat-model") => new ChatOpenAI({
    model, apiKey: "sdk-placeholder-never-forward", maxRetries: 0,
    temperature: 0.1, maxTokens: 16,
    useResponsesApi: model === "responses-model",
    configuration: { baseURL: SUBSCRIPTION_BASE_URL, fetch: proxy.fetchFor(provider, model) },
  });
  const request = (provider = "provider-a", model = "chat-model", body = {}) => proxy.fetchFor(provider, model)(
    `${SUBSCRIPTION_BASE_URL}/${model === "responses-model" ? "responses" : "chat/completions"}`, {
      method: "POST", headers: { Authorization: "Bearer app-secret-never-forward", Cookie: "private-cookie" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], ...body }),
    });
  return { ...auth, proxy, sdk, request, calls, bindings, port };
}
function chatResponse(content = "ok") {
  return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "chat-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
}
function sse(events) {
  return new Response(events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}
module.exports = { fixture, chatResponse, sse, models };
