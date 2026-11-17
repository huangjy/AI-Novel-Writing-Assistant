import { loadCapability } from "./compatibility";
import {attachLLMCacheRequestPolicy,resolveCacheCapability} from "../platform/llm/cache";
import {attachExecutionSignal,assertLlmExecutionConfiguration,attachLlmExecutionPolicy,resolveScopedTaskOutputTokens} from "../platform/llm/execution";
import { DEFAULT_MODEL_OUTPUT_TOKENS, type LLMProvider, type ProviderAuthMode, type ReasoningEffort } from "@ai-novel/shared/types/llm";
import type { ModelRouteRequestProtocol } from "@ai-novel/shared/types/novel";
import { ChatOpenAI } from "@langchain/openai";
import type { CopilotModel } from "@ai-novel/shared/types/authorization";
import { getCopilotRuntime, CopilotError } from "../modules/authorization";
import { SUBSCRIPTION_BASE_URL } from "../platform/llm/subscription-proxy";
import type { PromptInvocationMeta } from "../prompting/core/promptTypes";
import { secretStore } from "../services/settings/secretStore";
import { resolveModelTemperature } from "./capabilities";
import { createAnthropicLLM } from "./anthropicClient";
import { attachLLMDebugLogging } from "./debugLogging";
import { attachLLMRequestLimiter } from "./requestLimiter";
import { attachLLMRequestGuard } from "./requestGuard";
import { resolveProviderReasoningBehavior } from "./reasoning";
import {
  resolveStructuredOutputProfile,
  type StructuredExecutionMode,
  type StructuredOutputProfile,
  type StructuredOutputStrategy,
} from "./structuredOutput";
import { attachLLMUsageTracking } from "./compatibility";
import { resolveModel, toStructuredOutputStrategy, type TaskType } from "./modelRouter";
import {
  getProviderEnvApiKey,
  getProviderEnvModel,
  isBuiltInProvider,
  providerRequiresApiKey,
  PROVIDERS,
  resolveProviderBaseUrl,
} from "./providers";

interface LLMOptions {
  model?: string;
  temperature?: number;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  maxTokens?: number;
  timeoutMs?: number;
  reasoningEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  executionMode?: StructuredExecutionMode;
  structuredStrategy?: StructuredOutputStrategy;
  requestProtocol?: ModelRouteRequestProtocol;
  modelKwargs?: Record<string, unknown>;
  fallbackProvider?: LLMProvider;
  taskType?: TaskType;
  promptMeta?: PromptInvocationMeta;
  modelRoute?: string;
  routeDegraded?: boolean;
}

export interface ProviderSecret {
  connectionType?: string;
  authorizationAccountId?: string | null;
  key?: string;
  model?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  displayName?: string;
  reasoningEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  concurrencyLimit?: number | null;
  requestIntervalMs?: number | null;
}

export interface ResolvedLLMClientOptions {
  subscriptionModel?: CopilotModel;
  provider: LLMProvider;
  providerName: string;
  model: string;
  temperature: number;
  apiKey?: string;
  baseURL: string;
  authMode: ProviderAuthMode;
  maxTokens?: number;
  timeoutMs?: number;
  concurrencyLimit: number;
  requestIntervalMs: number;
  reasoningEnabled: boolean;
  reasoningEffort: ReasoningEffort | null;
  modelKwargs?: Record<string, unknown>;
  includeRawResponse: boolean;
  requestProtocol: ModelRouteRequestProtocol;
  executionMode: StructuredExecutionMode;
  structuredProfile?: StructuredOutputProfile | null;
  structuredStrategy?: StructuredOutputStrategy | null;
  reasoningForcedOff: boolean;
  taskType?: TaskType;
  promptMeta?: PromptInvocationMeta;
  modelRoute?: string;
  routeDegraded?: boolean;
}

const providerSecrets = new Map<LLMProvider, ProviderSecret>();
const RESOLVED_LLM_OPTIONS = Symbol("RESOLVED_LLM_OPTIONS");

type ChatOpenAIWithResolvedOptions = ChatOpenAI & {
  [RESOLVED_LLM_OPTIONS]?: ResolvedLLMClientOptions;
};

