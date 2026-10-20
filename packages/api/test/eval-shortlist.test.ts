/**
 * E3 ranks exactly what the product would (security audit run-5 item 5): the shipped shortlist only considers
 * suppliers from the spec's buyFrom country, so /api/eval/shortlist applies the same filter in both modes.
 */
import { describe, expect, it } from "vitest";
import { Shortlist } from "@hogee/core";
import { createApiApp } from "../src/app";
import { scriptedAgent, text } from "./support/agent";
import { TEST_SUPPLIERS, testCatalog, testChecks } from "./support/catalog";
import { facilityOnlyDb, fakeDeps } from "./support/fake-deps";

const domestic = { ...TEST_SUPPLIERS[1]!, supplier: { ...TEST_SUPPLIERS[1]!.supplier, supplierId: "supplier-my", country: "MY" } };
const listings = [TEST_SUPPLIERS[0]!, domestic, TEST_SUPPLIERS[2]!];

async function run(mode: "hogee" | "llm_rank", agent = scriptedAgent()) {
  const catalog = { ...testCatalog, supplierEvalSet: async (setId: string) => ({ setId, listings, spec: null }) };
  const f = fakeDeps({ deps: { catalog, checks: testChecks, agent, db: facilityOnlyDb() } });
  const res = await createApiApp(async () => f.deps).request("/api/eval/shortlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setId: "set-01", mode }) });
  return { res, agent };
}

describe("E3 considers only suppliers from spec.buyFrom (CN by default), like the product", () => {
  it("hogee: a supplier from another country is neither ranked nor excluded", async () => {
    const { res } = await run("hogee");
    expect(res.status).toBe(200);
    const s = Shortlist.parse(await res.json());
    expect([...s.candidates.map((c) => c.supplierId), ...s.excluded.map((e) => e.supplierId)].sort()).toEqual(["supplier-a", "supplier-c"]);
  });

  it("llm_rank: the baseline model is only shown the same suppliers", async () => {
    const agent = scriptedAgent();
    agent.queue(text(JSON.stringify({ ranking: ["supplier-my", "supplier-c", "supplier-a"] })));
    const { res } = await run("llm_rank", agent);
    expect(res.status).toBe(200);
    expect(Shortlist.parse(await res.json()).candidates.map((c) => c.supplierId)).toEqual(["supplier-c", "supplier-a"]);
    expect(agent.lastPrompt()).not.toContain("supplier-my");
  });
});
