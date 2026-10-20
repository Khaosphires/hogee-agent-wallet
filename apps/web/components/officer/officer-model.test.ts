import { describe, expect, it } from "vitest";
import { EXCEPTION_KINDS, Exception, type Balances, type ExceptionKind, type Payment } from "@hogee/core";
import { ago, aiCanPayNow, feedOf, goalPct, releaseRows, requestDetail, requestTitle, salesFigure, signatureTitle, STATUS_WORD } from "./officer-model";

const NOW_S = Date.parse("2026-10-19T10:00:00Z") / 1000;

const pocket = (lineKey: string, available: string, windowCap: string, windowSpent: string, extra: Partial<Balances["pockets"][number]> = {}) => ({
  lineKey,
  allocated: "100000",
  spent: "0",
  available,
  perTxCap: "10000",
  windowCap,
  windowSpent,
  validUntil: "1797292800",
  paused: false,
  circuitOpen: false,
  ...extra,
});

const BAL = {
  fundedMinor: "1000000",
  releasedMinor: "1000000",
  escrowMinor: "0",
  paused: false,
  agent: { address: `0x${"11".repeat(20)}`, expiresAt: "1797292800", revoked: false },
  pockets: [pocket("ADS", "60000", "60000", "7500"), pocket("LOGISTICS", "45000", "40000", "10000"), pocket("PACKAGING", "5000", "75000", "0")],
} as unknown as Balances;

describe("aiCanPayNow", () => {
  it("adds what is left of each pocket and of its window", () => {
    // ADS min(600, 525) + LOGISTICS min(450, 300) + PACKAGING min(50, 750) = 875 BU
    expect(aiCanPayNow(BAL, NOW_S)).toBe("87500");
  });

  it("is capped by what is ready to spend (released minus spent and held)", () => {
    expect(aiCanPayNow({ ...BAL, releasedMinor: "40000" }, NOW_S)).toBe("40000");
  });

  it("leaves out paused and stopped pockets", () => {
    const pockets = [pocket("ADS", "60000", "60000", "0", { paused: true }), pocket("LOGISTICS", "45000", "45000", "0", { circuitOpen: true }), pocket("PACKAGING", "5000", "75000", "0")];
    expect(aiCanPayNow({ ...BAL, pockets } as Balances, NOW_S)).toBe("5000");
  });

  it("is zero when payments are paused, or the AI's key is off or expired", () => {
    expect(aiCanPayNow({ ...BAL, paused: true }, NOW_S)).toBe("0");
    expect(aiCanPayNow({ ...BAL, agent: { ...BAL.agent, revoked: true } }, NOW_S)).toBe("0");
    expect(aiCanPayNow({ ...BAL, agent: { ...BAL.agent, expiresAt: String(NOW_S - 1) } }, NOW_S)).toBe("0");
  });
});

describe("ago", () => {
  const now = Date.parse("2026-10-19T10:00:00Z");
  it("reads like a feed", () => {
    expect(ago(now - 20_000, now)).toBe("Just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(ago(now - 30 * 3_600_000, now)).toBe("Yesterday");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3 days ago");
    expect(ago(Date.parse("2026-09-25T01:00:00Z"), now)).toBe("25 Sept");
  });
  it("never says a future time is past", () => {
    expect(ago(now + 86_400_000, now)).toBe("20 Oct");
  });
});

