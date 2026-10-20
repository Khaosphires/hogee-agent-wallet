/**
 * `pnpm --filter @hogee/worker start` end to end: the process reads its env (keys by name), refuses nothing on a
 * correct deployment, runs reconcile + one tick at boot (a slot is paid), starts pg-boss, and on SIGTERM shuts down
 * gracefully with exit code 0. Its output never contains a key.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_URL, LIVE, LIVE_TIMEOUT_MS, newWorld, openLive, RPC_URL, spentLogs, type Live, type World } from '../support/live';

const WORKER_DIR = fileURLToPath(new URL('../../', import.meta.url));

function startWorker(w: World, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hogee-worker-'));
  const manifest = join(dir, 'deployment.json');
  writeFileSync(manifest, JSON.stringify(w.deployment));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: WORKER_DIR,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: DB_URL as string,
      CHAIN: 'local',
      LOCAL_RPC_URL: RPC_URL as string,
      DEPLOYMENT_ID: w.deployment.deploymentId,
      DEPLOYMENT_FILE: manifest,
      MAX_FEE_GWEI: '1000',
      LOW_BALANCE_ETH: '0.01',
      ...w.keys,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString()));
  child.stderr.on('data', (b: Buffer) => (out += b.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, output: () => out, exited };
}

async function until(fn: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!LIVE)('worker process (start / SIGTERM)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await openLive();
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it('boots, pays the first slot, and shuts down gracefully on SIGTERM; no key in its output', async () => {
    const w = await newWorld(live);
    const worker = startWorker(w);
    await until(() => worker.output().includes('"event":"pgboss_started"'), 60_000);
    expect(worker.output()).toContain('"event":"worker_ready"');
    const beat = await live.db.$client.query(`select status from hogee_worker.heartbeats where job = 'autonomous-tick' and scope = $1`, [w.facilityId]);
    expect(beat.rows[0]?.status).toBe('ok');
    await until(async () => (await spentLogs(w)).length === 1, 30_000);
    worker.child.kill('SIGTERM');
    expect(await worker.exited).toBe(0);
    expect(worker.output()).toContain('"event":"shutdown_complete"');
    for (const key of Object.values(w.keys)) expect(worker.output()).not.toContain(key.slice(2));
  });

  it('refuses to start when the oracle key is not the deployment oracle (fail closed)', async () => {
    const w = await newWorld(live);
    const worker = startWorker(w, { ORACLE_PRIVATE_KEY_LOOP: w.keys.RELAYER_PRIVATE_KEY_LOOP as string, RELAYER_PRIVATE_KEY_LOOP: w.keys.ORACLE_PRIVATE_KEY_LOOP as string });
    expect(await worker.exited).toBe(1);
    expect(worker.output()).toMatch(/"event":"worker_start_failed".*oracle key is not the deployment's oracle/);
  });
});
