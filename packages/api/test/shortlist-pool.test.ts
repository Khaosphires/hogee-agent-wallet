/**
 * POST /api/suppliers/shortlist runs its supplier checks (FX, sanctions, registry) BEFORE it opens the transaction
 * that stores the result (security audit run-5 item 8), so a slow outside check never holds a pooled pg client.
 */
import { describe, expect, it } from "vitest";
import { exampleShortlistSpec } from "@hogee/core";
import type { Db } from "@hogee/db";
import { createApiApp } from "../src/app";
import type { ChecksPort } from "../src/context";
import { testCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";

describe("shortlist checks run outside the transaction", () => {
  it("no pooled client is held while a check runs; the result is still stored in one transaction", async () => {
    let held = 0;
    const statements: string[] = [];
    // The facility and its founder are MY's, as the MY server's (the shortlist runs compileEnv's country check first).
    const tenant = (sql: string) =>
      /from facilities/.test(sql) ? [{ facility_id: "fac-rina", currency: "MYR" }] : /from founders/.test(sql) ? [{ id: "founder-rina", country: "MY" }] : [];
    const query = async (sql: string) => {
      statements.push(sql.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
      return { rows: tenant(sql), rowCount: 1 };
    };
    const db = {
      $client: {
        query,
        connect: async () => {
          held += 1;
          return { query, release: () => void (held -= 1) };
        },
      },
    } as unknown as Db;
    const heldDuringChecks: number[] = [];
    const checks: ChecksPort = {
      screenSanctions: async (n) => (heldDuringChecks.push(held), testChecks.screenSanctions(n)),
      validateRegistryId: (k, id) => (heldDuringChecks.push(held), testChecks.validateRegistryId(k, id)),
      fx: async (p, d) => (heldDuringChecks.push(held), testChecks.fx(p, d)),
    };
    const f = fakeDeps({ deps: { catalog: testCatalog, checks, db } });
    const res = await createApiApp(async () => f.deps).request("/api/suppliers/shortlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec: exampleShortlistSpec }),
    });
    expect(res.status).toBe(200);
    expect(heldDuringChecks.length).toBeGreaterThan(0);
    expect(heldDuringChecks.every((h) => h === 0)).toBe(true);
    expect(statements.filter((s) => s === "begin")).toHaveLength(1);
    expect(statements).toContain("commit");
    expect(held).toBe(0);
  });
});
