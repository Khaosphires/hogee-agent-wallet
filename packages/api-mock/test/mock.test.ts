/**
 * api-mock behaviour beyond the contract test: scripted transitions, digest parity with @hogee/chain, the attack
 * table, the chat stream, replay mode and the seed source (evidence reading: evidence.test.ts).
 * Run: pnpm --filter @hogee/api-mock test
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hashTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashPlanApproval, hogeeDomain } from "@hogee/chain";
import {
  TIMELOCK_EXCEPTION_KINDS,
  examplePasskeyRegistrationResult,
  exampleSignatureSubmitPasskey,
  readCatalogScheduleRows,
  type Balances,
  type EscrowSchedule,
  type PasskeyAssertion,
  type Payment,
  type PlanDraft,
  type SignatureRequestResponse,
} from "@hogee/core";
import { ATTACKS } from "../src/attacks";
import { scheduleHash } from "../src/eip712";
import { readEnv } from "../src/env";
import { keyFromSpki } from "../src/handlers-core";
import { p256PublicKey, verifyPasskeyAssertion } from "../src/signature-check";
import { getState } from "../src/store";
import { harness, json, profile, secret } from "./support/harness";

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
  process.env.DEMO_TIMELOCK_SECONDS = "2";
});

afterEach(() => {
  vi.useRealTimers();
});

const { app } = await import("../src/index");
const { cookie, call } = harness(app);

/** A fresh P-256 key: its SPKI (base64url, as response.publicKey) and its point as the API returns it. */
function p256Key(): { spki: string; qx: string; qy: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const hex = (b64: string | undefined) => `0x${Buffer.from(b64 ?? "", "base64url").toString("hex")}`;
  return { spki: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), qx: hex(jwk.x), qy: hex(jwk.y), privateKey };
}

describe("seed", () => {
  it("loads P3's fixtures when present, else the core examples (never both for one file)", async () => {
    const { readEnv, seedSources } = await import("../src/index");
    const env = readEnv();
    // SG (the default): P3's scenario-mei file, else Rina's re-issued for Mei; MY: scenario-rina, else the core example.
    const folder = profile().scenarioFolder;
    const onDisk = existsSync(join(env.fixturesDir, folder, "balances.json"));
    expect(seedSources(env)["balances.json"]).toBe(onDisk ? "fixture" : env.country === "SG" ? "derived" : "example");
  });

  it("serves a session in mock mode", async () => {
    const { body } = await call<{ mode: string; persona: string }>("/api/session");
    expect(body.mode).toBe("mock");
    expect(body.persona).toBe(profile().founderPersona);
  });

  it("an officer cookie needs the operator token", async () => {
    const res = await app.request("/api/session/persona", json({ persona: "officer", officerToken: secret() }));
    expect(res.status).toBe(403);
    expect((await call<{ persona: string }>("/api/session", {}, "officer")).body.persona).toBe("officer");
  });
});

describe("scripted payment", () => {
  it("walks PROPOSED → SETTLED and moves the pocket when mined", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    await call("/api/demo/reset", json({}), "officer");
    const before = (await call<Balances>("/api/balances")).body.pockets.find((p) => p.lineKey === "ADS");
    const proposed = await call<{ verdict: string; reasonCode: string; paymentId?: string }>("/api/proposals/spend", json({ lineKey: "ADS", pacingSlot: 9, reason: "Daily ads slot" }));
    expect(proposed.body).toMatchObject({ verdict: "AUTO", reasonCode: "WITHIN_PLAN" });
    const id = proposed.body.paymentId ?? "";
    expect((await call<Payment>(`/api/payments/${id}`)).body.state).toBe("PROPOSED");
    vi.setSystemTime(new Date("2026-10-17T00:00:07Z"));
    const settled = (await call<Payment & { traces: unknown[] }>(`/api/payments/${id}`)).body;
    expect(settled.state).toBe("SETTLED");
    expect(settled.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(settled.payout.status).toBe("SUCCEEDED");
    expect(settled.traces.length).toBeGreaterThanOrEqual(4);
    const after = (await call<Balances>("/api/balances")).body.pockets.find((p) => p.lineKey === "ADS");
    expect(BigInt(after?.spent ?? "0") - BigInt(before?.spent ?? "0")).toBe(BigInt(settled.amountMinor));
  });

  it("counts payments still in flight against the window cap (no overspend before the first one is mined)", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const verdicts: string[] = [];
    for (let slot = 200; slot < 215; slot += 1) {
      verdicts.push((await call<{ verdict: string }>("/api/proposals/spend", json({ lineKey: "ADS", pacingSlot: slot, reason: "burst" }))).body.verdict);
    }
    const balances = (await call<Balances>("/api/balances")).body.pockets.find((p) => p.lineKey === "ADS");
    const plan = (await call<{ manifest: { lines: { lineKey: string; pacing?: { amountMinor: string } }[] } }>("/api/plans/current")).body;
    const pacing = BigInt(plan.manifest.lines.find((l) => l.lineKey === "ADS")?.pacing?.amountMinor ?? "1");
    const headroom = BigInt(balances?.windowCap ?? "0") - BigInt(balances?.windowSpent ?? "0");
    expect(BigInt(verdicts.filter((v) => v === "AUTO").length) * pacing).toBeLessThanOrEqual(headroom);
    expect(verdicts.at(-1)).toBe("DENY");
  });

  it("refuses an invoice whose payee is not on the line (PayeeNotBound), never trusting the caller", async () => {
    const { body } = await call<{ verdict: string; reasonCode: string }>("/api/proposals/spend", json({ lineKey: "LOGISTICS", invoiceId: "inv-0001", reason: "Pay this" }));
    expect(body).toMatchObject({ verdict: "DENY", reasonCode: "PayeeNotBound" });
  });
});

