/**
 * Model registry (project.md §7.1): MODEL_PROVIDER=anthropic|deepseek|qwen|ollama plus per-role overrides
 * PLANNER_MODEL, READER_MODEL, JUDGE_MODEL. Everything goes through the AI SDK provider registry.
 *
 * - The env is INJECTED (the API passes process.env); this module never reads .env files and never logs a key.
 * - A role override may carry a provider prefix: `JUDGE_MODEL=deepseek:deepseek-v4-pro`, `READER_MODEL=ollama:qwen3.5:4b`.
 *   Only a known provider name counts as a prefix, so an Ollama name like `qwen3.5:4b` keeps its colon (write
 *   `ollama:<name>` when the Ollama name itself starts with a provider name, e.g. `ollama:qwen:7b`).
 * - The eval judge must come from a different model family than the planner (§7.1).
 * - Ollama is privacy mode: its base URL must be a loopback address, so extraction never leaves the machine. With
 *   MODEL_PROVIDER=ollama every role must resolve to Ollama: an override such as `READER_MODEL=qwen:7b` (which parses as
 *   the cloud qwen provider) is refused unless `OLLAMA_ALLOW_CLOUD=1` opts in (security audit run-3).
 * - DeepSeek / Qwen / Ollama have no strict-schema mode: they get `extractJsonMiddleware` (code fences stripped) and the
 *   Reader zod-validates and repairs once (src/reader/reader.ts).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createProviderRegistry, extractJsonMiddleware, wrapLanguageModel, type LanguageModel } from "ai";
import { callSettingsFor, type CallSettings } from "./rules";

export const PROVIDERS = ["anthropic", "deepseek", "qwen", "ollama"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export const MODEL_ROLES = ["planner", "reader", "judge"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** A provider-level language model object (never a bare model-id string). */
export type ProviderModel = Exclude<LanguageModel, string>;
export type ModelEnv = Readonly<Record<string, string | undefined>>;

export interface ModelSpec {
  readonly role: ModelRole;
  readonly provider: ProviderId;
  readonly modelId: string;
  /** `provider:modelId`, the AI SDK provider-registry id. */
  readonly registryId: string;
  /** Model family (claude, deepseek, qwen, gemma, ...): the judge must differ from the planner. */
  readonly family: string;
}

export interface ModelHandle {
  readonly spec: ModelSpec;
  readonly model: ProviderModel;
  /** From `callSettingsFor` (the Claude 5.5 rules table); spread into generateText. */
  readonly settings: CallSettings;
}

export class ModelConfigError extends Error {
  override readonly name = "ModelConfigError";
}

const ROLE_ENV: { readonly [R in ModelRole]: string } = { planner: "PLANNER_MODEL", reader: "READER_MODEL", judge: "JUDGE_MODEL" };
const KEY_ENV: { readonly [P in ProviderId]: string | null } = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  ollama: null,
};
// [VERIFY] ids with `pnpm smoke:models` (project.md §6.2, §22).
const DEFAULTS: { readonly [P in ProviderId]: { readonly [R in ModelRole]: string } } = {
  anthropic: { planner: "claude-sonnet-5-5", reader: "claude-haiku-5-5", judge: "deepseek:deepseek-v4-pro" },
  deepseek: { planner: "deepseek-v4-pro", reader: "deepseek-flash", judge: "qwen:qwen3-max" },
  qwen: { planner: "qwen3-max", reader: "qwen-plus", judge: "deepseek:deepseek-v4-pro" },
  ollama: { planner: "qwen3.5:4b", reader: "qwen3.5:4b", judge: "ollama:gemma4:e4b" },
};
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const isProvider = (s: string): s is ProviderId => (PROVIDERS as readonly string[]).includes(s);

function familyOf(modelId: string, provider: ProviderId): string {
  return /^[a-z]+/.exec(modelId.toLowerCase())?.[0] ?? provider;
}

function parseRef(role: ModelRole, raw: string, fallback: ProviderId): ModelSpec {
  const idx = raw.indexOf(":");
  const prefix = idx > 0 ? raw.slice(0, idx) : "";
  const [provider, modelId] = isProvider(prefix) ? [prefix, raw.slice(idx + 1)] : [fallback, raw];
  if (!MODEL_ID_RE.test(modelId)) throw new ModelConfigError(`${ROLE_ENV[role]}: "${raw}" is not a valid model id`);
  return { role, provider, modelId, registryId: `${provider}:${modelId}`, family: familyOf(modelId, provider) };
}

/** In privacy mode (MODEL_PROVIDER=ollama) a role may leave the machine only with OLLAMA_ALLOW_CLOUD=1. */
function assertLocal(spec: ModelSpec, raw: string, env: ModelEnv): void {
  if (spec.provider === "ollama" || env.OLLAMA_ALLOW_CLOUD?.trim() === "1") return;
  throw new ModelConfigError(
    `${ROLE_ENV[spec.role]}: "${raw}" resolves to the cloud ${spec.provider} provider, but MODEL_PROVIDER=ollama is privacy mode. ` +
      `Write ollama:${raw} for a local model, or set OLLAMA_ALLOW_CLOUD=1 to send the ${spec.role} to the cloud.`,
  );
}

