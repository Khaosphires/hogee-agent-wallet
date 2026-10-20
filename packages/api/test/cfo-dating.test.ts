/**
 * GET /api/cfo dates its records in a bounded way (fixr-cfo, re-check LOW 4). Before, every request dated the
 * facility's ALL-time records, one getBlock per distinct block, through a 20,000-entry cache that emptied when full.
 * Now only the last 30 chain days are dated exactly, plus the earliest record of each class, the sale that crossed
 * the stage target, the 20 newest sales and the agent actions; every older record gets the time of the nearest dated
 * block at or below it (a lower bound, still before the window). Timestamps come through an LRU that evicts, never
 * clears. Parity: the report from these dates is exactly the report from the full dating.
 */
import { CfoReport, MEI_LINES, MEI_PLAN, examplePlanManifest, type Hex32, type Id, type PayeeId, type PlanManifest } from "@hogee/core";
import { stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { BlockTimeCache, CFO_WINDOW_DAYS, dateRecords } from "../src/services/cfo-dating";
import { agentActionsOf, reportOf, type CfoRecords, type PaymentRecord, type SaleRecord } from "../src/services/cfo";

const HOUR = 3_600n;
const DAY = 86_400n;
/** Head block: 100 days of one block an hour. */
const B = 2_400n;
const NOW = 1_792_108_800n + 100n * DAY + 7_200n; // 2027-01-24T02:00Z
const timeOf = (block: bigint): bigint => NOW - (B - block) * HOUR;
const tx = (n: bigint): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;

function stubChain() {
  const calls: bigint[] = [];
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      calls.push(blockNumber);
      return { number: blockNumber, hash: blockNumber === 0n ? `0x${"11".repeat(32)}` : `0x${blockNumber.toString(16).padStart(64, "0")}`, timestamp: timeOf(blockNumber) };
    },
  };
  return { client, calls };
}

const committed: PlanManifest = {
  ...examplePlanManifest,
  reserveBps: 500,
  stages: [
    { stageId: "stage-1", releaseMinor: "400000", gate: null },
    { stageId: "stage-2", releaseMinor: "600000", gate: { metric: "salesMinor", target: "50000", deadline: String(NOW + 30n * DAY) } },
  ],
};

function snapshot(): CfoRecords["snapshot"] {
  return {
    timestamp: NOW,
    plan: { reserveBps: 500 } as CfoRecords["snapshot"]["plan"],
    balances: { fundedMinor: 1_000_000n, releasedMinor: 400_000n, spentMinor: 0n, escrowedMinor: 0n, revenueMinor: 0n, reserveMinor: 0n },
    lines: MEI_LINES.map((l) => ({
      lineId: stringToHex(l.lineKey, { size: 32 }),
      pocket: {
        allocatedMinor: BigInt(l.amountMinor) * 10n,
        spentMinor: 0n,
        escrowedMinor: 0n,
        availableMinor: BigInt(l.amountMinor) * 10n,
        perTxCapMinor: BigInt(l.perTxCapMinor),
        windowCapMinor: BigInt(l.windowCapMinor),
        windowSpentMinor: 0n,
        windowSeconds: Number(MEI_PLAN.windowSeconds),
        validUntil: NOW + 60n * DAY,
        pacingMinor: BigInt(l.pacingPerDayMinor ?? "0"),
        escrowOnly: l.escrowOnly,
        paused: false,
        circuitOpen: false,
      },
      sequence: 0n,
      payeeIds: [],
      bindings: [],
    })),
    stages: [
      { stageId: stringToHex("stage-1", { size: 32 }), released: true },
      { stageId: stringToHex("stage-2", { size: 32 }), released: false },
    ],
  };
}

const pay = (kind: PaymentRecord["kind"], lineKey: PaymentRecord["lineKey"], amountMinor: string, block: bigint, over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  kind,
  lineKey,
  amountMinor,
  state: "FINALIZED",
  block,
  txHash: tx(block),
  autoReleased: false,
  ...over,
});
const saleAt = (block: bigint): SaleRecord => ({ saleId: `sale-${block.toString().padStart(5, "0")}` as Id, amountMinor: "100", block, txHash: tx(10_000n + block) });
const range = (from: bigint, to: bigint, step = 1n): bigint[] => {
  const out: bigint[] = [];
  for (let b = from; b <= to; b += step) out.push(b);
  return out;
};

/**
 * The first records are not counted (an escrowed funding, a failed settlement), the first counted one is an auto-released
 * deposit 95 days ago; ads spend daily; the founder pays logistics twice; 100-minor sales one a block from `sales`.
 */
function recordsOf(saleBlocks: readonly bigint[]): Omit<CfoRecords, "blockTimes"> {
  const payments = [
    pay("FUND_MILESTONE", "SUPPLIER", "120000", 3n),
    pay("SPEND", "ADS", "7500", 50n, { state: "SETTLEMENT_FAILED" }),
    pay("FUND_MILESTONE", "SUPPLIER", "30000", 120n, { autoReleased: true }),
    ...range(240n, B, 24n).map((b) => pay("SPEND", "ADS", "7500", b)),
    pay("OWNER_SPEND", "LOGISTICS", "20000", 600n),
    pay("OWNER_SPEND", "LOGISTICS", "15000", 2_300n),
  ];
  const actions = [{ id: "cfo-guard:1:ADS", request: { source: "cfo-guard", action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: "52500", reason: "Ads spent fast." }, block: 900n, txHash: tx(9n) }];
  return {
    currency: "SGD",
    facilityId: "fac-mei" as Id,
    snapshot: snapshot(),
    ledger: { reserveSkimmedMinor: 0n, reserveWithdrawnMinor: 0n, salesCount: BigInt(saleBlocks.length) },
    committed,
    taxPayeeId: "iras-tax" as PayeeId,
    payments,
    sales: saleBlocks.map(saleAt),
    actions,
  };
}

