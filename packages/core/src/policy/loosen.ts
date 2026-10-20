/**
 * Loosening (§8.8, H2): the agent may only ASK; founder + lender co-sign queueLoosen, the timelock runs, then anyone may
 * executeLoosen until the 7-day grace period ends. `loosenRules` mirrors TreasuryLoosenRules._checkLoosen, which runs at
 * queue time AND again at execution, row by row (require-table-final1, "Loosen kinds"): a DENY is the revert either
 * call would get. Off-chain checks (taint, unreadable values, a "raise" that is not higher) are not reverts.
 */
import { MAX_HORIZON_SECONDS } from "../constitution/check";
import { parseMinor, tryParseMinor } from "../money/index";
import type { ConstitutionCode, LineKey } from "../schemas/enums";
import { ZERO_HEX32 } from "../schemas/primitives";
import { TAINT_REASON, isTrusted, type Labeled } from "../taint/labels";
import { allow, deny, escalate, isPlatformPayee, lineState, nowOf, planLine } from "./state";
import type { ExecuteLoosenProposalIn, LoosenProposalIn, LoosenRequestIn, PolicyContext, PolicyDecision, PolicyQueuedLoosen } from "./types";

/** TreasuryState.MAX_QUEUED_LOOSENS: live (queued, unexpired) loosenings at once (bounds the loop in pause). */
export const MAX_QUEUED_LOOSENS = 16;
/** TreasuryState.LOOSEN_GRACE: executable from executableAt until executableAt + 7 days (inclusive). */
export const LOOSEN_GRACE_SECONDS = 7n * 86_400n;

const big = (s: string): bigint => parseMinor(s);
const invariant = (code: ConstitutionCode): PolicyDecision => deny("PlanInvariantViolated", { constitutionCode: code });
const INVALID = (): PolicyDecision => deny("INVALID_AMOUNT");

function tainted(v: Labeled<unknown>, reason: string): PolicyDecision | null {
  return isTrusted(v) ? null : deny(reason);
}

/** A loosening value from untrusted content: never a cap/expiry/amount (TAINTED_CAP), never a payee (TAINTED_PAYEE). */
function loosenTaint(r: LoosenRequestIn): PolicyDecision | null {
  switch (r.kind) {
    case "RAISE_CAP":
      return tainted(r.newCapMinor, TAINT_REASON.capRaise);
    case "EXTEND_EXPIRY":
      return tainted(r.newExpiresAt, TAINT_REASON.capRaise);
    case "MOVE_POCKETS":
      return tainted(r.amountMinor, TAINT_REASON.capRaise);
    case "ADD_PAYEE":
      return tainted(r.payeeId, TAINT_REASON.payee);
    case "WITHDRAW_RESERVE":
      return tainted(r.taxPayeeId, TAINT_REASON.payee) ?? tainted(r.amountMinor, TAINT_REASON.capRaise);
    case "UNPAUSE":
      return null;
  }
}

/** An active line of the current plan (an expired one is still active: validUntil is checked only where the kind says). */
const isActive = (ctx: PolicyContext, lineKey: LineKey | undefined): boolean =>
  lineKey !== undefined && lineState(ctx, lineKey) !== undefined && planLine(ctx, lineKey) !== undefined;

/** RAISE_*: line active, then the raised cap ≤ 25 % (code 4) / ≤ 50 % (code 5) of the line's current allocation. */
function raiseCapRules(r: Extract<LoosenRequestIn, { kind: "RAISE_CAP" }>, ctx: PolicyContext): PolicyDecision | null {
  const s = lineState(ctx, r.lineKey);
  if (!s || !isActive(ctx, r.lineKey)) return deny("LineExpired");
  const v = tryParseMinor(r.newCapMinor.value);
  if (v === null) return INVALID();
  const perTx = r.cap === "perTx";
  if (v * (perTx ? 4n : 2n) > big(s.allocatedMinor)) return invariant(perTx ? "PER_TX_CAP_OVER_25PCT" : "WINDOW_CAP_OVER_50PCT");
  return null;
}

/** ADD_PAYEE: non-zero payee and hash (13); line active and valid; not the escrow line (10); not a platform payee (11). */
function addPayeeRules(r: Extract<LoosenRequestIn, { kind: "ADD_PAYEE" }>, ctx: PolicyContext): PolicyDecision | null {
  if (r.payeeId.value === "" || r.payoutAccountHash?.toLowerCase() === ZERO_HEX32) return invariant("MALFORMED_PLAN");
  const s = lineState(ctx, r.lineKey);
  if (!s || !isActive(ctx, r.lineKey) || nowOf(ctx) > big(s.validUntil)) return deny("LineExpired");
  if (planLine(ctx, r.lineKey)?.escrowOnly) return invariant("SUPPLIER_LINE_NOT_ESCROW");
  return isPlatformPayee(ctx, r.payeeId.value) ? invariant("PAYEE_CAP_OVER_SCHEDULE") : null;
}

/** EXTEND_AGENT_EXPIRY: a committed plan (StalePlan), ≤ now + 90 days (2). EXTEND_LINE_EXPIRY: line active, ≤ now + 90 days (6). */
function extendRules(r: Extract<LoosenRequestIn, { kind: "EXTEND_EXPIRY" }>, ctx: PolicyContext): PolicyDecision | null {
  const agent = r.target === "agent";
  if (agent ? ctx.planVersion === 0 : !isActive(ctx, r.lineKey)) return agent ? deny("StalePlan") : deny("LineExpired");
  const v = tryParseMinor(r.newExpiresAt.value);
  if (v === null) return INVALID();
  return v > nowOf(ctx) + MAX_HORIZON_SECONDS ? invariant(agent ? "AGENT_EXPIRY_TOO_LATE" : "LINE_VALIDITY_TOO_LONG") : null;
}

