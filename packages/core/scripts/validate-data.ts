/**
 * Validates repo data files against the frozen zod schemas (project.md §26.8).
 * Missing files print SKIP; invalid records print `file[:line]: path: message`; exit 1 on any failure.
 * Coverage hints (e.g. one payment per state in scenario-rina) print WARN and never fail.
 * Usage: tsx scripts/validate-data.ts [--require <glob,...>]
 *   G0-REVIEW (M13): --require (or env REQUIRED_DATA, comma-separated) makes matching targets mandatory: a missing
 *   file is a FAIL instead of a SKIP. Globs match target labels as printed (`*` = one path segment, `**` = any),
 *   e.g. --require 'data/country-packs/*.json,fixtures/scenario-rina/*.json'. A glob that matches no target fails
 *   (typo guard). Default: everything optional.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { z } from "zod";
import {
  BundleManifest,
  CountryPack,
  E1AttackRow,
  E1CleanRow,
  E2LabelRow,
  E2PromptRow,
  E5DocRow,
  EXCEPTION_STATUSES,
  EvidenceRows,
  HashVectors,
  PAYMENT_STATES,
  PiiCanaryFile,
  PiiRecognizersFile,
  RecordedListingReading,
  RecordedTavilySearch,
  SANCTIONS_CSV_COLUMNS,
  SCENARIO_RINA_FILE_SCHEMAS,
  SanctionsRow,
  Supplier,
  SupplierEvalLabel,
  SupplierFile,
  supplierFileParts,
} from "../src/index";
import { REPO_ROOT } from "./lib/paths";
import {
  duplicateAcrossFiles,
  duplicateKeyIssues,
  formatIssue,
  validateCsvText,
  validateJsonlText,
  validateJsonText,
  type FileResult,
  type Issue,
} from "./lib/validate";

type Format = "json" | "jsonl" | "csv";

interface Target {
  /** Repo-relative file, or a directory + file-name pattern. */
  readonly file?: string;
  readonly dir?: string;
  readonly match?: RegExp;
  /** Human-readable form of dir + match for SKIP lines. */
  readonly glob?: string;
  readonly format: Format;
  readonly schema: z.ZodType;
  /** Extra checks on schema-valid values. */
  readonly check?: (file: string, values: readonly unknown[]) => Issue[];
  /** Checks across every schema-valid file of the target (run once, after all of them). */
  readonly checkAll?: (files: readonly { readonly file: string; readonly values: readonly unknown[] }[]) => Issue[];
  readonly warn?: (file: string, values: readonly unknown[]) => string[];
}

const field = (k: string) => (v: unknown) => String((v as Record<string, unknown>)[k]);
const unique = (label: string, keyOf: (v: unknown) => string) => (file: string, values: readonly unknown[]) =>
  duplicateKeyIssues(file, values, label, keyOf);

const coverage = (key: string, expected: readonly string[]) => (file: string, values: readonly unknown[]) => {
  const list = (values[0] ?? []) as Record<string, unknown>[];
  const have = new Set(list.map((x) => String(x[key])));
  const missing = expected.filter((s) => !have.has(s));
  return missing.length ? [`${file}: no record with ${key} ${missing.join(", ")} (ROLE-P3 3.2 asks for one per ${key})`] : [];
};

const scenarioTargets: Target[] = Object.entries(SCENARIO_RINA_FILE_SCHEMAS).map(([name, schema]) => ({
  file: `fixtures/scenario-rina/${name}`,
  format: "json",
  schema,
  ...(name === "payments.json" ? { warn: coverage("state", PAYMENT_STATES) } : {}),
  ...(name === "exceptions.json" ? { warn: coverage("status", EXCEPTION_STATUSES) } : {}),
}));