function isMissingTableError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "P2021"
  );
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalTimeoutMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeProviderAuthMode(value: unknown): ProviderAuthMode {
  return value === "x-api-key" || value === "none" ? value : "bearer";
}

function normalizeProviderSecret(secret: ProviderSecret): ProviderSecret {
  return {
    connectionType: secret.connectionType,
    authorizationAccountId: secret.authorizationAccountId,
    key: normalizeOptionalText(secret.key),
    model: normalizeOptionalText(secret.model),
    baseURL: normalizeOptionalText(secret.baseURL),
    authMode: normalizeProviderAuthMode(secret.authMode),
    displayName: normalizeOptionalText(secret.displayName),
    reasoningEnabled: secret.reasoningEnabled ?? true,
    reasoningEffort: secret.reasoningEffort,
    concurrencyLimit: normalizeLimitValue(secret.concurrencyLimit),
    requestIntervalMs: normalizeLimitValue(secret.requestIntervalMs),
  };
}

function normalizeLimitValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function toProviderSecret(item: {
  connectionType?: string;
  authorizationAccountId?: string | null;
  key?: string | null;
  model?: string | null;
  baseURL?: string | null;
  authMode?: string | null;
  displayName?: string | null;
  reasoningEnabled?: boolean | null;
  reasoningEffort?: string | null;
  concurrencyLimit?: number | null;
  requestIntervalMs?: number | null;
}): ProviderSecret {
  return normalizeProviderSecret({
    connectionType: item.connectionType,
    authorizationAccountId: item.authorizationAccountId,
    key: item.key ?? undefined,
    model: item.model ?? undefined,
    baseURL: item.baseURL ?? undefined,
    authMode: normalizeProviderAuthMode(item.authMode),
    displayName: item.displayName ?? undefined,
    reasoningEnabled: item.reasoningEnabled ?? undefined,
    reasoningEffort: item.reasoningEffort === "low" || item.reasoningEffort === "high" || item.reasoningEffort === "max"
      ? item.reasoningEffort
      : undefined,
    concurrencyLimit: normalizeLimitValue(item.concurrencyLimit),
    requestIntervalMs: normalizeLimitValue(item.requestIntervalMs),
  });
}

