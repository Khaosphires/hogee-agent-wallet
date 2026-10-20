/**
 * SupplierFile (docs/decisions/suppliers.md Q1): a data/suppliers/demo file is `{supplier, evidence[]}` or a plain
 * Supplier, the two shapes packages/api runtime/files.ts loads. Evidence rows must name the file's supplier and carry
 * unique ids; validate:data also checks ids across the whole demo catalog (duplicateAcrossFiles).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SupplierFile, exampleSupplier, exampleSupplierWithEvidence, supplierFileParts, type SupplierEvidence } from "../src/index";
import { duplicateAcrossFiles } from "../scripts/lib/validate";
import { REPO_ROOT } from "../scripts/lib/paths";

const { evidence: rows, ...supplier } = exampleSupplierWithEvidence;
const row = rows[0] as SupplierEvidence;
const paths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) => r.error?.issues.map((i) => i.path.join(".")) ?? [];

describe("SupplierFile", () => {
  it("accepts a plain Supplier record (no evidence rows)", () => {
    const r = SupplierFile.safeParse(exampleSupplier);
    expect(r.success).toBe(true);
    expect(r.success && supplierFileParts(r.data)).toEqual({ supplier: exampleSupplier, evidence: [] });
  });

  it("accepts {supplier, evidence[]} and keeps the rows", () => {
    const r = SupplierFile.safeParse({ supplier, evidence: rows });
    expect(r.success).toBe(true);
    expect(r.success && supplierFileParts(r.data).evidence).toEqual(rows);
  });

  it("refuses an evidence row for another supplier", () => {
    const r = SupplierFile.safeParse({ supplier, evidence: [{ ...row, supplierId: "supplier-b" }] });
    expect(r.success).toBe(false);
    expect(paths(r)).toEqual(["evidence.0.supplierId"]);
  });

  it("refuses a repeated evidenceId in one file", () => {
    const r = SupplierFile.safeParse({ supplier, evidence: [row, { ...row, criterion: "compliance" }] });
    expect(r.success).toBe(false);
    expect(paths(r)).toEqual(["evidence.1.evidenceId"]);
  });

  it("refuses extra keys, a missing evidence array and a Supplier with evidence inlined", () => {
    expect(SupplierFile.safeParse({ supplier, evidence: rows, note: "x" }).success).toBe(false);
    expect(SupplierFile.safeParse({ supplier }).success).toBe(false);
    expect(SupplierFile.safeParse(exampleSupplierWithEvidence).success).toBe(false);
  });

  it("every data/suppliers/demo file parses", () => {
    const dir = join(REPO_ROOT, "data", "suppliers", "demo");
    const files = readdirSync(dir).filter((n) => n.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(SupplierFile.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8"))).success, name).toBe(true);
  });
});

describe("duplicateAcrossFiles", () => {
  it("flags a key used by two files, once per later file, and allows repeats inside one file", () => {
    const issues = duplicateAcrossFiles("evidenceId", [
      { file: "A.json", key: "ev-1" },
      { file: "A.json", key: "ev-1" },
      { file: "B.json", key: "ev-2" },
      { file: "C.json", key: "ev-1" },
    ]);
    expect(issues).toEqual([{ file: "C.json", path: "evidenceId", message: "duplicate evidenceId ev-1 (also in A.json)" }]);
  });
});
