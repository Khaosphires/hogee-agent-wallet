import test from 'node:test';
import assert from 'node:assert/strict';
import { load, validate } from './validate.mjs';
const original = await load();
test('complete mock bundle links correctly', () => assert.match(validate(original), /3 mock evidence rows/));
for (const [name, mutate] of [
  ['missing artifact', d => { d.evidence[0].artifacts.push('missing.json'); }],
  ['path traversal', d => { d.evidence[0].artifacts.push('../outside.json'); }],
  ['wrong receipt status', d => { d.receipts.receipts[1].receipt.status = '0x1'; }],
  ['receipt hash mismatch', d => { d.receipts.receipts[0].receipt.transactionHash = d.evidence[1].txHash; }],
  ['missing trace', d => { d.traces.pop(); }],
  ['fake explorer link', d => { d.evidence[0].explorerUrl = 'https://example.invalid/tx'; }],
  ['transaction on refusal', d => { d.evidence[2].txHash = d.evidence[0].txHash; }],
  ['tampered canned log', d => { d['llm-calls'].calls[0].output += 'changed'; }],
  ['false verification claim', d => { d.rationales.commitmentVerified = true; }],
  ['incorrect deposit', d => { d.rationales.entries[0].rationale.amountMinor = '280000'; }],
]) test(`rejects ${name}`, () => {
  const data = structuredClone(original); mutate(data); assert.throws(() => validate(data));
});
