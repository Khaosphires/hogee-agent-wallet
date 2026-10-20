/**
 * Audit run-8 (shortlist.ts candidateOf, server-country-pack-vs-facility-currency-unchecked; SG-DESIGN fail-open 3 on
 * the shortlist). Landed cost applies the server's HOGEE_COUNTRY pack and converts into the facility's currency, so an
 * SG server over an MYR facility would price CN drinkware as SG MFN plus 9% GST instead of MY Form E plus 10% sales
 * tax (or the reverse), and SupplierApproval would build the founder-signed schedule from it. Now:
 * - the shortlist build refuses (CONFLICT) unless the currency is the server country's, before any FX, sanctions,
 *   registry or pack read;
 * - POST /api/suppliers/shortlist runs compileEnv's own check (server country, founder country, facility currency) and
 *   refuses with 409 before anything is priced or stored;
 * - E3 (/api/eval/shortlist) prices through the same build, so it refuses a facility of another country too;
 * - a pack file that is not the server country's, in its currency, fails the shortlist closed.
 * No database or chain: the tenant rows are a fake query function.
 */
import { describe, expect, it } from "vitest";
import { ApiError, exampleShortlistSpec, type CountryCode } from "@hogee/core";
import type { Db } from "@hogee/db";
import { createApiApp } from "../src/app";
import type { ApiDeps, CatalogPort, ChecksPort } from "../src/context";
import { ApiProblem } from "../src/http/problem";
import { CHECK_DOWN_REASON, rankFixtures, scorerCandidates } from "../src/services/shortlist";
import { scriptedAgent } from "./support/agent";
import { TEST_PACK_MY, TEST_SUPPLIERS, TEST_SUPPLIERS_SG, testCatalog, testChecks } from "./support/catalog";
import { facilityOnlyDb, fakeDeps } from "./support/fake-deps";

/** Every check and pack read the shortlist makes, so a test can show nothing was priced. */
function recording(): { checks: ChecksPort; catalog: CatalogPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    checks: {
      screenSanctions: async (n) => (calls.push("sanctions"), testChecks.screenSanctions(n)),
      validateRegistryId: (k, id) => (calls.push("registry"), testChecks.validateRegistryId(k, id)),
      fx: async (p, d) => (calls.push(`fx:${p}`), testChecks.fx(p, d)),
    },
    catalog: {
      ...testCatalog,
      countryPack: async (cc) => (calls.push(`pack:${cc}`), testCatalog.countryPack(cc)),
      suppliers: async () => (calls.push("suppliers"), testCatalog.suppliers()),
    },
  };
}

function on(country: CountryCode, currency: string, r = recording(), db?: Db): ApiDeps {
  const base = fakeDeps({ deps: { catalog: r.catalog, checks: r.checks, ...(db ? { db } : {}) } }).deps;
  return { ...base, config: { ...base.config, countryCode: country, currency } };
}

function expectConflict(error: unknown): void {
  expect(error).toBeInstanceOf(ApiProblem);
  expect((error as ApiProblem).failure.code).toBe("CONFLICT");
  expect((error as ApiProblem).failure.message).toMatch(/nothing was priced/);
}

describe("the shortlist build prices only in the server country's currency", () => {
  it.each([
    ["an SG server, an MYR shortlist", "SG", "SGD", "MYR"],
    ["an MY server, an SGD shortlist", "MY", "MYR", "SGD"],
    ["an SG server whose own currency is not SGD", "SG", "MYR", "SGD"],
    ["an MY server whose own currency is not MYR", "MY", "SGD", "MYR"],
  ] as const)("refuses %s with CONFLICT before any check or pack read", async (_label, country, serverCurrency, currency) => {
    const r = recording();
    const deps = on(country, serverCurrency, r);
    expectConflict(await rankFixtures(deps, "sl-x", TEST_SUPPLIERS, exampleShortlistSpec, currency).catch((e: unknown) => e));
    expectConflict(await scorerCandidates(deps, TEST_SUPPLIERS, exampleShortlistSpec, currency).catch((e: unknown) => e));
    expect(r.calls).toEqual([]);
  });

  it("prices when they agree (MY server, MYR; SG server, SGD)", async () => {
    expect((await rankFixtures(on("MY", "MYR"), "sl-my", TEST_SUPPLIERS, exampleShortlistSpec, "MYR")).shortlist?.status).toBe("READY");
    expect((await rankFixtures(on("SG", "SGD"), "sl-sg", TEST_SUPPLIERS_SG, exampleShortlistSpec, "SGD")).shortlist?.status).toBe("READY");
  });

  it("fails closed when the server country's pack file is another country's (no FX asked, nothing ranked)", async () => {
    const r = recording();
    const deps = on("SG", "SGD", { ...r, catalog: { ...r.catalog, countryPack: async (cc) => (r.calls.push(`pack:${cc}`), TEST_PACK_MY) } });
    expect(await rankFixtures(deps, "sl-wrong-pack", TEST_SUPPLIERS_SG, exampleShortlistSpec, "SGD")).toEqual({ error: CHECK_DOWN_REASON });
    expect(r.calls.filter((c) => c.startsWith("fx:"))).toEqual([]);
  });
});

