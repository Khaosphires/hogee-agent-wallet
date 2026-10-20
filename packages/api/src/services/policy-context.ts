/**
 * Snapshot + the committed plan + in-flight payments → core's PolicyContext (§7.2 step 3), as the API evaluates a
 * proposal or compiles a replan. Fail closed: the DB's committed plan must be the chain's (version, planHash, and the
 * stored manifest must hash to it). Payments the API or worker created but the snapshot block does not show mined yet
 * (POLICY_OK, SIGNED, BROADCAST, DROPPED, or mined after the block) are IN FLIGHT and count against the caps (hard
 * rule 6, core projectInFlight); mined ones feed usedIntents / paidInvoices. Pacing lines that already have a slot in
 * the snapshot's chain day are listed too (audit run-4: at most one pacing slot per line per day, spend-proposal.ts).
 * The payees are the plan lines' on-chain bindings plus the server country's tax payee, the reserve's only destination.
 */
import {
  hashObject,
  LOOSEN_GRACE_SECONDS,
  PlanManifest,
  type ExceptionKind,
  type LineKey,
  type LoosenRequestIn,
  type PolicyContext,
  type PolicyEscrowOrder,
  type PolicyLineState,
  type PolicyPayeeState,
  type PolicyQueuedLoosen,
  type RegistryPayee,
} from "@hogee/core";
import type { Hex } from "viem";
import { payoutHashOf, taxPayeeFor } from "../catalog/payees";
import { shortIdToBytes32 } from "../chain-lib";
import type { ApiDeps, OnboardedPayee, Scope } from "../context";
import { fail } from "../http/problem";
import { platformPayoutHash } from "./chain";
import { loosenIn } from "./loosen";
import { committedPlanRow, type PlanRow } from "./plans";
import { milestonesOnChain, readSnapshot, shortIdFromBytes32, type LineView, type Snapshot } from "./snapshot";
import { toBytes32 } from "./tags";
import { pool, rows } from "./sql";

const UINT128_MAX = (1n << 128n) - 1n;
const IN_FLIGHT = new Set(["POLICY_OK", "SIGNED", "BROADCAST", "DROPPED"]);
const MINED = new Set(["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"]);
const OUTFLOW = new Set(["SPEND", "OWNER_SPEND", "FUND_MILESTONE"]);
const SECONDS_PER_DAY = 86_400n;

export interface InFlight {
  readonly perLine: ReadonlyMap<LineKey, { readonly slots: number; readonly lineMinor: bigint }>;
  readonly totalMinor: bigint;
  readonly usedIntents: ReadonlySet<string>;
  readonly paidInvoices: ReadonlySet<string>;
  /**
   * Pacing lines with an agent slot (a SPEND row) in the snapshot's chain day, floor(timestamp / 86400) as the worker
   * tick counts days (decide.ts chainDay): one SIGNED and in flight (it lands that day or later), or the line's latest
   * mined one in a block of that day. Released rows never count, and neither does an unsigned POLICY_OK row (audit
   * run-4 re-check): it may never be signed, and nothing records the chain day it was proposed in, so it could hold a
   * line's day for ever. The worker enforces the day where it matters, at signing (agent-actions lineSlotToday counts
   * signed and mined rows and signs oldest first), so two unsigned proposals of one day never both become slots.
   */
  readonly pacedToday: ReadonlySet<LineKey>;
}

export interface PolicyWorld {
  readonly snapshot: Snapshot;
  readonly plan: PlanRow;
  readonly manifest: PlanManifest;
  readonly ctx: PolicyContext;
  readonly inflight: InFlight;
}

interface PaymentLite {
  kind: string;
  state: string;
  signed: boolean;
  line_key: LineKey | null;
  amount_minor: string;
  intent_id: string;
  invoice_hash: string;
  block: string | null;
}

async function pacedTodayOf(
  deps: ApiDeps,
  at: { readonly timestamp: bigint },
  pacing: ReadonlySet<LineKey>,
  signedInFlight: ReadonlyMap<LineKey, number>,
  latestMined: ReadonlyMap<LineKey, bigint>,
): Promise<Set<LineKey>> {
  const out = new Set<LineKey>();
  for (const lineKey of pacing) {
    if ((signedInFlight.get(lineKey) ?? 0) > 0) {
      out.add(lineKey);
      continue;
    }
    const block = latestMined.get(lineKey);
    if (block === undefined) continue;
    const mined = await deps.client.getBlock({ blockNumber: block });
    if (mined.timestamp / SECONDS_PER_DAY === at.timestamp / SECONDS_PER_DAY) out.add(lineKey);
  }
  return out;
}

