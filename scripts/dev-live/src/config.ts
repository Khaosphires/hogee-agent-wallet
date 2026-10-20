/** Launcher flags. Ports only; every secret is generated per run and every setting reaches a child through its env. */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SEED_DAYS } from "./seed-sales";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Gitignored (scripts/dev-live/.gitignore): Postgres data, the deployment manifest, the child logs. */
export const DATA_DIR = join(REPO_ROOT, "scripts", "dev-live", ".data");
/** The repo's data/ (country packs, suppliers, data/sanctions/un_sc.csv): HOGEE_DATA_DIR for the API and the worker. */
export const REPO_DATA_DIR = join(REPO_ROOT, "data");

/** The demo countries the stack can run: Rina's Malaysia, Mei's Singapore. */
export const LAUNCH_COUNTRIES = ["MY", "SG"] as const;
export type LaunchCountry = (typeof LAUNCH_COUNTRIES)[number];

export interface LaunchConfig {
  readonly anvilPort: number;
  readonly pgPort: number;
  readonly webPort: number;
  /** Keep .data (Postgres files, logs) after Ctrl-C; the next start wipes it anyway. */
  readonly keepData: boolean;
  /** Skip opening the facility (step 0a), e.g. to drive the officer page from scratch. */
  readonly seed: boolean;
  /** --country MY|SG; undefined = the API's DEFAULT_COUNTRY (SG, SG-DECISIONS Q3). */
  readonly country?: LaunchCountry;
  /** --fresh: the chat journey from zero (only the facility is opened; no plan, key, order or sale). Today's default. */
  readonly fresh?: true;
  /** --seed-sales <days>: Anvil-only demo sales over that many chain days once a plan is committed (seed-sales.ts). */
  readonly seedSalesDays?: number;
  /**
   * --prod: `next build` then `next start` (NODE_ENV=production: the page CSP has no 'unsafe-eval'). Default: `next dev`,
   * whose CSP must allow 'unsafe-eval' (React's dev tooling evaluates code), so a demo meant to show the real CSP uses --prod.
   */
  readonly prod?: true;
}

export const USAGE = [
  "usage: pnpm dev:live [-- --anvil-port 8545] [--pg-port 55432] [--web-port 3000] [--country MY|SG] [--keep-data] [--no-seed] [--fresh] [--seed-sales <days>] [--prod]",
  "  Starts Anvil + a fresh final-1, a throwaway Postgres in scripts/dev-live/.data, the worker (cron jobs) and",
  "  apps/web (next dev, MOCK_API=0, DEMO_MODE=1, CHAIN=local); opens the facility; Ctrl-C stops everything.",
  "  --prod: next build, then next start (the production page CSP; next dev's CSP allows 'unsafe-eval'). Slower to start.",
  "  --country: SG runs Mei's facility (fac-mei), MY Rina's (fac-rina); default: the API's default country.",
  "  --fresh: start the chat journey from zero (only the facility is opened; the default today, stated explicitly).",
  `  --seed-sales <days>: Anvil only. After the plan is committed, records demo sales over 1..${MAX_SEED_DAYS} chain days via`,
  "    Anvil time travel (local chain, time-shifted demo history). Refuses any chain that is not a local Anvil.",
].join("\n");

export class LaunchConfigError extends Error {
  override readonly name = "LaunchConfigError";
}

function port(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{2,4}$/.test(raw) || Number(raw) > 65_535) throw new LaunchConfigError(`--${name} must be a TCP port`);
  return Number(raw);
}

function seedDaysOf(raw: string | undefined, seed: boolean): { seedSalesDays?: number } {
  if (raw === undefined) return {};
  if (!/^[1-9][0-9]?$/.test(raw) || Number(raw) > MAX_SEED_DAYS) throw new LaunchConfigError(`--seed-sales must be a number of days from 1 to ${MAX_SEED_DAYS}`);
  if (!seed) throw new LaunchConfigError("--seed-sales needs the facility opened: drop --no-seed");
  return { seedSalesDays: Number(raw) };
}

function countryOf(raw: string | undefined): { country?: LaunchCountry } {
  if (raw === undefined) return {};
  if (!(LAUNCH_COUNTRIES as readonly string[]).includes(raw)) throw new LaunchConfigError("--country must be MY or SG");
  return { country: raw as LaunchCountry };
}