describe("E3 (/api/eval/shortlist) prices through the same build", () => {
  it.each(["hogee", "llm_rank"] as const)("%s: an SG server refuses an MYR facility's set before any check or model call", async (mode) => {
    const r = recording();
    const agent = scriptedAgent();
    const catalog = { ...r.catalog, supplierEvalSet: async (setId: string) => ({ setId, listings: TEST_SUPPLIERS, spec: null }) };
    const base = fakeDeps({ deps: { catalog, checks: r.checks, agent, db: facilityOnlyDb() } }).deps;
    const deps = { ...base, config: { ...base.config, countryCode: "SG" as const, currency: "SGD" } };
    const res = await createApiApp(async () => deps).request("/api/eval/shortlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setId: "set-01", mode }) });
    // Eval routes answer a CONFLICT as their declared NOT_FOUND (routes/eval.ts onAnvil); the message is the shortlist's.
    expect(res.status).toBe(404);
    expect(ApiError.parse(await res.json()).error.message).toMatch(/This server prices for SG \(SGD\), but the shortlist is in MYR; nothing was priced/);
    expect(r.calls.filter((c) => !c.startsWith("pack:"))).toEqual([]);
    expect(agent.lastPrompt()).toBe("null");
  });
});

/** A database answering the facility and founder selects with the given rows; it records every statement. */
function tenantDb(rows: { facility?: Record<string, unknown>; founder?: Record<string, unknown> }): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const query = async (sql: string) => {
    statements.push(sql.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
    if (/from founders/.test(sql)) return { rows: rows.founder ? [rows.founder] : [], rowCount: rows.founder ? 1 : 0 };
    if (/from facilities/.test(sql)) return { rows: rows.facility ? [rows.facility] : [], rowCount: rows.facility ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  };
  return { statements, db: { $client: { query, connect: async () => ({ query, release: () => undefined }) } } as unknown as Db };
}

const facility = (currency: string) => ({ facility_id: "fac-rina", cap_minor: "1000000", currency, reserve_floor_bps: 300 });
const founder = (country: string) => ({ id: "founder-rina", country, residency: "citizen", passkey_credential_id: null, qx: null, qy: null, wallet_address: null, key_status: "PENDING_LENDER" });

async function shortlistOn(country: CountryCode, currency: string, rows: { facility?: Record<string, unknown>; founder?: Record<string, unknown> }) {
  const r = recording();
  const t = tenantDb(rows);
  const res = await createApiApp(async () => on(country, currency, r, t.db)).request("/api/suppliers/shortlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: exampleShortlistSpec }),
  });
  return { status: res.status, body: await res.json(), calls: r.calls, statements: t.statements };
}

describe("POST /api/suppliers/shortlist (compileEnv's server-country check)", () => {
  it.each([
    ["an SG server, an MY facility", "SG", "SGD", facility("MYR"), founder("MY")],
    ["an MY server, an SG facility", "MY", "MYR", facility("SGD"), founder("SG")],
    ["the right founder country, another currency", "SG", "SGD", facility("MYR"), founder("SG")],
    ["the right currency, another founder country", "SG", "SGD", facility("SGD"), founder("MY")],
    ["a server whose own currency is not its country's", "SG", "MYR", facility("SGD"), founder("SG")],
  ] as const)("refuses %s with 409 before anything is priced or stored", async (_label, country, currency, f, fo) => {
    const out = await shortlistOn(country, currency, { facility: f, founder: fo });
    expect(out.status).toBe(409);
    const { error } = ApiError.parse(out.body);
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toMatch(/nothing was priced/);
    expect(out.calls).toEqual([]);
    expect(out.statements).not.toContain("begin");
    expect(out.statements).not.toContain("insert");
  });

  it("refuses a facility without a founder (its country is unknown)", async () => {
    const out = await shortlistOn("SG", "SGD", { facility: facility("SGD") });
    expect(out.status).toBe(409);
    expect(ApiError.parse(out.body).error.message).toMatch(/no founder.*nothing was priced/);
    expect(out.calls).toEqual([]);
  });

  it("starts the shortlist when server, founder and facility agree", async () => {
    const out = await shortlistOn("MY", "MYR", { facility: facility("MYR"), founder: founder("MY") });
    expect(out.status).toBe(200);
    expect(out.calls).toContain("fx:CNY/MYR");
    expect(out.calls).toContain("pack:MY");
  });
});