async function inFlightAt(deps: ApiDeps, scope: Scope, at: { readonly block: bigint; readonly timestamp: bigint }, pacing: ReadonlySet<LineKey>): Promise<InFlight> {
  const block = at.block;
  const ps = await rows<PaymentLite>(
    pool(deps.db),
    `select kind, state, raw_signed_tx is not null as signed, line_key, amount_minor::text as amount_minor, intent_id, invoice_hash, block::text as block from payments where facility_id = $1`,
    [scope.facilityId],
  );
  const perLine = new Map<LineKey, { slots: number; lineMinor: bigint }>();
  const usedIntents = new Set<string>();
  const paidInvoices = new Set<string>();
  const latestMined = new Map<LineKey, bigint>();
  const signedInFlight = new Map<LineKey, number>();
  let totalMinor = 0n;
  for (const p of ps) {
    const mined = MINED.has(p.state) && p.block !== null && BigInt(p.block) <= block;
    if (mined) {
      usedIntents.add(p.intent_id);
      if (p.kind === "SPEND" && p.line_key && !pacing.has(p.line_key)) paidInvoices.add(p.invoice_hash);
      if (p.kind === "SPEND" && p.line_key && pacing.has(p.line_key)) {
        const minedBlock = BigInt(p.block as string);
        if (minedBlock > (latestMined.get(p.line_key) ?? -1n)) latestMined.set(p.line_key, minedBlock);
      }
      continue;
    }
    if (!IN_FLIGHT.has(p.state) && !MINED.has(p.state)) continue;
    // An intent in flight is taken (the unique index holds it): a second proposal of it is a duplicate, not a race.
    usedIntents.add(p.intent_id);
    if (p.kind === "SPEND" && p.line_key && !pacing.has(p.line_key)) paidInvoices.add(p.invoice_hash);
    if (!OUTFLOW.has(p.kind)) continue;
    const amount = BigInt(p.amount_minor);
    totalMinor += amount;
    if (p.kind !== "SPEND" || !p.line_key) continue;
    const prev = perLine.get(p.line_key) ?? { slots: 0, lineMinor: 0n };
    perLine.set(p.line_key, { slots: prev.slots + 1, lineMinor: prev.lineMinor + amount });
    if (p.signed) signedInFlight.set(p.line_key, (signedInFlight.get(p.line_key) ?? 0) + 1);
  }
  return { perLine, totalMinor, usedIntents, paidInvoices, pacedToday: await pacedTodayOf(deps, at, pacing, signedInFlight, latestMined) };
}

function lineState(v: LineView): PolicyLineState {
  const p = v.pocket;
  return {
    allocatedMinor: p.allocatedMinor.toString(),
    spentMinor: p.spentMinor.toString(),
    escrowedMinor: p.escrowedMinor.toString(),
    perTxCapMinor: p.perTxCapMinor.toString(),
    windowCapMinor: p.windowCapMinor.toString(),
    windowSpentMinor: p.windowSpentMinor.toString(),
    validUntil: p.validUntil.toString(),
    paused: p.paused,
    circuitOpen: p.circuitOpen,
    nextSequence: Number(v.sequence),
    payeeIds: v.payeeIds.map(shortIdFromBytes32),
  };
}

/**
 * The bound payees of the lines (bytes32, lowercased) that Treasury's static platform registry holds
 * (platformPayoutAccountHash ≠ 0; fixed at deploy). Run-8 re-check: the lifetime cap does not tell them apart, since
 * _addPayee binds an ADD_PAYEE vendor with the same unlimited cap as a platform payee.
 */
export async function platformPayeeIdsOf(deps: ApiDeps, views: readonly LineView[]): Promise<ReadonlySet<string>> {
  const ids = [...new Set(views.flatMap((v) => v.bindings.filter((b) => b.bound).map((b) => b.payeeId.toLowerCase())))];
  const hashes = await Promise.all(ids.map((id) => platformPayoutHash(deps, id as Hex)));
  return new Set(ids.filter((_, i) => BigInt(hashes[i] as Hex) !== 0n));
}

