/**
 * G2 founder-key enrolment without a database: the code hash is Ethereum Keccak-256 (never NIST SHA3), compared in
 * constant time; the registration challenge is bound to the code; the route gates (persona, body) come first.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError, ENROLMENT_CODE_BYTES, EnrolmentCode, exampleEnrolmentCode } from "@hogee/core";
import { createApiApp } from "../src/app";
import { enrolmentCodeHash, sameHash } from "../src/services/enrolment";
import { RegistrationError, issueRegistrationChallenge, parseRegistration } from "../src/services/signing/webauthn";
import { SoftAuthenticator } from "./support/authenticator";
import { fakeDeps } from "./support/fake-deps";

const json = { "content-type": "application/json" };
const errorOf = async (res: Response) => ApiError.parse(await res.json()).error;

describe("enrolment code hash", () => {
  it("is keccak256(utf8(code)) as Ethereum computes it, not NIST SHA3-256", () => {
    expect(enrolmentCodeHash("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(enrolmentCodeHash("abc")).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    expect(enrolmentCodeHash("abc")).not.toBe(`0x${createHash("sha3-256").update("abc").digest("hex")}`);
  });

  it("compares 32-byte hashes in constant time and refuses anything else", () => {
    const h = enrolmentCodeHash(exampleEnrolmentCode);
    expect(sameHash(h, h.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(sameHash(h, enrolmentCodeHash(`${exampleEnrolmentCode.slice(0, -1)}A`))).toBe(false);
    expect(sameHash(h, "0x1234")).toBe(false);
    expect(sameHash("", "")).toBe(false);
  });

  it("a freshly generated code is a valid EnrolmentCode", () => {
    for (let i = 0; i < 50; i += 1) expect(EnrolmentCode.safeParse(randomBytes(ENROLMENT_CODE_BYTES).toString("base64url")).success).toBe(true);
  });
});

describe("the registration challenge is bound to the enrolment code", () => {
  const secret = Buffer.from(randomBytes(32));
  const rp = { rpId: "localhost", origins: ["http://localhost:3000"] };
  const bound = (code: string) => `fac-1|founder-1|${enrolmentCodeHash(code)}`;

  it("verifies under the code it was issued for, and fails as CHALLENGE under any other code", () => {
    const auth = new SoftAuthenticator();
    const codeA = randomBytes(ENROLMENT_CODE_BYTES).toString("base64url");
    const codeB = randomBytes(ENROLMENT_CODE_BYTES).toString("base64url");
    const reg = auth.register(issueRegistrationChallenge(secret, bound(codeA), Date.now()));
    expect(parseRegistration(reg, { ...rp, secret, binding: bound(codeA), nowMs: Date.now() }).credentialId).toBe(auth.credentialIdB64);
    expect(() => parseRegistration(reg, { ...rp, secret, binding: bound(codeB), nowMs: Date.now() })).toThrow(new RegistrationError("CHALLENGE"));
    expect(() => parseRegistration(reg, { ...rp, secret, binding: "fac-1|founder-1", nowMs: Date.now() })).toThrow(new RegistrationError("CHALLENGE"));
  });
});

describe("route gates come before any enrolment logic", () => {
  const app = (f = fakeDeps()) => ({ f, app: createApiApp(async () => f.deps, {}) });

  it("registration options without an enrolment code, or with a malformed one, are 422 VALIDATION", async () => {
    const { f, app: a } = app();
    for (const body of [{}, { enrolmentCode: "short" }, { enrolmentCode: exampleEnrolmentCode, extra: 1 }]) {
      const res = await a.request("/api/passkey/register/options", { method: "POST", headers: { ...json, cookie: f.cookie("founder:rina") }, body: JSON.stringify(body) });
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });

  it.each([
    ["GET", "/api/officer/founder-key/pending", undefined],
    ["POST", "/api/officer/founder-key/enrolment-code", {}],
    ["POST", "/api/officer/founder-key/reject", { credentialId: "Y3JlZC1yaW5hLTAwMQ" }],
  ] as const)("%s %s is officer-only (403 for the founder and for no cookie)", async (method, path, body) => {
    const { f, app: a } = app();
    for (const cookie of [f.cookie("founder:rina"), ""]) {
      const res = await a.request(path, { method, headers: { ...json, ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe("FORBIDDEN");
    }
  });

  it("a caller-built POLICY_ESCALATION is refused by the schema (422) before the handler", async () => {
    const { f } = app();
    let ran = false;
    const a = createApiApp(async () => f.deps, { createException: () => ((ran = true), Promise.reject(new Error("unreachable"))) });
    const res = await a.request("/api/exceptions", {
      method: "POST",
      headers: { ...json, cookie: f.cookie("founder:rina") },
      body: JSON.stringify({ kind: "POLICY_ESCALATION", payload: { proposal: { lineKey: "ADS", payeeId: "attacker", amountMinor: "1", pacingSlot: 1 } }, reason: "pay me" }),
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    expect(ran).toBe(false);
  });
});
