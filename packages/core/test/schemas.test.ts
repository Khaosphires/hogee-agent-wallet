import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  DerivedSpendProposal,
  PlanStage,
  RINA_IDS,
  ShortId,
  SpendProposal,
  exampleOwnerSpendPayment,
  exampleWithdrawReservePayment,
  Address,
  CONSTITUTION_CODES,
  CONSTITUTION_CODE_UINT8,
  CONTRACT_ERROR_NAMES,
  ChatDataPart,
  CountryPack,
  E1Case,
  E2PromptRow,
  E5DocRow,
  EVIDENCE_TASK_IDS,
  EvidenceRow,
  Exception,
  Hex32,
  IsoDateTime,
  Minor,
  PasskeyAssertion,
  Payment,
  PlanIntent,
  PlanManifest,
  SCHEMA_EXAMPLES,
  SCHEMA_VERSION,
  SIGNATURE_KINDS,
  SUPPLIER_CRITERION_WEIGHTS,
  SignatureSubmitBody,
  Supplier,
  SupplierEvalLabel,
  UuidV7,
  exampleCountryPack,
  exampleE5DocRow,
  exampleEvidenceRow,
  exampleExceptions,
  examplePayment,
  examplePlanIntent,
  examplePlanManifest,
  exampleSignatureSubmitPasskey,
  exampleSupplier,
  exampleSupplierEvalLabel,
  lineIdOf,
  stringToBytes32,
} from "../src/index";
import { fakeValuesIssued } from "../src/schemas/example-data/fake";

const fails = (schema: z.ZodType, value: unknown) => expect(schema.safeParse(value).success).toBe(false);
const passes = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2));
};

describe("examples", () => {
  it.each(SCHEMA_EXAMPLES.map((e) => [e.name, e] as const))("%s parses", (_name, e) => {
    passes(e.schema, e.value);
  });

  it("covers one exception per kind", () => {
    expect(new Set(exampleExceptions.map((e) => e.kind)).size).toBe(10);
  });

  it("fake hashes are unique per label", () => {
    const values = [...fakeValuesIssued().keys()];
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThan(20);
  });
});

describe("primitives", () => {
  it("Minor rejects floats, numbers, signs, leading zeros and > uint128", () => {
    passes(Minor, "0");
    passes(Minor, "1000000");
    passes(Minor, ((1n << 128n) - 1n).toString());
    for (const bad of ["1.5", "1e5", "-1", "0100", "", " 1", "1,000", (1n << 128n).toString()]) fails(Minor, bad);
    fails(Minor, 100);
    fails(Minor, 1.5);
  });

  it("Hex32 is 0x + 64 lowercase hex", () => {
    passes(Hex32, `0x${"ab".repeat(32)}`);
    fails(Hex32, `0x${"AB".repeat(32)}`);
    fails(Hex32, `0x${"ab".repeat(31)}`);
    fails(Hex32, "ab".repeat(32));
  });

  it("Address is lowercase", () => {
    passes(Address, `0x${"a".repeat(40)}`);
    fails(Address, "0xAbCdEf0000000000000000000000000000000000");
  });

  it("UuidV7 rejects v4 and uppercase", () => {
    passes(UuidV7, "01a14202-2800-7000-8000-000000000001");
    fails(UuidV7, "01a14202-2800-4000-8000-000000000001");
    fails(UuidV7, "01A14202-2800-7000-8000-00000000000A");
  });

  it("IsoDateTime requires UTC Z", () => {
    passes(IsoDateTime, "2026-10-16T02:00:00Z");
    fails(IsoDateTime, "2026-10-16T10:00:00+08:00");
    fails(IsoDateTime, "2026-10-16");
  });

  it("stringToBytes32 matches viem stringToHex(size 32)", () => {
    expect(stringToBytes32("SUPPLIER")).toBe(`0x535550504c494552${"0".repeat(48)}`);
    expect(lineIdOf("ADS")).toBe(`0x414453${"0".repeat(58)}`);
    expect(() => stringToBytes32("x".repeat(33))).toThrow();
  });
});

