# Security audit run-6: Hogee task 1.16 evidence, task 1.9 encoder, compile fail-closed

## 1. Run, scope and limits
- **Profile:** `quick`, scoped. **This is a partial pass.**
- **Scope:** the diff `7ca38ca..a33ea08` on `p1/dev`:
  - task 1.16: evidence export (`POST /api/evidence/export`, `make evidence`), the live evidence routes, the offline verifier `tools/verify-evidence` (`make verify`; P2's explorer imports it), and the rationale preimage writers plus migration `0001_rationales`;
  - task 1.9: the passkey encoder in `packages/chain/src/passkey`. Its Foundry vector test is test-only;
  - the compile fail-closed change: `PackFactMissingError` replaces the permissive defaults. The CI and `.gitignore` edits are config only.
- **Source ref:** `a33ea08`, read from a clean, detached, read-only worktree.
- **Execution:** sandboxed, source-and-local only. **No target code was executed**: macOS cannot enforce the required sandbox limits, so every check is source-only.
- **Agents:**
  - 3 hunters in one wave (`h-evidence`, `h-verifier`, `h-writers`);
  - 6 verifiers, one per candidate (Phase 3 merged with Phase 5);
  - 1 final coverage critic.
  No budget was set.
- **Prior runs:** runs 1–5 have no confirmed records. Run-5's deferred eval-spend unit is unchanged. Run-4 lead 5 (first-come passkey enrolment) is being closed by the G2 schema batch, outside this range.
- **Deferred:** 4 units from the critic (section 6).

## 2. Security posture
These parts keep their invariants, as far as the source shows:
- **Rationale writers:** every preimage is written in the same DB transaction as its decision row, before any key touches it. The stored object is exactly the one hashed, so no hash or calldata changed.
- **Compile fail-closed:** no fee, threshold, approval, duty route or import tax rate that carries money is defaulted any more. A missing pack leaf answers 409 `COMPILE_FAILED`, which names only the leaf.
- **Passkey encoder:** DER parsing is strict, low-s uses the same boundary as OZ P256, and the Sig layout matches `HogeeSigs`. The API re-verifies byte-exactly before it relays, so the encoder is not a trust boundary.
- **Evidence scope and leakage:** every export query is bound to the server's facility. Bundles carry no keys, cookies, raw chat, Stripe or Xendit data, and eval traces are dropped. The single-flight lock and the never-overwrite publish hold.
- **Contained bundle reads:** reads use realpath, accept only regular single-link files, and open with `O_NOFOLLOW|O_NONBLOCK` plus an inode re-check. Responses are inert (nosniff, CSP sandbox).

The weak point is the evidence pipeline's trust model. The offline verifier proves internal consistency, not chain truth, and the export has per-bundle bounds but no aggregate ones.

## 3. Confirmed findings
None.

## 4. Needs validation (6; `NEEDS-VALIDATION.md`)
Each lead carries a full trace, blockers and a safe local validation plan.

| # | Fingerprint | Lead |
|---|---|---|
| v-1 | `packages/api/src/evidence/collect.ts:capped:whole-history-row-cap` | The founder-persona writers (signature requests, refused submissions) grow `traces` and `signature_requests` without bound. Past 50,000 rows, every export answers 409 permanently. |
| v-2 | `packages/api/src/evidence/export.ts:exportEvidence:unbounded-bundle-retention` | An anonymous export writes a full new bundle on every state change: no retention, no interval limit, and `listRuns` reads every run. |
| v-3 | `tools/verify-evidence/src/chain.ts:row-labelled-chain-view` | DB row labels decide which txs the bundle and the verifier see. A relabelled mined row drops its tx and events, and the bundle still verifies. Non-agent payment kinds are unbound, and T29 orphans are never fetched. |
| v-4 | `tools/verify-evidence/src/rationales.ts:unavailable-preimage-accepted` | A self-declared "pre-1.16" missing rationale preimage passes for any decision. |
| v-5 | `tools/verify-evidence/src/replay.ts:replay-laxer-than-treasury` | Event replay is laxer than Treasury and MilestoneEscrow in six places: bound-AND-listed payees, agent expiry, milestone funding checks, the 64-entry window and the T29 pause scope. |
| v-6 | `tools/verify-evidence:unanchored-receipt-content` | Receipts, logs, blocks and SUMMARY.md are bound to nothing outside the bundle, so a consistently rewritten bundle verifies. Example: a successful spend shown as a blocked attack, or a swapped founder key. |

Two shared blockers: target execution is forbidden, and deployment facts (API exposure via `HOGEE_ALLOWED_HOSTS`, and whether judges compare hashes with Sepolia) are not in source.

## 5. Hardening (22 notes; `hardening.generated.md`)
The ones worth acting on:
- the exporter ships raw signed bytes once signed, not once mined;
- `collect()` runs without a shared snapshot;
- eval LLM calls are orphaned when an eval throws early;
- the export builds every file in memory, and the verifier runs synchronously on the API event loop;
- the read path's parent-swap race needs local write access;
- the encoder's SPKI header and curve check, its raw-substring challenge pre-check, and its BOM handling;
- a defensive hash-equality check in `insertRationale`;
- `decisionId` is missing from three worker rationale preimages;
- `__proto__` bundle file names, and pre-EIP-155 txs;
- trace chains have no anchor.

## 6. Coverage
- **Ledger:** 101 units: 5 covered, 3 candidate (the units behind the 6 leads), 4 deferred, 89 out of scope.
- **Final critic:** `stop: false`. It accepted 4 missing units, all deferred because the quick profile runs no follow-up wave:
  1. per-request memory, CPU and lock cost of the evidence routes;
  2. whether an honest export is complete (no deployment log scan, receipts read at `latest`, and evidence rows that can never record a failed defence);
  3. a shared evidence root across deployments and exporters (`readRun` does not check `deploymentId` or `chainId`, `sweep` assumes one database);
  4. a volume bound on anonymous trace writers. This one is outside the scoped diff.
  Units 1–3 and part of 4 are handed to the run-6 fix branches.
- **Validators:** both pass (`validate-findings.cjs`: 6 records; `validate-coverage-ledger.cjs`: 101 units).
- **Scope limit:** this run covers only the scoped diff and does not exhaust the target.

## 7. Fixes in progress
- **`wip/run6-export`** (v-1, v-2, critic units 1, 3 and 4):
  - signature requests are reused per kind and ref, pending requests are capped, and a request locks after N refusals;
  - export retention keeps the newest K runs, with a minimum interval checked before `prepare()`;
  - `listRuns` reads only the newest runs;
  - `readRun` checks the deployment, `sweep` touches only its own temp folders, and `created:false` no longer claims verified.
- **`wip/run6-verifier`** (v-3 to v-6, critic unit 2):
  - an `unavailable` preimage now fails;
  - replay checks match Treasury;
  - the exporter fetches every row's receipt, CANCELLED rows are proven by (signer, nonce), and non-agent payment kinds are bound;
  - every event is bound to its own tx's calldata, `registerFounderKey` is decoded, and SUMMARY.md is regenerated and compared;
  - the CLI prints an anchor and an optional `--rpc` online mode;
  - rows can record a failed defence.
- The skills re-check runs after these merge.
