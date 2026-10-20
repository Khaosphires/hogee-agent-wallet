// Mock UI data only. No network calls, real accounts, signatures or chain evidence.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { core } from './core.mjs';
const { RINA_IDS, RINA_SESSION_ID, RINA_COMMIT_AT_ISO, RINA_COMMIT_AT,
  RINA_PLAN, RINA_LINES, RINA_STAGES, RINA_PLATFORM_REGISTRY,
  RINA_CONSTITUTION_FACILITY, checkConstitution, constitutionOk, hashObject } = core;
const folder = fileURLToPath(new URL('.', import.meta.url));
// Public deterministic fixture seed, never a signing key. Placeholders are explicitly mock.
const hex = key => '0x' + createHash('sha256').update(`hogee-p3-rina:20261016:${key}`).digest('hex');
let counter = 0;
const uuid7 = () => {
  const h = hex(`decision:${counter++}`).slice(2);
  return `01a14202-2800-7${h.slice(0,3)}-8${h.slice(3,6)}-${h.slice(6,18)}`;
};
// Five gallery days after the canonical commit; no pre-commit payments.
const at = '2026-10-20T12:00:00Z';
// Plain made-up supplier names (UX round 3), the demo catalog's for the same ids (data/suppliers/demo), so a seeded
// order never reads "Mock Supplier A". The pages carry the "Sample" label; the names carry none.
const SUPPLIER_NAME = { A: 'Brightwave Drinkware Co., Ltd.', B: 'Harbourline Cups Co., Ltd.', C: 'Clearpeak Tumbler Factory Co., Ltd.',
  D: 'Redmaple Homeware Co., Ltd.', E: 'Grandriver Housewares Manufacturing Co., Ltd.' };
