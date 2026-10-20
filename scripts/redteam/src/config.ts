/**
 * Run configuration. ONE switch picks the target: `--target sepolia` (or REDTEAM_TARGET=sepolia); the default is a
 * local Anvil. Everything else follows from it:
 *
 *   anvil    deploys a fresh final-1 set with contracts/script/DeployFinal.s.sol (Anvil account #0 broadcasts with
 *            --unlocked, so no key reaches forge), generates fresh role keys at runtime, moves the clock with
 *            evm_increaseTime and finalises by mining past Anvil's `finalized` (latest − 64).
 *            RPC: --rpc-url | REDTEAM_RPC_URL | TEST_RPC_URL.  DB: --database-url | REDTEAM_DATABASE_URL | TEST_DATABASE_URL.
 *   sepolia  attaches to the deployed final-1 manifest (--manifest, default packages/chain/deployments/sepolia-final-1.json),
 *            reads the FINAL role keys from the worker host's env through the worker's own loader (scrubbed after
 *            reading), waits real time for cooling and timelocks and waits for the `finalized` tag. Anvil-only cases
 *            (T22, the 60-day AgentExpired variant, the SG world's variants) are written as "not run" rows. RPC: SEPOLIA_RPC_URL and
 *            SEPOLIA_RPC_URL_FALLBACK (both required, as for the worker). DB: --database-url | DATABASE_URL.
 *
 * Errors name the variable or flag, never a value (URLs can embed provider keys).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TARGETS = ["anvil", "sepolia"] as const;
export type Target = (typeof TARGETS)[number];

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_SEPOLIA_MANIFEST = join(REPO_ROOT, "packages/chain/deployments/sepolia-final-1.json");

export interface RunConfig {
  readonly target: Target;
  /** Anvil: one URL. Sepolia: primary + fallback (the worker's rule: two providers). */
  readonly rpcUrls: readonly string[];
  readonly databaseUrl: string;
  /** Sepolia only: the deployed final-1 manifest. */
  readonly manifestFile?: string;
  /** Bundle parent directory; the run writes <outDir>/<runId>/. */
  readonly outDir: string;
  readonly runId: string;
  /** Anvil only: also run the Anvil-only extras world (T22 rolling window ±1 s, AgentExpired). Default on. */
  readonly anvilExtras: boolean;
  /** Anvil only: also run the Singapore world (Mei; the T1 and T4 SG variants). Default on. */
  readonly anvilSg: boolean;
  /** Anvil only: also run the WEB world (Mei's chat journey with the recorded web search; the WEB variants). Default on. */
  readonly anvilWeb: boolean;
  /** Payee cooling and loosening timelock the Anvil deploy uses (seconds; DeployFinal's demo default is 120). */
  readonly coolingSeconds: number;
  readonly timelockSeconds: number;
}

export class RunConfigError extends Error {
  override readonly name = "RunConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

function flags(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--") continue; // pnpm passes the separator through
    if (!a.startsWith("--")) throw new RunConfigError(`unexpected argument ${JSON.stringify(a.slice(0, 40))}`);
    const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) out.set(name, inline);
    else if (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("--")) out.set(name, argv[(i += 1)] as string);
    else out.set(name, true);
  }
  return out;
}

const KNOWN = new Set(["target", "rpc-url", "database-url", "manifest", "out", "run-id", "no-extras", "no-sg", "no-web", "cooling-seconds", "timelock-seconds", "help"]);

export const USAGE = [
  "usage: pnpm --filter @hogee/redteam start [--target anvil|sepolia] [--rpc-url <url>] [--database-url <url>]",
  "                                         [--manifest <file>] [--out <dir>] [--run-id <id>] [--no-extras] [--no-sg] [--no-web]",
  "  anvil (default): needs a running Anvil and a throwaway Postgres (see scripts/redteam/README.md)",
  "  sepolia: needs the deployed final-1 manifest, SEPOLIA_RPC_URL + SEPOLIA_RPC_URL_FALLBACK, DATABASE_URL and",
  "           the *_PRIVATE_KEY_FINAL role keys in the worker host's env",
].join("\n");

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

