/**
 * What the worker signs for an API-created chain action (D19: the API only writes rows). Per kind: the request_json
 * schema, the role key, and the checks the row must pass against the product tables before ANY key touches it. A
 * failed check is a RelayRefusal: nothing is signed and the row is marked refused (revert_reason) with an ALERT trace.
 *
 * Authority comes only from those tables, never from the request: the lender key registers a founder key only for the
 * founder's pending registration, co-signs a LoosenRequest only for an exception the officer APPROVED (and only the
 * exact message the founder signed), signs a StageRelease only for an approved RELEASE_STAGE whose gate the chain
 * shows met, and cancels only a vetoed loosening the chain shows QUEUED. The relayer submits founder-signed structs and
 * gains no authority (the contracts verify every signature); the oracle records only a verified sale.
 */
import {
  buildBindPayee,
  buildCancelLoosen,
  buildCommitPlan,
  buildExecuteLoosen,
  buildFund,
  buildOpenFacility,
  buildPause,
  buildQueueLoosen,
  buildRecordDenied,
  buildRecordSale,
  buildRegisterFounderKey,
  buildReleaseStage,
  HOGEE_KINDS,
  hashLines,
  hashStages,
  hogeeDomain,
  hogeeTypes,
  iPlanRegistryAbi,
  iSalesOracleAbi,
  iTreasuryAbi,
  manifestToLines,
  manifestToStages,
  scheduleHash,
  toBytes32Tag,
  type HogeeCall,
  type HogeeStructName,
  type OnchainSig,
} from '@hogee/chain';
import { hashObject, PlanManifest } from '@hogee/core';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { rows, type Pg } from '../store/pg';
import type { JobDeps } from './deps';

export type Role = 'agent' | 'oracle' | 'lender' | 'relayer';

export class RelayRefusal extends Error {
  override readonly name = 'RelayRefusal';
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Not signable YET (e.g. a loosening the founder signed that awaits the loan officer): the row stays PENDING. */
export class RelayDeferral extends Error {
  override readonly name = 'RelayDeferral';
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface RelayPlan {
  readonly role: Role;
  readonly call: HogeeCall;
  /** Tried when the first role cannot send (pause: the agent key if the lender's send fails before it is signed). */
  readonly fallback?: Role;
}

export interface RelayRow {
  readonly id: string;
  readonly kind: string;
  readonly refId: string | null;
  readonly request: unknown;
}

export interface RelayCtx {
  readonly d: JobDeps;
  readonly q: Pg;
  readonly facilityId: string;
  readonly row: RelayRow;
}

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const Addr = z.string().regex(/^0x[0-9a-f]{40}$/);
const Uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const SigJson = z.strictObject({ kind: z.union([z.literal(0), z.literal(1)]), data: z.string().regex(/^0x([0-9a-f]{2})+$/) });
const Message = z.record(z.string(), z.union([z.string(), z.boolean()]));

const refuse = (reason: string): never => {
  throw new RelayRefusal(reason);
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) refuse(`request_json is malformed (${r.error.issues[0]?.path.join('.') ?? '?'})`);
  return (r as { data: T }).data;
}

/** API typed-data message (decimal strings) → viem message for `kind` (uint8..32 numbers, wider uints bigints). */
export function toMessage<K extends HogeeStructName>(kind: K, m: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of hogeeTypes[kind]) {
    const v = m[f.name];
    if (v === undefined) refuse(`typed message is missing ${f.name}`);
    if (f.type === 'bool') {
      if (typeof v !== 'boolean') refuse(`${f.name} must be a boolean`);
      out[f.name] = v;
    } else if (f.type.startsWith('uint')) {
      if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) refuse(`${f.name} must be a decimal string`);
      const bits = Number(f.type.slice(4));
      out[f.name] = bits <= 32 ? Number(v) : BigInt(v as string);
    } else {
      if (typeof v !== 'string' || !/^0x[0-9a-f]+$/.test(v)) refuse(`${f.name} must be lowercase hex`);
      out[f.name] = v;
    }
  }
  if (Object.keys(m).length !== hogeeTypes[kind].length) refuse('typed message has extra fields');
  return out;
}

const sameMessage = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => String(v).toLowerCase() === String(b[k]).toLowerCase());

