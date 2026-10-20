/**
 * SG enums and schemas (SG-DECISIONS). The SG values are appended in the fixed order, MY/ID values keep their order, and
 * widening the shared enums turns no refusal into an acceptance: each country's pack may only name its own entity
 * types, registration codes and approval agencies, and an SG pack carries no turnover-based e-invoicing section.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  COUNTRY_CODES,
  CompileError,
  CountryPack,
  E2PromptRow,
  E5DocRow,
  ENTITY_TYPES,
  ENTITY_TYPES_BY_COUNTRY,
  ENTITY_TYPES_SG,
  MEI_PLAN_INTENT,
  PACK_SECTIONS_NOT_APPLICABLE,
  PII_ENTITIES,
  PRODUCT_APPROVALS,
  PRODUCT_APPROVALS_BY_COUNTRY,
  PRODUCT_APPROVAL_PRIORITY,
  PlanIntent,
  REGISTRATIONS,
  REGISTRATIONS_BY_COUNTRY,
  examplePlanIntent,
  pickProductApproval,
  type CountryPack as CountryPackT,
  type ProductApproval,
} from "../src/index";
import { TEST_PACK_ID, TEST_PACK_MY } from "./fixtures/packs";
import { TEST_PACK_SG, TEST_PACK_SG_R } from "./fixtures/pack-sg";

const fails = (schema: z.ZodType, value: unknown) => expect(schema.safeParse(value).success).toBe(false);
const issues = (schema: z.ZodType, value: unknown): string[] => {
  const r = schema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join("/")}: ${i.message}`);
};
const MY_R: CountryPackT = { ...TEST_PACK_MY, tier: "RESEARCHED" };

describe("SG enum values are appended in the SG-DECISIONS order", () => {
  it("COUNTRY_CODES, entity types, registrations, approvals and PII entities", () => {
    expect(COUNTRY_CODES).toEqual(["MY", "ID", "SG"]);
    expect(ENTITY_TYPES_SG).toEqual(["sg_sole_prop", "sg_partnership", "pte_ltd"]);
    expect(ENTITY_TYPES).toEqual(["sole_prop", "partnership", "sdn_bhd", "perorangan", "pt_perorangan", "cv", "pt", "sg_sole_prop", "sg_partnership", "pte_ltd"]);
    expect(ENTITY_TYPES_BY_COUNTRY.SG).toEqual(ENTITY_TYPES_SG);
    expect(REGISTRATIONS.slice(0, 9)).toEqual(["SSM_SOLE_PROP", "SSM_SDN_BHD", "LHDN_TIN", "SST", "MYINVOIS", "PBT_LICENCE", "NIB_OSS", "NPWP_NIK", "PKP"]);
    expect(REGISTRATIONS.slice(9)).toEqual(["ACRA_BUSINESS", "ACRA_PTE_LTD", "IRAS_GST"]);
    expect(PRODUCT_APPROVALS).toEqual(["NONE", "NPRA", "ST_SIRIM", "JAKIM_HALAL", "BPOM", "BPJPH_HALAL", "KKM_FOOD", "SFA", "HSA", "CPSO_SAFETY_MARK"]);
    expect(PII_ENTITIES).toEqual(["MY_NRIC", "ID_NIK", "ID_NPWP", "MY_BANK_ACCOUNT", "MY_PHONE", "ID_PHONE", "SG_NRIC", "SG_PHONE"]);
  });

  it("every registration code belongs to exactly one country; every agency but NONE too, and NONE to all", () => {
    for (const code of REGISTRATIONS) expect(COUNTRY_CODES.filter((c) => REGISTRATIONS_BY_COUNTRY[c].includes(code))).toHaveLength(1);
    for (const a of PRODUCT_APPROVALS) {
      const owners = COUNTRY_CODES.filter((c) => PRODUCT_APPROVALS_BY_COUNTRY[c].includes(a));
      expect(owners).toHaveLength(a === "NONE" ? COUNTRY_CODES.length : 1);
    }
    expect(REGISTRATIONS_BY_COUNTRY.SG).toEqual(["ACRA_BUSINESS", "ACRA_PTE_LTD", "IRAS_GST"]);
    expect(PRODUCT_APPROVALS_BY_COUNTRY.SG).toEqual(["NONE", "SFA", "HSA", "CPSO_SAFETY_MARK"]);
  });
});

describe("PlanIntent for SG", () => {
  it("Mei's intent parses", () => {
    expect(PlanIntent.parse(MEI_PLAN_INTENT)).toEqual(MEI_PLAN_INTENT);
  });

  it.each([
    ["SG with an MY entity", { ...MEI_PLAN_INTENT, entityType: "sole_prop" }],
    ["SG with an ID entity", { ...MEI_PLAN_INTENT, entityType: "pt" }],
    ["MY with an SG entity", { ...examplePlanIntent, entityType: "sg_sole_prop" }],
    ["ID with an SG entity", { ...examplePlanIntent, countryCode: "ID", entityType: "pte_ltd" }],
  ])("refuses %s", (_name, intent) => {
    fails(PlanIntent, intent);
  });
});

describe("CountryPack for SG", () => {
  it("the VERIFIED SG fixture parses without an eInvoicing section", () => {
    expect(CountryPack.parse(TEST_PACK_SG)).toEqual(TEST_PACK_SG);
    expect(TEST_PACK_SG.eInvoicing).toBeUndefined();
    expect(PACK_SECTIONS_NOT_APPLICABLE).toEqual({ MY: [], ID: [], SG: ["eInvoicing"] });
  });

  it("an SG pack that carries an e-invoicing turnover threshold is refused (SG has no such rule)", () => {
    expect(issues(CountryPack, { ...TEST_PACK_SG_R, eInvoicing: TEST_PACK_MY.eInvoicing })).toEqual(["eInvoicing: SG has no eInvoicing rule of this shape; leave the section out"]);
  });

  it("MY and ID are unchanged: a VERIFIED MY pack still needs eInvoicing", () => {
    const { eInvoicing: _e, ...noEInvoicing } = TEST_PACK_MY;
    expect(issues(CountryPack, noEInvoicing)).toEqual(["eInvoicing: VERIFIED packs must include eInvoicing"]);
    expect(CountryPack.safeParse(TEST_PACK_MY).success).toBe(true);
    expect(CountryPack.safeParse(TEST_PACK_ID).success).toBe(true);
  });

  it("a VERIFIED SG pack still needs every other core section", () => {
    const { imports: _i, ...noImports } = TEST_PACK_SG;
    expect(issues(CountryPack, noImports)).toEqual(["imports: VERIFIED packs must include imports"]);
  });
});

describe("enum widening turns no refusal into an acceptance: a pack names only its own country's values", () => {
  const reg = (pack: CountryPackT, code: string, entityTypes: string[] = []) => ({
    ...pack,
    registrations: [...(pack.registrations ?? []), { ...TEST_PACK_SG.registrations![2]!, code, entityTypes }],
  });
  const approval = (pack: CountryPackT, agency: string) => ({
    ...pack,
    productApprovals: { ...pack.productApprovals, cosmetics: { ...TEST_PACK_SG.productApprovals!.cosmetics!, agency: { ...TEST_PACK_SG.productApprovals!.cosmetics!.agency, value: agency } } },
  });

  it.each([
    ["an MY pack with an SG registration", reg(MY_R, "ACRA_BUSINESS"), "registrations/6/code: registration ACRA_BUSINESS is not valid for MY"],
    ["an ID pack with SG GST", reg(TEST_PACK_ID, "IRAS_GST"), "registrations/3/code: registration IRAS_GST is not valid for ID"],
    ["an SG pack with SST", reg(TEST_PACK_SG_R, "SST"), "registrations/3/code: registration SST is not valid for SG"],
    ["an SG pack with an MY entity on a registration", reg(TEST_PACK_SG_R, "IRAS_GST", ["sole_prop"]), "registrations/3/entityTypes/0: entity type sole_prop is not valid for SG"],
    ["an SG pack whose tax id is the LHDN TIN", { ...TEST_PACK_SG_R, taxIds: [{ ...TEST_PACK_SG.taxIds![0]!, code: "LHDN_TIN" }] }, "taxIds/0/code: registration LHDN_TIN is not valid for SG"],
    ["an MY pack with the HSA", approval(MY_R, "HSA"), "productApprovals/cosmetics/agency/value: approval HSA is not valid for MY"],
    ["an ID pack with the SFA", approval(TEST_PACK_ID, "SFA"), "productApprovals/cosmetics/agency/value: approval SFA is not valid for ID"],
    ["an SG pack with the NPRA", approval(TEST_PACK_SG_R, "NPRA"), "productApprovals/cosmetics/agency/value: approval NPRA is not valid for SG"],
    ["an SG pack with an MY entity", { ...TEST_PACK_SG_R, entities: [{ ...TEST_PACK_SG.entities![0]!, type: "sdn_bhd" }] }, "entities/0/type: entity type sdn_bhd is not valid for SG"],
  ] as const)("refuses %s", (_name, pack, issue) => {
    expect(issues(CountryPack, pack)).toEqual([issue]);
  });
});

describe("product approval priority", () => {
  it("ranks every agency except NONE exactly once (MY/ID order unchanged, SG appended)", () => {
    expect([...PRODUCT_APPROVAL_PRIORITY].sort()).toEqual(PRODUCT_APPROVALS.filter((a) => a !== "NONE").sort());
    expect(PRODUCT_APPROVAL_PRIORITY.slice(0, 6)).toEqual(["NPRA", "BPOM", "ST_SIRIM", "KKM_FOOD", "BPJPH_HALAL", "JAKIM_HALAL"]);
  });

  it("picks the SG agency, and refuses an agency it cannot rank instead of reading it as NONE", () => {
    expect(pickProductApproval(["HSA"])).toBe("HSA");
    expect(pickProductApproval(["NONE"])).toBe("NONE");
    expect(() => pickProductApproval(["NOT_AN_AGENCY" as ProductApproval])).toThrow(CompileError);
  });
});

describe("SG dataset rows", () => {
  it("E2 prompts and E5 PII spans accept SG", () => {
    expect(E2PromptRow.safeParse({ promptId: "e2-sg-001", country: "SG", lang: "en", vague: false, text: "I sell tumblers on Shopee Singapore." }).success).toBe(true);
    const text = "NRIC S1234567D, call +65 9123 4567";
    expect(E5DocRow.safeParse({ docId: "e5-sg-001", text, spans: [{ start: 5, end: 14, entity: "SG_NRIC" }, { start: 21, end: 34, entity: "SG_PHONE" }] }).success).toBe(true);
  });
});
