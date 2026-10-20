/**
 * On-chain state for the settle-kinds live tests (final-1 worlds), built the way production builds it: a founder-signed
 * supplier order, the agent's milestone fundings, the founder's milestone release and owner spend, and a reserve
 * withdrawal (oracle sale → founder + lender LoosenRequest → timelock → executeLoosen by a third party). Value-moving
 * calls go through `payments` rows the worker's sender signs, so reconcile finalizes them and its orphan watch sees the
 * rows it expects. Each `prepare*` returns one FINALIZED row the settle job should pay.
 */
import {
  buildBindPayee,
  buildExecuteLoosen,
  buildFundMilestone,
  buildOwnerSpend,
  buildQueueLoosen,
  buildRecordSale,
  buildReleaseMilestone,
  decisionIdToBytes32,
  fundMilestoneIntentId,
  HOGEE_KINDS,
  hogeeDomain,
  hogeeTypedData,
  intentId,
  LINE_SUPPLIER,
  loosenId as loosenIdOf,
  milestoneSettlementId,
  scheduleHash,
  sendStored,
  signAndStore,
  toBytes32Tag,
  toTxRequest,
  ZERO_BYTES32,
  type HogeeCall,
  type LoosenRequestMessage,
  type TxSigner,
} from '@hogee/chain';
import { keccak256Utf8, payoutAccountHash } from '@hogee/core';
import { createWalletClient, http, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { sendAction } from '../../src/chain/actions';
import { anvilAccount } from '../../src/harness/deploy';
import { PLATFORM_PAYEES } from '../../src/harness/rina';
import { runReconcile } from '../../src/jobs/reconcile';
import { adoptReserveWithdrawals } from '../../src/jobs/settle-adopt';
import { payoutAccountRef, type PayoutDestination } from '../../src/rail/rail';
import { uuidv7 } from '../../src/runtime/ids';
import { CAP_WEI, DAY, finalizeAll, newWorld, RPC_URL, warp, type Live, type World } from './live';

export const ORDER = 'order-a-001';
export const SUPPLIER_PAYEE = 'supplier-a';
export const SUPPLIER_ACCOUNT: PayoutDestination = { channel: 'MY_DUITNOW', accountNumber: '2000000001', holderName: 'Supplier A Test' };
/** The reserve withdrawal's tax payee in these worlds: a static platform payee (destination fixed at deployment). */
export const TAX_PAYEE = 'shopee-fees';
export const SCHEDULE = [30_000n, 120_000n] as const;
const OWNER_PAYEE = 'spx-logistics';

/** One FINALIZED payment the settle job should pay, and what it must pay. */
export interface SettleCase {
  readonly w: World;
  readonly paymentId: string;
  readonly settlementId: Hex;
  readonly amountMinor: bigint;
  readonly payeeId: string;
  readonly destination: PayoutDestination;
}

export interface CaseOptions {
  /** The payee's payout account (stage a rail failure by account number). */
  readonly account?: PayoutDestination;
}

const orderBytes = toBytes32Tag(ORDER);
const nonce = (): bigint => BigInt(`0x${uuidv7().replace(/-/g, '').slice(-12)}`);
const platformAccount = (id: string): PayoutDestination => {
  const p = PLATFORM_PAYEES.find((x) => x.id === id);
  if (!p) throw new Error(`no platform payee ${id}`);
  return p.account;
};

function domainOf(w: World, verifyingContract: Hex) {
  return hogeeDomain({ verifyingContract, chainTag: toBytes32Tag(w.deployment.chainTag), deploymentId: toBytes32Tag(w.deployment.deploymentId) });
}

function escrowAddress(w: World): Hex {
  const escrow = w.deployment.contracts.MilestoneEscrow?.address;
  if (!escrow) throw new Error('not a final-1 deployment');
  return escrow;
}

async function chainNow(w: World): Promise<bigint> {
  return (await w.live.client.getBlock({ blockTag: 'latest' })).timestamp;
}

/** A third party (an Anvil account no worker key controls) sends the call; returns the mined tx hash. */
async function anyoneSends(w: World, to: Hex, data: Hex): Promise<Hex> {
  const anyone = createWalletClient({ account: anvilAccount(2), chain: anvil, transport: http(RPC_URL) });
  const hash = await anyone.sendTransaction({ to, data });
  const receipt = await w.live.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`third-party tx reverted: ${hash}`);
  return hash;
}

