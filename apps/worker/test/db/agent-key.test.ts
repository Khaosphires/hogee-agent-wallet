/**
 * Agent-key use outside the allocator (security re-check M4) against Postgres (TEST_DATABASE_URL) and a scripted
 * chain: the halt reason, the safety-pause request and the raised next_nonce are one transaction, so the use is
 * reported exactly once, and the pause path (lender first, agent fallback) picks the request up like an orphan's.
 */
import { randomUUID } from 'node:crypto';
import { readNextNonce, type DeploymentManifest, type HogeePublicClient } from '@hogee/chain';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerSigners } from '../../src/config/keys';
import { checkAgentKey, recordAgentKeyUse } from '../../src/jobs/agent-key';
import type { JobDeps } from '../../src/jobs/deps';
import { driveSafetyPause } from '../../src/jobs/safety-pause';
import { silentLogger } from '../../src/runtime/log';
import { activeHalt, haltReasons, raiseHalt } from '../../src/store/halt';
import { openSafetyPauses } from '../../src/store/safety-pause';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';
import { FakePauseChain } from '../support/fake-pause-chain';

const TREASURY: Address = '0x00000000000000000000000000000000000071e5';
const CHAIN_ID = 31337;
const DEPLOYMENT: DeploymentManifest = {
  chainId: CHAIN_ID,
  deploymentId: 'loop-1',
  chainTag: 'anvil',
  contracts: { PlanRegistry: { address: '0x00000000000000000000000000000000000000aa' }, Treasury: { address: TREASURY } },
  blockNumber: 1,
  deployedAt: '2026-10-01T00:00:00Z',
};

