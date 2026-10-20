/**
 * WITHDRAW_RESERVE's destination is bound to the server country's tax payee (security audit run-8 hardening, critic
 * gap 6): final-1 holds both countries' platform payees, so the chain alone accepts iras-tax on an MY server, lhdn-tax
 * on an SG one, or a line's platform payee. The request, the signed operands and the policy context name only the
 * server's own (lhdn-tax for MY, iras-tax for SG); the live path is in test/live/flows.live.test.ts (9b, 9c). A line
 * binding is platform only when Treasury's static registry holds it (an ADD_PAYEE vendor has the same unlimited cap).
 */
import { describe, expect, it } from "vitest";
import { MEI_IDS, RINA_IDS, type CountryCode } from "@hogee/core";
import { HOGEE_KINDS, shortIdToBytes32, ZERO_BYTES32 } from "../src/chain-lib";
import { DEMO_PAYEES_BY_COUNTRY, payoutHashOf, taxPayeeFor } from "../src/catalog/payees";
import type { ApiDeps } from "../src/context";
import { ApiProblem } from "../src/http/problem";
import { loosenFields, reserveTaxPayee } from "../src/services/exceptions";
import { loosenIn } from "../src/services/loosen";
import { payeesOf, platformPayeeIdsOf, taxPayeeEntries } from "../src/services/policy-context";
import type { LineView } from "../src/services/snapshot";
import { fakeDeps } from "./support/fake-deps";

const CURRENCY = { MY: "MYR", SG: "SGD", ID: "IDR" } as const;

function server(country: CountryCode, onChainHash?: (payeeId: string) => string | undefined): ApiDeps {
  const base = fakeDeps().deps;
  const client = { readContract: async ({ args }: { args: readonly [string] }) => onChainHash?.(args[0]) ?? `0x${"0".repeat(64)}` };
  return { ...base, config: { ...base.config, countryCode: country, currency: CURRENCY[country] }, client: client as never };
}

const withdraw = (taxPayeeId: string) => ({ kind: "WITHDRAW_RESERVE" as const, payload: { amountMinor: "5000", taxPayeeId } });

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiProblem);
  return (error as ApiProblem).failure;
}

const CASES = [
  { country: "MY", own: RINA_IDS.taxPayeeId, other: MEI_IDS.taxPayeeId, line: RINA_IDS.logisticsPayeeId, ads: RINA_IDS.adsPayeeId, vendor: RINA_IDS.packagingPayeeId },
  { country: "SG", own: MEI_IDS.taxPayeeId, other: RINA_IDS.taxPayeeId, line: MEI_IDS.logisticsPayeeId, ads: MEI_IDS.adsPayeeId, vendor: MEI_IDS.packagingPayeeId },
] as const;

describe("taxPayeeFor", () => {
  it("is lhdn-tax for MY and iras-tax for SG: a static platform payee on no line, on the country's own rail", () => {
    expect(taxPayeeFor("MY")).toMatchObject({ payeeId: "lhdn-tax", source: "platform", account: { channel: "MY_DUITNOW" } });
    expect(taxPayeeFor("SG")).toMatchObject({ payeeId: "iras-tax", source: "platform", account: { channel: "SG_PAYNOW" } });
    expect(taxPayeeFor("MY").lineKey).toBeUndefined();
    expect(taxPayeeFor("SG").lineKey).toBeUndefined();
  });

  it("throws for a country without a payee set (ID), never lending another country's", () => {
    expect(() => taxPayeeFor("ID")).toThrow(/No reserve tax payee for ID/);
  });
});

describe.each(CASES)("the $country server's reserve destination", ({ country, own, other, line, ads, vendor }) => {
  const deps = server(country);

  it(`refuses ${other} (the other country's tax payee), the marketplace payees ${ads} and ${line}, and the ADD_PAYEE vendor ${vendor}`, async () => {
    for (const bad of [other, ads, line, vendor, MEI_IDS.adsPayeeId, RINA_IDS.adsPayeeId, "", "LHDN-TAX", "IRAS-TAX"].filter((x) => x !== own)) {
      expect(await refusal(loosenIn(deps, withdraw(bad))), bad).toEqual({ code: "CONFLICT", message: `The reserve goes only to the tax payee ${own}` });
      expect(await refusal(loosenFields(deps, withdraw(bad))), bad).toMatchObject({ code: "CONFLICT" });
    }
    expect(() => reserveTaxPayee(deps, undefined)).toThrow(ApiProblem);
  });

  it(`accepts ${own}: the core request and the signed target name it`, async () => {
    const request = await loosenIn(deps, withdraw(own));
    expect(request).toMatchObject({ kind: "WITHDRAW_RESERVE", taxPayeeId: { value: own }, amountMinor: { value: "5000" } });
    expect(await loosenFields(deps, withdraw(own))).toEqual({
      kind: HOGEE_KINDS.LOOSEN_WITHDRAW_RESERVE,
      target: shortIdToBytes32(own),
      aux: ZERO_BYTES32,
      newValue: 5000n,
    });
  });
});

