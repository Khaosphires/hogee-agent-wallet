/**
 * `pnpm dev:live`: the local live stack P2 wires the pages against (task 2.14, MOCK_API=0), in one command:
 *   1. Anvil on 127.0.0.1:<anvil-port> (default 8545): --no-cors, a block every second, `finalized` ~2 blocks behind
 *   2. a throwaway Postgres 16 in scripts/dev-live/.data (gitignored, 0700), migrated like the live tests migrate: TCP on
 *      127.0.0.1 only, scram-sha-256 with a per-run password the children read from a 0600 PGPASSFILE (.data/pgpass)
 *   3. a fresh final-1 via contracts/script/DeployFinal.s.sol, roles on Anvil's PUBLIC default accounts
 *      (agent #1, lender #2, oracle #3, relayer #5; the founder's backup wallet is #4; deployer #0 with --unlocked),
 *      with BOTH countries' platform payout hashes (Rina's DuitNow and Mei's PayNow payees), as final-1 has them
 *   4. the worker (apps/worker src/main.ts: reconcile + one tick at boot, then its pg-boss cron jobs)
 *   5. apps/web (next dev; with --prod next build, then next start) on localhost:<web-port> with MOCK_API=0, DEMO_MODE=1,
 *      CHAIN=local. next dev's page CSP allows 'unsafe-eval' (React dev tooling); --prod serves the production CSP
 *   6. the facility opened the way the live tests do it (officer persona → POST /api/facility/open → the worker relays)
 * --country SG runs Mei's facility (HOGEE_COUNTRY=SG, MEI_IDS, Mei's PayNow payees, paid by the worker's MockRail as a
 * simulated PayNow payout); MY runs Rina's. Without the flag it is the API's DEFAULT_COUNTRY (SG).
 * Every setting reaches a child through its env (built from scratch); no .env file is read or written. Next.js still
 * loads apps/web/.env* for variables its env leaves undefined, so the web child gets REPLAY, the model provider and its
 * keys, Stripe, Xendit, Presidio and the Sepolia RPCs as empty strings (WEB_ENV_BLANKS).
 * PERSONA_COOKIE_SECRET, OFFICER_TOKEN and MEMORY_HMAC_KEY are random per run; no model provider is configured.
 * Ctrl-C stops everything (web, worker, Postgres, Anvil) and removes .data unless --keep-data.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHogeePublicClient, iPlanRegistryAbi, iTreasuryAbi } from "@hogee/chain";
import { createDb } from "@hogee/db";
import { ALL_DEMO_PAYEES, anvilAccount, API_DEFAULT_COUNTRY, deployFinalAnvil, demoCountry, migrateDatabase } from "@hogee/redteam";
import { parseAbi, toHex, type Hex } from "viem";
import { anvilArgs, countryEnv, DATA_DIR, LaunchConfigError, loadLaunchConfig, pgpassLine, REPO_ROOT, sharedEnv, USAGE, wantsHelp, webEnv, webSteps, type LaunchConfig } from "./config";
import { baseEnv, portFree, run, startChild, stopAll, waitFor } from "./procs";
import { rpcAt, SEED_LABEL, seedSales } from "./seed-sales";

const DEPLOYMENT_ID = "final-1";
const ROLE_INDEX = { AGENT: 1, LENDER: 2, ORACLE: 3, RELAYER: 5 } as const;

const say = (line: string) => process.stdout.write(`${line}\n`);
const anvilKey = (i: number): Hex => toHex(anvilAccount(i).getHdKey().privateKey as Uint8Array);

async function rpcUp(url: string): Promise<boolean> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  return r.ok;
}

let shuttingDown = false;
async function shutdown(cfg: LaunchConfig | null, code: number, why: string): Promise<never> {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  say(`\nstopping (${why}) …`);
  await stopAll();
  await run("pg_ctl", ["-D", join(DATA_DIR, "pg"), "-m", "fast", "stop"], { env: baseEnv() }).catch(() => undefined);
  if (cfg && !cfg.keepData) rmSync(DATA_DIR, { recursive: true, force: true });
  say("stopped.");
  process.exit(code);
}

const PG_USER = "hogee";

interface Postgres {
  /** postgres://hogee@127.0.0.1:<port>/hogee: no password in it (printable); clients read it from PGPASSFILE. */
  readonly url: string;
  readonly pgpassFile: string;
  /** Only for the launcher's own migration connection; never printed or passed to a child. */
  readonly password: string;
}

