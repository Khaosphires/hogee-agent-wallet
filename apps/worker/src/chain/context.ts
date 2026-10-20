/**
 * ChainSnapshot + the committed plan → core's PolicyContext (project.md §7.2 step 3). Pure.
 *
 * Fail closed (ContextMismatchError) when the DB's committed plan is not the chain's (version, planId, planHash, and
 * the stored manifest must hash to that planHash), or
 * when the worker's configured keys are not the deployment's roles: the plan's agent, the Treasury's lender and
 * oracle. The facility context carries the REAL owner/lender/oracle addresses (G0-DECISIONS §7: the Rina demo
 * context uses the zero address; the worker must not).
 */
import { hashObject, type LineKey, type PlanManifest, type PolicyContext, type PolicyLineState, type PolicyPayeeState, type RegistryPayee } from '@hogee/core';
import { getAddress, type Address, type Hex } from 'viem';
import { shortIdFromBytes32, type ChainSnapshot, type LineView } from './snapshot';

/** The `plans` row of the facility's committed version (status COMMITTED). */
export interface CommittedPlan {
  /** On-chain bytes32 planId (PlanApproval.planId). */
  readonly planId: Hex;
  readonly version: number;
  readonly planHash: Hex;
  readonly manifest: PlanManifest;
}

/** Role addresses the worker is configured with: its agent, lender and oracle keys. */
export interface ConfiguredRoles {
  readonly agent: Address;
  readonly lender: Address;
  readonly oracle: Address;
}

export interface ContextInput {
  readonly snapshot: ChainSnapshot;
  readonly committed: CommittedPlan | null;
  readonly roles: ConfiguredRoles;
  /** Intents / invoice hashes of this facility's mined payments (Treasury.isIntentUsed / isInvoicePaid mirror). */
  readonly mined: { readonly usedIntents: ReadonlySet<string>; readonly paidInvoices: ReadonlySet<string> };
}

export type MismatchCode =
  | 'NO_COMMITTED_PLAN'
  | 'PLAN_VERSION_MISMATCH'
  | 'PLAN_ID_MISMATCH'
  | 'PLAN_HASH_MISMATCH'
  | 'MANIFEST_MISMATCH'
  | 'ROLE_MISMATCH'
  | 'AGENT_MISMATCH';

export class ContextMismatchError extends Error {
  override readonly name = 'ContextMismatchError';
  constructor(readonly code: MismatchCode) {
    super(`policy context refused: ${code}`);
  }
}

const UINT128_MAX = (1n << 128n) - 1n;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const lower = (a: Address): Address => getAddress(a).toLowerCase() as Address;

function checkPlan(s: ChainSnapshot, c: CommittedPlan | null): CommittedPlan {
  if (s.planVersion === 0 || c === null) throw new ContextMismatchError('NO_COMMITTED_PLAN');
  if (c.version !== s.planVersion || s.plan.version !== s.planVersion) throw new ContextMismatchError('PLAN_VERSION_MISMATCH');
  if (!same(c.planId, s.plan.planId)) throw new ContextMismatchError('PLAN_ID_MISMATCH');
  if (!same(c.planHash, s.plan.planHash)) throw new ContextMismatchError('PLAN_HASH_MISMATCH');
  // The manifest the policy reads must be the one the founder signed: planHash = keccak256(utf8(JCS(manifest))).
  if (!same(c.manifest.planId, c.planId) || c.manifest.version !== c.version || !same(hashObject(c.manifest), s.plan.planHash)) {
    throw new ContextMismatchError('MANIFEST_MISMATCH');
  }
  return c;
}

function checkRoles(s: ChainSnapshot, r: ConfiguredRoles): void {
  if (!same(s.roles.lender, r.lender) || !same(s.roles.oracle, r.oracle)) throw new ContextMismatchError('ROLE_MISMATCH');
  if (!same(s.plan.agent, r.agent)) throw new ContextMismatchError('AGENT_MISMATCH');
}

function lineState(v: LineView): PolicyLineState {
  const p = v.pocket;
  if (v.sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('lineSequence is out of range');
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

function payeesOf(lineKey: LineKey, v: LineView): PolicyPayeeState[] {
  return v.bindings
    .filter((b) => b.bound)
    .map((b) => ({
      payeeId: shortIdFromBytes32(b.payeeId),
      source: b.lifetimeCapMinor === UINT128_MAX ? ('platform' as const) : ('bound' as const),
      lineKeys: [lineKey],
      lifetimeCapMinor: b.lifetimeCapMinor.toString(),
      ...(b.coolingUntil > 0n ? { coolingUntil: b.coolingUntil.toString() } : {}),
      paidMinor: b.paidMinor.toString(),
    }));
}

/** Builds the PolicyContext the pacing planner evaluates (on the in-flight projection; see jobs/inflight.ts). */
export function buildPolicyContext(input: ContextInput): PolicyContext {
  const s = input.snapshot;
  const plan = checkPlan(s, input.committed);
  checkRoles(s, input.roles);
  const byId = new Map(s.lines.map((l) => [l.lineId.toLowerCase(), l]));
  const lines: Partial<Record<LineKey, PolicyLineState>> = {};
  const payees: PolicyPayeeState[] = [];
  for (const l of plan.manifest.lines) {
    const view = byId.get(l.lineId.toLowerCase());
    if (!view) continue; // not on chain: core treats the line as absent (LineExpired / NOT_PACING_LINE)
    lines[l.lineKey] = lineState(view);
    payees.push(...payeesOf(l.lineKey, view));
  }
  const registry: RegistryPayee[] = payees.map(({ paidMinor: _paid, ...entry }) => entry);
  return {
    now: s.timestamp,
    plan: plan.manifest,
    planHash: plan.planHash,
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
    usedIntents: input.mined.usedIntents,
    paidInvoices: input.mined.paidInvoices,
    escrowOrders: [],
    stages: s.stages.map((st) => ({ stageId: shortIdFromBytes32(st.stageId), released: st.released })),
    facility: {
      capMinor: s.facility.capMinor.toString(),
      reserveFloorBps: s.facility.reserveFloorBps,
      judgingWindowEnd: s.judgingWindowEnd.toString(),
      payees: registry,
      ownerEOA: lower(s.roles.ownerEOA),
      lender: lower(input.roles.lender),
      oracle: lower(input.roles.oracle),
      observer: lower(s.roles.observer), // zero = none, as on-chain (audit run-3: the agent is never the observer)
    },
  };
}
