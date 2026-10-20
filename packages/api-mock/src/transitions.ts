/**
 * Scripted, time-based transitions (project.md §26.7), applied lazily on each request: no timers, so the mock
 * survives hot reloads and serverless-style handlers. Only records the mock created move; seeded ones stay put.
 */
import { isWebSupplierId, parseMinor, type LineKey, type Payment, type PaymentState, type PlanLine, type PolicyVerdict } from "@hogee/core";
import {
  addMinor,
  appendTrace,
  currentPlan,
  mockHash,
  mockNow,
  nextId,
  nowIso,
  nowUnix,
  pocketOf,
  updatePocket,
  uuidV7,
  type MockState,
  type ScriptedPayment,
} from "./store";
import { isAgentPayment } from "./autonomy";
import { applyExceptionEffects } from "./effects";
import { outflowRefusal, reserveWithdrawalRefusal } from "./spend-policy";

/** PROPOSED → SETTLED over ~6 s (§26.7). */
export const SETTLE_PATH: readonly PaymentState[] = [
  "PROPOSED",
  "POLICY_OK",
  "SIGNED",
  "BROADCAST",
  "INCLUDED",
  "FINALIZED",
  "SETTLEMENT_REQUESTED",
  "SETTLED",
];
/** A held escrow milestone's funding (FUND_MILESTONE without autoRelease): mined and final, with no payout (live settle-spend opens none). */
export const ESCROW_PATH: readonly PaymentState[] = SETTLE_PATH.slice(0, SETTLE_PATH.indexOf("FINALIZED") + 1);
/** What a web supplier's payout reads (VISION-DECISIONS §9: a MOCK_ONLY account), in either country: "Sample", the app's one word. */
const SIMULATED_PAYOUT_SUMMARY = "Sample payout succeeded: no real bank transfer to this web supplier; settlement confirmed on-chain";
/** Time between two states of a scripted payment (the scenario builder ticks at each one). */
export const STEP_MS = 850;
/** The executor picks up a matured loosening this long after it becomes executable (timelock-executor job). */
const EXECUTOR_DELAY_MS = 3_000;
/** Demo autonomy loop: one agent spend per tick while running. */
const AUTONOMY_TICK_MS = 9_000;
const AUTONOMY_LINES: readonly LineKey[] = ["ADS", "LOGISTICS", "PLATFORM_FEES"];

export interface NewPayment {
  readonly kind: Payment["kind"];
  readonly lineKey: LineKey | null;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly invoiceHash?: string;
  readonly reason: string;
  /** Who let this payment through, when it was not the agent's own spend inside the signed plan. */
  readonly policy?: { readonly verdict: PolicyVerdict; readonly reasonCode: string; readonly summary: string };
  /** The states it walks (default SETTLE_PATH). */
  readonly path?: readonly PaymentState[];
  /**
   * RELEASE_MILESTONE only: the milestone was not funded yet (the mock's catalog balance release funds and releases in
   * one step), so mining it also does what the chain's fundMilestone would: the pocket moves into escrow.
   */
  readonly fundsEscrow?: boolean;
}

const WITHIN_PLAN = {
  verdict: "AUTO",
  reasonCode: "WITHIN_PLAN",
  summary: "Within the signed plan: bound payee, under the per-transaction and window caps",
} as const satisfies NewPayment["policy"];

/**
 * Budget units of a line already promised to payments that are not mined yet. Caps are checked against
 * windowSpent + in-flight, like core's projectInFlight, so rapid proposals can't overspend before the first lands.
 */
export function inFlightMinor(st: MockState, lineKey: LineKey): bigint {
  return st.payments
    .filter((sp) => sp.script && sp.payment.lineKey === lineKey && !sp.applied.has("INCLUDED") && sp.payment.kind !== "FUND_MILESTONE")
    .reduce((sum, sp) => sum + parseMinor(sp.payment.amountMinor), 0n);
}