/** reconcile, make everything final, reconcile again: receipts → INCLUDED → FINALIZED. */
export async function finalize(w: World): Promise<void> {
  await runReconcile(w.deps(), [w.facilityId]);
  await finalizeAll(w.live);
  await runReconcile(w.deps(), [w.facilityId]);
}

interface PaymentInsert {
  readonly id: string;
  readonly kind: 'FUND_MILESTONE' | 'RELEASE_MILESTONE' | 'OWNER_SPEND';
  readonly intentId: Hex;
  readonly lineKey: string;
  readonly payeeId: string;
  readonly orderIdx?: number;
  readonly amountMinor: bigint;
  readonly invoiceHash: Hex;
  /** Agent-kind rows carry a decision and rationale (CHECK payments_decision_iff_agent_kind); owner kinds never do. */
  readonly decision: { readonly decisionId: string; readonly rationaleHash: Hex } | null;
}

const newDecision = (id: string) => ({ decisionId: uuidv7(), rationaleHash: keccak256Utf8(`rationale/${id}`) as Hex });

/** Inserts the POLICY_OK row, signs it with the worker's sender (raw tx + nonce stored first) and lands it. */
async function sendPayment(w: World, p: PaymentInsert, call: HogeeCall, signer: TxSigner): Promise<Hex> {
  await insertPayment(w, p);
  const txHash = await signAndBroadcast(w, p, call, signer);
  const receipt = await w.live.client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`${p.kind} ${p.id} reverted`);
  return txHash;
}

/** The POLICY_OK row the API (or the agent-actions job) writes before the worker signs. */
async function insertPayment(w: World, p: PaymentInsert): Promise<void> {
  await w.live.db.$client.query(
    `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, order_id, milestone_idx, amount_minor, invoice_hash, plan_version, state,
       decision_id, rationale_hash, trace_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 'POLICY_OK', $12, $13, $14)`,
    [
      p.id,
      w.facilityId,
      p.kind,
      p.intentId.toLowerCase(),
      p.lineKey,
      toBytes32Tag(p.lineKey),
      p.payeeId,
      p.orderIdx === undefined ? null : ORDER,
      p.orderIdx ?? null,
      p.amountMinor.toString(),
      p.invoiceHash.toLowerCase(),
      p.decision?.decisionId ?? null,
      p.decision?.rationaleHash ?? null,
      `trace:${p.id}`,
    ],
  );
}

/** Signs the row through the worker's sender (raw tx + nonce stored first) and broadcasts it; returns its hash. */
async function signAndBroadcast(w: World, p: PaymentInsert, call: HogeeCall, signer: TxSigner): Promise<Hex> {
  const stored = await signAndStore(w.live.db, {
    target: { table: 'payments', facilityId: w.facilityId, id: p.id },
    request: toTxRequest(call, w.deployment.contracts),
    account: signer,
    client: w.live.client,
    chainId: w.deployment.chainId,
    capWei: CAP_WEI,
    deployment: w.deployment,
    planId: w.manifest.planId as Hex,
  });
  await sendStored(w.live.db, w.live.client, stored);
  return stored.txHash;
}

/** The supplier, its payee (the account the founder signs the hash of) and the order row the API would write. */
async function seedSupplier(w: World, account: PayoutDestination, autoRelease: readonly boolean[]): Promise<void> {
  const q = w.live.db.$client;
  await q.query(`insert into suppliers (facility_id, supplier_id, display_name, country, record_json, evidence_tier, source_type) values ($1, 'sup-a', 'Supplier A', 'CN', '{}', 'tier1', 'mock')`, [
    w.facilityId,
  ]);
  await q.query(
    `insert into payees (id, facility_id, kind, display_name, supplier_id, xendit_account_ref, payout_account_hash, bound_line_ids, status)
     values ($1, $2, 'supplier', 'Supplier A (test)', 'sup-a', $3, $4, $5, 'BOUND')`,
    [SUPPLIER_PAYEE, w.facilityId, payoutAccountRef(account), payoutAccountHash(account), [LINE_SUPPLIER]],
  );
  await q.query(`insert into escrow_orders (order_id, facility_id, supplier_id, payee_id, schedule_hash, total_minor, inspection_required) values ($1, $2, 'sup-a', $3, $4, $5, false)`, [
    ORDER,
    w.facilityId,
    SUPPLIER_PAYEE,
    scheduleHash([...SCHEDULE], [...autoRelease]),
    (SCHEDULE[0] + SCHEDULE[1]).toString(),
  ]);
}

