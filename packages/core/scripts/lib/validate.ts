/** Pure validation helpers for scripts/validate-data.ts (unit-tested in test/validate-lib.test.ts). */
import type { z } from "zod";

export interface Issue {
  readonly file: string;
  readonly line?: number;
  readonly path: string;
  readonly message: string;
}

export interface FileResult {
  readonly records: number;
  readonly issues: readonly Issue[];
  /** Parsed, schema-valid values (for cross-record checks). */
  readonly values: readonly unknown[];
}

export function formatIssue(i: Issue): string {
  return `${i.file}${i.line !== undefined ? `:${i.line}` : ""}: ${i.path}: ${i.message}`;
}

function zodIssues(file: string, line: number | undefined, error: z.ZodError, prefix: (string | number)[] = []): Issue[] {
  return error.issues.map((iss) => ({
    file,
    line,
    path: [...prefix, ...iss.path.map(String)].join(".") || "(root)",
    message: iss.message,
  }));
}

/** Validate a whole-file JSON document. */
export function validateJsonText(file: string, text: string, schema: z.ZodType): FileResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { records: 0, values: [], issues: [{ file, path: "(json)", message: (e as Error).message }] };
  }
  const r = schema.safeParse(data);
  const records = Array.isArray(data) ? data.length : 1;
  return r.success ? { records, issues: [], values: [r.data] } : { records, issues: zodIssues(file, undefined, r.error), values: [] };
}

/** Validate JSON Lines: one record per non-blank line; line numbers are 1-based. */
export function validateJsonlText(file: string, text: string, schema: z.ZodType): FileResult {
  const issues: Issue[] = [];
  const values: unknown[] = [];
  let records = 0;
  text.split(/\r?\n/).forEach((raw, idx) => {
    if (raw.trim() === "") return;
    records += 1;
    const line = idx + 1;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      issues.push({ file, line, path: "(json)", message: (e as Error).message });
      return;
    }
    const r = schema.safeParse(data);
    if (r.success) values.push(r.data);
    else issues.push(...zodIssues(file, line, r.error));
  });
  return { records, issues, values };
}

/** Minimal RFC 4180 CSV parser (quoted fields, "" escapes, CRLF/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Validate a CSV with an exact header; each data row becomes an object of strings. */
export function validateCsvText(file: string, text: string, columns: readonly string[], schema: z.ZodType): FileResult {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = rows[0] ?? [];
  if (header.join(",") !== columns.join(",")) {
    return { records: 0, values: [], issues: [{ file, line: 1, path: "(header)", message: `expected header ${columns.join(",")}, got ${header.join(",")}` }] };
  }
  const issues: Issue[] = [];
  const values: unknown[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.length !== columns.length) {
      issues.push({ file, line, path: "(row)", message: `expected ${columns.length} columns, got ${cells.length}` });
      return;
    }
    const obj = Object.fromEntries(columns.map((c, j) => [c, cells[j]]));
    const r = schema.safeParse(obj);
    if (r.success) values.push(r.data);
    else issues.push(...zodIssues(file, line, r.error));
  });
  return { records: rows.length - 1, issues, values };
}

/** Issues for duplicate keys among records (key built by `keyOf`). */
export function duplicateKeyIssues(file: string, values: readonly unknown[], label: string, keyOf: (v: unknown) => string): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const v of values) {
    const key = keyOf(v);
    if (seen.has(key)) issues.push({ file, path: label, message: `duplicate ${label} ${key}` });
    seen.add(key);
  }
  return issues;
}

/** Issues for keys that more than one file uses (e.g. evidence ids across a catalog); reported at each later file. */
export function duplicateAcrossFiles(label: string, entries: readonly { readonly file: string; readonly key: string }[]): Issue[] {
  const firstFile = new Map<string, string>();
  const issues: Issue[] = [];
  for (const { file, key } of entries) {
    const first = firstFile.get(key);
    if (first !== undefined && first !== file) issues.push({ file, path: label, message: `duplicate ${label} ${key} (also in ${first})` });
    if (first === undefined) firstFile.set(key, file);
  }
  return issues;
}