/** Pure: which provider and model each role uses. Throws ModelConfigError on a bad configuration. */
export function resolveModelSpecs(env: ModelEnv): { readonly [R in ModelRole]: ModelSpec } {
  const providerRaw = env.MODEL_PROVIDER?.trim() || "anthropic";
  if (!isProvider(providerRaw)) throw new ModelConfigError(`MODEL_PROVIDER must be one of ${PROVIDERS.join("|")}`);
  const spec = (role: ModelRole): ModelSpec => {
    const raw = env[ROLE_ENV[role]]?.trim() || DEFAULTS[providerRaw][role];
    const resolved = parseRef(role, raw, providerRaw);
    if (providerRaw === "ollama") assertLocal(resolved, raw, env);
    return resolved;
  };
  const specs = { planner: spec("planner"), reader: spec("reader"), judge: spec("judge") };
  if (specs.judge.family === specs.planner.family) {
    throw new ModelConfigError(`JUDGE_MODEL must be a different model family from the planner (both ${specs.planner.family})`);
  }
  return specs;
}

/** Normalise OLLAMA_BASE_URL to its OpenAI-compatible `/v1` base; loopback hosts only. */
export function ollamaBaseUrl(raw: string | undefined): string {
  let url: URL;
  try {
    url = new URL(raw?.trim() || OLLAMA_DEFAULT_URL);
  } catch {
    throw new ModelConfigError("OLLAMA_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ModelConfigError("OLLAMA_BASE_URL must be http(s)");
  if (!LOOPBACK.has(url.hostname)) throw new ModelConfigError("OLLAMA_BASE_URL must be a loopback address (privacy mode stays on this machine)");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path.endsWith("/v1") ? path : `${path}/v1`}`;
}

export function handleFor(spec: ModelSpec, model: ProviderModel): ModelHandle {
  return Object.freeze({ spec, model, settings: callSettingsFor(spec) });
}

export interface ModelRegistry {
  readonly specs: { readonly [R in ModelRole]: ModelSpec };
  handle(role: ModelRole): ModelHandle;
}

export interface RegistryOptions {
  /** Injected fetch (tests use a fake; production leaves it undefined). */
  readonly fetch?: typeof fetch;
  /**
   * Roles whose provider (key, base URL) is checked at creation, so the API fails fast at startup. Default: planner
   * and reader (the runtime roles). Other roles are checked when first used (the judge is only for evals).
   */
  readonly require?: readonly ModelRole[];
}

function requireKey(env: ModelEnv, provider: ProviderId, roles: readonly ModelRole[]): string | undefined {
  const name = KEY_ENV[provider];
  if (name === null) return undefined;
  const key = env[name]?.trim();
  if (!key) throw new ModelConfigError(`${name} is not set (needed by the ${roles.join(", ")} model)`);
  return key;
}

function buildProvider(provider: ProviderId, apiKey: string | undefined, env: ModelEnv, fetchImpl: typeof fetch | undefined) {
  const common = { fetch: fetchImpl, includeUsage: true } as const;
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey, fetch: fetchImpl });
    case "deepseek":
      return createOpenAICompatible({ name: "deepseek", baseURL: DEEPSEEK_BASE_URL, apiKey, ...common });
    case "qwen":
      return createOpenAICompatible({ name: "qwen", baseURL: QWEN_BASE_URL, apiKey, ...common });
    case "ollama":
      return createOpenAICompatible({ name: "ollama", baseURL: ollamaBaseUrl(env.OLLAMA_BASE_URL), ...common });
  }
}

/** Build the registry. Fails fast on a missing key or a bad URL for the required roles (never prints a key). */
export function createModelRegistry(env: ModelEnv, options: RegistryOptions = {}): ModelRegistry {
  const specs = resolveModelSpecs(env);
  const providers = new Map<ProviderId, ReturnType<typeof buildProvider>>();
  const providerFor = (provider: ProviderId): ReturnType<typeof buildProvider> => {
    const cached = providers.get(provider);
    if (cached) return cached;
    const roles = MODEL_ROLES.filter((r) => specs[r].provider === provider);
    const built = buildProvider(provider, requireKey(env, provider, roles), env, options.fetch);
    providers.set(provider, built);
    return built;
  };
  for (const role of options.require ?? (["planner", "reader"] as const)) providerFor(specs[role].provider);
  return {
    specs,
    handle(role: ModelRole): ModelHandle {
      const spec = specs[role];
      const registry = createProviderRegistry({ [spec.provider]: providerFor(spec.provider) });
      const base = registry.languageModel(spec.registryId as `${string}:${string}`);
      const model = spec.provider === "anthropic" ? base : wrapLanguageModel({ model: base, middleware: extractJsonMiddleware() });
      return handleFor(spec, model);
    },
  };
}