/** The founder signs the SupplierApproval (payout account hash included, T1); anyone submits bindPayee; cooling passes. */
async function bindOrder(w: World, account: PayoutDestination, autoRelease: readonly boolean[]): Promise<void> {
  await seedSupplier(w, account, autoRelease);
  const treasury = w.deployment.contracts.Treasury.address;
  const approval = {
    orderId: orderBytes,
    supplierId: toBytes32Tag('sup-a'),
    payee: toBytes32Tag(SUPPLIER_PAYEE),
    payoutAccountHash: payoutAccountHash(account) as Hex,
    lineId: LINE_SUPPLIER,
    scheduleHash: scheduleHash([...SCHEDULE], [...autoRelease]),
    totalMinor: SCHEDULE[0] + SCHEDULE[1],
    quoteHash: keccak256Utf8('quote') as Hex,
    shortlistHash: keccak256Utf8('shortlist') as Hex,
    chosenIndex: 0,
    inspectionRequired: false,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: nonce(),
    expiry: (await chainNow(w)) + DAY,
  };
  const founder = await anvilAccount(1).signTypedData(hogeeTypedData('SupplierApproval', domainOf(w, treasury), approval) as never);
  const call = buildBindPayee({ approval, schedule: [...SCHEDULE], autoRelease: [...autoRelease], founder: { kind: 0, data: founder } });
  await anyoneSends(w, treasury, call.data);
  await warp(w.live, 121n); // past the payee's cooling window (COOLING_SECONDS 120 on Anvil)
}

/**
 * A re-bind (audit run-3): the founder signs a NEW SupplierApproval for the same payee and line with another payout
 * account; bindPayee replaces the account and restarts cooling. No warp: the binding is cooling when this returns.
 */
export async function rebindSupplier(w: World, account: PayoutDestination, orderId = 'order-a-002'): Promise<void> {
  const q = w.live.db.$client;
  const autoRelease = [true, true] as const;
  await q.query(`insert into escrow_orders (order_id, facility_id, supplier_id, payee_id, schedule_hash, total_minor, inspection_required) values ($1, $2, 'sup-a', $3, $4, $5, false)`, [
    orderId,
    w.facilityId,
    SUPPLIER_PAYEE,
    scheduleHash([...SCHEDULE], [...autoRelease]),
    (SCHEDULE[0] + SCHEDULE[1]).toString(),
  ]);
  const treasury = w.deployment.contracts.Treasury.address;
  const approval = {
    orderId: toBytes32Tag(orderId),
    supplierId: toBytes32Tag('sup-a'),
    payee: toBytes32Tag(SUPPLIER_PAYEE),
    payoutAccountHash: payoutAccountHash(account) as Hex,
    lineId: LINE_SUPPLIER,
    scheduleHash: scheduleHash([...SCHEDULE], [...autoRelease]),
    totalMinor: SCHEDULE[0] + SCHEDULE[1],
    quoteHash: keccak256Utf8('quote-2') as Hex,
    shortlistHash: keccak256Utf8('shortlist-2') as Hex,
    chosenIndex: 0,
    inspectionRequired: false,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: nonce(),
    expiry: (await chainNow(w)) + DAY,
  };
  const founder = await anvilAccount(1).signTypedData(hogeeTypedData('SupplierApproval', domainOf(w, treasury), approval) as never);
  const call = buildBindPayee({ approval, schedule: [...SCHEDULE], autoRelease: [...autoRelease], founder: { kind: 0, data: founder } });
  await anyoneSends(w, treasury, call.data);
}

/** The agent funds milestone `idx` with `amountMinor` (cumulative `after`) through a FUND_MILESTONE row. */
export async function fundMilestone(w: World, idx: number, amountMinor: bigint, after: bigint): Promise<string> {
  const id = `fund-${idx}-${after}`;
  const decision = newDecision(id);
  const p: PaymentInsert = {
    id,
    kind: 'FUND_MILESTONE',
    intentId: fundMilestoneIntentId({ orderId: orderBytes, idx, amountMinor, cumulativeAfterMinor: after }),
    lineKey: 'SUPPLIER',
    payeeId: SUPPLIER_PAYEE,
    orderIdx: idx,
    amountMinor,
    invoiceHash: keccak256Utf8(`invoice/${ORDER}/${idx}`) as Hex,
    decision,
  };
  const call = buildFundMilestone({ orderId: orderBytes, idx, amountMinor, decisionId: decisionIdToBytes32(decision.decisionId), rationaleHash: decision.rationaleHash });
  await sendPayment(w, p, call, w.signers.agent);
  return id;
}

