/**
 * One country per server (SG-DESIGN §4, fail-opens 2, 3 and 7): the founder row's country is checked at runtime, the
 * catalog serves only the configured country's payees, the facility opens with that country's currency, founder
 * country and payees, and a compile refuses a facility of another country. No database or chain: each guard refuses
 * before either is touched (the matching cases run end to end in test/live/facility-sg.live.test.ts).
 */
import { describe, expect, it } from "vitest";
import { ApiError, type CountryCode } from "@hogee/core";
import type { Db } from "@hogee/db";
import { createApiApp } from "../src/app";
import { DEMO_PAYEES_BY_COUNTRY } from "../src/catalog/payees";
import type { CatalogPort, OnboardedPayee } from "../src/context";
import { ApiProblem } from "../src/http/problem";
import { fileCatalog } from "../src/runtime/catalog";
import { compileEnv } from "../src/services/compile";
import type { Q } from "../src/services/sql";
import { founderRow } from "../src/services/facility";
import { fakeDeps } from "./support/fake-deps";

const SCOPE = { facilityId: "fac-rina", founderId: "founder-rina" };

/** A query function answering the facility and founder selects with the given rows (anything else: no rows). */
function tenantQ(rows: { facility?: Record<string, unknown>; founder?: Record<string, unknown> }): Q {
  const query = async (sql: string) => {
    if (/from founders/.test(sql)) return { rows: rows.founder ? [rows.founder] : [], rowCount: rows.founder ? 1 : 0 };
    if (/from facilities/.test(sql)) return { rows: rows.facility ? [rows.facility] : [], rowCount: rows.facility ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  };
  return { query } as unknown as Q;
}

const founder = (country: string) => ({ id: "founder-rina", country, residency: "citizen", passkey_credential_id: null, qx: null, qy: null, wallet_address: null, key_status: "PENDING_LENDER" });

describe("founderRow (fail-open 7)", () => {
  it("returns a row of a supported country", async () => {
    for (const country of ["MY", "ID", "SG"]) expect((await founderRow(tenantQ({ founder: founder(country) }), SCOPE))?.country).toBe(country);
    expect(await founderRow(tenantQ({}), SCOPE)).toBeUndefined();
  });

  it("refuses a row whose country is not a supported one, whatever its type says", async () => {
    for (const country of ["TH", "sg", "", "toString"]) {
      await expect(founderRow(tenantQ({ founder: founder(country) }), SCOPE), country).rejects.toThrow(/country/);
    }
  });
});

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("fileCatalog payees (fail-open 2)", () => {
  it("serves the configured country's payees only", async () => {
    expect((await fileCatalog(undefined, silent, "SG").payees()).map((p) => p.payeeId)).toEqual(["shopee-sg-ads", "shopee-sg-fees", "spx-sg-logistics", "iras-tax", "sg-packaging-printer"]);
    expect((await fileCatalog(undefined, silent, "SG").payees()).every((p) => p.account.channel === "SG_PAYNOW")).toBe(true);
    expect(await fileCatalog(undefined, silent, "MY").payees()).toBe(DEMO_PAYEES_BY_COUNTRY.MY);
  });

  it("refuses without a country, or for a country with no payee set (ID), instead of serving Rina's", async () => {
    await expect(fileCatalog(undefined, silent).payees()).rejects.toThrow(/HOGEE_COUNTRY/);
    await expect(fileCatalog(undefined, silent, "ID").payees()).rejects.toThrow(/No demo payees for ID/);
  });
});

const catalogOf = (payees: readonly OnboardedPayee[]): CatalogPort => ({ payees: async () => payees }) as unknown as CatalogPort;

/** An officer opening a facility on a server for `country` whose config and catalog are as given. No facility row yet. */
async function openOn(country: CountryCode, currency: string, payees: readonly OnboardedPayee[]) {
  const f = fakeDeps();
  const db = { $client: tenantQ({}) } as unknown as Db;
  const deps = { ...f.deps, config: { ...f.deps.config, countryCode: country, currency }, db, catalog: catalogOf(payees) };
  const res = await createApiApp(async () => deps, {}).request("/api/facility/open", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: f.cookie("officer") },
    body: JSON.stringify({ capMinor: "1000000", reserveFloorBps: 300 }),
  });
  return { status: res.status, error: ApiError.parse(await res.json()).error };
}

describe("openFacility (fail-open 2)", () => {
  it("refuses another country's payees before reading the chain (an SG facility never gets DuitNow or LHDN)", async () => {
    const r = await openOn("SG", "SGD", DEMO_PAYEES_BY_COUNTRY.MY);
    expect(r.status).toBe(502);
    expect(r.error.message).toMatch(/shopee-ads pays out on MY_DUITNOW, not SG's SG_PAYNOW/);
    const back = await openOn("MY", "MYR", DEMO_PAYEES_BY_COUNTRY.SG);
    expect(back.error.message).toMatch(/shopee-sg-ads pays out on SG_PAYNOW, not MY's MY_DUITNOW/);
  });

  it("refuses a configured currency that is not the country's, and a country with no payees", async () => {
    expect((await openOn("SG", "MYR", DEMO_PAYEES_BY_COUNTRY.SG)).error.message).toMatch(/currency MYR is not SG's \(SGD\)/);
    expect((await openOn("ID", "IDR", DEMO_PAYEES_BY_COUNTRY.MY)).error.message).toMatch(/No demo payees for ID/);
  });
});

/** compileEnv on a server for `country`/`currency` against the given rows; the chain is never reached when refused. */
async function compileOn(country: CountryCode, currency: string, rows: { facility?: Record<string, unknown>; founder?: Record<string, unknown> }) {
  const f = fakeDeps();
  const deps = { ...f.deps, config: { ...f.deps.config, countryCode: country, currency }, db: { $client: tenantQ(rows) } as unknown as Db };
  try {
    await compileEnv(deps, SCOPE, { firstPlan: true });
    return null;
  } catch (error: unknown) {
    return error;
  }
}

const facility = (currency: string) => ({ facility_id: "fac-rina", cap_minor: "1000000", currency, reserve_floor_bps: 300 });

describe("compileEnv (fail-open 3)", () => {
  it.each([
    ["an SG server, an MY facility", "SG", "SGD", facility("MYR"), founder("MY")],
    ["an MY server, an SG facility", "MY", "MYR", facility("SGD"), founder("SG")],
    ["the right founder country, another currency", "SG", "SGD", facility("MYR"), founder("SG")],
    ["the right currency, another founder country", "SG", "SGD", facility("SGD"), founder("MY")],
  ] as const)("refuses %s with CONFLICT before the chain", async (_label, country, currency, f, fo) => {
    const error = await compileOn(country, currency, { facility: f, founder: fo });
    expect(error).toBeInstanceOf(ApiProblem);
    expect((error as ApiProblem).failure.code).toBe("CONFLICT");
    expect((error as ApiProblem).failure.message).toMatch(/nothing was compiled/);
  });

  it("refuses a server whose own currency is not its country's, and a facility without a founder", async () => {
    expect(((await compileOn("SG", "MYR", { facility: facility("SGD"), founder: founder("SG") })) as ApiProblem).failure.code).toBe("CONFLICT");
    expect(((await compileOn("SG", "SGD", { facility: facility("SGD") })) as ApiProblem).failure.message).toMatch(/no founder/);
  });
});
