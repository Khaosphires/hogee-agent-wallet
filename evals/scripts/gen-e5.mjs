/**
 * E5 privacy dataset (project.md §15 "E5 Privacy", §12.2, §26.8; ROLE-P3 task 3.8). Deterministic: one fixed
 * seed, no clock and no Math.random, so a re-run is byte-identical. Every row is re-checked before it is
 * written (fail closed: a row that cannot be made clean stops the run).
 *
 *   node evals/scripts/gen-e5.mjs           write evals/datasets/e5/docs.jsonl (150 MY/ID rows, then 40 SG
 *                                           rows) and its docs.meta.jsonl sidecar
 *   node evals/scripts/gen-e5.mjs --check   regenerate in memory, compare bytes with the files on disk,
 *                                           and re-check every row read back from disk
 *   node evals/scripts/gen-e5.mjs --sample  print 10 seeded spans with context for a hand check
 *
 * Row checks: docId/text/span shape as core's E5DocRow; spans sorted, non-overlapping, inside the text
 * (code points, end exclusive); each span's slice matches its entity's format and validator; the reference
 * detector (e5/ids.mjs, all eight entities) finds exactly the labelled spans, so no hard negative is a
 * valid ID; no well-known example number; and the wording lint finds nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkText } from "../../scripts/lint-wording/index.mjs";
import { detect, rejectValue, rngFrom, seedFor, sliceMatchesEntity } from "./e5/ids.mjs";
import { MAIN_PLAN } from "./e5/templates.mjs";
import { SG_PLAN } from "./e5/templates-sg.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(REPO, "evals", "datasets", "e5");
const SEED = 20261018;
const MAX_ATTEMPTS = 50;
const BASE_ENTITIES = ["MY_NRIC", "ID_NIK", "ID_NPWP", "MY_BANK_ACCOUNT", "MY_PHONE", "ID_PHONE"];
const SG_ENTITIES = ["SG_NRIC", "SG_PHONE"];
const ALL_ENTITIES = new Set([...BASE_ENTITIES, ...SG_ENTITIES]);
/**
 * True since core's PII_ENTITIES gained SG_NRIC and SG_PHONE (merged from p1/dev, 2026-10-18): the 40 SG rows are
 * appended after the 150 MY/ID rows (which stay byte-identical), so docs.jsonl holds all 190 and is the one
 * source of truth. False would split them back into docs.sg.jsonl (only for a core without the SG names).
 */
const SG_IN_MAIN = true;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const FILES = {
  main: join(OUT, "docs.jsonl"),
  mainMeta: join(OUT, "docs.meta.jsonl"),
  sg: join(OUT, "docs.sg.jsonl"),
  sgMeta: join(OUT, "docs.sg.meta.jsonl"),
};

// ---- rendering -----------------------------------------------------------------------------------
const cpLen = (s) => Array.from(s).length;

function render(parts) {
  let text = "";
  let cp = 0;
  const spans = [];
  const formats = [];
  const decoys = [];
  for (const part of parts.flat(Infinity)) {
    if (typeof part === "string") {
      text += part;
      cp += cpLen(part);
      continue;
    }
    const n = cpLen(part.text);
    if (part.entity) {
      spans.push({ start: cp, end: cp + n, entity: part.entity });
      formats.push(part.format);
    } else if (part.decoy) decoys.push({ start: cp, end: cp + n, kind: part.decoy });
    else throw new Error("template part is neither text, entity nor decoy");
    text += part.text;
    cp += n;
  }
  return { text, spans, formats, decoys };
}

/** UTF-16 index → code-point index, for detector matches. */
function cpIndex(text) {
  const map = new Map();
  let i = 0;
  let cp = 0;
  for (const ch of text) {
    map.set(i, cp);
    i += ch.length;
    cp++;
  }
  map.set(i, cp);
  return map;
}

// ---- checks --------------------------------------------------------------------------------------
const spanKey = (s) => `${s.start}:${s.end}:${s.entity}`;