const start = RINA_COMMIT_AT_ISO;
const seconds = value => String(Date.parse(value) / 1000);
const expiry = RINA_PLAN.agentExpiresAt;
const facilityId = RINA_IDS.facilityId;
const sessionId = RINA_SESSION_ID;
const agent = { address: hex('agent-address').slice(0,42), expiresAt: expiry };
const keys = RINA_LINES.map(l => l.lineKey);
const lines = RINA_LINES.map(({pacingPerDayMinor, ...line}) => ({
  ...structuredClone(line), lineId: core.stringToBytes32(line.lineKey),
  windowSeconds: RINA_PLAN.windowSeconds, validUntil: RINA_PLAN.validUntil,
  ...(pacingPerDayMinor ? {pacing: {period: 'day', amountMinor: pacingPerDayMinor}} : {}),
}));
const manifest = {
  schemaVersion: '1.0.0', planId: hex('plan-id'), version: 1,
  prevPlanHash: '0x' + '0'.repeat(64), facilityId, countryCode: 'MY',
  countryPackVersion: 'mock-unverified-1', countryPackHash: hex('country-pack'),
  displayCurrency: 'MYR', totalMinor: '1000000', reserveBps: RINA_PLAN.reserveBps, agent,
  stages: structuredClone(RINA_STAGES),
  lines,
  rules: [
    { ruleId: 'mock-reserve', text: 'Demo assumption: 5% of recorded sales is reserved; this is not a verified tax rate.', sourceRef: 'compiler:mock-reserve-assumption' },
    { ruleId: 'mock-supplier', text: 'Supplier funds use the founder-approved milestone schedule.', sourceRef: 'constitution:SUPPLIER_LINE_NOT_ESCROW' },
  ],
  aigc: { model: 'mock-scripted-no-model-call', promptHash: hex('prompt') },
  compilerVersion: 'mock-fixture-v1',
};
const intent = {
  intentVersion: 1, countryCode: 'MY', residency: 'citizen', entityType: 'sole_prop',
  productCategory: 'drinkware_food_contact', sellChannel: 'shopee', buyFrom: 'CN',
  budgetCeilingMinor: '1000000', horizonDays: 60,
  lineEmphasis: Object.fromEntries([...keys, 'LICENSING'].map(k => [k, k === 'SUPPLIER' ? 'high' : 'med'])),
  adsPacing: 'conservative', answeredSlots: ['residency', 'productCategory', 'budgetCeilingMinor', 'buyFrom', 'sellChannel'],
  assumptions: [{ slot: 'entityType', text: 'Sole proprietorship is a mock planning assumption.' }, { slot: 'horizonDays', text: 'Use a 60-day mock horizon.' }, { slot: 'adsPacing', text: 'Use conservative daily ad pacing.' }],
};
const metadata = {
  facilityId, founderId: RINA_IDS.founderId, founderName: 'Rina (fictional)', countryCode: 'MY',
  capMinor: '1000000', currency: 'MYR', reserveFloorBps: 300,
  createdAt: start, snapshotAt: at, sourceType: 'mock', deploymentId: RINA_IDS.deploymentId,
  warning: 'MOCK UI DATA: no real funds, receipts, verified rules or measured results.',
  reserveAssumption: '300 bps floor and 500 bps plan reserve are demo choices, not verified tax rates.',
  sessionId, orderId: RINA_IDS.supplierAOrderId,
  registry: structuredClone(RINA_PLATFORM_REGISTRY),
  // These bindings happen after plan commit; they are NOT plan-v1 payees.
  approvedBindings: [
    { payeeId: RINA_IDS.supplierAPayeeId, lineKeys: ['SUPPLIER'], authority: 'SupplierApproval', cooledAt: seconds(start) },
    { payeeId: RINA_IDS.packagingPayeeId, lineKeys: ['PACKAGING'], authority: 'ADD_PAYEE', cooledAt: seconds(start) },
  ],
};
const facility = { facilityId, founderId: RINA_IDS.founderId, capMinor: '1000000', currency: 'MYR', reserveFloorBps: 300, lenderAddress: hex('lender-address').slice(0,42), chainId: 11155111, deploymentId: RINA_IDS.deploymentId };
const session = { persona: 'founder:rina', founderId: RINA_IDS.founderId, facilityId,
  mode: 'mock', chainId: 11155111, deploymentId: RINA_IDS.deploymentId };
const chat = [
  { id: 'chat-1', role: 'user', parts: [{ type: 'text', text: 'I want to sell custom insulated tumblers on Shopee in Selangor with a budget of RM10,000.' }] },
  { id: 'chat-2', role: 'assistant', parts: [{ type: 'text', text: 'Are you a Malaysian citizen, permanent resident or foreign resident?' },
    { type: 'data-question', data: { questionId: 'q-residency', slot: 'residency', text: 'What is your residency?', options: ['citizen', 'pr', 'foreigner'].map(value => ({ value, label: value })) } }] },
  { id: 'chat-3', role: 'user', parts: [{ type: 'text', text: 'I am a Malaysian citizen.' }] },
  { id: 'chat-4', role: 'assistant', parts: [{ type: 'text', text: 'Will you buy from China, and is RM10,000 your total budget ceiling?' }] },
  { id: 'chat-5', role: 'user', parts: [{ type: 'text', text: 'Yes, buy from China. Keep the total within RM10,000 and start with samples.' }] },
  { id: 'chat-6', role: 'assistant', parts: [{ type: 'text', text: 'Here is a mock launch plan. Supplier prices and reserve percentages are illustrative; local requirements still need verification.' },
    { type: 'data-intent', data: { intent } }, { type: 'data-plan-draft', data: { draftId: 'draft-rina-mock' } }] },
  { id: 'chat-7', role: 'assistant', parts: [{ type: 'data-shortlist', data: { requestId: 'shortlist-rina-mock' } },
    { type: 'data-redflag', data: { text: `${SUPPLIER_NAME.C}'s page contains instructions aimed at the AI and asks for a personal payment.`, source: 'supplier-c' } }] },
];
const source = (value, key) => ({ value, sourceUrl: `https://example.invalid/rina/${key}`,
  retrievedAt: at, snippetHash: hex(`source-${key}`), evidence: 'tier3', sourceType: 'mock' });
