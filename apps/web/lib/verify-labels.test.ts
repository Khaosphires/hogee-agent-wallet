/**
 * Every check the verifier can report has a plain-English label. The names are read from the verifier's source
 * (each `new Problems("…")` and each literal `name: "…"` check), so a new check fails here until it is labelled.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ONLINE_CHECK, verifyBundle } from "@hogee/verify-evidence";
import { CHECK_LABELS, checkLabel } from "./verify-labels";

const VERIFIER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tools/verify-evidence/src");
/** Problems collected inside another check and never reported as a row of their own. */
const INTERNAL = new Set(["dry run"]);

function verifierCheckNames(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(VERIFIER_SRC).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(VERIFIER_SRC, file), "utf8");
    for (const m of src.matchAll(/new Problems\("([^"]+)"\)/g)) names.add(m[1] as string);
    for (const m of src.matchAll(/\{ name: "([^"]+)", ok: false/g)) names.add(m[1] as string);
  }
  return [...names].filter((n) => !INTERNAL.has(n)).sort();
}

describe("verifier check labels", () => {
  it("finds the verifier's checks in its source", () => {
    const names = verifierCheckNames();
    expect(names.length).toBeGreaterThanOrEqual(18);
    expect(names).toContain("event sources (calldata ↔ events)");
    expect(names).toContain("SUMMARY.md (regenerated)");
  });

  it("labels and explains every check the verifier can report", () => {
    const missing = [...verifierCheckNames(), ONLINE_CHECK].filter((n) => !(n in CHECK_LABELS));
    expect(missing).toEqual([]);
    for (const [name, { label, explain }] of Object.entries(CHECK_LABELS)) {
      expect(label.length, name).toBeGreaterThan(0);
      expect(explain.length, name).toBeGreaterThan(20);
    }
  });

  it("labels what an empty bundle actually reports", () => {
    for (const c of verifyBundle({}).checks) expect(checkLabel(c.name).explain, c.name).not.toBe("");
  });

  it("shows an unknown check under its own name", () => {
    expect(checkLabel("something new")).toEqual({ label: "something new", explain: "" });
    expect(checkLabel("constructor")).toEqual({ label: "constructor", explain: "" });
  });
});
