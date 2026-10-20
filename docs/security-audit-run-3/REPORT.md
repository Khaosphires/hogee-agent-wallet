# Security audit — hogee run-3 (tasks 1.8, 1.6, 1.11 and the final-1 TS mirror)

## 1. Run, scope and limits

- **Profile:** `quick`. **Scope:** the diff `1e77ac0..11cbb81` on branch `p1/dev`. This is a partial pass, not a full-repository audit.
- **What is in scope:**
  - the final-1 contracts: Treasury and its state and storage, TreasuryGovernance, TreasuryLoosenRules, TreasuryModuleHooks, MilestoneEscrow, SalesOracle, and the DeployFinal/DeployLoop/SmokeFinal scripts;
  - the worker (`apps/worker`), the only signer;
  - the LLM agent library (`packages/agent`);
  - the TS mirror of the final-1 rules (`packages/core/src/policy`; `packages/chain/src/{intents,watcher,events}.ts`).
- **Source ref:** `11cbb81`, read from a clean, detached, read-only worktree.
- **Budget:** none set.
- **Agents:**
  - 1 reconnaissance pass (the parent);
  - 6 hunters (`h-gov`, `h-escrow`, `h-worker`, `h-ops`, `h-agent`, `h-mirror`) in exactly one wave;
  - 6 fresh, independent verifiers (`v-1`..`v-6`), one per candidate, doing candidate validation and final-record verification together;
  - 1 final coverage critic (`critic-1`).
- **Execution:** sandboxed source-and-local-only, and in practice **source only**. macOS cannot enforce the required memory, disk and file-size limits, and no reviewed promotion code exists, so no target code ran. Every check is `method: source` with no artifact. A source-only pass cannot meet the `confirmed` evidence bar, so the strongest verdict this run can reach is `needs_validation`.
- **Prior runs:** run-1 (`0b3e41d`) and run-2 (`70045f3`). Both were quick and ended with no confirmed records.
  - Run-2's two `needs_validation` leads were fixed after run-2 and re-checked here.
  - Earlier units whose source did not change are `out_of_scope` (46 units).
  - Run-2 units for the policy mirror and chain intents/watcher are re-covered as current units, because their source changed.
- **Deferred coverage:** 4 units. The final critic found these gaps, and the quick profile runs no follow-up wave (see §7).
- **Out of scope:**
  - anything outside the diff;
  - the task 1.12 API and any caller of the agent library (none exists at this commit);
  - P3 data validators;
  - the `@hogee/privacy` redactor, a stub that throws.

## 2. Security posture

**No confirmed vulnerabilities.** Five independently verified leads remain. All five are real source paths whose decisive behaviour needs execution or a component that is not yet built. Two themes stand out:

- **The worker's containment of a leaked agent key (T29) is narrower than designed.** Escrow funding by the agent key is never treated as an orphan. The orphan safety pause counts as done once a transaction is signed, not once `Treasury.paused()` is true.
- **Settlement treats the database as the authority** for what it pays and attests. Neither the payment row nor the account the rail pays is bound to the on-chain spend or to the founder-signed payout hash.

The contracts' core controls held under review:
- delegatecall to an immutable module behind `onlyDelegated`;
- two signatures, a timelock and a re-check at execute for every loosening;
- agent/lender/oracle role separation;
- cumulative escrow bounds.

The fifth lead (milestone release skipping payee cooling after a re-bind) is a contract-side gap in the T3 payee-swap control. One candidate (a queued loosening overriding a later line tightening) was rejected as documented design (require-table Decision 6).

## 3. Confirmed findings

None. See §1: a source-only run cannot confirm.

## 5. Needs validation (leads, no severity)

All details are copied from `findings.json` in `NEEDS-VALIDATION.md`. Each blocker below includes the run-wide execution restriction.

