// Shared inputs of the E2 generator: the seed, the two country packs (read as plain JSON, never through @hogee/core),
// the frozen enums from the generated JSON Schemas, and the founder-style money formats. No clock, no network.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');

export const SEED = 20261018;
/** P1 Q4 (SG-DECISIONS 23:25): 24 SG and 16 MY prompts, no ID. */
export const SPLIT = { SG: 24, MY: 16 };
/** project.md §15: 20 of the 40 prompts are deliberately vague, each hiding one plan-changing slot. */
export const VAGUE_TOTAL = 20;
/** LABELING §2.3: the plan-changing facts, so the only slots a prompt may hide. */
export const HIDDEN_SLOTS = ['residency', 'productCategory', 'buyFrom', 'budgetCeilingMinor'];

const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

/** The country packs the labels are derived from (LABELING §0). */
export const PACKS = { SG: readJson('data/country-packs/SG.json'), MY: readJson('data/country-packs/MY.json') };

export const LABEL_SCHEMA = readJson('data/schemas/e2-label-row.schema.json');
export const PROMPT_SCHEMA = readJson('data/schemas/e2-prompt-row.schema.json');
/** Frozen REGISTRATIONS order (enums.ts), used to order each label's registration set like LABELING's example row. */
export const REGISTRATION_ORDER = LABEL_SCHEMA.properties.fields.properties.registrations.items.enum;

/** The value of a pack leaf. Throws unless it is a Sourced leaf: a label never rests on an unsourced number. */
export function leaf(node, where) {
  if (!node || typeof node !== 'object' || !('value' in node) || typeof node.sourceUrl !== 'string') {
    throw new Error(`PACK_FACT_MISSING:${where}`);
  }
  return node.value;
}

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const thousands = (n) => (n % 1000 === 0 ? String(n / 1000) : (n / 1000).toFixed(1));

/** How founders write an amount, per country and language; one is picked per prompt from the seeded stream. */
const MONEY_STYLES = {
  SG: {
    en: [(n) => `S$${grouped(n)}`, (n) => `SGD ${grouped(n)}`, (n) => `S$${thousands(n)}k`, (n) => `${grouped(n)} SGD`],
    ms: [(n) => `S$${grouped(n)}`, (n) => `SGD ${grouped(n)}`],
  },
  MY: {
    en: [(n) => `RM${grouped(n)}`, (n) => `RM ${grouped(n)}`, (n) => `RM${thousands(n)}k`],
    ms: [(n) => `RM${grouped(n)}`, (n) => `RM${thousands(n)} ribu`, (n) => `RM ${grouped(n)}`],
  },
};

/** A budget in minor units (cents or sen) written the way a founder in `country` would type it in `lang`. */
export function formatBudget(country, lang, budgetMinor, rng) {
  const minor = BigInt(budgetMinor);
  if (minor % 100n !== 0n) throw new Error(`budget ${budgetMinor} is not a whole amount`);
  const styles = MONEY_STYLES[country]?.[lang];
  if (!styles) throw new Error(`no money style for ${country}/${lang}`);
  return rng.pick(styles)(Number(minor / 100n));
}