describe("an ID server has no reserve destination", () => {
  it("refuses every tax payee", async () => {
    const deps = server("ID");
    for (const id of [RINA_IDS.taxPayeeId, MEI_IDS.taxPayeeId]) {
      expect(await refusal(loosenIn(deps, withdraw(id)))).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/no tax payee/) });
    }
  });
});

describe("taxPayeeEntries (the policy context's static registry entry)", () => {
  const registered = (payeeId: string) => {
    const p = [...DEMO_PAYEES_BY_COUNTRY.MY, ...DEMO_PAYEES_BY_COUNTRY.SG].find((x) => shortIdToBytes32(x.payeeId).toLowerCase() === payeeId.toLowerCase());
    return p ? payoutHashOf(p) : undefined;
  };

  it.each(CASES)("lists only the $country server's own tax payee, on no line, when final-1 registers both", async ({ country, own, other }) => {
    const entries = await taxPayeeEntries(server(country, registered), []);
    expect(entries).toEqual([{ payeeId: own, source: "platform", lineKeys: [], lifetimeCapMinor: ((1n << 128n) - 1n).toString(), paidMinor: "0" }]);
    expect(entries.some((e) => e.payeeId === other)).toBe(false);
  });

  it("lists nothing when the chain holds no payout hash for it, or another account's (PayeeNotBound)", async () => {
    expect(await taxPayeeEntries(server("SG"), [])).toEqual([]);
    expect(await taxPayeeEntries(server("SG", () => payoutHashOf(taxPayeeFor("MY"))), [])).toEqual([]);
  });

  it("lists nothing for ID, and never twice for a payee the lines already list", async () => {
    expect(await taxPayeeEntries(server("ID", registered), [])).toEqual([]);
    const listed = [{ payeeId: "lhdn-tax", source: "platform" as const, lineKeys: ["ADS" as const], paidMinor: "0" }];
    expect(await taxPayeeEntries(server("MY", registered), listed)).toEqual([]);
  });
});

describe("payeesOf / platformPayeeIdsOf (platform = Treasury's static registry, never the lifetime cap)", () => {
  const MAX = (1n << 128n) - 1n;
  const binding = (payeeId: string, lifetimeCapMinor: bigint) => ({
    payeeId: shortIdToBytes32(payeeId),
    bound: true,
    coolingUntil: 0n,
    lifetimeCapMinor,
    paidMinor: 0n,
    payoutAccountHash: shortIdToBytes32("acct"),
  });
  const view = (bindings: ReturnType<typeof binding>[]) => ({ bindings }) as unknown as LineView;
  const registered = (payeeId: string) => {
    const p = DEMO_PAYEES_BY_COUNTRY.MY.find((x) => x.source === "platform" && shortIdToBytes32(x.payeeId).toLowerCase() === payeeId.toLowerCase());
    return p ? payoutHashOf(p) : undefined;
  };

  it("reads an ADD_PAYEE vendor bound with an unlimited cap as bound, and a registry payee as platform", async () => {
    const packaging = view([binding(RINA_IDS.packagingPayeeId, MAX)]);
    const ads = view([binding(RINA_IDS.adsPayeeId, MAX)]);
    const platform = await platformPayeeIdsOf(server("MY", registered), [packaging, ads]);
    expect([...platform]).toEqual([shortIdToBytes32(RINA_IDS.adsPayeeId).toLowerCase()]);
    expect(payeesOf("PACKAGING", packaging, platform)).toMatchObject([{ payeeId: RINA_IDS.packagingPayeeId, source: "bound", lineKeys: ["PACKAGING"] }]);
    expect(payeesOf("ADS", ads, platform)).toMatchObject([{ payeeId: RINA_IDS.adsPayeeId, source: "platform", lineKeys: ["ADS"] }]);
  });

  it("reads nothing as platform when the chain registers nothing", async () => {
    const ads = view([binding(RINA_IDS.adsPayeeId, MAX)]);
    const platform = await platformPayeeIdsOf(server("MY"), [ads]);
    expect(platform.size).toBe(0);
    expect(payeesOf("ADS", ads, platform)[0]?.source).toBe("bound");
  });
});
