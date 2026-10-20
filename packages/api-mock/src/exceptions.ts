/**
 * Exception console operations (project.md §4 step 10, §26.5): create, approve (officer or founder branch),
 * deny, veto, and the founder-signature → officer-approval → timelock sequence for loosenings.
 */
import {
  TIMELOCK_EXCEPTION_KINDS,
  formatBu,
  parseMinor,
  type ChainAction,
  type Exception,
  type ExceptionCreate,
  type ExceptionKind,
  type ExceptionRequester,
  type SignatureKind,
} from "@hogee/core";
import { appendTrace, founderKeyFor, mockHash, mockNow, nextId, nowUnix, pocketOf, type MockState, type ScriptedException, type SignedFounderSig } from "./store";
import { applyExceptionEffects } from "./effects";
import { reserveWithdrawalRefusal, spendRefusal } from "./spend-policy";
import { demoPayoutHash } from "./payees";
import type { Failure } from "./result";

const isTimelockKind = (kind: ExceptionKind): boolean => (TIMELOCK_EXCEPTION_KINDS as readonly string[]).includes(kind);
const OPEN_STATUSES: readonly Exception["status"][] = ["OPEN", "FOUNDER_SIGNED", "APPROVED"];

function titleOf(req: ExceptionCreate): string {
  switch (req.kind) {
    case "RAISE_CAP":
      return `Raise the ${req.payload.lineKey} ${req.payload.cap === "perTx" ? "per-payment" : "7-day"} cap to ${formatBu(req.payload.newCapMinor)}`;
    case "ADD_PAYEE":
      return `Add payee ${req.payload.payeeId} to ${req.payload.lineKey}`;
    case "EXTEND_EXPIRY":
      return req.payload.target === "agent" ? "Extend the agent key" : `Extend the ${req.payload.lineKey} pocket`;
    case "MOVE_POCKETS":
      return `Move ${formatBu(req.payload.amountMinor)} from ${req.payload.fromLineKey} to ${req.payload.toLineKey}`;
    case "UNPAUSE":
      return req.payload.lineKey ? `Unpause the ${req.payload.lineKey} pocket` : "Unpause the treasury";
    case "WITHDRAW_RESERVE":
      return `Withdraw ${formatBu(req.payload.amountMinor)} of the tax reserve`;
    case "RELEASE_ESCROW_BALANCE":
      return "Release the supplier's escrow balance";
    case "RELEASE_STAGE":
      return `Release ${req.payload.stageId}`;
    case "REPLAN":
      return "Replace the plan with a tighter version";
  }
}

/** Extra budget units the agent could move alone once this change executes (0 for tightenings and releases). */
function blastRadiusOf(st: MockState, req: ExceptionCreate): string {
  if (req.kind === "RAISE_CAP") {
    const pocket = pocketOf(st, req.payload.lineKey);
    const old = parseMinor(req.payload.cap === "perTx" ? (pocket?.perTxCap ?? "0") : (pocket?.windowCap ?? "0"));
    const next = parseMinor(req.payload.newCapMinor);
    return (next > old ? next - old : 0n).toString();
  }
  if (req.kind === "MOVE_POCKETS" || req.kind === "WITHDRAW_RESERVE") return req.payload.amountMinor;
  return "0";
}

function requiresOf(kind: ExceptionKind): Exception["requires"] {
  if (kind === "RELEASE_STAGE" || kind === "POLICY_ESCALATION") return { founder: false, lender: true };
  if (kind === "RELEASE_ESCROW_BALANCE" || kind === "REPLAN") return { founder: true, lender: false };
  return { founder: true, lender: true };
}

/**
 * Why a RELEASE_ESCROW_BALANCE may not be opened: its milestone must wait for the founder's release (not automatic,
 * not released) and carry a recorded inspection whose hash is the request's check code, which is what the release
 * signs (signing.ts milestoneRelease). Same CONFLICT reasons as live (api exception-create; run-10 re-check H-4).
 */
