const test = require("node:test"), assert = require("node:assert/strict");
const { GitHubCopilotGateway, parseCopilotModels, validateCopilotOrigin } = require("../../dist/modules/authorization/infrastructure/GitHubCopilotGateway");
const { CopilotCredentials } = require("../../dist/modules/authorization/application/CopilotCredentials");
const { fixture, MemoryStore } = require("./fixtures.cjs");

test("transport selection uses explicit endpoint capabilities, not model names", () => {
  const models = parseCopilotModels({ data: [
    { id: "misleading-claude", supported_endpoints: ["/responses"] },
    { id: "misleading-gpt", supported_endpoints: ["/chat/completions", "/responses"] },
    { id: "unknown", supported_endpoints: [] },
    { id: "hidden", model_picker_enabled: false, supported_endpoints: ["/responses"] },
    { id: "optional-unknown", supported_endpoints: ["/chat/completions"], capabilities: {
      supports: { tool_calls: "unknown", reasoning_effort: false },
    } },
  ] });
  assert.deepEqual(models.map(m => [m.id, m.transport]), [
    ["misleading-claude", "responses"], ["misleading-gpt", "chat"], ["unknown", null], ["optional-unknown", "chat"],
  ]);
  assert.equal(models[0].supportsTools, false);
  assert.equal(models[3].supportsTools, false, "unknown optional metadata must not become a supported capability");
  for (const raw of ["http://api.githubcopilot.com", "https://api.githubcopilot.com.evil.test",
    "https://user@api.githubcopilot.com", "https://127.0.0.1", "https://api.githubcopilot.com/path"]) {
    assert.throws(() => validateCopilotOrigin(raw), { code: "COPILOT_INVALID_UPSTREAM" });
  }
});

test("gateway pins device and token endpoints, refuses redirects and never exposes raw upstream errors", async () => {
  const calls = [];
  const gateway = new GitHubCopilotGateway(async (url, init) => {
    calls.push({ url, init });
    return new Response("raw-sensitive-token", { status: 403 });
  });
  await assert.rejects(() => gateway.startDevice(), error => {
    assert.equal(error.code, "COPILOT_ACCESS_DENIED");
    assert.ok(!error.message.includes("raw-sensitive-token")); return true;
  });
  assert.equal(calls[0].url, "https://github.com/login/device/code");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.body.get("scope"), "read:user");
});

test("catalog refresh carries Copilot protocol identity through token exchange and saves a ready catalog", async () => {
  const calls = [];
  const gateway = new GitHubCopilotGateway(async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, headers });
    const identity = headers.get("editor-version") === "vscode/1.110.1"
      && headers.get("editor-plugin-version") === "copilot-chat/0.38.2"
      && headers.get("copilot-integration-id") === "vscode-chat"
      && headers.get("user-agent") === "GitHubCopilotChat/0.38.2"
      && headers.get("x-github-api-version") === (new URL(url).hostname === "api.github.com" ? "2022-11-28" : "2025-10-01");
    if (!identity) return new Response("sensitive-upstream-rejection", { status: 400 });
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      assert.equal(headers.get("authorization"), "token oauth-secret-sentinel");
      return Response.json({ token: "copilot-secret-sentinel", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (url === "https://api.github.com/copilot_internal/user") {
      assert.equal(headers.get("authorization"), "token oauth-secret-sentinel");
      return Response.json({ endpoints: { api: "https://api.individual.githubcopilot.com" } });
    }
    assert.equal(url, "https://api.individual.githubcopilot.com/models");
    assert.equal(headers.get("authorization"), "Bearer copilot-secret-sentinel");
    return Response.json({ data: [{ id: "catalog-model", supported_endpoints: ["/chat/completions"] }] });
  });
  const store = new MemoryStore();
  await store.initialize();
  await store.update(0, { state: "authorized", encryptedCredential: "encrypted-sentinel" });
  const credentials = new CopilotCredentials(store, { open: () => "oauth-secret-sentinel" }, gateway);
  const models = await credentials.refreshModels();
  assert.equal(models[0].id, "catalog-model");
  assert.equal(store.record.state, "authorized");
  assert.equal(store.record.catalogState, "ready");
  assert.equal(JSON.parse(store.record.catalogJson)[0].transport, "chat");
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.headers.get("x-request-id"))).size, 3);
});

test("switching accounts validates GitHub identity with the REST API version, not the Copilot version", async t => {
  const f = fixture();
  t.after(() => f.service.close());
  const first = await f.service.start("original-account");
  await f.service.poll(first.id);
  await f.service.logout(1);
  const calls = [];
  const gateway = new GitHubCopilotGateway(async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, headers });
    if (headers.get("x-github-api-version") !== "2022-11-28") {
      return new Response("sensitive-version-error", { status: 400 });
    }
    return Response.json({ id: 456, login: "second-account" });
  });
  f.gateway.user = (token, signal) => gateway.user(token, signal);
  const switched = await f.service.start("switched-account", true);
  await f.service.poll(switched.id);
  assert.equal(f.service.session(switched.id).state, "succeeded");
  assert.equal(f.store.record.state, "authorized");
  assert.equal(f.store.record.login, "second-account");
  assert.equal(f.store.record.githubUserId, "456");
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].headers.get("authorization"), "token oauth-secret-sentinel");
});

test("gateway failure diagnostics keep only endpoint, HTTP status and safe error code", async t => {
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args.join(" ")));
  const gateway = new GitHubCopilotGateway(async () => new Response("raw-sensitive-token", { status: 400 }));
  await assert.rejects(() => gateway.models({
    token: "copilot-secret-sentinel", origin: "https://api.githubcopilot.com", expiresAt: Date.now() + 3600000, revision: 1,
  }), { code: "COPILOT_UPSTREAM_UNAVAILABLE" });
  const records = logs.filter(line => line.startsWith("[subscription.gateway] "))
    .map(line => JSON.parse(line.slice("[subscription.gateway] ".length)));
  assert.deepEqual(records, [{ endpoint: "/models", httpStatus: 400, code: "COPILOT_UPSTREAM_UNAVAILABLE" }]);
  assert.ok(!logs.join("\n").includes("raw-sensitive-token"));
  assert.ok(!logs.join("\n").includes("copilot-secret-sentinel"));
});
