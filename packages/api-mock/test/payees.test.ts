/**
 * P1 (binding): the mock's demo payee accounts are the live API's, so both sign the same payout hashes. Mei's pay to the
 * synthetic PayNow UEN proxies S99ZZ0001A..S99ZZ0005E on SG_PAYNOW.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MEI_IDS, RINA_IDS, type SignatureRequestResponse } from "@hogee/core";
// Test-only: @hogee/api exports no catalog, so the parity check reads the API's source directly.
import { DEMO_PAYEES_BY_COUNTRY, payoutHashOf } from "../../api/src/catalog/payees";
import { DEMO_PAYEE_ACCOUNTS, demoPayoutHash } from "../src/payees";
import { harness, json, secret } from "./support/harness";

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const { app } = await import("../src/index");
const { call } = harness(app);

describe("demo payee accounts", () => {
  it("equal the live API's catalog, payee for payee, so the payout hashes match", () => {
    for (const country of ["SG", "MY"] as const) {
      const api = Object.fromEntries(DEMO_PAYEES_BY_COUNTRY[country].map((p) => [p.payeeId, p.account]));
      expect(DEMO_PAYEE_ACCOUNTS[country]).toEqual(api);
      for (const p of DEMO_PAYEES_BY_COUNTRY[country]) expect(demoPayoutHash(country, p.payeeId)).toBe(payoutHashOf(p));
    }
    expect(Object.values(DEMO_PAYEE_ACCOUNTS.SG).map((a) => `${a.channel}:${a.accountNumber}`)).toEqual(
      ["S99ZZ0001A", "S99ZZ0002B", "S99ZZ0003C", "S99ZZ0004D", "S99ZZ0005E"].map((n) => `SG_PAYNOW:${n}`),
    );
  });

  it("never lend one demo's payee to the other", () => {
    expect(demoPayoutHash("SG", RINA_IDS.packagingPayeeId)).toBeUndefined();
    expect(demoPayoutHash("MY", MEI_IDS.packagingPayeeId)).toBeUndefined();
    expect(demoPayoutHash("SG", "__proto__")).toBeUndefined();
  });
});

describe("ADD_PAYEE (as the live API: onboarded payees only, signed with their payout hash)", () => {
  const ask = (payeeId: string) => call<{ exceptionId?: string; error?: { code: string } }>("/api/exceptions", json({ kind: "ADD_PAYEE", payload: { payeeId, lineKey: "PACKAGING" }, reason: "Packaging printer" }));

  it("SG: Mei's printer is signed with its PayNow payout hash; Rina's printer is refused", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const { body } = await ask(MEI_IDS.packagingPayeeId);
    const req = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "LoosenRequest", refId: body.exceptionId, method: "passkey" }))).body;
    expect(req.typedData.message.newValue).toBe(BigInt(demoPayoutHash("SG", MEI_IDS.packagingPayeeId) ?? "0x0").toString());
    const refused = await ask(RINA_IDS.packagingPayeeId);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("CONFLICT");
  });

  it("MY: Rina's printer is signed with its DuitNow payout hash", async () => {
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    await call("/api/demo/reset", json({}), "officer");
    const { body } = await ask(RINA_IDS.packagingPayeeId);
    const req = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "LoosenRequest", refId: body.exceptionId, method: "passkey" }))).body;
    expect(req.typedData.message.newValue).toBe(BigInt(demoPayoutHash("MY", RINA_IDS.packagingPayeeId) ?? "0x0").toString());
    expect((await ask(MEI_IDS.packagingPayeeId)).status).toBe(409);
  });
});