describe("escalations and intents (P1 review of #5)", () => {
  type Plan = { manifest: { lines: { lineKey: string; payeeIds: string[]; pacing?: { amountMinor: string } }[] } };
  type ApiErr = { error: { code: string } };

  /** An escalation as the server's spend path would open it (no route lets a caller create one). */
  function seedEscalation(id: string, proposal: { lineKey: "ADS"; payeeId: string; amountMinor: string; pacingSlot: number }): void {
    getState(readEnv()).exceptions.set(id, {
      exception: {
        exceptionId: id,
        kind: "POLICY_ESCALATION",
        payload: { proposal },
        title: "Escalated ADS spend",
        requestedBy: "agent",
        requires: { founder: false, lender: true },
        status: "OPEN",
        timelock: null,
        txs: {},
        blastRadiusMinor: proposal.amountMinor,
        traceId: `trace-${id}`,
      },
    });
  }

  it("refuses a caller-built POLICY_ESCALATION with 422", async () => {
    const res = await call<ApiErr>(
      "/api/exceptions",
      json({ kind: "POLICY_ESCALATION", payload: { proposal: { lineKey: "ADS", payeeId: "attacker", amountMinor: "99999999", pacingSlot: 1 } }, reason: "pay me" }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("an approved escalation still needs a bound payee and room under the caps, and is traced as an officer override", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const ads = (await call<Plan>("/api/plans/current")).body.manifest.lines.find((l) => l.lineKey === "ADS");
    const payments = async () => (await call<Payment[]>("/api/payments")).body;
    const before = (await payments()).length;

    seedEscalation("exc-attacker", { lineKey: "ADS", payeeId: "attacker", amountMinor: "99999999", pacingSlot: 1 });
    const refused = await call<ApiErr>("/api/exceptions/exc-attacker/approve", json({}), "officer");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PayeeNotBound");
    expect(getState(readEnv()).exceptions.get("exc-attacker")?.exception.status).toBe("OPEN");
    expect((await payments()).length).toBe(before);

    seedEscalation("exc-bound", { lineKey: "ADS", payeeId: ads?.payeeIds[0] ?? "", amountMinor: ads?.pacing?.amountMinor ?? "1", pacingSlot: 2 });
    const approved = await call<{ outcome: string; exception: { status: string } }>("/api/exceptions/exc-bound/approve", json({}), "officer");
    expect(approved.body).toMatchObject({ outcome: "APPROVED", exception: { status: "EXECUTED" } });
    const paid = (await payments())[0];
    const traces = (await call<{ traces: { kind: string; reasonCode?: string; summary: string }[] }>(`/api/payments/${paid?.paymentId}`)).body.traces;
    const verdict = traces.find((t) => t.kind === "POLICY_VERDICT");
    expect(verdict?.reasonCode).toBe("OFFICER_OVERRIDE");
    expect(verdict?.summary).toMatch(/^Officer override/);
  });

  it("pays a pacing slot once; a retry ends in DuplicateIntent", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const propose = async () => (await call<{ verdict: string; reasonCode: string }>("/api/proposals/spend", json({ lineKey: "ADS", pacingSlot: 300, reason: "slot 300" }))).body;
    expect(await propose()).toMatchObject({ verdict: "AUTO" });
    expect(await propose()).toMatchObject({ verdict: "DENY", reasonCode: "DuplicateIntent" });
  });

  it("never replaces a registered credential's public key (FounderKeyAlreadySet)", async () => {
    await call("/api/demo/reset", json({}), "officer");
    // Real P-256 keys: an off-curve point is refused before any of this (#6 LOW 3).
    const [first, second] = [p256Key(), p256Key()];
    let clientDataJSON = "e30";
    const register = (publicKey: string) =>
      call<{ qx?: string; onchain?: string; error?: { code: string } }>(
        "/api/passkey/register/verify",
        json({ id: "cred-swap-test", rawId: "cred-swap-test", type: "public-key", response: { clientDataJSON, attestationObject: "o2Nm", publicKey }, clientExtensionResults: {} }),
      );
    // Audit run-7: one key slot, so the seeded example key is rejected first.
    expect((await call("/api/officer/founder-key/reject", json({ credentialId: examplePasskeyRegistrationResult.credentialId }), "officer")).status).toBe(200);
    // G2: a new credential needs the loan officer's one-time enrolment code, presented at register/options; the
    // registration answers the challenge those options returned (audit run-7).
    const { body: issued } = await call<{ code: string }>("/api/officer/founder-key/enrolment-code", json({}), "officer");
    const { body: opts } = await call<{ challenge: string }>("/api/passkey/register/options", json({ enrolmentCode: issued.code }));
    clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge })).toString("base64url");
    const stored = await register(first.spki);
    expect(stored.body).toMatchObject({ onchain: "PENDING_LENDER", qx: first.qx });
    expect((await register(first.spki)).body.qx).toBe(first.qx);
    const swap = await register(second.spki);
    expect(swap.status).toBe(409);
    expect(swap.body.error?.code).toBe("FounderKeyAlreadySet");
    expect((await register(first.spki)).body.qx).toBe(first.qx);
  });

  it("REPLAY must be a plain run id", () => {
    for (const bad of ["..", "a/../b", "run..1", ".hidden"]) {
      process.env.REPLAY = bad;
      expect(() => readEnv(), bad).toThrow();
    }
    delete process.env.REPLAY;
  });
});

