/**
 * Mei's demo numbers (SG-DECISIONS "Mei's ids and caps"): Rina's minor units exactly, in SGD, with ids that never
 * collide with Rina's on the shared final-1 deployment (supplier A is the shared demo catalog's, stored per facility).
 * Mei's compile against a pack is in sg-compile.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  MEI_COMMIT_AT,
  MEI_FACILITY,
  MEI_IDS,
  MEI_LINES,
  MEI_PLAN,
  MEI_PLAN_INTENT,
  MEI_PLATFORM_REGISTRY,
  MEI_SESSION_ID,
  MEI_STAGES,
  MEI_SUPPLIER_A_SCHEDULE,
  MEI_SUPPLIER_A_SCHEDULE_TOTAL,
  RINA_COMMIT_AT,
  RINA_FACILITY,
  RINA_IDS,
  RINA_LINES,
  RINA_PLAN,
  RINA_SESSION_ID,
  RINA_STAGES,
  RINA_SUPPLIER_A_SCHEDULE,
  ShortId,
  UuidV7,
  meiSupplierABinding,
} from "../src/index";

describe("Mei's ids (SG-DECISIONS table)", () => {
  it("are the fixed platform, tax and vendor payee ids", () => {
    expect(MEI_IDS).toMatchObject({
      adsPayeeId: "shopee-sg-ads",
      platformFeesPayeeId: "shopee-sg-fees",
      logisticsPayeeId: "spx-sg-logistics",
      taxPayeeId: "iras-tax",
      packagingPayeeId: "sg-packaging-printer",
      deploymentId: "final-1",
      chainId: RINA_IDS.chainId,
    });
  });

  it("are ShortIds, and every id that names a party or record differs from Rina's (except the shared catalog supplier)", () => {
    // Shared: the deployment, the per-plan stage ids, supplier A (one demo catalog, stored per facility) and its first
    // order id, which the live API names per facility (order-<x>-NNN).
    const shared = new Set(["deploymentId", "chainId", "stage1Id", "stage2Id", "supplierAId", "supplierAPayeeId", "supplierAOrderId"]);
    for (const [key, value] of Object.entries(MEI_IDS)) {
      if (typeof value === "string") expect(ShortId.safeParse(value).success, key).toBe(true);
      if (!shared.has(key)) expect(Object.values(RINA_IDS), key).not.toContain(value);
    }
    expect(UuidV7.safeParse(MEI_SESSION_ID).success).toBe(true);
    expect(MEI_SESSION_ID).not.toBe(RINA_SESSION_ID);
  });
});

describe("Mei mirrors Rina's numbers exactly, in SGD", () => {
  it("facility: same cap and floor, SG and SGD", () => {
    expect(MEI_FACILITY).toEqual({ ...RINA_FACILITY, currency: "SGD", countryCode: "SG" });
    expect(MEI_COMMIT_AT).toBe(RINA_COMMIT_AT);
    expect(MEI_PLAN).toEqual(RINA_PLAN);
  });

  it("lines: the binding per-tx caps and pacing, and Rina's other numbers", () => {
    const caps = Object.fromEntries(MEI_LINES.map((l) => [l.lineKey, l.perTxCapMinor]));
    expect(caps).toEqual({ SUPPLIER: "125000", PACKAGING: "37500", LOGISTICS: "20000", ADS: "30000", PLATFORM_FEES: "12500", CONTINGENCY: "25000" });
    expect(MEI_LINES.find((l) => l.lineKey === "ADS")?.pacingPerDayMinor).toBe("7500");
    expect(MEI_LINES.map(({ payeeIds: _p, ...rest }) => rest)).toEqual(RINA_LINES.map(({ payeeIds: _p, ...rest }) => rest));
    expect(MEI_LINES.flatMap((l) => l.payeeIds)).toEqual(["spx-sg-logistics", "shopee-sg-ads", "shopee-sg-fees"]);
  });

  it("stages and the supplier schedule (430,000)", () => {
    expect(MEI_STAGES).toEqual(RINA_STAGES);
    expect(MEI_SUPPLIER_A_SCHEDULE).toEqual(RINA_SUPPLIER_A_SCHEDULE);
    expect(MEI_SUPPLIER_A_SCHEDULE_TOTAL).toBe("430000");
    expect(meiSupplierABinding(0n)).toMatchObject({ payeeId: "supplier-a", source: "bound", lineKeys: ["SUPPLIER"] });
    expect([MEI_IDS.supplierAId, MEI_IDS.supplierAOrderId]).toEqual(["supplier-a", "order-a-001"]);
  });

  it("the platform registry names only Mei's Shopee SG payees", () => {
    expect(MEI_PLATFORM_REGISTRY.map((p) => p.payeeId).sort()).toEqual(["shopee-sg-ads", "shopee-sg-fees", "spx-sg-logistics"]);
  });

  it("intent: an SG citizen's sole proprietorship selling drinkware on Shopee from CN, SGD 10,000", () => {
    expect(MEI_PLAN_INTENT).toMatchObject({
      countryCode: "SG",
      residency: "citizen",
      entityType: "sg_sole_prop",
      productCategory: "drinkware_food_contact",
      sellChannel: "shopee",
      buyFrom: "CN",
      budgetCeilingMinor: "1000000",
    });
  });
});
