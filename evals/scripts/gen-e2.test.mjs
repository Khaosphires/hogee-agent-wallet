// node --test evals/scripts/gen-e2.test.mjs
// The E2 files are reproducible byte-for-byte, match the frozen JSON Schemas and the API's hidden-answer shape, keep
// P1's split (24 SG / 16 MY, 20 vague), hide exactly one plan-changing slot per vague prompt, carry hand-checked labels
// for the key rows, never derive labels from the compiler, fail closed on facts the packs lack, and pass the wording check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkText } from '../../scripts/lint-wording/index.mjs';
import { buildE2, FILES, OUT_DIR } from './gen-e2.mjs';
import { amountsIn, caseProblems } from './e2/checks.mjs';
import { labelFields } from './e2/label.mjs';
import { LABEL_SCHEMA, PROMPT_SCHEMA } from './e2/world.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const parse = (text) => text.trimEnd().split('\n').map((l) => JSON.parse(l));
const built = buildE2();
const prompts = parse(built['prompts.jsonl']);
const labels = parse(built['labels.jsonl']);
const hidden = parse(built['hidden-answers.jsonl']);
const meta = parse(built['prompts.meta.jsonl']);
const count = (xs, key) => xs.reduce((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});
const labelOf = (id) => labels.find((l) => l.promptId === id).fields;

/** The subset of JSON Schema the generated e2-*.schema.json files use. */
function schemaErrors(value, schema, at = '$') {
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${value} not in enum`];
  if (schema.type === 'boolean') return typeof value === 'boolean' ? [] : [`${at}: not a boolean`];
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return [`${at}: not an integer`];
    return (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum) ? [`${at}: out of range`] : [];
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${at}: not a string`];
    const errs = [];
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${at}: pattern`);
    return errs;
  }
  if (schema.type === 'array') return Array.isArray(value) ? value.flatMap((v, i) => schemaErrors(v, schema.items, `${at}[${i}]`)) : [`${at}: not an array`];
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${at}: not an object`];
    const missing = (schema.required ?? []).filter((k) => !(k in value)).map((k) => `${at}.${k}: missing`);
    const extra = schema.additionalProperties === false ? Object.keys(value).filter((k) => !(k in schema.properties)).map((k) => `${at}.${k}: extra`) : [];
    const nested = Object.entries(value).flatMap(([k, v]) => (schema.properties[k] ? schemaErrors(v, schema.properties[k], `${at}.${k}`) : []));
    return [...missing, ...extra, ...nested];
  }
  return [`${at}: unsupported schema`];
}

test('two builds are byte-identical and equal the committed files', async () => {
  const again = buildE2();
  for (const name of FILES) {
    assert.equal(again[name], built[name], `${name} is not deterministic`);
    assert.equal(await readFile(path.join(OUT_DIR, name), 'utf8'), built[name], `${name} is stale: run node evals/scripts/gen-e2.mjs`);
  }
});

test('every prompt and label row matches the frozen JSON Schema; hidden answers match the API reader', () => {
  for (const r of prompts) assert.deepEqual(schemaErrors(r, PROMPT_SCHEMA), [], r.promptId);
  for (const r of labels) assert.deepEqual(schemaErrors(r, LABEL_SCHEMA), [], r.promptId);
  // packages/api/src/runtime/eval-data.ts HiddenAnswerRow: {promptId: Id, slot: IntentSlot, answer: trimmed 1..500}.
  for (const h of hidden) {
    assert.deepEqual(Object.keys(h), ['promptId', 'slot', 'answer'], h.promptId);
    assert.match(h.promptId, new RegExp(PROMPT_SCHEMA.properties.promptId.pattern, 'u'));
    assert.ok(PROMPT_SCHEMA.properties.hiddenSlot.enum.includes(h.slot), h.promptId);
    assert.ok(h.answer.trim().length >= 1 && h.answer.trim().length <= 500, h.promptId);
  }
});

test('40 prompts: 24 SG then 16 MY, no ID, 20 vague; one label per prompt; one answer per vague prompt', () => {
  assert.equal(prompts.length, 40);
  assert.deepEqual(count(prompts, (r) => r.country), { SG: 24, MY: 16 });
  assert.deepEqual(count(prompts.filter((r) => r.vague), (r) => r.country), { SG: 12, MY: 8 });
  const ids = prompts.map((r) => r.promptId);
  assert.equal(new Set(ids).size, 40, 'promptIds unique');
  assert.deepEqual(labels.map((l) => l.promptId), ids, 'labels in prompt order');
  assert.deepEqual(meta.map((m) => m.promptId), ids, 'meta in prompt order');
  for (const r of prompts) assert.equal(r.vague, r.hiddenSlot !== undefined, r.promptId);
  assert.deepEqual(
    hidden.map((h) => [h.promptId, h.slot]),
    prompts.filter((r) => r.vague).map((r) => [r.promptId, r.hiddenSlot]),
    'exactly the vague prompts have an answer, for their own slot',
  );
});

