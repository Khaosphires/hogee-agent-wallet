/**
 * The sample business (MOCK_SCENARIO=lived; docs/decisions/ux2-demo-data.md): Mei about three weeks in, built from the
 * fresh store by the mock's own transitions. What it holds, that it is labelled and made up, that its numbers add up,
 * and that its chat runs the journey with a Next step pointing at the second order's delivery check.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NEXT_STEP_TEXT, bpsFloor, parseMinor, type ChatMessage } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { mockCfoReport } from "../src/features/cfo";
import { termsStore } from "../src/features/orders";
import { buildSampleBusiness, readyState } from "../src/scenario-lived/index";
import { FIRST_SALE_DAY, startOfUtcDay } from "../src/scenario-lived/story";
import { getState, resetState, usedSinceBuilt, type MockState } from "../src/store";
import { advance } from "../src/transitions";
import { harness, json, secret } from "./support/harness";

const h = harness(app);
const SESSION = "01a14202-2800-7000-8000-00000000a11e";
const DAY = 86_400_000;

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});
beforeEach(() => {
  vi.stubEnv("MOCK_SCENARIO", "lived");
  vi.stubEnv("DEMO_TIMELOCK_SECONDS", "10");
  resetState(readEnv());
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetState(readEnv());
});

/** A lived store built at `builtAtMs` (outside HTTP, so the build time is fixed). */
async function built(builtAtMs: number): Promise<MockState> {
  resetState(readEnv());
  const st = getState(readEnv());
  await buildSampleBusiness(st, readEnv(), builtAtMs);
  return st;
}

async function chatTurn(message: string): Promise<{ text: string; types: string[] }> {
  const res = await app.request("/api/chat", { ...json({ sessionId: SESSION, message }), headers: { "content-type": "application/json", cookie: await h.cookie("founder") } });
  const chunks = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as { type: string; delta?: string });
  return { text: chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join(""), types: chunks.map((c) => c.type).filter((t) => t.startsWith("data-")) };
}

