/**
 * The orphan safety-pause driver against Postgres (TEST_DATABASE_URL) and a scripted chain (test/support/fake-pause-
 * chain.ts): what a DB writer can make the worker sign (H1), and node refusals that must never block the fallback (H2).
 */
import { randomUUID } from 'node:crypto';
import { buildPause, feeBump, readTarget, type DeploymentManifest, type HogeePublicClient } from '@hogee/chain';
import { keccak256, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actionTarget } from '../../src/chain/actions';
import type { WorkerSigners } from '../../src/config/keys';
import type { JobDeps } from '../../src/jobs/deps';
import { driveSafetyPause } from '../../src/jobs/safety-pause';
import { silentLogger } from '../../src/runtime/log';
import { raiseHalt } from '../../src/store/halt';
import { openSafetyPauses, queueSafetyPause } from '../../src/store/safety-pause';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';
import { FakePauseChain, recording } from '../support/fake-pause-chain';

const TREASURY: Address = '0x00000000000000000000000000000000000071e5';
const ATTACKER: Address = '0x000000000000000000000000000000000000bad0';
const PAUSE = buildPause().data;
const DEPLOYMENT: DeploymentManifest = {
  chainId: 31337,
  deploymentId: 'loop-1',
  chainTag: 'anvil',
  contracts: { PlanRegistry: { address: '0x00000000000000000000000000000000000000aa' }, Treasury: { address: TREASURY } },
  blockNumber: 1,
  deployedAt: '2026-10-01T00:00:00Z',
};
const CAP_WEI = 100n * 1_000_000_000n;
const INSUFFICIENT = 'insufficient funds for gas * price + value';

interface World {
  readonly facilityId: string;
  readonly requestId: string;
  readonly signers: WorkerSigners;
  readonly chain: FakePauseChain;
  deps(over?: Partial<JobDeps>): JobDeps;
}

