const test = require("node:test"), assert = require("node:assert/strict");
const { z } = require("zod");
const { fixture, sse, models } = require("./fixtures.cjs");
const { terminalSubscriptionError } = require("../../dist/platform/llm/subscription-proxy");

test("real Chat SDK uses the account credential and never forwards application authorization or cookies", async t => {
  const f = await fixture(t);
  const response = await f.sdk().invoke("hello");
  assert.equal(response.content, "ok");
  assert.equal(response.usage_metadata.total_tokens, 3);
  assert.equal(f.calls[0].url, "https://api.githubcopilot.com/chat/completions");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer copilot-secret-sentinel");
  assert.ok(!JSON.stringify(f.calls[0].init.headers).includes("sdk-placeholder"));
  const direct = await f.request(); await direct.text();
  assert.equal(f.calls[1].init.headers.Cookie, undefined);
  assert.ok(!JSON.stringify(f.calls[1].init.headers).includes("app-secret"));
  for (const call of f.calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("editor-version"), "vscode/1.110.1");
    assert.equal(headers.get("editor-plugin-version"), "copilot-chat/0.38.2");
    assert.equal(headers.get("copilot-integration-id"), "vscode-chat");
    assert.equal(headers.get("user-agent"), "GitHubCopilotChat/0.38.2");
    assert.equal(headers.get("x-github-api-version"), "2025-10-01");
    assert.ok(headers.get("x-request-id"));
  }
  assert.notEqual(f.calls[0].init.headers["X-Request-Id"], f.calls[1].init.headers["X-Request-Id"]);
});

test("real Responses SDK consumes native output and usage without a Chat bridge", async t => {
  const f = await fixture(t, () => Response.json({
    id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "responses-model",
    output: [{ id: "msg_fixture", type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "response-ok", annotations: [] }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  }));
  const response = await f.sdk("provider-a", "responses-model").invoke("hello");
  assert.equal(response.text, "response-ok");
  assert.equal(response.usage_metadata.total_tokens, 3);
  assert.equal(f.calls[0].url, "https://api.githubcopilot.com/responses");
  const headers = new Headers(f.calls[0].init.headers);
  assert.equal(headers.get("copilot-integration-id"), "vscode-chat");
  assert.equal(headers.get("editor-version"), "vscode/1.110.1");
  assert.equal(headers.get("editor-plugin-version"), "copilot-chat/0.38.2");
  assert.equal(headers.get("user-agent"), "GitHubCopilotChat/0.38.2");
  assert.equal(headers.get("x-github-api-version"), "2025-10-01");
});

test("SDK streaming merges fragmented tool arguments and structured output remains parseable", async t => {
  const f = await fixture(t, (_url, _init, body) => body.stream ? sse([
    { id: "cmpl", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: "read_items", arguments: '{"limit":' } },
    ] }, finish_reason: null }] },
    { id: "cmpl", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]) : Response.json({
    id: "cmpl", object: "chat.completion", model: "chat-model",
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
      { id: "call_result", type: "function", function: { name: "extract", arguments: '{"status":"ok"}' } },
    ] }, finish_reason: "tool_calls" }],
  }));
  const llm = f.sdk().bindTools([{ name: "read_items", description: "Read fixture", schema: z.object({ limit: z.number() }) }]);
  let combined;
  for await (const chunk of await llm.stream("hello")) combined = combined ? combined.concat(chunk) : chunk;
  assert.equal(combined.tool_calls[0].id, "call_1");
  assert.deepEqual(combined.tool_calls[0].args, { limit: 1 });
  const structured = f.sdk().withStructuredOutput(z.object({ status: z.literal("ok") }), { name: "extract", method: "functionCalling" });
  assert.deepEqual(await structured.invoke("hello"), { status: "ok" });
});

test("stream truncation and upstream authorization errors are terminal with no hidden replay", async t => {
  const f = await fixture(t, () => sse([
    { id: "cmpl", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
  ]));
  await assert.rejects(async () => { for await (const _chunk of await f.sdk().stream("hello")) {} },
    error => terminalSubscriptionError(error)?.code === "COPILOT_STREAM_INTERRUPTED");
  assert.equal(f.calls.length, 1);
  const denied = await fixture(t, () => new Response("sensitive-upstream-error", { status: 401 }));
  await assert.rejects(() => denied.sdk().invoke("hello"), error => {
    assert.ok(!error.message.includes("sensitive-upstream-error"));
    return terminalSubscriptionError(error)?.code === "COPILOT_AUTH_REQUIRED";
  });
  assert.equal(denied.calls.length, 1);
  const broken = await fixture(t, () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("raw-upstream-stream-secret")); },
  }), { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(async () => { for await (const _chunk of await broken.sdk().stream("hello")) {} },
    error => {
      assert.ok(!error.message.includes("raw-upstream-stream-secret"));
      return terminalSubscriptionError(error)?.code === "COPILOT_STREAM_INTERRUPTED";
    });
});

test("unsupported transports, capabilities and origins are rejected before credential dispatch", async t => {
  const f = await fixture(t);
  const malformed = new Request("https://copilot.internal.invalid/v1/embeddings", { method: "POST", body: "{}" });
  await assert.rejects(() => f.proxy.fetchFor("provider-a", "chat-model")(malformed), { code: "COPILOT_MODEL_UNSUPPORTED" });
  const saved = models[0].supportsTools; models[0].supportsTools = false;
  f.store.record.catalogJson = JSON.stringify(models);
  try {
    await assert.rejects(() => f.request("provider-a", "chat-model", { tools: [{ type: "function" }] }), { code: "COPILOT_MODEL_UNSUPPORTED" });
  } finally { models[0].supportsTools = saved; }
  assert.equal(f.calls.length, 0);
});
