/**
 * Mock CFO report (VISION-DECISIONS §5): GET /api/cfo through core buildCfoReport over the mock store, the same
 * function the live API uses (packages/api services/cfo.ts), so the numbers follow the same rules:
 *
 *   - lines: the store's pockets, with the plan's pacing and window; the supplier line carries the store's escrow;
 *   - payments: the store's payments dated by updatedAt, except milestone rows: supplier cost comes from the escrow map
 *     instead (each released milestone once, so a deposit the escrow paid automatically is cost, a funded milestone
 *     still held is not), dated by the payment that paid it for a web order (else now: the map holds no dates);
 *   - sales: once a plan is committed AND a supplier order exists (an escrow schedule: there is stock to sell; UX round
 *     3, Steve #6), a 14-day SAMPLE series ending yesterday (ids `sale-sample-<day>-<n>`, no tx; MOCK ONLY, the web
 *     labels it "Sample" in mock and replay mode), plus today's mock revenue (demo sales) as one sale. Before the
 *     first order there are no sample sales: a fresh start shows none while Mei has nothing to sell. The sample
 *     business (lived) has its own series instead, already recorded in the store's revenue and reserve
 *     (scenario-lived/), with the same ids and labels; a demo sale recorded since is today's one sale;
 *   - reserve: the plan's rate; set aside = the sample's skim + the store's reserve + withdrawals (lived: the store's
 *     reserve, which holds its series' skim, + withdrawals);
 *   - stage: the first unreleased stage (by the store's released total) with a salesMinor gate;
 *   - no agent actions: the mock runs no cfo-guard, and nothing is invented for it.
 */
import { bpsFloor, buildCfoReport, parseMinor, toCfoReportJson, type CfoInputs, type CfoLineIn, type CfoPaymentIn, type CfoReport, type CfoSaleIn, type Id, type PlanManifest } from "@hogee/core";
import type { Handlers } from "../http";
import { currentPlan, type MockState } from "../store";
import { milestonePayment, webTermsOfOrder } from "./orders";

const DAY_MS = 86_400_000;
export const SAMPLE_DAYS = 14;
/** Whole-BU sale amounts the sample cycles through (minor units; sales are bucketed to whole BU). */
const SAMPLE_AMOUNTS = [3_900n, 4_500n, 4_200n, 5_100n, 3_600n] as const;
const COUNTED_KINDS = new Set(["SPEND", "OWNER_SPEND", "WITHDRAW_RESERVE"]);

const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * The sample series: SAMPLE_DAYS days ending yesterday (UTC), 1 sale a day rising to 4, at 10:00, 12:00, … UTC.
 * Deterministic for a given day, so a page that polls sees the same history.
 */
export function sampleSales(nowMs: number): CfoSaleIn[] {
  const today = startOfUtcDay(nowMs);
  const out: CfoSaleIn[] = [];
  for (let k = 0; k < SAMPLE_DAYS; k += 1) {
    const day = today - (SAMPLE_DAYS - k) * DAY_MS;
    const count = 1 + Math.floor(k / 4);
    for (let j = 0; j < count; j += 1) {
      const amount = SAMPLE_AMOUNTS[(k * 2 + j) % SAMPLE_AMOUNTS.length] as bigint;
      out.push({ saleId: `sale-sample-${k + 1}-${j + 1}` as Id, amountMinor: amount, at: new Date(day + (10 + 2 * j) * 3_600_000), txHash: null });
    }
  }
  return out;
}

function linesOf(st: MockState, manifest: PlanManifest | undefined): CfoLineIn[] {
  const byKey = new Map((manifest?.lines ?? []).map((l) => [l.lineKey, l]));
  return st.balances.pockets.map((p) => {
    const line = byKey.get(p.lineKey);
    return {
      lineKey: p.lineKey,
      allocatedMinor: parseMinor(p.allocated),
      spentMinor: parseMinor(p.spent),
      escrowedMinor: p.lineKey === "SUPPLIER" ? parseMinor(st.balances.escrowMinor) : 0n,
      availableMinor: parseMinor(p.available),
      perTxCapMinor: parseMinor(p.perTxCap),
      windowCapMinor: parseMinor(p.windowCap),
      windowSpentMinor: parseMinor(p.windowSpent),
      validUntil: BigInt(p.validUntil),
      ...(line?.pacing ? { pacingMinor: parseMinor(line.pacing.amountMinor) } : {}),
      ...(line ? { windowSeconds: BigInt(line.windowSeconds) } : {}),
    };
  });
}

/** When a released milestone was paid: by the payment that paid it (a web order), else now (the escrow map holds no dates). */
function paidAt(st: MockState, orderId: string, m: { idx: number; amountMinor: string }, now: Date): Date {
  const web = webTermsOfOrder(st, orderId);
  const at = web ? milestonePayment(st, web, m)?.payment.updatedAt : undefined;
  return at ? new Date(at) : now;
}

