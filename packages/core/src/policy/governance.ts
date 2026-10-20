/**
 * Everything that is not a payment or a loosening: tighten (agent alone), escrow and stage releases (one human
 * signature), replans (founder; tighten-only, constitution re-checked) and direct calls the agent key can never make
 * (each mapped to the revert a forced send gets). Loosening: loosen.ts.
 */
import { effectiveLifetimeCap, checkConstitution, firstViolation } from "../constitution/check";
import { checkPlanSequence } from "../constitution/replan";
import { parseMinor, tryParseMinor } from "../money/index";
import { ZERO_HEX32 } from "../schemas/primitives";
import { TAINT_REASON, isTrusted } from "../taint/labels";
import { agentGate, allow, committedPlanFromContext, deny, escalate, isCooling, lineState, nowOf, payeeState } from "./state";
import type {
  DirectCall,
  DirectCallProposalIn,
  PolicyContext,
  PolicyDecision,
  ReleaseMilestoneProposalIn,
  ReleaseStageProposalIn,
  ReplanProposalIn,
  TightenProposalIn,
} from "./types";

const big = (s: string): bigint => parseMinor(s);

/**
 * Revert a forced send by the agent key gets for each function it may not call. The founder- and lender-signed entry
 * points run in TreasuryGovernance (delegatecall) on final-1, no longer as loop-1's InvalidSignature stubs: with a
 * valid envelope signed by the agent key, ENV-4 maps the agent signer to NotOwner (founder structs) and
 * _requireLender to NotLender (StageRelease).
 */
export const DIRECT_CALL_REVERT: { readonly [F in DirectCall]: string } = {
  commitPlan: "NotOwner", // T6
  bindPayee: "NotOwner", // T2
  queueLoosen: "NotOwner", // ENV-4 founder signature by the agent
  ownerSpend: "NotOwner", // ENV-4 founder signature by the agent
  executeLoosen: "TimelockActive", // T9: nothing the agent queued is executable (unknown id or inside the timelock)
  releaseMilestone: "MilestoneLocked", // T5: msg.sender == agent, before any other row
  releaseStage: "NotLender", // T23: a StageRelease signed by the agent key
  cancelLoosen: "NotOwner", // only the lender, the observer or the owner EOA may veto
  fund: "NotLender",
  openFacility: "NotLender",
  registerFounderKey: "NotLender",
  recordSale: "NotOracle", // T24
  confirmSettlement: "NotOracle",
  failSettlement: "NotOracle",
  withdrawReserve: "ReserveLocked", // T8: there is no such call; the forced send is Treasury.spend with lineId RESERVE
};

export function evaluateDirectCall(p: DirectCallProposalIn): PolicyDecision {
  return deny(DIRECT_CALL_REVERT[p.fn]);
}

/** Tighten-only calls the agent may make alone (§4). A "tighten" that loosens is a cap raise: NotOwner (T6). */
export function evaluateTighten(p: TightenProposalIn, ctx: PolicyContext): PolicyDecision {
  const gate = agentGate(ctx, true);
  if (gate) return gate;
  if (p.origin.trust !== "trusted" || (p.lineKey && !isTrusted(p.lineKey))) return deny(TAINT_REASON.action);
  if (p.action === "REVOKE_AGENT" || p.action === "PAUSE") return allow("TIGHTEN_OK");
  const state = p.lineKey ? lineState(ctx, p.lineKey.value) : undefined;
  if (p.action === "PAUSE_LINE") return state ? allow("TIGHTEN_OK") : deny("LineExpired");
  const value = p.newValue ? tryParseMinor(p.newValue.value) : null;
  if (value === null) return deny("INVALID_AMOUNT");
  if (p.action === "RAISE_RESERVE_BPS") {
    return value >= BigInt(ctx.reserveBps) && value <= 10_000n ? allow("TIGHTEN_OK") : deny("NotOwner");
  }
  if (!state) return deny("LineExpired");
  const current = big(p.action === "LOWER_PER_TX_CAP" ? state.perTxCapMinor : state.windowCapMinor);
  return value <= current ? allow("TIGHTEN_OK") : deny("NotOwner");
}

/**
 * Non-auto milestone release (MilestoneEscrow.releaseMilestone after the signature envelope): unknown → PayeeNotBound;
 * auto, released or not fully funded → MilestoneLocked; signed amount ≠ schedule → AmountExceedsSchedule; no inspection
 * evidence → EvidenceMissing; then Treasury.escrowRelease: the payee inside its cooling window (a re-bind restarts it,
 * audit run-3) → PayeeCooling; the payee's lifetime cap → CapExceeded. The agent itself always gets MilestoneLocked.
 * Re-check M-1: a release is for good. A failed payout returns the BU to the supplier line but leaves the milestone
 * released (MilestoneLocked), so a known settlement (`settlementUsed`) also reads as released; escrowRelease's
 * SettlementClosed is unreachable from here.
 */
