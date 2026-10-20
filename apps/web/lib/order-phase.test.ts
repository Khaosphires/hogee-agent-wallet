import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderTerms } from "@hogee/core";
import { GATE_LABEL, GOODS_ARRIVED_EVENT, balanceStepOf, canPayBalance, goodsArrived, milestoneName, paymentCount, phaseOf, setGoodsArrived } from "./order-phase";

type Row = OrderTerms["schedule"][number];
const row = (idx: number, autoRelease: boolean, released = false): Row => ({
  idx,
  trigger: autoRelease ? "ON_ORDER" : "ON_DELIVERY_INSPECTED",
  label: autoRelease ? "Deposit on order" : "Balance after delivery check",
  amountMinor: "75000",
  autoRelease,
  released,
  txHash: null,
});
const terms = (over: Partial<Pick<OrderTerms, "status" | "coolingEndsAt" | "schedule">>): Pick<OrderTerms, "status" | "coolingEndsAt" | "schedule"> => ({
  status: "USED",
  coolingEndsAt: "2026-10-19T10:00:00.000Z",
  schedule: [row(0, true), row(1, false)],
  ...over,
});
const at = (iso: string) => Date.parse(iso);

describe("phaseOf", () => {
  it("names every phase from the terms alone", () => {
    expect(phaseOf(terms({ status: "SUPERSEDED" }), null)).toBe("replaced");
    expect(phaseOf(terms({ status: "CONFIRMED", coolingEndsAt: null }), null)).toBe("unsigned");
    expect(phaseOf(terms({ coolingEndsAt: null }), null)).toBe("binding");
    expect(phaseOf(terms({}), at("2026-10-19T09:59:00.000Z"))).toBe("cooling");
    expect(phaseOf(terms({}), at("2026-10-19T10:00:01.000Z"))).toBe("paying");
    expect(phaseOf(terms({ schedule: [row(0, true, true), row(1, false)] }), at("2026-10-19T10:01:00.000Z"))).toBe("waiting");
    expect(phaseOf(terms({ schedule: [row(0, true, true), row(1, false, true)] }), at("2026-10-19T10:01:00.000Z"))).toBe("done");
  });

  it("without a clock (server render) never claims the safety wait is still running", () => {
    expect(phaseOf(terms({}), null)).toBe("paying");
  });

  it("an order with no automatic payment waits for the founder right after the wait", () => {
    expect(phaseOf(terms({ schedule: [row(0, false)] }), at("2026-10-19T11:00:00.000Z"))).toBe("waiting");
  });
});

describe("milestoneName and paymentCount (Deposit / Balance naming, 1-based counts)", () => {
  it("names a 30/70 deal Deposit then Balance", () => {
    const s = [row(0, true), row(1, false)];
    expect([milestoneName(0, s), milestoneName(1, s)]).toEqual(["Deposit", "Balance"]);
    expect(paymentCount(1, 2)).toBe("payment 2 of 2");
  });

  it("names a three-part deal Deposit, Second payment, Balance", () => {
    const s = [row(0, true), row(1, false), row(2, false)];
    expect(s.map((_, i) => milestoneName(i, s))).toEqual(["Deposit", "Second payment", "Balance"]);
  });

  it("a single payment is the full payment; a first payment that isn't automatic is not called a deposit", () => {
    expect(milestoneName(0, [row(0, false)])).toBe("Full payment");
    const s = [row(0, false), row(1, false)];
    expect(milestoneName(0, s)).toBe("First payment");
  });
});

describe("the Goods arrived gate is a UI gate only (G8)", () => {
  it("never enables paying without the check code, whatever the mark says", () => {
    expect(balanceStepOf({ evidenceHash: undefined, arrived: false })).toBe("in-transit");
    expect(balanceStepOf({ evidenceHash: undefined, arrived: true })).toBe("upload");
    expect(canPayBalance({ released: false, evidenceHash: undefined })).toBe(false);
    expect(canPayBalance({ released: false, evidenceHash: null })).toBe(false);
  });

  it("a check code already on record skips the gate (it was uploaded, maybe in another browser)", () => {
    expect(balanceStepOf({ evidenceHash: `0x${"ab".repeat(32)}`, arrived: false })).toBe("pay-balance");
    expect(canPayBalance({ released: false, evidenceHash: `0x${"ab".repeat(32)}` })).toBe(true);
  });

  it("a paid milestone can't be paid again", () => {
    expect(canPayBalance({ released: true, evidenceHash: `0x${"ab".repeat(32)}` })).toBe(false);
  });

  it("names the event each kind of payment waits for", () => {
    expect(GATE_LABEL.ON_DELIVERY_INSPECTED).toBe("Goods arrived");
    expect(GATE_LABEL.ON_SHIPMENT).toBe("Goods shipped");
  });
});

describe("the Goods arrived mark (browser storage, never the API)", () => {
  const store = new Map<string, string>();
  const events: string[] = [];
  const fetchSpy = vi.fn();
  beforeEach(() => {
    store.clear();
    events.length = 0;
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal("dispatchEvent", (e: Event) => void events.push(e.type));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stores hogee.goodsArrived.<orderId> and tells listeners in this tab, without any request", () => {
    expect(goodsArrived("order-wabcdefghijkl-001")).toBe(false);
    setGoodsArrived("order-wabcdefghijkl-001");
    expect(store.get("hogee.goodsArrived.order-wabcdefghijkl-001")).toBe("1");
    expect(goodsArrived("order-wabcdefghijkl-001")).toBe(true);
    expect(events).toEqual([GOODS_ARRIVED_EVENT]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still counts the press in this page when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(goodsArrived("order-wmnopqrstuvwx-001")).toBe(false);
    setGoodsArrived("order-wmnopqrstuvwx-001");
    expect(goodsArrived("order-wmnopqrstuvwx-001")).toBe(true);
  });
});