/** Problems with one row; empty means clean. `allowed`: entity names this file may label. */
function checkRow(row, allowed) {
  const problems = [];
  if (typeof row.docId !== "string" || !ID_PATTERN.test(row.docId)) problems.push("docId is not an Id");
  if (typeof row.text !== "string") return [...problems, "text is not a string"];
  const cps = Array.from(row.text);
  if (cps.length < 1 || cps.length > 20000) problems.push(`text length ${cps.length} outside 1..20000`);
  if (!Array.isArray(row.spans)) return [...problems, "spans is not an array"];
  let prevEnd = 0;
  row.spans.forEach((s, i) => {
    const keys = Object.keys(s).sort().join(",");
    if (keys !== "end,entity,start") problems.push(`span ${i}: keys ${keys}`);
    if (!allowed.has(s.entity)) problems.push(`span ${i}: entity ${s.entity} not allowed in this file`);
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < prevEnd || s.start >= s.end || s.end > cps.length) {
      problems.push(`span ${i}: [${s.start}, ${s.end}) out of order or outside the text`);
      return;
    }
    const slice = cps.slice(s.start, s.end).join("");
    if (!sliceMatchesEntity(s.entity, slice)) problems.push(`span ${i}: ${s.entity} slice ${JSON.stringify(slice)} fails its format or validator`);
    if (rejectValue(slice)) problems.push(`span ${i}: ${JSON.stringify(slice)} is a well-known or patterned number`);
    prevEnd = s.end;
  });
  const toCp = cpIndex(row.text);
  const found = detect(row.text, ALL_ENTITIES).map((d) => ({ start: toCp.get(d.start), end: toCp.get(d.end), entity: d.entity }));
  const labelled = new Set(row.spans.map(spanKey));
  const detected = new Set(found.map(spanKey));
  for (const f of found) if (!labelled.has(spanKey(f))) problems.push(`unlabelled ${f.entity} at [${f.start}, ${f.end}): ${JSON.stringify(cps.slice(f.start, f.end).join(""))}`);
  for (const s of row.spans) if (!detected.has(spanKey(s))) problems.push(`labelled ${s.entity} at [${s.start}, ${s.end}) is not what the reference detector finds`);
  for (const f of checkText(row.text)) problems.push(`wording lint: line ${f.line} ${JSON.stringify(f.matched)}`);
  return problems;
}

// ---- generation ----------------------------------------------------------------------------------
function schedule(plan, tag) {
  const keys = Object.entries(plan).flatMap(([key, [, count]]) => Array(count).fill(key));
  return rngFrom(seedFor(SEED, tag, "schedule")).shuffle(keys);
}

function buildDoc(plan, key, docId, allowed) {
  let last = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const d = plan[key][0](rngFrom(seedFor(SEED, docId, attempt)));
    const { text, spans, formats, decoys } = render(d.parts);
    const row = { docId, text, spans };
    last = checkRow(row, allowed);
    if (last.length === 0) {
      return { row, meta: { docId, template: key, lang: d.lang, docType: d.docType, country: d.country, spanFormats: formats, decoys, attempt } };
    }
  }
  throw new Error(`${docId} (${key}): no clean rendering in ${MAX_ATTEMPTS} attempts; last problems: ${last.join("; ")}`);
}

function buildSet(plan, tag, prefix, allowed) {
  return schedule(plan, tag).map((key, i) => buildDoc(plan, key, `${prefix}${String(i + 1).padStart(4, "0")}`, allowed));
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function coreEntities() {
  const src = readFileSync(join(REPO, "packages", "core", "src", "schemas", "enums.ts"), "utf8");
  const m = src.match(/export const PII_ENTITIES = \[([^\]]*)\]/);
  if (!m) throw new Error("PII_ENTITIES not found in packages/core/src/schemas/enums.ts");
  return new Set([...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]));
}

function generate() {
  const core = coreEntities();
  const missing = BASE_ENTITIES.filter((e) => !core.has(e));
  if (missing.length) throw new Error(`core PII_ENTITIES lacks ${missing.join(", ")}`);
  const coreHasSg = SG_ENTITIES.every((e) => core.has(e));
  if (SG_IN_MAIN && !coreHasSg) throw new Error("SG_IN_MAIN is set but core PII_ENTITIES lacks SG_NRIC/SG_PHONE");
  const main = buildSet(MAIN_PLAN, "main", "e5-", new Set(BASE_ENTITIES));
  const sg = buildSet(SG_PLAN, "sg", "e5-sg-", ALL_ENTITIES);
  const files = SG_IN_MAIN
    ? { [FILES.main]: jsonl([...main, ...sg].map((d) => d.row)), [FILES.mainMeta]: jsonl([...main, ...sg].map((d) => d.meta)) }
    : {
        [FILES.main]: jsonl(main.map((d) => d.row)),
        [FILES.mainMeta]: jsonl(main.map((d) => d.meta)),
        [FILES.sg]: jsonl(sg.map((d) => d.row)),
        [FILES.sgMeta]: jsonl(sg.map((d) => d.meta)),
      };
  return { main, sg, files, coreHasSg };
}

