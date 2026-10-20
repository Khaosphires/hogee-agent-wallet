/** Every world names its country: Rina (MY) and Mei (SG) with their own payees, currency and persona; nothing else. */
import { DEMO_PAYEES_BY_COUNTRY } from "../../../packages/api/src/catalog/payees";
import { describe, expect, it } from "vitest";
import { ALL_DEMO_PAYEES, DEMO_COUNTRIES, demoCountry } from "../src/country";

describe("demo countries", () => {
  it("MY is Rina's facility with the DuitNow payees; SG is Mei's with the PayNow payees", () => {
    expect(demoCountry("MY")).toMatchObject({ countryCode: "MY", currency: "MYR", facilityId: "fac-rina", founderId: "founder-rina", persona: "founder:rina" });
    expect(demoCountry("SG")).toMatchObject({ countryCode: "SG", currency: "SGD", facilityId: "fac-mei", founderId: "founder-mei", persona: "founder:mei" });
    expect(DEMO_COUNTRIES.MY.payees).toBe(DEMO_PAYEES_BY_COUNTRY.MY);
    expect(DEMO_COUNTRIES.SG.payees).toBe(DEMO_PAYEES_BY_COUNTRY.SG);
    expect(new Set(DEMO_COUNTRIES.MY.payees.map((p) => p.account.channel))).toEqual(new Set(["MY_DUITNOW"]));
    expect(new Set(DEMO_COUNTRIES.SG.payees.map((p) => p.account.channel))).toEqual(new Set(["SG_PAYNOW"]));
    expect(DEMO_COUNTRIES.SG.chatMessage).toContain("S$");
  });

  it("refuses any other country (ID has no demo payees), never falling back to MY", () => {
    for (const code of ["ID", "TH", "my", ""]) expect(() => demoCountry(code), code).toThrow(/MY or SG/);
  });

  it("ALL_DEMO_PAYEES is both registries, MY first (what a shared final-1 deploys)", () => {
    expect(ALL_DEMO_PAYEES.map((p) => p.payeeId)).toEqual([...DEMO_PAYEES_BY_COUNTRY.MY, ...DEMO_PAYEES_BY_COUNTRY.SG].map((p) => p.payeeId));
  });
});