describe("founder keys (P1 review of #6, LOW 2 and 3)", () => {
  type Err = { error?: { code: string; contractError?: { name: string } } };
  const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const reject = (credentialId: string) => call("/api/officer/founder-key/reject", json({ credentialId }), "officer");
  const options = async () => {
    const { body: issued } = await call<{ code: string }>("/api/officer/founder-key/enrolment-code", json({}), "officer");
    return (await call<{ challenge: string; excludeCredentials?: { type: string; id: string }[] }>("/api/passkey/register/options", json({ enrolmentCode: issued.code }))).body;
  };
  const verify = (id: string, challenge: string, publicKey: string) =>
    call<{ qx?: string; onchain?: string } & Err>(
      "/api/passkey/register/verify",
      json({ id, rawId: id, type: "public-key", response: { clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge })).toString("base64url"), attestationObject: "o2Nm", publicKey }, clientExtensionResults: {} }),
    );
  /** The SPKI of `k` with the last byte of y changed: the same shape, a point off the curve. */
  const offCurve = (k: { spki: string }) => {
    const der = Buffer.from(k.spki, "base64url");
    der[der.length - 1] = (der[der.length - 1] ?? 0) ^ 1;
    return der.toString("base64url");
  };

  it("reads only a DER SPKI whose point is on P-256, as registerFounderKey wants it", () => {
    const k = p256Key();
    expect(keyFromSpki(k.spki)).toEqual({ qx: k.qx, qy: k.qy });
    expect(keyFromSpki(offCurve(k))).toBeUndefined();
    // The shape the old byte check accepted: 0x04 then 64 bytes, without a valid SPKI or point.
    expect(keyFromSpki(Buffer.concat([Buffer.alloc(26), Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString("base64url"))).toBeUndefined();
    const k1 = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    expect(keyFromSpki(k1)).toBeUndefined();
    expect(keyFromSpki("not-base64-der")).toBeUndefined();
    expect(p256PublicKey(k)).toBeDefined();
    expect(p256PublicKey({ qx: `0x${P256_P.toString(16)}`, qy: k.qy })).toBeUndefined();
    expect(p256PublicKey({ qx: k.qx, qy: `0x${P256_P.toString(16)}` })).toBeUndefined();
    expect(p256PublicKey({ qx: `0x${"00".repeat(32)}`, qy: `0x${"00".repeat(32)}` })).toBeUndefined();
    expect(p256PublicKey(examplePasskeyRegistrationResult)).toBeUndefined();
  });

  it("register refuses an off-curve key (VALIDATION) and gives the enrolment code back", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const { challenge } = await options();
    const k = p256Key();
    const id = randomBytes(16).toString("base64url");
    const refused = await verify(id, challenge, offCurve(k));
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe("VALIDATION");
    expect(getState(readEnv()).founderKeys.has(id)).toBe(false);
    expect((await verify(id, challenge, k.spki)).body).toMatchObject({ onchain: "PENDING_LENDER", qx: k.qx, qy: k.qy });
  });

  it("approve refuses a key off the curve (the seeded placeholder): InvalidSignature, nothing registered", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const founderId = (await call<{ founderId: string }>("/api/session")).body.founderId;
    const { credentialId, qx, qy } = examplePasskeyRegistrationResult;
    const res = await call<Err>("/api/officer/founder-key/approve", json({ founderId, credentialId, qx, qy }), "officer");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "CONFLICT", contractError: { name: "InvalidSignature" } });
    expect(getState(readEnv()).founderKeys.get(credentialId)?.onchain).toBe("PENDING_LENDER");
    expect(getState(readEnv()).traces.some((t) => t.summary.includes("registered the founder's passkey"))).toBe(false);
  });

  it("register options exclude the founder's current key, never a rejected one or the seeded example", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const first = await options();
    expect(first.excludeCredentials).toEqual([]);
    const id = randomBytes(16).toString("base64url");
    expect((await verify(id, first.challenge, p256Key().spki)).body.onchain).toBe("PENDING_LENDER");
    expect((await options()).excludeCredentials).toEqual([{ type: "public-key", id }]);
    expect((await reject(id)).status).toBe(200);
    expect((await options()).excludeCredentials).toEqual([]);
  });
  it("a fresh store shows the officer no pending key: the seeded example never does (P1, g2-ui)", async () => {
    await call("/api/demo/reset", json({}), "officer");
    expect((await call<unknown>("/api/officer/founder-key/pending", {}, "officer")).body).toBeNull();
    const { challenge } = await options();
    const id = randomBytes(16).toString("base64url");
    expect((await verify(id, challenge, p256Key().spki)).body.onchain).toBe("PENDING_LENDER");
    expect((await call<{ credentialId: string }>("/api/officer/founder-key/pending", {}, "officer")).body.credentialId).toBe(id);
  });
});

describe("signing", () => {
  it("PlanApproval digest equals @hogee/chain hashPlanApproval over the same message", async () => {
    const draftId = (await call<{ draftId: string }>("/api/plans/draft", json({ sessionId: profile().sessionId }))).body.draftId;
    const { body } = await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "PlanApproval", refId: draftId, method: "passkey" }));
    const m = body.typedData.message as Record<string, string>;
    const domain = hogeeDomain({
      verifyingContract: body.typedData.domain.verifyingContract as `0x${string}`,
      chainTag: "0x7365706f6c696100000000000000000000000000000000000000000000000000",
      deploymentId: m.deploymentId as `0x${string}`,
    });
    expect(domain.salt).toBe(body.typedData.domain.salt);
    const viaChain = hashPlanApproval(domain, {
      planId: m.planId as `0x${string}`,
      version: Number(m.version),
      prevPlanHash: m.prevPlanHash as `0x${string}`,
      planHash: m.planHash as `0x${string}`,
      countryPackHash: m.countryPackHash as `0x${string}`,
      linesHash: m.linesHash as `0x${string}`,
      stagesHash: m.stagesHash as `0x${string}`,
      totalMinor: BigInt(m.totalMinor ?? "0"),
      reserveBps: Number(m.reserveBps),
      agent: m.agent as `0x${string}`,
      agentExpiry: BigInt(m.agentExpiry ?? "0"),
      deploymentId: m.deploymentId as `0x${string}`,
      nonce: BigInt(m.nonce ?? "0"),
      expiry: BigInt(m.expiry ?? "0"),
    } as Parameters<typeof hashPlanApproval>[1]);
    expect(body.digest).toBe(viaChain);
    // The browser recomputes it generically from typedData alone (SignDialog).
    const generic = hashTypedData({
      domain: body.typedData.domain as Parameters<typeof hashTypedData>[0]["domain"],
      types: body.typedData.types,
      primaryType: body.typedData.primaryType,
      message: Object.fromEntries(
        (body.typedData.types[body.typedData.primaryType] ?? []).map((f) => [f.name, f.type.startsWith("uint") ? BigInt(String(m[f.name])) : m[f.name]]),
      ),
    } as Parameters<typeof hashTypedData>[0]);
    expect(generic).toBe(body.digest);
    expect(Buffer.from(body.challengeB64url, "base64url").toString("hex")).toBe(body.digest.slice(2));
    expect(body.displayModel.rows.some((r) => r.effect === "loosen")).toBe(true);
  });
});

