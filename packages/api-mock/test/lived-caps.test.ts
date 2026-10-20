/**
 * Every sample payment of the sample business (MOCK_SCENARIO=lived) walked through the signed plan's limits by a
 * checker of its own (not the mock's spend path): the per-payment cap, the 7-day window cap, the ads pacing, the pocket,
 * the payee binding, the released and funded total, the supplier's cooling and the delivery check. Any break fails.
 * The checker is first shown to catch forged breaks, so a pass means something.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMinor, type LineKey, type PlanManifest } from "@hogee/core";
import { readEnv } from "../src/env";
import { termsStore } from "../src/features/orders";
import { buildSampleBusiness } from "../src/scenario-lived/index";
import { currentPlan, getState, resetState, type MockState } from "../src/store";

const DAY = 86_400_000;

interface Paid {
  readonly id: string;
  readonly kind: "SPEND" | "OWNER_SPEND" | "FUND_MILESTONE" | "RELEASE_MILESTONE" | "WITHDRAW_RESERVE";
  readonly lineKey: LineKey | null;
  readonly payeeId: string;
  readonly amount: bigint;
  /** When the agent proposed it (its PROPOSAL trace). */
  readonly atMs: number;
}

interface Order {
  readonly supplierId: string;
  readonly coolingEndsAtMs: number;
  readonly held: { readonly amount: bigint; readonly evidence: boolean };
  readonly totalMinor: bigint;
}

interface Facts {
  readonly plan: PlanManifest;
  readonly committedAtMs: number;
  readonly fundedAtMs: number;
  readonly fundedMinor: bigint;
  readonly releasedMinor: bigint;
  /** ADD_PAYEE loosenings that executed: line, payee, when. */
  readonly addedPayees: readonly { readonly lineKey: LineKey; readonly payeeId: string; readonly atMs: number }[];
  readonly orders: readonly Order[];
  readonly payments: readonly Paid[];
}

const tsOf = (st: MockState, pred: (t: MockState["traces"][number]) => boolean): number => {
  const t = st.traces.find(pred);
  if (!t) throw new Error("trace not found");
  return Date.parse(t.ts);
};

function factsOf(st: MockState): Facts {
  const plan = currentPlan(st)?.manifest;
  if (!plan) throw new Error("no plan");
  const addedPayees = [...st.exceptions.values()].flatMap(({ exception: e }) =>
    e.kind === "ADD_PAYEE" && e.status === "EXECUTED"
      ? [{ lineKey: e.payload.lineKey, payeeId: e.payload.payeeId, atMs: tsOf(st, (t) => t.traceId === e.traceId && t.summary.startsWith("Timelock passed")) }]
      : [],
  );
  const orders = [...termsStore(st).values()].map((t) => {
    const schedule = st.escrow.get(t.orderId ?? "") ?? [];
    const held = schedule.find((m) => !m.autoRelease);
    return { supplierId: t.supplierId, coolingEndsAtMs: t.coolingEndsAtMs ?? Infinity, held: { amount: parseMinor(held?.amountMinor ?? "0"), evidence: held?.evidenceHash !== undefined }, totalMinor: parseMinor(t.totalMinor) };
  });
  const payments = st.payments.map((sp) => ({
    id: sp.payment.paymentId,
    kind: sp.payment.kind,
    lineKey: sp.payment.lineKey,
    payeeId: sp.payment.payeeId,
    amount: parseMinor(sp.payment.amountMinor),
    atMs: tsOf(st, (t) => t.traceId === sp.payment.traceId && t.kind === "PROPOSAL"),
  }));
  return {
    plan,
    committedAtMs: tsOf(st, (t) => t.kind === "SIGNATURE" && t.summary.includes("(PlanApproval)")),
    fundedAtMs: tsOf(st, (t) => t.actor === "officer" && t.summary === "Loan officer funded the facility"),
    fundedMinor: parseMinor(st.balances.fundedMinor),
    releasedMinor: parseMinor(st.balances.releasedMinor),
    addedPayees,
    orders,
    payments: payments.sort((a, b) => a.atMs - b.atMs),
  };
}