export function evaluateReleaseMilestone(p: ReleaseMilestoneProposalIn, ctx: PolicyContext): PolicyDecision {
  if (p.origin.trust !== "trusted") return deny(TAINT_REASON.action);
  const order = ctx.escrowOrders.find((o) => o.orderId === p.orderId);
  const m = order?.milestones[p.idx];
  if (!order || !m) return deny("PayeeNotBound");
  const amount = big(m.amountMinor);
  if (m.released || m.settlementUsed || m.autoRelease || big(m.fundedMinor) !== amount) return deny("MilestoneLocked");
  const signed = p.amountMinor === undefined ? amount : tryParseMinor(p.amountMinor);
  if (signed === null) return deny("INVALID_AMOUNT");
  if (signed !== amount) return deny("AmountExceedsSchedule");
  if (order.inspectionRequired && (!p.evidenceHash || p.evidenceHash.toLowerCase() === ZERO_HEX32)) return deny("EvidenceMissing");
  const payee = payeeState(ctx, order.payeeId, order.lineKey);
  if (payee && isCooling(ctx, payee)) return deny("PayeeCooling");
  const lifetime = payee ? effectiveLifetimeCap(payee) : null;
  if (payee && lifetime !== null && big(payee.paidMinor) + amount > lifetime) return deny("CapExceeded");
  return escalate("NEEDS_FOUNDER", "FOUNDER_RELEASE_REQUIRED", "RELEASE_ESCROW_BALANCE");
}

/**
 * Stage gate (Treasury.releaseStage after the lender's signature): an unknown or released stage, or a gate not met by
 * its deadline (0 = none), reverts CapExceeded, the stage stop-loss error. `salesMinor` gates compare recorded revenue,
 * `orders` gates the recorded sale count; the first stage (no gate, METRIC_NONE) is never released here. Met → the
 * release goes to the lender (NEEDS_OFFICER); otherwise the stage stays frozen.
 */
export function evaluateReleaseStage(p: ReleaseStageProposalIn, ctx: PolicyContext): PolicyDecision {
  if (p.origin.trust !== "trusted") return deny(TAINT_REASON.action);
  if (!isTrusted(p.salesMinor) || (p.salesCount !== undefined && !isTrusted(p.salesCount))) return deny(TAINT_REASON.capRaise);
  const stage = ctx.plan.stages.find((s) => s.stageId === p.stageId);
  const state = ctx.stages.find((s) => s.stageId === p.stageId);
  if (!stage || !state || state.released) return deny("CapExceeded");
  const gate = stage.gate;
  if (gate === null) return deny("CapExceeded");
  const deadline = big(gate.deadline);
  if (deadline !== 0n && nowOf(ctx) > deadline) return deny("CapExceeded");
  const raw = gate.metric === "salesMinor" ? p.salesMinor : p.salesCount;
  const fact = raw === undefined ? null : tryParseMinor(raw.value);
  if (raw !== undefined && fact === null) return deny("INVALID_AMOUNT");
  return fact !== null && fact >= big(gate.target) ? escalate("NEEDS_OFFICER", "STAGE_GATE_MET", "RELEASE_STAGE") : deny("CapExceeded");
}

/**
 * Replan: the founder alone signs commitPlan, so it must be the next version (else StalePlan) and pass the
 * constitution against the current on-chain state, codes 1-13 then 14 (G0-AUDIT v-1): a re-commit that loosens
 * anything is DENY PlanInvariantViolated(REPLAN_LOOSENS), the revert a forced send gets. Such a draft is split
 * into lender-co-signed LOOSEN_* exceptions instead (compiler `routeReplan`). Code 9 reads the live payee
 * registry (payees bound since v1 count).
 */
export function evaluateReplan(p: ReplanProposalIn, ctx: PolicyContext): PolicyDecision {
  if (p.origin.trust !== "trusted") return deny(TAINT_REASON.action);
  const m = p.draft.manifest;
  const current = committedPlanFromContext(ctx);
  if (checkPlanSequence(m, current)) return deny("StalePlan");
  const facility = { ...ctx.facility, payees: ctx.payees };
  const code = firstViolation(checkConstitution(m, facility, nowOf(ctx), current));
  if (code) return deny("PlanInvariantViolated", { constitutionCode: code });
  return escalate("NEEDS_FOUNDER", "FOUNDER_SIGNATURE_REQUIRED", "REPLAN");
}