function balanceRequestRefusal(st: MockState, p: Extract<ExceptionCreate, { kind: "RELEASE_ESCROW_BALANCE" }>["payload"]): Failure | undefined {
  const m = st.escrow.get(p.orderId)?.find((x) => x.idx === p.idx);
  if (!m) return { code: "CONFLICT", message: "No such escrow milestone" };
  if (m.autoRelease || m.released) return { code: "CONFLICT", message: "That milestone is not funded and waiting for release" };
  if (!m.evidenceHash) return { code: "CONFLICT", message: "Upload the inspection evidence first" };
  if (m.evidenceHash.toLowerCase() !== p.evidenceHash.toLowerCase()) {
    return { code: "CONFLICT", message: "The delivery check code does not match the inspection evidence recorded for that milestone" };
  }
  return undefined;
}

/** Sent by apps/mcp on every call; it can only lower a request's requester to "agent". */
export const REQUESTER_HEADER = "x-hogee-requester";

/** Who opened a request over POST /api/exceptions: the founder, or the agent through the MCP server. */
export type ExceptionRequesterOf = Extract<ExceptionRequester, "founder" | "agent">;

export function createException(st: MockState, req: ExceptionCreate, requestedBy: ExceptionRequesterOf = "founder"): Exception | Failure {
  // A caller-built escalation would let any request name its own payee and amount (D6). Only the server's spend
  // path opens one, from a proposal it derived itself.
  // G2: ExceptionCreate no longer admits it (422 from the schema); kept as defence in depth.
  if ((req.kind as ExceptionKind) === "POLICY_ESCALATION") {
    return { code: "VALIDATION", message: "A policy escalation is opened only by the server's own spend path, never by a request" };
  }
  // As live (api services/loosen.ts): only a payee the demo onboarded (payees.ts) can be added, never another demo's.
  if (req.kind === "ADD_PAYEE" && !demoPayoutHash(st.profile.country, req.payload.payeeId)) {
    return { code: "CONFLICT", message: "Only an onboarded payee can be added to a line" };
  }
  if (req.kind === "WITHDRAW_RESERVE") {
    const refusal = reserveWithdrawalRefusal(st, req.payload.taxPayeeId, req.payload.amountMinor);
    if (refusal) {
      return { code: refusal.reasonCode === "PayeeNotBound" ? "VALIDATION" : "CONFLICT", message: `Not requested: ${refusal.summary}`, contractError: { name: refusal.reasonCode } };
    }
  }
  if (req.kind === "RELEASE_ESCROW_BALANCE") {
    const refusal = balanceRequestRefusal(st, req.payload);
    if (refusal) return refusal;
  }
  const exceptionId = nextId(st, "exc");
  const traceId = nextId(st, "trace");
  const exception = {
    exceptionId,
    kind: req.kind,
    payload: req.payload,
    title: titleOf(req),
    requestedBy,
    requires: requiresOf(req.kind),
    status: "OPEN",
    timelock: null,
    txs: {},
    blastRadiusMinor: blastRadiusOf(st, req),
    traceId,
  } as Exception;
  st.exceptions.set(exceptionId, { exception });
  const who = requestedBy === "agent" ? "The agent (via MCP) asked" : "Founder asked";
  appendTrace(st, { traceId, actor: requestedBy === "agent" ? "planner" : "founder", kind: "EXCEPTION", summary: `${who}: ${exception.title}. Reason: ${req.reason}`, refs: { exceptionId } });
  return exception;
}

/** Queues a fully signed loosening behind the timelock (Treasury.queueLoosen). */
export function queueLoosen(st: MockState, se: ScriptedException, timelockSeconds: number, nowMs = mockNow()): void {
  const queuedAt = nowUnix(nowMs);
  se.exception = {
    ...se.exception,
    status: "QUEUED",
    timelock: { queuedAt, executableAt: String(Number(queuedAt) + timelockSeconds) },
    txs: { ...se.exception.txs, queue: mockHash(`tx:queue:${se.exception.exceptionId}`) },
  };
  se.queuedByMock = true;
  appendTrace(st, {
    traceId: se.exception.traceId,
    actor: "worker",
    kind: "TX",
    summary: `Queued behind a ${timelockSeconds} s waiting time (demo); the founder or the loan officer can cancel it until it ends`,
    refs: { exceptionId: se.exception.exceptionId, ...(se.exception.txs.queue ? { txHash: se.exception.txs.queue } : {}) },
  });
}