const criterionNames = ['landed_cost', 'quality_evidence', 'trust_verification', 'lead_time', 'compliance', 'terms', 'communication'];
const weights = [25, 20, 20, 10, 10, 10, 5];
const suppliers = ['A', 'B', 'C', 'D', 'E'].map((letter, i) => ({
  supplierId: `supplier-${letter.toLowerCase()}`, displayName: SUPPLIER_NAME[letter], country: 'CN', ids: {},
  listing: { url: `https://example.invalid/suppliers/${letter}`, sourceType: 'mock',
    rawTextRef: `fixtures/scenario-rina/README.md#supplier-${letter.toLowerCase()}` },
  // G0: unit prices and freight are currency minor-unit strings.
  offer: { currency: 'MYR', fobUnit: source(['800', '750', '600', '900', '1100'][i], `supplier-${letter}-price`),
    moq: [400, 400, 400, 400, 1000][i], leadTimeDays: [25, 35, 15, 30, 45][i], freightPerUnit: '100', incoterm: 'FOB' },
  terms: { escrow: i !== 2, offPlatformDiscount: i === 2, payeeType: i === 2 ? 'personal' : 'company' },
  certificates: [], // No invented official certificates or company registration IDs.
  metrics: { rating: [4.8, 4.3, 5, 4.5, 4][i], responseRate: [0.98, 0.90, 1, 0.95, 0.80][i], yearsOnPlatform: [9, 4, 1, 6, 2][i] },
  xenditTest: { channel: 'MOCK_ONLY', accountNumber: '0000', holderName: `${SUPPLIER_NAME[letter].toUpperCase()} - SAMPLE, DO NOT PAY` },
  evidence: criterionNames.map(criterion => ({ evidenceId: `evidence-${letter}-${criterion}`,
    supplierId: `supplier-${letter.toLowerCase()}`, criterion, tier: 'tier3', sourceType: 'mock',
    sourceUrl: `https://example.invalid/suppliers/${letter}/${criterion}`, snippetHash: hex(`evidence-${letter}-${criterion}`),
    value: 'Synthetic UI example; not independently verified.', taint: { trust: 'untrusted', sensitivity: 'public' } })),
}));
const candidates = ['A', 'D', 'B'].map((letter, i) => ({
  supplierId: `supplier-${letter.toLowerCase()}`, 
  displayName: SUPPLIER_NAME[letter], payoutAccountHash: hex(`payout-account-${letter}`), // UI placeholder, not a verified commitment.
  rank: i + 1, score: [90, 80, 70][i],
  criteria: criterionNames.map((criterion, j) => ({ criterion, weight: weights[j], score: [90, 80, 70][i], evidenceIds: [`evidence-${letter}-${criterion}`] })),
  landedCost: { cifMinor: ['360000', '400000', '340000'][i], dutyMinor: '0', sstMinor: ['36000', '40000', '34000'][i],
    feesMinor: '4000', totalMinor: ['400000', '444000', '378000'][i], fx: source(1, 'MYR-MYR') },
  evidenceCoverageBps: 0,
  gates: ['NO_ESCROW', 'PERSONAL_PAYEE', 'OFF_PLATFORM_DISCOUNT', 'AI_INJECTION', 'OVER_MOQ'].map(gate => ({ gate, passed: true, evidenceIds: [`evidence-${letter}-terms`] })),
  redFlags: [{ text: 'All evidence is synthetic. Product-approval and sanctions checks are pending; ranking is a UI placeholder.', source: 'mock-fixture' }],
  pros: [{ text: i === 0 ? 'Illustrative first choice with staged payments.' : 'Alternative for comparison.', evidenceIds: [`evidence-${letter}-terms`] }],
  cons: [{ text: 'No live supplier verification has been performed.', evidenceIds: [] }],
  whyNotNext: i === 2 ? null : 'Mock ranking for screen development; no measured ranking claim.',
  whatWouldChange: 'Verified costs, certificates and checks may change or exclude this candidate.',
}));
const shortlist = { requestId: 'shortlist-rina-mock', status: 'READY', candidates,
  excluded: [{ supplierId: 'supplier-c', gate: 'AI_INJECTION' }, { supplierId: 'supplier-e', gate: 'OVER_MOQ' }],
  rankStabilityPct: 0, shortlistHash: hex('shortlist'), weightsVersion: 'mock-placeholder-not-measured' };