test('the set varies residency, entity, category, origin, channel and language', () => {
  const truths = meta.map((m) => ({ ...m.truth, country: m.country }));
  for (const cc of ['SG', 'MY']) {
    const mine = truths.filter((t) => t.country === cc);
    assert.deepEqual(Object.keys(count(mine, (t) => t.residency)).sort(), ['citizen', 'foreigner', 'pr'], cc);
    assert.ok(Object.keys(count(mine, (t) => t.sellChannel)).length >= 3, `${cc} channels`);
  }
  assert.deepEqual(Object.keys(count(truths.filter((t) => t.country === 'SG'), (t) => t.productCategory)).sort(), ['apparel', 'cosmetics', 'drinkware_food_contact', 'electrical', 'food']);
  assert.deepEqual(Object.keys(count(labels, (l) => l.fields.entityType)).sort(), ['partnership', 'pte_ltd', 'sdn_bhd', 'sg_partnership', 'sg_sole_prop', 'sole_prop']);
  assert.deepEqual(Object.keys(count(labels, (l) => l.fields.dutyRoute)).sort(), ['EXEMPT', 'FORM_E', 'MFN']);
  assert.deepEqual(Object.keys(count(prompts.filter((r) => r.vague), (r) => r.hiddenSlot)).sort(), ['budgetCeilingMinor', 'buyFrom', 'productCategory', 'residency']);
  assert.ok(prompts.filter((r) => r.lang === 'ms').length >= 6, 'Malay prompts');
  assert.ok(meta.filter((m) => m.zh).length >= 4, 'Chinese-mixed prompts');
});

test('hand-checked labels: Mei and Rina, and one row per distinctive SG rule', () => {
  // LABELING §1's example row, for the Rina-style prompt (pack: SSM RM60, LHDN 0, Form E 0, drinkware NONE).
  assert.deepEqual(labelOf('e2-my-001'), {
    entityType: 'sole_prop', registrations: ['SSM_SOLE_PROP', 'LHDN_TIN'], indirectTaxRegistered: false, eInvoicing: false,
    dutyRoute: 'FORM_E', productApproval: 'NONE', reserveBps: 500, licenceCostMinor: '6000',
  });
  // Mei (SG-DESIGN §1.3): ACRA S$15 + S$100, CN goods MFN (not EXEMPT), SFA importer registration at fee 0.
  assert.deepEqual(labelOf('e2-sg-001'), {
    entityType: 'sg_sole_prop', registrations: ['ACRA_BUSINESS'], indirectTaxRegistered: false, eInvoicing: false,
    dutyRoute: 'MFN', productApproval: 'SFA', reserveBps: 500, licenceCostMinor: '11500',
  });
  assert.deepEqual(labelOf('e2-sg-012'), { ...labelOf('e2-sg-001'), entityType: 'pte_ltd', registrations: ['ACRA_PTE_LTD'], productApproval: 'HSA', licenceCostMinor: '32800' });
  assert.deepEqual(labelOf('e2-sg-016'), { ...labelOf('e2-sg-001'), entityType: 'sg_partnership', productApproval: 'CPSO_SAFETY_MARK', licenceCostMinor: '29500' });
  assert.deepEqual(labelOf('e2-sg-022'), { ...labelOf('e2-sg-001'), dutyRoute: 'EXEMPT', productApproval: 'NONE' }); // foreigner: pack-eligible sole prop
  assert.deepEqual(labelOf('e2-my-013'), { ...labelOf('e2-my-001'), entityType: 'sdn_bhd', registrations: ['SSM_SDN_BHD', 'LHDN_TIN'], dutyRoute: 'EXEMPT', licenceCostMinor: '101000' });
  for (const { fields } of labels) {
    assert.equal(fields.reserveBps, 500);
    assert.equal(fields.indirectTaxRegistered, false, 'launch scale');
    assert.equal(fields.eInvoicing, false, 'launch scale; SG InvoiceNow follows GST');
  }
});

const SG = { residency: 'citizen', partner: false, limitedLiability: false, productCount: 1, productCategory: 'drinkware_food_contact', buyFrom: 'CN', budgetMinor: '500000' };
const MY = { ...SG };

