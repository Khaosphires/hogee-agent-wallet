import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoIds, redact } from "../src/index";

// Strings the app sends to a model all the time must pass through untouched, and must never trip the canary
// (a canary hit blocks the whole call).

async function expectUntouched(values: readonly string[]) {
  for (const v of values) {
    const r = await redact(v);
    expect(r.report.entities, v).toEqual([]);
    expect(r.text).toBe(v);
    expect(() => assertNoIds(v), v).not.toThrow();
  }
}

describe("no false positives on app data", () => {
  it("0x hashes and addresses, including all-digit stretches", () =>
    expectUntouched([
      "0x3171010101900001aa00000000000000000000000000000000000000000000ab",
      "0x900101145678abcdef0123456789abcdef012345",
      "invoiceHash 0x0000000000000000000000000000000000000000000000003171010101900001",
      "rationale 3171010101900001fe3a9c0e4b8d2f7a1c6e5b4d3a2f1e0d9c8b7a6f5e4d3c2b",
      "tx 0x9123456781234567812345678123456781234567812345678123456781234567",
    ]));

  it("UUIDs (decision, session and trace ids), even with an all-digit tail", () =>
    expectUntouched(["01a14202-2800-7344-8424-d235cd3bc74f", "01a14202-2800-7000-8000-0000000000aa", "01a14202-2800-7000-8000-900101145678", "3f2b8c1e-1234-8901-9123-345678901234"]));

  it("order, plan, line, payee and stage ids", () =>
    expectUntouched(["order-a-001", "ord-20261018-0001", "plan-v3", "line-ads", "stage-1", "fac-rina", "supplier-a", "shopee-sg-ads", "iras-tax", "draft-rina-mock", "evidence-A-landed_cost", "exception-approved", "final-1"]));

  it("amounts in minor units, also next to a phone or account word", () =>
    expectUntouched([
      "1000000",
      "125000",
      "30000000",
      "90000000",
      "300000000",
      "1000000000000000000",
      "Budget SGD 10,000 = 1000000 minor; ADS per-tx cap 30000, window 60000, pacing 7500.",
      "call me after the budget 30000000 is approved",
      "account balance RM 1250000000",
      "capMinor 61234567, window 604800 seconds",
    ]));

  it("dates and times", () => expectUntouched(["2026-10-18", "18/10/2026", "20261018", "2026-10-16T00:00:00Z", "1760572800", "1760572800000", "18 Oct 2026 23:59 UTC+8"]));

  it("HS codes", () => expectUntouched(["9617.00.10", "9617.00.1000", "HS 961700", "HS 96170010", "7323.93.00", "3924.10.90"]));

  it("Singapore UENs", () => expectUntouched(["UEN 53312345K", "201912345A", "T08LL1234A", "S99FC1234X", "ACRA UEN: 199912345M"]));

  it("Malaysian SSM numbers, new and old format", () => expectUntouched(["SSM 200501012345", "201901000005", "202001012345", "Syarikat ABC Sdn Bhd (201101061234)", "1234567-A", "123456-X"]));

  it("package versions, scoped names and decimals", () => expectUntouched(["react@18.3.1", "next@16.0.0", "@hogee/core", "score 0.3171010101900001", "rate 3.900101145678"]));
});

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function stringsOf(v: unknown, out: string[]): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      stringsOf(x, out);
    }
  }
  return out;
}

describe("repo fixtures (what the API feeds the planner and reader)", () => {
  // If a fixture ever carries a synthetic ID on purpose (a redaction demo), list it here instead of weakening this.
  const dirs = ["fixtures/scenario-rina", "data/country-packs", "data/golden"];

  it("no fixture string is redacted and no fixture file trips the canary", async () => {
    let leaves = 0;
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = readdirSync(join(REPO, dir)).filter((n) => n.endsWith(".json"));
      } catch {
        continue;
      }
      for (const name of names) {
        const text = readFileSync(join(REPO, dir, name), "utf8");
        expect(() => assertNoIds(text), `${dir}/${name}`).not.toThrow();
        for (const s of stringsOf(JSON.parse(text), [])) {
          leaves += 1;
          const r = await redact(s);
          expect(r.report.entities, `${dir}/${name}: ${s.slice(0, 80)}`).toEqual([]);
        }
      }
    }
    expect(leaves).toBeGreaterThan(1000);
  });
});