const states = ['PROPOSED', 'POLICY_DENIED', 'POLICY_OK', 'SIGNED', 'BROADCAST', 'INCLUDED', 'FINALIZED',
  'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED', 'REVERTED', 'DROPPED', 'CANCELLED'];
const mined = new Set(['INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED', 'REVERTED']);
const payments = states.map((state, i) => ({
  paymentId: `payment-ads-${state.toLowerCase()}`, kind: 'SPEND', intentId: hex(`intent-${state}`),
  lineKey: ['POLICY_DENIED', 'REVERTED'].includes(state) ? 'PACKAGING' : 'ADS',
  payeeId: ['POLICY_DENIED', 'REVERTED'].includes(state) ? RINA_IDS.packagingPayeeId : RINA_IDS.adsPayeeId,
  amountMinor: ['POLICY_DENIED', 'REVERTED'].includes(state) ? '40000' : RINA_LINES.find(l => l.lineKey === 'ADS').pacingPerDayMinor,
  invoiceHash: hex(`invoice-${state}`), planVersion: 1, state,
  ...(['BROADCAST', 'DROPPED'].includes(state) || mined.has(state) ? { txHash: hex(`tx-${state}`) } : {}),
  ...(mined.has(state) ? { block: 1000 + i } : {}),
  ...(state === 'REVERTED' ? { revertReason: 'CapExceeded' } : {}),
  payout: { attempt: ['SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED'].includes(state) ? 1 : 0,
    status: ({ SETTLEMENT_REQUESTED: 'REQUESTED', SETTLED: 'SUCCEEDED', SETTLEMENT_FAILED: 'FAILED' })[state] ?? 'NONE',
    ...(['SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED'].includes(state) ? { payoutId: `mock-payout-${state}` } : {}),
    ...(state === 'SETTLEMENT_FAILED' ? { failureCode: 'MOCK_TEMPORARY_TRANSFER_ERROR' } : {}) },
  decisionId: uuid7(), rationaleHash: hex(`rationale-${state}`), traceId: `trace-${state}`,
  updatedAt: ['INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED'].includes(state)
    ? `2026-10-${String(i + 11).padStart(2, '0')}T12:00:00Z` : at,
}));
payments.push(...[
  { paymentId: 'payment-sample', kind: 'RELEASE_MILESTONE', amountMinor: '30000', state: 'SETTLED', status: 'SUCCEEDED' },
  { paymentId: 'payment-deposit', kind: 'FUND_MILESTONE', amountMinor: '120000', state: 'FINALIZED', status: 'NONE' },
].map((p, i) => ({ paymentId: p.paymentId, kind: p.kind, intentId: hex(`${p.paymentId}-intent`),
  lineKey: 'SUPPLIER', payeeId: 'supplier-a', amountMinor: p.amountMinor,
  invoiceHash: hex(`${p.paymentId}-invoice`), planVersion: 1, state: p.state,
  txHash: hex(`${p.paymentId}-tx`), block: 980 + i,
  payout: { attempt: i === 0 ? 1 : 0, status: p.status, ...(i === 0 ? { payoutId: 'mock-payout-sample' } : {}) },
  decisionId: uuid7(), rationaleHash: hex(`${p.paymentId}-rationale`), traceId: `trace-${p.paymentId}`, updatedAt: at })));