function domainFor(d: JobDeps, contract: 'Treasury' | 'PlanRegistry') {
  return hogeeDomain({
    verifyingContract: d.deployment.contracts[contract].address,
    chainTag: toBytes32Tag(d.deployment.chainTag),
    deploymentId: toBytes32Tag(d.deployment.deploymentId),
  });
}

async function lenderSign(d: JobDeps, kind: 'LoosenRequest' | 'StageRelease', message: Record<string, unknown>): Promise<OnchainSig> {
  const signer = d.signers.lender;
  const data = await signer.signTypedData({ domain: domainFor(d, 'Treasury'), types: { [kind]: hogeeTypes[kind] }, primaryType: kind, message } as never);
  return { kind: 0, data };
}

async function one<T extends Record<string, unknown>>(q: Pg, sql: string, values: unknown[]): Promise<T | undefined> {
  return (await rows<T>(q, sql, values))[0];
}

type Builder = (ctx: RelayCtx) => Promise<RelayPlan>;

const registerFounderKey: Builder = async ({ q, facilityId, row }) => {
  const r = parse(z.object({ qx: Hex32, qy: Hex32, ownerEOA: Addr, credentialId: z.string().min(1) }), row.request);
  const f = await one<{ qx: string; qy: string; wallet_address: string | null; passkey_credential_id: string; key_status: string }>(
    q,
    'select qx, qy, wallet_address, passkey_credential_id, key_status from founders where facility_id = $1 and id = $2',
    [facilityId, row.refId],
  );
  if (!f || f.key_status !== 'PENDING_LENDER') refuse('the founder has no pending registration');
  const owner = f?.wallet_address ?? `0x${'0'.repeat(40)}`;
  if (f?.qx !== r.qx || f.qy !== r.qy || f.passkey_credential_id !== r.credentialId || owner !== r.ownerEOA) refuse('the key is not the founder’s reviewed registration');
  return { role: 'lender', call: buildRegisterFounderKey({ qx: r.qx as Hex, qy: r.qy as Hex, ownerEOA: r.ownerEOA as Address }) };
};

const openFacility: Builder = async ({ q, facilityId, row }) => {
  const r = parse(z.object({ capMinor: Uint, reserveFloorBps: z.number().int().min(0).max(10_000) }), row.request);
  const f = await one<{ cap_minor: string; reserve_floor_bps: number }>(q, 'select cap_minor::text as cap_minor, reserve_floor_bps from facilities where facility_id = $1', [facilityId]);
  if (!f || f.cap_minor !== r.capMinor || Number(f.reserve_floor_bps) !== r.reserveFloorBps) refuse('the request is not the facility row');
  return { role: 'lender', call: buildOpenFacility({ capMinor: BigInt(r.capMinor), reserveFloorBps: r.reserveFloorBps }) };
};

const fund: Builder = async ({ row }) => {
  const r = parse(z.object({ amountMinor: Uint }), row.request);
  if (BigInt(r.amountMinor) === 0n) refuse('zero funding');
  return { role: 'lender', call: buildFund({ amountMinor: BigInt(r.amountMinor) }) };
};

const commitPlan: Builder = async ({ q, facilityId, row }) => {
  const r = parse(z.object({ approval: Message, founder: SigJson }), row.request);
  const plan = await one<{ manifest_json: unknown; plan_hash: string; status: string }>(q, 'select manifest_json, plan_hash, status from plans where facility_id = $1 and id = $2', [facilityId, row.refId]);
  if (!plan || plan.status !== 'SUBMITTED') refuse('the plan row is not awaiting its commit');
  const manifest = PlanManifest.parse(plan?.manifest_json);
  const approval = toMessage('PlanApproval', r.approval);
  const lines = manifestToLines(manifest);
  const stages = manifestToStages(manifest);
  if (approval.planHash !== hashObject(manifest) || approval.planHash !== plan?.plan_hash) refuse('planHash is not the stored manifest');
  if (approval.linesHash !== hashLines(lines) || approval.stagesHash !== hashStages(stages)) refuse('lines or stages differ from the signed hashes');
  return { role: 'relayer', call: buildCommitPlan({ approval: approval as never, lines, stages, founder: r.founder as OnchainSig }) };
};

