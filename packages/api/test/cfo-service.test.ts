/**
 * v-cfo: the CFO service's pure half (records → core CfoInputs → report) and its fail-closed edges. The DB and chain
 * reads are covered by test/live/cfo.live.test.ts.
 */
import { CfoInputError, CfoReport, examplePlanManifest, MEI_LINES, MEI_PLAN, type Hex32, type Id, type PayeeId, type PlanManifest } from "@hogee/core";
import { stringToHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { agentActionsOf, cfoInputsOf, cfoReport, reportOf, wireHref, type CfoRecords, type PaymentRecord } from "../src/services/cfo";
import { ApiProblem } from "../src/http/problem";
import { fakeDeps } from "./support/fake-deps";

const DAY = 86_400n;
const T0 = 1_792_108_800n; // 2026-10-16T00:00:00Z
const tag = (s: string): Hex => stringToHex(s, { size: 32 });
const shortLine = (id: string): string => Buffer.from(id.slice(2).replace(/(00)+$/, ""), "hex").toString("latin1");
const tx = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;

function pocket(l: (typeof MEI_LINES)[number], over: Partial<CfoRecords["snapshot"]["lines"][number]["pocket"]> = {}) {
  return {
    allocatedMinor: BigInt(l.amountMinor),
    spentMinor: 0n,
    escrowedMinor: 0n,
    availableMinor: BigInt(l.amountMinor),
    perTxCapMinor: BigInt(l.perTxCapMinor),
    windowCapMinor: BigInt(l.windowCapMinor),
    windowSpentMinor: 0n,
    windowSeconds: Number(MEI_PLAN.windowSeconds),
    validUntil: T0 + 60n * DAY,
    pacingMinor: BigInt(l.pacingPerDayMinor ?? "0"),
    escrowOnly: l.escrowOnly,
    paused: false,
    circuitOpen: false,
    ...over,
  };
}

const committed: PlanManifest = {
  ...examplePlanManifest,
  reserveBps: 500,
  stages: [
    { stageId: "stage-1", releaseMinor: "400000", gate: null },
    { stageId: "stage-2", releaseMinor: "600000", gate: { metric: "salesMinor", target: "200000", deadline: String(T0 + 30n * DAY) } },
  ],
};

function records(over: Partial<CfoRecords> = {}, nowDay = 10n): CfoRecords {
  const blocks = new Map<string, bigint>();
  for (let b = 0n; b <= 20n; b += 1n) blocks.set(b.toString(), T0 + b * DAY + 3600n);
  return {
    currency: "SGD",
    facilityId: "fac-mei" as Id,
    snapshot: {
      timestamp: T0 + nowDay * DAY + 7200n,
      plan: { reserveBps: 600 } as CfoRecords["snapshot"]["plan"],
      balances: { fundedMinor: 1_000_000n, releasedMinor: 400_000n, spentMinor: 0n, escrowedMinor: 0n, revenueMinor: 0n, reserveMinor: 0n },
      lines: [
        ...MEI_LINES.map((l) => ({ lineId: tag(l.lineKey), pocket: pocket(l), sequence: 0n, payeeIds: [], bindings: [] })),
        // Not a LineKey: left out, as the dashboard does.
        { lineId: tag("NOT_A_LINE"), pocket: pocket(MEI_LINES[1]!), sequence: 0n, payeeIds: [], bindings: [] },
      ],
      stages: [
        { stageId: tag("stage-1"), released: true },
        { stageId: tag("stage-2"), released: false },
      ],
    },
    ledger: { reserveSkimmedMinor: 3_000n, reserveWithdrawnMinor: 0n, salesCount: 2n },
    committed,
    taxPayeeId: "iras-tax" as PayeeId,
    payments: [],
    sales: [
      { saleId: "sale-1" as Id, amountMinor: "30000", block: 8n, txHash: tx(1) },
      { saleId: "sale-2" as Id, amountMinor: "30000", block: 9n, txHash: tx(2) },
    ],
    actions: [],
    blockTimes: blocks,
    ...over,
  };
}

const deposit = (autoReleased: boolean, block = 5n): PaymentRecord => ({
  kind: "FUND_MILESTONE",
  lineKey: "SUPPLIER",
  amountMinor: "120000",
  state: "FINALIZED",
  block,
  txHash: tx(9),
  autoReleased,
});

// The service's own path: cfoInputsOf → core buildCfoReport → the wire shape, checked against the contract schema.
const buildJson = (r: CfoRecords) => CfoReport.parse(reportOf(r, agentActionsOf(r).actions));

describe("cfoInputsOf (records → core CfoInputs)", () => {
  it("passes every optional input core-cfo needs: autoReleased, released/funded, pacing and window seconds", () => {
    const i = cfoInputsOf(records({ payments: [deposit(true)] }), []);
    expect(i.payments[0]).toMatchObject({ kind: "FUND_MILESTONE", autoReleased: true, amountMinor: 120_000n });
    expect(i.releasedMinor).toBe(400_000n);
    expect(i.fundedMinor).toBe(1_000_000n);
    const ads = i.lines.find((l) => l.lineKey === "ADS");
    expect(ads).toMatchObject({ pacingMinor: 7_500n, windowSeconds: 604_800n });
    expect(i.lines.map((l) => l.lineKey)).not.toContain("NOT_A_LINE");
    // Live rate from the chain, committed rate from the manifest; chain time is the clock.
    expect(i.reserve.rateBps).toBe(600);
    expect(i.reserveBps).toBe(500);
    expect(i.now.toISOString()).toBe("2026-10-26T02:00:00.000Z");
  });

  it("dates every record by its block's timestamp, and refuses a record whose block it cannot date", () => {
    const i = cfoInputsOf(records(), []);
    expect(i.sales.map((s) => s.at.toISOString())).toEqual(["2026-10-24T01:00:00.000Z", "2026-10-25T01:00:00.000Z"]);
    expect(() => cfoInputsOf(records({ sales: [{ saleId: "sale-x" as Id, amountMinor: "100", block: 99n, txHash: null }] }), [])).toThrow(CfoInputError);
  });

  it("autoReleased is only ever set on milestone fundings", () => {
    const spend: PaymentRecord = { kind: "SPEND", lineKey: "ADS", amountMinor: "7500", state: "FINALIZED", block: 6n, txHash: tx(3), autoReleased: false };
    expect(cfoInputsOf(records({ payments: [spend] }), []).payments[0]).not.toHaveProperty("autoReleased");
  });

  it("stage: the first unreleased salesMinor gate; none for an orders gate, a released stage or no plan", () => {
    expect(cfoInputsOf(records(), []).stage).toEqual({ stageId: "stage-2", targetMinor: 200_000n, deadline: new Date(Number(T0 + 30n * DAY) * 1000) });
    const orders = { ...committed, stages: [committed.stages[0]!, { ...committed.stages[1]!, gate: { metric: "orders" as const, target: "50", deadline: String(T0 + 30n * DAY) } }] };
    expect(cfoInputsOf(records({ committed: orders }), []).stage).toBeNull();
    const released = records();
    expect(cfoInputsOf({ ...released, snapshot: { ...released.snapshot, stages: released.snapshot.stages.map((s) => ({ ...s, released: true })) } }, []).stage).toBeNull();
    const none = records({ committed: null });
    expect(cfoInputsOf(none, []).stage).toBeNull();
    expect(cfoInputsOf(none, []).reserveBps).toBe(600);
  });
});

describe("the report from the records", () => {
  // The service's own path: cfoInputsOf → core buildCfoReport → toCfoReportJson, checked against the contract schema.

  it("an auto-released deposit is supplier cost; a funding still held in escrow is not", () => {
    const paid = buildJson(records({ payments: [deposit(true)] }));
    expect(paid.pnl.supplierCostMinor).toBe("120000");
    expect(paid.overview.spentMinor).toBe("120000");
    const held = buildJson(records({ payments: [deposit(false)] }));
    expect(held.pnl.supplierCostMinor).toBe("0");
  });

  it("stage-1 cash is capped by what the lender released (4,000 BU), not the 10,000 BU of allocations", () => {
    const r = buildJson(records());
    expect(r.overview.cashAvailableMinor).toBe("400000");
    expect(r.reserve).toMatchObject({ rateBps: 600, skimmedMinor: "3000", balanceMinor: "3000", taxPayeeId: "iras-tax", salesCount: 2 });
    expect(r.sales.revenueMinor).toBe("60000");
    expect(r.disclaimer).toBe("Estimates from your own records. Not financial advice.");
  });

  it("agent actions: landed cfo-guard tightenings dated by block; a request that does not parse is dropped", () => {
    const good = { source: "cfo-guard", action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: "52500", reason: "Ads spent 900 BU in the last 7 days." };
    const r = records({
      actions: [
        { id: "cfo-guard:20387:ADS", request: good, block: 9n, txHash: tx(7) },
        { id: "cfo-guard:20387:RESERVE", request: { ...good, newValue: "-1" }, block: 9n, txHash: tx(8) },
        { id: "cfo-guard:20388:LOGISTICS", request: { ...good, action: "LOOSEN" }, block: 9n, txHash: tx(9) },
      ],
    });
    const { actions, dropped } = agentActionsOf(r);
    expect(dropped).toEqual(["cfo-guard:20387:RESERVE", "cfo-guard:20388:LOGISTICS"]);
    expect(actions).toEqual([{ at: "2026-10-25T01:00:00.000Z", action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: "52500", reason: good.reason, txHash: tx(7) }]);
    expect(buildJson(r).agentActions).toHaveLength(1);
  });
});

describe("insight links on the wire", () => {
  it("a MOVE_BUDGET insight still yields a schema-valid report (its change-requests link is an in-app path)", () => {
    const r = records();
    const lines = r.snapshot.lines.map((l) =>
      shortLine(l.lineId) === "ADS" ? { ...l, pocket: { ...l.pocket, availableMinor: 10_000n, spentMinor: 110_000n } } : l,
    );
    const report = buildJson({ ...r, snapshot: { ...r.snapshot, lines } });
    const move = report.insights.find((i) => i.kind === "MOVE_BUDGET");
    expect(move?.lineKey).toBe("ADS");
    expect(move?.suggestion?.href).toBe("/dashboard#change-requests");
  });

  it("wireHref keeps a valid in-app path (with its #fragment) and nulls anything else", () => {
    expect(wireHref("/dashboard?tab=pnl")).toBe("/dashboard?tab=pnl");
    expect(wireHref("/dashboard#change-requests")).toBe("/dashboard#change-requests");
    expect(wireHref("/dashboard#bad fragment")).toBe("/dashboard");
    expect(wireHref("//evil.example/x")).toBeNull();
    expect(wireHref("https://evil.example")).toBeNull();
    expect(wireHref(null)).toBeNull();
  });
});

describe("cfoReport fails closed", () => {
  it("answers UPSTREAM when the chain cannot be read (never a partial report)", async () => {
    const { deps, logs } = fakeDeps();
    const err = await cfoReport(deps, { facilityId: "fac-rina", founderId: "founder-rina" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblem);
    expect((err as ApiProblem).failure.code).toBe("UPSTREAM");
    expect(logs.map((l) => l.event)).toContain("cfo_records_failed");
  });
});