describe("strict objects and enums", () => {
  it("rejects an extra key in a strict object", () => {
    fails(PlanIntent, { ...examplePlanIntent, confidence: 0.9 });
    fails(Payment, { ...examplePayment, note: "x" });
    fails(Supplier, { ...exampleSupplier, offer: { ...exampleSupplier.offer, discount: "1" } });
  });

  // SG-CORE: SG became a CountryCode (SG-DECISIONS), so the bad value is now a country outside the enum.
  it("rejects a bad enum value", () => {
    fails(PlanIntent, { ...examplePlanIntent, countryCode: "TH" });
    fails(Payment, { ...examplePayment, state: "PAID" });
  });

  it("rejects number money inside domain objects", () => {
    fails(Payment, { ...examplePayment, amountMinor: 30000 });
    fails(Supplier, { ...exampleSupplier, offer: { ...exampleSupplier.offer, fobUnit: { ...exampleSupplier.offer.fobUnit, value: 12.5 } } });
  });

  it("rejects an entity type from the other country", () => {
    fails(PlanIntent, { ...examplePlanIntent, entityType: "pt_perorangan" });
  });
});

describe("plan manifest", () => {
  it("rejects a lineId that does not match its lineKey", () => {
    const [first, ...rest] = examplePlanManifest.lines;
    fails(PlanManifest, { ...examplePlanManifest, lines: [{ ...first, lineId: lineIdOf("ADS") }, ...rest] });
  });

  it("rejects duplicate lines and zero pacing", () => {
    const lines = examplePlanManifest.lines;
    fails(PlanManifest, { ...examplePlanManifest, lines: [...lines, lines[0]] });
    const ads = lines.map((l) => (l.lineKey === "ADS" ? { ...l, pacing: { period: "day", amountMinor: "0" } } : l));
    fails(PlanManifest, { ...examplePlanManifest, lines: ads });
  });

  it("stays structural: a constitution-violating plan (T21) is still representable", () => {
    const evil = { ...examplePlanManifest, reserveBps: 0, lines: examplePlanManifest.lines.map((l) => ({ ...l, perTxCapMinor: l.amountMinor })) };
    passes(PlanManifest, evil);
  });
});

describe("exceptions", () => {
  const raise = exampleExceptions.find((e) => e.kind === "RAISE_CAP")!;

  it("rejects the payload of another kind", () => {
    fails(Exception, { ...raise, payload: { payeeId: "printer-kl", lineKey: "PACKAGING" } });
    fails(Exception, { ...raise, kind: "UNPAUSE" });
  });

  it("EXTEND_EXPIRY needs lineKey for target line and forbids it for target agent", () => {
    const ext = exampleExceptions.find((e) => e.kind === "EXTEND_EXPIRY")!;
    passes(Exception, { ...ext, payload: { target: "line", lineKey: "ADS", newExpiresAt: "1797292800" } });
    fails(Exception, { ...ext, payload: { target: "line", newExpiresAt: "1797292800" } });
    fails(Exception, { ...ext, payload: { target: "agent", lineKey: "ADS", newExpiresAt: "1797292800" } });
  });

  it("UNPAUSE accepts the whole treasury or one line", () => {
    const un = exampleExceptions.find((e) => e.kind === "UNPAUSE")!;
    passes(Exception, { ...un, payload: {} });
    passes(Exception, { ...un, payload: { lineKey: "ADS" } });
  });
});

describe("other refinements", () => {
  it("VERIFIED country packs must be complete; partial packs may be RESEARCHED", () => {
    passes(CountryPack, exampleCountryPack);
    fails(CountryPack, { ...exampleCountryPack, tier: "VERIFIED" });
  });

  it("E5 spans must lie inside the text (code points)", () => {
    fails(E5DocRow, { ...exampleE5DocRow, spans: [{ start: 60, end: 99, entity: "MY_PHONE" }] });
  });

  it("supplier eval labels: excluded iff a hard-gate defect", () => {
    fails(SupplierEvalLabel, { ...exampleSupplierEvalLabel, expectedExcluded: false });
    passes(SupplierEvalLabel, { ...exampleSupplierEvalLabel, defects: [{ type: "FAKE_REPORT" }], expectedExcluded: false });
  });

  it("vague E2 prompts need a hiddenSlot", () => {
    fails(E2PromptRow, { promptId: "p", country: "MY", lang: "en", vague: true, text: "help" });
  });

  it("on-chain evidence rows need a txHash", () => {
    const { txHash: _drop, ...rest } = exampleEvidenceRow;
    fails(EvidenceRow, rest);
  });

  it("passkey s must be low-s; submit takes exactly one signature", () => {
    const pk = (exampleSignatureSubmitPasskey as { passkey: z.infer<typeof PasskeyAssertion> }).passkey;
    fails(PasskeyAssertion, { ...pk, s: `0x${"f".repeat(64)}` });
    fails(SignatureSubmitBody, { ...exampleSignatureSubmitPasskey, ecdsa: { signature: `0x${"ab".repeat(65)}` } });
  });

  it("E1Case discriminates attack vs clean rows; data parts are strict", () => {
    fails(E1Case, { caseId: "x", expected: "maybe" });
    fails(ChatDataPart, { type: "data-plan-draft", data: { draftId: "d", extra: 1 } });
  });
});

