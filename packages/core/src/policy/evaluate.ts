/**
 * Policy engine (project.md §4, §7.2 step 3): every agent proposal → AUTO | NEEDS_FOUNDER | NEEDS_OFFICER | DENY.
 * Deterministic and pure. The first matching row wins. DENY reasons that mirror an on-chain check use the
 * contract error name, so the refusal trace and a forced send's revert line up (§13.1 #6, `mirrorsRevert`).
 *
 * DECISION TABLE
 *
 * SPEND (pay a bound payee from a line; invoice or pacing slot)          [§8.4 order, then off-chain checks]
 *   agent revoked → DENY NotAgent · treasury paused → DENY Paused · agent expired → DENY AgentExpired
 *   lineKey RESERVE → DENY ReserveLocked (T8: the reserve is not a line)
 *   line escrowOnly → DENY EscrowOnly · planVersion ≠ current → DENY StalePlan
 *   line missing or past validUntil → DENY LineExpired · circuit open → DENY CircuitOpen · line paused → DENY Paused
 *   payee not bound to the line, or not listed on it in the current plan version → DENY PayeeNotBound
 *   payee in cooling → DENY PayeeCooling
 *   intentId used → DENY DuplicateIntent · invoice paid → DENY DuplicateInvoice
 *   invoice spend on a pacing line → DENY INVOICE_ON_PACING_LINE
 *   pacing invoiceHash ≠ bytes32(uint256(slot)) → DENY PACING_HASH_MISMATCH
 *   pacing slot already used → DENY DuplicateInvoice · slot ahead → DENY PACING_SLOT_AHEAD
 *   amount unreadable → DENY INVALID_AMOUNT · amount 0 → DENY CapExceeded (first check of Treasury._requireCaps)
 *   amount > perTxCap | 64 live spends in the window | window | line balance | payee lifetime cap | pacing |
 *     released stage | fundedMinor → DENY CapExceeded
 *   payee value untrusted → DENY TAINTED_PAYEE · line or trigger untrusted → DENY TAINTED_ACTION
 *   invoice carries a Reader red flag → NEEDS_OFFICER FLAGGED_INVOICE (POLICY_ESCALATION)
 *   otherwise → AUTO WITHIN_PLAN
 * FUND_MILESTONE (pre-signed schedule; not bounded by perTx/window, §8.4)       [MilestoneEscrow order]
 *   agent gate as above · unknown order/milestone → PayeeNotBound
 *   supplier line missing or past validUntil → LineExpired · circuit open → CircuitOpen · line paused → Paused
 *   payee not bound to the line (no listing rule) → PayeeNotBound · cooling → PayeeCooling · amount 0 → CapExceeded
 *   funded + amount > schedule → AmountExceedsSchedule · > line balance, released stage or funded → CapExceeded
 *   planVersion ≠ current → STALE_PLAN_VERSION (off-chain only) · order or trigger untrusted → TAINTED_ACTION
 *   otherwise → AUTO WITHIN_PLAN
 * TIGHTEN (agent alone, instant; allowed while paused)
 *   revoked → NotAgent · expired → AgentExpired · trigger/line untrusted → TAINTED_ACTION
 *   PAUSE / REVOKE_AGENT / PAUSE_LINE → AUTO TIGHTEN_OK
 *   new cap ≤ current, or current reserve ≤ new bps ≤ 10,000 → AUTO TIGHTEN_OK (untrusted values may only tighten)
 *   anything that loosens → DENY NotOwner (T6)
 * LOOSEN (RAISE_CAP, ADD_PAYEE, EXTEND_EXPIRY, MOVE_POCKETS, UNPAUSE, WITHDRAW_RESERVE)       [loosen.ts]
 *   trigger untrusted → TAINTED_ACTION · new cap/expiry/amount untrusted → TAINTED_CAP · payee untrusted → TAINTED_PAYEE
 *   the kind's rules (_checkLoosen, re-checked by executeLoosen): a line outside the plan → LineExpired;
 *     caps over 25%/50% → PlanInvariantViolated(4/5); expiry past now + 90 days → (2/6); agent expiry before any
 *     plan → StalePlan; MOVE_POCKETS same line or 0 → (13), more than unspent → CapExceeded; ADD_PAYEE zero id or
 *     hash → (13), past validUntil → LineExpired, escrow line → (10), platform payee → (11); WITHDRAW_RESERVE to a
 *     payee outside the static platform registry → PayeeNotBound, 0 or above the reserve → CapExceeded
 *   16 live loosenings queued → CapExceeded · "raise" that is not higher → DENY NOT_A_LOOSENING
 *   otherwise → NEEDS_OFFICER LOOSEN_NEEDS_BOTH_SIGS (founder + lender sign, then the timelock)
 * EXECUTE_LOOSEN (executeLoosen: anyone, after the timelock)
 *   trigger untrusted → TAINTED_ACTION · unknown, executed, cancelled or before executableAt → TimelockActive
 *   past expiresAt (7-day grace) → SignatureExpired · the kind's rules fail now → their error · else AUTO LOOSEN_EXECUTABLE
 * RELEASE_MILESTONE (non-auto balance)
 *   unknown → PayeeNotBound · released, auto or not fully funded → MilestoneLocked
 *     (a failed payout leaves it released for good: re-check M-1)
 *   signed amount ≠ schedule → AmountExceedsSchedule · no (or zero) evidence → EvidenceMissing
 *   payee cooling (a re-bind restarts it) → PayeeCooling · payee lifetime cap → CapExceeded
 *   otherwise → NEEDS_FOUNDER FOUNDER_RELEASE_REQUIRED (RELEASE_ESCROW_BALANCE)
 * RELEASE_STAGE
 *   sales figure or count untrusted → TAINTED_CAP · unknown, already released, no gate, past the deadline or gate
 *     short → DENY CapExceeded (the stage stays frozen) · gate met → NEEDS_OFFICER STAGE_GATE_MET (RELEASE_STAGE)
 * REPLAN (founder-only, so tighten-only; G0-AUDIT v-1)
 *   trigger untrusted → TAINTED_ACTION
 *   not version + 1 of the same planId with prevPlanHash = current planHash → DENY StalePlan
 *   codes 1-13 fail → DENY PlanInvariantViolated(+first code); payees are checked against the live registry
 *   loosens the current on-chain state (caps, expiries, amounts, stages, reserve, agent, payees, pacing, window,
 *     escrowOnly) → DENY PlanInvariantViolated(REPLAN_LOOSENS): split it into LOOSEN_* kinds (routeReplan)
 *   otherwise → NEEDS_FOUNDER FOUNDER_SIGNATURE_REQUIRED (REPLAN)
 * DIRECT_CALL (the agent key calling a function it does not hold)
 *   commitPlan/bindPayee/queueLoosen/ownerSpend/cancelLoosen → NotOwner · executeLoosen → TimelockActive
 *   releaseMilestone → MilestoneLocked · releaseStage/fund/openFacility/registerFounderKey → NotLender
 *   recordSale/confirmSettlement/failSettlement → NotOracle · withdrawReserve → ReserveLocked
 * Any proposal whose trigger (`origin`) is untrusted can never be AUTO.
 *
 * Outside the proposal union: evaluateOwnerSpend (the founder's manual fallback; spend's rules without the agent,
 * pause, per-tx or window rows; no window entry) and evaluateRecordSale (the oracle: DuplicateSale, then StalePlan).
 */