/** Every rule a payment breaks, as "<payment>: <rule>". */
export function capBreaks(f: Facts): string[] {
  const out: string[] = [];
  const byLine = new Map<LineKey, Paid[]>();
  let outflow = 0n;
  for (const p of f.payments) {
    const line = f.plan.lines.find((l) => l.lineKey === p.lineKey);
    const fail = (rule: string) => out.push(`${p.id} (${p.kind} ${p.lineKey} ${p.amount}): ${rule}`);
    if (p.atMs <= f.committedAtMs || p.atMs <= f.fundedAtMs) fail("before the plan was signed and funded");
    if (!line) {
      fail("no such pocket in the plan");
      continue;
    }
    const earlier = byLine.get(line.lineKey) ?? [];
    if (p.kind === "SPEND" || p.kind === "OWNER_SPEND") {
      if (line.escrowOnly) fail("an escrow-only pocket paid directly");
      const bound = line.payeeIds.includes(p.payeeId) || f.addedPayees.some((a) => a.lineKey === line.lineKey && a.payeeId === p.payeeId && a.atMs < p.atMs);
      if (!bound) fail("payee not bound to the pocket");
      if (p.amount > parseMinor(line.perTxCapMinor)) fail("over the per-payment cap");
      if (line.pacing) {
        if (p.amount > parseMinor(line.pacing.amountMinor)) fail("over the pacing slot");
        const day = Math.floor(p.atMs / DAY);
        if (earlier.some((e) => Math.floor(e.atMs / DAY) === day)) fail("a second paced payment the same day");
      }
      const windowMs = Number(line.windowSeconds) * 1000;
      const inWindow = [...earlier, p].filter((e) => e.atMs > p.atMs - windowMs && (e.kind === "SPEND" || e.kind === "OWNER_SPEND")).reduce((s, e) => s + e.amount, 0n);
      if (inWindow > parseMinor(line.windowCapMinor)) fail("over the 7-day window cap");
      outflow += p.amount;
    } else if (p.kind === "FUND_MILESTONE" || p.kind === "RELEASE_MILESTONE") {
      if (!line.escrowOnly) fail("a milestone outside the escrow-only pocket");
      const order = f.orders.find((o) => o.supplierId === p.payeeId);
      if (!order) fail("no signed order for this supplier");
      else {
        if (p.atMs < order.coolingEndsAtMs) fail("paid before the supplier's cooling ended");
        if (order.totalMinor > parseMinor(line.windowCapMinor)) fail("an order over the 7-day window cap");
        if (p.kind === "RELEASE_MILESTONE" && (!order.held.evidence || p.amount !== order.held.amount)) fail("a balance released without its delivery check");
      }
      if (p.amount > parseMinor(line.perTxCapMinor)) fail("a milestone over the per-payment cap");
      if (p.kind === "FUND_MILESTONE") outflow += p.amount;
    } else fail("a payment kind the sample business never makes");
    byLine.set(line.lineKey, [...earlier, p]);
    const lineTotal = [...earlier, p].filter((e) => e.kind !== "RELEASE_MILESTONE").reduce((s, e) => s + e.amount, 0n);
    if (lineTotal > parseMinor(line.amountMinor)) fail("over the pocket's budget");
    if (outflow > f.releasedMinor || outflow > f.fundedMinor) fail("over the released or funded total");
  }
  return out;
}

beforeEach(() => {
  vi.stubEnv("MOCK_SCENARIO", "lived");
  vi.stubEnv("DEMO_TIMELOCK_SECONDS", "120");
  resetState(readEnv());
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetState(readEnv());
});

async function sample(): Promise<MockState> {
  const st = getState(readEnv());
  await buildSampleBusiness(st, readEnv(), Date.now() - 60_000);
  return st;
}

describe("every sample payment obeys the signed plan", () => {
  it("the checker catches forged breaks (so a pass means something)", { timeout: 30_000 }, async () => {
    const f = factsOf(await sample());
    const ads = f.payments.find((p) => p.lineKey === "ADS");
    const packaging = f.payments.find((p) => p.lineKey === "PACKAGING");
    const deposit = f.payments.find((p) => p.kind === "FUND_MILESTONE");
    if (!ads || !packaging || !deposit) throw new Error("the sample lost a pocket");
    const forged = (p: Paid): Facts => ({ ...f, payments: [...f.payments, p].sort((a, b) => a.atMs - b.atMs) });
    expect(capBreaks(forged({ ...packaging, id: "forged-cap", amount: 37_501n }))).toEqual([expect.stringMatching(/forged-cap.*over the per-payment cap/)]);
    expect(capBreaks(forged({ ...ads, id: "forged-pace", atMs: ads.atMs + 60_000 })).join()).toMatch(/forged-pace.*a second paced payment the same day/);
    expect(capBreaks(forged({ ...packaging, id: "forged-payee", payeeId: "someone-else" })).join()).toMatch(/forged-payee.*payee not bound/);
    expect(capBreaks(forged({ ...deposit, id: "forged-cooling", atMs: f.committedAtMs + 1 })).join()).toMatch(/forged-cooling.*cooling/);
    const window = [1, 2].map((i) => ({ ...packaging, id: `forged-window-${i}`, amount: 30_000n, atMs: packaging.atMs + i * 3_600_000 }));
    expect(capBreaks({ ...f, payments: [...f.payments, ...window].sort((a, b) => a.atMs - b.atMs) }).join()).toMatch(/forged-window-2.*over the 7-day window cap/);
    expect(capBreaks({ ...f, releasedMinor: 100_000n }).join()).toMatch(/over the released or funded total/);
  });

  it("no sample payment breaks a cap, the pacing, a binding, the released total or the delivery check", { timeout: 30_000 }, async () => {
    const st = await sample();
    const f = factsOf(st);
    expect(f.payments.length).toBeGreaterThan(20);
    expect(capBreaks(f)).toEqual([]);
    // The ledger the walk ends in: no pocket over its window or budget, none below zero.
    for (const p of st.balances.pockets) {
      expect(parseMinor(p.windowSpent), p.lineKey).toBeLessThanOrEqual(parseMinor(p.windowCap));
      expect(parseMinor(p.spent), p.lineKey).toBeLessThanOrEqual(parseMinor(p.allocated));
      expect(parseMinor(p.available), p.lineKey).toBeGreaterThanOrEqual(0n);
    }
  });
});