const fullDates = (r: Omit<CfoRecords, "blockTimes">): Map<string, bigint> =>
  new Map([...r.payments, ...r.sales, ...r.actions].map((x) => [x.block.toString(), timeOf(x.block)]));
const report = (r: Omit<CfoRecords, "blockTimes">, blockTimes: Map<string, bigint>) => {
  const full = { ...r, blockTimes };
  return CfoReport.parse(reportOf(full, agentActionsOf(full).actions));
};
const datingIn = (r: Omit<CfoRecords, "blockTimes">) => ({ payments: r.payments, sales: r.sales, actions: r.actions, timestamp: NOW, stageTargetMinor: 50_000n });

describe("dateRecords: a 30-day window plus anchors", () => {
  // A: 2,000 sales over 83 days, the stage target crossed 71 days ago (sale 500), the 20 newest in the window.
  const A = recordsOf(range(200n, 2_199n));
  // B: the window holds 5 sales only, so 15 of the 20 newest sales are older than it.
  const Bx = recordsOf([...range(200n, 1_500n), ...range(2_300n, 2_304n)]);

  it("dates the window, the anchors and a logarithmic search, far fewer blocks than the history", async () => {
    expect(CFO_WINDOW_DAYS).toBe(30);
    const chain = stubChain();
    const cache = new BlockTimeCache();
    await dateRecords(chain.client, cache, datingIn(A));
    const fromTime = (NOW / DAY - 29n) * DAY;
    const inWindow = new Set([...A.payments, ...A.sales].map((x) => x.block).filter((b) => timeOf(b) >= fromTime));
    // genesis + the window + ≤ 6 class anchors + the crossing sale + the action + ~2 probes per halving of 2,400 blocks
    expect(chain.calls.length).toBeLessThanOrEqual(1 + inWindow.size + 6 + 1 + 1 + 2 * 12);
    expect(chain.calls.length).toBeLessThan(A.sales.length / 2);
    const before = chain.calls.length;
    await dateRecords(chain.client, cache, datingIn(A));
    expect(chain.calls.length - before).toBe(1); // the genesis check only: every block it needs is cached
  });

  it("parity: the report from these dates is the report from dating every record", async () => {
    for (const r of [A, Bx]) {
      const { times } = await dateRecords(stubChain().client, new BlockTimeCache(), datingIn(r));
      const exact = report(r, fullDates(r));
      expect(report(r, times)).toEqual(exact);
      // Not vacuous: the first counted record, the stage crossing and the newest sales are older than the window.
      expect(exact.pnl.from).toBe(new Date(Number(timeOf(120n)) * 1000).toISOString().slice(0, 10));
      expect(exact.forecast.stage2Date).toBe(new Date(Number(timeOf(699n)) * 1000).toISOString().slice(0, 10));
      expect(exact.sales.count).toBe(r.sales.length);
    }
    const recentB = report(Bx, fullDates(Bx)).sales.recent;
    expect(recentB).toHaveLength(20);
    expect(recentB.at(-1)?.saleId).toBe("sale-01486");
  });

  it("every record gets a time; an older record's time is a lower bound that stays before the window", async () => {
    const { times } = await dateRecords(stubChain().client, new BlockTimeCache(), datingIn(A));
    const fromTime = (NOW / DAY - 29n) * DAY;
    for (const x of [...A.payments, ...A.sales, ...A.actions]) {
      const t = times.get(x.block.toString());
      expect(t).toBeDefined();
      expect(t! <= timeOf(x.block)).toBe(true);
      if (timeOf(x.block) >= fromTime) expect(t).toBe(timeOf(x.block));
      else expect(t! < fromTime).toBe(true);
    }
  });

  it("no record: only the genesis is read", async () => {
    const chain = stubChain();
    const { times } = await dateRecords(chain.client, new BlockTimeCache(), { payments: [], sales: [], actions: [], timestamp: NOW, stageTargetMinor: null });
    expect(times.size).toBe(0);
    expect(chain.calls.length).toBeLessThanOrEqual(1);
  });

  it("a read error propagates (the report fails closed)", async () => {
    const broken = { getBlock: async () => Promise.reject(new Error("rpc down")) };
    await expect(dateRecords(broken, new BlockTimeCache(), datingIn(A))).rejects.toThrow("rpc down");
  });
});

describe("BlockTimeCache: an LRU that evicts, never empties", () => {
  it("evicts the least recently used entry and re-scopes on another chain", () => {
    const c = new BlockTimeCache(2);
    c.scope("0xaa");
    c.set(1n, 10n);
    c.set(2n, 20n);
    expect(c.get(1n)).toBe(10n);
    c.set(3n, 30n); // evicts 2, keeps 1 and 3
    expect([c.get(2n), c.get(1n), c.get(3n), c.size]).toEqual([undefined, 10n, 30n, 2]);
    c.scope("0xAA");
    expect(c.size).toBe(2);
    c.scope("0xbb");
    expect(c.size).toBe(0);
  });
});