/** No trust auth: any local account could otherwise connect as this superuser (COPY … TO PROGRAM runs as you). */
async function startPostgres(cfg: LaunchConfig): Promise<Postgres> {
  const pg = join(DATA_DIR, "pg");
  const password = randomBytes(32).toString("base64url");
  const pgpassFile = join(DATA_DIR, "pgpass");
  writeFileSync(pgpassFile, pgpassLine(cfg.pgPort, PG_USER, password), { mode: 0o600 });
  const env = baseEnv({ LC_ALL: "C", LANG: "C", PGPASSFILE: pgpassFile });
  const pwfile = join(DATA_DIR, "pg-initdb-password");
  writeFileSync(pwfile, `${password}\n`, { mode: 0o600 });
  try {
    await run("initdb", ["-D", pg, "-U", PG_USER, "--auth=scram-sha-256", `--pwfile=${pwfile}`], { env });
  } finally {
    rmSync(pwfile, { force: true });
  }
  await run("pg_ctl", ["-D", pg, "-l", join(DATA_DIR, "postgres.log"), "-o", `-p ${cfg.pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, "-w", "start"], { env });
  await run("createdb", ["-h", "127.0.0.1", "-p", String(cfg.pgPort), "-U", PG_USER, "hogee"], { env });
  return { url: `postgres://${PG_USER}@127.0.0.1:${cfg.pgPort}/hogee`, pgpassFile, password };
}

async function seedFacility(webUrl: string, host: string, officerToken: string, rpcUrl: string, treasury: Hex): Promise<void> {
  const headers = { host, "content-type": "application/json" };
  const persona = await fetch(`${webUrl}/api/session/persona`, { method: "POST", headers, body: JSON.stringify({ persona: "officer", officerToken }) });
  const cookie = persona.headers.get("set-cookie")?.split(";")[0];
  if (!persona.ok || !cookie) throw new Error(`officer persona: HTTP ${persona.status}`);
  const open = await fetch(`${webUrl}/api/facility/open`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({ capMinor: "1000000", reserveFloorBps: 300 }) });
  if (!open.ok) throw new Error(`open facility: HTTP ${open.status} ${(await open.text()).slice(0, 200)}`);
  const client = createHogeePublicClient({ chain: "local", rpcUrls: [rpcUrl], pollingIntervalMs: 500 });
  await waitFor("the facility on-chain (the worker relays openFacility)", async () => (await client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: "facility" })).opened, 120_000);
}

const ledgerAbi = parseAbi(["function revenueLedger() view returns (uint128 reserveSkimmedMinor, uint128 reserveWithdrawnMinor, uint64 salesCount)"]);

interface SeedTarget {
  readonly rpcUrl: string;
  readonly webUrl: string;
  readonly host: string;
  readonly webhookSecret: string;
  readonly facilityId: string;
  readonly currency: string;
  readonly registry: Hex;
  readonly treasury: Hex;
}

