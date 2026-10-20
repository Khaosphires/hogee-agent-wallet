import { core } from './core.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const names = ['facility', 'session', 'chat', 'plan-draft', 'plan-current', 'shortlist',
  'suppliers', 'balances', 'payments', 'traces', 'exceptions', 'autonomy', 'escrow'];
export async function load(folder = fileURLToPath(new URL('.', import.meta.url))) {
  const data = Object.fromEntries(await Promise.all(names.map(async name =>
    [name, JSON.parse(await readFile(path.join(folder, `${name}.json`), 'utf8'))])));
  const meta = await readFile(path.join(folder, 'metadata.mjs'), 'utf8');
  data.metadata = JSON.parse(meta.slice(meta.indexOf('export default ') + 15).trim().replace(/;$/, ''));
  return data;
}
const money = value => { assert.match(value, /^\d+$/, 'money must be a digit string'); return BigInt(value); };
const sum = values => values.reduce((a, b) => a + money(b), 0n);
const uuid = value => assert.match(value, /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const hash = value => assert.match(value, /^0x[a-f0-9]{64}$/);
const unique = values => assert.equal(new Set(values).size, values.length, 'duplicate identity');
const paymentStates = ['PROPOSED', 'POLICY_DENIED', 'POLICY_OK', 'SIGNED', 'BROADCAST', 'INCLUDED', 'FINALIZED',
  'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED', 'REVERTED', 'DROPPED', 'CANCELLED'];
const exceptionStates = ['OPEN', 'FOUNDER_SIGNED', 'APPROVED', 'QUEUED', 'EXECUTABLE', 'EXECUTED', 'DENIED', 'CANCELLED', 'EXPIRED'];
const successStates = new Set(['INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED']);

export function validate(data) {
  const f = data.facility, meta = data.metadata, s = data.session, current = data['plan-current'];
  const m = current.manifest, b = data.balances, draft = data['plan-draft'];
  assert.equal(s.mode, 'mock'); assert.equal(s.persona, 'founder:rina'); assert.equal(meta.sourceType, 'mock');
  assert.equal(s.deploymentId, core.RINA_IDS.deploymentId);
  assert.equal(f.facilityId, core.RINA_IDS.facilityId); assert.equal(f.founderId, core.RINA_IDS.founderId);
  assert.equal(meta.sessionId, core.RINA_SESSION_ID); assert.equal(meta.orderId, core.RINA_IDS.supplierAOrderId);
  assert.equal(meta.createdAt, core.RINA_COMMIT_AT_ISO);
  assert.equal(m.agent.expiresAt, core.RINA_PLAN.agentExpiresAt);
  assert.deepEqual(m.stages, core.RINA_STAGES);
  const report = core.checkConstitution(m, core.RINA_CONSTITUTION_FACILITY, core.RINA_COMMIT_AT);
  assert(core.constitutionOk(report), 'real constitution rejected plan');
  assert.deepEqual(draft.constitutionReport, report);
  assert.equal(current.planHash, core.hashObject(m)); assert.match(meta.warning, /MOCK/);
  assert.equal(s.facilityId, f.facilityId); assert.equal(m.facilityId, f.facilityId);
  assert.equal(f.chainId, s.chainId); assert.match(f.lenderAddress, /^0x[a-f0-9]{40}$/);
  assert.equal(m.schemaVersion, '1.0.0'); hash(m.planId); assert.equal(draft.intent.intentVersion, 1);
  assert.equal(m.stages[0].gate, null);
  assert.equal(s.founderId, f.founderId); uuid(meta.sessionId);
  assert.equal(f.currency, 'MYR'); assert.equal(m.countryCode, 'MY');
  assert.equal(m.totalMinor, '1000000'); assert.equal(f.capMinor, m.totalMinor);
  assert.equal(f.reserveFloorBps, 300); assert.equal(m.reserveBps, 500);
  assert(m.reserveBps >= f.reserveFloorBps);
  assert.deepEqual(draft.manifest, m); assert.deepEqual(draft.baseline, m); assert.deepEqual(draft.diff, []);
  assert.equal(draft.intent.budgetCeilingMinor, m.totalMinor);
  assert.equal(sum(m.lines.map(x => x.amountMinor)), money(m.totalMinor));
  const expected = { SUPPLIER: '500000', PACKAGING: '150000', LOGISTICS: '80000', ADS: '120000', PLATFORM_FEES: '50000', CONTINGENCY: '100000' };
  assert.deepEqual(Object.fromEntries(m.lines.map(x => [x.lineKey, x.amountMinor])), expected);
  const created = BigInt(Date.parse(meta.createdAt) / 1000), snapshot = BigInt(Date.parse(meta.snapshotAt) / 1000);
  assert.equal(money(m.agent.expiresAt) - created, 60n * 86400n);
  assert(money(m.agent.expiresAt) > snapshot);
  assert.match(m.agent.address, /^0x[a-f0-9]{40}$/);
  const registry = new Map(meta.registry.map(x => [x.payeeId, x]));
  assert.deepEqual(meta.registry, core.RINA_PLATFORM_REGISTRY);
  assert.deepEqual(meta.approvedBindings.map(b => [b.payeeId, b.lineKeys, b.authority]), [
    [core.RINA_IDS.supplierAPayeeId, ['SUPPLIER'], 'SupplierApproval'],
    [core.RINA_IDS.packagingPayeeId, ['PACKAGING'], 'ADD_PAYEE'],
  ]);
  unique(meta.registry.map(x => x.payeeId));
  for (const line of m.lines) {
    const canonical = core.RINA_LINES.find(l => l.lineKey === line.lineKey);
    assert.deepEqual(line.payeeIds, canonical.payeeIds);
    assert.equal(line.pacing?.amountMinor, canonical.pacingPerDayMinor);
    assert.equal(line.lineId, '0x' + Buffer.from(line.lineKey).toString('hex').padEnd(64, '0'));
    assert.equal(money(line.perTxCapMinor) * 4n, money(line.amountMinor));
    assert.equal(money(line.windowCapMinor) * 2n, money(line.amountMinor));
    assert.equal(line.windowSeconds, '604800'); assert.equal(line.validUntil, m.agent.expiresAt);
    for (const payee of line.payeeIds) assert(registry.get(payee)?.lineKeys.includes(line.lineKey), 'unbound payee');
    assert.equal(line.escrowOnly, line.lineKey === 'SUPPLIER');
  }
  assert.deepEqual(m.stages.map(x => x.releaseMinor), ['400000', '600000']);
  assert.equal(sum(m.stages.map(x => x.releaseMinor)), money(m.totalMinor));
  assert.equal(m.stages[1].gate.target, '200000');
  assert.equal(money(m.stages[1].gate.deadline) - created, 30n * 86400n);
  assert.equal(b.releasedMinor, '400000'); assert.equal(b.revenueMinor, '0'); assert.equal(b.reserveMinor, '0');
  assert.equal(b.fundedMinor, f.capMinor);
  assert.equal(sum(b.pockets.map(x => x.available)) + sum(b.pockets.map(x => x.spent)) + money(b.escrowMinor) + money(b.reserveMinor),
    money(b.fundedMinor) + money(b.revenueMinor), 'ledger does not reconcile');
  assert(sum(b.pockets.map(x => x.spent)) + money(b.escrowMinor) <= money(b.releasedMinor));
  assert.deepEqual(b.agent, { ...m.agent, revoked: false });
  assert.equal(b.paused, false); assert.equal(b.drift, 0);
  const escrow = data.escrow[core.RINA_IDS.supplierAOrderId];
  assert.deepEqual(escrow.map(x => x.amountMinor), ['30000', '120000', '280000']);
  assert.deepEqual(escrow.map(x => [x.funded, x.released, x.autoRelease]), [['30000', true, true], ['120000', false, true], ['0', false, false]]);
  assert.equal(sum(escrow.map(x => x.amountMinor)), 430000n);
  assert.equal(sum(escrow.filter(x => money(x.funded) > 0n && !x.released).map(x => x.amountMinor)), money(b.escrowMinor));
  const payments = data.payments, traces = new Map(data.traces.map(t => [t.traceId, t]));
  unique(payments.map(x => x.paymentId)); unique(payments.map(x => x.invoiceHash));
  unique(payments.map(x => x.intentId)); unique(payments.map(x => x.decisionId)); unique(data.traces.map(x => x.traceId));
  assert.deepEqual([...new Set(payments.map(x => x.state))].sort(), [...paymentStates].sort());
  for (const p of payments) {
    const line = m.lines.find(x => x.lineKey === p.lineKey);
    assert(line); assert(line.payeeIds.includes(p.payeeId) || meta.approvedBindings.some(b => b.payeeId === p.payeeId && b.lineKeys.includes(p.lineKey)), 'unbound payee');
    if (p.lineKey === 'ADS') assert(money(p.amountMinor) <= money(core.RINA_LINES.find(l => l.lineKey === 'ADS').pacingPerDayMinor)); assert.equal(p.planVersion, m.version);
    money(p.amountMinor); hash(p.invoiceHash); hash(p.intentId); hash(p.rationaleHash); uuid(p.decisionId);
    const t = traces.get(p.traceId); assert(t, 'payment trace missing');
    assert.equal(t.refs.paymentId, p.paymentId); assert.equal(t.refs.decisionId, p.decisionId);
    assert.equal(t.refs.invoiceHash, p.invoiceHash); assert.equal(t.refs.txHash, p.txHash);
    assert.match(p.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    if (successStates.has(p.state) || ['BROADCAST', 'DROPPED', 'REVERTED'].includes(p.state)) hash(p.txHash);
    if (successStates.has(p.state) || p.state === 'REVERTED') assert(Number.isInteger(p.block));
    if (successStates.has(p.state) && p.kind === 'SPEND') assert(money(p.amountMinor) <= money(line.perTxCapMinor));
    if (p.lineKey === 'SUPPLIER') assert.notEqual(p.kind, 'SPEND');
    const payoutState = { SETTLED: 'SUCCEEDED', SETTLEMENT_REQUESTED: 'REQUESTED', SETTLEMENT_FAILED: 'FAILED' }[p.state] ?? 'NONE';
    assert.equal(p.payout.status, payoutState);
    if (payoutState !== 'NONE') { assert(p.payout.payoutId); assert(p.payout.attempt >= 1); }
    else assert.equal(p.payout.attempt, 0);
    if (p.state === 'REVERTED') assert.equal(p.revertReason, 'CapExceeded');
  }
  for (const pocket of b.pockets) {
    const line = m.lines.find(x => x.lineKey === pocket.lineKey);
    const rows = payments.filter(p => p.lineKey === line.lineKey && successStates.has(p.state));
    const spent = sum(rows.filter(x => x.kind !== 'FUND_MILESTONE').map(x => x.amountMinor));
    const held = sum(rows.filter(x => x.kind === 'FUND_MILESTONE').map(x => x.amountMinor));
    assert.equal(money(pocket.spent), spent, 'payment and pocket spent mismatch');
    assert.equal(money(pocket.available) + spent + held, money(line.amountMinor));
    assert.equal(pocket.allocated, line.amountMinor); assert.equal(pocket.perTxCap, line.perTxCapMinor);
    assert.equal(pocket.windowCap, line.windowCapMinor);
    const windowRows = rows.filter(x => x.kind === 'SPEND');
    assert.equal(money(pocket.windowSpent), sum(windowRows.map(x => x.amountMinor)));
    assert(money(pocket.windowSpent) <= money(line.windowCapMinor));
    if (line.pacing) {
      const days = new Map();
      for (const p of windowRows) {
        const day = p.updatedAt.slice(0, 10);
        days.set(day, (days.get(day) ?? 0n) + money(p.amountMinor));
      }
      for (const total of days.values()) assert(total <= money(line.pacing.amountMinor), 'daily pacing exceeded');
    }
  }
  unique(data.exceptions.map(x => x.exceptionId));
  assert.deepEqual([...new Set(data.exceptions.map(x => x.status))].sort(), [...exceptionStates].sort());
  for (const e of data.exceptions) {
    assert.equal(e.requestedBy, 'founder');
    if (!e.txs.queue) assert.equal(e.timelock, null);
    assert.equal(traces.get(e.traceId)?.refs.exceptionId, e.exceptionId);
    money(e.blastRadiusMinor);
    if (e.status === 'QUEUED') assert(money(e.timelock.executableAt) > snapshot);
    if (e.status === 'EXECUTABLE') assert(money(e.timelock.executableAt) <= snapshot);
    if (e.txs.queue) hash(e.txs.queue);
    if (e.status === 'EXECUTED') hash(e.txs.execute);
  }
  for (const t of data.traces) { hash(t.hash); hash(t.prevHash); assert.equal(t.seq, 1); }
  unique(data.traces.map(x => x.hash));
  assert.equal(data.suppliers.length, 5); unique(data.suppliers.map(x => x.supplierId));
  const suppliers = new Map(data.suppliers.map(x => [x.supplierId, x]));
  const evidenceIds = new Set(data.suppliers.flatMap(x => x.evidence.map(e => e.evidenceId)));
  for (const supplier of data.suppliers) {
    assert.equal(supplier.listing.sourceType, 'mock'); assert.equal(supplier.xenditTest.channel, 'MOCK_ONLY');
    assert.equal(supplier.xenditTest.accountNumber, '0000'); assert.equal(supplier.evidence.length, 7);
    money(supplier.offer.fobUnit.value); money(supplier.offer.freightPerUnit);
    assert(supplier.metrics.responseRate >= 0 && supplier.metrics.responseRate <= 1);
    for (const e of supplier.evidence) { assert.equal(e.sourceType, 'mock'); assert.equal(e.tier, 'tier3'); hash(e.snippetHash); }
  }
  for (const c of data.shortlist.candidates) {
    assert(suppliers.has(c.supplierId)); assert.equal(c.evidenceCoverageBps, 0);
    assert.equal(c.displayName, suppliers.get(c.supplierId).displayName); hash(c.payoutAccountHash);
    assert.equal(c.criteria.reduce((n, x) => n + x.weight, 0), 100);
    assert.equal(c.criteria.reduce((n, x) => n + x.weight * x.score / 100, 0), c.score);
    for (const criterion of c.criteria) for (const id of criterion.evidenceIds) assert(evidenceIds.has(id));
    const cost = c.landedCost;
    assert.equal(sum([cost.cifMinor, cost.dutyMinor, cost.sstMinor, cost.feesMinor]), money(cost.totalMinor));
  }
  assert(data.shortlist.excluded.some(x => x.supplierId === 'supplier-c' && x.gate === 'AI_INJECTION'));
  assert(data.shortlist.excluded.some(x => x.supplierId === 'supplier-e' && x.gate === 'OVER_MOQ'));
  assert(!data.shortlist.candidates.some(x => ['supplier-c', 'supplier-e'].includes(x.supplierId)));
  assert.equal(data.autonomy.agentTxs, 0); assert.equal(data.autonomy.hours, 0);
  assert(data.chat.some(x => x.parts.some(p => p.type === 'data-plan-draft' && p.data.draftId === draft.draftId)));
  hash(current.planHash); hash(current.txHash); hash(m.countryPackHash);
  return '13 mock JSON files pass domain consistency checks (run the shared-schema validator separately).';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(validate(await load(process.argv[2]))); }
  catch (error) { console.error(`Rina fixture validation failed: ${error.message}`); process.exitCode = 1; }
}
