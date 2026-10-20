/**
 * SG-DESIGN §4 fail-open 4: registry ids were validated as `kind === "uscc" ? USCC : SSM`, so a Singapore UEN (or
 * any new kind) was checked against Malaysia's SSM format. Now each kind has its own validator, an unknown kind is
 * refused, and the shortlist fails closed on an id it cannot check.
 */
import { describe, expect, it } from "vitest";
import { exampleShortlistSpec, type Supplier } from "@hogee/core";
import type { ValidationResult } from "@hogee/checks";
import { REGISTRY_KINDS, isRegistryKind, type ChecksPort, type RegistryKind, type SupplierFixture } from "../src/context";
import { LIVE_REGISTRY_VALIDATORS, liveChecks, registryValidator, type RegistryValidators } from "../src/runtime/ports";
import { CHECK_DOWN_REASON, rankFixtures, registryChecksOf } from "../src/services/shortlist";
import { TEST_SUPPLIERS, testCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";

/** Fake validators that record which kind was asked and accept only the ids listed for that kind. */
function fakeValidators(accept: Partial<Record<RegistryKind, string>> = {}) {
  const calls: [RegistryKind, string][] = [];
  const of = (kind: RegistryKind) => (id: string): ValidationResult => (calls.push([kind, id]), { valid: accept[kind] === id });
  const validators: RegistryValidators = { uscc: of("uscc"), ssm: of("ssm"), uen: of("uen") };
  return { calls, validators };
}

describe("registryValidator: exhaustive per kind", () => {
  it("sends each kind to its own validator only", () => {
    const { calls, validators } = fakeValidators({ uscc: "U1", ssm: "S1", uen: "E1" });
    const validate = registryValidator(validators);
    expect(validate("uscc", "U1")).toEqual({ valid: true });
    expect(validate("ssm", "S1")).toEqual({ valid: true });
    expect(validate("uen", "E1")).toEqual({ valid: true });
    // An id the SSM validator would accept, asked as a UEN, is the UEN validator's call: never SSM's.
    expect(validate("uen", "S1")).toEqual({ valid: false });
    expect(calls).toEqual([
      ["uscc", "U1"],
      ["ssm", "S1"],
      ["uen", "E1"],
      ["uen", "S1"],
    ]);
  });

  it("refuses a kind without a validator (lei, an unknown one) without calling any validator", () => {
    const { calls, validators } = fakeValidators();
    const validate = registryValidator(validators);
    for (const kind of ["lei", "acra", "", "SSM"]) expect(() => validate(kind as RegistryKind, "x")).toThrow(/no validator for registry id kind/);
    expect(calls).toEqual([]);
    expect(REGISTRY_KINDS).toEqual(["uscc", "ssm", "uen"]);
    expect(["uscc", "ssm", "uen"].every(isRegistryKind)).toBe(true);
    expect(["lei", "SSM", "toString", "__proto__"].some(isRegistryKind)).toBe(false);
  });

  it("fails closed: a validator that throws propagates, and only valid === true counts", () => {
    const boom = (): ValidationResult => {
      throw new Error("validator down");
    };
    expect(() => registryValidator({ ...fakeValidators().validators, uen: boom })("uen", "x")).toThrow(/validator down/);
    const loose = (): ValidationResult => ({ valid: "yes" }) as unknown as ValidationResult;
    expect(registryValidator({ ...fakeValidators().validators, ssm: loose })("ssm", "x")).toEqual({ valid: false });
  });

  it("the live port wires @hogee/checks validateUSCC, validateSSM and validateUEN", () => {
    expect(Object.keys(LIVE_REGISTRY_VALIDATORS).sort()).toEqual([...REGISTRY_KINDS].sort());
    // 12-digit new-format SSM company number: valid SSM, not a UEN format. Under the old code a UEN check passed it.
    expect(liveChecks.validateRegistryId("ssm", "201901012345")).toEqual({ valid: true });
    expect(liveChecks.validateRegistryId("uen", "201901012345")).toEqual({ valid: false });
    // UEN formats: business nnnnnnnnX, local company yyyynnnnnX, other entity TyyPQnnnnX.
    for (const uen of ["53312345D", "201912345K", "T09LL0001B"]) expect(liveChecks.validateRegistryId("uen", uen)).toEqual({ valid: true });
    expect(liveChecks.validateRegistryId("uscc", "201912345K")).toEqual({ valid: false });
    expect(() => liveChecks.validateRegistryId("lei" as RegistryKind, "529900T8BM49AURSDO55")).toThrow(/no validator/);
  });
});

/** A test supplier whose registry ids are `ids` (cast: core's Supplier.ids has no "uen" yet). */
function withIds(ids: Record<string, string>): SupplierFixture {
  const a = TEST_SUPPLIERS[0]!;
  return { ...a, supplier: { ...a.supplier, ids } as unknown as Supplier };
}

function recordingChecks(): { checks: ChecksPort; asked: [string, string][] } {
  const asked: [string, string][] = [];
  return { asked, checks: { ...testChecks, validateRegistryId: (kind, id) => (asked.push([kind, id]), { valid: true }) } };
}

describe("shortlist registry checks per kind", () => {
  it("checks each listed id by its own kind, bound to the supplier; an LEI is skipped as before", () => {
    const { checks, asked } = recordingChecks();
    const deps = fakeDeps({ deps: { checks } }).deps;
    const f = withIds({ uscc: "U-1", ssm: "S-1", uen: "201912345K", lei: "529900T8BM49AURSDO55" });
    const out = registryChecksOf(deps, f.supplier) as Record<string, unknown>;
    expect(asked).toEqual([
      ["uscc", "U-1"],
      ["ssm", "S-1"],
      ["uen", "201912345K"],
    ]);
    expect(out).toEqual({
      uscc: { supplierId: "supplier-a", id: "U-1", valid: true },
      ssm: { supplierId: "supplier-a", id: "S-1", valid: true },
      uen: { supplierId: "supplier-a", id: "201912345K", valid: true },
    });
    expect(registryChecksOf(deps, withIds({}).supplier)).toEqual({});
  });

  it("an id of a kind with no validator fails the shortlist closed (nothing ranked, no validator called)", async () => {
    const { checks, asked } = recordingChecks();
    const deps = fakeDeps({ deps: { catalog: testCatalog, checks } }).deps;
    const out = await rankFixtures(deps, "sl-kind", [withIds({ acra: "201912345K" }), ...TEST_SUPPLIERS.slice(1)], exampleShortlistSpec, "MYR");
    expect(out).toEqual({ error: CHECK_DOWN_REASON });
    // The other suppliers' USCCs may be checked before the refusal; the unknown kind's id never reaches any validator.
    expect(asked.filter(([, id]) => id === "201912345K")).toEqual([]);
  });

  it("a supplier's UEN is never sent to the SSM validator by the shortlist", async () => {
    const { checks, asked } = recordingChecks();
    const deps = fakeDeps({ deps: { catalog: testCatalog, checks } }).deps;
    const out = await rankFixtures(deps, "sl-uen", [withIds({ uen: "201912345K" })], exampleShortlistSpec, "MYR");
    expect(out.shortlist?.status).toBe("READY");
    expect(asked).toEqual([["uen", "201912345K"]]);
  });
});
