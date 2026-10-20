/**
 * Contract test: every non-stream route of @hogee/api-mock (P2 task 2.12), called with its ROUTE_EXAMPLES
 * request, must return 2xx with a body matching `route.res`. An example marked `expectError` must instead return
 * that ApiError code with the route's status. Any other non-2xx fails (G0-REVIEW M13: no vacuous passes).
 *
 * The mock module is looked up in this order: $HOGEE_API_MOCK, the `@hogee/api-mock` package, then
 * packages/api-mock/src/index.ts by path (no lockfile change needed). If none exists the suite is SKIPPED, unless
 * REQUIRE_API_MOCK=1 (CI after G4), which turns a missing mock into a FAILURE. A mock that exists but fails to
 * load always fails. Run with `pnpm --filter @hogee/api-contract test:contract`.
 *
 * Persona: the cookie is HMAC-signed (task 1.12), so the test obtains it from POST /api/session/persona's
 * Set-Cookie. G0-AUDIT (v-2): there is no unsigned fallback (a mock that sets no signed cookie fails), the officer
 * persona is minted with a per-run random OFFICER_TOKEN, and negative cases check that the officer persona cannot be
 * self-assigned, forged (no / unsigned / tampered / relabelled cookie) or used to reach the lender-key branch.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PERSONAS, type ApiErrorCode, type Persona } from "@hogee/core";
import {
  ApiError,
  PERSONA_COOKIE,
  ROUTE_EXAMPLES,
  ROUTE_NAMES,
  buildPath,
  httpStatusFor,
  routes,
  type RouteDef,
  type RouteName,
} from "../../src/index";

interface HonoLike {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

interface Loaded {
  readonly app?: HonoLike;
  readonly source?: string;
  readonly skipReason?: string;
  readonly loadError?: string;
}

const NOT_FOUND = /Cannot find (module|package)|Failed to (load|resolve)( url| import)?|ERR_MODULE_NOT_FOUND|Does the file exist/i;

// G0-AUDIT (v-2): the mock and the live API both read OFFICER_TOKEN and PERSONA_COOKIE_SECRET (operator secrets,
// 32..256 chars, strength-checked by @hogee/api; no defaults). The test generates both per run, never a committed one.
const randomSecret = (): string => randomBytes(32).toString("base64url");
const TEST_OFFICER_TOKEN = randomSecret();

// The mock verifies passkey signatures (P-256, WebAuthn.verify's checks) against the founder key the officer
// registered. So the test registers a real key, approveFounderKey registers it, and submitSignature signs the digest
// requestSignature returned, as a platform authenticator would (low-s, byte offsets).
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const founderKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const founderCredentialId = randomBytes(16).toString("base64url");

function passkeyAssertion(challenge: string) {
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:3000" });
  const authenticatorData = Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([0x05, 0, 0, 0, 1])]);
  const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
  const sig = sign("sha256", signed, { key: founderKey.privateKey, dsaEncoding: "ieee-p1363" });
  const s = BigInt(`0x${sig.subarray(32).toString("hex")}`);
  return {
    credentialId: founderCredentialId,
    r: `0x${sig.subarray(0, 32).toString("hex")}`,
    s: `0x${(s > P256_N >> 1n ? P256_N - s : s).toString(16).padStart(64, "0")}`,
    challengeIndex: clientDataJSON.indexOf('"challenge"'),
    typeIndex: clientDataJSON.indexOf('"type"'),
    authenticatorData: `0x${authenticatorData.toString("hex")}`,
    clientDataJSON,
  };
}

async function loadMock(): Promise<Loaded> {
  process.env.DEMO_MODE ??= "1";
  process.env.OFFICER_TOKEN = TEST_OFFICER_TOKEN;
  process.env.PERSONA_COOKIE_SECRET = randomSecret();
  const local = fileURLToPath(new URL("../../../api-mock/src/index.ts", import.meta.url));
  const localHref = existsSync(local) ? pathToFileURL(local).href : undefined;
  const candidates = [
    ...(process.env.HOGEE_API_MOCK ? [process.env.HOGEE_API_MOCK] : []),
    "@hogee/api-mock",
    ...(localHref ? [localHref] : []),
  ];
  const misses: string[] = [];
  for (const spec of candidates) {
    try {
      const mod = (await import(/* @vite-ignore */ spec)) as { app?: HonoLike };
      if (mod.app && typeof mod.app.request === "function") return { app: mod.app, source: spec };
      return { loadError: `${spec} loaded but does not export \`app\` (expected new Hono().basePath('/api'))` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A real load error (or any error from a file that exists) fails the suite; only "not found" skips.
      if (!NOT_FOUND.test(message) || spec === localHref) {
        return { loadError: `${spec} failed to load: ${message.split("\n")[0]}` };
      }
      misses.push(spec);
    }
  }
  const reason = `@hogee/api-mock not found (tried ${misses.join(", ")}); P2 creates it in task 2.12`;
  // G0-REVIEW (M13): CI sets REQUIRE_API_MOCK=1 once the mock exists, so a missing mock fails instead of skipping.
  return process.env.REQUIRE_API_MOCK === "1" ? { loadError: `REQUIRE_API_MOCK=1: ${reason}` } : { skipReason: reason };
}

