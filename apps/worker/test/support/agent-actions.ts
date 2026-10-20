/**
 * Rows the API would write for the agent-actions job, seeded directly in the live tests: a founder-signed supplier
 * order bound on-chain (through the relayer's outbox, so every hot-key nonce stays in Postgres), invoices, approved
 * escalations, API spend proposals and founder-signed OwnerSpend / MilestoneRelease requests. The founder is the
 * world's registered ECDSA owner (Anvil account 1); nothing here signs with a worker key directly.
 */
import {
  buildBindPayee,
  hashHogeeTypedData,
  hogeeDomain,
  hogeeTypedData,
  intentId,
  LINE_SUPPLIER,
  releaseMilestoneIntentId,
  scheduleHash,
  shortIdToBytes32,
  toBytes32Tag,
  toTxRequest,
  type HogeeStructName,
  type MilestoneReleaseMessage,
  type OwnerSpendMessage,
  type SupplierApprovalMessage,
} from '@hogee/chain';
import { hashObject, keccak256Utf8 } from '@hogee/core';
import type { Hex } from 'viem';
import { sendAction } from '../../src/chain/actions';
import { anvilAccount } from '../../src/harness/deploy';
import { uuidv7 } from '../../src/runtime/ids';
import { CAP_WEI, DAY, type World } from './live';

const founder = () => anvilAccount(1);
const q = (w: World, sql: string, values: unknown[]) => w.live.db.$client.query(sql, values);

function domainOf(w: World, contract: 'Treasury' | 'MilestoneEscrow') {
  const verifyingContract = w.deployment.contracts[contract]?.address;
  if (!verifyingContract) throw new Error(`no ${contract} in the deployment`);
  return hogeeDomain({ verifyingContract, chainTag: toBytes32Tag(w.deployment.chainTag), deploymentId: toBytes32Tag(w.deployment.deploymentId) });
}

async function chainNow(w: World): Promise<bigint> {
  return (await w.live.client.getBlock({ blockTag: 'latest' })).timestamp;
}

export interface OrderSpec {
  readonly supplierId: string;
  readonly orderId: string;
  readonly schedule: readonly bigint[];
  readonly autoRelease: readonly boolean[];
}

/** Rina's supplier A (§26.2): sample 30,000 and deposit 120,000 autoRelease, balance 280,000 for the founder. */
export const RINA_ORDER: OrderSpec = { supplierId: 'supplier-a', orderId: 'order-a-001', schedule: [30_000n, 120_000n, 280_000n], autoRelease: [true, true, false] };

/** The supplier, payee, order and milestone rows (as the API's SupplierApproval finalize), then bindPayee lands. */
export async function bindSupplierOrder(w: World, o: OrderSpec = RINA_ORDER): Promise<string> {
  const account = { channel: 'MY_DUITNOW', accountNumber: '2000000001', holderName: `${o.supplierId} test` };
  const payout = keccak256Utf8(JSON.stringify(account)) as Hex;
  const total = o.schedule.reduce((s, x) => s + x, 0n);
  await q(w, `insert into suppliers (facility_id, supplier_id, display_name, country, record_json, evidence_tier, source_type) values ($1, $2, $3, 'CN', '{}'::jsonb, 'tier2', 'mock')`, [
    w.facilityId,
    o.supplierId,
    `${o.supplierId} (test)`,
  ]);
  await q(w, `insert into payees (id, facility_id, kind, display_name, supplier_id, payout_account_hash, bound_line_ids, status) values ($1, $2, 'supplier', $3, $1, $4, $5, 'PENDING')`, [
    o.supplierId,
    w.facilityId,
    `${o.supplierId} (test)`,
    payout,
    [LINE_SUPPLIER],
  ]);
  const sHash = scheduleHash([...o.schedule], [...o.autoRelease]);
  await q(w, `insert into escrow_orders (order_id, facility_id, supplier_id, payee_id, schedule_hash, total_minor, inspection_required) values ($1, $2, $3, $3, $4, $5, true)`, [
    o.orderId,
    w.facilityId,
    o.supplierId,
    sHash,
    total.toString(),
  ]);
  for (const [i, amount] of o.schedule.entries()) {
    await q(w, 'insert into escrow_milestones (order_id, idx, facility_id, amount_minor, auto_release) values ($1, $2, $3, $4, $5)', [o.orderId, i, w.facilityId, amount.toString(), o.autoRelease[i]]);
  }
  const approval: SupplierApprovalMessage = {
    orderId: shortIdToBytes32(o.orderId),
    supplierId: shortIdToBytes32(o.supplierId),
    payee: shortIdToBytes32(o.supplierId),
    payoutAccountHash: payout,
    lineId: LINE_SUPPLIER,
    scheduleHash: sHash,
    totalMinor: total,
    quoteHash: keccak256Utf8(`quote/${o.orderId}`) as Hex,
    shortlistHash: keccak256Utf8('shortlist') as Hex,
    chosenIndex: 0,
    inspectionRequired: true,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: BigInt(keccak256Utf8(`nonce/${o.orderId}/${w.facilityId}`)),
    expiry: (await chainNow(w)) + DAY,
  };
  const signature = await founder().signTypedData(hogeeTypedData('SupplierApproval', domainOf(w, 'Treasury'), approval) as never);
  const call = buildBindPayee({ approval, schedule: [...o.schedule], autoRelease: [...o.autoRelease], founder: { kind: 0, data: signature } });
  const ctx = { db: w.live.db, client: w.live.client, deployment: w.deployment, chainId: w.deployment.chainId, capWei: CAP_WEI };
  const { stored } = await sendAction(ctx, { facilityId: w.facilityId, id: `test:bind:${o.orderId}`, kind: call.kind, refId: o.orderId, request: toTxRequest(call, w.deployment.contracts) }, w.signers.relayer);
  const receipt = await w.live.client.waitForTransactionReceipt({ hash: stored.txHash });
  if (receipt.status !== 'success') throw new Error('bindPayee reverted');
  return o.orderId;
}

