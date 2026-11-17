require("./fixtures/compatibilitySettings.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma");
const {
  resolveLLMClientOptions,
  createLLMFromResolvedOptions,
  setProviderSecretCache,
} = require("../dist/llm/factory.js");

const PROVIDER = "custom_modelscope";
const BASE_URL = "https://api-inference.modelscope.cn/v1";
const MODEL = "Qwen/Qwen3.5-397B-A17B";

function configureProvider() {
  setProviderSecretCache(PROVIDER, {
    key: "test-key",
    model: MODEL,
    baseURL: BASE_URL,
    reasoningEnabled: false,
  });
}

test("structured explicit maxTokens survives the safeStructuredMaxTokens clamp", async () => {
  configureProvider();
  try {
    const resolved = await resolveLLMClientOptions(PROVIDER, {
      executionMode: "structured",
      structuredStrategy: "prompt_json",
      maxTokens: 32768,
    });
    assert.equal(resolved.structuredProfile?.safeStructuredMaxTokens, 8192);
    assert.equal(resolved.maxTokens, 32768);
  } finally {
    setProviderSecretCache(PROVIDER, null);
  }
});

test("structured route maxTokens survives when task options omit maxTokens", async () => {
  configureProvider();
  const original = prisma.modelRouteConfig.findUnique;
  prisma.modelRouteConfig.findUnique = async () => ({
    provider: PROVIDER,
    model: MODEL,
    temperature: 0.2,
    maxTokens: 32768,
    requestProtocol: "openai_compatible",
    structuredResponseFormat: "prompt_json",
  });
  try {
    const resolved = await resolveLLMClientOptions(PROVIDER, {
      taskType: "fact_extraction",
      executionMode: "structured",
      structuredStrategy: "prompt_json",
    });
    assert.equal(resolved.modelRoute, "fact_extraction");
    assert.equal(resolved.maxTokens, 32768);
  } finally {
    prisma.modelRouteConfig.findUnique = original;
    setProviderSecretCache(PROVIDER, null);
  }
});

test("structured requests use 8192 only when neither a request budget nor a model limit is known", async () => {
  configureProvider();
  const original = prisma.modelRouteConfig.findUnique;
  prisma.modelRouteConfig.findUnique = async () => null;
  try {
    const resolved = await resolveLLMClientOptions(PROVIDER, {
      taskType: "planner",
      executionMode: "structured",
      structuredStrategy: "prompt_json",
    });
    assert.equal(resolved.maxTokens, 8192);
    const body = JSON.parse(JSON.stringify(createLLMFromResolvedOptions(resolved).invocationParams({})));
    assert.equal(body.max_tokens, 8192);
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  } finally {
    prisma.modelRouteConfig.findUnique = original;
    setProviderSecretCache(PROVIDER, null);
  }
});