import { evaluateDirectCall, evaluateReleaseMilestone, evaluateReleaseStage, evaluateReplan, evaluateTighten } from "./governance";
import { evaluateExecuteLoosen, evaluateLoosen } from "./loosen";
import { evaluateFundMilestone, evaluateSpend } from "./spend";
import type { PolicyContext, PolicyDecision, PolicyProposal } from "./types";

export function evaluateProposal(proposal: PolicyProposal, ctx: PolicyContext): PolicyDecision {
  switch (proposal.kind) {
    case "SPEND":
      return evaluateSpend(proposal, ctx);
    case "FUND_MILESTONE":
      return evaluateFundMilestone(proposal, ctx);
    case "TIGHTEN":
      return evaluateTighten(proposal, ctx);
    case "LOOSEN":
      return evaluateLoosen(proposal, ctx);
    case "EXECUTE_LOOSEN":
      return evaluateExecuteLoosen(proposal, ctx);
    case "RELEASE_MILESTONE":
      return evaluateReleaseMilestone(proposal, ctx);
    case "RELEASE_STAGE":
      return evaluateReleaseStage(proposal, ctx);
    case "REPLAN":
      return evaluateReplan(proposal, ctx);
    case "DIRECT_CALL":
      return evaluateDirectCall(proposal);
  }
}