| # | Lead | Repository trace (entry → sink) | Exact blocker | Bounded local next step | Owner-observed check |
|---|---|---|---|---|---|
| 1 | Agent-key `fundMilestone` outside the backend raises no orphan halt and no `Treasury.pause()` (alert only) | `contracts/src/MilestoneEscrow.sol:66` → `TreasuryModuleHooks.sol:35` (no Treasury event) → `apps/worker/src/jobs/reconcile.ts:147` (only the Treasury address is watched) → `apps/worker/src/jobs/orphans.ts:109` | No execution. Whether a fundable founder-approved order exists, and whether the agent key already has a nonces row, are deployment state. | Anvil + throwaway Postgres: the agent key calls `fundMilestone` directly; reconcile twice; today expect no ORPHAN_SPEND halt and `paused() == false`. Control: a direct `spend` halts and pauses. | Compare `MilestoneFunded` logs on the final-1 test deployment with FUND_MILESTONE payment rows; read `Treasury.paused()`. |
| 2 | The orphan `Treasury.pause()` counts as done once signed under one fixed id, so a contested, stale-nonce or second orphan leaves the treasury unpaused | `contracts/src/Treasury.sol:134` → `reconcile.ts:144` → `orphans.ts:119,121` (fixed id, ON CONFLICT DO NOTHING) → `reconcile.ts:124` (agent first; `nonce_consumed` is not an error) → `reconcile.ts:115` | No execution. | `reconcile.live.test.ts`: (A) two orphans separated by an UNPAUSE and `ops resume`; (B) the agent replaces the pause at its nonce; (C) an orphan during an operator halt. Today each ends with `paused() == false`. | Search worker logs for `treasury_pause_sent` followed by `UNRESOLVED_ROW` for `reconcile:orphan-pause`; read `Treasury.paused()`. |
| 3 | settle-spend pays out, and has the oracle confirm or fail, using mutable payment-row fields never bound to the on-chain spend | `apps/worker/src/jobs/settle.ts:202` → `:77` → `:91` (only `settlementState`) → `contracts/src/TreasuryStorage.sol:110` → `settle.ts:106` → `settle-decide.ts:51/56/60` → `settle.ts:139` → `settle.ts:138` | No execution. Whether any principal other than the worker can write `public.payments` is a deployment fact. Real-money impact needs XenditRail (task 1.12). | `settle.live.test.ts`: tamper `amount_minor`; insert a fabricated FINALIZED row; set FAILED after a SUCCEEDED payout; force a retry after success. | List INSERT/UPDATE grants on `public.payments` and `public.payees` in each deployed Postgres; confirm the deployed rail. |
| 4 | The account the rail pays (`payees.xendit_account_ref`) is not bound to the founder-signed `payoutAccountHash` that the destination check compares | `settle.ts:202` → `:73` → `:106` (stored hash vs binding) → `settle-decide.ts:58` → `settle.ts:143` (pays `xendit_account_ref`) | No execution. XenditRail and the production writer of `xendit_account_ref` (task 1.12) are absent. `public.payees` grants are a deployment fact. | `settle.live.test.ts`: change only `xendit_account_ref`; expect a SUCCEEDED mock payout to the new reference and a `SettlementConfirmed` today. | List UPDATE grants on `public.payees`; when 1.12 lands, confirm that the Xendit destination is derived from the hashed `{channel, accountNumber, holderName}`. |
| 5 | `releaseMilestone` pays a re-bound supplier inside its restarted cooling (veto) window | `contracts/src/Treasury.sol:105` (re-bind) → `:410` (`_bind` restarts cooling and overwrites the hash) → `MilestoneEscrow.sol:94,103` → `:174` → `TreasuryModuleHooks.sol:57` (no cooling read) | No forge execution. Milestone payouts are not wired in the worker (`settle.ts:77`), so whether funds reach the new account is unobserved. | `MilestoneRelease.t.sol`: re-bind with a new hash, then release an earlier fully funded milestone without warping; today it succeeds while `coolingUntil > now`. | From the 1.12 milestone-settlement design, confirm which account a MILESTONE settlement pays and whether it holds during cooling. |

Rejected (not a finding; recorded so it is not repeated without new evidence): `contracts/src/TreasuryGovernance.sol:executeLoosen:queued-loosening-overrides-later-tightening`. The effect is exactly what both loosening authorities co-signed, and limiting queue cancellation to the treasury-pause transition is documented and tested.

