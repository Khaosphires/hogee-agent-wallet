/**
 * SGD FX pairs (SG-DESIGN §3 packages/api: routes/plans.ts converter, services/shortlist.ts landed cost). Every rate
 * comes through the checks port (live: @hogee/checks getFx, X/SGD as a labelled BNM cross rate); these tests use fakes:
 * - the SG shortlist asks CNY/SGD (and USD/SGD for a USD quote) for the clock's date;
 * - the country preview asks MYR/SGD (an MY facility previewing SG) and SGD/MYR (an SG facility previewing MY);
 * - a missing rate fails closed: nothing is converted or ranked.
 */
import { describe, expect, it } from "vitest";
import { CheckInputError } from "@hogee/checks";
import { exampleShortlistSpec, type Sourced } from "@hogee/core";
import type { ApiDeps, ChecksPort, SupplierFixture } from "../src/context";
import { converter } from "../src/routes/plans";
import { liveChecks } from "../src/runtime/ports";
import { CHECK_DOWN_REASON, rankFixtures } from "../src/services/shortlist";
import { FX_SGD, TEST_SUPPLIERS_SG, sgTestCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";

const NOW = Date.parse("2026-10-16T02:00:00Z");

function recordingFx(base: ChecksPort = testChecks): { checks: ChecksPort; asked: [string, string][] } {
  const asked: [string, string][] = [];
  return { asked, checks: { ...base, fx: (pair, date) => (asked.push([pair, date]), base.fx(pair, date)) } };
}

function deps(checks: ChecksPort, country: "SG" | "MY" = "SG"): ApiDeps {
  const base = fakeDeps({ deps: { catalog: sgTestCatalog, checks, clock: () => NOW } }).deps;
  return { ...base, config: { ...base.config, countryCode: country, currency: country === "SG" ? "SGD" : "MYR" } };
}

describe("country preview FX (plans converter)", () => {
  it("MY facility previewing SG asks MYR/SGD; SG facility previewing MY asks SGD/MYR; both convert exactly", async () => {
    const { checks, asked } = recordingFx();
    const toSgd = await converter(deps(checks, "MY"), "MYR", "SGD");
    const toMyr = await converter(deps(checks), "SGD", "MYR");
    expect(asked).toEqual([
      ["MYR/SGD", "2026-10-16"],
      ["SGD/MYR", "2026-10-16"],
    ]);
    expect(toSgd("1000000")).toBe("312500"); // RM 10,000 at 0.3125 = SGD 3,125.00
    expect(toMyr("1000000")).toBe("3200000"); // SGD 10,000 at 3.2 = RM 32,000.00
    expect(toMyr("1")).toBe("3");
    expect(FX_SGD["MYR/SGD"].value * FX_SGD["SGD/MYR"].value).toBe(1);
  });

  it("the same currency asks for no rate; a missing rate fails closed", async () => {
    const { checks, asked } = recordingFx();
    expect((await converter(deps(checks), "SGD", "SGD"))("123")).toBe("123");
    expect(asked).toEqual([]);
    await expect(converter(deps(checks), "SGD", "IDR")).rejects.toThrow(/no test FX rate for SGD\/IDR/);
  });
});

describe("SG shortlist FX (landed cost in SGD)", () => {
  const usd = (f: SupplierFixture): SupplierFixture => ({ ...f, supplier: { ...f.supplier, offer: { ...f.supplier.offer, currency: "USD" } } });

  it("asks CNY/SGD for CNY quotes and USD/SGD for a USD quote, and prices each with its own rate", async () => {
    const { checks, asked } = recordingFx();
    const [a, b] = TEST_SUPPLIERS_SG;
    // A budget both quotes fit, so B (priced in USD) is ranked and carries its landed cost.
    const out = await rankFixtures(deps(checks), "sl-fx", [a!, usd(b!)], { ...exampleShortlistSpec, budgetMinor: "5000000" }, "SGD");
    expect(out.error).toBeUndefined();
    expect([...asked].sort()).toEqual([
      ["CNY/SGD", "2026-10-16"],
      ["USD/SGD", "2026-10-16"],
    ]);
    const fxOf = (id: string): Sourced<number> | undefined => out.shortlist?.candidates.find((c) => c.supplierId === id)?.landedCost.fx;
    expect(fxOf("supplier-a")).toEqual(FX_SGD["CNY/SGD"]);
    expect(fxOf("supplier-b")).toEqual(FX_SGD["USD/SGD"]);
  });

  it("a quote currency with no rate fails the whole shortlist closed", async () => {
    const noUsd: ChecksPort = { ...testChecks, fx: (pair, date) => (pair === "USD/SGD" ? Promise.reject(new Error("FX down")) : testChecks.fx(pair, date)) };
    const [a, b] = TEST_SUPPLIERS_SG;
    expect(await rankFixtures(deps(noUsd), "sl-fx-down", [a!, usd(b!)], exampleShortlistSpec, "SGD")).toEqual({ error: CHECK_DOWN_REASON });
  });
});

describe("the live FX port is @hogee/checks getFx (no network in these cases)", () => {
  it("same-currency SGD is 1 (tier3); a pair outside X/MYR and X/SGD is refused as input", async () => {
    expect((await liveChecks.fx("SGD/SGD", "2026-10-16")).value).toBe(1);
    await expect(liveChecks.fx("SGD/IDR", "2026-10-16")).rejects.toBeInstanceOf(CheckInputError);
    await expect(liveChecks.fx("CNY/SGD", "16-10-2026")).rejects.toBeInstanceOf(CheckInputError);
  });
});