describe.skipIf(!DB_URL)('safety pause driver (Postgres + scripted chain)', () => {
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

  async function world(): Promise<World> {
    const [agent, oracle, lender, relayer] = [0, 1, 2, 3].map(() => privateKeyToAccount(generatePrivateKey()));
    const signers = { set: 'LOOP', agent, oracle, lender, relayer } as WorkerSigners;
    const facilityId = `fac-${randomUUID().slice(0, 8)}`;
    await t.db.$client.query(
      `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, 1000000, 'MYR', 300, $2, $3, $4)`,
      [facilityId, lender?.address.toLowerCase(), DEPLOYMENT.deploymentId, DEPLOYMENT.chainId],
    );
    const { halt } = await raiseHalt(t.db.$client, silentLogger, 'ORPHAN_SPEND', { facilityId });
    const requestId = `orphan:${facilityId}:0`;
    await queueSafetyPause(t.db.$client, { id: requestId, haltId: halt.id, reason: 'ORPHAN_SPEND', detail: {} });
    const chain = new FakePauseChain();
    return {
      facilityId,
      requestId,
      signers,
      chain,
      deps: (over = {}) => ({
        db: t.db,
        client: chain.client as unknown as HogeePublicClient,
        signers,
        deployment: DEPLOYMENT,
        config: { maxFeeWei: CAP_WEI, lowBalanceWei: 0n, stuckPendingPasses: 3, payoutMaxAttempts: 3 },
        log: silentLogger,
        ...over,
      }),
    };
  }

  const storedRaw = async (w: World, id: string): Promise<Hex | null> => (await readTarget(t.db, actionTarget(w.facilityId, id)))?.rawSignedTx ?? null;

  it('H1: stored bytes a DB writer swapped into a pending pause are never re-signed by the lender; a fresh pause follows', async () => {
    const w = await world();
    const pass1 = await driveSafetyPause(w.deps(), [w.facilityId]);
    expect(pass1.attempts).toEqual([expect.objectContaining({ role: 'lender', action: 'sent', nonce: '0' })]);
    const attemptId = pass1.attempts[0]?.id as string;

    // The DB writer swaps in a tx a throwaway key signed: the lender's whole balance to the attacker, same nonce.
    const throwaway = privateKeyToAccount(generatePrivateKey());
    const swapped = await throwaway.signTransaction({
      type: 'eip1559',
      chainId: DEPLOYMENT.chainId,
      nonce: 0,
      to: ATTACKER,
      value: parseEther('10'),
      gas: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    await t.db.$client.query('update chain_actions set raw_signed_tx = $3, tx_hash = $4 where facility_id = $1 and id = $2', [w.facilityId, attemptId, swapped, keccak256(swapped)]);
    const lender = recording(w.signers.lender);

    // Layer (a): the fee bump itself refuses before anything is signed.
    await expect(
      feeBump(t.db, { target: actionTarget(w.facilityId, attemptId), account: lender.account, client: w.chain.client, capWei: CAP_WEI, chainId: DEPLOYMENT.chainId, deployment: DEPLOYMENT }),
    ).rejects.toThrow(/not signed by the account; not re-signed/);
    expect(lender.signed).toEqual([]);

    // Layer (b): the driver judges the attempt failed without touching it, and sends a fresh pause.
    const pass2 = await driveSafetyPause(w.deps({ signers: { ...w.signers, lender: lender.account } }), [w.facilityId]);
    expect(pass2.error).toBeUndefined();
    expect(pass2.attempts.map((a) => [a.id === attemptId, a.role, a.action])).toEqual([
      [true, 'lender', 'failed'],
      [false, 'lender', 'sent'],
    ]);
    expect(pass2.attempts[0]?.detail).toMatch(/not this Treasury's pause\(\)/);
    expect(lender.signed.length).toBe(1);
    expect(lender.signed.every((tx) => tx.to?.toLowerCase() === TREASURY.toLowerCase() && tx.data === PAUSE && (tx.value ?? 0n) === 0n)).toBe(true);
    expect([...w.chain.accepted, ...w.chain.refused].some((tx) => tx.to?.toLowerCase() === ATTACKER.toLowerCase())).toBe(false);
    expect(await storedRaw(w, attemptId)).toBe(swapped);
  });

  it('H2: a node that refuses the bumped re-send (insufficient funds) does not block the pass: fresh attempts follow, down to the agent', async () => {
    const w = await world();
    const pass1 = await driveSafetyPause(w.deps(), [w.facilityId]);
    const attemptId = pass1.attempts[0]?.id as string;
    const accepted = await storedRaw(w, attemptId);
    const lender = w.signers.lender.address;
    w.chain.refuse = (tx) => (tx.from === lender ? INSUFFICIENT : null);

    const pass2 = await driveSafetyPause(w.deps(), [w.facilityId]);
    expect(pass2.error).toBeUndefined();
    expect(pass2.attempts.map((a) => [a.role, a.action])).toEqual([
      ['lender', 'failed'],
      ['lender', 'failed'],
      ['agent', 'sent'],
    ]);
    expect(pass2.attempts[0]).toMatchObject({ id: attemptId, detail: expect.stringMatching(/refused the re-send/) });
    // The bump was signed and refused: the row keeps the bytes the node did accept, not the refused ones.
    expect(w.chain.refused.some((tx) => tx.from === lender && tx.nonce === 0n)).toBe(true);
    expect(await storedRaw(w, attemptId)).toBe(accepted);
    const [req] = await openSafetyPauses(t.db.$client);
    expect(req?.lastAttemptId).toBe(pass2.attempts[2]?.id);

    // The next pass works on the agent's attempt, not on the lender's refused one.
    w.chain.refuse = () => null;
    const pass3 = await driveSafetyPause(w.deps(), [w.facilityId]);
    expect(pass3.attempts).toEqual([expect.objectContaining({ id: pass2.attempts[2]?.id, role: 'agent', action: 'bumped' })]);
  });

  it('L2: a pause seen only at latest is not confirmed: requests close once paused() reads true at the safe block', async () => {
    const w = await world();
    await driveSafetyPause(w.deps(), [w.facilityId]);
    w.chain.paused = { latest: true, safe: false }; // mined, but a reorg can still drop it
    const pending = await driveSafetyPause(w.deps(), [w.facilityId]);
    expect(pending).toMatchObject({ live: 1, paused: true, pausedSafe: false, attempts: [], closed: [] });
    expect(await openSafetyPauses(t.db.$client)).toHaveLength(1);
    w.chain.paused = { latest: false, safe: false }; // the reorg dropped it: the driver acts again
    expect((await driveSafetyPause(w.deps(), [w.facilityId])).attempts.length).toBeGreaterThan(0);
    w.chain.paused = { latest: true, safe: true };
    const confirmed = await driveSafetyPause(w.deps(), [w.facilityId]);
    expect(confirmed).toMatchObject({ paused: true, pausedSafe: true, closed: [{ id: w.requestId, reason: 'PAUSED' }] });
    expect(await openSafetyPauses(t.db.$client)).toEqual([]);
  });

  it.each(['replacement transaction underpriced', 'txpool is full', 'max fee per gas less than block base fee'])(
    'H2: "%s" on the re-send of a pending pause leads to a fresh attempt in the same pass',
    async (reason) => {
      const w = await world();
      const pass1 = await driveSafetyPause(w.deps(), [w.facilityId]);
      const lender = w.signers.lender.address;
      w.chain.refuse = (tx) => (tx.from === lender && tx.nonce === 0n ? reason : null);
      const pass2 = await driveSafetyPause(w.deps(), [w.facilityId]);
      expect(pass2.error).toBeUndefined();
      expect(pass2.attempts.map((a) => [a.id === pass1.attempts[0]?.id, a.role, a.action])).toEqual([
        [true, 'lender', 'failed'],
        [false, 'lender', 'sent'],
      ]);
    },
  );
});