test('the labeller fails closed instead of guessing', () => {
  assert.throws(() => labelFields('MY', { ...MY, productCategory: 'cosmetics' }), /PACK_FACT_MISSING:productApprovals.cosmetics/);
  assert.throws(() => labelFields('MY', { ...MY, productCategory: 'food' }), /PACK_FACT_MISSING/);
  assert.throws(() => labelFields('SG', { ...SG, productCategory: 'other' }), /PACK_FACT_MISSING:productApprovals.other/);
  assert.throws(() => labelFields('SG', { ...SG, buyFrom: 'TH' }), /D5/);
  assert.throws(() => labelFields('SG', { ...SG, buyFrom: 'SG' }), /domestic purchase/);
  assert.throws(() => labelFields('MY', { ...MY, productCategory: 'apparel', buyFrom: 'CN' }), /ACFTA cover/);
  assert.throws(() => labelFields('SG', { ...SG, expectedTurnoverMinor: '150000000' }), /PACK_FACT_MISSING:registrations.IRAS_GST/);
  assert.throws(() => labelFields('ID', SG), /no pack/);
  assert.throws(() => labelFields('SG', { ...SG, productCount: 0 }), /productCount/);
});

test('the labeller follows the thresholds, the per-product fee and the entity rules', () => {
  // At or above a threshold the registration is labelled, and its fee must then come from the pack (MY.json has none).
  assert.throws(() => labelFields('MY', { ...MY, expectedTurnoverMinor: '300000000' }), /PACK_FACT_MISSING:registrations.MYINVOIS/);
  assert.equal(labelFields('MY', { ...MY, expectedTurnoverMinor: '299999900' }).eInvoicing, false);
  assert.equal(labelFields('MY', { ...MY, expectedTurnoverMinor: '90000000' }).indirectTaxRegistered, false, 'a reseller never registers for SST');
  assert.throws(() => labelFields('MY', { ...MY, expectedTurnoverMinor: '90000000', manufactures: true }), /PACK_FACT_MISSING:registrations.SST/);
  assert.equal(labelFields('SG', { ...SG, productCategory: 'cosmetics', productCount: 2 }).licenceCostMinor, '14100');
  assert.equal(labelFields('MY', { ...MY, residency: 'foreigner' }).entityType, 'sdn_bhd');
  assert.equal(labelFields('MY', { ...MY, residency: 'pr', partner: true }).entityType, 'partnership');
  assert.equal(labelFields('SG', { ...SG, residency: 'foreigner', partner: true }).entityType, 'sg_partnership');
  assert.equal(labelFields('SG', { ...SG, buyFrom: 'US' }).dutyRoute, 'MFN');
});

test('row checks catch a vague prompt that gives its slot away or an answer that misstates it', () => {
  const ok = { promptId: 'x', country: 'SG', lang: 'en', zh: false, truth: SG, text: 'Selling tumblers from China, budget S$5,000.' };
  assert.deepEqual(caseProblems({ ...ok, hiddenSlot: 'residency', answer: "I'm a Singapore citizen." }), []);
  assert.match(caseProblems({ ...ok, hiddenSlot: 'residency', text: `I'm Singaporean. ${ok.text}`, answer: 'citizen' }).join(), /gives it away/);
  assert.match(caseProblems({ ...ok, hiddenSlot: 'residency', answer: "I'm a PR." }).join(), /does not give residency/);
  assert.match(caseProblems({ ...ok, hiddenSlot: 'budgetCeilingMinor', answer: 'S$5,000' }).join(), /names an amount/);
  assert.match(caseProblems({ ...ok, text: 'Selling tumblers from China, budget S$4,000.' }).join(), /does not state the budget/);
  assert.deepEqual(amountsIn('S$4.5k, RM8 ribu, 12,000 SGD'), [4500, 8000, 12000]);
});

test('labels are never derived from the compiler: the generator imports no @hogee code', async () => {
  const sources = ['gen-e2.mjs', ...(await readdir(path.join(here, 'e2'))).filter((f) => f.endsWith('.mjs')).map((f) => `e2/${f}`)];
  for (const f of sources) {
    const src = await readFile(path.join(here, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"](?:@hogee\/|[./]*packages\/)|compilePlan\(|deriveE2Fields\(/, f);
  }
});

test('the wording check finds nothing in the dataset, its README, LABELING and the decision record', async () => {
  const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
  for (const [name, text] of Object.entries(built)) assert.deepEqual(checkText(text), [], name);
  assert.deepEqual(checkText(await read('evals/datasets/e2/README.md')), [], 'README.md');
  assert.deepEqual(checkText(await read('evals/docs/evals-e2.md')), [], 'evals/docs/evals-e2.md');
  // LABELING's approved D8 line (P1, 17 Oct) says "trade name", also hyphenated before "fee"; only that phrase is
  // exempt. The hyphenated form is derived, so this file stays clean for gen-e1.test.mjs's scan of evals/scripts.
  const d8Phrase = 'trade name';
  assert.deepEqual(checkText(await read('evals/datasets/e2/LABELING.md'), [d8Phrase, d8Phrase.replace(' ', '-')]), [], 'LABELING.md');
});