/** The founder signs a MilestoneRelease; the relayer submits it through a RELEASE_MILESTONE row (`release:<id>`). */
async function releaseMilestone(w: World, idx: number, amountMinor: bigint): Promise<string> {
  const id = `release:exc-${idx}`;
  const escrow = escrowAddress(w);
  const release = { orderId: orderBytes, idx, amountMinor, evidenceHash: ZERO_BYTES32, deploymentId: toBytes32Tag(w.deployment.deploymentId), nonce: nonce(), expiry: (await chainNow(w)) + DAY };
  const founder = await anvilAccount(1).signTypedData(hogeeTypedData('MilestoneRelease', domainOf(w, escrow), release) as never);
  const p: PaymentInsert = {
    id,
    kind: 'RELEASE_MILESTONE',
    intentId: milestoneSettlementId(orderBytes, idx),
    lineKey: 'SUPPLIER',
    payeeId: SUPPLIER_PAYEE,
    orderIdx: idx,
    amountMinor,
    invoiceHash: keccak256Utf8(`invoice/${ORDER}/${idx}`) as Hex,
    decision: newDecision(id),
  };
  await sendPayment(w, p, buildReleaseMilestone({ release, founder: { kind: 0, data: founder } }), w.signers.relayer);
  return id;
}

/** A founder release of a fully funded, non-auto milestone 0 (milestone 1 stays unfunded). */
export async function prepareRelease(live: Live, o: CaseOptions = {}): Promise<SettleCase> {
  const destination = o.account ?? SUPPLIER_ACCOUNT;
  const w = await newWorld(live, { final: true });
  await bindOrder(w, destination, [false, false]);
  await fundMilestone(w, 0, SCHEDULE[0], SCHEDULE[0]);
  const paymentId = await releaseMilestone(w, 0, SCHEDULE[0]);
  await finalize(w);
  return { w, paymentId, settlementId: milestoneSettlementId(orderBytes, 0), amountMinor: SCHEDULE[0], payeeId: SUPPLIER_PAYEE, destination };
}

/** An autoRelease milestone 0 funded in two parts: the second funding releases it inside fundMilestone. */
export async function prepareAutoRelease(live: Live, o: CaseOptions = {}): Promise<SettleCase & { readonly partialId: string }> {
  const destination = o.account ?? SUPPLIER_ACCOUNT;
  const w = await newWorld(live, { final: true });
  await bindOrder(w, destination, [true, false]);
  const partialId = await fundMilestone(w, 0, 10_000n, 10_000n);
  const paymentId = await fundMilestone(w, 0, SCHEDULE[0] - 10_000n, SCHEDULE[0]);
  await finalize(w);
  return { w, paymentId, partialId, settlementId: milestoneSettlementId(orderBytes, 0), amountMinor: SCHEDULE[0], payeeId: SUPPLIER_PAYEE, destination };
}

/** The founder's manual fallback (ownerSpend) on LOGISTICS to spx-logistics, relayed through an OWNER_SPEND row. */
export async function prepareOwnerSpend(live: Live): Promise<SettleCase> {
  const w = await newWorld(live, { final: true });
  const treasury = w.deployment.contracts.Treasury.address;
  const amountMinor = 10_000n;
  const req = {
    lineId: toBytes32Tag('LOGISTICS'),
    payeeId: toBytes32Tag(OWNER_PAYEE),
    amountMinor,
    invoiceHash: keccak256Utf8(`invoice/owner/${w.facilityId}`) as Hex,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: nonce(),
    expiry: (await chainNow(w)) + DAY,
  };
  const founder = await anvilAccount(1).signTypedData(hogeeTypedData('OwnerSpend', domainOf(w, treasury), req) as never);
  const spendId = intentId({ planId: w.manifest.planId as Hex, lineId: req.lineId, payeeId: req.payeeId, invoiceHash: req.invoiceHash, amountMinor });
  const p: PaymentInsert = { id: 'owner-1', kind: 'OWNER_SPEND', intentId: spendId, lineKey: 'LOGISTICS', payeeId: OWNER_PAYEE, amountMinor, invoiceHash: req.invoiceHash, decision: null };
  await sendPayment(w, p, buildOwnerSpend({ req, founder: { kind: 0, data: founder } }), w.signers.relayer);
  await finalize(w);
  return { w, paymentId: p.id, settlementId: spendId, amountMinor, payeeId: OWNER_PAYEE, destination: platformAccount(OWNER_PAYEE) };
}