// ---- reporting -----------------------------------------------------------------------------------
function tally(items) {
  const out = {};
  for (const k of items) out[k] = (out[k] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function stats(label, docs) {
  const spans = docs.flatMap((d) => d.row.spans);
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`${label}: ${docs.length} docs, ${spans.length} spans, ${docs.filter((d) => d.row.spans.length === 0).length} with no PII`);
  console.log(`  entities: ${fmt(tally(spans.map((s) => s.entity)))}`);
  console.log(`  lang: ${fmt(tally(docs.map((d) => d.meta.lang)))}`);
  console.log(`  docType: ${fmt(tally(docs.map((d) => d.meta.docType)))}`);
  console.log(`  decoys: ${fmt(tally(docs.flatMap((d) => d.meta.decoys.map((x) => x.kind))))}`);
  console.log(`  astral (emoji) docs: ${docs.filter((d) => /[\u{10000}-\u{10FFFF}]/u.test(d.row.text)).length}`);
}

function sample(docs) {
  const r = rngFrom(seedFor(SEED, "hand-check"));
  const all = docs.flatMap((d) => d.row.spans.map((s) => ({ d, s })));
  for (const { d, s } of r.shuffle(all).slice(0, 10)) {
    const cps = Array.from(d.row.text);
    const ctx = (a, b) => cps.slice(Math.max(0, a), b).join("").replace(/\n/g, " ⏎ ");
    console.log(`${d.row.docId} ${s.entity} [${s.start},${s.end}) ${JSON.stringify(cps.slice(s.start, s.end).join(""))}  …${ctx(s.start - 30, s.start)}[…]${ctx(s.end, s.end + 20)}…`);
  }
}

function checkOnDisk(files) {
  const problems = [];
  for (const [path, expected] of Object.entries(files)) {
    const name = relative(REPO, path);
    if (!existsSync(path)) problems.push(`${name}: missing`);
    else if (readFileSync(path, "utf8") !== expected) problems.push(`${name}: differs from a fresh generation`);
  }
  if (SG_IN_MAIN) for (const p of [FILES.sg, FILES.sgMeta]) if (existsSync(p)) problems.push(`${relative(REPO, p)}: should be removed once SG rows live in docs.jsonl`);
  const recheck = (path, allowed, count) => {
    if (!existsSync(path)) return;
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
    if (lines.length !== count) problems.push(`${relative(REPO, path)}: ${lines.length} rows, expected ${count}`);
    const ids = new Set();
    lines.forEach((line, i) => {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        problems.push(`${relative(REPO, path)}:${i + 1}: not JSON`);
        return;
      }
      if (Object.keys(row).join(",") !== "docId,text,spans") problems.push(`${relative(REPO, path)}:${i + 1}: keys must be docId,text,spans`);
      if (ids.has(row.docId)) problems.push(`${relative(REPO, path)}:${i + 1}: duplicate docId`);
      ids.add(row.docId);
      for (const p of checkRow(row, allowed)) problems.push(`${relative(REPO, path)}:${i + 1}: ${p}`);
    });
  };
  recheck(FILES.main, SG_IN_MAIN ? ALL_ENTITIES : new Set(BASE_ENTITIES), SG_IN_MAIN ? 190 : 150);
  if (!SG_IN_MAIN) recheck(FILES.sg, ALL_ENTITIES, 40);
  return problems;
}

function main(argv) {
  const { main: mainDocs, sg, files, coreHasSg } = generate();
  if (argv.includes("--sample")) return sample([...mainDocs, ...sg]);
  if (argv.includes("--check")) {
    const problems = checkOnDisk(files);
    for (const p of problems) console.error(p);
    console.log(`E5 check: ${problems.length === 0 ? "OK, files are byte-identical and every row is clean" : `${problems.length} problem(s)`}`);
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  for (const [path, body] of Object.entries(files)) writeFileSync(path, body);
  stats("docs.jsonl", SG_IN_MAIN ? [...mainDocs, ...sg] : mainDocs);
  if (!SG_IN_MAIN) stats("docs.sg.jsonl", sg);
  if (coreHasSg && !SG_IN_MAIN) console.log("Note: core PII_ENTITIES now has SG_NRIC and SG_PHONE; see SG_IN_MAIN in this script to merge the SG rows.");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`gen-e5 failed: ${error.stack}`);
  process.exitCode = 2;
}