/** MOVE_POCKETS (_checkMove): distinct lines and amount > 0 (13); both active; ≤ unspent balance; from-line caps (4, 5). */
function moveRules(r: Extract<LoosenRequestIn, { kind: "MOVE_POCKETS" }>, ctx: PolicyContext): PolicyDecision | null {
  const v = tryParseMinor(r.amountMinor.value);
  if (v === null) return INVALID();
  if (r.fromLineKey === r.toLineKey || v === 0n) return invariant("MALFORMED_PLAN");
  const from = lineState(ctx, r.fromLineKey);
  if (!from || !isActive(ctx, r.fromLineKey) || !isActive(ctx, r.toLineKey)) return deny("LineExpired");
  if (v > big(from.allocatedMinor) - big(from.spentMinor) - big(from.escrowedMinor)) return deny("CapExceeded");
  const reduced = big(from.allocatedMinor) - v;
  if (big(from.perTxCapMinor) * 4n > reduced) return invariant("PER_TX_CAP_OVER_25PCT");
  return big(from.windowCapMinor) * 2n > reduced ? invariant("WINDOW_CAP_OVER_50PCT") : null;
}

/** WITHDRAW_RESERVE: the destination is a static platform payee (PayeeNotBound, T1), then 0 < amount ≤ reserve. */
function withdrawRules(r: Extract<LoosenRequestIn, { kind: "WITHDRAW_RESERVE" }>, ctx: PolicyContext): PolicyDecision | null {
  if (!isPlatformPayee(ctx, r.taxPayeeId.value)) return deny("PayeeNotBound");
  const v = tryParseMinor(r.amountMinor.value);
  if (v === null) return INVALID();
  return v === 0n || v > big(ctx.reserveMinor) ? deny("CapExceeded") : null;
}

/** TreasuryLoosenRules._checkLoosen for one request, against the current state (queue time or execution time). */
export function loosenRules(r: LoosenRequestIn, ctx: PolicyContext): PolicyDecision | null {
  switch (r.kind) {
    case "RAISE_CAP":
      return raiseCapRules(r, ctx);
    case "ADD_PAYEE":
      return addPayeeRules(r, ctx);
    case "EXTEND_EXPIRY":
      return extendRules(r, ctx);
    case "MOVE_POCKETS":
      return moveRules(r, ctx);
    case "UNPAUSE":
      return r.lineKey !== undefined && !isActive(ctx, r.lineKey) ? deny("LineExpired") : null;
    case "WITHDRAW_RESERVE":
      return withdrawRules(r, ctx);
  }
}

/** Off-chain: a cap "raise" to a value that is not higher is not a loosening (on-chain it would be a no-op or a tighten). */
function notALoosening(r: LoosenRequestIn, ctx: PolicyContext): PolicyDecision | null {
  if (r.kind !== "RAISE_CAP") return null;
  const s = lineState(ctx, r.lineKey);
  const v = tryParseMinor(r.newCapMinor.value);
  if (!s || v === null) return null;
  return v <= big(r.cap === "perTx" ? s.perTxCapMinor : s.windowCapMinor) ? deny("NOT_A_LOOSENING") : null;
}

/** queueLoosen row 7: expired entries are pruned (expiresAt < now), then fewer than 16 may be live. */
function liveLoosens(ctx: PolicyContext): number {
  const now = nowOf(ctx);
  return (ctx.loosens ?? []).filter((q) => q.status === "QUEUED" && big(q.expiresAt) >= now).length;
}

/**
 * LOOSEN: taint first (an untrusted trigger or value never reaches a signer), then queueLoosen's rows: the kind's rules
 * (as executeLoosen re-checks them) and the live-queue bound; then the off-chain NOT_A_LOOSENING.
 */
export function evaluateLoosen(p: LoosenProposalIn, ctx: PolicyContext): PolicyDecision {
  if (p.origin.trust !== "trusted") return deny(TAINT_REASON.action);
  const refusal = loosenTaint(p.request) ?? loosenRules(p.request, ctx);
  if (refusal) return refusal;
  if (liveLoosens(ctx) >= MAX_QUEUED_LOOSENS) return deny("CapExceeded");
  return notALoosening(p.request, ctx) ?? escalate("NEEDS_OFFICER", "LOOSEN_NEEDS_BOTH_SIGS", p.request.kind);
}

/**
 * EXECUTE_LOOSEN (executeLoosen: anyone): QUEUED and now ≥ executableAt (else TimelockActive: unknown, executed and
 * cancelled ids too), now ≤ expiresAt (else SignatureExpired), then the kind's rules again at execution time.
 */
export function evaluateExecuteLoosen(p: ExecuteLoosenProposalIn, ctx: PolicyContext): PolicyDecision {
  if (p.origin.trust !== "trusted") return deny(TAINT_REASON.action);
  const now = nowOf(ctx);
  const q: PolicyQueuedLoosen | undefined = (ctx.loosens ?? []).find((x) => x.loosenId.toLowerCase() === p.loosenId.toLowerCase());
  if (!q || q.status !== "QUEUED" || now < big(q.executableAt)) return deny("TimelockActive");
  if (now > big(q.expiresAt)) return deny("SignatureExpired");
  return loosenRules(q.request, ctx) ?? allow("LOOSEN_EXECUTABLE");
}