describe("signature verification (P1 review of #5, point 9)", () => {
  const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  type ApiErr = { error: { code: string; message: string } };
  const hex32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A registration attempt for a fresh P-256 key, with the officer's one-time code (G2) and its bound challenge. */
  async function registerAttempt(): Promise<{ credentialId: string; privateKey: KeyObject; status: number; body: { onchain?: string } & Partial<ApiErr> }> {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const credentialId = randomBytes(16).toString("base64url");
    const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const { body: issued } = await call<{ code: string }>("/api/officer/founder-key/enrolment-code", json({}), "officer");
    const { body: opts } = await call<{ challenge: string }>("/api/passkey/register/options", json({ enrolmentCode: issued.code }));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge })).toString("base64url");
    const res = await call<{ onchain?: string } & Partial<ApiErr>>(
      "/api/passkey/register/verify",
      json({ id: credentialId, rawId: credentialId, type: "public-key", response: { clientDataJSON, attestationObject: "o2Nm", publicKey: spki }, clientExtensionResults: {} }),
    );
    return { credentialId, privateKey, ...res };
  }

  /** A P-256 key registered as the founder's passkey (PENDING_LENDER), on a reset store: G2 keeps one key slot. */
  async function registeredKey(): Promise<{ credentialId: string; privateKey: KeyObject }> {
    await call("/api/demo/reset", json({}), "officer");
    const { credentialId, privateKey, body } = await registerAttempt();
    expect(body.onchain).toBe("PENDING_LENDER");
    return { credentialId, privateKey };
  }

  /** What a platform authenticator returns for `challenge`, encoded as the web app does (low-s, byte offsets). */
  function assertion(privateKey: KeyObject, credentialId: string, challenge: string): PasskeyAssertion {
    const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:3000", crossOrigin: false });
    const authenticatorData = Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([0x05, 0, 0, 0, 1])]);
    const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
    const sig = sign("sha256", signed, { key: privateKey, dsaEncoding: "ieee-p1363" });
    const s = BigInt(`0x${sig.subarray(32).toString("hex")}`);
    return {
      credentialId,
      r: `0x${sig.subarray(0, 32).toString("hex")}`,
      s: hex32(s > P256_N >> 1n ? P256_N - s : s),
      challengeIndex: clientDataJSON.indexOf('"challenge"'),
      typeIndex: clientDataJSON.indexOf('"type"'),
      authenticatorData: `0x${authenticatorData.toString("hex")}`,
      clientDataJSON,
    };
  }

  async function planRequest(): Promise<SignatureRequestResponse> {
    const draftId = (await call<{ draftId: string }>("/api/plans/draft", json({ sessionId: profile().sessionId }))).body.draftId;
    return (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "PlanApproval", refId: draftId, method: "passkey" }))).body;
  }

  const submit = (requestId: string, body: unknown) => call<{ state?: string } & Partial<ApiErr>>(`/api/signatures/${requestId}/submit`, json(body));

  it("accepts the founder's passkey over this request's digest, once", async () => {
    const { credentialId, privateKey } = await registeredKey();
    const req = await planRequest();
    const signed = assertion(privateKey, credentialId, req.challengeB64url);
    expect((await submit(req.requestId, { passkey: signed })).body.state).toBe("BROADCAST");
    expect((await submit(req.requestId, { passkey: signed })).body.error?.code).toBe("CONFLICT");
  });

  it("refuses a key that is not the founder's (InvalidSignature)", async () => {
    const { credentialId } = await registeredKey();
    const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const req = await planRequest();
    const wrongKey = await submit(req.requestId, { passkey: assertion(stranger, credentialId, req.challengeB64url) });
    expect(wrongKey.body.error?.code).toBe("InvalidSignature");
    const unknown = await submit(req.requestId, { passkey: assertion(stranger, randomBytes(16).toString("base64url"), req.challengeB64url) });
    expect(unknown.body.error?.code).toBe("InvalidSignature");
  });

  it("refuses an assertion over another challenge, and the request stays usable", async () => {
    const { credentialId, privateKey } = await registeredKey();
    const [req, other] = [await planRequest(), await planRequest()];
    const replayed = await submit(req.requestId, { passkey: assertion(privateKey, credentialId, other.challengeB64url) });
    expect(replayed.body.error?.code).toBe("InvalidSignature");
    const wrongType = assertion(privateKey, credentialId, req.challengeB64url);
    const created = { ...wrongType, clientDataJSON: wrongType.clientDataJSON.replace("webauthn.get", "webauthn.create") };
    expect((await submit(req.requestId, { passkey: created })).body.error?.code).toBe("InvalidSignature");
    expect((await submit(req.requestId, { passkey: assertion(privateKey, credentialId, req.challengeB64url) })).body.state).toBe("BROADCAST");
  });

  it("refuses high-s (the schema answers VALIDATION; the verifier alone says no too)", async () => {
    const { credentialId, privateKey } = await registeredKey();
    const req = await planRequest();
    const low = assertion(privateKey, credentialId, req.challengeB64url);
    const high = { ...low, s: hex32(P256_N - BigInt(low.s)) };
    const res = await submit(req.requestId, { passkey: high });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION");
    const pub = createPublicKey(privateKey).export({ format: "jwk" });
    const key = { qx: `0x${Buffer.from(pub.x ?? "", "base64url").toString("hex")}`, qy: `0x${Buffer.from(pub.y ?? "", "base64url").toString("hex")}` };
    expect(verifyPasskeyAssertion(low, key, req.challengeB64url)).toBe(true);
    expect(verifyPasskeyAssertion(high, key, req.challengeB64url)).toBe(false);
  });

  it("verifies a real Chrome virtual-authenticator vector (e2e/vectors)", () => {
    const vector = JSON.parse(readFileSync(join(readEnv().repoRoot, "e2e", "vectors", "passkey-1.json"), "utf8")) as PasskeyAssertion & { digest: string; qx: string; qy: string };
    const challenge = Buffer.from(vector.digest.slice(2), "hex").toString("base64url");
    expect(verifyPasskeyAssertion(vector, vector, challenge)).toBe(true);
    const counter = vector.authenticatorData.slice(0, -1) + (vector.authenticatorData.endsWith("0") ? "1" : "0");
    expect(verifyPasskeyAssertion({ ...vector, authenticatorData: counter }, vector, challenge)).toBe(false);
  });

  it("a key the officer rejected signs nothing while no key is registered (P1, g2-ui)", async () => {
    const { credentialId, privateKey } = await registeredKey();
    expect((await call("/api/officer/founder-key/reject", json({ credentialId }), "officer")).status).toBe(200);
    const signedPlans = () => getState(readEnv()).traces.filter((t) => t.summary.startsWith("Founder signed PlanApproval")).length;
    const before = signedPlans();
    const req = await planRequest();
    const refused = await submit(req.requestId, { passkey: assertion(privateKey, credentialId, req.challengeB64url) });
    expect(refused.body.error?.code).toBe("InvalidSignature");
    expect(signedPlans()).toBe(before);
    expect([...getState(readEnv()).founderKeys.values()].some((k) => k.onchain === "REGISTERED")).toBe(false);
  });

  // Audit run-8 critic gap 3: a country-switch preview is stored as a draft (<base>-my). PlanApproval used to sign it,
  // and to commit it as the facility's plan when its version was above the current one (a replan's preview); a v1
  // preview re-stamped the committed plan's txHash. Live refuses previews (packages/api signing/plan-approval.ts).
  it("never signs or commits a country preview as the facility's plan", async () => {
    const { credentialId, privateKey } = await registeredKey();
    const base = (await call<PlanDraft>("/api/plans/draft", json({ sessionId: profile().sessionId }))).body;
    const st = getState(readEnv());
    const replan: PlanDraft = { ...base, draftId: "draft-replan-002", manifest: { ...base.manifest, version: base.manifest.version + 1 } };
    st.drafts.set(replan.draftId, replan);
    const plansBefore = st.plans.map((p) => ({ ...p }));
    for (const country of ["MY", "ID"] as const) {
      const preview = (await call<PlanDraft>("/api/plans/preview-country", json({ draftId: replan.draftId, country }))).body;
      expect([preview.manifest.countryCode, preview.manifest.version]).toEqual([country, replan.manifest.version]);
      const res = await call<SignatureRequestResponse & Partial<ApiErr>>("/api/signatures/request", json({ kind: "PlanApproval", refId: preview.draftId, method: "passkey" }));
      expect([res.status, res.body.error?.code], country).toEqual([409, "CONFLICT"]);
      expect(res.body.error?.message).toMatch(/preview/i);
    }
    // A request for the facility's own replan whose draft is swapped for another country's before the submit.
    const req = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "PlanApproval", refId: replan.draftId, method: "passkey" }))).body;
    st.drafts.set(replan.draftId, { ...replan, intent: { ...replan.intent, countryCode: "MY" }, manifest: { ...replan.manifest, countryCode: "MY" } });
    const refused = await submit(req.requestId, { passkey: assertion(privateKey, credentialId, req.challengeB64url) });
    expect(refused.body.error?.code).toBe("CONFLICT");
    expect(getState(readEnv()).plans).toEqual(plansBefore);
    // The facility's own replan still signs and commits.
    st.drafts.set(replan.draftId, replan);
    const own = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "PlanApproval", refId: replan.draftId, method: "passkey" }))).body;
    expect((await submit(own.requestId, { passkey: assertion(privateKey, credentialId, own.challengeB64url) })).body.state).toBe("BROADCAST");
    const committed = getState(readEnv()).plans.find((p) => p.status === "COMMITTED");
    expect([committed?.manifest.version, committed?.manifest.countryCode]).toEqual([replan.manifest.version, profile().country]);
  });

  it("with HOGEE_COUNTRY=MY (Rina), an SG preview is refused the same way", async () => {
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    await registeredKey();
    const base = (await call<PlanDraft>("/api/plans/draft", json({ sessionId: profile().sessionId }))).body;
    expect(base.intent.countryCode).toBe("MY");
    const preview = (await call<PlanDraft>("/api/plans/preview-country", json({ draftId: base.draftId, country: "SG" }))).body;
    const res = await call<Partial<ApiErr>>("/api/signatures/request", json({ kind: "PlanApproval", refId: preview.draftId, method: "passkey" }));
    expect(res.body.error?.code).toBe("CONFLICT");
  });

  it("SupplierApproval takes a shortlisted supplier id, as live: its order, or its first order once signed (P1, g2-ui)", async () => {
    type Req = SignatureRequestResponse & Partial<ApiErr>;
    const { credentialId, privateKey } = await registeredKey();
    const request = (refId: string) => call<Req>("/api/signatures/request", json({ kind: "SupplierApproval", refId, method: "passkey" }));
    const { ids, orderPrefix } = profile();
    const a = await request(ids.supplierAId);
    expect(a.status).toBe(200);
    expect(a.body.displayModel.rows[0]).toMatchObject({ label: "Order", value: ids.supplierAOrderId });
    // Re-check review LOW 2: the catalog milestones the panel shows recompute to the signed scheduleHash and totalMinor.
    const shown = readCatalogScheduleRows(a.body.displayModel.rows);
    expect(shown).toBeDefined();
    const am = a.body.typedData.message;
    expect(scheduleHash(shown?.map((x) => x.amountMinor) ?? [], shown?.map((x) => x.autoRelease) ?? [])).toBe(am.scheduleHash);
    expect(shown?.reduce((t, x) => t + x.amountMinor, 0n).toString()).toBe(am.totalMinor);
    expect(shown?.map((x) => x.autoRelease)).toEqual([true, true, false]);
    const orderB = `${orderPrefix}b-001`;
    const b = await request("supplier-b");
    expect(b.body.displayModel.rows[0]?.value).toBe(orderB);
    expect((await call(`/api/escrow/${orderB}`)).status).toBe(404);
    expect((await submit(b.body.requestId, { passkey: assertion(privateKey, credentialId, b.body.challengeB64url) })).body.state).toBe("BROADCAST");
    const schedule = (await call<EscrowSchedule>(`/api/escrow/${orderB}`)).body;
    expect(schedule.map((m) => [m.autoRelease, m.funded === m.amountMinor])).toEqual([[true, true], [true, true], [false, false]]);
    expect((await call<{ orderId: string | null }>("/api/suppliers/supplier-b")).body.orderId).toBe(orderB);
    // Excluded from the shortlist (supplier-c), or not a supplier id: refused as live refuses it.
    expect((await request("supplier-c")).status).toBe(404);
    expect((await request("nobody")).status).toBe(404);
  });

  it("refuses the core example assertion (placeholder key and challenge)", async () => {
    const req = await planRequest();
    expect((await submit(req.requestId, exampleSignatureSubmitPasskey)).body.error?.code).toBe("InvalidSignature");
  });

  it("a malformed HOGEE_MOCK_OWNER_EOA refuses wallet signatures and nothing else", async () => {
    vi.stubEnv("HOGEE_MOCK_OWNER_EOA", "not-an-address");
    expect((await call<{ persona: string }>("/api/session")).status).toBe(200);
    const req = await planRequest();
    const sig = await privateKeyToAccount(generatePrivateKey()).sign({ hash: req.digest as `0x${string}` });
    const res = await submit(req.requestId, { ecdsa: { signature: sig } });
    expect(res.body.error).toMatchObject({ code: "InvalidSignature", message: expect.stringContaining("HOGEE_MOCK_OWNER_EOA") });
  });

  it("the officer registers one founder key per facility; a second answers FounderKeyAlreadySet", async () => {
    const founderId = (await call<{ founderId: string }>("/api/session")).body.founderId;
    const registered = await registeredKey();
    const keys = getState(readEnv()).founderKeys;
    const first = keys.get(registered.credentialId);
    // G2 (one key slot): a second credential is refused while the first is pending, before any approval.
    const pendingSecond = await registerAttempt();
    expect(pendingSecond.status).toBe(409);
    expect(pendingSecond.body.error?.code).toBe("FounderKeyAlreadySet");
    const approve = (k: typeof first) => call<{ state?: string; error?: { code: string } }>("/api/officer/founder-key/approve", json({ founderId, credentialId: k?.credentialId, qx: k?.qx, qy: k?.qy }), "officer");
    expect((await approve(first)).body.state).toBe("BROADCAST");
    // G2 parity with the live API: approving again once a key is registered answers FounderKeyAlreadySet (one trace).
    expect((await approve(first)).body.error?.code).toBe("FounderKeyAlreadySet");
    expect(getState(readEnv()).traces.filter((t) => t.summary.includes("registered the founder's passkey")).length).toBe(1);
    // Once a key is registered, no further credential registers.
    const afterRegistered = await registerAttempt();
    expect(afterRegistered.status).toBe(409);
    expect(afterRegistered.body.error?.code).toBe("FounderKeyAlreadySet");
    expect(keys.has(afterRegistered.credentialId)).toBe(false);
    await call("/api/demo/reset", json({}), "officer");
  });

  describe("the signer behind a FOUNDER_SIGNED loosening (P1, after the #6 re-review; fix-mock)", () => {
    type Exc = { exceptionId: string; status: string };
    type Approved = { outcome?: string; exception?: Exc } & Partial<{ error: { code: string; contractError?: { name: string } } }>;
    type Key = { credentialId: string; privateKey: KeyObject };
    const ask = async () =>
      (await call<Exc>("/api/exceptions", json({ kind: "RAISE_CAP", payload: { lineKey: "ADS", cap: "perTx", newCapMinor: "150000" }, reason: "Peak season ads" }))).body.exceptionId;
    const founderSigns = async (exceptionId: string, k: Key) => {
      const req = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "LoosenRequest", refId: exceptionId, method: "passkey" }))).body;
      return submit(req.requestId, { passkey: assertion(k.privateKey, k.credentialId, req.challengeB64url) });
    };
    const officerApproves = (exceptionId: string) => call<Approved>(`/api/exceptions/${exceptionId}/approve`, json({}), "officer");
    const statusOf = (exceptionId: string) => getState(readEnv()).exceptions.get(exceptionId)?.exception.status;
    const reject = (k: Key) => call("/api/officer/founder-key/reject", json({ credentialId: k.credentialId }), "officer");
    async function register(k: Key): Promise<number> {
      const founderId = (await call<{ founderId: string }>("/api/session")).body.founderId;
      const stored = getState(readEnv()).founderKeys.get(k.credentialId);
      return (await call("/api/officer/founder-key/approve", json({ founderId, credentialId: k.credentialId, qx: stored?.qx, qy: stored?.qy }), "officer")).status;
    }
    /** A new pending key after a reject (registerAttempt asks the officer for a fresh code). */
    async function nextKey(): Promise<Key> {
      const { credentialId, privateKey, body } = await registerAttempt();
      expect(body.onchain).toBe("PENDING_LENDER");
      return { credentialId, privateKey };
    }

    it("queues as before when that key is still the founder's: pending, or registered meanwhile (flow-loosen)", async () => {
      const pending = await registeredKey();
      const first = await ask();
      expect((await founderSigns(first, pending)).body.state).toBe("BROADCAST");
      expect(statusOf(first)).toBe("FOUNDER_SIGNED");
      expect(getState(readEnv()).exceptions.get(first)?.founderSig).toEqual({ kind: "passkey", credentialId: pending.credentialId });
      expect((await officerApproves(first)).body).toMatchObject({ outcome: "APPROVED", exception: { status: "QUEUED" } });

      const second = await ask();
      expect((await founderSigns(second, pending)).body.state).toBe("BROADCAST");
      expect(await register(pending)).toBe(200);
      expect((await officerApproves(second)).body).toMatchObject({ outcome: "APPROVED", exception: { status: "QUEUED" } });
    });

    it("refuses the officer's approval once the officer rejected that key; the request is open again, the key signs nothing", async () => {
      const rejected = await registeredKey();
      const exceptionId = await ask();
      expect((await founderSigns(exceptionId, rejected)).body.state).toBe("BROADCAST");
      expect((await reject(rejected)).status).toBe(200);
      const refused = await officerApproves(exceptionId);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: "CONFLICT", contractError: { name: "InvalidSignature" } });
      expect(statusOf(exceptionId)).toBe("OPEN");
      expect(getState(readEnv()).exceptions.get(exceptionId)?.exception.timelock).toBeNull();
      expect((await founderSigns(exceptionId, rejected)).body.error?.code).toBe("InvalidSignature");
      expect(statusOf(exceptionId)).toBe("OPEN");
    });

    it("refuses it once another key is registered; signed again with that key, it queues", async () => {
      const replaced = await registeredKey();
      const exceptionId = await ask();
      expect((await founderSigns(exceptionId, replaced)).body.state).toBe("BROADCAST");
      expect((await reject(replaced)).status).toBe(200);
      const current = await nextKey();
      expect(await register(current)).toBe(200);
      expect((await officerApproves(exceptionId)).body.error).toMatchObject({ code: "CONFLICT", contractError: { name: "InvalidSignature" } });
      expect(statusOf(exceptionId)).toBe("OPEN");
      expect((await founderSigns(exceptionId, current)).body.state).toBe("BROADCAST");
      expect((await officerApproves(exceptionId)).body).toMatchObject({ outcome: "APPROVED", exception: { status: "QUEUED" } });
      await call("/api/demo/reset", json({}), "officer");
    });

    it("records a MetaMask signer as the wallet's address; the officer's approval queues it as before", async () => {
      await call("/api/demo/reset", json({}), "officer");
      const owner = privateKeyToAccount(generatePrivateKey());
      vi.stubEnv("HOGEE_MOCK_OWNER_EOA", owner.address);
      const exceptionId = await ask();
      const req = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "LoosenRequest", refId: exceptionId, method: "eip712" }))).body;
      expect((await submit(req.requestId, { ecdsa: { signature: await owner.sign({ hash: req.digest as `0x${string}` }) } })).body.state).toBe("BROADCAST");
      expect(getState(readEnv()).exceptions.get(exceptionId)?.founderSig).toEqual({ kind: "wallet", address: owner.address });
      expect((await officerApproves(exceptionId)).body).toMatchObject({ outcome: "APPROVED", exception: { status: "QUEUED" } });
    });

    // Run-8 lead (rejected by P1's verifier): seeded rows are the owner's status gallery, not a founder's signature.
    it("marks seeded FOUNDER_SIGNED rows seeded-fixture, and the officer approves them exactly as before", async () => {
      await call("/api/demo/reset", json({}), "officer");
      const seeded = [...getState(readEnv()).exceptions.values()].filter((se) => se.exception.status === "FOUNDER_SIGNED");
      expect(seeded.length).toBeGreaterThan(0);
      for (const se of seeded) expect(se.founderSig).toEqual({ kind: "seeded-fixture" });
      const loosening = seeded.find((se) => (TIMELOCK_EXCEPTION_KINDS as readonly string[]).includes(se.exception.kind));
      if (!loosening) throw new Error("the seed has no FOUNDER_SIGNED loosening (fixtures/scenario-rina/exceptions.json)");
      expect((await officerApproves(loosening.exception.exceptionId)).body).toMatchObject({ outcome: "APPROVED", exception: { status: "QUEUED" } });
      await call("/api/demo/reset", json({}), "officer");
    });
  });

  it("ECDSA: HOGEE_MOCK_OWNER_EOA that is the lender's or an agent key's address signs nothing (#6 LOW 7)", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const owner = privateKeyToAccount(generatePrivateKey());
    vi.stubEnv("HOGEE_MOCK_OWNER_EOA", owner.address);
    const st = getState(readEnv());
    const signedBy = async () => {
      const req = await planRequest();
      return submit(req.requestId, { ecdsa: { signature: await owner.sign({ hash: req.digest as `0x${string}` }) } });
    };
    const lender = st.facility.lenderAddress;
    st.facility = { ...st.facility, lenderAddress: owner.address.toLowerCase() as typeof lender };
    expect((await signedBy()).body.error).toMatchObject({ code: "InvalidSignature", message: expect.stringContaining("HOGEE_MOCK_OWNER_EOA") });
    st.facility = { ...st.facility, lenderAddress: lender };
    const plans = st.plans;
    st.plans = plans.map((p) => ({ ...p, manifest: { ...p.manifest, agent: { ...p.manifest.agent, address: owner.address } } }));
    expect((await signedBy()).body.error).toMatchObject({ code: "InvalidSignature", message: expect.stringContaining("HOGEE_MOCK_OWNER_EOA") });
    st.plans = plans;
    expect((await signedBy()).body.state).toBe("BROADCAST");
    await call("/api/demo/reset", json({}), "officer");
  });

  it("ECDSA: refused while no founder wallet is set; accepted only from HOGEE_MOCK_OWNER_EOA", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const req = await planRequest();
    const ownerSig = await owner.sign({ hash: req.digest as `0x${string}` });
    expect((await submit(req.requestId, { ecdsa: { signature: ownerSig } })).body.error?.code).toBe("InvalidSignature");
    vi.stubEnv("HOGEE_MOCK_OWNER_EOA", owner.address);
    const strangerSig = await stranger.sign({ hash: req.digest as `0x${string}` });
    expect((await submit(req.requestId, { ecdsa: { signature: strangerSig } })).body.error?.code).toBe("InvalidSignature");
    expect((await submit(req.requestId, { ecdsa: { signature: ownerSig } })).body.state).toBe("BROADCAST");
  });
});

