/**
 * Crash/restart (§12.3, T19 for the tick): `kill -9` the worker at every durable checkpoint of a tick, restart it
 * (tick + reconcile), and require exactly one payment: one Spent on chain, one live payment row, the agent key used
 * once, nothing recordDenied.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { iTreasuryAbi, toBytes32Tag } from '@hogee/chain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TickStep } from '../../src/jobs/deps';
import { runReconcile } from '../../src/jobs/reconcile';
import { runTick } from '../../src/jobs/tick';
import { DB_URL, deniedLogs, denialRows, finalizeAll, LIVE, LIVE_TIMEOUT_MS, lineSequence, mined, newWorld, openLive, paymentRows, RPC_URL, spentLogs, type Live, type World } from '../support/live';

const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

function crashTickAt(w: World, crashAt: TickStep): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...w.keys,
        CRASH_CHILD: JSON.stringify({ dbUrl: DB_URL, rpcUrl: RPC_URL, deployment: w.deployment, facilityId: w.facilityId, crashAt }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }));
  });
}

describe.skipIf(!LIVE)('crash mid-tick, then restart: exactly one payment', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await openLive();
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  async function restart(w: World): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      const tick = await runTick(w.deps(), w.facilityId);
      expect(tick.status).toBe('ok');
      await mined(live, tick);
      await runReconcile(w.deps(), [w.facilityId]);
      await live.test.mine({ blocks: 1 });
    }
    await finalizeAll(live);
    const last = await runReconcile(w.deps(), [w.facilityId]);
    expect(last.halted).toBe(false);
  }

  async function expectExactlyOnePayment(w: World): Promise<void> {
    const spent = await spentLogs(w);
    expect(spent).toHaveLength(1);
    expect(spent[0]?.args.amountMinor).toBe(7_500n);
    expect(await lineSequence(w, 'ADS')).toBe(2n);
    const rows = await paymentRows(w);
    expect(rows.filter((r) => !['POLICY_DENIED', 'REVERTED', 'CANCELLED'].includes(r.state))).toHaveLength(1);
    expect(rows[0]?.state).toBe('FINALIZED');
    expect(await live.client.getTransactionCount({ address: w.signers.agent.address })).toBe(1);
    expect(
      await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'rollingSpent', args: [toBytes32Tag('ADS')] }),
    ).toBe(7_500n);
    expect(await deniedLogs(w)).toEqual([]);
    expect(await denialRows(w)).toBe(0);
  }

  for (const step of ['inserted', 'signed', 'broadcast'] as const) {
    it(`kill -9 after "${step}"`, async () => {
      const w = await newWorld(live);
      const crash = await crashTickAt(w, step);
      expect(crash.signal, crash.err).toBe('SIGKILL');
      expect(JSON.parse(crash.out.trim())).toMatchObject({ step, paymentId: expect.stringMatching(/^pacing:ADS:\d+$/) });
      const before = await paymentRows(w);
      expect(before).toHaveLength(1);
      expect(before[0]?.state).toBe(step === 'inserted' ? 'POLICY_OK' : step === 'signed' ? 'SIGNED' : 'BROADCAST');
      await restart(w);
      await expectExactlyOnePayment(w);
    });
  }
});
