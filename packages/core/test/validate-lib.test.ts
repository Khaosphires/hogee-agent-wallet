import { describe, expect, it } from "vitest";
import { E1CleanRow, SANCTIONS_CSV_COLUMNS, SanctionsRow, Session, exampleE1CleanRow, exampleSession } from "../src/index";
import { duplicateKeyIssues, formatIssue, parseCsv, validateCsvText, validateJsonlText, validateJsonText } from "../scripts/lib/validate";

describe("validate-data helpers", () => {
  it("reports file:line: path: message for a bad JSONL row", () => {
    const good = JSON.stringify(exampleE1CleanRow);
    const bad = JSON.stringify({ ...exampleE1CleanRow, amountMinor: 12000 });
    const r = validateJsonlText("evals/datasets/e1/clean.jsonl", `${good}\n\n${bad}\n{oops\n`, E1CleanRow);
    expect(r.records).toBe(3);
    const lines = r.issues.map(formatIssue);
    expect(lines[0]).toMatch(/^evals\/datasets\/e1\/clean\.jsonl:3: amountMinor: /);
    expect(lines[1]).toMatch(/^evals\/datasets\/e1\/clean\.jsonl:4: \(json\): /);
  });

  it("validates whole JSON files and reports nested paths", () => {
    expect(validateJsonText("s.json", JSON.stringify(exampleSession), Session).issues).toEqual([]);
    const r = validateJsonText("s.json", JSON.stringify({ ...exampleSession, chainId: "1" }), Session);
    expect(r.issues.map(formatIssue)).toEqual([expect.stringMatching(/^s\.json: chainId: /)]);
  });

  it("parses RFC 4180 CSV and validates sanctions rows", () => {
    expect(parseCsv('a,"b, c","d ""q"""\r\n1,2,3\n')).toEqual([
      ["a", "b, c", 'd "q"'],
      ["1", "2", "3"],
    ]);
    const csv = `name,aliases,listId,listedOn\n"DOE, JOHN",J. DOE;JD,QDi.001,2001-01-25\nX,,QDi.002,\nY,,QDi.003,25/01/2001\n`;
    const r = validateCsvText("un_sc.csv", csv, SANCTIONS_CSV_COLUMNS, SanctionsRow);
    expect(r.records).toBe(3);
    expect(r.issues.map(formatIssue)).toEqual([expect.stringMatching(/^un_sc\.csv:4: listedOn: /)]);
    expect(validateCsvText("x.csv", "name,listId\n", SANCTIONS_CSV_COLUMNS, SanctionsRow).issues[0]?.path).toBe("(header)");
  });

  it("flags duplicate ids", () => {
    const issues = duplicateKeyIssues("f", [{ id: "a" }, { id: "b" }, { id: "a" }], "id", (v) => (v as { id: string }).id);
    expect(issues).toHaveLength(1);
  });
});
