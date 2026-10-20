/** The demo payee sets (catalog/payees.ts): Mei's SG set mirrors Rina's MY set, and final-1 commits both. */
import { describe, expect, it } from "vitest";
import { MEI_IDS, RINA_IDS } from "@hogee/core";
import {
  ALL_DEMO_PAYEES,
  DEMO_PAYEES,
  DEMO_PAYEES_BY_COUNTRY,
  demoPayeesFor,
  payoutHashOf,
  platformPayeeDeployArgs,
  requireCountryPayees,
} from "../src/catalog/payees";

const shape = (p: (typeof ALL_DEMO_PAYEES)[number]) => ({ source: p.source, lineKey: p.lineKey, channels: p.channels });

describe("DEMO_PAYEES_BY_COUNTRY", () => {
  it("gives Mei the five MEI_IDS payees, all on SG_PAYNOW, all labelled as test accounts", () => {
    const sg = DEMO_PAYEES_BY_COUNTRY.SG;
    expect(sg.map((p) => p.payeeId)).toEqual([MEI_IDS.adsPayeeId, MEI_IDS.platformFeesPayeeId, MEI_IDS.logisticsPayeeId, MEI_IDS.taxPayeeId, MEI_IDS.packagingPayeeId]);
    for (const p of sg) {
      expect(p.account.channel, p.payeeId).toBe("SG_PAYNOW");
      expect(p.displayName, p.payeeId).toMatch(/\(test\)$/);
    }
  });

  it("keeps Rina's MY set as it was (DEMO_PAYEES), all on MY_DUITNOW", () => {
    expect(DEMO_PAYEES).toBe(DEMO_PAYEES_BY_COUNTRY.MY);
    expect(DEMO_PAYEES.map((p) => p.payeeId)).toEqual([RINA_IDS.adsPayeeId, RINA_IDS.platformFeesPayeeId, RINA_IDS.logisticsPayeeId, RINA_IDS.taxPayeeId, RINA_IDS.packagingPayeeId]);
    expect(DEMO_PAYEES.every((p) => p.account.channel === "MY_DUITNOW")).toBe(true);
  });

  it("mirrors MY line for line: iras-tax like lhdn-tax (platform, no line), the printer a vendor on PACKAGING", () => {
    expect(DEMO_PAYEES_BY_COUNTRY.SG.map(shape)).toEqual(DEMO_PAYEES_BY_COUNTRY.MY.map(shape));
    const iras = DEMO_PAYEES_BY_COUNTRY.SG.find((p) => p.payeeId === "iras-tax");
    expect(iras).toMatchObject({ source: "platform", displayName: "IRAS tax payment (test)" });
    expect(iras?.lineKey).toBeUndefined();
  });

  it("never shares an id or a payout account between countries", () => {
    const ids = ALL_DEMO_PAYEES.map((p) => p.payeeId);
    expect(new Set(ids).size).toBe(ids.length);
    const hashes = ALL_DEMO_PAYEES.map((p) => payoutHashOf(p));
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("demoPayeesFor / requireCountryPayees", () => {
  it("serves each country only its own set", () => {
    expect(demoPayeesFor("MY")).toBe(DEMO_PAYEES_BY_COUNTRY.MY);
    expect(demoPayeesFor("SG")).toBe(DEMO_PAYEES_BY_COUNTRY.SG);
  });

  it("refuses a country without a set (ID) or any other key, never falling back to Rina's", () => {
    for (const country of ["ID", "TH", "toString", "__proto__"]) expect(() => demoPayeesFor(country as never), country).toThrow(/No demo payees/);
  });

  it("refuses payees on another country's rail, naming the payee", () => {
    expect(requireCountryPayees("SG", DEMO_PAYEES_BY_COUNTRY.SG)).toBe(DEMO_PAYEES_BY_COUNTRY.SG);
    expect(() => requireCountryPayees("SG", DEMO_PAYEES_BY_COUNTRY.MY)).toThrow(/shopee-ads pays out on MY_DUITNOW, not SG's SG_PAYNOW/);
    expect(() => requireCountryPayees("MY", ALL_DEMO_PAYEES)).toThrow(/shopee-sg-ads/);
    expect(() => requireCountryPayees("ID", [])).toThrow(/No demo payees for ID/);
  });
});

describe("platformPayeeDeployArgs", () => {
  it("commits both countries' platform payees to final-1 by default, MY first, vendors never", () => {
    const args = platformPayeeDeployArgs();
    expect(args.ids).toBe("shopee-ads,shopee-fees,spx-logistics,lhdn-tax,shopee-sg-ads,shopee-sg-fees,spx-sg-logistics,iras-tax");
    const hashes = args.hashes.split(",");
    expect(hashes).toHaveLength(8);
    for (const h of hashes) expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashes[7]).toBe(payoutHashOf(DEMO_PAYEES_BY_COUNTRY.SG[3] as (typeof ALL_DEMO_PAYEES)[number]));
  });

  it("still takes an explicit list (Rina's alone gives four)", () => {
    expect(platformPayeeDeployArgs(DEMO_PAYEES).ids).toBe("shopee-ads,shopee-fees,spx-logistics,lhdn-tax");
  });
});
