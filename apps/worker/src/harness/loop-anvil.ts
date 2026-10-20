/**
 * `pnpm --filter @hogee/worker loop:anvil [--days N | --wall-minutes M] [options]`: the task 1.6 acceptance run.
 *
 * 1. starts a throwaway Anvil + Postgres 16 (or reuses LOOP_RPC_URL / LOOP_DATABASE_URL), applies the migrations;
 * 2. generates the four loop role keys at runtime (into this process's env, read back by the worker's key loader);
 * 3. deploys loop-1 with contracts/script/DeployLoop.s.sol (Anvil default account 0, `--unlocked`);
 * 4. sets up Rina: founder = Anvil account 1 signing the EIP-712 PlanApproval; the lender registers the founder,
 *    opens and funds the facility; the relayer commits the plan (all through the worker's outbox);
 * 5. runs the production jobs tick after tick with Anvil time warp (§12.4 cadence, 15–30 min per tick);
 * 6. prints the report and exits 0 only if every acceptance check passes. Job logs go to a JSON-lines file.
 *
 * Options (flag or env): --days (LOOP_DAYS, default 21), --wall-minutes (LOOP_WALL_MINUTES), --tick-minutes
 * (LOOP_TICK_MINUTES, default 15-30), --pace-ms (LOOP_PACE_MS; default 2000 with --wall-minutes), --ads-window-cap
 * (LOOP_ADS_WINDOW_CAP), --seed (LOOP_SEED), --anvil-port
 * (default 18548), --pg-port (default 55445), PG_BIN (default /opt/homebrew/opt/postgresql@16/bin), LOOP_TMP_DIR.
 */
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHogeePublicClient, gweiToWei, validateChainConfig } from '@hogee/chain';
import { createDb } from '@hogee/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createTestClient, http, parseEther } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { keyEnvName, loadSigners, SIGNER_ROLES } from '../config/keys';
import type { JobDeps } from '../jobs/deps';
import { MockRail } from '../rail/mock-rail';
import { createLogger } from '../runtime/log';
import { migrateWorkerSchema } from '../store/schema';
import { anvilAccount, deployLoop } from './deploy';
import { startInfra, type Infra } from './infra';
import { runLoop, seededRandom } from './loop';
import { buildReport } from './report';
import { platformPayeeHashes, setupRina } from './rina';

const DAY = 86_400n;
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle/', import.meta.url));

function option(name: string, env: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env[env];
}