describe.skipIf(!DB_URL)('agent key use outside the allocator (Postgres + scripted chain)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await openTestDb();
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.db.$client.query('truncate hogee_worker.halts, hogee_worker.halt_events, hogee_worker.safety_pauses');
  });

  async function world(agentNext: bigint) {
    const [agent, oracle, lender, relayer] = [0, 1, 2, 3].map(() => privateKeyToAccount(generatePrivateKey()));
    const signers = { set: 'LOOP', agent, oracle, lender, relayer } as WorkerSigners;
    const facilityId = `fac-${randomUUID().slice(0, 8)}`;
    await t.db.$client.query(
      `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, 1000000, 'MYR', 300, $2, $3, $4)`,
      [facilityId, lender?.address.toLowerCase(), DEPLOYMENT.deploymentId, CHAIN_ID],
    );
    await t.db.$client.query('insert into nonces (signer_address, chain_id, next_nonce) values ($1, $2, $3)', [agent?.address.toLowerCase(), CHAIN_ID, agentNext.toString()]);
    const chain = new FakePauseChain();
    const deps = (): JobDeps => ({
      db: t.db,
      client: chain.client as unknown as HogeePublicClient,
      signers,
      deployment: DEPLOYMENT,
      config: { maxFeeWei: 100n * 1_000_000_000n, lowBalanceWei: 0n, stuckPendingPasses: 3, payoutMaxAttempts: 3 },
      log: silentLogger,
    });
    return { facilityId, signers, chain, deps, agent: (agent as NonNullable<typeof agent>).address };
  }
  const next = (signer: Address) => readNextNonce(t.db, { signer, chainId: CHAIN_ID });

  it('a pending agent nonce the allocator never handed out halts, queues a safety pause and raises next_nonce, once', async () => {
    const w = await world(3n);
    w.chain.mined.set(w.agent.toLowerCase(), 5n);
    w.chain.pending.set(w.agent.toLowerCase(), 5n); // nonces 3 and 4 were used by someone else

    const first = await checkAgentKey(w.deps(), [w.facilityId]);
    expect(first.finding).toMatchObject({ reason: 'EXTERNAL_AGENT_KEY_USE', detail: { role: 'agent', dbNext: '3', chainPending: '5' } });
    const halt = await activeHalt(t.db.$client);
    expect(halt?.reason).toBe('EXTERNAL_AGENT_KEY_USE');
    expect(await openSafetyPauses(t.db.$client)).toEqual([
      expect.objectContaining({ id: `agent-key:${w.agent.toLowerCase()}:3`, haltId: halt?.id, reason: 'EXTERNAL_AGENT_KEY_USE' }),
    ]);
    expect(await next(w.agent)).toBe(5n);
    const traces = await t.db.$client.query<{ n: number }>(`select count(*)::int as n from traces where facility_id = $1 and reason_code = 'EXTERNAL_AGENT_KEY_USE'`, [w.facilityId]);
    expect(traces.rows[0]?.n).toBe(1);

    // The next pass sees nothing new: the use is reported exactly once (and survives an `ops resume`).
    expect((await checkAgentKey(w.deps(), [w.facilityId])).finding).toBeNull();
    expect((await haltReasons(t.db.$client, halt?.id as string)).map((r) => r.reason)).toEqual(['EXTERNAL_AGENT_KEY_USE']);
    expect(await openSafetyPauses(t.db.$client)).toHaveLength(1);
  });

  it('every nonce the allocator handed out is no finding (no false positive from the worker’s own sends)', async () => {
    const w = await world(4n);
    w.chain.mined.set(w.agent.toLowerCase(), 3n);
    w.chain.pending.set(w.agent.toLowerCase(), 4n); // nonce 3 signed and stored by the worker, still in the pool
    expect((await checkAgentKey(w.deps(), [w.facilityId])).finding).toBeNull();
    expect(await activeHalt(t.db.$client)).toBeNull();
  });

  it('during an operator halt the reason joins it and the pause request is bound to it', async () => {
    const w = await world(1n);
    const { halt } = await raiseHalt(t.db.$client, silentLogger, 'OPERATOR_HALT', { note: 'drill' });
    w.chain.pending.set(w.agent.toLowerCase(), 2n);
    await checkAgentKey(w.deps(), [w.facilityId]);
    expect((await haltReasons(t.db.$client, halt.id)).map((r) => r.reason)).toEqual(['OPERATOR_HALT', 'EXTERNAL_AGENT_KEY_USE']);
    expect((await openSafetyPauses(t.db.$client)).map((r) => r.haltId)).toEqual([halt.id]);
  });

  it('is all or nothing: a failure while recording leaves no halt, no request and next_nonce untouched (re-detected next pass)', async () => {
    const w = await world(3n);
    await expect(
      recordAgentKeyUse(t.db.$client, silentLogger, { signer: w.agent, chainId: CHAIN_ID, dbNext: 3n, chainPending: 5n }, ['fac-that-does-not-exist']),
    ).rejects.toThrow();
    expect(await activeHalt(t.db.$client)).toBeNull();
    expect(await openSafetyPauses(t.db.$client)).toEqual([]);
    expect(await next(w.agent)).toBe(3n);
  });

  it('the safety pause driver drives the request: lender first', async () => {
    const w = await world(3n);
    w.chain.pending.set(w.agent.toLowerCase(), 4n);
    await checkAgentKey(w.deps(), [w.facilityId]);
    const pass = await driveSafetyPause(w.deps(), [w.facilityId]);
    expect(pass.attempts).toEqual([expect.objectContaining({ role: 'lender', action: 'sent' })]);
  });

  it('an agent use that appears right before the agent fallback signs is recorded there too', async () => {
    const w = await world(3n);
    const { halt } = await raiseHalt(t.db.$client, silentLogger, 'ORPHAN_SPEND', { txHash: '0x01' });
    await t.db.$client.query(`insert into hogee_worker.safety_pauses (id, halt_id, reason) values ('orphan:0x01:0', $1, 'ORPHAN_SPEND')`, [halt.id]);
    const lender = w.signers.lender.address;
    w.chain.refuse = (tx) => (tx.from === lender ? 'insufficient funds for gas * price + value' : null);
    w.chain.pending.set(w.agent.toLowerCase(), 4n); // used after the pass's nonce check, before the fallback
    const pass = await driveSafetyPause(w.deps(), [w.facilityId]);
    expect(pass.attempts.map((a) => [a.role, a.action])).toEqual([
      ['lender', 'failed'],
      ['agent', 'sent'],
    ]);
    expect((await haltReasons(t.db.$client, halt.id)).map((r) => r.reason)).toEqual(['ORPHAN_SPEND', 'EXTERNAL_AGENT_KEY_USE']);
  });
});
