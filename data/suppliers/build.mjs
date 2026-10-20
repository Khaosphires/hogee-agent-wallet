#!/usr/bin/env node
/**
 * Deterministic generator for the supplier data (ROLE-P3 task 3.7; brief in docs/decisions/suppliers.md).
 *
 *   node data/suppliers/build.mjs            write data/suppliers/demo/** and data/suppliers/eval/**
 *   node data/suppliers/build.mjs --check    regenerate in memory; exit 1 if any generated file differs, is
 *                                            missing, or an unexpected file sits in demo/ or eval/
 *   node data/suppliers/build.mjs extract-un <consolidated.xml> --retrieved-at <ISO>
 *                                            pin the UN SC entities used as sanctions-screening TEST rows into
 *                                            data/suppliers/un-sc-entities.json (the only step that reads a download)
 *
 * Fixed seed, fixed dates, no network and no clock: the same inputs always give byte-identical files.
 * No dependencies (node: built-ins only).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoCatalog } from "./lib/demo.mjs";
import { evalSets } from "./lib/eval.mjs";
import { json } from "./lib/text.mjs";
import { checkedExtract, extractUnScEntities } from "./lib/un-sc.mjs";

export const SEED = 20261020;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const UN_EXTRACT = join(HERE, "un-sc-entities.json");

/** Every generated file as [repo-relative path, content]. */
export function generate(unSc) {
  const files = new Map();
  const put = (path, content) => {
    if (files.has(path)) throw new Error(`generated twice: ${path}`);
    files.set(path, content);
  };
  for (const { supplier, evidence, rawText } of demoCatalog(SEED, unSc)) {
    const letter = supplier.supplierId.slice(-1);
    put(`data/suppliers/demo/${letter.toUpperCase()}.json`, json({ supplier, evidence }));
    put(supplier.listing.rawTextRef, rawText);
  }
  const labels = [];
  for (const set of evalSets(SEED + 1, unSc)) {
    put(`data/suppliers/eval/${set.setId}/spec.json`, json(set.spec));
    for (const l of set.listings) {
      put(`data/suppliers/eval/${set.setId}/listings/${l.letter}.json`, json(l.supplier));
      put(l.supplier.listing.rawTextRef, l.rawText);
    }
    labels.push(...set.labels);
  }
  put("data/suppliers/eval/labels.jsonl", labels.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return files;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function check(files) {
  const problems = [];
  for (const [path, content] of files) {
    const abs = join(REPO, path);
    if (!existsSync(abs)) problems.push(`missing ${path}`);
    else if (readFileSync(abs, "utf8") !== content) problems.push(`differs ${path}`);
  }
  for (const abs of [...walk(join(HERE, "demo")), ...walk(join(HERE, "eval"))]) {
    const path = relative(REPO, abs).split("\\").join("/");
    if (!files.has(path)) problems.push(`unexpected ${path}`);
  }
  return problems;
}

function main(argv) {
  if (argv[0] === "extract-un") {
    const at = argv.indexOf("--retrieved-at");
    if (!argv[1] || at < 0 || !argv[at + 1]) throw new Error("usage: build.mjs extract-un <consolidated.xml> --retrieved-at <ISO date-time>");
    writeFileSync(UN_EXTRACT, json(extractUnScEntities(readFileSync(argv[1]), argv[at + 1])));
    process.stdout.write(`wrote ${relative(REPO, UN_EXTRACT)}\n`);
    return 0;
  }
  const files = generate(checkedExtract(JSON.parse(readFileSync(UN_EXTRACT, "utf8"))));
  if (argv.includes("--check")) {
    const problems = check(files);
    process.stdout.write(problems.length ? `${problems.join("\n")}\nsupplier data is stale: run node data/suppliers/build.mjs\n` : `supplier data up to date (${files.size} files)\n`);
    return problems.length ? 1 : 0;
  }
  for (const [path, content] of files) {
    const abs = join(REPO, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const extra = check(files);
  process.stdout.write(`wrote ${files.size} files\n${extra.map((p) => `WARN ${p}\n`).join("")}`);
  return extra.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`build.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
