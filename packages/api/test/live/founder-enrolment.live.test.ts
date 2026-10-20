/**
 * G2 (closes security-audit run-4 lead 5) on Anvil + Postgres: founder-key enrolment needs the loan officer's one-time
 * code. Issue, revoke, expire (wall clock), reuse, single use under a race, the challenge bound to the code, register
 * without a code (403), the pending key for the officer, reject then re-enrol, and an approval of a rejected key refused.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, ChainAction, ENROLMENT_CODE_TTL_SECONDS, EnrolmentCode, PasskeyRegistrationOptions, PasskeyRegistrationResult, PendingFounderKey, keccak256Utf8 } from "@hogee/core";
import { EnrolmentCodeResult } from "@hogee/api-contract";
import { SoftAuthenticator } from "../support/authenticator";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { issueEnrolmentCode, json, registerWith } from "../support/steps";
import { newWorld, type World } from "../support/world";

const errorOf = async (res: Response) => ApiError.parse(await res.json()).error;
const NEVER_ISSUED = "AAAAAAAAAAAAAAAAAAAAAAAA";

describe.skipIf(!LIVE)("founder-key enrolment codes (live, G2)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  const q = () => live.db.$client;
  const pending = async () => (await w.officer.get("/api/officer/founder-key/pending")).json() as Promise<unknown>;
  const optionsWith = (code: string) => w.founder.post("/api/passkey/register/options", { enrolmentCode: code });
  const challengeFor = async (code: string) => (await json(await optionsWith(code), PasskeyRegistrationOptions)).challenge;
  const founderKey = async () =>
    (await q().query("select passkey_credential_id, key_status from founders where facility_id = $1 and id = $2", [w.facilityId, w.founderId])).rows[0];
  const registerActions = async () =>
    (await q().query(`select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'PlanRegistry.registerFounderKey'`, [w.facilityId])).rows[0].n as number;
  const withClock = async <T>(offsetMs: number, fn: () => Promise<T>): Promise<T> => {
    const real = w.deps.clock;
    Object.assign(w.deps, { clock: () => Date.now() + offsetMs });
    try {
      return await fn();
    } finally {
      Object.assign(w.deps, { clock: real });
    }
  };

  beforeAll(async () => {
    live = await openLive();
    w = await newWorld(live);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("before the facility opens: no pending key, no code", async () => {
    expect(await pending()).toBeNull();
    expect((await w.officer.post("/api/officer/founder-key/enrolment-code")).status).toBe(409);
    await json(await w.officer.post("/api/facility/open", { capMinor: "1000000", reserveFloorBps: 300 }), ChainAction);
    await w.pump();
    expect(await pending()).toBeNull();
  });

  it("register without a code: options refuse a missing (422) or never-issued code (403); verify with no open code is 403", async () => {
    expect((await w.founder.post("/api/passkey/register/options", {})).status).toBe(422);
    const res = await optionsWith(NEVER_ISSUED);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("FORBIDDEN");
    const forged = await w.founder.post("/api/passkey/register/verify", new SoftAuthenticator().register(Buffer.alloc(40, 7).toString("base64url")));
    expect(forged.status).toBe(403);
    expect((await founderKey()).passkey_credential_id).toBeNull();
  });

  it("issues a 144-bit code valid 15 minutes; stores only its keccak256 and never traces it", async () => {
    const before = Date.now();
    const issued = await json(await w.officer.post("/api/officer/founder-key/enrolment-code"), EnrolmentCodeResult);
    expect(EnrolmentCode.safeParse(issued.code).success).toBe(true);
    const ttl = Date.parse(issued.expiresAt) - before;
    expect(ttl).toBeGreaterThanOrEqual(ENROLMENT_CODE_TTL_SECONDS * 1000 - 1000);
    expect(ttl).toBeLessThanOrEqual(ENROLMENT_CODE_TTL_SECONDS * 1000 + 5000);
    const rows = (await q().query("select * from founder_enrolment_codes where facility_id = $1", [w.facilityId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].code_hash).toBe(keccak256Utf8(issued.code));
    expect(JSON.stringify(rows)).not.toContain(issued.code);
    const traces = (await q().query("select summary from traces where facility_id = $1", [w.facilityId])).rows.map((r) => r.summary as string);
    expect(traces.some((t) => /enrolment code/.test(t))).toBe(true);
    expect(traces.join("\n")).not.toContain(issued.code);
    expect((await optionsWith(issued.code)).status).toBe(200);
  });

  it("a newer code revokes the open one", async () => {
    const a = await issueEnrolmentCode(w);
    const b = await issueEnrolmentCode(w);
    expect((await optionsWith(a)).status).toBe(403);
    expect((await optionsWith(b)).status).toBe(200);
    const open = await q().query("select count(*)::int as n from founder_enrolment_codes where facility_id = $1 and used_at is null and revoked_at is null", [w.facilityId]);
    expect(open.rows[0].n).toBe(1);
  });

  it("a code expires after 15 minutes of wall-clock time", async () => {
    const code = await issueEnrolmentCode(w);
    expect((await withClock(ENROLMENT_CODE_TTL_SECONDS * 1000 - 30_000, () => optionsWith(code))).status).toBe(200);
    const late = await withClock(ENROLMENT_CODE_TTL_SECONDS * 1000 + 1000, () => optionsWith(code));
    expect(late.status).toBe(403);
    expect((await errorOf(late)).code).toBe("FORBIDDEN");
  });

  it("a challenge is bound to its code: once the code is replaced, its challenge cannot register (403)", async () => {
    const challenge = await challengeFor(await issueEnrolmentCode(w));
    await issueEnrolmentCode(w);
    const res = await w.founder.post("/api/passkey/register/verify", new SoftAuthenticator().register(challenge));
    expect(res.status).toBe(403);
    expect((await founderKey()).passkey_credential_id).toBeNull();
  });

  let first: SoftAuthenticator;
  let firstCode: string;

  it("verify consumes the code with the key: two racing registrations with one code store exactly one key", async () => {
    firstCode = await issueEnrolmentCode(w);
    const [c1, c2] = [await challengeFor(firstCode), await challengeFor(firstCode)];
    const [a1, a2] = [new SoftAuthenticator(), new SoftAuthenticator()];
    const results = await Promise.all([w.founder.post("/api/passkey/register/verify", a1.register(c1)), w.founder.post("/api/passkey/register/verify", a2.register(c2))]);
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect([403, 409]).toContain(results.find((r) => r.status !== 200)?.status);
    const winner = PasskeyRegistrationResult.parse(await ok[0]!.json());
    first = winner.credentialId === a1.credentialIdB64 ? a1 : a2;
    expect(winner).toEqual({ credentialId: first.credentialIdB64, qx: first.qx, qy: first.qy, onchain: "PENDING_LENDER" });
    const code = (await q().query("select used_credential_id from founder_enrolment_codes where facility_id = $1 and code_hash = $2", [w.facilityId, keccak256Utf8(firstCode)])).rows[0];
    expect(code.used_credential_id).toBe(first.credentialIdB64);
    expect((await founderKey()).passkey_credential_id).toBe(first.credentialIdB64);
  });

  it("a used code is never accepted again", async () => {
    const res = await optionsWith(firstCode);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("FORBIDDEN");
  });

  it("the officer reads the pending key (founder: 403)", async () => {
    const key = PendingFounderKey.parse(await pending());
    expect(key).toMatchObject({ credentialId: first.credentialIdB64, qx: first.qx, qy: first.qy });
    expect(Math.abs(Date.parse(key.createdAt) - Date.now())).toBeLessThan(60_000);
    expect((await w.founder.get("/api/officer/founder-key/pending")).status).toBe(403);
  });

  let issuedWhilePending: string;

  it("rejects the pending key: officer only, that exact credential; the slot is free and the key is remembered", async () => {
    issuedWhilePending = await issueEnrolmentCode(w);
    const body = { credentialId: first.credentialIdB64 };
    expect((await w.founder.post("/api/officer/founder-key/reject", body)).status).toBe(403);
    expect((await w.officer.post("/api/officer/founder-key/reject", { credentialId: new SoftAuthenticator().credentialIdB64 })).status).toBe(404);
    const res = await w.officer.post("/api/officer/founder-key/reject", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ credentialId: first.credentialIdB64, status: "REJECTED" });
    expect(await pending()).toBeNull();
    expect(await founderKey()).toEqual({ passkey_credential_id: null, key_status: "PENDING_LENDER" });
    const rejected = await q().query("select qx, qy from rejected_founder_keys where facility_id = $1 and credential_id = $2", [w.facilityId, first.credentialIdB64]);
    expect(rejected.rows[0]).toEqual({ qx: first.qx, qy: first.qy });
    expect((await w.officer.post("/api/officer/founder-key/reject", body)).status).toBe(404);
  });

  it("the reject revokes a code issued while the key was pending (audit run-7): a new enrolment needs a new code", async () => {
    const res = await optionsWith(issuedWhilePending);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("FORBIDDEN");
    const open = await q().query("select count(*)::int as n from founder_enrolment_codes where facility_id = $1 and used_at is null and revoked_at is null", [w.facilityId]);
    expect(open.rows[0].n).toBe(0);
  });

  it("an approval of the rejected key is refused (409) and queues nothing", async () => {
    const res = await w.officer.post("/api/officer/founder-key/approve", { founderId: w.founderId, credentialId: first.credentialIdB64, qx: first.qx, qy: first.qy });
    expect(res.status).toBe(409);
    expect(await registerActions()).toBe(0);
  });

  it("the rejected public key cannot come back under a new credential id (audit run-7), and does not burn the code", async () => {
    const code = await issueEnrolmentCode(w);
    const sameKey = Object.assign(Object.create(SoftAuthenticator.prototype) as SoftAuthenticator, first, { credentialId: randomBytes(16) });
    expect(sameKey.credentialIdB64).not.toBe(first.credentialIdB64);
    expect([sameKey.qx, sameKey.qy]).toEqual([first.qx, first.qy]);
    const res = await registerWith(w, sameKey, code);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("CONFLICT");
    expect((await founderKey()).passkey_credential_id).toBeNull();
    expect((await optionsWith(code)).status).toBe(200);
  });

  let second: SoftAuthenticator;

  it("the rejected passkey cannot come back, and its attempt does not burn the new code", async () => {
    const code = await issueEnrolmentCode(w);
    const again = await registerWith(w, first, code);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("CONFLICT");
    second = new SoftAuthenticator();
    const reg = PasskeyRegistrationResult.parse(await json(await registerWith(w, second, code)));
    expect(reg).toMatchObject({ credentialId: second.credentialIdB64, onchain: "PENDING_LENDER" });
    expect(PendingFounderKey.parse(await pending()).credentialId).toBe(second.credentialIdB64);
  });

  it("re-enrolled key: approved, then no longer rejectable (approval in flight, then on-chain)", async () => {
    const body = { founderId: w.founderId, credentialId: second.credentialIdB64, qx: second.qx, qy: second.qy };
    await json(await w.officer.post("/api/officer/founder-key/approve", body), ChainAction);
    const inFlight = await w.officer.post("/api/officer/founder-key/reject", { credentialId: second.credentialIdB64 });
    expect(inFlight.status).toBe(409);
    expect((await errorOf(inFlight)).code).toBe("CONFLICT");
    await w.pump();
    expect((await founderKey()).key_status).toBe("REGISTERED");
    const onChain = await w.officer.post("/api/officer/founder-key/reject", { credentialId: second.credentialIdB64 });
    expect(onChain.status).toBe(409);
    expect((await errorOf(onChain)).code).toBe("FounderKeyAlreadySet");
    expect(await pending()).toBeNull();
    expect(await founderKey()).toEqual({ passkey_credential_id: second.credentialIdB64, key_status: "REGISTERED" });
  });

  it("after registration a fresh code still cannot add a key (FounderKeyAlreadySet)", async () => {
    const res = await registerWith(w, new SoftAuthenticator(), await issueEnrolmentCode(w));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("FounderKeyAlreadySet");
  });
});
