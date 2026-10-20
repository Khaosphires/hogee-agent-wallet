/**
 * The preflight runs before any migration or write, so it only reads: a database that was never migrated passes; the
 * anvil target refuses facilities of another chain; the Sepolia target refuses any facility row (a fresh final-1
 * Treasury has none open, so a row is another Treasury's, even under a reused deployment id) and a halted worker.
 */
import { describe, expect, it } from "vitest";
import type { Deployment } from "../src/api-internals";
import { databasePreflight, PreflightError, sepoliaChainPreflight } from "../src/safety";

interface Facility {
  readonly facility_id: string;
  readonly deployment_id: string;
  readonly chain_id: number;
}

/** A read-only fake of the few queries the preflight issues; it records every statement. */
function fakeSql(o: { migrated: boolean; facilities?: readonly Facility[]; activeHalts?: number }) {
  const statements: string[] = [];
  const sql = {
    async query(text: string, values: unknown[] = []) {
      statements.push(text);
      if (text.includes("to_regclass")) return { rows: [{ present: o.migrated }] };
      if (text.includes("from facilities where chain_id <> $1")) return { rows: (o.facilities ?? []).filter((f) => f.chain_id !== values[0]) };
      if (text.includes("from facilities")) return { rows: [...(o.facilities ?? [])] };
      if (text.includes("hogee_worker.halts")) return { rows: [{ n: o.activeHalts ?? 0 }] };
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return { sql: sql as never, statements };
}

const final1 = { facility_id: "fac-rina", deployment_id: "final-1", chain_id: 11155111 };
const anvilRow = { facility_id: "fac-main-a1b2c3", deployment_id: "final-mai123456", chain_id: 31337 };

describe("databasePreflight", () => {
  it("passes a database that was never migrated, on both targets, and only reads", async () => {
    for (const target of ["anvil", "sepolia"] as const) {
      const f = fakeSql({ migrated: false });
      await expect(databasePreflight(f.sql, target)).resolves.toBeUndefined();
      expect(f.statements.every((q) => /^\s*select\b/i.test(q))).toBe(true);
    }
  });

  it("anvil: refuses a database with a facility of another chain, keeps its own throwaway rows", async () => {
    await expect(databasePreflight(fakeSql({ migrated: true, facilities: [anvilRow] }).sql, "anvil")).resolves.toBeUndefined();
    const f = fakeSql({ migrated: true, facilities: [anvilRow, final1], activeHalts: 1 });
    await expect(databasePreflight(f.sql, "anvil")).rejects.toThrow(/fac-rina \(chain 11155111\).*throwaway database/);
    expect(f.statements.every((q) => /^\s*select\b/i.test(q))).toBe(true);
  });

  it("sepolia: refuses any facility row, including one under the same deployment id and chain", async () => {
    await expect(databasePreflight(fakeSql({ migrated: true }).sql, "sepolia")).resolves.toBeUndefined();
    await expect(databasePreflight(fakeSql({ migrated: true, facilities: [final1] }).sql, "sepolia")).rejects.toThrow(PreflightError);
    await expect(databasePreflight(fakeSql({ migrated: true, facilities: [{ ...final1, deployment_id: "loop-1" }] }).sql, "sepolia")).rejects.toThrow(/loop-1.*dedicated, empty database/);
  });

  it("sepolia: refuses a halted worker before anything clears or migrates", async () => {
    const f = fakeSql({ migrated: true, activeHalts: 2 });
    await expect(databasePreflight(f.sql, "sepolia")).rejects.toThrow(/worker is halted/);
    expect(f.statements.every((q) => /^\s*select\b/i.test(q))).toBe(true);
  });
});

describe("sepoliaChainPreflight", () => {
  const deployment = { chainId: 11155111, deploymentId: "final-1", contracts: { Treasury: { address: "0x0000000000000000000000000000000000000001" } } } as unknown as Deployment;
  const client = (chainId: number, opened: boolean) => ({ getChainId: async () => chainId, readContract: async () => ({ opened }) }) as never;

  it("needs the manifest's chain and a Treasury with no open facility", async () => {
    await expect(sepoliaChainPreflight(client(11155111, false), deployment)).resolves.toBeUndefined();
    await expect(sepoliaChainPreflight(client(1, false), deployment)).rejects.toThrow(/serves chain 1, the manifest is for chain 11155111/);
    await expect(sepoliaChainPreflight(client(11155111, true), deployment)).rejects.toThrow(/already has an open facility/);
  });
});
