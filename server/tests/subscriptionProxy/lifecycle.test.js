const test = require("node:test"), assert = require("node:assert/strict");
const { fixture, chatResponse } = require("./fixtures.cjs");
const { SubscriptionError } = require("../../dist/platform/llm/subscription-proxy");

test("two providers share one permit; a queued cancellation never reaches upstream", async t => {
  let close;
  const f = await fixture(t, () => new Response(new ReadableStream({
    start(controller) { close = () => { controller.enqueue(new TextEncoder().encode('{"ok":true}')); controller.close(); }; },
  }), { headers: { "content-type": "application/json" } }));
  const first = await f.request("provider-a");
  const cancellation = new AbortController();
  const second = f.proxy.fetchFor("provider-b", "chat-model")("https://copilot.internal.invalid/v1/chat/completions", {
    method: "POST", signal: cancellation.signal, body: JSON.stringify({ model: "chat-model" }),
  });
  const rejected = assert.rejects(second, /cancel-queued/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  cancellation.abort(new Error("cancel-queued")); await rejected;
  close(); await first.text();
  assert.equal(f.calls.length, 1);
});

test("rate limit cooldown is account-wide and produces no extra upstream attempts", async t => {
  const f = await fixture(t, () => new Response("", { status: 429, headers: { "retry-after": "120" } }));
  await assert.rejects(() => f.request("provider-a"), { code: "COPILOT_RATE_LIMITED" });
  await assert.rejects(() => f.request("provider-b"), { code: "COPILOT_RATE_LIMITED" });
  assert.equal(f.calls.length, 1);
});

test("logout aborts an in-flight response and rejects the same prebuilt client afterwards", async t => {
  const f = await fixture(t, () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() {},
  })));
  const client = f.sdk();
  const result = client.invoke("hello");
  const rejected = assert.rejects(result);
  while (f.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  await f.service.logout(f.store.record.credentialRevision);
  await rejected;
  await assert.rejects(() => client.invoke("hello"));
  assert.equal(f.calls.length, 1);
});

test("binding validation and 403 errors preserve safe typed failures", async t => {
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args.join(" ")));
  const f = await fixture(t, () => new Response("raw-secret", { status: 403 }));
  await assert.rejects(() => f.request(), error => {
    assert.equal(error.code, "COPILOT_ACCESS_DENIED"); assert.ok(!error.message.includes("raw-secret")); return true;
  });
  f.port.assertBinding = async () => { throw new SubscriptionError("COPILOT_BINDING_INVALID", "binding changed", 409); };
  await assert.rejects(() => f.request(), { code: "COPILOT_BINDING_INVALID" });
  assert.equal(f.calls.length, 1);
  const records = logs.filter(line => line.startsWith("[subscription.request] ")).map(line => JSON.parse(line.slice("[subscription.request] ".length)));
  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].httpStatus, 403);
  assert.equal(records[0].code, "COPILOT_ACCESS_DENIED");
  assert.ok(!logs.join("\n").includes("raw-secret"));
});

test("the explicit deadline includes a body stalled after response headers and releases its permit", async t => {
  let requests = 0;
  const f = await fixture(t, () => ++requests === 1 ? new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() {},
  })) : chatResponse());
  const response = await f.proxy.fetchFor("provider-a", "chat-model", 30)(
    "https://copilot.internal.invalid/v1/chat/completions",
    { method: "POST", body: JSON.stringify({ model: "chat-model" }) },
  );
  await assert.rejects(() => response.text(), { code: "COPILOT_STREAM_INTERRUPTED" });
  const next = await f.request("provider-b"); await next.text();
  assert.equal(f.calls.length, 2);
});
