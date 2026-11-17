require("../fixtures/compatibilitySettings.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture, models } = require("./fixtures.cjs");
const { prisma } = require("../../dist/db/prisma");
const { secretStore } = require("../../dist/services/settings/secretStore");
const composition = require("../../dist/modules/authorization/composition");
const { resolveLLMClientOptions, createLLMFromResolvedOptions } = require("../../dist/llm/factory");
const { withLlmTaskOutputBudgets } = require("../../dist/platform/llm/execution");

test("unset Copilot output allowance uses the catalog maximum in the physical Responses parameters", async t => {
  const f = await fixture(t);
  t.mock.method(composition, "getCopilotRuntime", () => ({ providers: f.port, proxy: f.proxy }));
  t.mock.method(secretStore, "getProvider", async () => ({
    provider: "provider-a", isActive: true, model: "responses-model",
    connectionType: "copilot_subscription", authorizationAccountId: "github_copilot",
  }));
  let routeLimit = null;
  const originalRoute = prisma.modelRouteConfig.findUnique;
  prisma.modelRouteConfig.findUnique = async () => ({
    taskType: "planner", provider: "provider-a", model: "responses-model", temperature: 0.3,
    maxTokens: routeLimit, requestProtocol: "openai_compatible", structuredResponseFormat: "json_schema",
  });
  t.after(() => { prisma.modelRouteConfig.findUnique = originalRoute; });
  f.store.record.catalogJson = JSON.stringify(models.map(model => ({
    ...model, maxOutputTokens: 128000,
  })));
  const options = { taskType: "planner", executionMode: "structured", structuredStrategy: "json_schema" };
  const resolve = overrides => resolveLLMClientOptions("provider-a", { ...options, ...overrides });
  const unrestricted = await resolve();
  assert.equal(unrestricted.maxTokens, 128000);
  assert.equal(createLLMFromResolvedOptions(unrestricted).invocationParams({}).max_output_tokens, 128000);
  assert.equal((await resolve({ maxTokens: 16 })).maxTokens, 16, "explicit probe allowances stay explicit");
  assert.equal((await resolve({ maxTokens: 256000 })).maxTokens, 128000, "catalog maximum is a hard ceiling");
  routeLimit = 24000;
  assert.equal((await resolve()).maxTokens, 24000, "saved task limits must not be erased");
  routeLimit = null;
  const scoped = await withLlmTaskOutputBudgets([
    { provider: "provider-a", model: "responses-model", taskType: "planner", maxTokens: 2048 },
  ], () => resolve());
  assert.equal(scoped.maxTokens, 2048, "production safety scopes remain authoritative");
  f.store.record.catalogJson = JSON.stringify(models);
  const unknown = await resolve();
  assert.equal(unknown.maxTokens, 8192, "8192 is used only when the catalog has no confirmed maximum");
  const body = JSON.parse(JSON.stringify(createLLMFromResolvedOptions(unknown).invocationParams({})));
  assert.equal(body.max_output_tokens, 8192);
});