/**
 * A reserve withdrawal to the tax payee: the oracle records a sale (5 % skims into the reserve), founder and lender
 * co-sign the LoosenRequest, the relayer queues it, and after the timelock a third party executes it. The exception row
 * is what the API writes; the finalized ReserveWithdrawn is all the settle job trusts. Returns the loosen id.
 */
export async function withdrawReserve(w: World, amountMinor: bigint): Promise<Hex> {
  const treasury = w.deployment.contracts.Treasury.address;
  const ctx = { db: w.live.db, client: w.live.client, deployment: w.deployment, chainId: w.deployment.chainId, capWei: CAP_WEI };
  const sale = buildRecordSale({ saleIdHash: keccak256Utf8(`sale/${w.facilityId}`) as Hex, amountBucket: 100_000n });
  const recorded = await sendAction(ctx, { facilityId: w.facilityId, id: 'test:record-sale', kind: sale.kind, request: toTxRequest(sale, w.deployment.contracts) }, w.signers.oracle);
  await w.live.client.waitForTransactionReceipt({ hash: recorded.stored.txHash });
  const req: LoosenRequestMessage = {
    kind: HOGEE_KINDS.LOOSEN_WITHDRAW_RESERVE,
    target: toBytes32Tag(TAX_PAYEE),
    aux: ZERO_BYTES32,
    newValue: amountMinor,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: nonce(),
    expiry: (await chainNow(w)) + DAY,
  };
  const typed = hogeeTypedData('LoosenRequest', domainOf(w, treasury), req) as never;
  const founder = await anvilAccount(1).signTypedData(typed);
  const lender = await w.signers.lender.signTypedData(typed);
  const queue = buildQueueLoosen({ req, founder: { kind: 0, data: founder }, lender: { kind: 0, data: lender } });
  const queued = await sendAction(ctx, { facilityId: w.facilityId, id: 'test:queue-loosen', kind: queue.kind, request: toTxRequest(queue, w.deployment.contracts) }, w.signers.relayer);
  await w.live.client.waitForTransactionReceipt({ hash: queued.stored.txHash });
  const loosenId = loosenIdOf(req).toLowerCase() as Hex;
  await w.live.db.$client.query(
    `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, loosen_id)
     values ('exc-reserve', $1, 'WITHDRAW_RESERVE', 'Pay the tax reserve', $2::jsonb, 'founder', true, true, 'QUEUED', $3)`,
    [w.facilityId, JSON.stringify({ amountMinor: amountMinor.toString(), taxPayeeId: TAX_PAYEE }), loosenId],
  );
  await warp(w.live, 121n); // past the loosening timelock (120 s on Anvil)
  await anyoneSends(w, treasury, buildExecuteLoosen({ loosenId }).data);
  await finalizeAll(w.live);
  return loosenId;
}

/** A finalized reserve withdrawal adopted as the worker-owned WITHDRAW_RESERVE row (`reserve:<loosenId>`). */
export async function prepareReserve(live: Live, o: CaseOptions = {}): Promise<SettleCase> {
  const destination = o.account ?? platformAccount(TAX_PAYEE);
  const w = await newWorld(live, { final: true, ...(o.account ? { accounts: { [TAX_PAYEE]: o.account } } : {}) });
  const loosenId = await withdrawReserve(w, 4_000n);
  await adoptReserveWithdrawals(w.deps(), w.facilityId);
  return { w, paymentId: `reserve:${loosenId}`, settlementId: loosenId, amountMinor: 4_000n, payeeId: TAX_PAYEE, destination };
}

// ---- audit run-4 (v-2): a third party lands a copy of the relayer's founder-signed call first ---------------------

/** A founder-signed settlement whose relayer row ended REVERTED behind a copy another account landed first. */
export interface CopiedCase {
  readonly w: World;
  /** The relayer's row (REVERTED once finalized). */
  readonly sourceId: string;
  readonly settlementId: Hex;
  readonly amountMinor: bigint;
  readonly destination: PayoutDestination;
  readonly copyTx: Hex;
}

/**
 * The relayer signs and broadcasts the row's call; before it is mined a third party sends the same calldata with a
 * higher tip. Both are mined in one block (Anvil orders by fee): the copy executes, the relayer's tx reverts.
 */
