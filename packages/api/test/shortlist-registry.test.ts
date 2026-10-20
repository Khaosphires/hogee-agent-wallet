/**
 * Registry trust (security audit run-5 item 4): a validator result counts only when it is bound to the supplier
 * (core registryIdValidated checks supplierId and the exact id), so the shortlist must pass the supplier's id with
 * each check. A valid registry id now raises the supplier's trust score; an invalid one does not.
 */
import { describe, expect, it } from "vitest";
import { exampleShortlistSpec, type Shortlist } from "@hogee/core";
import { rankFixtures } from "../src/services/shortlist";
import { TEST_SUPPLIERS, testCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";

async function trustOf(valid: boolean): Promise<number> {
  const f = fakeDeps({ deps: { catalog: testCatalog, checks: { ...testChecks, validateRegistryId: () => ({ valid }) } } });
  // Supplier A without its tier-1 trust evidence, so trust comes from the registry id and platform metrics only.
  const a = TEST_SUPPLIERS[0]!;
  const fixture = { ...a, evidence: a.evidence.filter((e) => e.criterion !== "trust_verification") };
  const out = await rankFixtures(f.deps, "sl-1", [fixture], exampleShortlistSpec, "MYR");
  const s = out.shortlist as Shortlist;
  const c = s.candidates.find((x) => x.supplierId === "supplier-a");
  return c?.criteria.find((x) => x.criterion === "trust_verification")?.score ?? -1;
}

describe("registry checks are bound to the supplier", () => {
  it("a valid USCC raises trust_verification; an invalid one does not", async () => {
    expect(TEST_SUPPLIERS[0]?.supplier.ids.uscc).toBeTruthy();
    const [valid, invalid] = [await trustOf(true), await trustOf(false)];
    expect(valid).toBeGreaterThan(invalid);
  });
});
