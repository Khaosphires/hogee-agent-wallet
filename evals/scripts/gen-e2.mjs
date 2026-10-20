// E2 dataset generator (project.md §15, §26.8; LABELING.md). Deterministic: a fixed seed, no clock, no network.
//   node evals/scripts/gen-e2.mjs           write evals/datasets/e2/{prompts,labels,hidden-answers,prompts.meta}.jsonl
//   node evals/scripts/gen-e2.mjs --check   rebuild in memory and exit 1 if any committed byte differs
// prompts.jsonl and labels.jsonl follow the frozen E2PromptRow / E2LabelRow schemas; hidden-answers.jsonl is the
// {promptId, slot, answer} file packages/api/src/runtime/eval-data.ts reads for the auto-answer (LABELING §2.4).
// prompts.meta.jsonl is a sidecar (case key, Chinese text, the ground-truth facts) for report breakdowns and for
// e2/compiler-check.ts; nothing in the API reads it. Labels come from e2/label.mjs (LABELING + pack JSON), never from
// the compiler.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rngFor } from './e1/rng.mjs';
import { MY_CASES } from './e2/cases-my.mjs';
import { SG_CASES } from './e2/cases-sg.mjs';
import { caseProblems } from './e2/checks.mjs';
import { labelFields } from './e2/label.mjs';
import { formatBudget, HIDDEN_SLOTS, SEED, SPLIT, VAGUE_TOTAL } from './e2/world.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.resolve(here, '../datasets/e2');
export const FILES = ['prompts.jsonl', 'labels.jsonl', 'hidden-answers.jsonl', 'prompts.meta.jsonl'];

/** Singapore first (the main country), then Malaysia; ids number each country from 001. */
const COUNTRY_CASES = [
  ['SG', SG_CASES],
  ['MY', MY_CASES],
];

/** One case → its prompt row, label row, hidden answer (vague only) and sidecar row. */
function buildCase(country, c, n) {
  const promptId = `e2-${country.toLowerCase()}-${String(n).padStart(3, '0')}`;
  if (c.hiddenSlot !== undefined && !HIDDEN_SLOTS.includes(c.hiddenSlot)) throw new Error(`${promptId}: hiddenSlot ${c.hiddenSlot} is not plan-changing`);
  const budget = formatBudget(country, c.lang, c.truth.budgetMinor, rngFor(SEED, `budget:${promptId}`));
  const text = c.text({ budget });
  const answer = c.hiddenSlot ? c.answer({ budget }) : undefined;
  const problems = caseProblems({ promptId, country, lang: c.lang, zh: c.zh, hiddenSlot: c.hiddenSlot, text, answer, truth: c.truth });
  if (problems.length) throw new Error(problems.join('\n'));
  const vague = c.hiddenSlot !== undefined;
  return {
    prompt: { promptId, country, lang: c.lang, vague, ...(vague ? { hiddenSlot: c.hiddenSlot } : {}), text },
    label: { promptId, fields: labelFields(country, c.truth) },
    hidden: vague ? { promptId, slot: c.hiddenSlot, answer } : null,
    meta: { promptId, key: c.key, country, lang: c.lang, zh: Boolean(c.zh), vague, ...(vague ? { hiddenSlot: c.hiddenSlot } : {}), truth: c.truth },
  };
}

/** Every built case, in file order. Throws on a split, vague count or key that breaks the dataset's shape. */
export function buildCases() {
  const built = COUNTRY_CASES.flatMap(([country, cases]) => {
    if (cases.length !== SPLIT[country]) throw new Error(`${country}: expected ${SPLIT[country]} prompts, got ${cases.length}`);
    return cases.map((c, i) => buildCase(country, c, i + 1));
  });
  const keys = built.map((b) => b.meta.key);
  if (new Set(keys).size !== keys.length) throw new Error('case keys must be unique');
  const vague = built.filter((b) => b.prompt.vague).length;
  if (vague !== VAGUE_TOTAL) throw new Error(`expected ${VAGUE_TOTAL} vague prompts, got ${vague}`);
  return built;
}

const jsonl = (values) => `${values.map((v) => JSON.stringify(v)).join('\n')}\n`;

/** The four files' exact contents. Pure: same output on every call. */
export function buildE2() {
  const built = buildCases();
  return {
    'prompts.jsonl': jsonl(built.map((b) => b.prompt)),
    'labels.jsonl': jsonl(built.map((b) => b.label)),
    'hidden-answers.jsonl': jsonl(built.flatMap((b) => (b.hidden ? [b.hidden] : []))),
    'prompts.meta.jsonl': jsonl(built.map((b) => b.meta)),
  };
}

async function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: node evals/scripts/gen-e2.mjs [--check]');
  const files = buildE2();
  if (args[0] === '--check') {
    const stale = [];
    for (const name of FILES) {
      const committed = await readFile(path.join(OUT_DIR, name), 'utf8').catch(() => null);
      if (committed !== files[name]) stale.push(name);
    }
    if (stale.length) throw new Error(`stale or non-deterministic: ${stale.join(', ')} (run node evals/scripts/gen-e2.mjs)`);
    process.stdout.write(`E2 check: ${FILES.length} files reproduce byte-for-byte.\n`);
    return;
  }
  for (const name of FILES) await writeFile(path.join(OUT_DIR, name), files[name], 'utf8');
  process.stdout.write(`E2: wrote ${FILES.join(', ')} to ${path.relative(process.cwd(), OUT_DIR) || '.'}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`gen-e2 failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