/** Creates a payment the mock will walk to SETTLED, with its proposal and policy trace events. */
export function createScriptedPayment(st: MockState, input: NewPayment, nowMs = mockNow()): ScriptedPayment {
  const paymentId = nextId(st, "pay");
  const traceId = nextId(st, "trace");
  const agentKind = input.kind !== "OWNER_SPEND" && input.kind !== "WITHDRAW_RESERVE";
  const decisionId = agentKind ? uuidV7(st, nowMs) : null;
  const planVersion = currentPlan(st)?.manifest.version ?? 1;
  const payment: Payment = {
    paymentId,
    kind: input.kind,
    intentId: mockHash(`intent:${paymentId}`),
    lineKey: input.lineKey,
    payeeId: input.payeeId,
    amountMinor: input.amountMinor,
    invoiceHash: (input.invoiceHash ?? mockHash(`invoice:${paymentId}`)) as Payment["invoiceHash"],
    planVersion,
    state: "PROPOSED",
    payout: { attempt: 0, status: "NONE" },
    decisionId,
    rationaleHash: agentKind ? mockHash(`rationale:${paymentId}`) : null,
    traceId,
    updatedAt: nowIso(nowMs),
  };
  const refs = { planVersion, paymentId, ...(decisionId ? { decisionId } : {}) };
  appendTrace(st, { traceId, actor: "planner", kind: "PROPOSAL", summary: input.reason, refs, ts: nowIso(nowMs) });
  const policy = input.policy ?? WITHIN_PLAN;
  appendTrace(st, { traceId, actor: "policy", kind: "POLICY_VERDICT", summary: policy.summary, verdict: policy.verdict, reasonCode: policy.reasonCode, refs, ts: nowIso(nowMs) });
  const scripted: ScriptedPayment = {
    payment,
    script: { startMs: nowMs, stepMs: STEP_MS, path: input.path ?? SETTLE_PATH, ...(input.fundsEscrow ? { fundsEscrow: true } : {}) },
    applied: new Set<PaymentState>(["PROPOSED"]),
  };
  st.payments.unshift(scripted);
  // An AI payment only when the agent decided it by itself: the founder's MilestoneRelease carries a decision id too (W-4).
  if (isAgentPayment(payment)) st.autonomy = { ...st.autonomy, agentTxs: st.autonomy.agentTxs + 1 };
  return scripted;
}

function applyPaymentStep(st: MockState, sp: ScriptedPayment, state: PaymentState, atMs: number): void {
  const p = sp.payment;
  const amount = parseMinor(p.amountMinor);
  const refs = { planVersion: p.planVersion, paymentId: p.paymentId, ...(p.decisionId ? { decisionId: p.decisionId } : {}) };
  let next: Payment = { ...p, state, updatedAt: nowIso(atMs) };
  if (state === "BROADCAST") {
    next = { ...next, txHash: mockHash(`tx:${p.paymentId}`) };
    appendTrace(st, { traceId: p.traceId, actor: "worker", kind: "TX", summary: "Signed and broadcast by the worker", refs: { ...refs, txHash: next.txHash }, ts: nowIso(atMs) });
    if (st.crashArmed) {
      st.crashArmed = false;
      appendTrace(st, {
        traceId: p.traceId,
        actor: "reconciler",
        kind: "ALERT",
        summary: "Worker stopped right after broadcast; on restart it found the intent already used on-chain and sent no second transaction",
        reasonCode: "RECOVERED_NO_RESEND",
        refs: { ...refs, txHash: next.txHash },
        ts: nowIso(atMs),
      });
    }
  }
  if (state === "INCLUDED") {
    st.blockBase += 1;
    next = { ...next, block: st.blockBase };
    applyLedger(st, p, amount, sp.script?.fundsEscrow === true);
  }
  // A web supplier (MOCK_ONLY account) is always paid on the simulated rail, never with the country's rail wording.
  const simulated = isWebSupplierId(p.payeeId);
  if (state === "SETTLEMENT_REQUESTED") {
    // SG-DECISIONS rail: Mei's payees are paid by the worker's MockRail ("simulated PayNow payout"), Rina's by Xendit test mode.
    next = { ...next, payout: { payoutId: nextId(st, simulated ? "simulated-payout" : st.profile.payout.idPrefix), attempt: 0, status: "REQUESTED" } };
  }
  if (state === "SETTLED") {
    next = { ...next, payout: { ...next.payout, status: "SUCCEEDED" } };
    appendTrace(st, {
      traceId: p.traceId,
      actor: "worker",
      kind: "PAYOUT",
      summary: simulated ? SIMULATED_PAYOUT_SUMMARY : st.profile.payout.settledSummary,
      refs: { ...refs, ...(next.txHash ? { txHash: next.txHash } : {}), ...(next.payout.payoutId ? { payoutId: next.payout.payoutId } : {}) },
      ts: nowIso(atMs),
    });
  }
  sp.payment = next;
  sp.applied.add(state);
}