const exceptionStates = ['OPEN', 'FOUNDER_SIGNED', 'APPROVED', 'QUEUED', 'EXECUTABLE', 'EXECUTED', 'DENIED', 'CANCELLED', 'EXPIRED'];
// Plain words for the status gallery's rows (UX round 3: no "MOCK status example", no raw status codes in prose).
const EXCEPTION_STATUS_WORDS = { OPEN: 'waiting for signatures', FOUNDER_SIGNED: 'signed by the founder', APPROVED: 'approved by the loan officer',
  QUEUED: 'in its waiting time', EXECUTABLE: 'ready to go ahead', EXECUTED: 'done', DENIED: 'refused', CANCELLED: 'cancelled', EXPIRED: 'expired' };
const PAYMENT_STATE_WORDS = { PROPOSED: 'proposed', POLICY_DENIED: 'refused by the rules', POLICY_OK: 'allowed by the rules', SIGNED: 'signed',
  BROADCAST: 'sent to the chain', INCLUDED: 'recorded on the chain', FINALIZED: 'final on the chain', SETTLEMENT_REQUESTED: 'bank payout requested',
  SETTLED: 'paid out', SETTLEMENT_FAILED: 'bank payout failed', REVERTED: 'refused by the chain', DROPPED: 'dropped', CANCELLED: 'cancelled' };
const PAYMENT_WORDS = { 'payment-sample': 'Supplier sample payment', 'payment-deposit': 'Supplier deposit' };
const paymentWords = p => PAYMENT_WORDS[p.paymentId] ?? (p.lineKey === 'PACKAGING' ? 'Packaging payment' : 'Ads payment');
const exceptions = exceptionStates.map((status, i) => ({
  exceptionId: `exception-${status.toLowerCase()}`, kind: 'UNPAUSE',
  title: 'Turn automatic payments back on', payload: {}, requestedBy: 'founder',
  requires: { founder: true, lender: true }, status,
  timelock: ['QUEUED', 'EXECUTABLE', 'EXECUTED', 'CANCELLED', 'EXPIRED'].includes(status)
    ? { queuedAt: String(BigInt(seconds(at)) - (status === 'QUEUED' ? 60n : 300n)),
      executableAt: String(BigInt(seconds(at)) + (status === 'QUEUED' ? 60n : -180n)) } : null,
  txs: { ...(['QUEUED', 'EXECUTABLE', 'EXECUTED', 'CANCELLED', 'EXPIRED'].includes(status) ? { queue: hex(`queue-${i}`) } : {}),
    ...(status === 'EXECUTED' ? { execute: hex('unpause-executed') } : {}) },
  blastRadiusMinor: '400000', traceId: `trace-exception-${status}`,
}));
exceptions.push({ exceptionId: 'exception-balance', kind: 'RELEASE_ESCROW_BALANCE',
  title: `Pay the balance to ${SUPPLIER_NAME.A}`,
  payload: { orderId: RINA_IDS.supplierAOrderId, idx: 2, evidenceHash: hex('inspection-placeholder') },
  requestedBy: 'founder', requires: { founder: true, lender: false }, status: 'OPEN',
  timelock: null, txs: {}, blastRadiusMinor: '280000', traceId: 'trace-exception-balance' });
