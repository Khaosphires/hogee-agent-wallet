# Mock evidence bundle — P3 task 3.3

**UI SAMPLE ONLY.** Every row is scripted. These are not actual test passes, chain receipts, valid signatures, verified country rules or submission evidence. Keep a visible mock banner; never count these rows in evaluation results.

This is a three-row display bundle following `project.md` sections 16, 26.5 and 26.8, validated against main snapshot `d4961a6d3283defdbaf4e63f3f7db977b212e205`. P2 can import it without a wallet, keys or network.

## Examples

| Task | Display case | Detail |
|---|---|---|
| S5 | Successful deposit | 120,000 minor held in supplier escrow; no bank payout claimed |
| T4 | Forced overspend reverted | 40,000 minor exceeds the 37,500 packaging per-payment cap; `CapExceeded` |
| T11 | Agent refusal | Canned supplier-injection refusal, no transaction or receipt |

S5 and T4 reuse IDs and placeholder hashes from the checked-in Rina scenario. T11 is a standalone canned reader example. The `onchain_success` / `onchain_revert` layers describe simulated UI states only. `outcome: pass` is the scripted expectation, not a measured result. Task IDs follow sections 19.1 and 13.2.

## Files and integration

- `manifest.json`: run ID, integration-reference Git commit, deployment map and tool labels. `gitCommit` identifies the main reference revision, not a real execution or the later bundle commit.
- `evidence.json`: the exact three-row array to render. Multiple layers of one attack can share a task ID in future; do not assume task ID is always a unique database key.
- `receipts.json`: `{sourceType, warning, receipts:[{taskId, receipt, revertReason?}]}`. Receipts are minimal fabricated JSON-RPC-style display records; logs are empty and no event decoding is claimed.
- `traces.json`: trace array, joined through each row's `traceId`.
- `signatures.json`: unsigned SupplierApproval display inputs; absent types, salt, digest and signature are explicitly `null`. Show “unsigned mock”; do not call signing APIs.
- `rationales.json`: salted display preimages with copied placeholder commitments. They deliberately do not claim a matching cryptographic commitment.
- `llm-calls.json`: canned input/output with real SHA-256 hashes of those exact UTF-8 strings. No model was called.
- `country-pack.json`: an empty mock pack with the plan's placeholder hash. No researched facts.
- `contracts.json`: deterministic mock addresses and reserved example.invalid verification URL placeholders; no deployed contracts.
- `plan.json`: copied Rina plan for inspection.
- `SUMMARY.md`: generated description of the three examples.

`artifacts[]` uses bundle-relative file-name strings. Resolve them inside this bundle, not against the repository root. Read `manifest.deployments[row.deploymentId]` for deployment details. The row `contract` field uses an address; the off-chain refusal uses an empty string. Never construct an explorer link from these placeholder hashes. Keep all verification links disabled in mock mode; example.invalid addresses are placeholders, not verification evidence.

P2 owns the page and mock-route adapter. G0 defines the detail response as {manifest, rows, files}; use the manifest, evidence array and local artifact list to assemble it. Run summaries use {runId, createdAt, gitCommit, rowCount}. The sample is an evidence-page fixture, not a complete replay store for the whole app.

## Rebuild and validate

Node 24, after installing the pinned workspace dependencies, from the integration checkout root:

```sh
node fixtures/evidence-sample/build.mjs
pnpm --filter @hogee/core validate:data --require "fixtures/scenario-rina/*.json,fixtures/evidence-sample/*.json"
node fixtures/evidence-sample/validate.mjs
node --test fixtures/evidence-sample/validate.test.mjs
```

The builder reads `fixtures/scenario-rina/` and writes only this folder. With the same source JSON it produces identical output. If the Rina inputs change, rebuild this bundle with them and update the schema-reference commit in the builder when changing schema versions.

Validation checks the three expected cases, file links, receipt status/hash/block/address, trace joins, money/cap/schedule values, mock labels, canned-call SHA-256 hashes, the real core constitution and the plan's JCS/Keccak hash. It does **not** verify chain inclusion, EIP-712 signatures, other commitments or trace hash chains. This bundle is intentionally unsuitable for `make verify` or final submission.

## Integration checks still required

Check that the page shows the mock banner, all three layers, the CapExceeded reason, local artifact downloads and the refusal's missing transaction gracefully, including offline. Measured integration results are recorded in `docs/compliance/P3-rina-sandbox-results.md`.

The G0 evidence row and manifest schemas pass locally. Receipt/signature/preimage envelopes remain mock display artifacts, not verifier inputs. The required verifiedUrl fields use https://example.invalid/mock-contracts/<name> because no deployed contracts exist for this sample. Replace all sample artifacts with recorded and verified output at G6.
