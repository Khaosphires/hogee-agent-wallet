import test from 'node:test';
import assert from 'node:assert/strict';
import { load, validate } from './validate.mjs';
import { core } from './core.mjs';
const original = await load();
test('complete fixture set reconciles', () => assert.match(validate(original), /13 mock JSON/));
test('actual core checks all 14 codes and rejects a supplier inserted before approval', () => {
  const plan = structuredClone(original['plan-current'].manifest);
  const check = () => core.checkConstitution(plan, core.RINA_CONSTITUTION_FACILITY, core.RINA_COMMIT_AT);
  assert.equal(check().length, 14);
  assert(check().every(row => row.ok));
  plan.lines[0].payeeIds = [core.RINA_IDS.supplierAPayeeId];
  assert.equal(check().find(row => row.code === 'PLAN_ADDS_PAYEE').ok, false);
});
const cases = [
  ['invented constitution report', d => { d['plan-draft'].constitutionReport.pop(); }],
  ['supplier in plan v1', d => { d['plan-current'].manifest.lines[0].payeeIds = ['supplier-a']; }],
  ['wrong canonical identity', d => { d.facility.facilityId = 'other'; }],
  ['wrong canonical pacing', d => { d['plan-current'].manifest.lines[3].pacing.amountMinor = '10000'; }],
  ['wrong schema version', d => { d['plan-current'].manifest.schemaVersion = '1'; }],
  ['decimal supplier price', d => { d.suppliers[0].offer.fobUnit.value = 8; }],
  ['percentage instead of response fraction', d => { d.suppliers[0].metrics.responseRate = 98; }],
  ['empty timelock object', d => { d.exceptions[0].timelock = {}; }],
  ['budget drift', d => { d.balances.pockets[0].available = '350001'; }],
  ['unbound recipient', d => { d.payments[0].payeeId = 'unapproved'; }],
  ['float money', d => { d.payments[0].amountMinor = 100.01; }],
  ['duplicate invoice', d => { d.payments[1].invoiceHash = d.payments[0].invoiceHash; }],
  ['missing state', d => { d.payments = d.payments.filter(x => x.state !== 'DROPPED'); }],
  ['missing trace', d => { d.traces.shift(); }],
  ['payout failure incorrectly refunded', d => { d.balances.pockets[3].spent = '40000'; d.balances.pockets[3].available = '80000'; }],
  ['daily ad overspend', d => { const rows = d.payments.filter(x => ['INCLUDED', 'FINALIZED'].includes(x.state) && x.kind === 'SPEND'); rows[1].updatedAt = rows[0].updatedAt; }],
  ['premature balance release', d => { d.escrow['order-a-001'][2].released = true; }],
  ['fake verified supplier evidence', d => { d.suppliers[0].evidence[0].tier = 'tier1'; }],
];
for (const [name, mutate] of cases) test(`rejects ${name}`, () => {
  const data = structuredClone(original); mutate(data); assert.throws(() => validate(data));
});
