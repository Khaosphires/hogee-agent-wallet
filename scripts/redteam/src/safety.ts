/**
 * Guards around a run:
 *   - Preflight (fail closed), read-only and BEFORE any migration or write (openInfra runs it right after taking the
 *     advisory lock; the gas check runs before newStack publishes the roles):
 *       anvil    the database holds no facility of another chain (a mistaken shared database would otherwise lose its
 *                worker halts, which the anvil target clears, and get T29's halt);
 *       sepolia  the RPC serves the manifest's chain; the final-1 Treasury is fresh (the run opens the facility and
 *                registers a founder key, both once per deployment); the database holds NO facility row (a fresh
 *                Treasury has none open, so any row is another Treasury's: loop-1, or an earlier final-1 that reused
 *                the deployment id; T29 raises a worker halt, global to the hogee_worker schema); the worker is not
 *                halted; every role key has gas.
 *   - Secret scan: after the bundle is written, no generated or loaded secret (role keys, persona cookie secret, officer
 *     code, Stripe webhook secret, memory HMAC key, the founder's backup-wallet key and soft-passkey private key, the RPC
 *     and database URLs, the Xendit key) may appear in any file of it. A hit fails the run.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOGEE_CHAINS, iTreasuryAbi, type HogeePublicClient } from "@hogee/chain";
import type { Db } from "@hogee/db";
import type { WorkerSigners } from "@hogee/worker";
import { formatEther, parseEther } from "viem";
import type { Deployment } from "./api-internals";
import type { RunConfig } from "./config";
import type { Stack } from "./stack";

export class PreflightError extends Error {
  override readonly name = "PreflightError";
}

export const MIN_SEPOLIA_GAS_WEI = parseEther("0.05");
const ANVIL_CHAIN_ID = HOGEE_CHAINS.local.id;
const LISTED = 10;

type Sql = Pick<Db["$client"], "query">;

async function tableExists(sql: Sql, name: string): Promise<boolean> {
  const r = await sql.query<{ present: boolean }>("select to_regclass($1) is not null as present", [name]);
  return r.rows[0]?.present === true;
}

/** Sepolia, before any write: the RPC serves the manifest's chain and its final-1 Treasury has no open facility. */
export async function sepoliaChainPreflight(client: Pick<HogeePublicClient, "getChainId" | "readContract">, deployment: Deployment): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) throw new PreflightError(`the RPC serves chain ${chainId}, the manifest is for chain ${deployment.chainId}`);
  const facility = await client.readContract({ address: deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "facility" });
  if (facility.opened) throw new PreflightError("this final-1 Treasury already has an open facility: the run needs a fresh final-1 deployment (it opens the facility and registers the founder key, once each)");
}

/** Before any migration or write; a database that was never migrated (no tables yet) passes. */
export async function databasePreflight(sql: Sql, target: RunConfig["target"]): Promise<void> {
  if (await tableExists(sql, "public.facilities")) {
    if (target === "anvil") {
      const foreign = await sql.query<{ facility_id: string; chain_id: number }>("select facility_id, chain_id from facilities where chain_id <> $1 order by facility_id limit $2", [ANVIL_CHAIN_ID, LISTED]);
      if (foreign.rows.length > 0) {
        const list = foreign.rows.map((r) => `${r.facility_id} (chain ${r.chain_id})`).join(", ");
        throw new PreflightError(`the database holds facilities of another chain (${list}): the anvil target needs a throwaway database (it clears the worker halts and T29 halts the worker schema)`);
      }
    } else {
      const rows = await sql.query<{ facility_id: string; deployment_id: string; chain_id: number }>("select facility_id, deployment_id, chain_id from facilities order by facility_id limit $1", [LISTED]);
      if (rows.rows.length > 0) {
        const list = rows.rows.map((r) => `${r.facility_id} (${r.deployment_id}, chain ${r.chain_id})`).join(", ");
        throw new PreflightError(
          `the database already holds facilities (${list}): the fresh final-1 Treasury has none open, so they belong to another Treasury; use a dedicated, empty database (T29 halts the worker schema that Treasury's worker reads)`,
        );
      }
    }
  }
  if (target === "sepolia" && (await tableExists(sql, "hogee_worker.halts"))) {
    const halted = await sql.query<{ n: number }>("select count(*)::int as n from hogee_worker.halts where cleared_at is null");
    if ((halted.rows[0]?.n ?? 0) > 0) throw new PreflightError("the worker is halted on this database: an operator must resume it (ops status / ops resume) before a run");
  }
}