/** --seed-sales in the background: it waits for the founder's committed plan, so the stack is usable meanwhile. */
function startSeedSales(t: SeedTarget, days: number): void {
  const client = createHogeePublicClient({ chain: "local", rpcUrls: [t.rpcUrl], pollingIntervalMs: 500 });
  void seedSales(
    {
      rpc: rpcAt(t.rpcUrl),
      post: async (path, raw, headers) => (await fetch(`${t.webUrl}${path}`, { method: "POST", headers: { ...headers, host: t.host }, body: raw })).status,
      planCommitted: async () => Number(await client.readContract({ address: t.registry, abi: iPlanRegistryAbi, functionName: "planVersion" })) > 0,
      salesCount: async () => BigInt((await client.readContract({ address: t.treasury, abi: ledgerAbi, functionName: "revenueLedger" }))[2]),
      webhookSecret: t.webhookSecret,
      facilityId: t.facilityId,
      currency: t.currency,
      say,
    },
    days,
  ).catch((error: unknown) => say(`seed-sales stopped: ${error instanceof Error ? error.message : String(error)}`));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    say(USAGE);
    return;
  }
  let cfg: LaunchConfig;
  try {
    cfg = loadLaunchConfig(argv);
  } catch (e) {
    if (e instanceof LaunchConfigError) {
      process.stderr.write(`${e.message}\n${USAGE}\n`);
      process.exit(2);
    }
    throw e;
  }
  const country = demoCountry(cfg.country ?? API_DEFAULT_COUNTRY);
  for (const [name, p] of [["anvil", cfg.anvilPort], ["postgres", cfg.pgPort], ["web", cfg.webPort]] as const) {
    if (!(await portFree(p))) throw new Error(`port ${p} (${name}) is in use: stop what holds it or pass --${name === "postgres" ? "pg" : name}-port`);
  }
  process.on("SIGINT", () => void shutdown(cfg, 0, "Ctrl-C"));
  process.on("SIGTERM", () => void shutdown(cfg, 0, "SIGTERM"));
  const died = (name: string, code: number | null, sig: NodeJS.Signals | null) => void shutdown(cfg, 1, `${name} exited (${sig ?? `code ${code}`}); see ${join(DATA_DIR, `${name}.log`)}`);

  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  chmodSync(DATA_DIR, 0o700);
  const rpcUrl = `http://127.0.0.1:${cfg.anvilPort}`;
  startChild("anvil", "anvil", anvilArgs(cfg.anvilPort), { cwd: DATA_DIR, env: baseEnv(), logDir: DATA_DIR }, died);
  await waitFor("anvil", () => rpcUp(rpcUrl), 30_000);
  say(`anvil      ${rpcUrl}`);
  const postgres = await startPostgres(cfg);
  const databaseUrl = postgres.url;
  const ownUrl = new URL(databaseUrl);
  ownUrl.password = postgres.password;
  const db = createDb(ownUrl.toString(), { maxConnections: 2 });
  await migrateDatabase(db);
  await db.$client.end();
  say(`postgres   ${databaseUrl} (scram-sha-256, per-run password in scripts/dev-live/.data/pgpass)`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const { deployment, raw } = await deployFinalAnvil({
    rpcUrl,
    deploymentId: DEPLOYMENT_ID,
    lender: anvilAccount(ROLE_INDEX.LENDER).address,
    oracle: anvilAccount(ROLE_INDEX.ORACLE).address,
    judgingWindowEnd: now + 30n * 86_400n,
    coolingSeconds: 120,
    timelockSeconds: 120,
    // Both founders' platform payees (SG-DECISIONS: Mei's payout hashes go into final-1 alongside Rina's).
    payees: ALL_DEMO_PAYEES,
  });
  const deploymentFile = join(DATA_DIR, `anvil-${DEPLOYMENT_ID}.json`);
  writeFileSync(deploymentFile, JSON.stringify(raw, null, 2));
  say(`final-1    Treasury ${deployment.contracts.Treasury.address}, PlanRegistry ${deployment.contracts.PlanRegistry.address}`);

  const officerToken = randomBytes(32).toString("base64url");
  // --seed-sales only: this run's own Stripe webhook secret, so the launcher can send signed test events to the API.
  const webhookSecret = cfg.seedSalesDays ? `whsec_${randomBytes(24).toString("hex")}` : undefined;
  const shared = sharedEnv({ databaseUrl, pgpassFile: postgres.pgpassFile, rpcUrl, deploymentId: DEPLOYMENT_ID, deploymentFile });
  const keys = Object.fromEntries(Object.entries(ROLE_INDEX).map(([role, i]) => [`${role}_PRIVATE_KEY_FINAL`, anvilKey(i)]));
  startChild(
    "worker",
    process.execPath,
    ["--import", "tsx", "src/main.ts"],
    { cwd: join(REPO_ROOT, "apps", "worker"), env: baseEnv({ ...shared, ...keys, MAX_FEE_GWEI: "100" }), logDir: DATA_DIR, onLine: (l) => (/"level":"(error|warn)"/.test(l) ? say(`[worker] ${l.slice(0, 300)}`) : undefined) },
    died,
  );
  const host = `localhost:${cfg.webPort}`;
  const webUrl = `http://${host}`;
  const webDir = join(REPO_ROOT, "apps", "web");
  const nextBin = join(webDir, "node_modules", "next", "dist", "bin", "next");
  const webChildEnv = baseEnv(webEnv({
    ...shared,
    MOCK_API: "0",
    DEMO_MODE: "1",
    PERSONA_COOKIE_SECRET: randomBytes(32).toString("base64url"),
    OFFICER_TOKEN: officerToken,
    MEMORY_HMAC_KEY: randomBytes(32).toString("hex"),
    ...countryEnv(country),
    FOUNDER_WALLET_ADDRESS: anvilAccount(4).address,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: webUrl,
    HOGEE_ALLOWED_HOSTS: `${host},127.0.0.1:${cfg.webPort}`,
    NEXT_TELEMETRY_DISABLED: "1",
    ...(webhookSecret ? { STRIPE_WEBHOOK_SECRET: webhookSecret } : {}),
  }));
  const steps = webSteps(cfg);
  if (steps.build) {
    say("web        next build (--prod; a few minutes)…");
    const buildLog = join(DATA_DIR, "web-build.log");
    await run(process.execPath, [nextBin, ...steps.build], { cwd: webDir, env: webChildEnv, maxBuffer: 64 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string }) => {
      writeFileSync(buildLog, `${e.stdout ?? ""}${e.stderr ?? ""}`);
      throw new Error(`next build failed; see ${buildLog}`);
    });
  }
  startChild("web", process.execPath, [nextBin, ...steps.serve], { cwd: webDir, env: webChildEnv, logDir: DATA_DIR, group: true }, died);
  await waitFor(cfg.prod ? "apps/web (next start)" : "apps/web (next dev compiles /api on first use)", async () => (await fetch(`${webUrl}/api/session`, { headers: { host } })).ok, 240_000);
  if (cfg.seed) await seedFacility(webUrl, host, officerToken, rpcUrl, deployment.contracts.Treasury.address as Hex);
  if (cfg.seedSalesDays && webhookSecret) {
    startSeedSales(
      {
        rpcUrl,
        webUrl,
        host,
        webhookSecret,
        facilityId: country.facilityId,
        currency: country.currency,
        registry: deployment.contracts.PlanRegistry.address as Hex,
        treasury: deployment.contracts.Treasury.address as Hex,
      },
      cfg.seedSalesDays,
    );
  }
  say("");
  say(`ready      ${webUrl}  (MOCK_API=0, DEMO_MODE=1, CHAIN=local, ${cfg.prod ? "next start: production CSP" : "next dev: its CSP allows 'unsafe-eval'; --prod for the production one"})`);
  say(`officer    access code: ${officerToken}`);
  say(`           POST /api/session/persona {"persona":"officer","officerToken":"<code>"} or the officer page; random per run`);
  say(`country    ${country.countryCode} (${country.founderName}, ${country.currency}${country.countryCode === "SG" ? "; PayNow payouts are simulated on MockRail" : ""})`);
  say(`facility   ${country.facilityId}: ${cfg.seed ? "opened on-chain (cap 10,000 BU, reserve floor 300 bps)" : "not opened (--no-seed)"}; next: ${country.founderName} registers a passkey, the officer approves it`);
  say(`founder    backup wallet = Anvil account #4 ${anvilAccount(4).address} (public test key; import it in MetaMask for the eip712 path)`);
  if (cfg.fresh) say("fresh      only the facility is opened: the chat journey starts at intake (no plan, key, order or sale)");
  if (cfg.seedSalesDays) say(`seed-sales ${cfg.seedSalesDays} days once the plan is committed (${SEED_LABEL}; Anvil only)`);
  say(`logs       scripts/dev-live/.data/{web,worker,anvil,postgres}.log`);
  say(`not yet    chat answers 502 until P3's privacy redactor exists; plan drafts and shortlists need P3's data/country-packs and data/suppliers`);
  say("Ctrl-C stops everything.");
}

main().catch((error: unknown) => {
  process.stderr.write(`dev:live failed: ${error instanceof Error ? error.message : String(error)}\n`);
  void shutdown(null, 1, "start-up failed");
});
