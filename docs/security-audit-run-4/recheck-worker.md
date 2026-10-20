# Post-fix security re-check of the run-4 worker fixes (HEAD 8c6db2b)

Read-only: no edits, no builds, no tests. I found no HIGH or CRITICAL regressions, and no new key-signing or payout path that should not exist. The four MEDIUM findings are availability and cost problems, not safety problems.

The Skill tool wasn't available to me, so I read the three SKILL.md files directly. Applied from them:
- **Simulate before send:** the adoption path re-binds to finalized logs before any payout, and `cancelLoosen` goes through the `signAndStore` gas simulation.
- **Kill switch:** the halt gate in `settle.ts:292` still lets `close`, `wait` and `blocked` run while halted, and blocks payouts and confirms.
- **Keccak:** `keccak256Utf8` in `packages/core/src/hash/index.ts:87` uses noble `keccak_256`, and there is no `sha3-256` in worker, chain or core.
- **Access control, idempotency and CEI:** the contract-side rules are unchanged by this diff. The rail idempotency key is derived from the settlement id, invoice hash and attempt only, so two rows for one settlement cannot pay twice.

## MEDIUM

**M1. `SETTLEMENT_CONTRADICTION` on CONFIRMED can wedge the whole worker, and no operator command resolves it.**
- Files: `apps/worker/src/jobs/settle-decide.ts:119`, `settle.ts:273` and `:292`, `apps/worker/src/ops/cli.ts` (halt status and resume only).
- Scenario:
  1. An outside confirm lands, from either of two sources: someone holding the oracle key, or a hand rescue with that key (the audit itself named hand rescue as the only remedy).
  2. The worker's own confirm reverts with `SettlementClosed`, or was never sent.
  3. The rail's payout then SUCCEEDS, or already had.
  4. `confirmedPayoutRef` returns null, because the confirm receipt is reverted or missing, or the ref differs.
  5. The row halts globally.
  6. After `ops resume`, the next pass re-raises the halt, and it writes one ALERT trace per pass.
  7. The only way out is hand-editing `payments.state`.
- This also covers question 3: an outside confirm that lands first with the right ref still halts, because the rule only trusts the worker's own tx.
- Fix: in `decideSettlement`, close CONFIRMED to SETTLED when the history has any SUCCEEDED attempt. Raise one deduplicated halt or alert only if the ref does not match. Keep the halt only for CONFIRMED with no SUCCEEDED attempt. The safety property, never SETTLED without a rail-SUCCEEDED payout, is preserved.

**M2. An anonymous caller can trigger a global halt via `VETOED_LOOSEN_EXECUTED`.**
- Files: `apps/worker/src/jobs/sync.ts:168` and `:190-193`, `packages/api-contract/src/routes.ts:202-205` (veto route has no persona list).
- Scenario:
  1. An approved loosening reaches EXECUTABLE.
  2. Anyone POSTs `/veto`, because unauthenticated callers read as founder. The status becomes CANCELLED and the cancel is queued.
  3. In the same moment anyone broadcasts `executeLoosen`, which has no caller check (`TreasuryGovernance.sol:129`).
  4. The execute lands before the lender-key cancel.
  5. `syncVetoedLoosens` reads EXECUTED and halts every signing and payout job.
  6. This is repeatable once per matured loosening.
- Related, covering question 2: the decision reads `queuedLoosen` at `latest`, not `finalized`. A reorged-out execute would raise the halt, and `haltEverRecorded` would then suppress the halt for the real execution.
- Fix (root cause): gate veto to the officer, lender or owner persona in the API.
- Fix (worker side): make the executed-after-veto case an alert plus persisted trace, or a tighten-only pause, instead of a global halt. Read the status at `finalized` before deciding.
- `haltEverRecorded` itself is correctly scoped by `facilityId`, `code` and `exceptionId`, so it does not suppress unrelated halts.