const bindPayee: Builder = async ({ q, facilityId, row }) => {
  const r = parse(z.object({ approval: Message, schedule: z.array(Uint).min(1).max(8), autoRelease: z.array(z.boolean()).min(1).max(8), founder: SigJson }), row.request);
  const ms = await rows<{ amount_minor: string; auto_release: boolean }>(
    q,
    'select amount_minor::text as amount_minor, auto_release from escrow_milestones where facility_id = $1 and order_id = $2 order by idx',
    [facilityId, row.refId],
  );
  const stored = ms.map((m) => m.amount_minor).join(',') === r.schedule.join(',') && ms.map((m) => m.auto_release).join(',') === r.autoRelease.join(',');
  if (!stored) refuse('the schedule is not the stored escrow order');
  const approval = toMessage('SupplierApproval', r.approval);
  const schedule = r.schedule.map((x) => BigInt(x));
  if (approval.scheduleHash !== scheduleHash(schedule, r.autoRelease)) refuse('scheduleHash is not the schedule');
  return { role: 'relayer', call: buildBindPayee({ approval: approval as never, schedule, autoRelease: r.autoRelease, founder: r.founder as OnchainSig }) };
};

const queueLoosen: Builder = async (ctx) => {
  const { q, facilityId, row, d } = ctx;
  const r = parse(z.object({ exceptionId: z.string().min(1), req: Message, founder: SigJson }), row.request);
  const e = await one<{ status: string; founder_sig: unknown }>(q, 'select status, founder_sig from exceptions where facility_id = $1 and id = $2', [facilityId, r.exceptionId]);
  // The officer's approval is what lets the server-held lender key co-sign (G0-AUDIT v-2). Until then it waits.
  if (e?.status === 'FOUNDER_SIGNED' && e.founder_sig) throw new RelayDeferral('awaiting the loan officer');
  if (!e || e.status !== 'APPROVED' || !e.founder_sig) refuse('the loosening is not approved by the officer with the founder’s signature');
  const signed = await one<{ typed_data_json: { message: Record<string, string | boolean> } }>(
    q,
    `select typed_data_json from signature_requests where facility_id = $1 and kind = 'LoosenRequest' and ref_id = $2 and status = 'SUBMITTED' order by submitted_at desc limit 1`,
    [facilityId, r.exceptionId],
  );
  const req = toMessage('LoosenRequest', r.req);
  if (!signed || !sameMessage(req, toMessage('LoosenRequest', signed.typed_data_json.message))) refuse('the request is not the message the founder signed');
  const lender = await lenderSign(d, 'LoosenRequest', req);
  return { role: 'relayer', call: buildQueueLoosen({ req: req as never, founder: r.founder as OnchainSig, lender }) };
};

const releaseStage: Builder = async ({ q, facilityId, row, d }) => {
  const r = parse(z.object({ exceptionId: z.string().min(1), stageId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/) }), row.request);
  const e = await one<{ status: string; kind: string; payload: { stageId?: string } }>(q, 'select status, kind, payload from exceptions where facility_id = $1 and id = $2', [facilityId, r.exceptionId]);
  if (!e || e.kind !== 'RELEASE_STAGE' || e.status !== 'APPROVED' || e.payload.stageId !== r.stageId) refuse('the stage release is not approved by the officer');
  const stageId = toBytes32Tag(r.stageId);
  const registry = d.deployment.contracts.PlanRegistry.address;
  const [[stage, released], revenue, block] = await Promise.all([
    d.client.readContract({ address: registry, abi: iPlanRegistryAbi, functionName: 'stage', args: [stageId] }),
    d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'revenue' }),
    d.client.getBlock({ blockTag: 'latest' }),
  ]);
  if (released) refuse('the stage is already released');
  // Defense in depth: the lender key signs only a gate the chain shows met (the officer decides; code re-checks).
  if (stage.metric === HOGEE_KINDS.METRIC_SALES_MINOR && (revenue < stage.target || block.timestamp > stage.deadline)) refuse('the stage gate is not met on-chain');
  const nonce = BigInt(`0x${randomBytes(32).toString('hex')}`);
  const req = { stageId, amountMinor: stage.releaseMinor, deploymentId: toBytes32Tag(d.deployment.deploymentId), nonce, expiry: block.timestamp + 3600n };
  const lender = await lenderSign(d, 'StageRelease', req);
  return { role: 'relayer', call: buildReleaseStage({ req, lender }) };
};