const traces = payments.map(p => ({ traceId: p.traceId, seq: 1, ts: p.updatedAt,
  actor: p.state === 'POLICY_DENIED' ? 'policy' : 'worker',
  kind: p.state === 'POLICY_DENIED' ? 'DENIAL' : p.txHash ? 'TX' : 'PROPOSAL',
  summary: `Sample record: ${paymentWords(p)}, ${PAYMENT_STATE_WORDS[p.state]}; no real transaction.`,
  verdict: ['POLICY_DENIED', 'REVERTED'].includes(p.state) ? 'DENY' : 'AUTO',
  ...(['POLICY_DENIED', 'REVERTED'].includes(p.state) ? { reasonCode: 'CapExceeded' } : {}),
  refs: { planVersion: 1, paymentId: p.paymentId, invoiceHash: p.invoiceHash, decisionId: p.decisionId,
    ...(p.txHash ? { txHash: p.txHash } : {}), ...(p.payout.payoutId ? { payoutId: p.payout.payoutId } : {}) },
  prevHash: '0x' + '0'.repeat(64), hash: hex(`trace-hash-${p.paymentId}`),
}));
traces.push(...exceptions.map(e => ({ traceId: e.traceId, seq: 1, ts: at, actor: 'policy', kind: 'EXCEPTION',
  summary: `Sample request: ${e.title.charAt(0).toLowerCase()}${e.title.slice(1)} (${EXCEPTION_STATUS_WORDS[e.status]}).`, verdict: e.status === 'DENIED' ? 'DENY' : e.requires.lender ? 'NEEDS_OFFICER' : 'NEEDS_FOUNDER',
  refs: { planVersion: 1, exceptionId: e.exceptionId }, prevHash: '0x' + '0'.repeat(64), hash: hex(e.traceId) })));
const balances = {
  fundedMinor: '1000000', releasedMinor: '400000', revenueMinor: '0', reserveMinor: '0', escrowMinor: '120000',
  pockets: lines.map(line => {
    const spent = line.lineKey === 'ADS' ? 37500n : line.lineKey === 'SUPPLIER' ? 30000n : 0n;
    const held = line.lineKey === 'SUPPLIER' ? 120000n : 0n;
    return { lineKey: line.lineKey, allocated: line.amountMinor, spent: String(spent),
      available: String(BigInt(line.amountMinor) - spent - held), perTxCap: line.perTxCapMinor,
      windowCap: line.windowCapMinor, windowSpent: line.lineKey === 'ADS' ? '37500' : '0',
      validUntil: expiry, paused: false, circuitOpen: false };
  }),
  agent: { ...agent, revoked: false }, paused: false, drift: 0,
};
const escrow = [
  { idx: 0, amountMinor: '30000', funded: '30000', released: true, autoRelease: true },
  { idx: 1, amountMinor: '120000', funded: '120000', released: false, autoRelease: true },
  { idx: 2, amountMinor: '280000', funded: '0', released: false, autoRelease: false },
];
const files = {
  facility, session, chat,
  'plan-draft': { draftId: 'draft-rina-mock', intent, manifest, baseline: structuredClone(manifest), diff: [],
    blastRadiusMinor: '400000', constitutionReport: checkConstitution(manifest, RINA_CONSTITUTION_FACILITY, RINA_COMMIT_AT) },
  'plan-current': { manifest, status: 'COMMITTED', planHash: hashObject(manifest), txHash: hex('plan-tx') },
  shortlist, suppliers, balances, payments, traces, exceptions,
  // Placeholder screen values, not a measured autonomous run. Status examples are not an event history.
  autonomy: { agentTxs: 0, humanSigs: 0, autoPct: 0, escalatedPct: 0, startedAt: at, hours: 0, drift: 0 },
  escrow: { [RINA_IDS.supplierAOrderId]: escrow },
};
if (!constitutionOk(files['plan-draft'].constitutionReport)) throw new Error('Rina fails the real constitution');
for (const [name, value] of Object.entries(files)) {
  await writeFile(`${folder}${name}.json`, JSON.stringify(value, null, 2) + '\n');
}
console.log(`Generated ${Object.keys(files).length} mock JSON files. Deterministic placeholders; constitution checked by core.`);

await writeFile(`${folder}metadata.mjs`, '// Mock seed/display metadata, separate from the strict Facility schema.\nexport default ' + JSON.stringify(metadata, null, 2) + ';\n');