/** An invoice row (as the Reader intake stores it); returns its hash. */
export async function insertInvoice(w: World, i: { id: string; payeeId: string; amountMinor: string; flags?: readonly string[]; orderId?: string; idx?: number }): Promise<Hex> {
  const hash = keccak256Utf8(`${w.facilityId}:${i.id}`) as Hex;
  await q(
    w,
    `insert into invoices (id, facility_id, payee_id, order_id, milestone_idx, amount_minor, invoice_hash, extracted_fields_json, taint, flags, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, '{"trust":"untrusted","sensitivity":"public"}'::jsonb, $8, now())`,
    [i.id, w.facilityId, i.payeeId, i.orderId ?? null, i.idx ?? null, i.amountMinor, hash, [...(i.flags ?? [])]],
  );
  return hash;
}

/** A payee the founder never bound on-chain (a DB row only). */
export async function insertUnboundPayee(w: World, id: string): Promise<void> {
  await q(w, `insert into payees (id, facility_id, kind, display_name, payout_account_hash, bound_line_ids, status) values ($1, $2, 'platform', $1, $3, $4, 'PENDING')`, [
    id,
    w.facilityId,
    keccak256Utf8(`${id}/account`),
    [toBytes32Tag('LOGISTICS')],
  ]);
}

/** A POLICY_ESCALATION the loan officer approved, with the server-derived proposal. */
export async function insertApprovedEscalation(w: World, id: string, proposal: Record<string, unknown>): Promise<string> {
  const traceId = `trace-${id}`;
  await q(
    w,
    `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, trace_id)
     values ($1, $2, 'POLICY_ESCALATION', 'Review a flagged payment', $3::jsonb, 'agent', false, true, 'APPROVED', $4)`,
    [id, w.facilityId, JSON.stringify({ proposal }), traceId],
  );
  return traceId;
}

/** The POLICY_OK SPEND row POST /api/proposals/spend writes for an AUTO verdict (the API's decision + rationale). */
export async function insertApiSpend(w: World, p: { id: string; lineKey: string; payeeId: string; amountMinor: string; invoiceHash: Hex }): Promise<void> {
  const intent = intentId({ planId: w.manifest.planId as Hex, lineId: toBytes32Tag(p.lineKey), payeeId: shortIdToBytes32(p.payeeId), invoiceHash: p.invoiceHash, amountMinor: BigInt(p.amountMinor) });
  await q(
    w,
    `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state, decision_id, rationale_hash, trace_id)
     values ($1, $2, 'SPEND', $3, $4, $5, $6, $7, $8, 1, 'POLICY_OK', $9, $10, $11)`,
    [p.id, w.facilityId, intent, p.lineKey, toBytes32Tag(p.lineKey), p.payeeId, p.amountMinor, p.invoiceHash.toLowerCase(), uuidv7(), hashObject({ api: p.id }), `trace:${p.id}`],
  );
}

/** JSON form of a typed message (§26.5): uints as decimal strings, bytes lowercase hex. */
const jsonMessage = (m: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : String(v)]));

