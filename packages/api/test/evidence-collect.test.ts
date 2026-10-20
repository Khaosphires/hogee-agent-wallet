/**
 * collect() refuses to export a decision whose committed rationaleHash has no stored preimage (run-6 v-4), and past
 * MAX_ROWS_PER_TABLE trace events keeps the named traces and the newest others whole (audit run-7).
 */
import { describe, expect, it } from "vitest";
import { collect, EvidenceIncompleteError, EvidenceTooLargeError, MAX_ROWS_PER_TABLE, selectTraces, type TraceStat } from "../src/evidence/collect";
import type { Q } from "../src/services/sql";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const DECISION = "01a14495-5600-7000-8000-000000000001";

const paymentRow = {
  id: "pay-1", kind: "SPEND", intent_id: h(1), line_key: "LOGISTICS", payee_id: "spx-logistics", amount_minor: "1000", invoice_hash: h(2), plan_version: 1,
  state: "FINALIZED", tx_hash: h(3), block: "101", revert_reason: null, payout_id: null, payout_attempt: 0, payout_status: "NONE", payout_failure_code: null,
  decision_id: DECISION, rationale_hash: h(4), trace_id: "trace:pay-1", updated_at: new Date("2026-10-18T00:00:00Z"), order_id: null, milestone_idx: null,
  signer_address: `0x${"2".repeat(40)}`, nonce: "0", raw_signed_tx: "0x02",
};

/** A Q that answers each table's select with `tables[name]` (every other table is empty). */
function fakeQ(tables: Record<string, unknown[]>): Q {
  return {
    query: (async (text: string) => {
      const table = /from (\w+)/.exec(text)?.[1] ?? "";
      return { rows: tables[table] ?? [] };
    }) as unknown as Q["query"],
  };
}

const scope = { facilityId: "fac-1", founderId: "founder-1" };

describe("collect: rationale preimages", () => {
  it("refuses a committed rationaleHash without its stored preimage", async () => {
    const q = fakeQ({ payments: [paymentRow] });
    await expect(collect(q, scope)).rejects.toBeInstanceOf(EvidenceIncompleteError);
    await expect(collect(q, scope)).rejects.toThrow(/no stored preimage/);
  });

  it("exports the stored preimage when there is one", async () => {
    const q = fakeQ({ payments: [paymentRow], rationales: [{ rationale_hash: h(4), decision_id: DECISION, rationale_json: { a: 1 }, salt: null }] });
    const c = await collect(q, scope);
    expect(c.rationales).toEqual([{ status: "available", rationaleHash: h(4), decisionId: DECISION, rationale: { a: 1 }, salt: null }]);
  });
});

describe("selectTraces (audit run-7)", () => {
  const stat = (traceId: string, events: number, lastMs: number, over: Partial<TraceStat> = {}): TraceStat => ({ traceId, events, lastMs, evalTrace: false, named: false, ...over });

  it("keeps everything that fits, and never an eval trace", () => {
    const s = selectTraces([stat("a", 3, 1), stat("b", 2, 2), stat("eval-1", 40, 3, { evalTrace: true, named: true })], 10);
    expect([...s.keep].sort()).toEqual(["a", "b"]);
    expect([...s.excludedEval]).toEqual(["eval-1"]);
    expect(s.omitted).toEqual({ traces: 0, events: 0 });
  });

  it("counts the cap after the eval filter", () => {
    const s = selectTraces([stat("a", 6, 1), stat("eval-1", 100, 2, { evalTrace: true })], 6);
    expect(s.keep).toEqual(["a"]);
    expect(s.omitted).toEqual({ traces: 0, events: 0 });
  });

  it("keeps every named trace, then the newest others whole; the oldest are left out", () => {
    const s = selectTraces(
      [stat("old-named", 4, 1, { named: true }), stat("oldest", 2, 2), stat("older", 3, 3), stat("newer", 2, 5), stat("newest", 1, 6), stat("named", 1, 7, { named: true })],
      9,
    );
    expect(s.keep).toEqual(["old-named", "named", "newest", "newer"]);
    expect(s.omitted).toEqual({ traces: 2, events: 5 });
  });

  it("stops at the first unnamed trace that does not fit whole (no newer gap is filled with older traces)", () => {
    const s = selectTraces([stat("big", 8, 9), stat("small-old", 1, 1)], 5);
    expect(s.keep).toEqual([]);
    expect(s.omitted).toEqual({ traces: 2, events: 9 });
  });

  it("refuses only when the named traces alone exceed the cap", () => {
    expect(() => selectTraces([stat("p1", 6, 1, { named: true }), stat("p2", 5, 2, { named: true })], 10)).toThrow(EvidenceTooLargeError);
    expect(selectTraces([stat("p1", MAX_ROWS_PER_TABLE, 1, { named: true }), stat("x", 1, 2)]).omitted).toEqual({ traces: 1, events: 1 });
  });
});
