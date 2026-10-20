/**
 * reconcile halt rules on Anvil + Postgres (task 1.6): an `error` outcome, an `occupied` nonce hole-fill and a
 * non-canonical `pending` that stays stuck for N passes each halt new signing; the halt is a DB row plus an error
 * log line, and an operator resumes it. An orphan Spent (the agent key used outside the backend, T29) halts and
 * pauses the treasury, and the safety pause holds up: (A) a second orphan after an unpause and a resume, (B) a pause
 * whose nonce is replaced, (C) an orphan during an operator halt, (D) a lender that cannot pause (agent fallback),
 * (E) a pending pause fee-bumped in place, (F) fees above MAX_SAFETY_FEE_GWEI reported, not skipped, (G) an agent
 * nonce used outside the allocator halts and pauses before any finality (M4), (H) stored bytes a DB writer swapped
 * into a pending pause are never re-signed (H1). (A)-(E) and (G) first let the worker sign one agent spend, so the
 * agent key has a `nonces` row: its leaked use then also raises EXTERNAL_AGENT_KEY_USE (with its own pause request)
 * before the orphan is read at finalized. Requests close only once paused() holds at the safe block (L2).
 */
import {
  buildExecuteLoosen,
  buildQueueLoosen,
  buildSpend,
  decisionIdToBytes32,
  HOGEE_KINDS,
  hogeeDomain,
  hogeeTypedData,
  iTreasuryAbi,
  loosenId,
  sequenceInvoiceHash,
  shortIdToBytes32,
  toBytes32Tag,
  type HogeePublicClient,
  type LoosenRequestMessage,
} from '@hogee/chain';
import { keccak256Utf8, ZERO_HEX32 } from '@hogee/core';
import { createWalletClient, http, keccak256, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anvilAccount } from '../../src/harness/deploy';
import { runReconcile } from '../../src/jobs/reconcile';
import { runTick } from '../../src/jobs/tick';
import { runOps } from '../../src/ops/cli';
import { createLogger } from '../../src/runtime/log';
import { activeHalt, clearHalt, haltReasons } from '../../src/store/halt';
import { silentLogger } from '../../src/runtime/log';
import { uuidv7 } from '../../src/runtime/ids';
import { recording } from '../support/fake-pause-chain';
import {
  DAY,
  finalizeAll,
  leakedSpend,
  LIVE,
  LIVE_TIMEOUT_MS,
  mined,
  newWorld,
  openLive,
  primeAgentNonce,
  resumeArgs,
  RPC_URL,
  spentLogs,
  treasuryPaused,
  warp,
  type Live,
  type World,
} from '../support/live';

/** The finality outcome of the facility's payment row (setup chain actions are in the same pass). */
function paymentOutcome(r: Awaited<ReturnType<typeof runReconcile>>) {
  return r.facilities[0]?.finality.find((o) => o.target.table === 'payments');
}

/** Founder + lender co-sign LOOSEN_UNPAUSE; anyone submits it, and executes it once the timelock (24 h on loop-1) passed. */
async function unpauseByLoosen(w: World): Promise<void> {
  const treasury = w.deployment.contracts.Treasury.address;
  const now = (await w.live.client.getBlock({ blockTag: 'latest' })).timestamp;
  const req: LoosenRequestMessage = {
    kind: HOGEE_KINDS.LOOSEN_UNPAUSE,
    target: ZERO_HEX32 as Hex,
    aux: ZERO_HEX32 as Hex,
    newValue: 0n,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: 9_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
    expiry: now + DAY,
  };
  const domain = hogeeDomain({ verifyingContract: treasury, chainTag: toBytes32Tag(w.deployment.chainTag), deploymentId: toBytes32Tag(w.deployment.deploymentId) });
  const typed = hogeeTypedData('LoosenRequest', domain, req) as never;
  const founderSig = await anvilAccount(1).signTypedData(typed);
  const lenderSig = await w.signers.lender.signTypedData(typed);
  const anyone = createWalletClient({ account: anvilAccount(2), chain: anvil, transport: http(RPC_URL) });
  const send = async (data: Hex) => {
    const receipt = await w.live.client.waitForTransactionReceipt({ hash: await anyone.sendTransaction({ to: treasury, data }) });
    if (receipt.status !== 'success') throw new Error('loosen tx reverted');
  };
  await send(buildQueueLoosen({ req, founder: { kind: 0, data: founderSig }, lender: { kind: 0, data: lenderSig } }).data);
  await warp(w.live, DAY + 60n);
  await send(buildExecuteLoosen({ loosenId: loosenId(req) }).data);
}