function num(name: string, env: string, fallback?: number): number | undefined {
  const raw = option(name, env);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  const wallMinutes = num('wall-minutes', 'LOOP_WALL_MINUTES');
  const days = num('days', 'LOOP_DAYS', wallMinutes === undefined ? 21 : undefined);
  const [minM, maxM] = (option('tick-minutes', 'LOOP_TICK_MINUTES') ?? '15-30').split('-').map(Number);
  if (!minM || !maxM || minM > maxM) throw new Error('--tick-minutes must look like 15-30');
  const windowCap = option('ads-window-cap', 'LOOP_ADS_WINDOW_CAP');
  const seed = num('seed', 'LOOP_SEED', 1_016) as number;
  // A wall-clock soak paces itself (one tick every 2 s by default); a chain-day run goes as fast as Anvil allows.
  const paceMs = num('pace-ms', 'LOOP_PACE_MS', wallMinutes === undefined ? undefined : 2_000);
  const reuse = process.env.LOOP_RPC_URL && process.env.LOOP_DATABASE_URL;
  const tmpRoot = process.env.LOOP_TMP_DIR ?? tmpdir();

  let infra: Infra | undefined;
  const rpcUrl = reuse ? (process.env.LOOP_RPC_URL as string) : undefined;
  if (!reuse) {
    out('starting a throwaway Anvil and Postgres 16 ...');
    infra = await startInfra({ anvilPort: num('anvil-port', 'LOOP_ANVIL_PORT', 18_548) as number, pgPort: num('pg-port', 'LOOP_PG_PORT', 55_445) as number, pgBin: process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@16/bin', tmpRoot });
  }
  const logFile = join(tmpRoot, `hogee-loop-${Date.now()}.jsonl`);
  const logStream = createWriteStream(logFile);
  const db = createDb(infra?.databaseUrl ?? (process.env.LOOP_DATABASE_URL as string), { maxConnections: 8 });
  try {
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
    await migrateWorkerSchema(db.$client);
    const url = infra?.rpcUrl ?? (rpcUrl as string);
    const client = createHogeePublicClient(validateChainConfig({ chain: 'local', rpcUrls: [url], pollingIntervalMs: 50 }));
    const test = createTestClient({ mode: 'anvil', chain: anvil, transport: http(url) });

    Object.assign(process.env, Object.fromEntries(SIGNER_ROLES.map((role) => [keyEnvName(role, 'LOOP'), generatePrivateKey()])));
    const signers = loadSigners(process.env, 'LOOP', { scrub: true });
    for (const a of [signers.agent, signers.oracle, signers.lender, signers.relayer]) await test.setBalance({ address: a.address, value: parseEther('100') });

    const now = (await client.getBlock({ blockTag: 'latest' })).timestamp;
    const deploymentId = reuse ? `loop-${Date.now().toString(36)}` : 'loop-1';
    out(`deploying ${deploymentId} with contracts/script/DeployLoop.s.sol ...`);
    const deployment = await deployLoop({ deploymentId, rpcUrl: url, deployer: anvilAccount(0).address, lender: signers.lender.address, oracle: signers.oracle.address, judgingWindowEnd: now + 30n * DAY, platformPayees: platformPayeeHashes() });
    out(`PlanRegistry ${deployment.contracts.PlanRegistry.address}, Treasury ${deployment.contracts.Treasury.address}`);
    const capWei = gweiToWei('1000');
    const setup = await setupRina({ db, client, deployment, signers, founder: anvilAccount(1), facilityId: 'fac-rina', capWei, ...(windowCap ? { windowCapMinor: { ADS: windowCap } } : {}) });
    const ads = setup.manifest.lines.find((l) => l.lineKey === 'ADS');
    if (!ads?.pacing) throw new Error('the Rina plan has no ADS pacing line');
    out(`Rina's plan v1 committed (planHash ${setup.planHash}); ADS pacing ${ads.pacing.amountMinor}/day, window cap ${ads.windowCapMinor}`);

    const log = createLogger({ sink: (line) => logStream.write(`${line}\n`), base: { svc: 'loop-anvil' } });
    const deps: JobDeps = { db, client, signers, deployment, config: { maxFeeWei: capWei, lowBalanceWei: parseEther('1'), stuckPendingPasses: 5, payoutMaxAttempts: 3 }, log, rail: new MockRail(db.$client) };
    out(`running the loop (${wallMinutes !== undefined ? `${wallMinutes} wall-clock minutes` : `${days} chain days`}, ${minM}-${maxM} min per tick); job logs: ${logFile}`);
    const stats = await runLoop({
      deps,
      test,
      facilityId: setup.facilityId,
      lineKey: 'ADS',
      stepSeconds: { min: minM * 60, max: maxM * 60 },
      ...(days !== undefined ? { chainDays: days } : {}),
      ...(wallMinutes !== undefined ? { wallMs: wallMinutes * 60_000 } : {}),
      random: seededRandom(seed),
      progress: out,
      ...(paceMs !== undefined ? { paceMs } : {}),
    });
    const report = await buildReport({
      pool: db.$client,
      client,
      deployment,
      facilityId: setup.facilityId,
      lineKey: 'ADS',
      pacingMinor: BigInt(ads.pacing.amountMinor),
      windowCapMinor: BigInt(ads.windowCapMinor),
      windowSeconds: BigInt(ads.windowSeconds),
      stats,
    });
    out(report.text);
    out(JSON.stringify(report.summary));
    return report.ok ? 0 : 1;
  } finally {
    await db.$client.end();
    logStream.end();
    await infra?.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`loop:anvil failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
