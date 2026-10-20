// E1 dataset generator (project.md §15, §26.8; ROLE-P3 task 3.9). Deterministic: a fixed seed, no clock, no network.
//   node evals/scripts/gen-e1.mjs           write evals/datasets/e1/{attacks,clean,meta}.jsonl
//   node evals/scripts/gen-e1.mjs --check   rebuild in memory and exit 1 if any committed byte differs
// Rows follow the frozen E1AttackRow / E1CleanRow schemas (data/schemas/e1-*.schema.json). meta.jsonl is a sidecar
// (country, scenario, hard negative, Chinese text) for report breakdowns; the frozen rows have no field for it.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AMOUNT_MANIPULATION } from './e1/cat-amount.mjs';
import { DATA_EXTRACTION } from './e1/cat-extraction.mjs';
import { ENCODED_PAYLOAD } from './e1/cat-encoded.mjs';
import { INVOICE_INJECTION } from './e1/cat-invoice.mjs';
import { LISTING_INJECTION } from './e1/cat-listing.mjs';
import { MEMORY_POISONING } from './e1/cat-memory.mjs';
import { PAYEE_SUBSTITUTION } from './e1/cat-payee.mjs';
import { WEBHOOK_FORGERY } from './e1/cat-webhook.mjs';
import { buildWebSearch } from './e1/cat-websearch.mjs';
import { buildClean } from './e1/clean.mjs';
import { rngFor } from './e1/rng.mjs';
import { COUNTRY, LANGS, SEED } from './e1/world.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.resolve(here, '../datasets/e1');
export const FILES = ['attacks.jsonl', 'clean.jsonl', 'meta.jsonl'];

/** In the frozen enum order (E1_CATEGORIES). */
export const CATEGORIES = [INVOICE_INJECTION, LISTING_INJECTION, WEBHOOK_FORGERY, PAYEE_SUBSTITUTION, AMOUNT_MANIPULATION, MEMORY_POISONING, DATA_EXTRACTION, ENCODED_PAYLOAD];
export const ROWS_PER_CATEGORY = 30;

/**
 * Row i of a category: scenario s = i % 10 in round r = floor(i / 10). Each scenario appears once per language
 * (lang = LANGS[(s + r) % 3]), and 3 rows of every round are MY ((s + 3r) % 10 < 3: scenarios 0-2, then 7-9, then
 * 4-6), so every category is 10/10/10 en/ms/id and 21 SG / 9 MY, with MY rows 3/3/3 by language.
 */
export function slot(i) {
  const s = i % 10;
  const r = Math.floor(i / 10);
  return { s, lang: LANGS[(s + r) % 3], cc: (s + 3 * r) % 10 < 3 ? 'MY' : 'SG' };
}

function buildCategory(cat) {
  if (cat.scenarios.length !== 10) throw new Error(`${cat.category}: expected 10 scenarios, got ${cat.scenarios.length}`);
  const rng = rngFor(SEED, cat.category);
  const counters = { SG: 0, MY: 0 };
  return Array.from({ length: ROWS_PER_CATEGORY }, (_, i) => {
    const { s, lang, cc } = slot(i);
    const sc = cat.scenarios[s];
    const { payload, target } = sc.build({ C: COUNTRY[cc], lang, rng, cc });
    counters[cc] += 1;
    const caseId = `e1-${cc.toLowerCase()}-${cat.code}-${String(counters[cc]).padStart(3, '0')}`;
    const row = {
      caseId,
      category: cat.category,
      vector: sc.vector,
      lang,
      payload,
      attackerGoal: { kind: sc.goal, target },
      expected: 'blocked',
      ...(sc.taskRef ? { taskRef: sc.taskRef } : {}),
    };
    return { row, meta: { caseId, country: cc, scenario: `${cat.code}/${sc.key}`, hardNegative: false, zh: Boolean(sc.zh) } };
  });
}

// Format and default-ignorable characters (zero-width, bidi controls, tag characters, variation selectors) and the
// JSON line/paragraph separators are written as \u escapes: the parsed string is unchanged, the file stays readable
// and no editor or diff can drop them silently.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;
const escapeInvisible = (json) => json.replace(INVISIBLE, (ch) => Array.from({ length: ch.length }, (_, k) => `\\u${ch.charCodeAt(k).toString(16).padStart(4, '0')}`).join(''));

const jsonl = (values) => `${values.map((v) => escapeInvisible(JSON.stringify(v))).join('\n')}\n`;

/**
 * The three files' exact contents. Pure: same output on every call. The web_search rows (cat-websearch.mjs) are
 * appended after everything that existed before them (attacks after the 240, meta after the clean rows), so the
 * earlier lines keep their bytes and positions.
 */
export function buildE1() {
  const attacks = CATEGORIES.flatMap(buildCategory);
  const clean = buildClean(rngFor(SEED, 'CLEAN'));
  const web = buildWebSearch(rngFor(SEED, 'WEB_SEARCH'));
  return {
    'attacks.jsonl': jsonl([...attacks, ...web].map((x) => x.row)),
    'clean.jsonl': jsonl(clean.map((x) => x.row)),
    'meta.jsonl': jsonl([...attacks, ...clean, ...web].map((x) => x.meta)),
  };
}

async function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: node evals/scripts/gen-e1.mjs [--check]');
  const files = buildE1();
  if (args[0] === '--check') {
    const stale = [];
    for (const name of FILES) {
      const committed = await readFile(path.join(OUT_DIR, name), 'utf8').catch(() => null);
      if (committed !== files[name]) stale.push(name);
    }
    if (stale.length) throw new Error(`stale or non-deterministic: ${stale.join(', ')} (run node evals/scripts/gen-e1.mjs)`);
    process.stdout.write(`E1 check: ${FILES.length} files reproduce byte-for-byte.\n`);
    return;
  }
  for (const name of FILES) await writeFile(path.join(OUT_DIR, name), files[name], 'utf8');
  process.stdout.write(`E1: wrote ${FILES.join(', ')} to ${path.relative(process.cwd(), OUT_DIR) || '.'}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`gen-e1 failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
