/**
 * The officer's pause is not lost behind the CFO guard (fixr-cfo, re-check LOW 5). Every job shares one advisory lock,
 * and a job that found it busy used to be skipped, so a relay wake carrying a Treasury.pause waited for the next relay
 * cron (up to a minute) while cfo-guard held the lock. Now the relay wake waits for the lock while a tighten-only row
 * (pause, cancelLoosen) is pending and relays it as soon as the lock frees; without one it still skips at once. Anvil +
 * Postgres (TEST_RPC_URL, TEST_DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { facilitiesFor } from '../../src/jobs/facility';
import { relayWake } from '../../src/runtime/relay-wake';
import { withJobLock } from '../../src/runtime/lock';
import { silentLogger } from '../../src/runtime/log';
import { LIVE, LIVE_TIMEOUT_MS, newWorld, openLive, treasuryPaused, type Live, type World } from '../support/live';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE)('relay wake vs the job lock (live)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  const ids = async () => (await facilitiesFor(live.db.$client, { deploymentId: w.deployment.deploymentId, chainId: w.deployment.chainId })).map((f) => f.facilityId);
  /** Holds the shared job lock as a cfo-guard pass would, until `release()`. */
  function holdLock() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = withJobLock(live.db.$client, silentLogger, 'cfo-guard', () => gate);
    return { held, release };
  }

  beforeAll(async () => {
    live = await openLive();
    w = await newWorld(live);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it('without a tighten-only row pending, a wake that finds the lock busy is skipped at once (as before)', async () => {
    const lock = holdLock();
    await sleep(50);
    const started = Date.now();
    expect(await relayWake(w.deps(), ids)).toMatchObject({ ran: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    lock.release();
    expect(await lock.held).toMatchObject({ ran: true });
  });

  it('a pause queued while cfo-guard holds the lock is relayed as soon as the lock frees', async () => {
    const lock = holdLock();
    await sleep(50);
    // What POST /api/control/pause writes: an unsigned PENDING Treasury.pause, then a relay wake.
    await live.db.$client.query(`insert into chain_actions (id, facility_id, kind, ref_id, state, request_json) values ($1, $2, 'Treasury.pause', $2, 'PENDING', '{}'::jsonb)`, [
      `act-pause-${Date.now()}`,
      w.facilityId,
    ]);
    let done = false;
    const wake = relayWake(w.deps(), ids, { pollMs: 50 }).finally(() => (done = true));
    await sleep(1_000);
    expect(done).toBe(false); // waiting for the lock, not skipped
    const released = Date.now();
    lock.release();
    const r = await wake;
    expect(Date.now() - released).toBeLessThan(3_000);
    expect(r.ran).toBe(true);
    expect(r.reports.flatMap((x) => x.actions).filter((a) => a.kind === 'Treasury.pause').map((a) => a.result)).toEqual(['sent']);
    expect(await treasuryPaused(w)).toBe(true);
    // Re-check A-3: signed with the lender key, not behind the agent key's spends in flight.
    const signed = await live.db.$client.query(`select signer_address from chain_actions where facility_id = $1 and kind = 'Treasury.pause'`, [w.facilityId]);
    expect(signed.rows).toEqual([{ signer_address: w.signers.lender.address.toLowerCase() }]);
    await lock.held;
  });
});