/** A line's bound payees; `platform` only for one in Treasury's static registry (platformPayeeIdsOf). */
export function payeesOf(lineKey: LineKey, v: LineView, platform: ReadonlySet<string>): PolicyPayeeState[] {
  return v.bindings
    .filter((b) => b.bound)
    .map((b) => ({
      payeeId: shortIdFromBytes32(b.payeeId),
      source: platform.has(b.payeeId.toLowerCase()) ? ("platform" as const) : ("bound" as const),
      lineKeys: [lineKey],
      lifetimeCapMinor: b.lifetimeCapMinor.toString(),
      ...(b.coolingUntil > 0n ? { coolingUntil: b.coolingUntil.toString() } : {}),
      paidMinor: b.paidMinor.toString(),
    }));
}

/** The server country's tax payee; none for a country without a payee set (ID), so a withdrawal is PayeeNotBound. */
function serverTaxPayee(deps: ApiDeps): OnboardedPayee | undefined {
  try {
    return taxPayeeFor(deps.config.countryCode);
  } catch {
    return undefined;
  }
}

/**
 * The server country's tax payee as Treasury's static platform registry holds it (hardening run-8). WITHDRAW_RESERVE
 * may go to it alone (exceptions.ts reserveTaxPayee), and it is on no plan line, so the line bindings never list it and
 * core's isPlatformPayee refused the one destination the chain accepts. It is listed, on no line, only while the chain
 * holds its payout hash and that hash is the catalog account's: otherwise PayeeNotBound, as the chain would revert (or
 * a payout to an account nobody signed for). The other country's tax payee is never listed.
 */
export async function taxPayeeEntries(deps: ApiDeps, lineBound: readonly PolicyPayeeState[]): Promise<PolicyPayeeState[]> {
  const tax = serverTaxPayee(deps);
  if (!tax || lineBound.some((p) => p.payeeId === tax.payeeId)) return [];
  const onChain = await platformPayoutHash(deps, shortIdToBytes32(tax.payeeId));
  if (onChain.toLowerCase() !== payoutHashOf(tax).toLowerCase()) return [];
  return [{ payeeId: tax.payeeId, source: "platform", lineKeys: [], lifetimeCapMinor: UINT128_MAX.toString(), paidMinor: "0" }];
}

async function escrowOrders(deps: ApiDeps, scope: Scope): Promise<PolicyEscrowOrder[]> {
  const orders = await rows<{ order_id: string; payee_id: string; inspection_required: boolean }>(
    pool(deps.db),
    `select o.order_id, o.payee_id, o.inspection_required from escrow_orders o
       join payees p on p.facility_id = o.facility_id and p.id = o.payee_id
      where o.facility_id = $1 and p.status in ('COOLING', 'BOUND')`,
    [scope.facilityId],
  );
  const out: PolicyEscrowOrder[] = [];
  for (const o of orders) {
    const ms = await milestonesOnChain(deps, toBytes32(o.order_id));
    out.push({
      orderId: o.order_id,
      payeeId: o.payee_id,
      lineKey: "SUPPLIER",
      inspectionRequired: o.inspection_required,
      milestones: ms.map((m) => ({ amountMinor: m.amountMinor.toString(), fundedMinor: m.fundedMinor.toString(), autoRelease: m.autoRelease, released: m.released })),
    });
  }
  return out;
}

/**
 * The facility's live loosenings as Treasury counts them for queueLoosen row 7 (audit run-7: core's MAX_QUEUED_LOOSENS
 * bound only applies when ctx.loosens is set): QUEUED or EXECUTABLE exception rows with a loosenId, live until
 * executableAt + LOOSEN_GRACE_SECONDS. A row without an executableAt yet counts from `now`. The API only counts them
 * (evaluateLoosen); a request it can no longer rebuild (a payee left the catalog) is kept as a placeholder.
 */