describe("frozen lists", () => {
  it("schema version and enum sizes", () => {
    expect(SCHEMA_VERSION).toBe("2.0.0");
    expect(CONTRACT_ERROR_NAMES).toHaveLength(27);
    expect(API_ERROR_CODES).toHaveLength(33);
    for (const name of ["FounderKeyAlreadySet", "MissingDecision", "SettlementClosed", "EscrowOnly"] as const) {
      expect(CONTRACT_ERROR_NAMES).toContain(name);
      expect(API_ERROR_HTTP_STATUS[name]).toBe(409);
    }
    expect(EVIDENCE_TASK_IDS).toHaveLength(12 + 33 + 2);
    expect(SIGNATURE_KINDS).toContain("OwnerSpend");
  });

  it("constitution codes are 1..14 in order (HogeeKinds.sol CONST_*)", () => {
    expect(CONSTITUTION_CODES.map((c) => CONSTITUTION_CODE_UINT8[c])).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(CONSTITUTION_CODE_UINT8.REPLAN_LOOSENS).toBe(14); // G0-AUDIT (v-1)
  });

  it("supplier weights sum to 100", () => {
    expect(Object.values(SUPPLIER_CRITERION_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("G0 review fixes", () => {
  it("D6: spend proposals carry an invoice OR a pacing slot, never payee/amount", () => {
    passes(SpendProposal, { lineKey: "ADS", pacingSlot: 0, reason: "slot" });
    passes(SpendProposal, { lineKey: "LOGISTICS", invoiceId: "inv-1", reason: "invoice" });
    fails(SpendProposal, { lineKey: "ADS", pacingSlot: 1, payeeId: "evil", reason: "x" });
    fails(SpendProposal, { lineKey: "ADS", pacingSlot: 1, amountMinor: "999999", reason: "x" });
    fails(SpendProposal, { lineKey: "ADS", pacingSlot: 1, invoiceId: "inv-1", reason: "x" });
    fails(SpendProposal, { lineKey: "ADS", reason: "x" });
    fails(SpendProposal, { lineKey: "ADS", pacingSlot: -1, reason: "x" });
    fails(DerivedSpendProposal, { lineKey: "ADS", payeeId: "shopee-ads", amountMinor: "10000" });
  });

  it("H4: decisionId/rationaleHash are null exactly for OWNER_SPEND and WITHDRAW_RESERVE", () => {
    fails(Payment, { ...examplePayment, decisionId: null });
    fails(Payment, { ...examplePayment, rationaleHash: null });
    fails(Payment, { ...exampleOwnerSpendPayment, decisionId: examplePayment.decisionId });
    fails(Payment, { ...exampleWithdrawReservePayment, rationaleHash: examplePayment.rationaleHash });
    fails(Payment, { ...exampleWithdrawReservePayment, lineKey: "ADS" });
    fails(Payment, { ...examplePayment, lineKey: null });
    const { intentId: _drop, ...noIntent } = exampleOwnerSpendPayment;
    fails(Payment, noIntent);
  });

  it("M10: on-chain numbers carry their real bit width", () => {
    const line = examplePlanManifest.lines[0]!;
    const withLine = (l: object) => ({ ...examplePlanManifest, lines: [{ ...line, ...l }, ...examplePlanManifest.lines.slice(1)] });
    passes(PlanManifest, withLine({ windowSeconds: String(2 ** 32 - 1) }));
    fails(PlanManifest, withLine({ windowSeconds: String(2 ** 32) }));
    const gate = { metric: "orders", target: ((1n << 128n) - 1n).toString(), deadline: "1" };
    passes(PlanStage, { stageId: "stage-2", releaseMinor: "1", gate });
    fails(PlanStage, { stageId: "stage-2", releaseMinor: "1", gate: { ...gate, target: (1n << 128n).toString() } });
    fails(PlanManifest, { ...examplePlanManifest, version: 2 ** 32 });
    fails(Payment, { ...examplePayment, planVersion: 0 });
    const exc = exampleExceptions.find((e) => e.kind === "RELEASE_ESCROW_BALANCE")!;
    fails(Exception, { ...exc, payload: { ...(exc.payload as object), idx: 256 } });
  });

  it("M15: Rina ids are ShortIds", () => {
    for (const [key, value] of Object.entries(RINA_IDS)) {
      if (key !== "chainId") passes(ShortId, value);
    }
  });
});