/**
 * Why the founder's LoosenRequest signature must not be accepted now, if it would queue a loosening Treasury.queueLoosen
 * refuses: a WITHDRAW_RESERVE the officer already approved is re-checked against the reserve, as queueLoosen checks it
 * when the founder's signature completes the pair (#6 LOW 5). Fails closed: nothing is signed, traced or queued, and
 * the founder sees the chain's reason. Execution re-checks it again either way.
 */
export function founderSignRefusal(st: MockState, exceptionId: string): Failure | undefined {
  const e = st.exceptions.get(exceptionId)?.exception;
  if (!e || e.kind !== "WITHDRAW_RESERVE" || e.status !== "APPROVED") return undefined;
  const refusal = reserveWithdrawalRefusal(st, e.payload.taxPayeeId, e.payload.amountMinor);
  if (!refusal) return undefined;
  return { code: refusal.reasonCode, message: `Not queued: ${refusal.summary}`, contractError: { name: refusal.reasonCode }, traceId: e.traceId };
}

/**
 * The founder signed the LoosenRequest: queue it if the officer already approved, else wait for the officer with the
 * verified signer recorded (store.ts FounderSig). Signing again while it waits replaces the record.
 */
export function founderSigned(st: MockState, exceptionId: string, timelockSeconds: number, signer: SignedFounderSig): void {
  const se = st.exceptions.get(exceptionId);
  if (!se) return;
  if (se.exception.status === "APPROVED") queueLoosen(st, se, timelockSeconds);
  else if (se.exception.status === "OPEN" || se.exception.status === "FOUNDER_SIGNED") {
    se.exception = { ...se.exception, status: "FOUNDER_SIGNED" };
    se.founderSig = signer;
  }
}

/**
 * A FOUNDER_SIGNED loosening whose passkey no longer counts: the officer rejected it, or another key is now the
 * registered one (founderKeyFor). On-chain queueLoosen checks the founder's signature against the registered key and
 * would revert InvalidSignature, so the approval is refused. The stale signature is void: the request goes back to
 * OPEN, where the founder can sign it again with her key.
 * Only a passkey signer is re-checked. A wallet signer recovered to HOGEE_MOCK_OWNER_EOA when it signed. A
 * `seeded-fixture` row is the owner's status gallery (store.ts FounderSig): the officer approves it as any other
 * FOUNDER_SIGNED row, by design, since no request can create or edit a FOUNDER_SIGNED record.
 */
function staleFounderSignature(st: MockState, se: ScriptedException): Failure | undefined {
  const sig = se.founderSig;
  if (se.exception.status !== "FOUNDER_SIGNED" || sig?.kind !== "passkey" || founderKeyFor(st, sig.credentialId)) return undefined;
  const e = se.exception;
  se.exception = { ...e, status: "OPEN" };
  se.founderSig = undefined;
  const summary = "Not approved: the founder signed with a passkey that is no longer her key (rejected or replaced); she must sign again";
  appendTrace(st, { traceId: e.traceId, actor: "officer", kind: "EXCEPTION", summary, refs: { exceptionId: e.exceptionId } });
  return { code: "CONFLICT", message: summary, contractError: { name: "InvalidSignature" }, traceId: e.traceId };
}