type Req = { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> };

function toRequest(route: RouteDef, req: Req, cookie: string): [string, RequestInit] {
  const query = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
  const headers: Record<string, string> = { cookie, ...req.headers };
  const init: RequestInit = { method: route.method, headers };
  if (route.multipart && req.body) {
    const form = new FormData();
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      if (v instanceof Blob) form.append(k, v, "inspection.pdf");
      else form.append(k, String(v));
    }
    init.body = form;
  } else if (route.rawBody && typeof req.body === "string") {
    headers["content-type"] = "application/json";
    init.body = req.body;
  } else if (req.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }
  return [`${buildPath(route, req.params)}${query}`, init];
}

const loaded = await loadMock();
if (loaded.skipReason) process.stderr.write(`[test:contract] SKIPPED: ${loaded.skipReason}\n`);

describe.runIf(loaded.loadError)("api-mock contract (load)", () => {
  it("loads @hogee/api-mock", () => {
    throw new Error(loaded.loadError);
  });
});

describe.skipIf(!loaded.app)(`api-mock contract${loaded.skipReason ? ` (skipped: ${loaded.skipReason})` : ""}`, () => {
  const app = loaded.app as HonoLike;
  const cookies = new Map<Persona, string>();
  /**
   * SG-DECISIONS Q1: the deployment's founder (founder:mei for SG, founder:rina for MY) is the persona a request
   * without a cookie gets; it is the only founder persona the server mints. Read once from the mock in beforeAll.
   */
  let founder: Persona = "founder:mei";
  const isFounder = (p: Persona): boolean => p.startsWith("founder:");
  const personaFor = (route: RouteDef): Persona => (route.personas?.includes("officer") && !route.personas.some(isFounder) ? "officer" : founder);

  /** The whole `hogee_persona=...; Path=...` Set-Cookie line of a response, if any. */
  const personaSetCookie = (res: Response): string | undefined =>
    res.headers.getSetCookie().find((c) => c.trimStart().startsWith(`${PERSONA_COOKIE}=`));
  /** `hogee_persona=<signed value>` from a response's Set-Cookie, if any. */
  const personaCookieOf = (res: Response): string | undefined => personaSetCookie(res)?.split(";")[0]?.trim();

  /** POST /api/session/persona without a cookie (the self-assignment attempt v-2 is about). */
  const mintPersona = (body: unknown) => {
    const [url, init] = toRequest(routes.setPersona, { body }, "");
    return app.request(url, init);
  };

  /** The signed persona cookie, obtained from POST /api/session/persona. */
  const cookieFor = async (persona: Persona): Promise<string> => {
    const cached = cookies.get(persona);
    if (cached) return cached;
    // G0-AUDIT (v-2): officer needs the operator token; founder takes none.
    const res = await mintPersona(persona === "officer" ? { persona, officerToken: TEST_OFFICER_TOKEN } : { persona });
    const cookie = personaCookieOf(res);
    // G0-AUDIT (v-2): no unsigned fallback. A mock that does not set the signed cookie fails the suite.
    if (!cookie) throw new Error(`POST /api/session/persona (${persona}) → ${res.status} set no signed ${PERSONA_COOKIE} cookie`);
    cookies.set(persona, cookie);
    return cookie;
  };

  const send = async (name: RouteName, req: Req) => {
    const route = routes[name] as RouteDef;
    const [url, init] = toRequest(route, req, await cookieFor(personaFor(route)));
    return app.request(url, init);
  };
  const json = async (name: RouteName, req: Req): Promise<unknown> => {
    const res = await send(name, req);
    return res.ok ? res.json() : undefined;
  };

  /** Ids discovered from the mock's own fixtures, so param routes exercise real records. */
  const found: Record<string, string> = {};
  beforeAll(async () => {
    const anonymous = await app.request(...toRequest(routes.getSession, {}, ""));
    const persona = routes.getSession.res.parse(await anonymous.json()).persona;
    if (!isFounder(persona)) throw new Error(`GET /api/session without a cookie must be the deployment's founder, got ${persona}`);
    founder = persona;
    const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
    const pick = (k: string, v: unknown) => {
      if (typeof v === "string" && v) found[k] = v;
    };
    const session = (await json("getSession", {})) as { founderId?: string } | undefined;
    pick("founderId", session?.founderId);
    pick("paymentId", list(await json("listPayments", { query: {} }))[0]?.paymentId);
    pick("traceId", list(await json("listTraces", { query: {} }))[0]?.traceId);
    // Distinct exceptions per action so one decision does not invalidate the next one.
    const exceptions = list(await json("listExceptions", { query: {} }));
    const byStatus = (...statuses: string[]) => exceptions.filter((e) => statuses.includes(String(e.status)));
    const open = byStatus("OPEN", "FOUNDER_SIGNED");
    pick("approveId", open[0]?.exceptionId);
    pick("denyId", (open[1] ?? open[0])?.exceptionId);
    pick("vetoId", byStatus("QUEUED", "EXECUTABLE")[0]?.exceptionId);
    const runId = list(await json("listEvidenceRuns", {}))[0]?.runId;
    pick("runId", runId);
    if (typeof runId === "string") pick("evidencePath", ((await json("getEvidenceRun", { params: { runId } })) as { files?: string[] } | undefined)?.files?.[0]);
    // REG-BRIEF (fisco-proof): the mock's own FISCO mirror packs; the anchor example needs a pack with a sidecar.
    const fiscoPacks = list(await json("listFiscoPacks", {}));
    pick("fiscoPackId", fiscoPacks[0]?.packId);
    pick("fiscoPath", (fiscoPacks[0]?.files as string[] | undefined)?.[0]);
    pick("anchoredPackId", fiscoPacks.find((p) => p.anchored === true)?.packId);
    pick("shortlistId", ((await json("shortlistSuppliers", ROUTE_EXAMPLES.shortlistSuppliers.req)) as { requestId?: string } | undefined)?.requestId);
    // G2: registration needs an officer-issued code and the challenge register/options bound to it. The test's real
    // key is registered that way, so it is pending before approveFounderKey runs; approving it is what lets
    // submitSignature's assertion verify (the mock checks signatures against the officer-registered key).
    const regCode = ((await json("issueEnrolmentCode", {})) as { code?: string } | undefined)?.code;
    const regOptions = (await json("passkeyRegisterOptions", { body: { enrolmentCode: regCode } })) as { challenge?: string } | undefined;
    const example = ROUTE_EXAMPLES.passkeyRegisterVerify.req.body;
    const publicKey = founderKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: regOptions?.challenge })).toString("base64url");
    const registered = (await json("passkeyRegisterVerify", {
      body: { ...example, id: founderCredentialId, rawId: founderCredentialId, response: { ...example.response, clientDataJSON, publicKey } },
    })) as { qx?: string; qy?: string } | undefined;
    pick("founderQx", registered?.qx);
    pick("founderQy", registered?.qy);
    const signature = (await json("requestSignature", ROUTE_EXAMPLES.requestSignature.req)) as { requestId?: string; challengeB64url?: string } | undefined;
    pick("signatureId", signature?.requestId);
    pick("signatureChallenge", signature?.challengeB64url);
    // G2: enrolment codes are random and single use; this one is the code the passkeyRegisterOptions example presents.
    pick("enrolmentCode", ((await json("issueEnrolmentCode", {})) as { code?: string } | undefined)?.code);
  });

  const requestFor = (name: RouteName): Req => {
    const base = ROUTE_EXAMPLES[name].req as Req;
    const req: Req = { ...base, ...(base.params ? { params: { ...base.params } } : {}) };
    const set = (param: string, key: string) => {
      if (req.params && found[key]) req.params[param] = found[key];
    };
    if (name === "getPayment") set("id", "paymentId");
    if (name === "getShortlist") set("id", "shortlistId");
    if (name === "submitSignature") set("id", "signatureId");
    if (name === "approveException") set("id", "approveId");
    if (name === "denyException") set("id", "denyId");
    if (name === "vetoException") set("id", "vetoId");
    if (name === "getTrace") set("traceId", "traceId");
    if (name === "getEvidenceRun" || name === "getEvidenceFile") set("runId", "runId");
    if (name === "getEvidenceFile") set("path", "evidencePath");
    if (name === "getFiscoFile") set("packId", "fiscoPackId");
    if (name === "getFiscoFile") set("path", "fiscoPath");
    if (name === "getFiscoAnchor") set("packId", found.anchoredPackId ? "anchoredPackId" : "fiscoPackId");
    // G0-AUDIT (v-2): the body names the reviewed credential. It is the test's real key, registered through
    // passkeyRegisterVerify in beforeAll, so it is pending before approveFounderKey runs; approving it is what lets
    // submitSignature's assertion verify (the mock checks signatures against the officer-registered key). The founder
    // id is taken from the mock's session.
    if (name === "approveFounderKey" && found.founderId) {
      req.body = { ...ROUTE_EXAMPLES.approveFounderKey.req.body, founderId: found.founderId, credentialId: founderCredentialId, qx: found.founderQx, qy: found.founderQy };
    }
    if (name === "submitSignature" && found.signatureChallenge) req.body = { passkey: passkeyAssertion(found.signatureChallenge) };
    // G2: a code the mock issued (beforeAll's registration consumed the first one).
    if (name === "passkeyRegisterOptions" && found.enrolmentCode) req.body = { enrolmentCode: found.enrolmentCode };
    // The example's officerToken is a placeholder; the mock checks the test's OFFICER_TOKEN.
    if (name === "setPersona") req.body = { persona: "officer", officerToken: TEST_OFFICER_TOKEN };
    return req;
  };

  /** A non-2xx ApiError envelope with `code` (or one of `code`), declared in route.errors, at that code's status. */
  const expectApiError = async (res: Response, route: RouteDef, code: ApiErrorCode | readonly ApiErrorCode[]): Promise<void> => {
    const codes: readonly ApiErrorCode[] = typeof code === "string" ? [code] : code;
    const label = `${route.method} ${route.path} → ${res.status}`;
    expect(res.ok, `${label}: must not succeed (expected ${codes.join(" or ")})`).toBe(false);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${label}: non-2xx body is not JSON (route missing?): ${text.slice(0, 120)}`);
    }
    const err = ApiError.safeParse(body);
    expect(err.success, `${label}: not an ApiError envelope: ${text.slice(0, 200)}`).toBe(true);
    if (!err.success) return;
    expect(codes, `${label}: wrong error code ${err.data.error.code}`).toContain(err.data.error.code);
    expect(route.errors, `${label}: code ${err.data.error.code} not declared in route.errors`).toContain(err.data.error.code);
    expect(res.status, `${label}: wrong status for ${err.data.error.code}`).toBe(httpStatusFor(route, err.data.error.code));
  };

  // Audit run-7: the mock has one founder-key slot, as live. The approveFounderKey example registers the seeded example
  // key, and a registered key is never rejected, so rejectFounderKey runs last, on a reset store where that key is
  // pending again (its example rejects exactly it).
  const LAST: readonly RouteName[] = ["rejectFounderKey"];
  const testable = [...ROUTE_NAMES.filter((n) => !(routes[n] as RouteDef).stream && !LAST.includes(n)), ...LAST];

  it.each(testable)("%s", async (name) => {
    const route = routes[name] as RouteDef;
    // REG-BRIEF (fisco-proof): an app lists a FISCO pack only when its evidence folder holds one of the tenant's (the
    // mock: the tracked pack; the live contract world's temporary folder: none), and a sidecar only once the pack is
    // anchored on Sepolia (P1). Without one, the example must answer the declared NOT_FOUND (api-mock test/fisco.test.ts
    // and api test/evidence-fisco-store.test.ts serve both from temporary evidence folders).
    const noFisco = (name === "getFiscoFile" && !found.fiscoPackId) || (name === "getFiscoAnchor" && !found.anchoredPackId);
    const expectError = noFisco ? "NOT_FOUND" : (ROUTE_EXAMPLES[name] as { expectError?: ApiErrorCode }).expectError;
    if (name === "rejectFounderKey") expect((await send("demoReset", {})).ok, "POST /api/demo/reset").toBe(true);
    const res = await send(name, requestFor(name));
    const label = `${route.method} ${route.path} → ${res.status}`;
    const ok = res.status >= 200 && res.status < 300;

    if (!expectError) {
      expect(ok, `${label}: the example request must succeed (2xx); body: ${ok ? "" : (await res.clone().text()).slice(0, 200)}`).toBe(true);
      if (route.fileResponse) return;
      const body: unknown = await res.json();
      const parsed = route.res.safeParse(body);
      expect(parsed.success, `${label} body does not match route.res: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5))}`).toBe(true);
      return;
    }

    await expectApiError(res, route, expectError);
  });

  // P1 (g2-ui parity): planOrder in the live API reads refId as an escrow order id OR a shortlisted supplier id; the
  // web sends the supplier id until the supplier has an order. The example supplier is on the seeded shortlist.
  it("requestSignature: a SupplierApproval may name a shortlisted supplier by id, as the live API accepts", async () => {
    const res = await send("requestSignature", { body: { kind: "SupplierApproval", refId: ROUTE_EXAMPLES.getSupplier.req.params.id, method: "passkey" } });
    expect(res.ok, `POST /api/signatures/request (SupplierApproval by supplier id) → ${res.status}: ${res.ok ? "" : (await res.clone().text()).slice(0, 200)}`).toBe(true);
    const parsed = routes.requestSignature.res.safeParse(await res.json());
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
    if (parsed.success) expect(parsed.data.typedData.primaryType).toBe("SupplierApproval");
  });

  // SG-DECISIONS Q1: the server accepts only its country's founder; the other founder persona is never minted.
  it("setPersona mints only the deployment's founder: the other founder is FORBIDDEN and sets no cookie", async () => {
    const others = PERSONAS.filter((p) => isFounder(p) && p !== founder);
    expect(others.length).toBeGreaterThan(0);
    for (const persona of others) {
      const res = await mintPersona({ persona });
      expect(personaCookieOf(res), `${persona}: no persona cookie on a refused request`).toBeUndefined();
      await expectApiError(res, routes.setPersona, "FORBIDDEN");
    }
  });

  // ---- G0-AUDIT (v-2): the officer persona cannot be self-assigned ------------------------------------------------
  it("setPersona refuses officer without an officerToken (VALIDATION) and sets no cookie", async () => {
    const res = await mintPersona({ persona: "officer" });
    expect(personaCookieOf(res), "no persona cookie on a refused request").toBeUndefined();
    await expectApiError(res, routes.setPersona, "VALIDATION");
  });

  it("setPersona refuses officer with a wrong officerToken (FORBIDDEN) and sets no cookie", async () => {
    const res = await mintPersona({ persona: "officer", officerToken: randomSecret() });
    expect(personaCookieOf(res), "no persona cookie on a refused request").toBeUndefined();
    await expectApiError(res, routes.setPersona, "FORBIDDEN");
  });

  it.each(["founder", "officer"] as const)("setPersona's %s cookie is HttpOnly, SameSite=Strict, Path=/api, host-only, ≤ 8 h", async (who) => {
    const persona = who === "officer" ? "officer" : founder;
    const res = await mintPersona(persona === "officer" ? { persona, officerToken: TEST_OFFICER_TOKEN } : { persona });
    const line = personaSetCookie(res);
    expect(line, `POST /api/session/persona (${persona}) → ${res.status} set no ${PERSONA_COOKIE} cookie`).toBeDefined();
    const attrs = new Map(
      (line ?? "").split(";").slice(1).map((a) => {
        const [k = "", ...v] = a.trim().split("=");
        return [k.toLowerCase(), v.join("=")] as const;
      }),
    );
    expect(attrs.has("httponly"), line).toBe(true);
    expect(attrs.get("samesite")?.toLowerCase(), line).toBe("strict");
    expect(attrs.get("path"), line).toBe("/api");
    expect(attrs.has("domain"), `${line}: Domain widens the cookie beyond this host`).toBe(false);
    const maxAge = attrs.get("max-age");
    if (maxAge !== undefined) expect(Number(maxAge), line).toBeLessThanOrEqual(8 * 60 * 60);
  });

  /**
   * Cookies that must never act as officer. "tampered" flips one character inside the trailing MAC (not the last:
   * base64url's final character carries padding bits); "relabelled" swaps the persona of a signed founder cookie
   * (format `<persona>.<exp>.<mac>`, @hogee/api signPersonaCookie) to officer and keeps its MAC.
   */
  const FORGED = ["no cookie", "unsigned officer", "tampered officer", "relabelled founder"] as const;
  type Forged = (typeof FORGED)[number];
  const forgedCookie = async (kind: Forged): Promise<string> => {
    if (kind === "no cookie") return "";
    if (kind === "unsigned officer") return `${PERSONA_COOKIE}=officer`;
    if (kind === "relabelled founder") return (await cookieFor(founder)).replace(/^([^=]+=)[^.]*\./, "$1officer.");
    const signed = await cookieFor("officer");
    const i = Math.max(signed.indexOf("=") + 1, signed.length - 10);
    return `${signed.slice(0, i)}${signed[i] === "A" ? "B" : "A"}${signed.slice(i + 1)}`;
  };

  it.each(FORGED)("GET /api/session with %s → the deployment's founder persona", async (kind) => {
    const [url, init] = toRequest(routes.getSession, {}, await forgedCookie(kind));
    const res = await app.request(url, init);
    expect(res.ok, `GET /api/session → ${res.status}`).toBe(true);
    const session = routes.getSession.res.safeParse(await res.json());
    expect(session.success).toBe(true);
    if (session.success) expect(session.data.persona).toBe(founder);
  });

  const officerOnly = ROUTE_NAMES.filter((n) => {
    const personas = (routes[n] as RouteDef).personas;
    return personas !== undefined && personas.includes("officer") && !personas.some(isFounder);
  });
  const nonOfficerCookies = ["founder cookie", ...FORGED] as const;
  const cookieAs = async (kind: (typeof nonOfficerCookies)[number]): Promise<string> =>
    kind === "founder cookie" ? cookieFor(founder) : forgedCookie(kind);

  it.each(officerOnly.flatMap((name) => nonOfficerCookies.map((kind) => [name, kind] as const)))(
    "%s refuses %s (FORBIDDEN)",
    async (name, kind) => {
      const route = routes[name] as RouteDef;
      const [url, init] = toRequest(route, requestFor(name), await cookieAs(kind));
      await expectApiError(await app.request(url, init), route, "FORBIDDEN");
    },
  );

  // approveException's officer branch (server lender signature) is taken iff the verified persona === "officer".
  // Any other caller gets the founder branch (SIGNATURE_REQUIRED), FORBIDDEN, or CONFLICT (e.g. a founder signature
  // request already pending for this exception); never APPROVED.
  it.each(nonOfficerCookies)("approveException with %s never takes the officer branch", async (kind) => {
    const route = routes.approveException;
    const [url, init] = toRequest(route, requestFor("approveException"), await cookieAs(kind));
    const res = await app.request(url, init);
    if (res.ok) {
      const body = route.res.safeParse(await res.json());
      expect(body.success, "body does not match route.res").toBe(true);
      if (body.success) expect(body.data.outcome, "officer branch taken without the officer persona").toBe("SIGNATURE_REQUIRED");
      return;
    }
    await expectApiError(res, route, ["FORBIDDEN", "CONFLICT"]);
  });

  it("enrolment: the seeded example key never holds the slot; a real registration is the pending key", async () => {
    expect((await send("demoReset", {})).ok).toBe(true);
    const code = String(((await json("issueEnrolmentCode", {})) as { code?: string } | undefined)?.code);
    const opts = await send("passkeyRegisterOptions", { body: { enrolmentCode: code } });
    const challenge = routes.passkeyRegisterOptions.res.parse(await opts.json()).challenge;
    const id = randomBytes(16).toString("base64url");
    const publicKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge })).toString("base64url");
    const res = await send("passkeyRegisterVerify", { body: { id, rawId: id, type: "public-key", response: { clientDataJSON, attestationObject: "o2NmbXRkbm9uZQ", publicKey }, clientExtensionResults: {} } });
    expect(res.ok, `verify → ${res.status}`).toBe(true);
    expect(routes.getPendingFounderKey.res.parse(await json("getPendingFounderKey", {}))?.credentialId).toBe(id);
  });

  // ---- G2 (run-4 lead 5): the mock enforces the enrolment code and the reject route as the live API does ----------
  it("enrolment: only the officer's open code registers a key; a rejected key never comes back", async () => {
    const reset = await send("demoReset", {});
    expect(reset.ok, `POST /api/demo/reset → ${reset.status}`).toBe(true);
    const issue = async () => String(((await json("issueEnrolmentCode", {})) as { code?: string } | undefined)?.code);
    const options = (enrolmentCode: string) => send("passkeyRegisterOptions", { body: { enrolmentCode } });
    const challengeOf = async (res: Response) => routes.passkeyRegisterOptions.res.parse(await res.json()).challenge;
    const spkiOf = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    /** A registration answering `challenge` (none: an empty clientDataJSON), for a new credential id. */
    const newKey = (challenge?: string, publicKey = spkiOf()) => {
      const id = randomBytes(16).toString("base64url");
      const clientDataJSON = Buffer.from(JSON.stringify(challenge ? { type: "webauthn.create", challenge } : {})).toString("base64url");
      return { id, rawId: id, type: "public-key", response: { clientDataJSON, attestationObject: "o2NmbXRkbm9uZQ", publicKey }, clientExtensionResults: {} };
    };
    const verify = (body: unknown) => send("passkeyRegisterVerify", { body });
    const reject = (credentialId: string) => send("rejectFounderKey", { body: { credentialId } });

    await expectApiError(await options("AAAAAAAAAAAAAAAAAAAAAAAA"), routes.passkeyRegisterOptions, "FORBIDDEN");
    const a = await issue();
    const b = await issue();
    await expectApiError(await options(a), routes.passkeyRegisterOptions, "FORBIDDEN"); // replaced
    // Audit run-7: a reject revokes the open code (the seeded example key is still pending here, so it can be rejected).
    const seeded = await challengeOf(await options(b));
    expect((await reject(ROUTE_EXAMPLES.rejectFounderKey.req.body.credentialId)).ok).toBe(true);
    await expectApiError(await verify(newKey(seeded)), routes.passkeyRegisterVerify, "FORBIDDEN"); // revoked by the reject
    await expectApiError(await options(b), routes.passkeyRegisterOptions, "FORBIDDEN");

    const c = await issue();
    await expectApiError(await verify(newKey()), routes.passkeyRegisterVerify, "FORBIDDEN"); // no challenge from options
    const challenge = await challengeOf(await options(c));
    // Audit run-7: the code binds to the caller's challenge; another client's ceremony (its own or a made-up challenge)
    // cannot consume it.
    await expectApiError(await verify(newKey(randomBytes(32).toString("base64url"))), routes.passkeyRegisterVerify, "FORBIDDEN");
    const key = newKey(challenge);
    const stored = await verify(key);
    expect(stored.ok, `verify → ${stored.status}`).toBe(true);
    await expectApiError(await options(c), routes.passkeyRegisterOptions, "FORBIDDEN"); // used

    const pending = routes.getPendingFounderKey.res.parse(await json("getPendingFounderKey", {}));
    expect(pending?.credentialId).toBe(key.id);
    expect((await verify(key)).ok, "a replay of the stored registration returns its record").toBe(true);
    // Audit run-7: a second key while one is pending is refused, even with a fresh code.
    const d = await issue();
    await expectApiError(await verify(newKey(await challengeOf(await options(d)))), routes.passkeyRegisterVerify, "FounderKeyAlreadySet");

    expect(routes.rejectFounderKey.res.parse(await (await reject(key.id)).json())).toEqual({ credentialId: key.id, status: "REJECTED" });
    await expectApiError(await reject(key.id), routes.rejectFounderKey, "NOT_FOUND");
    expect(routes.getPendingFounderKey.res.parse(await json("getPendingFounderKey", {}))).toBeNull();
    const reviewed = { founderId: found.founderId ?? "", credentialId: key.id, qx: pending?.qx, qy: pending?.qy };
    await expectApiError(await send("approveFounderKey", { body: reviewed }), routes.approveFounderKey, "CONFLICT");
    await expectApiError(await verify(key), routes.passkeyRegisterVerify, "CONFLICT");
    // Audit run-7: the rejected public key under a new credential id is refused too.
    const e = await issue();
    await expectApiError(await verify(newKey(await challengeOf(await options(e)), key.response.publicKey)), routes.passkeyRegisterVerify, "CONFLICT");

    // A fresh key registers and is approved; then a registered key is never rejected, and nothing more is approved.
    const fresh = newKey(await challengeOf(await options(e)));
    const freshResult = routes.passkeyRegisterVerify.res.parse(await (await verify(fresh)).json());
    const approve = (k: typeof freshResult) => send("approveFounderKey", { body: { founderId: found.founderId ?? "", credentialId: k.credentialId, qx: k.qx, qy: k.qy } });
    expect((await approve(freshResult)).ok).toBe(true);
    await expectApiError(await approve(freshResult), routes.approveFounderKey, "FounderKeyAlreadySet");
    await expectApiError(await reject(fresh.id), routes.rejectFounderKey, "FounderKeyAlreadySet");
    await expectApiError(await verify(newKey(await challengeOf(await options(await issue())))), routes.passkeyRegisterVerify, "FounderKeyAlreadySet");
  });
});
