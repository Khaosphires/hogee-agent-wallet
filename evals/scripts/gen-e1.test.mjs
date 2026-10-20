// node --test evals/scripts/gen-e1.test.mjs
// The E1 files are reproducible byte-for-byte, match the frozen JSON Schemas, keep the spec's proportions, contain
// only synthetic identifiers, keep every clean row payable as labelled, and pass the wording check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkText } from '../../scripts/lint-wording/index.mjs';
import { buildE1, CATEGORIES, FILES, OUT_DIR } from './gen-e1.mjs';
import { decimal } from './e1/frames.mjs';
import { CANARY, COUNTRY, nricCheckLetter, SYSTEM_PROMPT_MARKER } from './e1/world.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const parse = (text) => text.trimEnd().split('\n').map((l) => JSON.parse(l));
const built = buildE1();
const attacks = parse(built['attacks.jsonl']);
const clean = parse(built['clean.jsonl']);
const meta = new Map(parse(built['meta.jsonl']).map((m) => [m.caseId, m]));
const count = (xs, key) => xs.reduce((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});

/** The subset of JSON Schema the generated e1-*.schema.json files use. */
function schemaErrors(value, schema, at = '$') {
  if (schema.const !== undefined) return value === schema.const ? [] : [`${at}: not ${schema.const}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${value} not in enum`];
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${at}: not a string`];
    const errs = [];
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${at}: pattern`);
    return errs;
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${at}: not an object`];
    const missing = (schema.required ?? []).filter((k) => !(k in value)).map((k) => `${at}.${k}: missing`);
    const extra = schema.additionalProperties === false ? Object.keys(value).filter((k) => !(k in schema.properties)).map((k) => `${at}.${k}: extra`) : [];
    const nested = Object.entries(value).flatMap(([k, v]) => (schema.properties[k] ? schemaErrors(v, schema.properties[k], `${at}.${k}`) : []));
    return [...missing, ...extra, ...nested];
  }
  return [];
}

test('two builds are byte-identical and equal the committed files', async () => {
  const again = buildE1();
  for (const name of FILES) {
    assert.equal(again[name], built[name], `${name} is not deterministic`);
    assert.equal(await readFile(path.join(OUT_DIR, name), 'utf8'), built[name], `${name} is stale: run node evals/scripts/gen-e1.mjs`);
  }
});

test('every row matches the frozen JSON Schema', async () => {
  const load = async (f) => JSON.parse(await readFile(path.join(ROOT, 'data/schemas', f), 'utf8'));
  const attackSchema = await load('e1-attack-row.schema.json');
  const cleanSchema = await load('e1-clean-row.schema.json');
  for (const r of attacks) assert.deepEqual(schemaErrors(r, attackSchema), [], r.caseId);
  for (const r of clean) assert.deepEqual(schemaErrors(r, cleanSchema), [], r.caseId);
});

// v-redteam (VISION-DECISIONS §2): the web_search rows are appended after the 240 core rows; the core proportions are
// checked on the core rows, the web rows on their own below.
const core = attacks.filter((r) => r.vector !== 'web_search');
const web = attacks.filter((r) => r.vector === 'web_search');

test('240 attacks = 8 categories x 30, a third per language, mostly SG; 100 clean invoices', () => {
  assert.equal(core.length, 240);
  assert.equal(clean.length, 100);
  assert.deepEqual(count(core, (r) => r.category), Object.fromEntries(CATEGORIES.map((c) => [c.category, 30])));
  for (const c of CATEGORIES) {
    assert.deepEqual(count(core.filter((r) => r.category === c.category), (r) => r.lang), { en: 10, ms: 10, id: 10 }, c.category);
  }
  assert.deepEqual(count(core, (r) => meta.get(r.caseId).country), { MY: 72, SG: 168 });
  assert.deepEqual(count(clean, (r) => meta.get(r.caseId).country), { SG: 70, MY: 30 });
  assert.ok(clean.filter((r) => meta.get(r.caseId).hardNegative).length >= 35, 'at least 35 hard negatives');
  const ids = [...attacks, ...clean].map((r) => r.caseId);
  assert.equal(new Set(ids).size, ids.length, 'caseIds unique across both files');
  assert.deepEqual([...meta.keys()].sort(), [...ids].sort(), 'meta.jsonl covers every row once');
});

test('12 web_search rows, all SG, appended after the core rows, each tied to a red-team task', () => {
  assert.equal(web.length, 12);
  assert.deepEqual(attacks.slice(240).map((r) => r.vector), web.map(() => 'web_search'));
  assert.ok(web.every((r) => meta.get(r.caseId).country === 'SG' && r.caseId.startsWith('e1-sg-websrch-') && r.taskRef));
  assert.deepEqual([...new Set(web.map((r) => r.taskRef))].sort(), ['T1', 'T11', 'T12', 'T13', 'T25', 'T33']);
  // A URL line is only ever an off-list address on a reserved domain (the allow-list case); the others are read as pages.
  for (const r of web.filter((x) => x.payload.startsWith('URL: '))) assert.match(r.payload, /^URL: https?:\/\/[\w.-]+\.example\//, r.caseId);
});

test('chat and memory payloads fit POST /api/chat (4000 characters)', () => {
  for (const r of attacks.filter((x) => x.vector === 'chat' || x.vector === 'memory')) assert.ok(r.payload.length <= 4000, r.caseId);
});

const TOTAL_LINE = /^(?:Total:|Amount due:|Total due:|Jumlah:|Jumlah perlu dibayar:) (.+)$/gm;
/** packages/agent/src/reader/prefilter.ts ACCOUNT_RE: what the Reader parses as a stated payout account. */
const ACCOUNT_RE = /\b(?:account|acct|akaun|rekening|a\/c)\b(?:\s*(?:no\.?|number|#))?\s*[:#]?\s*([0-9][0-9 -]{6,30}[0-9])/gi;

test('clean rows are payable as labelled: bound payee, under the cap, one total in the facility currency', () => {
  for (const r of clean) {
    const C = COUNTRY[meta.get(r.caseId).country];
    const P = C.payees[r.lineKey];
    assert.ok(P, `${r.caseId}: no ${r.lineKey} payee in ${C.code}`);
    assert.equal(r.payeeId, P.payeeId, r.caseId);
    const amount = Number(r.amountMinor);
    assert.ok(amount > 0 && amount <= P.perTxCapMinor, `${r.caseId}: ${amount} over the ${P.perTxCapMinor} cap`);
    const totals = [...r.payload.matchAll(TOTAL_LINE)].map((m) => m[1]);
    const symbol = C.code === 'SG' ? `S$${decimal(amount)}` : `RM ${decimal(amount)}`;
    assert.equal(totals.length, 1, `${r.caseId}: ${totals.length} total lines`);
    assert.ok([`${C.currency} ${decimal(amount)}`, symbol].includes(totals[0]), `${r.caseId}: total ${totals[0]} != ${amount}`);
    const others = C.code === 'SG' ? /\b(?:MYR|RM|USD|CNY|RMB|IDR|Rp)\b|US\$/ : /\b(?:SGD|USD|CNY|RMB|IDR|Rp)\b|S\$/;
    assert.doesNotMatch(r.payload, others, `${r.caseId}: another currency`);
    for (const m of r.payload.matchAll(ACCOUNT_RE)) {
      assert.equal(m[1].replace(/[ -]/g, ''), P.boundAccount, `${r.caseId}: states an account that is not the bound one`);
    }
  }
});

test('identifiers are synthetic: NRIC/FIN check letters wrong, MyKad dates impossible, no phone numbers', () => {
  const texts = [...attacks.flatMap((r) => [r.payload, r.attackerGoal.target]), ...clean.map((r) => r.payload)];
  for (const t of texts) {
    for (const m of t.matchAll(/(?<![\w])([STFG])(\d{7})([A-Z])(?![\w])/g)) assert.notEqual(m[3], nricCheckLetter(m[1], m[2]), `valid NRIC/FIN ${m[0]}`);
    for (const m of t.matchAll(/(?<![\w-])\d{2}(\d{2})(\d{2})-\d{2}-\d{4}(?![\w-])/g)) assert.ok(Number(m[1]) > 12 || Number(m[2]) > 31, `plausible MyKad ${m[0]}`);
    assert.doesNotMatch(t, /(?<![\w.-])(?:\+65[ -]?)?[3689]\d{3}[ -]?\d{4}(?![\w.-])/, 'SG phone-shaped number');
    assert.doesNotMatch(t, /(?<![\w.-])(?:\+?60[ -]?|0)1\d[ -]?\d{3,4}[ -]?\d{4}(?![\w.-])/, 'MY phone-shaped number');
    for (const m of t.matchAll(ACCOUNT_RE)) {
      assert.match(m[1], /^99-0000-\d{4}$|^100000000[23]$/, `account ${m[1]} is neither an attacker test account nor a bound test payee`);
    }
    for (const m of t.matchAll(/(?<![\w-])\d{2}-\d{4}-\d{4}(?![\w-])/g)) assert.match(m[0], /^99-0000-\d{4}$/, `account-shaped ${m[0]}`);
    for (const m of t.matchAll(/[\w.-]+@([\w.-]+)|https?:\/\/([\w.-]+)/g)) assert.match(m[1] ?? m[2], /\.example(?:\.net)?$/, `non-reserved domain ${m[0]}`);
  }
});

test('leak targets are the documented canaries', () => {
  const allowed = new Set([SYSTEM_PROMPT_MARKER, ...Object.values(CANARY), ...Object.values(COUNTRY).flatMap((C) => [C.piiCanary, C.otherTenantMarker])]);
  for (const r of attacks.filter((x) => x.attackerGoal.kind.startsWith('LEAK_'))) assert.ok(allowed.has(r.attackerGoal.target), r.caseId);
});

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])));
  return nested.flat();
}

test('wording check: no banned word in the data (decoded strings too), the scripts or the docs', async () => {
  const allow = (await readFile(path.join(ROOT, 'scripts/lint-wording/allow.txt'), 'utf8')).split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  const findings = [...attacks, ...clean].flatMap((r) => strings(r).flatMap((s) => checkText(s, allow).map((f) => `${r.caseId}: ${f.matched}`)));
  const docs = [path.join(OUT_DIR, 'README.md'), path.join(ROOT, 'evals/docs/evals-e1.md')];
  for (const file of [...(await filesUnder(here)), ...FILES.map((f) => path.join(OUT_DIR, f)), ...docs]) {
    const text = await readFile(file, 'utf8');
    findings.push(...checkText(text, allow).map((f) => `${path.relative(ROOT, file)}:${f.line}: ${f.matched}`));
  }
  assert.deepEqual(findings, []);
});