/** The client with some methods replaced (fault injection). */
function faulty(client: HogeePublicClient, over: Partial<Record<keyof HogeePublicClient, unknown>>): HogeePublicClient {
  return new Proxy(client, { get: (target, prop, receiver) => (prop in over ? over[prop as keyof HogeePublicClient] : Reflect.get(target, prop, receiver)) });
}

describe.skipIf(!LIVE)('reconcile: alert-and-halt (Anvil + Postgres)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await openLive();
  }, LIVE_TIMEOUT_MS);
  afterEach(async () => {
    await live.test.setAutomine(true);
    await clearHalt(live.db.$client, silentLogger, { by: 'test-teardown', note: 'next test', ackThrough: 'all', abandonPause: true });
  });
  afterAll(async () => {
    await live?.close();
  });

  it('an error outcome halts new signing (DB row + error log); `ops resume` clears it', async () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
    const w = await newWorld(live, { log });
    await live.test.setAutomine(false);
    const tick = await runTick(w.deps(), w.facilityId); // broadcast, not mined: an open row for recovery
    expect(tick.lines[0]).toMatchObject({ decision: 'propose' });
    const broken = faulty(live.client, {
      readContract: async () => {
        throw new Error('rpc read failed');
      },
    });
    const pass = await runReconcile(w.deps({ client: broken }), [w.facilityId]);
    expect(pass.facilities[0]?.recovery.find((o) => o.target.table === 'payments')?.action).toBe('error');
    expect(pass.halts.map((h) => h.reason)).toContain('RECOVERY_ERROR');
    expect(pass.halted).toBe(true);
    expect((await activeHalt(live.db.$client))?.reason).toBe('RECOVERY_ERROR');
    expect(lines.some((l) => l.event === 'halt_raised' && l.level === 'error' && l.reason === 'RECOVERY_ERROR')).toBe(true);

    await live.test.mine({ blocks: 1 });
    await live.test.setAutomine(true);
    await live.test.increaseTime({ seconds: 86_400 });
    await live.test.mine({ blocks: 1 });
    expect((await runTick(w.deps(), w.facilityId)).status).toBe('halted'); // nothing is signed while halted

    const out: string[] = [];
    expect(await runOps(await resumeArgs(live, 'checked the RPC'), { db: live.db, log: silentLogger, print: (s) => out.push(s) })).toBe(0);
    expect(out.join('\n')).toMatch(/resumed.*RECOVERY_ERROR/);
    expect(await activeHalt(live.db.$client)).toBeNull();
    await runReconcile(w.deps(), [w.facilityId]);
    const next = await runTick(w.deps(), w.facilityId);
    expect(next.lines[0]).toMatchObject({ decision: 'propose', slot: 2 });
  });

  it('a halt raised in a pass stops the same pass from signing hole cancels', async () => {
    const w = await newWorld(live);
    await live.test.setAutomine(false);
    await runTick(w.deps(), w.facilityId); // an open payment row for recovery
    const oracle = w.signers.oracle.address;
    await live.db.$client.query('insert into nonces (signer_address, chain_id, next_nonce) values ($1, $2, 1)', [oracle.toLowerCase(), 31337]); // hole at 0
    const broken = faulty(live.client, {
      readContract: async () => {
        throw new Error('rpc read failed');
      },
    });
    const pass = await runReconcile(w.deps({ client: broken }), [w.facilityId]);
    expect(pass.halts.map((h) => h.reason)).toContain('RECOVERY_ERROR');
    expect(pass.nonces.find((n) => n.role === 'oracle')).toMatchObject({ holes: 1, cancels: 0 });
    expect(await live.client.getTransactionCount({ address: oracle, blockTag: 'pending' })).toBe(0);
    await live.test.mine({ blocks: 1 });
  });

  it('an occupied nonce hole-fill halts', async () => {
    const w = await newWorld(live);
    const agent = w.signers.agent.address.toLowerCase();
    await live.db.$client.query('insert into nonces (signer_address, chain_id, next_nonce) values ($1, $2, 1) on conflict (signer_address, chain_id) do update set next_nonce = 1', [agent, 31337]);
    // Nonce 0 is now a hole no row holds. Another tx already waits in the mempool at that nonce with higher fees.
    await live.test.setAutomine(false);
    const fees = await live.client.estimateFeesPerGas();
    const wallet = createWalletClient({ account: w.signers.agent, chain: anvil, transport: http(RPC_URL) });
    await wallet.sendTransaction({ to: w.signers.agent.address, value: 0n, nonce: 0, gas: 21_000n, maxFeePerGas: fees.maxFeePerGas * 3n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 3n });
    const pass = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass.halts).toContainEqual(expect.objectContaining({ reason: 'NONCE_HOLE_OCCUPIED' }));
    expect((await activeHalt(live.db.$client))?.reason).toBe('NONCE_HOLE_OCCUPIED');
    await live.test.mine({ blocks: 1 });
  });

  it('a non-canonical pending halts only after N passes', async () => {
    const w = await newWorld(live);
    const tick = await runTick(w.deps(), w.facilityId);
    await mined(live, tick);
    await runReconcile(w.deps(), [w.facilityId]); // → INCLUDED
    await finalizeAll(live);
    const receipt = await live.client.getTransactionReceipt({ hash: tick.lines[0]?.txHash as Hex });
    const reorged = faulty(live.client, {
      getBlock: async (args: { blockNumber?: bigint }) => {
        const block = await live.client.getBlock(args as never);
        return args.blockNumber === receipt.blockNumber ? { ...block, hash: keccak256Utf8('another fork') } : block;
      },
    });
    for (let pass = 1; pass <= 3; pass += 1) {
      const r = await runReconcile(w.deps({ client: reorged }), [w.facilityId]);
      expect(paymentOutcome(r)).toMatchObject({ action: 'pending', detail: expect.stringContaining('not the canonical block') });
      expect(r.halted).toBe(pass === 3);
    }
    expect((await activeHalt(live.db.$client))?.reason).toBe('NON_CANONICAL_STUCK');
    await clearHalt(live.db.$client, silentLogger, { by: 'test', note: 'canonical again', ackThrough: 'all' });
    const healed = await runReconcile(w.deps(), [w.facilityId]);
    expect(paymentOutcome(healed)).toMatchObject({ action: 'finalized' });
    expect(healed.halted).toBe(false);
  });

  it('an orphan Spent (agent key used outside the backend) halts and pauses the treasury', async () => {
    const w = await newWorld(live);
    const wallet = createWalletClient({ account: w.signers.agent, chain: anvil, transport: http(RPC_URL) });
    const call = buildSpend({
      lineId: toBytes32Tag('ADS'),
      payeeId: shortIdToBytes32('shopee-ads'),
      amountMinor: 7_500n,
      invoiceHash: sequenceInvoiceHash(1n),
      planVersion: 1,
      decisionId: decisionIdToBytes32(uuidv7()),
      rationaleHash: keccak256Utf8('leaked key') as Hex,
    });
    const hash = await wallet.sendTransaction({ to: w.deployment.contracts.Treasury.address, data: call.data });
    await live.client.waitForTransactionReceipt({ hash });
    await finalizeAll(live);
    const pass = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass.orphans).toEqual([expect.objectContaining({ event: 'Spent', reason: 'NO_ROW', txHash: hash })]);
    expect((await activeHalt(live.db.$client))?.reason).toBe('ORPHAN_SPEND');
    await live.test.mine({ blocks: 1 });
    expect(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'paused' })).toBe(true);
    expect(await spentLogs(w)).toHaveLength(1);
    // The next pass does not report the same orphan twice (the cursor moved with the halt, in one transaction).
    expect((await runReconcile(w.deps(), [w.facilityId])).orphans).toEqual([]);
  });
  it('(A) a second orphan after an unpause and `ops resume` gets a fresh pause (one pause request per orphan)', async () => {
    const w = await newWorld(live);
    await primeAgentNonce(w);
    const first = await leakedSpend(w, 2n);
    await finalizeAll(live);
    const pass1 = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass1.orphans).toEqual([expect.objectContaining({ event: 'Spent', txHash: first })]);
    expect(await treasuryPaused(w)).toBe(true);
    await finalizeAll(live); // the pause is past the safe block: its requests close
    expect((await runReconcile(w.deps(), [w.facilityId])).safetyPause.closed.map((c) => c.reason)).toEqual(['PAUSED', 'PAUSED']);

    await unpauseByLoosen(w); // founder + lender end the pause through the timelock
    expect(await treasuryPaused(w)).toBe(false);
    expect(await runOps(await resumeArgs(live, 'first orphan handled'), { db: live.db, log: silentLogger, print: () => undefined })).toBe(0);
    expect(await activeHalt(live.db.$client)).toBeNull();
    // No open request survives the resume: the founder's unpause is not undone.
    await runReconcile(w.deps(), [w.facilityId]);
    expect(await treasuryPaused(w)).toBe(false);

    const second = await leakedSpend(w, 3n);
    await finalizeAll(live);
    const pass2 = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass2.orphans).toEqual([expect.objectContaining({ event: 'Spent', txHash: second })]);
    const halt = await activeHalt(live.db.$client);
    expect((await haltReasons(live.db.$client, halt?.id as string)).map((r) => r.reason)).toEqual(['EXTERNAL_AGENT_KEY_USE', 'ORPHAN_SPEND']);
    await runReconcile(w.deps(), [w.facilityId]);
    expect(await treasuryPaused(w)).toBe(true);
  });

  it('(B) a pause whose nonce is consumed by a replacement counts as failed and is retried until paused() is true', async () => {
    const w = await newWorld(live);
    await primeAgentNonce(w);
    await leakedSpend(w, 2n);
    await finalizeAll(live);
    await live.test.setAutomine(false);
    const pass1 = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass1.safetyPause.attempts).toEqual([expect.objectContaining({ action: 'sent', role: 'lender' })]);
    const [attempt] = (
      await live.db.$client.query<{ signer_address: string; nonce: string; raw_signed_tx: string }>(
        `select signer_address, nonce::text as nonce, raw_signed_tx from chain_actions where facility_id = $1 and kind = 'Treasury.pause' and raw_signed_tx is not null`,
        [w.facilityId],
      )
    ).rows;
    expect(attempt?.signer_address).toBe(w.signers.lender.address.toLowerCase());
    // The pause's nonce is taken by another tx of the same signer, with fees 20 % higher (a replacement).
    const fees = await live.client.estimateFeesPerGas();
    const signer = attempt?.signer_address === w.signers.agent.address.toLowerCase() ? w.signers.agent : w.signers.lender;
    const wallet = createWalletClient({ account: signer, chain: anvil, transport: http(RPC_URL) });
    await wallet.sendTransaction({ to: signer.address, value: 0n, nonce: Number(attempt?.nonce), gas: 21_000n, maxFeePerGas: fees.maxFeePerGas * 12n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 12n + 1n });
    await live.test.mine({ blocks: 1 });
    expect(await treasuryPaused(w)).toBe(false);
    await live.test.setAutomine(true);
    const pass2 = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass2.safetyPause.attempts).toEqual([expect.objectContaining({ action: 'sent' })]);
    await runReconcile(w.deps(), [w.facilityId]);
    expect(await treasuryPaused(w)).toBe(true);
  });

  it('(C) an orphan during an operator halt still pauses: the reason is recorded and the pause is sent', async () => {
    const w = await newWorld(live);
    await primeAgentNonce(w);
    expect(await runOps(['halt', '--reason', 'ops'], { db: live.db, log: silentLogger, print: () => undefined })).toBe(0);
    await leakedSpend(w, 2n);
    await finalizeAll(live);
    await runReconcile(w.deps(), [w.facilityId]);
    await runReconcile(w.deps(), [w.facilityId]);
    expect(await treasuryPaused(w)).toBe(true);
    const halt = await activeHalt(live.db.$client);
    expect(halt?.reason).toBe('OPERATOR_HALT');
    expect((await haltReasons(live.db.$client, halt?.id as string)).map((r) => r.reason)).toEqual(['OPERATOR_HALT', 'EXTERNAL_AGENT_KEY_USE', 'ORPHAN_SPEND']);
  });

  it('(D) when the lender cannot pause, the agent key does, its next_nonce raised past the leaked use when it was found', async () => {
    const w = await newWorld(live);
    await primeAgentNonce(w);
    expect(await runOps(['halt', '--reason', 'ops'], { db: live.db, log: silentLogger, print: () => undefined })).toBe(0);
    await leakedSpend(w, 2n); // the agent's chain nonce is now ahead of its nonces row (recorded and raised by the pass)
    await finalizeAll(live);
    await live.test.setBalance({ address: w.signers.lender.address, value: 0n }); // the lender's pause cannot be sent
    try {
      const pass = await runReconcile(w.deps(), [w.facilityId]);
      expect(pass.safetyPause.attempts.map((a) => [a.role, a.action])).toEqual([
        ['lender', 'failed'],
        ['agent', 'sent'],
      ]);
      expect(await treasuryPaused(w)).toBe(true);
    } finally {
      await live.test.setBalance({ address: w.signers.lender.address, value: parseEther('10') });
    }
  });
  it('(E) a pause still pending on the next pass is re-signed at its nonce with higher fees, then lands', async () => {
    const w = await newWorld(live);
    await primeAgentNonce(w);
    await leakedSpend(w, 2n);
    await finalizeAll(live);
    await live.test.setAutomine(false);
    const first = await runReconcile(w.deps(), [w.facilityId]);
    const sent = first.safetyPause.attempts[0];
    expect(sent).toMatchObject({ action: 'sent', role: 'lender' });
    const second = await runReconcile(w.deps(), [w.facilityId]); // still in the mempool
    expect(second.safetyPause.attempts).toEqual([expect.objectContaining({ id: sent?.id, action: 'bumped', nonce: sent?.nonce })]);
    expect(second.safetyPause.attempts[0]?.txHash).not.toBe(sent?.txHash);
    await live.test.setAutomine(true);
    expect(await treasuryPaused(w)).toBe(true);
    // Paused at latest only: nothing more is sent, and nothing closes until the pause is past the safe block.
    expect((await runReconcile(w.deps(), [w.facilityId])).safetyPause).toMatchObject({ paused: true, pausedSafe: false, attempts: [], closed: [] });
    await finalizeAll(live);
    const closed = (await runReconcile(w.deps(), [w.facilityId])).safetyPause.closed;
    expect(closed.map((c) => c.reason)).toEqual(['PAUSED', 'PAUSED']); // the agent-key request and the orphan's
  });

  it('(F) fees above MAX_SAFETY_FEE_GWEI sign nothing but are reported every pass, never skipped silently', async () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
    const w = await newWorld(live, { log });
    await leakedSpend(w, 1n);
    await finalizeAll(live);
    const capped = w.deps({ config: { maxFeeWei: 1n, maxSafetyFeeWei: 1n, lowBalanceWei: 0n, stuckPendingPasses: 3, payoutMaxAttempts: 3 } });
    const pass = await runReconcile(capped, [w.facilityId]);
    expect(pass.safetyPause.attempts.map((a) => [a.role, a.action])).toEqual([
      ['lender', 'failed'],
      ['agent', 'failed'],
    ]);
    expect(pass.safetyPause.attempts[0]?.detail).toMatch(/above MAX_SAFETY_FEE_GWEI/);
    expect(lines.some((l) => l.event === 'treasury_still_unpaused' && l.level === 'error')).toBe(true);
    expect(await treasuryPaused(w)).toBe(false);
    await runReconcile(w.deps(), [w.facilityId]); // fees within the cap again
    expect(await treasuryPaused(w)).toBe(true);
  });

  it('(G) an agent nonce used outside the allocator halts and pauses at once, before any finality (M4)', async () => {
    const w = await newWorld(live);
    await primeAgentNonce(w);
    // The leaked key sends a harmless self-transfer: no Hogee event for the orphan watch, nothing to finalize.
    const wallet = createWalletClient({ account: w.signers.agent, chain: anvil, transport: http(RPC_URL) });
    await live.client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: w.signers.agent.address, value: 0n }) });
    const pass = await runReconcile(w.deps(), [w.facilityId]);
    expect(pass.orphans).toEqual([]);
    expect(pass.halts.map((h) => h.reason)).toEqual(['EXTERNAL_AGENT_KEY_USE']);
    expect((await activeHalt(live.db.$client))?.reason).toBe('EXTERNAL_AGENT_KEY_USE');
    expect(pass.safetyPause.attempts).toEqual([expect.objectContaining({ role: 'lender', action: 'sent' })]);
    expect(await treasuryPaused(w)).toBe(true);
    // Reported once: the next pass finds nothing new, so a resume after it is not re-halted by the same use.
    expect((await runReconcile(w.deps(), [w.facilityId])).halts).toEqual([]);
  });

  it('(H) stored bytes a DB writer swapped into a pending pause are never re-signed by the lender; a fresh pause lands (H1)', async () => {
    const w = await newWorld(live);
    await leakedSpend(w, 1n);
    await finalizeAll(live);
    await live.test.setAutomine(false);
    const first = await runReconcile(w.deps(), [w.facilityId]);
    const sent = first.safetyPause.attempts[0];
    expect(sent).toMatchObject({ role: 'lender', action: 'sent' });
    // A throwaway key's tx at the same nonce, draining 9 ETH to an attacker, replaces the stored pause bytes.
    const fees = await live.client.estimateFeesPerGas();
    const swapped = await privateKeyToAccount(generatePrivateKey()).signTransaction({
      type: 'eip1559',
      chainId: anvil.id,
      nonce: Number(sent?.nonce),
      to: anvilAccount(3).address,
      value: parseEther('9'),
      gas: 21_000n,
      ...fees,
    });
    await live.db.$client.query('update chain_actions set raw_signed_tx = $3, tx_hash = $4 where facility_id = $1 and id = $2', [w.facilityId, sent?.id, swapped, keccak256(swapped)]);
    const lender = recording(w.signers.lender);
    const second = await runReconcile(w.deps({ signers: { ...w.signers, lender: lender.account } }), [w.facilityId]);
    expect(second.safetyPause.attempts.map((a) => [a.id === sent?.id, a.role, a.action])).toEqual([
      [true, 'lender', 'failed'],
      [false, 'lender', 'sent'],
    ]);
    const treasury = w.deployment.contracts.Treasury.address.toLowerCase();
    expect(lender.signed.length).toBe(1);
    expect(lender.signed.every((tx) => tx.to?.toLowerCase() === treasury && (tx.value ?? 0n) === 0n)).toBe(true);
    await live.test.setAutomine(true);
    expect(await treasuryPaused(w)).toBe(true);
    expect(await live.client.getBalance({ address: w.signers.lender.address })).toBeGreaterThan(parseEther('9'));
  });
});