describe("the sample business (MOCK_SCENARIO=lived)", () => {
  it("is Mei's plan signed and funded, with payments from every pocket and two supplier orders", { timeout: 30_000 }, async () => {
    const st = await readyState(readEnv());
    const draft = st.loaded.scenario["plan-draft.json"];
    expect(st.plans).toHaveLength(1);
    expect(st.plans[0]).toMatchObject({ status: "COMMITTED" });
    // Mei's real plan: the same lines, caps and stages as Mei's draft.
    expect(st.plans[0]?.manifest).toEqual(draft.manifest);
    expect(st.balances).toMatchObject({ fundedMinor: "1000000", releasedMinor: draft.manifest.stages[0]?.releaseMinor, paused: false });

    const lines = new Set(st.payments.map((sp) => sp.payment.lineKey));
    for (const line of ["SUPPLIER", "PACKAGING", "LOGISTICS", "ADS", "PLATFORM_FEES"]) expect(lines, line).toContain(line);
    for (const sp of st.payments) expect(["SETTLED", "FINALIZED"], `${sp.payment.paymentId} ${sp.payment.kind}`).toContain(sp.payment.state);
    expect(st.payments.filter((sp) => sp.payment.state === "FINALIZED").every((sp) => sp.payment.kind === "FUND_MILESTONE")).toBe(true);
    expect([...st.exceptions.values()].map((s) => [s.exception.kind, s.exception.status])).toEqual([["ADD_PAYEE", "EXECUTED"]]);

    const orders = [...termsStore(st).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(orders.map((t) => t.status)).toEqual(["USED", "USED"]);
    const [first, second] = orders.map((t) => st.escrow.get(t.orderId ?? "") ?? []);
    // The first: deposit and balance paid, the balance after a delivery check.
    expect(first?.every((m) => m.released)).toBe(true);
    expect(first?.find((m) => !m.autoRelease)?.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The second: deposit paid, the balance escrowed and waiting for its delivery check.
    expect(second?.map((m) => [m.autoRelease, m.released, m.funded === m.amountMinor, m.evidenceHash ?? null])).toEqual([
      [true, true, true, null],
      [false, false, true, null],
    ]);
  });

  it("sells on Shopee every day for three weeks, keeps tax at the plan's rate, and the CFO report agrees", { timeout: 30_000 }, async () => {
    const builtAtMs = Date.now() - 3_600_000;
    const st = await built(builtAtMs);
    const sales = st.sample?.sales ?? [];
    const rate = st.plans[0]?.manifest.reserveBps ?? 0;
    expect(rate).toBe(500);
    expect(sales.every((s) => /^sale-sample-\d+-\d+$/.test(s.saleId) && s.txHash === null && s.at.getTime() < builtAtMs)).toBe(true);
    const days = new Set(sales.map((s) => startOfUtcDay(s.at.getTime())));
    for (let d = FIRST_SALE_DAY; d < 0; d += 1) expect(days.has(startOfUtcDay(builtAtMs) + d * DAY), `day ${d}`).toBe(true);
    const revenue = sales.reduce((s, x) => s + x.amountMinor, 0n);
    const reserve = sales.reduce((s, x) => s + bpsFloor(x.amountMinor, rate), 0n);
    expect(st.balances.revenueMinor).toBe(revenue.toString());
    expect(st.balances.reserveMinor).toBe(reserve.toString());

    const report = mockCfoReport(st, builtAtMs);
    expect(report.sales.count).toBe(sales.length);
    expect(report.sales.revenueMinor).toBe(revenue.toString());
    expect(report.reserve.skimmedMinor).toBe(reserve.toString());
    // Ready to spend is what the released stage leaves after every payment and escrow (the wallet's figure).
    const outflow = st.balances.pockets.reduce((s, p) => s + parseMinor(p.spent), 0n) + parseMinor(st.balances.escrowMinor);
    expect(report.overview.cashAvailableMinor).toBe((parseMinor(st.balances.releasedMinor) - outflow).toString());
  });

  it("is the same business whenever it is built at the same time (deterministic per day)", { timeout: 30_000 }, async () => {
    const at = Date.now() - 7_200_000;
    const shape = (st: MockState) => ({
      balances: st.balances,
      payments: st.payments.map((sp) => [sp.payment.kind, sp.payment.lineKey, sp.payment.payeeId, sp.payment.amountMinor, sp.payment.state, sp.payment.updatedAt]),
      sales: st.sample?.sales.map((s) => [s.saleId, s.amountMinor, s.at.toISOString()]),
      traces: st.traces.map((t) => [t.ts, t.kind, t.summary]),
    });
    const a = shape(await built(at));
    expect(shape(await built(at))).toEqual(a);
  });

  it("keeps an activity record of all of it: one hash chain in time order, nothing after the build", { timeout: 30_000 }, async () => {
    const builtAtMs = Date.now() - 600_000;
    const st = await built(builtAtMs);
    for (const [i, t] of st.traces.entries()) {
      if (i > 0) expect(t.prevHash, `trace ${i}`).toBe(st.traces[i - 1]?.hash);
      if (i > 0) expect(t.ts >= (st.traces[i - 1]?.ts ?? ""), `trace ${i} ts`).toBe(true);
      expect(Date.parse(t.ts)).toBeLessThanOrEqual(builtAtMs);
    }
    for (const sp of st.payments) {
      const kinds = st.traces.filter((t) => t.traceId === sp.payment.traceId).map((t) => t.kind);
      expect(kinds.slice(0, 2), sp.payment.paymentId).toEqual(["PROPOSAL", "POLICY_VERDICT"]);
      expect(kinds).toContain("TX");
    }
    expect(st.traces.filter((t) => t.actor === "oracle")).toHaveLength(st.sample?.sales.length ?? -1);
    expect(st.traces.some((t) => t.kind === "TX" && t.summary.startsWith("Timelock passed"))).toBe(true);
  });

  it("is labelled and made up: no key signed it, no signature is stored, every proposal says Sample", { timeout: 30_000 }, async () => {
    const st = await readyState(readEnv());
    const signatures = st.traces.filter((t) => t.kind === "SIGNATURE" && t.actor === "founder");
    expect(signatures.map((t) => t.summary.match(/\((\w+)\)/)?.[1])).toEqual(["PlanApproval", "LoosenRequest", "SupplierApproval", "MilestoneRelease", "SupplierApproval"]);
    for (const t of signatures) expect(t.summary).toMatch(/^Sample history: .*no passkey signed it$/);
    expect(st.signatures.size).toBe(0);
    expect(st.founderKeys.size).toBe(0);
    expect([...st.exceptions.values()].every((s) => s.founderSig === undefined || s.founderSig.kind === "seeded-fixture")).toBe(true);
    for (const sp of st.payments.filter((p) => p.payment.kind === "SPEND")) {
      expect(st.traces.find((t) => t.traceId === sp.payment.traceId && t.kind === "PROPOSAL")?.summary).toMatch(/^Sample: /);
    }
    expect(st.sample?.sales.every((s) => s.saleId.startsWith("sale-sample-"))).toBe(true);
  });

  it("counts its autonomy from its own records, and the numbers add up", { timeout: 30_000 }, async () => {
    await readyState(readEnv());
    const st = getState(readEnv());
    const { body: stats } = await h.call<{ agentTxs: number; humanSigs: number; autoPct: number; escalatedPct: number; startedAt: string; hours: number }>("/api/stats/autonomy");
    // AI payments are the agent's own (SPEND, FUND_MILESTONE); Mei's MilestoneRelease is one of Mei's signatures (W-4).
    const agentKinds: readonly string[] = ["SPEND", "FUND_MILESTONE"];
    expect(st.payments.some((sp) => sp.payment.kind === "RELEASE_MILESTONE" && sp.payment.decisionId !== null)).toBe(true);
    expect(stats.agentTxs).toBe(st.payments.filter((sp) => sp.payment.decisionId !== null && agentKinds.includes(sp.payment.kind)).length);
    // Five founder signatures, the officer's co-signature on the packaging payee, and the officer's funding.
    expect(stats.humanSigs).toBe(7);
    expect(stats.autoPct + stats.escalatedPct).toBe(100);
    expect(stats.startedAt).toBe(new Date(st.sample?.commitAtMs ?? 0).toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(stats.hours).toBeGreaterThan(20 * 24);
  });

  it("starts a new chat with its history and runs the journey: Next is the second order's delivery check", { timeout: 30_000 }, async () => {
    const { status, body } = await h.call<ChatMessage[]>(`/api/chat/${SESSION}`);
    expect(status).toBe(200);
    expect(body.map((m) => [m.role, m.parts.map((p) => p.type)])).toEqual([
      ["assistant", ["text", "data-order"]],
      ["user", ["text", "data-action"]],
      ["assistant", ["text", "data-sign"]],
      ["user", ["text", "data-action"]],
      ["assistant", ["text", "data-order", "data-next"]],
    ]);
    expect(JSON.stringify(body[0])).toContain("sample business");
    // The presses are dated when Mei made them in the story (UUIDv7 time), a week before the build, not now.
    const actionIds = body.flatMap((m) => m.parts).flatMap((p) => (p.type === "data-action" ? [(p as { data: { action: { actionId: string } } }).data.action.actionId] : []));
    const pressedAt = actionIds.map((id) => parseInt(id.replace(/-/g, "").slice(0, 12), 16));
    expect(pressedAt).toHaveLength(2);
    for (const ms of pressedAt) expect(Date.now() - ms).toBeGreaterThan(6 * DAY);
    const st = getState(readEnv());
    expect(usedSinceBuilt(st)).toBe(false);

    // A quick question gets core's template, from the journey (not the canned script).
    const next = await chatTurn("what do I do now?");
    expect(next.text).toContain(`Next: ${NEXT_STEP_TEXT["in-transit"]}`);
    expect(next.types).toContain("data-order");
    expect(usedSinceBuilt(st)).toBe(true);

    // "How are we doing?" is the CFO card, as in the fresh journey.
    expect((await chatTurn("How are we doing?")).types).toContain("data-cfo");
  });

  it("the officer's Start the AI never pays past the released budget, and a proposal past it is refused", { timeout: 30_000 }, async () => {
    const st = await readyState(readEnv());
    const outflow = () => st.balances.pockets.reduce((s, p) => s + parseMinor(p.spent), 0n) + parseMinor(st.balances.escrowMinor);
    const released = parseMinor(st.balances.releasedMinor);
    const before = st.payments.length;
    expect((await h.call("/api/demo/autonomy/start", json({}), "officer")).status).toBe(200);
    const t0 = Date.now();
    for (let k = 1; k <= 60; k += 1) advance(st, t0 + k * 10_000);
    expect(st.payments.length).toBeGreaterThan(before);
    expect(outflow()).toBeLessThanOrEqual(released);
    expect(released - outflow()).toBeLessThan(7_500n);
    // Treasury.spend's outflow bound: the next pacing slot no longer fits the released stage.
    const { body } = await h.call<{ verdict: string; reasonCode: string }>("/api/proposals/spend", json({ lineKey: "ADS", pacingSlot: 999, reason: "One more ads slot" }));
    expect(body).toMatchObject({ verdict: "DENY", reasonCode: "CapExceeded" });
  });

  it("serves Mei in mock mode only: lived with REPLAY or for Malaysia fails closed", () => {
    vi.stubEnv("REPLAY", "final-1");
    expect(() => resetState(readEnv())).toThrow(/mock mode only/);
    vi.stubEnv("REPLAY", "");
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    expect(() => resetState(readEnv())).toThrow(/HOGEE_COUNTRY=SG/);
  });
});

describe("a payee an ADD_PAYEE loosening added (spend-policy.ts payeeBound)", () => {
  it("is bound to its line only once the loosening executed", { timeout: 30_000 }, async () => {
    const { payeeBound } = await import("../src/spend-policy");
    const st = await readyState(readEnv());
    const se = [...st.exceptions.values()].find((s) => s.exception.kind === "ADD_PAYEE");
    if (!se || se.exception.kind !== "ADD_PAYEE") throw new Error("no ADD_PAYEE in the sample");
    const { lineKey, payeeId } = se.exception.payload;
    expect(payeeBound(st, lineKey, payeeId)).toBe(true);
    expect(payeeBound(st, "LOGISTICS", payeeId)).toBe(false);
    se.exception = { ...se.exception, status: "QUEUED" };
    expect(payeeBound(st, lineKey, payeeId)).toBe(false);
  });
});