/** Sepolia, before newStack publishes the roles: every role key holds gas. */
export async function gasPreflight(client: Pick<HogeePublicClient, "getBalance">, signers: WorkerSigners): Promise<void> {
  for (const [role, account] of Object.entries({ agent: signers.agent, oracle: signers.oracle, lender: signers.lender, relayer: signers.relayer })) {
    const wei = await client.getBalance({ address: account.address });
    if (wei < MIN_SEPOLIA_GAS_WEI) throw new PreflightError(`the ${role} key ${account.address} holds ${formatEther(wei)} ETH; fund it with at least ${formatEther(MIN_SEPOLIA_GAS_WEI)} Sepolia ETH`);
  }
}

/** Shortest generated secret worth scanning for, and the shortest URL path+query (where a provider key lives). */
const MIN_SECRET_LENGTH = 16;
const MIN_PASSWORD_LENGTH = 8;

const safeDecode = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/**
 * Each loaded URL in full, plus its path+query when that is 16 characters or longer (a provider key in
 * `/v2/<key>` or `?apikey=<key>` leaks even when an error prints the URL without its scheme) and its password.
 */
export function urlSecrets(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    out.push(raw);
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const tail = `${u.pathname}${u.search}`;
    if (tail.length >= MIN_SECRET_LENGTH) out.push(tail);
    if (u.password.length >= MIN_PASSWORD_LENGTH) out.push(u.password, safeDecode(u.password));
  }
  return [...new Set(out)];
}

/** The secrets a run config loads: the RPC URLs and the database URL (known before any world exists). */
export function configSecrets(cfg: Pick<RunConfig, "rpcUrls" | "databaseUrl">): string[] {
  return urlSecrets([...cfg.rpcUrls, cfg.databaseUrl]);
}

/**
 * The founder secrets a run generates (run-7 re-check L5): the backup owner EOA's private key (the on-chain ownerEOA on
 * Sepolia), with and without 0x, and the soft passkey's private key in its JWK and PKCS8 forms.
 */
export function founderSecrets(walletKey: string, auth: { secretForms(): readonly string[] }): string[] {
  return [walletKey, walletKey.replace(/^0x/, ""), ...auth.secretForms()];
}

/** Every secret value the run generated or loaded (never written anywhere; only compared). */
export function secretsOf(s: Stack): string[] {
  const memory = s.agent.memoryKey ? Buffer.from(s.agent.memoryKey) : null;
  const values = [
    ...Object.values(s.childKeyEnv),
    ...Object.values(s.childKeyEnv).map((k) => k.replace(/^0x/, "")),
    s.flags.cookieSecret,
    s.flags.officerToken,
    s.flags.stripeWebhookSecret,
    memory?.toString("hex"),
    memory?.toString("base64"),
    ...s.loadedSecrets,
    ...s.generatedSecrets,
  ];
  const generated = values.filter((v): v is string => typeof v === "string" && v.length >= MIN_SECRET_LENGTH);
  return [...new Set([...generated, ...configSecrets(s.infra.cfg)])];
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Paths (relative) of bundle files that contain any of `secrets`. */
export function scanForSecrets(dir: string, secrets: readonly string[]): string[] {
  if (secrets.length === 0) return [];
  const hits: string[] = [];
  for (const f of files(dir)) {
    const text = readFileSync(f, "utf8");
    if (secrets.some((x) => text.includes(x))) hits.push(f.slice(dir.length + 1));
  }
  return hits;
}