const TARGETS: readonly Target[] = [
  {
    dir: "data/country-packs",
    match: /^[^/]+\.json$/,
    glob: "data/country-packs/*.json",
    format: "json",
    schema: CountryPack,
    check: (file, values) => {
      const cc = (values[0] as { countryCode: string } | undefined)?.countryCode;
      const expected = file.split("/").pop()?.replace(/\.json$/, "");
      return cc && cc !== expected ? [{ file, path: "countryCode", message: `file name says ${expected}, pack says ${cc}` }] : [];
    },
  },
  // w2-core: demo files are SupplierFile ({supplier, evidence[]} or a plain Supplier). The schema checks that every
  // evidence row names the file's supplier and that ids are unique in the file; the API stores evidence per facility by
  // evidenceId alone (a duplicate is silently dropped), so ids must also be unique across the whole demo catalog.
  {
    dir: "data/suppliers/demo",
    match: /^[^/]+\.json$/,
    glob: "data/suppliers/demo/*.json",
    format: "json",
    schema: SupplierFile,
    checkAll: (files) =>
      duplicateAcrossFiles(
        "evidenceId",
        files.flatMap(({ file, values }) => values.flatMap((v) => supplierFileParts(v as SupplierFile).evidence.map((e) => ({ file, key: e.evidenceId })))),
      ),
  },
  // G0-DECISION: eval listings (data/suppliers/eval/set-XX/listings/*.json) are Supplier records too.
  {
    dir: "data/suppliers/eval",
    match: /^set-[0-9]{2}\/listings\/[^/]+\.json$/,
    glob: "data/suppliers/eval/set-XX/listings/*.json",
    format: "json",
    schema: Supplier,
  },
  // VISION-DECISIONS §8: recorded web search mode. The raw Tavily responses and the recorded Reader outputs (one per
  // web supplier, named after its docId).
  {
    dir: "data/suppliers/search/recorded",
    match: /^[^/]+\.json$/,
    glob: "data/suppliers/search/recorded/*.json",
    format: "json",
    schema: RecordedTavilySearch,
  },
  {
    dir: "data/suppliers/search/reader",
    match: /^[^/]+\.json$/,
    glob: "data/suppliers/search/reader/*.json",
    format: "json",
    schema: RecordedListingReading,
    check: (file, values) => {
      const docId = (values[0] as { docId: string } | undefined)?.docId;
      const expected = file.split("/").pop()?.replace(/\.json$/, "");
      return docId && docId !== expected ? [{ file, path: "docId", message: `file name says ${expected}, reading says ${docId}` }] : [];
    },
  },
  {
    file: "data/suppliers/eval/labels.jsonl",
    format: "jsonl",
    schema: SupplierEvalLabel,
    check: unique("setId+supplierId", (v) => `${field("setId")(v)}/${field("supplierId")(v)}`),
  },
  { file: "data/golden/hash-vectors.json", format: "json", schema: HashVectors },
  { file: "data/sanctions/un_sc.csv", format: "csv", schema: SanctionsRow },
  { file: "data/pii/recognizers.json", format: "json", schema: PiiRecognizersFile },
  { file: "data/pii/canary-patterns.json", format: "json", schema: PiiCanaryFile },
  { file: "evals/datasets/e1/attacks.jsonl", format: "jsonl", schema: E1AttackRow, check: unique("caseId", field("caseId")) },
  { file: "evals/datasets/e1/clean.jsonl", format: "jsonl", schema: E1CleanRow, check: unique("caseId", field("caseId")) },
  { file: "evals/datasets/e2/prompts.jsonl", format: "jsonl", schema: E2PromptRow, check: unique("promptId", field("promptId")) },
  { file: "evals/datasets/e2/labels.jsonl", format: "jsonl", schema: E2LabelRow, check: unique("promptId", field("promptId")) },
  { file: "evals/datasets/e5/docs.jsonl", format: "jsonl", schema: E5DocRow, check: unique("docId", field("docId")) },
  ...scenarioTargets,
  { file: "fixtures/evidence-sample/evidence.json", format: "json", schema: EvidenceRows },
  { file: "fixtures/evidence-sample/manifest.json", format: "json", schema: BundleManifest },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function filesFor(t: Target): { label: string; files: string[] } {
  if (t.file) return { label: t.file, files: existsSync(join(REPO_ROOT, t.file)) ? [t.file] : [] };
  const dir = join(REPO_ROOT, t.dir ?? "");
  const label = t.glob ?? `${t.dir}/*`;
  if (!existsSync(dir)) return { label, files: [] };
  const files = walk(dir)
    .map((p) => relative(dir, p).split("\\").join("/"))
    .filter((rel) => t.match?.test(rel) ?? true)
    .sort()
    .map((rel) => `${t.dir}/${rel}`);
  return { label, files };
}

function validateFile(t: Target, file: string): FileResult {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  if (t.format === "jsonl") return validateJsonlText(file, text, t.schema);
  if (t.format === "csv") return validateCsvText(file, text, SANCTIONS_CSV_COLUMNS, t.schema);
  return validateJsonText(file, text, t.schema);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function requiredGlobs(): string[] {
  const i = process.argv.indexOf("--require");
  const raw = [i >= 0 ? process.argv[i + 1] ?? "" : "", process.env.REQUIRED_DATA ?? ""].join(",");
  return raw.split(",").map((g) => g.trim()).filter(Boolean);
}

let ok = 0;
let skipped = 0;
let failed = 0;
const out: string[] = [];

const required = requiredGlobs().map((glob) => ({ glob, re: globToRegExp(glob), used: false }));
const isRequired = (label: string): boolean => {
  let hit = false;
  for (const r of required) {
    if (r.re.test(label)) {
      r.used = true;
      hit = true;
    }
  }
  return hit;
};

for (const t of TARGETS) {
  const { label, files } = filesFor(t);
  const valid: { file: string; values: readonly unknown[] }[] = [];
  const mandatory = isRequired(label);
  if (files.length === 0) {
    if (mandatory) {
      failed += 1;
      out.push(`FAIL  ${label}: required (--require/REQUIRED_DATA) but missing`);
    } else {
      skipped += 1;
      out.push(`SKIP  ${label} (missing)`);
    }
    continue;
  }
  for (const file of files) {
    const result = validateFile(t, file);
    const issues = [...result.issues, ...(result.issues.length === 0 && t.check ? t.check(file, result.values) : [])];
    if (issues.length > 0) {
      failed += 1;
      for (const issue of issues) out.push(`FAIL  ${formatIssue(issue)}`);
      continue;
    }
    ok += 1;
    valid.push({ file, values: result.values });
    out.push(`OK    ${file} (${result.records} record${result.records === 1 ? "" : "s"})`);
    for (const w of t.warn?.(file, result.values) ?? []) out.push(`WARN  ${w}`);
  }
  const across = t.checkAll?.(valid) ?? [];
  if (across.length > 0) {
    failed += 1;
    for (const issue of across) out.push(`FAIL  ${formatIssue(issue)}`);
  }
}

for (const r of required.filter((x) => !x.used)) {
  failed += 1;
  out.push(`FAIL  --require ${r.glob}: matches no known data target`);
}

const knownScenario = new Set(Object.keys(SCENARIO_RINA_FILE_SCHEMAS));
const scenarioDir = join(REPO_ROOT, "fixtures/scenario-rina");
if (existsSync(scenarioDir)) {
  for (const name of readdirSync(scenarioDir).filter((n) => n.endsWith(".json") && !knownScenario.has(n))) {
    out.push(`WARN  fixtures/scenario-rina/${name}: no schema registered (see SCENARIO_RINA_FILE_SCHEMAS)`);
  }
}

process.stdout.write(`${out.join("\n")}\nvalidate:data: ${ok} ok, ${skipped} skipped, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