async function raceCopy(w: World, p: PaymentInsert, call: HogeeCall): Promise<Hex> {
  await w.live.test.setAutomine(false);
  let relayed: Hex;
  let copy: Hex;
  try {
    await insertPayment(w, p);
    relayed = await signAndBroadcast(w, p, call, w.signers.relayer);
    const tx = await w.live.client.getTransaction({ hash: relayed });
    const fee = tx.maxFeePerGas ?? 2_000_000_000n;
    const anyone = createWalletClient({ account: anvilAccount(2), chain: anvil, transport: http(RPC_URL) });
    copy = await anyone.sendTransaction({ to: tx.to as Hex, data: tx.input, gas: tx.gas, maxFeePerGas: fee * 4n, maxPriorityFeePerGas: fee * 2n });
    await w.live.test.mine({ blocks: 1 });
  } finally {
    await w.live.test.setAutomine(true);
  }
  const [mine, theirs] = await Promise.all([w.live.client.waitForTransactionReceipt({ hash: relayed }), w.live.client.waitForTransactionReceipt({ hash: copy })]);
  if (theirs.status !== 'success' || mine.status !== 'reverted') throw new Error('the copy did not land ahead of the relayer');
  return copy;
}

/** The founder's ownerSpend on LOGISTICS, copied from the relayer's pending tx and landed first by a third party. */
export async function prepareCopiedOwnerSpend(live: Live): Promise<CopiedCase> {
  const w = await newWorld(live, { final: true });
  const treasury = w.deployment.contracts.Treasury.address;
  const amountMinor = 12_000n;
  const req = {
    lineId: toBytes32Tag('LOGISTICS'),
    payeeId: toBytes32Tag(OWNER_PAYEE),
    amountMinor,
    invoiceHash: keccak256Utf8(`invoice/copied-owner/${w.facilityId}`) as Hex,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: nonce(),
    expiry: (await chainNow(w)) + DAY,
  };
  const founder = await anvilAccount(1).signTypedData(hogeeTypedData('OwnerSpend', domainOf(w, treasury), req) as never);
  const spendId = intentId({ planId: w.manifest.planId as Hex, lineId: req.lineId, payeeId: req.payeeId, invoiceHash: req.invoiceHash, amountMinor });
  const p: PaymentInsert = { id: 'owner:sig-copied', kind: 'OWNER_SPEND', intentId: spendId, lineKey: 'LOGISTICS', payeeId: OWNER_PAYEE, amountMinor, invoiceHash: req.invoiceHash, decision: null };
  const copyTx = await raceCopy(w, p, buildOwnerSpend({ req, founder: { kind: 0, data: founder } }));
  await finalize(w);
  return { w, sourceId: p.id, settlementId: spendId, amountMinor, destination: platformAccount(OWNER_PAYEE), copyTx };
}

/** The founder's release of funded, non-auto milestone 0, copied from the relayer's pending tx and landed first. */
export async function prepareCopiedRelease(live: Live): Promise<CopiedCase> {
  const w = await newWorld(live, { final: true });
  await bindOrder(w, SUPPLIER_ACCOUNT, [false, false]);
  await fundMilestone(w, 0, SCHEDULE[0], SCHEDULE[0]);
  const escrow = escrowAddress(w);
  const release = { orderId: orderBytes, idx: 0, amountMinor: SCHEDULE[0], evidenceHash: ZERO_BYTES32, deploymentId: toBytes32Tag(w.deployment.deploymentId), nonce: nonce(), expiry: (await chainNow(w)) + DAY };
  const founder = await anvilAccount(1).signTypedData(hogeeTypedData('MilestoneRelease', domainOf(w, escrow), release) as never);
  const p: PaymentInsert = {
    id: 'release:exc-copied',
    kind: 'RELEASE_MILESTONE',
    intentId: milestoneSettlementId(orderBytes, 0),
    lineKey: 'SUPPLIER',
    payeeId: SUPPLIER_PAYEE,
    orderIdx: 0,
    amountMinor: SCHEDULE[0],
    invoiceHash: keccak256Utf8(`invoice/${ORDER}/0`) as Hex,
    decision: newDecision('release:exc-copied'),
  };
  const copyTx = await raceCopy(w, p, buildReleaseMilestone({ release, founder: { kind: 0, data: founder } }));
  await finalize(w);
  return { w, sourceId: p.id, settlementId: milestoneSettlementId(orderBytes, 0), amountMinor: SCHEDULE[0], destination: SUPPLIER_ACCOUNT, copyTx };
}