function seconds(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{0,6}$/.test(raw)) throw new RunConfigError(`--${name} must be a positive integer (seconds)`);
  return Number(raw);
}

function urlOf(raw: string, label: string, httpsOnly: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RunConfigError(`${label} is not a valid URL`);
  }
  if (httpsOnly && u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
    throw new RunConfigError(`${label} must be an https URL`);
  }
  return raw;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
}

export function loadRunConfig(argv: readonly string[], env: Env, now: Date = new Date()): RunConfig {
  const f = flags(argv);
  for (const k of f.keys()) if (!KNOWN.has(k)) throw new RunConfigError(`unknown flag --${k}`);
  const targetRaw = str(f.get("target")) ?? env.REDTEAM_TARGET?.trim() ?? "anvil";
  if (!(TARGETS as readonly string[]).includes(targetRaw)) throw new RunConfigError("--target (REDTEAM_TARGET) must be anvil or sepolia");
  const target = targetRaw as Target;
  const runId = str(f.get("run-id")) ?? `rt-${stamp(now)}-${target}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) throw new RunConfigError("--run-id must be [A-Za-z0-9._:-], alphanumeric first");
  const outDir = resolve(str(f.get("out")) ?? join(REPO_ROOT, "evidence"));
  const base = {
    target,
    outDir,
    runId,
    coolingSeconds: seconds(str(f.get("cooling-seconds")), "cooling-seconds", 120),
    timelockSeconds: seconds(str(f.get("timelock-seconds")), "timelock-seconds", 120),
  };
  if (target === "anvil") {
    const rpc = str(f.get("rpc-url")) ?? env.REDTEAM_RPC_URL?.trim() ?? env.TEST_RPC_URL?.trim();
    const db = str(f.get("database-url")) ?? env.REDTEAM_DATABASE_URL?.trim() ?? env.TEST_DATABASE_URL?.trim();
    if (!rpc) throw new RunConfigError("anvil needs --rpc-url (or REDTEAM_RPC_URL / TEST_RPC_URL)");
    if (!db) throw new RunConfigError("anvil needs --database-url (or REDTEAM_DATABASE_URL / TEST_DATABASE_URL)");
    if (f.has("manifest")) throw new RunConfigError("--manifest is for --target sepolia (anvil deploys its own final-1)");
    return { ...base, rpcUrls: [urlOf(rpc, "the RPC URL", false)], databaseUrl: urlOf(db, "the database URL", false), anvilExtras: !f.has("no-extras"), anvilSg: !f.has("no-sg"), anvilWeb: !f.has("no-web") };
  }
  const primary = env.SEPOLIA_RPC_URL?.trim();
  const fallback = env.SEPOLIA_RPC_URL_FALLBACK?.trim();
  if (!primary || !fallback) throw new RunConfigError("sepolia needs SEPOLIA_RPC_URL and SEPOLIA_RPC_URL_FALLBACK (two providers, as for the worker)");
  if (f.has("rpc-url")) throw new RunConfigError("--rpc-url is for anvil; sepolia reads SEPOLIA_RPC_URL and SEPOLIA_RPC_URL_FALLBACK");
  const db = str(f.get("database-url")) ?? env.DATABASE_URL?.trim();
  if (!db) throw new RunConfigError("sepolia needs --database-url or DATABASE_URL");
  const manifestFile = resolve(str(f.get("manifest")) ?? DEFAULT_SEPOLIA_MANIFEST);
  if (!existsSync(manifestFile)) throw new RunConfigError("the final-1 manifest file does not exist (deploy final-1 and write its manifest first, or pass --manifest)");
  return {
    ...base,
    rpcUrls: [urlOf(primary, "SEPOLIA_RPC_URL", true), urlOf(fallback, "SEPOLIA_RPC_URL_FALLBACK", true)],
    databaseUrl: urlOf(db, "the database URL", false),
    manifestFile,
    anvilExtras: false,
    anvilSg: false,
    anvilWeb: false,
  };
}

export const wantsHelp = (argv: readonly string[]): boolean => argv.includes("--help") || argv.includes("-h");