export async function loadProviderApiKeys(): Promise<void> {
  try {
    const keys = await secretStore.listProviders({ onlyActive: true });
    providerSecrets.clear();
    for (const item of keys) {
      providerSecrets.set(item.provider as LLMProvider, toProviderSecret(item));
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw error;
  }
}

export function setProviderSecretCache(provider: LLMProvider, secret: ProviderSecret | null): void {
  if (!secret) {
    providerSecrets.delete(provider);
    return;
  }
  providerSecrets.set(provider, normalizeProviderSecret(secret));
}

async function resolveProviderSecret(provider: LLMProvider): Promise<ProviderSecret | undefined> {
  const cached = providerSecrets.get(provider);
  if (cached && cached.connectionType !== "copilot_subscription") return cached;
  if (!isBuiltInProvider(provider)) {
    const record = await secretStore.getProvider(provider);
    if (record?.connectionType === "copilot_subscription" && !record.isActive) {
      throw new CopilotError("COPILOT_BINDING_INVALID", "此 Copilot 厂商已停用，请检查模型配置。", 409);
    }
    return record?.isActive ? toProviderSecret(record) : undefined;
  }
  if (cached) {
    return cached;
  }
  try {
    const secret = await secretStore.getProvider(provider);
    if (!secret || !secret.isActive) {
      return undefined;
    }
    const value = toProviderSecret(secret);
    providerSecrets.set(provider, value);
    return value;
  } catch (error) {
    if (isMissingTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function resolveLLMClientOptions(
  provider?: LLMProvider,
  rawOptions: LLMOptions = {},
): Promise<ResolvedLLMClientOptions> {
  const options: LLMOptions = { ...rawOptions };
  let resolvedProvider = provider ?? options.fallbackProvider ?? "deepseek";
  let resolvedModel = normalizeOptionalText(options.model);
  let resolvedTemperature: number | undefined = options.temperature;
  let resolvedMaxTokens: number | undefined = options.maxTokens;
  let resolvedModelRoute: string | undefined;
  let resolvedRouteDegraded = false;

  if (options.taskType) {
    const hasExplicitProvider = provider != null;
    const hasExplicitModel = options.model != null;
    const shouldUseRouteProvider = !hasExplicitProvider && !hasExplicitModel;
    const route = await resolveModel(options.taskType, {
      ...(shouldUseRouteProvider ? {} : { provider: resolvedProvider }),
      ...(options.model != null ? { model: options.model } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
    });
    if (shouldUseRouteProvider) {
      resolvedProvider = route.provider;
    }
    if (options.model == null && shouldUseRouteProvider) {
      resolvedModel = normalizeOptionalText(route.model);
    }
    if (options.temperature == null) {
      resolvedTemperature = route.temperature;
    }
    if (options.maxTokens == null) {
      resolvedMaxTokens = route.maxTokens;
    }
    if (options.requestProtocol == null) {
      options.requestProtocol = route.requestProtocol;
    }
    if (options.structuredStrategy == null) {
      const routeStructuredStrategy = toStructuredOutputStrategy(route.structuredResponseFormat);
      if (routeStructuredStrategy) {
        options.structuredStrategy = routeStructuredStrategy;
      }
    }
    resolvedModelRoute = route.routeKey;
    resolvedRouteDegraded = route.routeDegraded;
  }

  const dbSecret = await resolveProviderSecret(resolvedProvider);
  const subscription = dbSecret?.connectionType === "copilot_subscription";
  if (subscription && (options.requestProtocol === "anthropic" || options.apiKey
    || (options.baseURL && options.baseURL !== SUBSCRIPTION_BASE_URL))) {
    throw new CopilotError("COPILOT_BINDING_INVALID", "Copilot 订阅连接不能使用外部密钥、地址或 Anthropic 原生协议。");
  }
  const providerName = isBuiltInProvider(resolvedProvider)
    ? PROVIDERS[resolvedProvider].name
    : dbSecret?.displayName ?? resolvedProvider;
  const apiKey = subscription ? undefined : normalizeOptionalText(options.apiKey)
    ?? dbSecret?.key
    ?? getProviderEnvApiKey(resolvedProvider);

  if (!apiKey && providerRequiresApiKey(resolvedProvider)) {
    throw new Error(`未配置 ${providerName} 的 API Key。`);
  }

  const model = resolvedModel
    ?? dbSecret?.model
    ?? getProviderEnvModel(resolvedProvider)
    ?? (isBuiltInProvider(resolvedProvider) ? PROVIDERS[resolvedProvider].defaultModel : undefined);
  if (!model) {
    throw new Error(`未配置 ${providerName} 的默认模型。`);
  }
  let subscriptionModel = subscription ? await getCopilotRuntime().providers.model(model) : undefined;

  const baseURL = subscription ? SUBSCRIPTION_BASE_URL : resolveProviderBaseUrl(
    resolvedProvider,
    options.baseURL ?? dbSecret?.baseURL,
    dbSecret?.baseURL,
  );
  if (!baseURL) {
    throw new Error(`未配置 ${providerName} 的 API URL。`);
  }
  const authMode = subscription ? "none" : normalizeProviderAuthMode(options.authMode ?? dbSecret?.authMode);

  const capability = await loadCapability({ provider: resolvedProvider, model, baseURL });
  if (subscriptionModel && capability.source !== "builtin_default") {
    subscriptionModel = {
      ...subscriptionModel, supportsTools: capability.structuredModes.includes("tool_calling"),
      supportsStructuredOutput: capability.structuredModes.includes("json_schema"),
    };
  }
  const temperature = resolveModelTemperature(resolvedProvider, model, resolvedTemperature);
  const timeoutMs = normalizeOptionalTimeoutMs(options.timeoutMs);
  const concurrencyLimit = normalizeLimitValue(dbSecret?.concurrencyLimit);
  const requestIntervalMs = normalizeLimitValue(dbSecret?.requestIntervalMs);
  const requestProtocol = options.requestProtocol === "anthropic" ? "anthropic" : "openai_compatible";
  const structuredStrategy = options.structuredStrategy;
  const executionMode = options.executionMode ?? "plain";
  let structuredProfile = executionMode === "structured" || subscription
    ? resolveStructuredOutputProfile({
      provider: resolvedProvider,
      model,
      baseURL,
      executionMode,
      requestProtocol,
    })
    : null;
  if (subscriptionModel && structuredProfile) {
    const structuredModes: NonNullable<StructuredOutputProfile["structuredModes"]> = [
      ...(subscriptionModel.supportsStructuredOutput ? ["json_schema" as const] : []),
      ...(subscriptionModel.supportsTools ? ["tool_calling" as const] : []),
      "prompt_only",
    ];
    structuredProfile = {
      ...structuredProfile, structuredModes, nativeJsonSchema: subscriptionModel.supportsStructuredOutput,
      nativeJsonObject: false, requiresNonThinkingForStructured: false, supportsReasoningToggle: false,
      preferredStructuredStrategy: structuredModes[0] === "prompt_only" ? "prompt_json" : structuredModes[0],
      omitMaxTokensForNativeStructured: false,
    };
  }
  const usesNativeStructured = structuredStrategy != null && structuredStrategy !== "prompt_json";
  const requestedReasoningEnabled = options.reasoningEnabled ?? dbSecret?.reasoningEnabled ?? true;
  const requestedReasoningEffort = options.reasoningEffort ?? dbSecret?.reasoningEffort ?? "high";
  const shouldForceDisableReasoning = Boolean(
    structuredProfile
      && structuredProfile.requiresNonThinkingForStructured,
  );
  const reasoningEnabled = shouldForceDisableReasoning ? false : requestedReasoningEnabled;
  const requestedMaxTokens = capability.maxOutputTokens ?? resolvedMaxTokens
    ?? subscriptionModel?.maxOutputTokens ?? DEFAULT_MODEL_OUTPUT_TOKENS;
  let effectiveMaxTokens = resolveScopedTaskOutputTokens(resolvedProvider, model, resolvedModelRoute ?? options.taskType, requestedMaxTokens);
  if (capability.maxOutputTokens != null) {
    effectiveMaxTokens = Math.min(effectiveMaxTokens ?? capability.maxOutputTokens, capability.maxOutputTokens);
  }
  if (structuredProfile && usesNativeStructured && structuredProfile.omitMaxTokensForNativeStructured
    && capability.maxOutputTokens == null && resolvedMaxTokens == null && subscriptionModel?.maxOutputTokens == null) {
    effectiveMaxTokens = undefined;
  }
  const baseModelKwargs = options.modelKwargs ?? {};
  const reasoningBehavior = subscription ? {
    reasoningEnabled: requestedReasoningEnabled, reasoningEffort: null, modelKwargs: undefined, includeRawResponse: false,
  } : resolveProviderReasoningBehavior({
    provider: resolvedProvider,
    baseURL,
    model,
    reasoningEnabled,
    reasoningEffort: requestedReasoningEffort,
  });
  const modelKwargs = {
    ...(reasoningBehavior.modelKwargs ?? {}),
    ...baseModelKwargs,
  };

  return {
    subscriptionModel,
    provider: resolvedProvider,
    providerName,
    model,
    temperature,
    apiKey,
    baseURL,
    authMode,
    maxTokens: subscriptionModel?.maxOutputTokens
      ? Math.min(effectiveMaxTokens ?? subscriptionModel.maxOutputTokens, subscriptionModel.maxOutputTokens) : effectiveMaxTokens,
    timeoutMs,
    concurrencyLimit,
    requestIntervalMs,
    reasoningEnabled: reasoningBehavior.reasoningEnabled,
    reasoningEffort: reasoningBehavior.reasoningEffort,
    modelKwargs: Object.keys(modelKwargs).length > 0 ? modelKwargs : undefined,
    includeRawResponse: reasoningBehavior.includeRawResponse,
    requestProtocol,
    executionMode,
    structuredProfile,
    structuredStrategy: structuredStrategy ?? null,
    reasoningForcedOff: shouldForceDisableReasoning && requestedReasoningEnabled,
    taskType: options.taskType,
    promptMeta: options.promptMeta,
    modelRoute: resolvedModelRoute,
    routeDegraded: resolvedRouteDegraded,
  };
}

export function buildOpenAICompatibleDefaultHeaders(
  authMode: ProviderAuthMode,
  apiKey?: string,
): Record<string, string | null> | undefined {
  if (authMode === "bearer") {
    return undefined;
  }
  return {
    Authorization: null,
    ...(authMode === "x-api-key" && apiKey ? { "x-api-key": apiKey } : {}),
  };
}

export function createLLMFromResolvedOptions(resolved: ResolvedLLMClientOptions): ChatOpenAI {
  assertLlmExecutionConfiguration(resolved);
  if (resolved.baseURL === SUBSCRIPTION_BASE_URL && !resolved.subscriptionModel) {
    throw new CopilotError("COPILOT_BINDING_INVALID", "订阅连接缺少有效的模型绑定。");
  }
  const llm = resolved.requestProtocol === "anthropic"
    ? createAnthropicLLM({
      apiKey: resolved.apiKey,
      model: resolved.model,
      baseURL: resolved.baseURL,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      timeoutMs: resolved.timeoutMs,
    }) as ChatOpenAI
    : new ChatOpenAI({
      useResponsesApi: resolved.subscriptionModel?.transport === "responses",
      apiKey: resolved.apiKey ?? "ollama",
      model: resolved.model,
      modelName: resolved.model,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      timeout: resolved.timeoutMs,
      maxRetries: 0,
      modelKwargs: resolved.modelKwargs,
      __includeRawResponse: resolved.includeRawResponse,
      configuration: {
        baseURL: resolved.baseURL,
        defaultHeaders: buildOpenAICompatibleDefaultHeaders(resolved.authMode, resolved.apiKey),
        ...(resolved.subscriptionModel ? {
          fetch: getCopilotRuntime().proxy.fetchFor(resolved.provider, resolved.model, resolved.timeoutMs, resolved.subscriptionModel),
        } : {}),
      },
    });
  const meta = {
    provider: resolved.provider,
    model: resolved.model,
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    timeoutMs: resolved.timeoutMs,
    taskType: resolved.taskType,
    modelRoute: resolved.modelRoute,
    routeDegraded: resolved.routeDegraded,
    baseURL: resolved.baseURL,
    requestProtocol: resolved.requestProtocol,
    structuredMode: resolved.structuredStrategy,
    promptMeta: resolved.promptMeta,
  };
  const cacheAware=attachLLMCacheRequestPolicy(llm,resolveCacheCapability({model:resolved.model,baseURL:resolved.baseURL,protocol:resolved.requestProtocol==="anthropic"?"anthropic":"openai-compatible"}));
  const decorated = attachLLMDebugLogging(attachLLMUsageTracking(attachLLMRequestGuard(cacheAware, meta), meta, [resolved.apiKey ?? ""]), meta);
  const limited = attachLLMRequestLimiter(decorated, {
    provider: resolved.provider,
    model: resolved.model,
    concurrencyLimit: resolved.concurrencyLimit,
    requestIntervalMs: resolved.requestIntervalMs,
  });
  (limited as ChatOpenAIWithResolvedOptions)[RESOLVED_LLM_OPTIONS] = resolved;
  return attachLlmExecutionPolicy(attachExecutionSignal(limited),resolved);
}

export async function getLLM(provider?: LLMProvider, options: LLMOptions = {}): Promise<ChatOpenAI> {
  const resolved = await resolveLLMClientOptions(provider, options);
  return createLLMFromResolvedOptions(resolved);
}

export function getResolvedLLMClientOptionsFromInstance(llm: ChatOpenAI): ResolvedLLMClientOptions | undefined {
  return (llm as ChatOpenAIWithResolvedOptions)[RESOLVED_LLM_OPTIONS];
}