/** Released escrow milestones as supplier cost (RELEASE_MILESTONE). */
function supplierCost(st: MockState, now: Date): CfoPaymentIn[] {
  return [...st.escrow.entries()].flatMap(([orderId, schedule]) =>
    schedule
      .filter((m) => m.released)
      .map((m) => ({ kind: "RELEASE_MILESTONE" as const, lineKey: "SUPPLIER" as const, amountMinor: parseMinor(m.amountMinor), state: "FINALIZED" as const, at: paidAt(st, orderId, m, now), txHash: null })),
  );
}

function paymentsOf(st: MockState, now: Date): CfoPaymentIn[] {
  const rows = st.payments
    .map((s) => s.payment)
    .filter((p) => COUNTED_KINDS.has(p.kind))
    .map((p) => ({ kind: p.kind, lineKey: p.lineKey, amountMinor: parseMinor(p.amountMinor), state: p.state, at: new Date(p.updatedAt), txHash: p.txHash ?? null }));
  return [...rows, ...supplierCost(st, now)];
}

function stageOf(st: MockState, manifest: PlanManifest | undefined): CfoInputs["stage"] {
  if (!manifest) return null;
  const released = parseMinor(st.balances.releasedMinor);
  let cumulative = 0n;
  for (const s of manifest.stages) {
    cumulative += parseMinor(s.releaseMinor);
    if (cumulative <= released) continue;
    const gate = s.gate;
    if (!gate || gate.metric !== "salesMinor" || gate.deadline === "0") return null;
    return { stageId: s.stageId, targetMinor: BigInt(gate.target), deadline: new Date(Number(gate.deadline) * 1000) };
  }
  return null;
}

/** True once a supplier order exists (its escrow schedule): only then is there anything to sell. */
export const hasSupplierOrder = (st: Pick<MockState, "escrow">): boolean => st.escrow.size > 0;

/** The mock store's CFO inputs at `nowMs` (see the header). */
export function mockCfoInputs(st: MockState, nowMs: number): CfoInputs {
  const now = new Date(nowMs);
  const manifest = currentPlan(st)?.status === "COMMITTED" ? currentPlan(st)?.manifest : undefined;
  const rateBps = manifest?.reserveBps ?? 0;
  const lived = st.sample;
  const sample = lived ? [...lived.sales] : manifest && hasSupplierOrder(st) ? sampleSales(nowMs) : [];
  const demoRevenue = parseMinor(st.balances.revenueMinor) - (lived?.revenueMinor ?? 0n);
  const sales = demoRevenue > 0n ? [...sample, { saleId: "sale-mock-today" as Id, amountMinor: demoRevenue, at: now, txHash: null }] : sample;
  const payments = paymentsOf(st, now);
  const withdrawn = payments.filter((p) => p.kind === "WITHDRAW_RESERVE" && ["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED"].includes(p.state)).reduce((s, p) => s + p.amountMinor, 0n);
  // The lived series is already in the store's reserve (recorded sale by sale); the 14-day sample is not.
  const sampleSkim = lived ? 0n : sample.reduce((s, x) => s + bpsFloor(x.amountMinor, rateBps), 0n);
  return {
    currency: st.facility.currency,
    now,
    facilityId: st.facility.facilityId,
    lines: linesOf(st, manifest),
    payments,
    sales,
    reserve: { rateBps, skimmedMinor: sampleSkim + parseMinor(st.balances.reserveMinor) + withdrawn, withdrawnMinor: withdrawn, taxPayeeId: st.profile.ids.taxPayeeId },
    stage: stageOf(st, manifest),
    reserveBps: rateBps,
    agentActions: [],
    releasedMinor: parseMinor(st.balances.releasedMinor),
    fundedMinor: parseMinor(st.balances.fundedMinor),
  };
}

/** The schema's in-app path (core schemas/cfo.ts AppHref): a single leading slash, an optional #fragment, no scheme. */
const APP_PATH = /^\/(?!\/)[A-Za-z0-9/_.?=&%-]*(#[A-Za-z0-9_-]+)?$/;

/** As the live API's wireHref: core's "/dashboard#change-requests" loses its fragment rather than fail the schema. */
function wireHref(href: string | null): string | null {
  if (href === null || APP_PATH.test(href)) return href;
  const path = href.split("#", 1)[0] ?? "";
  return APP_PATH.test(path) ? path : null;
}

export function mockCfoReport(st: MockState, nowMs: number): CfoReport {
  const json = toCfoReportJson(buildCfoReport(mockCfoInputs(st, nowMs)));
  return {
    ...json,
    insights: json.insights.map((i) => (i.suggestion ? { ...i, suggestion: { ...i.suggestion, href: wireHref(i.suggestion.href) } } : i)),
  } as CfoReport;
}

export const cfoHandlers: Pick<Handlers, "getCfoReport"> = {
  getCfoReport: ({ st }) => mockCfoReport(st, Date.now()),
};