describe("demo attacks (§13.2)", () => {
  const REVERTS: Record<string, string> = {
    T1: "PayeeNotBound", T2: "NotOwner", T4: "CapExceeded", T5: "MilestoneLocked", T6: "NotOwner", T7: "DuplicateIntent",
    T8: "ReserveLocked", T9: "TimelockActive", T10: "Paused", T15: "AgentExpired", T16: "SignatureExpired", T17: "DuplicateInvoice",
    T18: "AmountExceedsSchedule", T20: "StalePlan", T21: "PlanInvariantViolated", T23: "DuplicateSale", T24: "NotOracle", T28: "InvalidSignature",
  };
  it.each(Object.entries(REVERTS))("%s forced send reverts %s", async (attackId, revert) => {
    expect(ATTACKS[attackId as keyof typeof ATTACKS]?.revert).toBe(revert);
    const { body } = await call<{ forced?: { revertReason: string }; refusal: { kind: string } }>("/api/demo/attack", json({ attackId }));
    expect(body.refusal.kind).toBe("DENIAL");
    expect(body.forced?.revertReason).toBe(revert);
  });

  it("covers every T1..T33 and both headline demos", () => {
    for (let i = 1; i <= 33; i += 1) expect(ATTACKS[`T${i}` as keyof typeof ATTACKS], `T${i}`).toBeDefined();
    expect(ATTACKS["D-poison"]).toBeDefined();
    expect(ATTACKS["D-plug"]).toBeDefined();
  });

  it("is off without DEMO_MODE", async () => {
    process.env.DEMO_MODE = "0";
    const res = await app.request("/api/demo/attack", json({ attackId: "T1" }));
    process.env.DEMO_MODE = "1";
    expect(res.status).toBe(404);
  });
});