async function insertSignatureRequest(w: World, s: { id: string; kind: HogeeStructName; refId: string; contract: 'Treasury' | 'MilestoneEscrow'; message: Record<string, unknown> }): Promise<void> {
  const domain = domainOf(w, s.contract);
  const signature = await founder().signTypedData(hogeeTypedData(s.kind, domain, s.message as never) as never);
  const digest = hashHogeeTypedData(s.kind, domain, s.message as never);
  await q(
    w,
    `insert into signature_requests (id, facility_id, kind, ref_id, method, typed_data_json, digest, challenge_b64url, display_model_json, nonce, expires_at, status, signature_json, submitted_at)
     values ($1, $2, $3, $4, 'eip712', $5::jsonb, $6, $7, '{}'::jsonb, 1, $8, 'SUBMITTED', $9::jsonb, now())`,
    [
      s.id,
      w.facilityId,
      s.kind,
      s.refId,
      JSON.stringify({ primaryType: s.kind, message: jsonMessage(s.message) }),
      digest,
      Buffer.from(digest.slice(2), 'hex').toString('base64url'),
      String(s.message.expiry),
      JSON.stringify({ ecdsa: { signature } }),
    ],
  );
}

/**
 * The founder signs an OwnerSpend (Treasury domain) and the API stores it: signature request + `owner:<sigId>` row.
 * `rowAmountMinor` lets a test tamper with the row after the founder signed.
 */
export async function ownerSpendRequest(w: World, o: { sigId: string; lineKey: string; payeeId: string; amountMinor: string; invoiceHash: Hex; rowAmountMinor?: string }): Promise<{ paymentId: string; intent: Hex }> {
  const paymentId = `owner:${o.sigId}`;
  const message: OwnerSpendMessage = {
    lineId: toBytes32Tag(o.lineKey),
    payeeId: shortIdToBytes32(o.payeeId),
    amountMinor: BigInt(o.amountMinor),
    invoiceHash: o.invoiceHash,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: BigInt(keccak256Utf8(`owner/${o.sigId}/${w.facilityId}`)),
    expiry: (await chainNow(w)) + 900n,
  };
  await insertSignatureRequest(w, { id: o.sigId, kind: 'OwnerSpend', refId: paymentId, contract: 'Treasury', message: message as unknown as Record<string, unknown> });
  const amount = o.rowAmountMinor ?? o.amountMinor;
  const intent = intentId({ planId: w.manifest.planId as Hex, lineId: toBytes32Tag(o.lineKey), payeeId: shortIdToBytes32(o.payeeId), invoiceHash: o.invoiceHash, amountMinor: BigInt(amount) });
  await q(
    w,
    `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state, trace_id)
     values ($1, $2, 'OWNER_SPEND', $3, $4, $5, $6, $7, $8, 1, 'POLICY_OK', $9)`,
    [paymentId, w.facilityId, intent, o.lineKey, toBytes32Tag(o.lineKey), o.payeeId, amount, o.invoiceHash.toLowerCase(), o.sigId],
  );
  return { paymentId, intent };
}

/** The founder signs a MilestoneRelease with the stored inspection evidence; the API stores it as `release:<sigId>`. */
export async function milestoneReleaseRequest(w: World, r: { sigId: string; order: OrderSpec; idx: number; evidenceHash: Hex }): Promise<string> {
  const paymentId = `release:${r.sigId}`;
  const amount = r.order.schedule[r.idx] as bigint;
  await q(w, 'update escrow_milestones set evidence_hash = $4 where facility_id = $1 and order_id = $2 and idx = $3', [w.facilityId, r.order.orderId, r.idx, r.evidenceHash]);
  const message: MilestoneReleaseMessage = {
    orderId: shortIdToBytes32(r.order.orderId),
    idx: r.idx,
    amountMinor: amount,
    evidenceHash: r.evidenceHash,
    deploymentId: toBytes32Tag(w.deployment.deploymentId),
    nonce: BigInt(keccak256Utf8(`release/${r.sigId}/${w.facilityId}`)),
    expiry: (await chainNow(w)) + 900n,
  };
  await insertSignatureRequest(w, { id: r.sigId, kind: 'MilestoneRelease', refId: r.order.orderId, contract: 'MilestoneEscrow', message: message as unknown as Record<string, unknown> });
  await q(
    w,
    `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, order_id, milestone_idx, amount_minor, invoice_hash, plan_version, state, decision_id, rationale_hash, trace_id)
     values ($1, $2, 'RELEASE_MILESTONE', $3, 'SUPPLIER', $4, $5, $6, $7, $8, $9, 1, 'POLICY_OK', $10, $11, $12)`,
    [
      paymentId,
      w.facilityId,
      releaseMilestoneIntentId({ orderId: shortIdToBytes32(r.order.orderId), idx: r.idx }),
      LINE_SUPPLIER,
      r.order.supplierId,
      r.order.orderId,
      r.idx,
      amount.toString(),
      keccak256Utf8(`release-invoice/${r.sigId}`),
      uuidv7(),
      hashObject({ release: r.sigId }),
      r.sigId,
    ],
  );
  return paymentId;
}
