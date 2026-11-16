const test = require("node:test"), assert = require("node:assert/strict");
const { GitHubCopilotGateway, parseCopilotModels, validateCopilotOrigin } = require("../../dist/modules/authorization/infrastructure/GitHubCopilotGateway");

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
