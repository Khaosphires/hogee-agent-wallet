/**
 * Never ranked on missing facts (security audit run-5 item 3): a supplier whose declared listing text could not be
 * read would pass the injection and off-platform gates as clean, so the shortlist fails closed instead, in the
 * product path (rankFixtures) and in E3 (/api/eval/shortlist), before any check or model call.
 */
import { describe, expect, it } from "vitest";
import { ApiError, exampleShortlistSpec } from "@hogee/core";
import { createApiApp } from "../src/app";
import type { ChecksPort } from "../src/context";
import { rankFixtures } from "../src/services/shortlist";
import { scriptedAgent } from "./support/agent";
import { TEST_SUPPLIERS, testCatalog, testChecks } from "./support/catalog";
import { facilityOnlyDb, fakeDeps } from "./support/fake-deps";

const unreadable = [TEST_SUPPLIERS[0]!, { ...TEST_SUPPLIERS[2]!, listingText: null }];

function countingChecks(): ChecksPort & { calls: number } {
  const c = {
    calls: 0,
    screenSanctions: async (n: string) => (c.calls++, testChecks.screenSanctions(n)),
    validateRegistryId: (k: "uscc" | "ssm", id: string) => (c.calls++, testChecks.validateRegistryId(k, id)),
    fx: async (p: `${string}/${string}`, d: string) => (c.calls++, testChecks.fx(p, d)),
  };
  return c;
}

describe("a supplier with unreadable listing text", () => {
  it("fails the product shortlist (nothing ranked, no check run)", async () => {
    const checks = countingChecks();
    const f = fakeDeps({ deps: { catalog: testCatalog, checks } });
    const out = await rankFixtures(f.deps, "sl-1", unreadable, exampleShortlistSpec, "MYR");
    expect(out.shortlist).toBeUndefined();
    expect(out.error).toMatch(/supplier-c/);
    expect(checks.calls).toBe(0);
  });

  it.each(["hogee", "llm_rank"] as const)("is a 404 for E3 %s, before any model call", async (mode) => {
    const agent = scriptedAgent();
    const catalog = { ...testCatalog, supplierEvalSet: async (setId: string) => ({ setId, listings: unreadable, spec: null }) };
    const f = fakeDeps({ deps: { catalog, checks: testChecks, agent, db: facilityOnlyDb() } });
    const res = await createApiApp(async () => f.deps).request("/api/eval/shortlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setId: "set-01", mode }) });
    expect(res.status).toBe(404);
    expect(ApiError.parse(await res.json()).error.message).toMatch(/listing text of supplier-c could not be read/);
    expect(agent.calls()).toBe(0);
  });
});