/** The chain's escrowFund: the line's pocket moves into escrow (Treasury.pocket availableMinor drops, escrowedMinor grows). */
function fundEscrow(st: MockState, lineKey: LineKey, amount: bigint): void {
  updatePocket(st, lineKey, (k) => ({ ...k, available: addMinor(k.available, -amount) }));
  st.balances = { ...st.balances, escrowMinor: addMinor(st.balances.escrowMinor, amount) };
}

/**
 * Moves budget units when a payment is mined (INCLUDED), exactly as the chain does. Escrow funding moves the pocket
 * into escrow (auto-release or held alike); a milestone paid out (auto-released, or the founder's release) STAYS in
 * escrowMinor and never enters the pocket's spent: Treasury.escrowRelease only counts the payee's paid amount. What
 * escrow has paid out is the CFO report's supplier cost (core walletFigures puts the two together for the wallet).
 */
function applyLedger(st: MockState, p: Payment, amount: bigint, fundsEscrow: boolean): void {
  if (p.kind === "FUND_MILESTONE" && p.lineKey) {
    fundEscrow(st, p.lineKey, amount);
  } else if (p.kind === "RELEASE_MILESTONE" && p.lineKey) {
    if (fundsEscrow) fundEscrow(st, p.lineKey, amount);
  } else if (p.kind === "WITHDRAW_RESERVE") {
    st.balances = { ...st.balances, reserveMinor: addMinor(st.balances.reserveMinor, -amount) };
  } else if (p.lineKey) {
    updatePocket(st, p.lineKey, (k) => ({
      ...k,
      spent: addMinor(k.spent, amount),
      available: addMinor(k.available, -amount),
      windowSpent: addMinor(k.windowSpent, amount),
    }));
  }
}

function advancePayments(st: MockState, nowMs: number): void {
  // Oldest first, so ledger effects land in the order the payments were made.
  for (const sp of [...st.payments].reverse()) {
    if (!sp.script) continue;
    const { startMs, stepMs, path } = sp.script;
    const target = Math.min(path.length - 1, Math.floor((nowMs - startMs) / stepMs));
    for (let i = 1; i <= target; i += 1) {
      const step = path[i];
      if (step && !sp.applied.has(step)) applyPaymentStep(st, sp, step, startMs + i * stepMs);
    }
  }
}