## 6. Hardening notes and positive patterns

**Hardening notes.** There are 44 unique hunter notes, in `hardening.generated.md`. These are not findings. The main themes:

- **Contracts:**
  - the observer is never checked against the agent, lender or oracle, so a worker-held key could veto every UNPAUSE;
  - timelock and cooling accept 1 s off Anvil;
  - DeployFinal does not refuse an Anvil default broadcaster off Anvil, although the escrow and oracle link addresses come from deployer nonces;
  - links are not re-checked on-chain after broadcast;
  - zero-amount milestones are accepted;
  - there is no Treasury/TreasuryGovernance storage-layout equality check, and `onlyDelegated` refusal is tested for `releaseStage` only;
  - a failed milestone payout strands escrowed budget units;
  - founder and lender structs share one nonce space.
- **Worker:**
  - `raiseHalt` drops later reasons;
  - the lender key sits in the hot process;
  - keys are scrubbed from `process.env` only;
  - `http:` RPC URLs are accepted;
  - unmapped rail failure codes throw on every pass;
  - a FAILED chain state with a SUCCEEDED payout closes silently;
  - there is no DB `statement_timeout`;
  - in-flight ownerSpends are ignored by pacing.
- **Agent library:**
  - guarded models are structural, so a raw handle can bypass the guard;
  - streams deliver parts before the call log is written;
  - `reasoning-file`/`custom` parts and JSON keys are not redacted;
  - memory uses caller-chosen ordering and has no facility filter;
  - reader money grounding is substring-based and the currency is unchecked;
  - homoglyphs and visible blanks get past the detector;
  - an ollama-mode provider override can leave privacy mode;
  - milestone invoice escalation is only advisory.

**Positive patterns seen in source:**
- An immutable governance module behind `onlyDelegated`, with one `TreasuryState` layout.
- Every loosening needs the founder's and the lender's signatures plus a timelock, a grace period, a veto window and a full re-check at execute. A pause of an unpaused treasury cancels the whole queue.
- Agent-key role separation from owner, lender and oracle (run-2 fix).
- Escrow funding bounded by the founder-signed cumulative schedule and the global outflow headroom.
- SalesOracle dedup.
- Worker signing only rows whose intent equals a freshly recomputed proposal; calldata intent recompute; event-source checks on every decoded event.
- Fail-closed redaction with canary scanning and hash-only call logs.
- Grounding and taint labels on every reader field.

## 7. Coverage summary

- **Ledger:** 66 units.
  - **12 covered.**
  - **4 candidate** units, holding 6 candidates: 5 `needs_validation` and 1 `rejected`.
  - **0 blocked.**
  - **4 deferred.**
  - **46 out_of_scope.**
- **Both validators pass:** `validate-findings.cjs` (6 records) and `validate-coverage-ledger.cjs` (66 units).
- **Final critic (`critic-1`):** `stop: false`, no reassignments. It accepted 4 missing units, recorded as `deferred`:
  1. the worker's hot oracle and lender keys alongside the agent key, and whether co-location collapses the two-party controls (inside the diff);
  2. which principals can write the Postgres rows that drive signing, payouts and halts, given the worker's idempotent DDL and no grants or RLS (mixed scope);
  3. `DEPLOYMENT_FILE` manifest provenance and a self-referential preflight that never checks the contract links (inside the diff);
  4. observer veto separation from the agent, oracle and worker-held keys (mixed scope).
- **Hunter-reported gaps not accepted as in-scope:** task 1.12 agent callers, P3 data validators, and the privacy redactor stub. None of these has code in this diff.
- **Prior leads:**
  - Run-2 `packages/core/src/taint/imperative.ts:stripInvisible:incomplete-invisible-format-char-set`: **resolved**, per the critic.
  - Run-2 `packages/core/src/scorer/criteria.ts:scoreCriteria:trust-verification-from-unverified-ids-and-metrics`: the h-agent unit re-checked it and found the fix holds in source, but the critic did not list it as resolved. It stays a prior lead until a later run closes it.
- **No clean-coverage claim:** this is a quick, scoped, source-only pass with deferred gaps.