describe("What happened", () => {
  const pay = (paymentId: string, extra: Partial<Payment>): Payment =>
    ({ paymentId, kind: "SPEND", lineKey: "ADS", amountMinor: "7500", state: "SETTLED", decisionId: `0x${"ab".repeat(32)}`, updatedAt: "2026-10-18T10:00:05Z", ...extra }) as Payment;

  it("lists the AI's mined payments, the founder's signatures and the officer's actions, newest first, as templates", () => {
    const feed = feedOf({
      founder: "Mei",
      payments: [
        pay("p1", {}),
        pay("p2", { state: "BROADCAST", updatedAt: "2026-10-19T09:00:00Z" }),
        pay("p3", { kind: "OWNER_SPEND", decisionId: null, updatedAt: "2026-10-19T09:30:00Z" }),
        pay("p4", { kind: "FUND_MILESTONE", lineKey: "SUPPLIER", updatedAt: "2026-10-17T10:00:00Z", amountMinor: "75000" }),
      ],
      traces: [
        { traceId: "t1", seq: 0, actor: "founder", kind: "SIGNATURE", summary: "Sample history: Mei signed the plan (PlanApproval). Made up for the demo", ts: "2026-09-25T01:00:00Z" },
        { traceId: "t2", seq: 0, actor: "officer", kind: "TX", summary: "Loan officer funded the facility", ts: "2026-09-25T02:30:00Z" },
        { traceId: "t3", seq: 0, actor: "oracle", kind: "TX", summary: "Sale recorded by the oracle", ts: "2026-10-19T05:00:00Z" },
      ],
    });
    expect(feed.map((i) => [i.kind, i.title])).toEqual([
      ["agent", "Ads paid by itself"],
      ["agent", "Supplier deposit paid by itself"],
      ["officer", "You added money"],
      ["signed", "Mei signed the plan"],
    ]);
    expect(feed[0]?.amountMinor).toBe("7500");
    expect(JSON.stringify(feed)).not.toMatch(/Sample history|Made up|PlanApproval/);
  });

  it("never calls a founder-signed payment one the AI paid by itself (re-check W-4)", () => {
    const feed = feedOf({
      founder: "Mei",
      payments: [
        pay("r1", { kind: "RELEASE_MILESTONE", lineKey: "SUPPLIER", updatedAt: "2026-10-19T09:00:00Z" }),
        pay("o1", { kind: "OWNER_SPEND", updatedAt: "2026-10-19T08:00:00Z" }),
        pay("p1", {}),
      ],
      traces: [{ traceId: "t1", seq: 0, actor: "founder", kind: "SIGNATURE", summary: "(MilestoneRelease)", ts: "2026-10-19T08:59:00Z" }],
    });
    expect(feed.map((i) => [i.kind, i.title])).toEqual([
      ["signed", "Mei signed a balance payment"],
      ["agent", "Ads paid by itself"],
    ]);
  });

  it("names each signature from its kind, never from the summary's words", () => {
    expect(signatureTitle("… (SupplierApproval) …", "Mei")).toBe("Mei signed a supplier order");
    expect(signatureTitle("… (MilestoneRelease) …", "Mei")).toBe("Mei signed a balance payment");
    expect(signatureTitle("… (LoosenRequest) …", "Rina")).toBe("Rina signed a request for you");
    expect(signatureTitle("Mock signed something odd", "Mei")).toBe("Mei signed");
  });

  it("keeps the founder's older signatures in view next to a busy week of payments", () => {
    const payments = Array.from({ length: 10 }, (_, i) => pay(`p${i}`, { updatedAt: `2026-10-1${i}T10:00:00Z` }));
    const traces = [1, 2, 3, 4].map((n) => ({ traceId: `s${n}`, seq: 0, actor: "founder", kind: "SIGNATURE", summary: "(SupplierApproval)", ts: `2026-09-2${n}T00:00:00Z` }));
    const feed = feedOf({ founder: "Mei", payments, traces, limit: 6 });
    expect(feed.map((i) => i.kind)).toEqual(["agent", "agent", "agent", "signed", "signed", "signed"]);
  });

  it("keeps to the limit", () => {
    const payments = Array.from({ length: 10 }, (_, i) => pay(`p${i}`, { updatedAt: `2026-10-1${i}T10:00:00Z` }));
    expect(feedOf({ founder: "Mei", payments, traces: [], limit: 3 })).toHaveLength(3);
    expect(feedOf({ founder: "Mei", payments: undefined, traces: undefined })).toEqual([]);
  });
});

describe("requests", () => {
  it("titles a request from its kind and says its status in words", () => {
    expect(requestTitle({ kind: "UNPAUSE" })).toBe("Restart payments");
    for (const word of Object.values(STATUS_WORD)) expect(word).not.toMatch(/^[A-Z_]+$/);
  });
});