const LOOSEN_STATUS_LABEL: Readonly<Record<number, string>> = {
  [HOGEE_KINDS.LOOSEN_STATUS_EXECUTED]: 'executed',
  [HOGEE_KINDS.LOOSEN_STATUS_CANCELLED]: 'already cancelled',
  [HOGEE_KINDS.LOOSEN_STATUS_EXPIRED]: 'expired',
};

/**
 * The exception's own co-signed queueLoosen can still land at `now`: signed, not finalized or reverted, and its
 * LoosenRequest envelope not expired (Treasury refuses SignatureExpired after `expiry`). Recovery re-sends stored bytes,
 * so a broadcast that failed or was dropped still counts.
 */
async function queueInFlight(q: Pg, facilityId: string, exceptionId: string, now: bigint): Promise<boolean> {
  const queued = await rows<{ expiry: string | null }>(
    q,
    `select request_json->'req'->>'expiry' as expiry from chain_actions
      where facility_id = $1 and kind = 'Treasury.queueLoosen' and ref_id = $2 and raw_signed_tx is not null and state in ('PENDING', 'BROADCAST', 'INCLUDED')`,
    [facilityId, exceptionId],
  );
  return queued.some((a) => a.expiry === null || !/^(0|[1-9][0-9]{0,19})$/.test(a.expiry) || BigInt(a.expiry) >= now);
}

/**
 * Cancels a vetoed loosening once the chain shows it QUEUED (audit run-4). A veto can commit while the exception's own
 * queueLoosen is signed but not yet included: simulating the cancel then reverts TimelockActive, and a refusal would be
 * final. So while that queueLoosen can still land the cancel WAITS (RelayDeferral, retried next pass). A loosening that
 * was never queued and can no longer be has nothing to cancel; one the chain already closed is not cancelled again.
 * sync-veto.ts re-queues a cancel (a bounded number of times) if a vetoed loosening is ever seen QUEUED, and alerts
 * once on one the chain executed (final).
 */
const cancelLoosen: Builder = async ({ q, facilityId, row, d }) => {
  const r = parse(z.object({ exceptionId: z.string().min(1), loosenId: Hex32 }), row.request);
  const e = await one<{ status: string; loosen_id: string | null }>(q, 'select status, loosen_id from exceptions where facility_id = $1 and id = $2', [facilityId, r.exceptionId]);
  if (!e || e.status !== 'CANCELLED' || e.loosen_id !== r.loosenId) refuse('the loosening was not vetoed');
  const block = await d.client.getBlock({ blockTag: 'latest' });
  const ql = await d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'queuedLoosen', args: [r.loosenId as Hex], blockNumber: block.number });
  const status = Number(ql.status);
  if (status === HOGEE_KINDS.LOOSEN_STATUS_QUEUED) return { role: 'lender', call: buildCancelLoosen({ loosenId: r.loosenId as Hex }) };
  if (status !== HOGEE_KINDS.LOOSEN_STATUS_NONE) refuse(`the loosening is ${LOOSEN_STATUS_LABEL[status] ?? `in state ${status}`} on-chain; nothing to cancel`);
  if (await queueInFlight(q, facilityId, r.exceptionId, block.timestamp)) throw new RelayDeferral('the queueLoosen is in flight; the cancel waits for it to land');
  return refuse('the loosening was never queued on-chain and can no longer be; nothing to cancel');
};

/** Anyone may execute a matured loosening; only one the officer approved and the chain shows executable is sent. */
const executeLoosen: Builder = async ({ q, facilityId, row, d }) => {
  const r = parse(z.object({ exceptionId: z.string().min(1), loosenId: Hex32 }), row.request);
  const e = await one<{ status: string; loosen_id: string | null }>(q, 'select status, loosen_id from exceptions where facility_id = $1 and id = $2', [facilityId, r.exceptionId]);
  if (!e || !['QUEUED', 'EXECUTABLE'].includes(e.status) || e.loosen_id !== r.loosenId) refuse('the loosening is not queued for this exception');
  const [ql, block] = await Promise.all([
    d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'queuedLoosen', args: [r.loosenId as Hex] }),
    d.client.getBlock({ blockTag: 'latest' }),
  ]);
  if (Number(ql.status) !== HOGEE_KINDS.LOOSEN_STATUS_QUEUED) refuse('the loosening is not queued on-chain');
  if (block.timestamp < ql.executableAt) throw new RelayDeferral('the timelock has not passed');
  return { role: 'relayer', call: buildExecuteLoosen({ loosenId: r.loosenId as Hex }) };
};

