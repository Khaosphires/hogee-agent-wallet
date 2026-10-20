/** Central route rules (register.ts) and the session routes, without a database. */
import { describe, expect, it } from "vitest";
import { ApiError, PERSONA_COOKIE, Session } from "@hogee/core";
import { ROUTE_EXAMPLES } from "@hogee/api-contract";
import { createApiApp } from "../src/app";
import { ConfigError, contractFailure, fail } from "../src/http/problem";
import { signPersonaCookie } from "../src/persona-cookie";
import type { Db } from "@hogee/db";
import { fakeDeps, randomSecret, type Fake } from "./support/fake-deps";

const json = { "content-type": "application/json" };

function appFor(f: Fake, overrides = {}) {
  return createApiApp(async () => f.deps, overrides);
}

async function errorOf(res: Response) {
  const body = ApiError.parse(await res.json());
  return body.error;
}

describe("central route rules", () => {
  it("answers an unknown path with a 404 ApiError", async () => {
    const res = await appFor(fakeDeps()).request("/api/nope");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("NOT_FOUND");
  });

  it("hides demo-only routes (404) unless DEMO_MODE=1, even for the officer", async () => {
    const f = fakeDeps({ flags: { demoMode: false } });
    const res = await appFor(f).request("/api/demo/reset", { method: "POST", headers: { cookie: f.cookie("officer") } });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("NOT_FOUND");
  });

  it("refuses a persona-restricted route to another persona (403)", async () => {
    const f = fakeDeps();
    const res = await appFor(f).request("/api/facility/open", {
      method: "POST",
      headers: { ...json, cookie: f.cookie("founder:rina") },
      body: JSON.stringify({ capMinor: "1000000", reserveFloorBps: 300 }),
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("FORBIDDEN");
  });

  it("validates the request body against the route schema (422)", async () => {
    const f = fakeDeps();
    const res = await appFor(f).request("/api/facility/open", {
      method: "POST",
      headers: { ...json, cookie: f.cookie("officer") },
      body: JSON.stringify({ capMinor: "10.5", reserveFloorBps: 300 }),
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("refuses a JSON body that is not JSON (422)", async () => {
    const f = fakeDeps();
    const res = await appFor(f).request("/api/facility/open", { method: "POST", headers: { ...json, cookie: f.cookie("officer") }, body: "{" });
    expect(res.status).toBe(422);
  });

  it("evidence routes without an evidence directory: no runs, no export (409), nothing to read (404)", async () => {
    const app = appFor(fakeDeps());
    const runs = await app.request("/api/evidence/runs");
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual([]);
    const exp = await app.request("/api/evidence/export", { method: "POST", headers: json, body: "{}" });
    expect(exp.status).toBe(409);
    expect((await errorOf(exp)).code).toBe("CONFLICT");
    expect((await app.request("/api/evidence/run-1")).status).toBe(404);
    expect((await app.request("/api/evidence/run-1/files/receipts/T1.json")).status).toBe(404);
  });

  it("refuses an evidence file path that leaves the bundle before any read", async () => {
    const res = await appFor(fakeDeps()).request("/api/evidence/run-1/files/a/..%2F..%2Fmanifest.json");
    expect([404, 422]).toContain(res.status);
  });

  it("keeps the eval routes behind DEMO_MODE (404)", async () => {
    const body = JSON.stringify(ROUTE_EXAMPLES.evalCase.req.body);
    const res = await appFor(fakeDeps({ flags: { demoMode: false } })).request("/api/eval/case", { method: "POST", headers: json, body });
    expect(res.status).toBe(404);
  });

  it("answers 502 UPSTREAM naming the variable when the live API is not configured", async () => {
    const app = createApiApp(async () => {
      throw new ConfigError("DATABASE_URL is required");
    });
    const res = await app.request("/api/session");
    expect(res.status).toBe(502);
    expect((await errorOf(res)).message).toContain("DATABASE_URL");
  });

  it("never sends a 2xx body that breaks route.res (502)", async () => {
    const f = fakeDeps();
    const res = await appFor(f, { getHealth: () => ({ db: "fine" }) as never }).request("/api/health");
    expect(res.status).toBe(502);
    expect(f.logs.some((l) => l.event === "response_invalid")).toBe(true);
  });

  it("turns an undeclared contract error into CONFLICT with the decoded contractError", async () => {
    const f = fakeDeps();
    const res = await appFor(f, {
      createException: () => {
        // G2: createException now declares PayeeNotBound (the loosening mirror returns it); DuplicateIntent it does not.
        throw contractFailure("DuplicateIntent", "already used");
      },
    }).request("/api/exceptions", {
      method: "POST",
      headers: { ...json, cookie: f.cookie("founder:rina") },
      body: JSON.stringify({ kind: "UNPAUSE", payload: {}, reason: "test" }),
    });
    expect(res.status).toBe(409);
    const err = await errorOf(res);
    expect(err.code).toBe("CONFLICT");
    expect(err.contractError?.name).toBe("DuplicateIntent");
  });

  it("hides unknown errors behind a generic message (no internals leak)", async () => {
    const f = fakeDeps();
    const res = await appFor(f, {
      getHealth: () => {
        throw new Error("connect ECONNREFUSED postgres://user:hunter2@db:5432");
      },
    }).request("/api/health");
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("Internal error");
  });

  it("keeps a declared ApiProblem as is", async () => {
    const f = fakeDeps();
    const res = await appFor(f, {
      getCurrentPlan: () => {
        throw fail("NOT_FOUND", "No plan yet");
      },
    }).request("/api/plans/current");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/session", () => {
  it("reads founder:rina without a cookie and reports the live deployment", async () => {
    const res = await appFor(fakeDeps()).request("/api/session");
    expect(res.status).toBe(200);
    const s = Session.parse(await res.json());
    expect(s).toEqual({ persona: "founder:rina", founderId: "founder-rina", facilityId: "fac-rina", mode: "live", chainId: 31337, deploymentId: "final-1" });
  });

  it("reads the officer only from a valid signed cookie", async () => {
    const f = fakeDeps();
    const ok = await appFor(f).request("/api/session", { headers: { cookie: f.cookie("officer") } });
    expect(Session.parse(await ok.json()).persona).toBe("officer");
    const forged = await appFor(f).request("/api/session", { headers: { cookie: `${PERSONA_COOKIE}=officer` } });
    expect(Session.parse(await forged.json()).persona).toBe("founder:rina");
  });

  it("reads every cookie as founder:rina when PERSONA_COOKIE_SECRET is unset", async () => {
    const f = fakeDeps();
    const cookie = f.cookie("officer");
    const unset = fakeDeps({ flags: { cookieSecret: undefined, officerToken: f.flags.officerToken } });
    const res = await appFor(unset).request("/api/session", { headers: { cookie } });
    expect(Session.parse(await res.json()).persona).toBe("founder:rina");
  });
});

describe("GET /api/session on an SG server (SG-DECISIONS Q1)", () => {
  const sgApp = (f: Fake) =>
    createApiApp(async () => ({ ...f.deps, config: { ...f.deps.config, countryCode: "SG", currency: "SGD", facilityId: "fac-mei", founderId: "founder-mei" } }), {});
  const signed = (f: Fake, persona: "founder:rina" | "founder:mei") => `${PERSONA_COOKIE}=${signPersonaCookie(persona, { secret: f.flags.cookieSecret as string, now: Date.now() })}`;
  const personaAt = async (app: ReturnType<typeof sgApp>, cookie?: string) =>
    Session.parse(await (await app.request("/api/session", cookie ? { headers: { cookie } } : {})).json());

  it("reads founder:mei without a cookie, for Mei's tenant", async () => {
    expect(await personaAt(sgApp(fakeDeps()))).toEqual({ persona: "founder:mei", founderId: "founder-mei", facilityId: "fac-mei", mode: "live", chainId: 31337, deploymentId: "final-1" });
  });

  it("accepts a valid founder:mei cookie, and reads a valid founder:rina cookie as founder:mei", async () => {
    const f = fakeDeps();
    expect((await personaAt(sgApp(f), signed(f, "founder:mei"))).persona).toBe("founder:mei");
    expect((await personaAt(sgApp(f), signed(f, "founder:rina"))).persona).toBe("founder:mei");
    expect((await personaAt(sgApp(f), f.cookie("officer"))).persona).toBe("officer");
    expect((await personaAt(sgApp(f), `${PERSONA_COOKIE}=officer`)).persona).toBe("founder:mei");
  });

  it("reads every cookie as founder:mei when PERSONA_COOKIE_SECRET is unset", async () => {
    const f = fakeDeps();
    const unset = fakeDeps({ flags: { cookieSecret: undefined, officerToken: f.flags.officerToken } });
    expect((await personaAt(sgApp(unset), f.cookie("officer"))).persona).toBe("founder:mei");
  });

  it("never grants Mei on an MY server: Mei's valid cookie reads as founder:rina", async () => {
    const f = fakeDeps();
    const res = await appFor(f).request("/api/session", { headers: { cookie: signed(f, "founder:mei") } });
    expect(Session.parse(await res.json()).persona).toBe("founder:rina");
  });
});

describe("POST /api/session/persona", () => {
  const mint = (f: Fake, body: unknown) =>
    appFor(f).request("/api/session/persona", { method: "POST", headers: json, body: JSON.stringify(body) });

  it("mints the officer persona only with OFFICER_TOKEN, as an HttpOnly SameSite=Strict cookie on /api", async () => {
    const f = fakeDeps();
    const res = await mint(f, { persona: "officer", officerToken: f.flags.officerToken });
    expect(res.status).toBe(200);
    const line = res.headers.getSetCookie().find((c) => c.startsWith(`${PERSONA_COOKIE}=officer.`));
    expect(line).toBeDefined();
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Strict/);
    expect(line).toMatch(/Path=\/api/);
    expect(line).not.toMatch(/Domain/i);
    expect(Session.parse(await res.json()).persona).toBe("officer");
  });

  it("mints only this server's founder: an MY server refuses founder:mei (403) and sets no cookie", async () => {
    const f = fakeDeps();
    const other = await mint(f, { persona: "founder:mei" });
    expect(other.status).toBe(403);
    expect(other.headers.getSetCookie()).toEqual([]);
    const own = await mint(f, { persona: "founder:rina" });
    expect(own.status).toBe(200);
    expect(Session.parse(await own.json()).persona).toBe("founder:rina");
  });

  it("refuses a wrong token (403), sets no cookie, and logs the failed attempt", async () => {
    const f = fakeDeps();
    const res = await mint(f, { persona: "officer", officerToken: randomSecret() });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(f.logs.some((l) => l.event === "officer_token_rejected")).toBe(true);
  });

  it("refuses everyone after repeated wrong tokens, the right token included", async () => {
    const f = fakeDeps();
    const app = appFor(f);
    const post = (token: string) => app.request("/api/session/persona", { method: "POST", headers: json, body: JSON.stringify({ persona: "officer", officerToken: token }) });
    for (let i = 0; i < 5; i += 1) expect((await post(randomSecret())).status).toBe(403);
    const locked = await post(f.flags.officerToken as string);
    expect(locked.status).toBe(403);
    expect(locked.headers.getSetCookie()).toEqual([]);
  });

  it("traces each wrong token, but a lockout only once per window (audit run-6: no unbounded ALERT rows)", async () => {
    const reasons: unknown[] = [];
    const query = async (sql: string, values?: unknown[]) => {
      if (/insert into traces/.test(sql)) reasons.push(values?.[8]);
      return { rows: [], rowCount: 1 };
    };
    const db = { $client: { query, connect: async () => ({ query, release: () => undefined }) } } as unknown as Db;
    const f = fakeDeps({ deps: { db } });
    const app = appFor(f);
    const post = (token: string) => app.request("/api/session/persona", { method: "POST", headers: json, body: JSON.stringify({ persona: "officer", officerToken: token }) });
    for (let i = 0; i < 5; i += 1) expect((await post(randomSecret())).status).toBe(403);
    for (let i = 0; i < 20; i += 1) expect((await post(f.flags.officerToken as string)).status).toBe(403);
    expect(reasons.filter((r) => r === "OFFICER_TOKEN_REJECTED")).toHaveLength(5);
    expect(reasons.filter((r) => r === "OFFICER_TOKEN_LOCKED")).toHaveLength(1);
    expect(f.logs.filter((l) => l.event === "officer_token_rejected")).toHaveLength(25);
  });

  it("refuses the officer when OFFICER_TOKEN is weak or unset", async () => {
    const f = fakeDeps({ flags: { officerToken: "short" } });
    expect((await mint(f, { persona: "officer", officerToken: "short".repeat(8) })).status).toBe(403);
  });

  it("refuses to mint anything without PERSONA_COOKIE_SECRET (403)", async () => {
    const f = fakeDeps({ flags: { cookieSecret: undefined } });
    expect((await mint(f, { persona: "founder:rina" })).status).toBe(403);
  });

  it("mints founder:rina without a token", async () => {
    const f = fakeDeps();
    const res = await mint(f, { persona: "founder:rina" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => decodeURIComponent(c).startsWith(`${PERSONA_COOKIE}=founder:rina.`))).toBe(true);
  });
});