describe("chat stream", () => {
  it("streams text and a frozen data-question part, and keeps the history", async () => {
    const sessionId = "01a14202-2800-7000-8000-00000000c0de";
    const res = await app.request("/api/chat", { ...json({ sessionId, message: "I want to sell tumblers on Shopee" }), headers: { "content-type": "application/json", cookie: await cookie("founder") } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"text-delta"');
    expect(text).toContain('"type":"data-question"');
    const history = await call<{ role: string }[]>(`/api/chat/${sessionId}`);
    expect(history.body.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("reserve withdrawal (P1 review of #6)", () => {
  type Exc = { exceptionId: string; status: string; error?: { code: string; message: string } };
  const st = () => getState(readEnv());
  const ask = (taxPayeeId: string, amountMinor: string) =>
    call<Exc>("/api/exceptions", json({ kind: "WITHDRAW_RESERVE", payload: { taxPayeeId, amountMinor }, reason: "Quarterly tax" }));
  /** A fresh store with a known reserve: the seed's reserve differs between the core examples and P3's fixtures ("0"). */
  async function resetWithReserve(reserve: string): Promise<string> {
    await call("/api/demo/reset", json({}), "officer");
    st().balances = { ...st().balances, reserveMinor: reserve };
    return reserve;
  }

  it("goes only to the tax payee and never above the reserve", async () => {
    const reserve = await resetWithReserve("2500");
    const attacker = await ask("attacker", "1");
    expect(attacker.status).toBe(422);
    expect(attacker.body.error?.message).toContain(profile().ids.taxPayeeId);
    const tooMuch = await ask(profile().ids.taxPayeeId, (BigInt(reserve) + 1n).toString());
    expect(tooMuch.status).toBe(409);
    expect((await ask(profile().ids.taxPayeeId, reserve)).body.status).toBe("OPEN");
  });

  it("is re-checked when the officer approves and when the timelock executes", async () => {
    const reserve = await resetWithReserve("2500");
    const { exceptionId } = (await ask(profile().ids.taxPayeeId, reserve)).body;
    st().balances = { ...st().balances, reserveMinor: "0" };
    const approve = await call<Exc>(`/api/exceptions/${exceptionId}/approve`, json({}), "officer");
    expect(approve.status).toBe(409);

    // Queued and past its timelock, but the reserve shrank meanwhile: the executor leaves it EXECUTABLE, pays nothing.
    // Counted in the store, and `before` before it is queued: any request runs the executor first (http.ts advance).
    const withdrawals = () => st().payments.filter((sp) => sp.payment.kind === "WITHDRAW_RESERVE").length;
    const before = withdrawals();
    const se = st().exceptions.get(exceptionId);
    if (!se) throw new Error("exception missing");
    se.exception = { ...se.exception, status: "QUEUED", timelock: { queuedAt: "1", executableAt: "2" } };
    se.queuedByMock = true;
    const listed = async () => (await call<Payment[]>("/api/payments")).body.filter((p) => p.kind === "WITHDRAW_RESERVE").length;
    expect(await listed()).toBe(before);
    expect(withdrawals()).toBe(before);
    expect(st().exceptions.get(exceptionId)?.exception.status).toBe("EXECUTABLE");
    st().balances = { ...st().balances, reserveMinor: reserve };
    expect(await listed()).toBe(before + 1);
    expect(withdrawals()).toBe(before + 1);
    expect(st().exceptions.get(exceptionId)?.exception.status).toBe("EXECUTED");
  });

  it("is re-checked when the founder signs after the officer approved: refused, nothing signed or queued (#6 LOW 5)", async () => {
    const reserve = await resetWithReserve("2500");
    const owner = privateKeyToAccount(generatePrivateKey());
    vi.stubEnv("HOGEE_MOCK_OWNER_EOA", owner.address);
    try {
      const { exceptionId } = (await ask(profile().ids.taxPayeeId, reserve)).body;
      expect((await call<{ exception: Exc }>(`/api/exceptions/${exceptionId}/approve`, json({}), "officer")).body.exception.status).toBe("APPROVED");
      const req = (await call<SignatureRequestResponse>("/api/signatures/request", json({ kind: "LoosenRequest", refId: exceptionId, method: "eip712" }))).body;
      const signature = await owner.sign({ hash: req.digest as `0x${string}` });
      const submit = () => call<{ state?: string; error?: { code: string; contractError?: { name: string } } }>(`/api/signatures/${req.requestId}/submit`, json({ ecdsa: { signature } }));
      const founderSignedTraces = () => st().traces.filter((t) => t.summary === "Founder signed LoosenRequest with MetaMask").length;
      const tracesBefore = founderSignedTraces();

      st().balances = { ...st().balances, reserveMinor: "0" };
      const refused = await submit();
      expect(refused.body.error).toMatchObject({ code: "CapExceeded", contractError: { name: "CapExceeded" } });
      expect(st().exceptions.get(exceptionId)?.exception.status).toBe("APPROVED");
      expect(founderSignedTraces()).toBe(tracesBefore);

      // The request was not used up: once the reserve holds the amount again, the same signature queues it.
      st().balances = { ...st().balances, reserveMinor: reserve };
      expect((await submit()).body.state).toBe("BROADCAST");
      expect(st().exceptions.get(exceptionId)?.exception.status).toBe("QUEUED");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("replay", () => {
  it("reports replay mode and serves only that run", async () => {
    process.env.REPLAY = "run-that-does-not-exist";
    const session = await call<{ mode: string }>("/api/session");
    const runs = await call<unknown[]>("/api/evidence/runs");
    delete process.env.REPLAY;
    expect(session.body.mode).toBe("replay");
    expect(runs.body).toEqual([]);
  });
});