/**
 * The officer's or founder's pause (re-check A-3): the lender key first (Treasury._requireTightener lets the lender
 * pause), so it never queues behind the agent spends in flight on the agent key's nonces; the safety pause orders its
 * signers the same way (jobs/safety-pause.ts). The agent key is only the fallback.
 */
const pause: Builder = async () => ({ role: 'lender', call: buildPause(), fallback: 'agent' });

const recordDenied: Builder = async ({ q, facilityId, row }) => {
  const r = parse(z.object({ denialId: z.string().min(1), lineId: Hex32, decisionId: Hex32, reasonCode: Hex32, proposalHash: Hex32 }), row.request);
  const den = await one<{ proposal_hash: string }>(q, 'select proposal_hash from denials where facility_id = $1 and id = $2', [facilityId, r.denialId]);
  if (!den || den.proposal_hash !== r.proposalHash) refuse('no such denial');
  return { role: 'agent', call: buildRecordDenied({ lineId: r.lineId as Hex, decisionId: r.decisionId as Hex, reasonCode: r.reasonCode as Hex, proposalHash: r.proposalHash as Hex }) };
};

const recordSale: Builder = async ({ q, facilityId, row, d }) => {
  const r = parse(z.object({ saleId: z.string().min(1), saleIdHash: Hex32, amountBucket: Uint }), row.request);
  const sale = await one<{ sale_id_hash: string; amount_bucket: string }>(q, 'select sale_id_hash, amount_bucket::text as amount_bucket from sales where facility_id = $1 and id = $2', [facilityId, r.saleId]);
  if (!sale || sale.sale_id_hash !== r.saleIdHash || sale.amount_bucket !== r.amountBucket) refuse('the request is not the verified sale');
  if (BigInt(r.amountBucket) === 0n) refuse('a zero-amount sale is never recorded');
  // Treasury refuses a sale before the first plan (StalePlan): wait for the commit instead of refusing for good.
  const planVersion = await d.client.readContract({ address: d.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: 'planVersion' });
  if (Number(planVersion) === 0) throw new RelayDeferral('no plan is committed yet');
  const recorded = await d.client.readContract({ address: d.deployment.contracts.SalesOracle?.address as Address, abi: iSalesOracleAbi, functionName: 'isSaleRecorded', args: [r.saleIdHash as Hex] });
  if (recorded) refuse('the sale is already recorded');
  return { role: 'oracle', call: buildRecordSale({ saleIdHash: r.saleIdHash as Hex, amountBucket: BigInt(r.amountBucket) }) };
};

export const RELAY_BUILDERS: Readonly<Record<string, Builder>> = Object.freeze({
  'PlanRegistry.registerFounderKey': registerFounderKey,
  'Treasury.openFacility': openFacility,
  'Treasury.fund': fund,
  'PlanRegistry.commitPlan': commitPlan,
  'Treasury.bindPayee': bindPayee,
  'Treasury.queueLoosen': queueLoosen,
  'Treasury.releaseStage': releaseStage,
  'Treasury.cancelLoosen': cancelLoosen,
  'Treasury.executeLoosen': executeLoosen,
  'Treasury.pause': pause,
  'Treasury.recordDenied': recordDenied,
  'SalesOracle.recordSale': recordSale,
});

/** Kinds the oracle signs (the record-sale queue); every other kind is the relay queue's. */
export const ORACLE_KINDS: ReadonlySet<string> = new Set(['SalesOracle.recordSale']);
/** Tighten-only kinds that may still be signed while the worker is halted. */
export const TIGHTEN_KINDS: ReadonlySet<string> = new Set(['Treasury.pause', 'Treasury.cancelLoosen']);