**M3. The per-pass scans are unbounded and fail quietly.**
- Founder-adoption candidates (`settle-adopt.ts:214-231`, `:329-336`, `:385-393`):
  - Every OWNER_SPEND or RELEASE_MILESTONE group whose rows are all POLICY_DENIED, REVERTED, CANCELLED or DROPPED is re-examined every settle pass, forever.
  - That costs one `getBlock(finalized)` and one `isIntentUsed` call per group, including groups whose intent is unused.
  - A group whose intent is used but is never adopted repeats the binary search of about 22 historical `eth_call`s plus a `getLogs` every pass. Three cases do this: a DROPPED (held) row, a log that does not match the row, and an `ownTx` hit.
  - A realistic `ownTx` case is a founder release for a milestone that FUND_MILESTONE already auto-released.
  - The search needs archive state. On a pruned node it throws, adoption never happens, and the only signal is a settle-job `error` outcome. Mismatch strings return at `settle-adopt.ts:290` and `:305` with no trace or halt.
- Vetoed-exception scan (`sync.ts:152-168`):
  - It does one `eth_call` per CANCELLED exception per relay pass. Exceptions whose queue never landed stay in the set forever, because no cancel ever finalizes for them.
- Cap-safety: the new `getLogs` calls are single-block, so they are safe on providers capped at 10 blocks. The 22-call search is the part that needs archive state.
- Fix:
  - Hoist `finalizedHead` out of the group loop.
  - Skip groups older than the signature expiry plus finality (the founder envelope TTL is `SIGNATURE_TTL_S`), or persist a "checked" marker.
  - Alert once, then skip, for held, mismatched and `ownTx` groups.
  - Drop vetoed exceptions from the scan once the chain status is terminal or the request expiry has passed.

**M4. Adoption does not check that the settlement is still NONE.**
- File: `settle-adopt.ts:331`.
- Scenario: a REVERTED or POLICY_DENIED founder row whose settlement an operator already confirmed by hand with the oracle key (the only remedy the audit offered). The first settle pass after deploy adopts it, reads CONFIRMED with no worker payout, and halts globally.
- Fix: read `settlementState` at `head` in `adoptFounderOne`. Adopt only when it is NONE. For CONFIRMED or FAILED, alert once and skip.

## LOW

- **L1. The one-slot-per-day rule is one-sided.**
  - Where: `agent-actions-world.ts:136-148` (new check), `tick.ts:110`, `decide.ts:52`. The tick only checks its own `pacing:<LINE>:<day>` id.
  - Effect: an API row signed first and then a tick row on the same chain day makes two slots. The invariant is "at most 2 per day", not 1.
  - Fix: have `tick.ts` also count other signed or mined SPEND rows on the line for the day.
  - Also, a transient hit (a reverted-but-INCLUDED row) denies the API row permanently, so the user must re-propose.
- **L2. The cancel requeue is unbounded.**
  - Where: `sync.ts:167` and `:172-178`.
  - Effect: if the cancel is persistently refused while the chain shows QUEUED (for example, the lender key mismatches `_LENDER`), each relay-then-sync cycle inserts a new `chain_actions` row and two ALERT traces.
  - The opposite failure also exists: a cancel stuck "live" and unresolved never requeues.
  - Fix: cap the requeues per exception, then raise one deduplicated alert.
- **L3. Two different "finalized" reads in one pass.**
  - Where: `settle.ts:125` re-reads the finalized head, while `settle.ts:135` read `settlementState` at the `'finalized'` tag.
  - Effect: on a load-balanced RPC the second read can be older, so the receipt block exceeds it, the ref reads null, and a legitimate close halts.
  - Fix: use one explicit block number for both reads.
- **L4. Diagnostics and config truncation.**
  - The contradiction halt detail drops `bindingDetail` (`settle.ts:273`).
  - Lowering `payoutMaxAttempts` below the succeeded attempt index truncates the history (`settle.ts:99`) and halts a legitimate close.
- **L5. Adoption alert dedupe.**
  - `alertOnce` (`settle-adopt.ts:319-326`) keys on `trace_id` plus reason code. An earlier "held" alert for the same row therefore suppresses the later "adopted" alert.
  - A crash between the insert and the alert also loses it.