async function liveLoosens(deps: ApiDeps, scope: Scope, now: bigint): Promise<PolicyQueuedLoosen[]> {
  const live = await rows<{ kind: ExceptionKind; payload: Record<string, unknown>; loosen_id: string; executable_at: string | null }>(
    pool(deps.db),
    "select kind, payload, loosen_id, executable_at::text as executable_at from exceptions where facility_id = $1 and status in ('QUEUED', 'EXECUTABLE') and loosen_id is not null",
    [scope.facilityId],
  );
  return Promise.all(
    live.map(async (e): Promise<PolicyQueuedLoosen> => {
      const request: LoosenRequestIn = await loosenIn(deps, e).catch((): LoosenRequestIn => ({ kind: "UNPAUSE" }));
      const executableAt = e.executable_at === null ? now : BigInt(e.executable_at);
      return { loosenId: e.loosen_id as Hex, request, status: "QUEUED", executableAt: executableAt.toString(), expiresAt: (executableAt + LOOSEN_GRACE_SECONDS).toString() };
    }),
  );
}

/** The PolicyContext of the facility's committed plan at the latest block. CONFLICT when there is none or it drifted. */
export async function policyWorld(deps: ApiDeps, scope: Scope): Promise<PolicyWorld> {
  const plan = await committedPlanRow(pool(deps.db), scope);
  if (!plan) throw fail("CONFLICT", "No plan is committed yet");
  const s = await readSnapshot(deps);
  const manifest = PlanManifest.parse(plan.manifest_json);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (s.planVersion !== Number(plan.version) || !same(s.plan.planHash, plan.plan_hash) || !same(hashObject(manifest), plan.plan_hash)) {
    throw fail("CONFLICT", "The stored plan is not the plan on-chain; wait for the worker to sync");
  }
  const pacing = new Set(manifest.lines.filter((l) => l.pacing).map((l) => l.lineKey));
  const inflight = await inFlightAt(deps, scope, { block: s.blockNumber, timestamp: s.timestamp }, pacing);
  const byId = new Map(s.lines.map((l) => [l.lineId.toLowerCase(), l]));
  const lines: Partial<Record<LineKey, PolicyLineState>> = {};
  const payees: PolicyPayeeState[] = [];
  const listed = manifest.lines.flatMap((l) => {
    const view = byId.get(l.lineId.toLowerCase());
    return view ? [{ lineKey: l.lineKey, view }] : [];
  });
  const platform = await platformPayeeIdsOf(deps, listed.map((x) => x.view));
  for (const { lineKey, view } of listed) {
    lines[lineKey] = lineState(view);
    payees.push(...payeesOf(lineKey, view, platform));
  }
  payees.push(...(await taxPayeeEntries(deps, payees)));
  const registry: RegistryPayee[] = payees.map(({ paidMinor: _paid, ...entry }) => entry);
  const ctx: PolicyContext = {
    now: s.timestamp,
    plan: manifest,
    planHash: plan.plan_hash as Hex,
    planVersion: s.planVersion,
    paused: s.paused,
    agent: { revoked: s.plan.agentRevoked, expiresAt: s.agentExpiry.toString() },
    releasedMinor: s.balances.releasedMinor.toString(),
    fundedMinor: s.balances.fundedMinor.toString(),
    totalSpentMinor: s.balances.spentMinor.toString(),
    totalEscrowedMinor: s.balances.escrowedMinor.toString(),
    reserveMinor: s.balances.reserveMinor.toString(),
    reserveBps: s.plan.reserveBps,
    lines,
    payees,
    usedIntents: inflight.usedIntents,
    paidInvoices: inflight.paidInvoices,
    escrowOrders: await escrowOrders(deps, scope),
    stages: s.stages.map((st) => ({ stageId: shortIdFromBytes32(st.stageId), released: st.released })),
    loosens: await liveLoosens(deps, scope, s.timestamp),
    facility: {
      capMinor: s.facility.capMinor.toString(),
      reserveFloorBps: s.facility.reserveFloorBps,
      judgingWindowEnd: s.judgingWindowEnd.toString(),
      payees: registry,
      ownerEOA: s.roles.ownerEOA.toLowerCase() as Hex,
      lender: s.roles.lender.toLowerCase() as Hex,
      oracle: s.roles.oracle.toLowerCase() as Hex,
      observer: s.roles.observer.toLowerCase() as Hex, // zero = none (audit run-3: the agent is never the observer)
    },
  };
  return { snapshot: s, plan, manifest, ctx, inflight };
}