export function loadLaunchConfig(argv: readonly string[]): LaunchConfig {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--") continue;
    if (!a.startsWith("--")) throw new LaunchConfigError(`unexpected argument ${JSON.stringify(a.slice(0, 40))}`);
    const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (["keep-data", "no-seed", "help", "fresh", "prod"].includes(name)) switches.add(name);
    else if (["anvil-port", "pg-port", "web-port", "country", "seed-sales"].includes(name)) values.set(name, inline ?? (argv[(i += 1)] as string));
    else throw new LaunchConfigError(`unknown flag --${name}`);
  }
  const cfg = {
    anvilPort: port(values.get("anvil-port"), "anvil-port", 8545),
    pgPort: port(values.get("pg-port"), "pg-port", 55432),
    webPort: port(values.get("web-port"), "web-port", 3000),
    keepData: switches.has("keep-data"),
    seed: !switches.has("no-seed"),
    ...countryOf(values.get("country")),
    ...(switches.has("fresh") ? { fresh: true as const } : {}),
    ...(switches.has("prod") ? { prod: true as const } : {}),
    ...seedDaysOf(values.get("seed-sales"), !switches.has("no-seed")),
  };
  if (new Set([cfg.anvilPort, cfg.pgPort, cfg.webPort]).size !== 3) throw new LaunchConfigError("the three ports must differ");
  return cfg;
}

export const wantsHelp = (argv: readonly string[]): boolean => argv.includes("--help") || argv.includes("-h");

/** The `next` CLI steps of the web child: `build` once then `start` with --prod, else `dev`; always localhost:<web-port>. */
export function webSteps(cfg: Pick<LaunchConfig, "webPort" | "prod">): { readonly build?: readonly string[]; readonly serve: readonly string[] } {
  const listen = ["--hostname", "localhost", "--port", String(cfg.webPort)];
  return cfg.prod ? { build: ["build"], serve: ["start", ...listen] } : { serve: ["dev", ...listen] };
}

/**
 * Anvil's flags: loopback only; --no-cors (Anvil's default allow-origin is *, so any web page could send anvil_* / evm_*
 * cheat calls to the local chain); a block every second with 1-slot epochs, so `finalized` trails `latest` by about 2
 * blocks even on an idle demo (the evidence exporter ships only finalized receipts; Anvil's default is 64 behind, and an
 * automine chain stops mining after the last tx).
 */
export function anvilArgs(port: number): string[] {
  return ["--host", "127.0.0.1", "--port", String(port), "--silent", "--no-cors", "--block-time", "1", "--slots-in-an-epoch", "1"];
}

/**
 * Variables the web child gets as empty strings. Next.js loads apps/web/.env* only for variables its env does not
 * define, and the API treats an empty value as unset, so a developer's .env file cannot switch dev:live to replay
 * (REPLAY), configure a paid model API, Stripe, Xendit or Presidio, or point it at Sepolia.
 */
export const WEB_ENV_BLANKS = [
  "REPLAY",
  "MODEL_PROVIDER",
  "PLANNER_MODEL",
  "READER_MODEL",
  "JUDGE_MODEL",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_ALLOW_CLOUD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PRESIDIO_ANALYZER_URL",
  "XENDIT_SECRET_KEY",
  "SEPOLIA_RPC_URL",
  "SEPOLIA_RPC_URL_FALLBACK",
] as const;

/** The web child's settings over the blanks: the launcher's own values always win. */
export function webEnv(settings: Readonly<Record<string, string>>): Record<string, string> {
  return { ...Object.fromEntries(WEB_ENV_BLANKS.map((name) => [name, ""])), ...settings };
}

/** A ~/.pgpass line (host:port:database:user:password) for the throwaway cluster (colons and backslashes escaped). */
export function pgpassLine(port: number, user: string, password: string): string {
  const esc = (v: string) => v.replace(/[\\:]/g, (c) => `\\${c}`);
  return `127.0.0.1:${port}:*:${esc(user)}:${esc(password)}\n`;
}

export interface ChildEnvInput {
  readonly databaseUrl: string;
  readonly pgpassFile: string;
  readonly rpcUrl: string;
  readonly deploymentId: string;
  readonly deploymentFile: string;
}

/**
 * What the worker and the web child (the API) both get: the database, the local chain and final-1, the MockRail payout
 * rail (Mei's PayNow payouts are always simulated; Rina's DuitNow ones too, since no Xendit key is set), and
 * HOGEE_DATA_DIR, so the country packs, suppliers and the sanctions list never depend on a child's working directory.
 */
export function sharedEnv(i: ChildEnvInput): Record<string, string> {
  return {
    DATABASE_URL: i.databaseUrl,
    PGPASSFILE: i.pgpassFile,
    CHAIN: "local",
    LOCAL_RPC_URL: i.rpcUrl,
    DEPLOYMENT_ID: i.deploymentId,
    CHAIN_TAG: "anvil",
    DEPLOYMENT_FILE: i.deploymentFile,
    PAYOUT_RAIL: "mock",
    HOGEE_DATA_DIR: REPO_DATA_DIR,
  };
}

/** The API's country and tenant, always explicit (never the API's own default). */
export function countryEnv(c: { readonly countryCode: LaunchCountry; readonly facilityId: string; readonly founderId: string }): Record<string, string> {
  return { HOGEE_COUNTRY: c.countryCode, HOGEE_FACILITY_ID: c.facilityId, HOGEE_FOUNDER_ID: c.founderId };
}