describe("requestDetail: what the officer approves, read from the typed payload", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  /** A server- or seed-written title that says something else: none of its words may reach the row. */
  const MISLEADING = "Approved by the bank: send 999,999 BU to evil-co";
  /** One request, checked against the core schema like the API client does (strict payloads). */
  const req = (kind: ExceptionKind, payload: unknown): Exception =>
    Exception.parse({
      exceptionId: `exc-${kind.toLowerCase()}`,
      kind,
      title: MISLEADING,
      requestedBy: "founder",
      requires: { founder: true, lender: true },
      status: "FOUNDER_SIGNED",
      timelock: null,
      txs: {},
      blastRadiusMinor: "10000",
      traceId: "trace-1",
      payload,
    });
  const text = (t: string) => ({ kind: "text", text: t });
  const money = (minor: string) => ({ kind: "money", minor });

  it("RAISE_CAP: the pocket, which limit and the new limit", () => {
    expect(requestDetail(req("RAISE_CAP", { lineKey: "ADS", cap: "perTx", newCapMinor: "40000" }), "SGD")).toEqual([
      { label: "Pocket", value: text("Ads") },
      { label: "Which limit", value: text("Most per payment") },
      { label: "New limit", value: money("40000") },
    ]);
    expect(requestDetail(req("RAISE_CAP", { lineKey: "LOGISTICS", cap: "window", newCapMinor: "90000" }), "SGD")).toEqual([
      { label: "Pocket", value: text("Delivery") },
      { label: "Which limit", value: text("Most per week") },
      { label: "New limit", value: money("90000") },
    ]);
  });

  it("ADD_PAYEE: who can be paid (with how payees are paid) and from which pocket", () => {
    expect(requestDetail(req("ADD_PAYEE", { payeeId: "print-co", lineKey: "PACKAGING" }), "SGD")).toEqual([
      { label: "Who can be paid", value: { kind: "id", id: "print-co", rail: true } },
      { label: "Paid from", value: text("Packaging pocket") },
    ]);
  });

  it("EXTEND_EXPIRY: what gets more time and the new end date, with its year, in the facility's time", () => {
    // 1797292800 = 15 Dec 2026, 00:00 UTC = 08:00 in Singapore and Kuala Lumpur.
    expect(requestDetail(req("EXTEND_EXPIRY", { target: "agent", newExpiresAt: "1797292800" }), "SGD")).toEqual([
      { label: "What", value: text("The AI's paying key") },
      { label: "New end date", value: text("15 Dec 2026, 08:00 SGT") },
    ]);
    expect(requestDetail(req("EXTEND_EXPIRY", { target: "line", lineKey: "ADS", newExpiresAt: "1797292800" }), "MYR")).toEqual([
      { label: "What", value: text("Ads pocket") },
      { label: "New end date", value: text("15 Dec 2026, 08:00 MYT") },
    ]);
  });

  it("EXTEND_EXPIRY: a date past the calendar still shows, never a blank or a crash", () => {
    const rows = requestDetail(req("EXTEND_EXPIRY", { target: "agent", newExpiresAt: "18446744073709551615" }), "SGD");
    expect(rows[1]).toEqual({ label: "New end date", value: text("Too far ahead to show as a date (18446744073709551615 in seconds)") });
  });

  it("MOVE_POCKETS: from, to and how much", () => {
    expect(requestDetail(req("MOVE_POCKETS", { fromLineKey: "CONTINGENCY", toLineKey: "ADS", amountMinor: "20000" }), "SGD")).toEqual([
      { label: "From pocket", value: text("Safety buffer") },
      { label: "To pocket", value: text("Ads") },
      { label: "Amount", value: money("20000") },
    ]);
  });

  it("UNPAUSE: the whole wallet, or the one pocket", () => {
    expect(requestDetail(req("UNPAUSE", {}), "SGD")).toEqual([{ label: "Restarts", value: text("Every payment, from every pocket") }]);
    expect(requestDetail(req("UNPAUSE", { lineKey: "ADS" }), "SGD")).toEqual([{ label: "Restarts", value: text("Payments from the Ads pocket") }]);
  });

  it("WITHDRAW_RESERVE: the amount, who is paid and that it comes from the tax money", () => {
    expect(requestDetail(req("WITHDRAW_RESERVE", { amountMinor: "2000", taxPayeeId: "tax-office" }), "SGD")).toEqual([
      { label: "Pays", value: money("2000") },
      { label: "To", value: { kind: "id", id: "tax-office", rail: true } },
      { label: "From", value: text("Tax money") },
    ]);
  });

  it("RELEASE_ESCROW_BALANCE: the order, which payment (1-based) and the delivery check's whole code (rcfix H-4)", () => {
    // All 66 characters, never shortened: there is no hover on a phone, and the officer checks it letter by letter.
    expect(HASH).toHaveLength(66);
    expect(requestDetail(req("RELEASE_ESCROW_BALANCE", { orderId: "order-a", idx: 2, evidenceHash: HASH }), "SGD")).toEqual([
      { label: "Order", value: { kind: "id", id: "order-a" } },
      { label: "Which payment", value: text("Payment 3") },
      { label: "Delivery check code", value: { kind: "code", hex: HASH, full: true } },
    ]);
  });

  it("RELEASE_STAGE and REPLAN: the budget part, the new plan draft", () => {
    expect(requestDetail(req("RELEASE_STAGE", { stageId: "stage-2" }), "SGD")).toEqual([{ label: "Budget part", value: { kind: "id", id: "stage-2" } }]);
    expect(requestDetail(req("REPLAN", { draftId: "draft-7" }), "SGD")).toEqual([{ label: "New plan draft", value: { kind: "id", id: "draft-7" } }]);
  });

  it("POLICY_ESCALATION: the payment the rules stopped, for an invoice or a daily ads payment", () => {
    const base = { lineKey: "ADS", payeeId: "ads-net", amountMinor: "7500" };
    expect(requestDetail(req("POLICY_ESCALATION", { proposal: { ...base, invoiceId: "inv-9" } }), "SGD")).toEqual([
      { label: "Pays", value: money("7500") },
      { label: "To", value: { kind: "id", id: "ads-net", rail: true } },
      { label: "From", value: text("Ads pocket") },
      { label: "For", value: { kind: "id", id: "inv-9", before: "invoice" } },
    ]);
    expect(requestDetail(req("POLICY_ESCALATION", { proposal: { ...base, pacingSlot: 3 } }), "SGD")[3]).toEqual({ label: "For", value: text("daily ads payment #3") });
  });

  const EVERY: Readonly<Record<ExceptionKind, unknown>> = {
    RAISE_CAP: { lineKey: "ADS", cap: "perTx", newCapMinor: "40000" },
    ADD_PAYEE: { payeeId: "print-co", lineKey: "PACKAGING" },
    EXTEND_EXPIRY: { target: "agent", newExpiresAt: "1797292800" },
    MOVE_POCKETS: { fromLineKey: "CONTINGENCY", toLineKey: "ADS", amountMinor: "20000" },
    UNPAUSE: {},
    WITHDRAW_RESERVE: { amountMinor: "2000", taxPayeeId: "tax-office" },
    RELEASE_ESCROW_BALANCE: { orderId: "order-a", idx: 2, evidenceHash: HASH },
    RELEASE_STAGE: { stageId: "stage-2" },
    REPLAN: { draftId: "draft-7" },
    POLICY_ESCALATION: { proposal: { lineKey: "ADS", payeeId: "ads-net", amountMinor: "7500", invoiceId: "inv-9" } },
  };

  it("gives every kind at least one row, with a short label and a value", () => {
    for (const kind of EXCEPTION_KINDS) {
      const rows = requestDetail(req(kind, EVERY[kind]), "SGD");
      expect(rows.length, kind).toBeGreaterThan(0);
      for (const r of rows) expect(r.label, kind).toMatch(/^[A-Z][\w' ]{1,24}$/);
    }
  });

  it("never reads the server's or the seed's title", () => {
    for (const kind of EXCEPTION_KINDS) {
      const e = req(kind, EVERY[kind]);
      const shown = JSON.stringify([requestTitle(e), requestDetail(e, "SGD")]);
      expect(shown, kind).not.toContain(MISLEADING);
      expect(shown, kind).not.toMatch(/999,999|evil-co|Approved by the bank/);
    }
  });
});

describe("releases", () => {
  const stages = [
    { stageId: "stage-1", releaseMinor: "400000", gate: null },
    { stageId: "stage-2", releaseMinor: "600000", gate: { metric: "salesMinor", target: "200000", deadline: "1794700800" } },
  ] as const;

  it("marks each part released once the chain's released total covers it, with its sales goal", () => {
    expect(releaseRows(stages as never, "400000")).toEqual([
      { n: 1, stageId: "stage-1", releaseMinor: "400000", released: true },
      { n: 2, stageId: "stage-2", releaseMinor: "600000", released: false, goal: { targetMinor: "200000", deadline: "1794700800" } },
    ]);
    expect(releaseRows(stages as never, "1000000").every((r) => r.released)).toBe(true);
  });

  it("states the goal's share, capped at 100", () => {
    expect(goalPct("187200", "200000")).toBe(93.6);
    expect(goalPct("250000", "200000")).toBe(100);
    expect(goalPct("1", "0")).toBe(0);
  });
});

describe("salesFigure (stand-in for cfo-model's, same shape)", () => {
  it("reads the CFO report's sales and the next release's goal", () => {
    const sales = { count: 62, revenueMinor: "187200", averageMinor: "3019", daily: [], recent: [], stageGate: { stageId: "stage-2", targetMinor: "200000", soFarMinor: "187200", deadline: "2026-11-15", projectedDate: "2026-10-21" } };
    expect(salesFigure({ sales } as never)).toEqual({ soFarMinor: "187200", count: 62, targetMinor: "200000", deadline: "2026-11-15", projectedDate: "2026-10-21", pct: 93.6 });
    expect(salesFigure({ sales: { ...sales, stageGate: null } } as never)).toMatchObject({ targetMinor: null, pct: 0 });
  });
});