function advanceExceptions(st: MockState, nowMs: number): void {
  const now = BigInt(nowUnix(nowMs));
  for (const se of st.exceptions.values()) {
    const e = se.exception;
    if (!se.queuedByMock || !e.timelock) continue;
    const executableAt = BigInt(e.timelock.executableAt);
    if (e.status === "QUEUED" && now >= executableAt) se.exception = { ...e, status: "EXECUTABLE" };
    if (se.exception.status === "EXECUTABLE" && nowMs >= Number(executableAt) * 1000 + EXECUTOR_DELAY_MS) {
      // executeLoosen re-runs the loosening's checks; a reverted execute leaves it EXECUTABLE.
      const refusal = e.kind === "WITHDRAW_RESERVE" ? reserveWithdrawalRefusal(st, e.payload.taxPayeeId, e.payload.amountMinor) : undefined;
      if (refusal) {
        if (!se.executeRefused) {
          se.executeRefused = true;
          appendTrace(st, {
            traceId: e.traceId,
            actor: "worker",
            kind: "DENIAL",
            summary: `Not executed: ${refusal.summary}`,
            verdict: "DENY",
            reasonCode: refusal.reasonCode,
            refs: { exceptionId: e.exceptionId },
            ts: nowIso(nowMs),
          });
        }
        continue;
      }
      se.exception = { ...se.exception, status: "EXECUTED", txs: { ...se.exception.txs, execute: mockHash(`tx:execute:${e.exceptionId}`) } };
      applyExceptionEffects(st, se.exception);
      appendTrace(st, {
        traceId: e.traceId,
        actor: "worker",
        kind: "TX",
        summary: `Timelock passed; executed "${e.title}"`,
        refs: { exceptionId: e.exceptionId, ...(se.exception.txs.execute ? { txHash: se.exception.txs.execute } : {}) },
        ts: nowIso(nowMs),
      });
    }
  }
}

function advanceShortlists(st: MockState, nowMs: number): void {
  for (const job of st.shortlists.values()) {
    if (job.readyAtMs !== undefined && job.shortlist.status === "PENDING" && nowMs >= job.readyAtMs) {
      const seeded = st.loaded.scenario["shortlist.json"];
      job.shortlist = {
        ...seeded,
        requestId: job.shortlist.requestId,
        status: "READY",
        rankStabilityPct: seeded.rankStabilityPct ?? 0,
        shortlistHash: seeded.shortlistHash ?? mockHash(`shortlist:${job.shortlist.requestId}`),
        failureReason: null, // G2: the mock's shortlists never fail; a FAILED fixture's reason must not ride along
      };
    }
  }
}

/** Demo autonomy loop: while running, the agent pays one pacing or logistics slot per tick, inside its caps and the released total. */
function tickAutonomy(st: MockState, nowMs: number): void {
  if (!st.autonomy.running || st.balances.paused) return;
  if (nowMs - st.autonomy.lastTickMs < AUTONOMY_TICK_MS) return;
  st.autonomy = { ...st.autonomy, lastTickMs: nowMs, pacingSlot: st.autonomy.pacingSlot + 1 };
  const manifest = currentPlan(st)?.manifest;
  const lineKey = AUTONOMY_LINES[st.autonomy.pacingSlot % AUTONOMY_LINES.length] ?? "ADS";
  const line: PlanLine | undefined = manifest?.lines.find((l) => l.lineKey === lineKey);
  const pocket = pocketOf(st, lineKey);
  if (!line || !pocket || pocket.paused || pocket.circuitOpen) return;
  const amount = line.pacing ? parseMinor(line.pacing.amountMinor) : parseMinor(line.perTxCapMinor) / 4n;
  // Skip (never deny) a slot the window or the pocket cannot hold, counting payments still in flight (G0-DECISIONS §1 #1).
  const inFlight = inFlightMinor(st, lineKey);
  if (parseMinor(pocket.windowSpent) + inFlight + amount > parseMinor(pocket.windowCap) || inFlight + amount > parseMinor(pocket.available)) return;
  // Nor one the released and funded total cannot hold (Treasury.spend's outflow bound).
  if (outflowRefusal(st, amount.toString())) return;
  const payeeId = line.payeeIds[0];
  const intent = `${lineKey}:slot:${st.autonomy.pacingSlot}`;
  if (!payeeId || st.usedIntents.has(intent)) return;
  st.usedIntents.add(intent);
  createScriptedPayment(
    st,
    { kind: "SPEND", lineKey, payeeId, amountMinor: amount.toString(), reason: `Autonomous ${lineKey.toLowerCase()} spend for slot ${st.autonomy.pacingSlot}, from the signed plan's pacing` },
    nowMs,
  );
}

export function advance(st: MockState, nowMs = mockNow()): void {
  tickAutonomy(st, nowMs);
  advancePayments(st, nowMs);
  advanceExceptions(st, nowMs);
  advanceShortlists(st, nowMs);
}
