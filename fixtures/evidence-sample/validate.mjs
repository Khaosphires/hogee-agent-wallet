import { core } from '../scenario-rina/core.mjs';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = new URL('./', import.meta.url);
const hex32 = /^0x[0-9a-f]{64}$/;
const sha256 = text => '0x' + createHash('sha256').update(text, 'utf8').digest('hex');
export async function load() {
  const files = await readdir(here);
  const data = { files };
  for (const file of files.filter(f => f.endsWith('.json'))) {
    data[file.slice(0, -5)] = JSON.parse(await readFile(new URL(file, here), 'utf8'));
  }
  return data;
}
export function validate(d) {
  assert(core.constitutionOk(core.checkConstitution(d.plan.manifest, core.RINA_CONSTITUTION_FACILITY, core.RINA_COMMIT_AT)));
  assert.equal(d.plan.planHash, core.hashObject(d.plan.manifest));
  assert.equal(d.manifest.toolVersions.mode, 'mock');
  assert.equal(d.manifest.toolVersions.cryptographicVerification, 'not-performed');
  assert.match(d.manifest.gitCommit, /^[0-9a-f]{40}$/);
  assert.equal(d.evidence.length, 3);
  assert.deepEqual(d.evidence.map(r => r.taskId), ['S5', 'T4', 'T11']);
  assert.deepEqual(d.evidence.map(r => [r.expected, r.layer]), [
    ['success', 'onchain_success'], ['revert', 'onchain_revert'], ['refused', 'agent_refusal'],
  ]);
  for (const name of ['receipts', 'signatures', 'rationales', 'llm-calls', 'country-pack', 'contracts']) {
    assert.equal(d[name].sourceType, 'mock');
    assert.match(d[name].warning, /^MOCK UI SAMPLE ONLY:/);
  }
  assert.equal(d.traces.length, 3);
  assert.equal(new Set(d.traces.map(t => t.traceId)).size, 3);
  assert.equal(d.receipts.receipts.length, 2);
  assert.equal(new Set(d.receipts.receipts.map(r => r.taskId)).size, 2);
  for (const row of d.evidence) {
    assert.match(row.title, /^MOCK:/);
    assert.equal(row.outcome, 'pass');
    assert.ok(!row.explorerUrl, 'Mock hashes must not link to a real explorer');
    const deployment = d.manifest.deployments[row.deploymentId];
    assert.ok(deployment);
    assert.equal(row.chainId, deployment.chainId);
    assert.ok(row.artifacts.length);
    for (const file of row.artifacts) {
      assert.match(file, /^[a-z][a-z0-9-]*\.json$/, 'Only local bundle filenames');
      assert.ok(d.files.includes(file), `Missing artifact ${file}`);
    }
    const trace = d.traces.find(t => t.traceId === row.traceId);
    assert.ok(trace, `Missing trace ${row.traceId}`);
    if (row.decisionId) assert.equal(trace.refs.decisionId, row.decisionId);
    const receiptEntry = d.receipts.receipts.find(r => r.taskId === row.taskId);
    if (row.layer === 'agent_refusal') {
      assert.equal(row.txHash, undefined);
      assert.equal(row.block, undefined);
      assert.equal(receiptEntry, undefined);
      assert.equal(row.contract, '');
      assert.equal(trace.verdict, 'DENY');
      assert.equal(trace.refs.txHash, undefined);
      assert.equal(trace.refs.llmCallId, d['llm-calls'].calls[0].llmCallId);
    } else {
      assert.match(row.txHash, hex32);
      assert.equal(trace.refs.txHash, row.txHash);
      assert.ok(receiptEntry, 'Chain display row needs a receipt');
      const receipt = receiptEntry.receipt;
      assert.equal(receipt.transactionHash, row.txHash);
      assert.equal(Number(BigInt(receipt.blockNumber)), row.block);
      assert.equal(receipt.to, row.contract);
      assert.equal(receipt.status, row.expected === 'success' ? '0x1' : '0x0');
      assert.deepEqual(receipt.logs, []);
      assert.ok(Object.values(deployment.contracts).some(c => c.address === row.contract));
      if (row.expected === 'revert') {
        assert.equal(row.revertReason, 'CapExceeded');
        assert.equal(row.expectedError, row.revertReason);
        assert.equal(receiptEntry.revertReason, row.revertReason);
        assert.equal(trace.verdict, 'DENY');
      }
    }
  }
  for (const c of Object.values(d.contracts.contracts)) {
    assert.match(c.address, /^0x[0-9a-f]{40}$/);
    assert.equal(new URL(c.verifiedUrl).hostname, 'example.invalid');
  }
  assert.deepEqual(d.contracts.contracts, d.manifest.deployments[d.contracts.deploymentId].contracts);
  assert.equal(d.contracts.chainId, d.manifest.deployments[d.contracts.deploymentId].chainId);
  assert.equal(d.signatures.status, 'UNSIGNED');
  assert.equal(d.signatures.payloads.length, 1);
  for (const p of d.signatures.payloads) {
    assert.equal(p.taskId, 'S5');
    for (const key of ['signature', 'digest', 'types']) assert.equal(p[key], null);
    assert.equal(p.domain.salt, null);
    assert.deepEqual(p.message.milestones.map(m => m.amountMinor), ['30000', '120000', '280000']);
  }
  assert.equal(d.rationales.commitmentVerified, false);
  assert.equal(d.rationales.entries.length, 2);
  assert.deepEqual(d.rationales.entries.map(r => r.taskId), ['S5', 'T4']);
  for (const e of d.rationales.entries) {
    assert.match(e.rationale.amountMinor, /^\d+$/);
    assert.match(e.salt, hex32);
    assert.match(e.rationaleHash, hex32);
    assert.equal(e.decisionId, d.evidence.find(r => r.taskId === e.taskId).decisionId);
  }
  assert.equal(d.rationales.entries[0].rationale.amountMinor, '120000');
  const ads = d.plan.manifest.lines.find(l => l.lineKey === 'PACKAGING');
  assert.equal(ads.perTxCapMinor, '37500');
  assert.equal(d.rationales.entries[1].rationale.amountMinor, '40000');
  assert.ok(BigInt(d.rationales.entries[1].rationale.amountMinor) > BigInt(ads.perTxCapMinor));
  assert.equal(d['country-pack'].hashVerified, false);
  assert.deepEqual(d['country-pack'].facts, {});
  assert.equal(d['country-pack'].hash, d.plan.manifest.countryPackHash);
  assert.equal(d['llm-calls'].hashAlgorithm, 'sha256-utf8');
  assert.equal(d['llm-calls'].calls.length, 1);
  for (const call of d['llm-calls'].calls) {
    assert.equal(call.model, 'mock-canned');
    assert.equal(call.inputSha256, sha256(call.input));
    assert.equal(call.outputSha256, sha256(call.output));
  }
  return '3 mock evidence rows pass structural/link checks; cryptographic verification and UI rendering are not tested.';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(validate(await load())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
