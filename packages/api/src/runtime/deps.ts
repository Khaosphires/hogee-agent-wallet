/**
 * Production ApiDeps from the environment (MOCK_API=0). Built once per process on the first request and cached; a
 * configuration error is answered as a generic 502 and retried on the next request (so fixing the env needs no
 * restart of Next). Fail closed: the RPC must serve the deployment's chain; the model provider and the supplier
 * checks throw until configured, PII redaction (@hogee/privacy) runs before every model call, and no shortlist ranks
 * on missing facts. Every model call reserves from one per-process model budget before it is sent. The API holds no
 * private key (D19).
 */
import { createModelRegistry, privacyRedactor, type ModelRegistry } from "@hogee/agent";
import { resolve } from "node:path";
import { createDb } from "@hogee/db";
import { createHogeePublicClient } from "../chain-lib";
import type { AgentPort, ApiDeps, ApiLogger, DepsProvider } from "../context";
import { loadDeploymentFile } from "../deployment";
import { ConfigError } from "../http/problem";
import { ModelBudget } from "../services/model-budget";
import { webSearchPortFor } from "../services/web-candidates";
import { budgetedAgentModels } from "./budgeted-models";
import { fileCatalog, findDataDir } from "./catalog";
import { loadApiEnv, readFlags, type Env } from "./env";
import { bossQueue, jsonLogger, liveChecks, stripePort } from "./ports";

/** A request waits at most this long for a pooled pg connection, then fails (instead of hanging, e.g. an eval slot). */
export const API_PG_CONNECT_TIMEOUT_MS = 10_000;

function agentPort(env: Env, memoryKey: Uint8Array | null, budget: ModelBudget, log: ApiLogger): AgentPort {
  let registry: ModelRegistry | null = null;
  try {
    registry = createModelRegistry(env as never);
  } catch (error: unknown) {
    log.warn("model_provider_unconfigured", { error });
  }
  return {
    configured: registry !== null,
    memoryKey,
    redactor: privacyRedactor,
    budget,
    models: (context, sink) => {
      if (!registry) throw new ConfigError("No model provider is configured (MODEL_PROVIDER and its API key)");
      return budgetedAgentModels(registry, budget, { sink, redactor: privacyRedactor }, context);
    },
  };
}

export async function createLiveDeps(env: Env = process.env, log: ApiLogger = jsonLogger()): Promise<ApiDeps> {
  const e = loadApiEnv(env);
  readFlags(env); // fail at start-up on a bad PERSONA_COOKIE_SECRET, not on the first persona switch
  const deployment = await loadDeploymentFile({ file: e.deploymentFile, chainTag: e.chainTag, deploymentId: e.deploymentId });
  const client = createHogeePublicClient(e.chain);
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) throw new ConfigError("The RPC serves another chain than the deployment manifest (CHAIN / DEPLOYMENT_ID)");
  const db = createDb(e.databaseUrl, { maxConnections: 8, connectionTimeoutMillis: API_PG_CONNECT_TIMEOUT_MS });
  db.$client.on("error", (error: unknown) => log.error("pg_pool_error", { error }));
  log.info("api_ready", { deploymentId: deployment.deploymentId, chainId, facilityId: e.config.facilityId, chatRate: e.config.chatRate, modelBudget: e.modelBudget });
  const dataDir = findDataDir(e.dataDir);
  const evidenceDir = e.evidenceDir ? resolve(/*turbopackIgnore: true*/ e.evidenceDir) : dataDir ? resolve(/*turbopackIgnore: true*/ dataDir, "..", "evidence") : undefined;
  return {
    config: { ...e.config, ...(evidenceDir ? { evidenceDir } : {}) },
    flags: () => readFlags(env),
    db,
    client,
    deployment,
    queue: bossQueue(e.databaseUrl, log),
    clock: () => Date.now(),
    catalog: fileCatalog(dataDir, log, e.config.countryCode),
    checks: liveChecks,
    agent: agentPort(env, e.memoryKey, new ModelBudget(e.modelBudget), log),
    stripe: stripePort(e.stripeSecretKey),
    // v-search: Tavily with e.tavilyKey when set, else the recorded samples under dataDir (chosen once; never a silent fallback).
    webSearch: webSearchPortFor(e.tavilyKey, dataDir),
    log,
  };
}

let cached: Promise<ApiDeps> | undefined;

/** The process-wide provider the mounted app uses: built on first use, rebuilt after a failed build. */
export const liveProvider: DepsProvider = () =>
  (cached ??= createLiveDeps().catch((error: unknown) => {
    cached = undefined;
    throw error;
  }));