- **L6. Outside oracle, lender and relayer key use is still alert-only.**
  - Seeding the nonce rows fixes detection, but the finding is one `warn` log plus a heartbeat summary that the next pass overwrites. The audit's "persisted halt event" suggestion was not implemented. This is an owner decision, noted in the README.
- **L7. Pre-existing and unchanged.**
  - `settle-adopt.ts:127` (reserve adoption) does a full-range `getLogs` from the deployment block. That breaks on providers that cap `eth_getLogs` at 10 blocks.

## Verified correct

- **v-1, close rule**
  - `settle-decide.ts:112-119` closes CONFIRMED only over a SUCCEEDED attempt whose `keccak256Utf8(payoutId)` equals the worker's own confirm ref. This matches what `settle.ts:252` sends.
  - The comparison is lower-cased on both sides.
  - The rule runs before the binding rules.
- **v-1, receipt lookup (question 3):** the lookup is bounded and canonical. It is one receipt, one block read and one finalized-head read. It requires `status === 'success'`, a block at or below finalized, and a matching `blockHash`. The CONFIRMED close does not use a latest-state read or a log-range scan.
- **v-1, destination-only failures:** a cooling or re-bound payee keeps its `keys` (`settle-verify.ts:49-50`, `settle-verify-escrow.ts:85-86`, `settle-binding.ts:40-41`), so the history is still read and the close succeeds. `planId` is stable across plan versions (`PlanRegistry.sol:115`), so re-plans do not cause `INTENT_MISMATCH`.
- **v-1, FAILED branch:** unchanged and still correct.
- **v-1, rail history:** transient rail errors throw and show as a row `error`, not a halt (`xendit-rail.ts` `#ok`).
- **v-1, replaced confirm txs:** fee-bump never touches settle-confirm. Only safety-pause uses `feeBump`, so `chain_actions.tx_hash` is accurate.
- **Nonce seeding**
  - `nonces.ts:90-98` never moves an existing row and seeds from the pending count, as a first allocation does.
  - `app.ts` runs it after preflight and `publishRoles`. A failure aborts start-up, which is fail-closed.
- **v-4 `cancelLoosen`**
  - The status and the block are read at the same `latest` block number.
  - QUEUED builds the cancel. NONE defers only while a signed queueLoosen (state PENDING, BROADCAST or INCLUDED, with raw tx) can still land.
  - The deferral is bounded by `req.expiry`. The API stores `req.expiry` as a decimal string (`typed.ts:63-64`), so the JSON path is correct, and expiry is chain-now plus `SIGNATURE_TTL_S`. There is no forever-defer.
  - Terminal statuses refuse with a label.
  - The cancel request JSON from `sync.ts` is accepted by the builder's zod parse.
  - Cancels still run while halted (`TIGHTEN_KINDS`).
- **v-8 pacing**
  - It excludes the row itself and released states, and counts signed-pending rows as taking the slot.
  - It compares the latest mined row's block timestamp against block B's chain day, using the same `chainDay` as the tick.
  - `contextOf` reloads the rows for each proposal, and the signing-job advisory lock (`runtime/lock.ts`) serialises the tick and agent-actions.
- **v-2 adoption (question 1)**
  - No double pay. A resumed original row cannot execute, because POLICY_DENIED is only ever set pre-signing and a REVERTED or CANCELLED nonce is consumed.
  - Both rows would share one chain-derived rail key, and a second confirm would revert and halt, not pay.
  - `ownTx` covers the FUND_MILESTONE auto-release case. Adopted ids are in the reserved prefixes, so they are never treated as API proposals.
  - A forged DB row can only make the worker pay a chain-verified settlement to the chain-bound payee. The amount comes from the log, and the destination is re-bound at finalized by the usual binding. At worst a forged row triggers a halt.
  - The binary search reads at explicit finalized-bounded block numbers. The lower bound is before the Treasury exists (the ZeroData error is handled), and `isIntentUsed` is monotone.
  - The event filters use indexed arguments (checked in `IHogeeBase.sol`).
- **Halt re-raising:** the `settle.ts:292` halt gate keeps payouts and confirms stopped while halted.

Paths are under `/Users/eldridge01gmail.com/Desktop/Fintechathon/hogee/`.