/** Officer branch of POST /api/exceptions/:id/approve (the server signs with the demo lender key). */
export function officerApprove(st: MockState, se: ScriptedException, timelockSeconds: number): { exception: Exception; action?: ChainAction } | Failure {
  const e = se.exception;
  if (!OPEN_STATUSES.includes(e.status)) return { code: "CONFLICT", message: `Exception ${e.exceptionId} is ${e.status}` };
  const stale = staleFounderSignature(st, se);
  if (stale) return stale;
  if (e.kind === "WITHDRAW_RESERVE") {
    const refusal = reserveWithdrawalRefusal(st, e.payload.taxPayeeId, e.payload.amountMinor);
    if (refusal) return { code: "CONFLICT", message: `Not approved: ${refusal.summary}`, contractError: { name: refusal.reasonCode }, traceId: e.traceId };
  }
  appendTrace(st, { traceId: e.traceId, actor: "officer", kind: "SIGNATURE", summary: "Loan officer approved (demo lender key, server-held)", refs: { exceptionId: e.exceptionId } });
  const action: ChainAction = { actionId: nextId(st, "act"), state: "BROADCAST", txHash: mockHash(`tx:approve:${e.exceptionId}:${st.counter}`) };
  if (isTimelockKind(e.kind)) {
    if (e.status === "FOUNDER_SIGNED" || !e.requires.founder) queueLoosen(st, se, timelockSeconds);
    else se.exception = { ...e, status: "APPROVED" };
    return { exception: se.exception, action };
  }
  if (e.kind === "POLICY_ESCALATION") {
    // The officer overrides a soft verdict, never the payee binding or the caps: re-check them now, as
    // Treasury.spend would, and leave the request open (the officer can still deny it) if they fail.
    const { lineKey, payeeId, amountMinor } = e.payload.proposal;
    const refusal = spendRefusal(st, lineKey, payeeId, amountMinor);
    if (refusal) {
      appendTrace(st, { traceId: e.traceId, actor: "policy", kind: "DENIAL", summary: `Not sent: ${refusal.summary}`, verdict: "DENY", reasonCode: refusal.reasonCode, refs: { exceptionId: e.exceptionId } });
      return { code: refusal.reasonCode, message: `Not sent: ${refusal.summary}`, contractError: { name: refusal.reasonCode }, traceId: e.traceId };
    }
  }
  if (e.kind === "RELEASE_STAGE" || e.kind === "POLICY_ESCALATION") {
    se.exception = { ...e, status: "EXECUTED", txs: { ...e.txs, execute: action.txHash } };
    applyExceptionEffects(st, se.exception);
    se.executedEffects = true;
    return { exception: se.exception, action };
  }
  // RELEASE_ESCROW_BALANCE and REPLAN complete with the founder's own signature.
  se.exception = { ...e, status: "APPROVED" };
  return { exception: se.exception };
}

/** Which signature the founder gives for an exception, and over which record. */
export function founderSignatureFor(e: Exception): { kind: SignatureKind; refId: string } | undefined {
  if (isTimelockKind(e.kind)) return { kind: "LoosenRequest", refId: e.exceptionId };
  if (e.kind === "RELEASE_ESCROW_BALANCE") return { kind: "MilestoneRelease", refId: e.payload.orderId };
  if (e.kind === "REPLAN") return { kind: "PlanApproval", refId: e.payload.draftId };
  return undefined;
}

export function denyException(st: MockState, se: ScriptedException, reason: string): Exception | Failure {
  const e = se.exception;
  if (!OPEN_STATUSES.includes(e.status)) return { code: "CONFLICT", message: `Exception ${e.exceptionId} is ${e.status}` };
  se.exception = { ...e, status: "DENIED" };
  appendTrace(st, { traceId: e.traceId, actor: "officer", kind: "EXCEPTION", summary: `Loan officer denied: ${reason}`, refs: { exceptionId: e.exceptionId } });
  return se.exception;
}

export function vetoException(st: MockState, se: ScriptedException, reason: string, by: "founder" | "officer"): Exception | Failure {
  const e = se.exception;
  if (e.status !== "QUEUED" && e.status !== "EXECUTABLE") return { code: "CONFLICT", message: `Only a queued change can be vetoed; ${e.exceptionId} is ${e.status}` };
  se.exception = { ...e, status: "CANCELLED" };
  appendTrace(st, { traceId: e.traceId, actor: by, kind: "EXCEPTION", summary: `Vetoed during the timelock: ${reason}`, refs: { exceptionId: e.exceptionId } });
  return se.exception;
}
