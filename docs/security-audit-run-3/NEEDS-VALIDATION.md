# Needs validation — hogee run-3

Source ref `11cbb81` (branch p1/dev; scope = diff 1e77ac0..11cbb81: tasks 1.8, 1.6, 1.11 and the TS mirror). Profile `quick`, scoped, source-only: no target code was executed.
These are prioritized leads, not confirmed vulnerabilities, and carry no severity. Each section is copied from the final record in
`findings.json`. Owner checks ask you to observe your own components only; none involves sending traffic to a deployment.

## 1. Agent-key fundMilestone outside the backend raises no orphan halt and no Treasury.pause() (alert only)

- **Fingerprint:** `apps/worker/src/jobs/orphans.ts:watchOrphans:agent-fundMilestone-outside-backend-not-watched`
- **Verifier:** `v-1` (independent, source-only)

### Claimed root cause

The orphan detector's scope is fixed to Treasury-address logs (reconcile.ts:147; orphans.ts:106,109) and to Spent/OwnerSpent events (orphans.ts:69). MilestoneEscrow.fundMilestone is a second value-moving agent-key entry point. It produces logs only on the MilestoneEscrow address (MilestoneFunded, MilestoneReleased), because Treasury's escrowFund and escrowRelease hooks emit nothing. It is therefore outside that scope, and the external-key-use path stays alert-only because it relies on the orphan check to pause on any spending use (halt-rules.ts:9).

### Description

On final-1 the agent key can move facility budget into MilestoneEscrow. MilestoneEscrow.fundMilestone is gated by four things. First, requireSpendingAgent: the caller is the current agent, not revoked, not expired, and the treasury is not paused. Second, the order must exist, which means a founder-signed SupplierApproval went through Treasury.bindPayee. Third, checkEscrowLine: the line is active and valid, with no line pause or open circuit, and the payee is bound and past cooling. Fourth, the cumulative funding must stay within the signed schedule, and the line and global outflow caps inside Treasury.escrowFund must hold. There are no per-tx or window caps. When an autoRelease milestone is fully funded, _release runs in the same call: it opens a milestone settlement and raises the payee binding's paidMinor.

The worker never sends fundMilestone. buildFundMilestone has no caller in apps/worker/src, and tick/pacing sign only SPEND rows. So at this commit, every MilestoneFunded is agent-key use outside the backend. That is the T29 case: project.md:719 says a leaked agent key used outside the backend must be flagged and the treasury auto-paused.

watchOrphans does not cover this case. runReconcile passes it only the Treasury address. pollLogs reads only that address, and classify drops every event except Spent and OwnerSpent. escrowFund and escrowRelease emit no Treasury event; MilestoneFunded and MilestoneReleased come from the MilestoneEscrow address, which nothing in the worker polls. The only remaining signal is the nonce check. It raises EXTERNAL_KEY_USE as a warn-level alert, and only when the agent key already has a nonces row (dbNext != null). halt-rules.ts:9 justifies keeping that alert-only by assuming the orphan check pauses the treasury whenever the external use spent money. That assumption does not hold for escrow funding.

Result: a leaked agent key can fund founder-approved milestones up to their signed schedules and trigger autoRelease settlements while the worker stays unhalted and Treasury stays unpaused. Escrowed funds can never be decreased (escrowedMinor is only ever increased). Escrow also shares the global outflow bound with spend (_spentMinor + _escrowedMinor <= releasedMinor and fundedMinor), so funding escrow early can make legitimate spends on other lines revert CapExceeded. Because the treasury is never paused, the key stays usable for each newly approved order. A key holder who knows about the watch can use fundMilestone and avoid Treasury.spend.

The damage is bounded. The payees, the schedules and the autoRelease flags are all founder-signed, so funds cannot be sent to the attacker. Budget units are internal. The worker's settle job pays out SPEND rows only, so no fiat payout of a milestone settlement happens at this commit.

Fix: add a finalized log watch over deployment.contracts.MilestoneEscrow with its own log_checkpoints cursor (pgLogCursorTx is already keyed by contract). Treat a MilestoneFunded as an orphan unless it matches a FUND_MILESTONE payments row. Match on three things: the intent id fundMilestoneIntentId(orderId, idx, amountMinor, cumulative funded from the event), the same rationaleHash, and a tx hash the row signed. On an orphan, raise the ORPHAN_SPEND halt and queue Treasury.pause() in the same transaction. Regression test: on final-1, the agent key calls fundMilestone directly, and reconcile must halt and pause.

### Source trace

1. **entrypoint** `contracts/src/MilestoneEscrow.sol:66` — `fundMilestone`: An agent-key holder outside the backend (T29: leaked agent key) calls fundMilestone directly. It is gated only by requireSpendingAgent, the order's existence, checkEscrowLine, the cumulative schedule bound and the escrowFund caps. There is no per-tx or window cap.
2. **propagation** `contracts/src/TreasuryModuleHooks.sol:35` — `escrowFund`: Treasury raises the line's and the global escrowedMinor and emits no Treasury event (the comment at line 41 defers logging to MilestoneFunded).
3. **propagation** `contracts/src/MilestoneEscrow.sol:85` — `fundMilestone`: MilestoneFunded is emitted from the MilestoneEscrow address. A fully funded autoRelease milestone calls _release in the same call (line 86), which runs escrowRelease (also no Treasury event) and emits MilestoneReleased from MilestoneEscrow.
4. **propagation** `apps/worker/src/jobs/reconcile.ts:147` — `runReconcile`: Only the Treasury address is passed to watchOrphans. No watch is started for deployment.contracts.MilestoneEscrow.
5. **sink** `apps/worker/src/jobs/orphans.ts:109` — `watchOrphans`: pollLogs reads finalized logs only from d.treasury, so MilestoneFunded is never read. Neither the ORPHAN_SPEND halt (line 119) nor the Treasury.pause chain action (lines 121-124) is created, and the treasury stays unpaused.

### Evidence

- `apps/worker/src/jobs/orphans.ts:69`: classify returns null for every event except Spent and OwnerSpent, so escrow events would be ignored even if they were polled.
- `apps/worker/src/jobs/halt-rules.ts:9`: Key use outside the allocator is alert-only, on the stated assumption that the orphan-spend check pauses the treasury whenever that use spent money.
- `apps/worker/src/jobs/halt-rules.ts:69`: EXTERNAL_KEY_USE goes into alerts, not halts.
- `packages/chain/src/nonces.ts:169`: externalUse is true only when the signer already has a nonces row (dbNext !== null), so even the alert depends on the worker having used the agent key before.
- `packages/chain/src/tx-builder.ts:212`: buildFundMilestone exists, but nothing in apps/worker/src calls it, so every on-chain fundMilestone at this commit happens outside the backend.
- `apps/worker/src/jobs/tick.ts:111`: The tick job resumes and signs only SPEND rows, so no FUND_MILESTONE payment row is ever signed by the worker.
- `apps/worker/src/jobs/settle.ts:77`: settle selects only SPEND rows, so milestone settlements are never paid out by the worker. This bounds the current impact to the budget-unit ledger.
- `contracts/src/TreasuryModuleHooks.sol:45`: The global escrowedMinor is only ever increased. No contract path decreases it, so attacker-driven escrow funding is irreversible.
- `contracts/src/Treasury.sol:369`: spend's global outflow bound includes _escrowedMinor, so escrow funded by the leaked key consumes the releasedMinor/fundedMinor headroom that legitimate spends on other lines need.
- `packages/chain/src/deployments.ts:27`: The final-1 manifest carries the MilestoneEscrow address, so the worker could watch it.
- `contracts/src/TreasuryState.sol:195`: _requireSpendingAgent reverts Paused, so the missing pause is what leaves fundMilestone open to the key holder.
- `project.md:719`: T29 control: a leaked agent key used outside the backend must be flagged by the reconciler and the treasury auto-paused.
- `apps/worker/README.md:61`: The documented halt covers only an orphan Spent.

### Blockers

- The run-3 execution policy forbids running target code: there is no OS-enforced sandbox with memory, disk and file-size limits, and the promotion allowlist is empty. A final-1 Anvil + Postgres run of a direct agent-key fundMilestone followed by runReconcile therefore cannot be observed, and the source-derived outcome (no orphan, no halt, no pause row, Treasury.paused() == false) cannot be confirmed.
- Live exposure depends on deployment data state that source does not show. Two facts decide it: whether the owner's final-1 deployment has a fundable founder-approved escrow order (bindPayee executed, line active, payee past cooling, milestone not fully funded), and whether the worker's agent key already has a nonces row. The second fact decides whether even the EXTERNAL_KEY_USE alert would fire.

### Bounded local validation

Run in an approved sandbox (no external network, empty allowlisted environment, read-only target, scratch-only writes, CPU/memory/disk/wall-clock limits) against a local Anvil and a throwaway Postgres, with dummy keys.

Setup: deploy final-1 with DeployFinal.s.sol. openFacility, fund, and commit a plan that has an escrowOnly SUPPLIER line. Submit bindPayee with a founder-signed SupplierApproval whose schedule contains an autoRelease milestone, then warp past coolingSeconds. Let the worker sign and finalize one pacing SPEND with the agent key, so the agent key has a nonces row.

Action: from the agent key, call MilestoneEscrow.fundMilestone(orderId, idx, <full milestone amount>, <nonzero decisionId>, <nonzero rationaleHash>). Mine past finality and run runReconcile twice.

Expected today: report.orphans is []. There is no ORPHAN_SPEND row in hogee_worker.halts and no chain_actions row 'reconcile:orphan-pause'. Treasury.paused() is false. The alerts contain only EXTERNAL_KEY_USE. On-chain, escrowedMinor has risen and milestones(orderId)[idx].released is true.

Control: repeat with a direct agent-key Treasury.spend. Expect an ORPHAN_SPEND halt and a queued pause.

After the fix: the fundMilestone case must produce the halt and Treasury.paused() == true.

### Owner-observed deployment check

Owner-observed and read-only; never audit traffic. On the owner's final-1 test deployment, the owner lists the MilestoneEscrow MilestoneFunded logs from the manifest's blockNumber at the finalized tag. The owner compares them with FUND_MILESTONE payments rows; none are expected, because the worker has no fundMilestone caller. For each unmatched log, the owner checks for an ORPHAN_SPEND row in hogee_worker.halts and reads Treasury.paused(). Today the expected finding is no halt and an unpaused treasury, with at most an EXTERNAL_KEY_USE warn line in the reconcile logs.

## 2. Orphan-spend Treasury.pause() counts as done once a tx is signed under one fixed id, so a contested, stale-nonce or later orphan leaves the treasury unpaused

- **Fingerprint:** `apps/worker/src/jobs/reconcile.ts:sendQueuedPause:orphan-pause-done-once-signed`
- **Verifier:** `v-2` (independent, source-only)

### Claimed root cause

sendQueuedPause (reconcile.ts:109-131) treats 'a raw signed tx exists for the single fixed id reconcile:orphan-pause' as 'the treasury is paused'. It never reads Treasury.paused() and never creates a new attempt. It signs with the suspect agent key first, at the stored next_nonce, which is not advanced while halted. It falls back to the lender only when sendAction throws, but broadcast returns nonce_consumed as a non-error. A second orphan after an unpause, a replaced or consumed agent nonce, or a stale nonce while halted each leave a signed row and no pause.

### Description

After an orphan Spent (T29: the agent key used outside the backend), reconcile halts the worker and queues Treasury.pause(). The halt stops only the worker. The pause is the only automatic on-chain containment: _requireSpendingAgent reverts Paused for spend and, through the requireSpendingAgent hook, for fundMilestone.

watchOrphans inserts the pause request under one fixed id, 'reconcile:orphan-pause' (PK facility_id,id; ON CONFLICT DO NOTHING). sendQueuedPause returns as soon as that row holds a raw signed tx, and it never reads Treasury.paused(). It signs with the agent key first, which is the key the orphan marks as misused, and tries the lender only when sendAction throws. broadcast reports 'nonce too low' as nonce_consumed instead of throwing, so treasury_pause_sent is still logged and the lender is skipped. Recovery then reports the row as 'unresolved' on every pass (UNRESOLVED_ROW, alert only) and never re-signs it.

Three cases are reachable from source:
(A) A later orphan after an unpause. The agent is set only at the first plan commit, and TIGHTEN_REVOKE_AGENT is permanent. Keeping the agent in service after any orphan, even one judged benign, therefore means a LOOSEN_UNPAUSE plus an ops resume without revocation. The first pause row stays FINALIZED with its raw tx. A later orphan raises a new halt, but the insert is a no-op, the trace still says 'treasury pause queued', and sendQueuedPause returns at once.
(B) A contested nonce. The holder of the agent key replaces the broadcast pause with a higher-fee tx at the same nonce, or gets a tx mined at that nonce before the pause is broadcast. The row stays signed and unresolved, and neither a retry nor the lender fallback happens. A 'replacement transaction underpriced' reply at broadcast does throw and does reach the lender; only the replaced-after-broadcast and nonce_consumed paths are abandoned.
(C) A stale DB nonce while halted. While any halt is active, reconcileNonces skips reconcileNonce and its advanceNonce, and the allocator hands out the stored next_nonce. Suppose a halt is already active when the orphan is sent (for example an operator's ops halt; raiseHalt coalesces the ORPHAN_SPEND into it), and the worker has signed with the agent before. The first pause attempt is then signed at the nonce the orphan consumed, and it is abandoned on the first try. The same happens when the first attempt is deferred on both keys (FeeCapExceededError) and the key is used again before the next attempt.

In each case the agent key keeps passing _requireSpendingAgent until a human pauses or revokes it. It can spend within line, per-tx and window caps to bound payees. It can also call fundMilestone up to each milestone's schedule; an autoRelease milestone releases on full funding. The halted worker never pays out orphan spends, because they have no payment row. The effect is therefore on-chain budget and escrow movement within those bounds, while the worker logs treasury_pause_sent.

Fix: drive the pause from on-chain state. While an ORPHAN_SPEND is open and Treasury.paused() reads false at latest, create a fresh attempt on each pass, keyed per orphan (the id includes spendId) or per attempt. Sign with the lender (or owner) key first and use the agent only as a fallback. Treat nonce_consumed, unresolved and reverted as failures that move on to the next key. Before signing the pause, raise the signer's next_nonce to the chain pending count; this is a DB-only step and is safe while halted.

Regression tests, each expecting paused()==true:
(1) two orphans separated by an UNPAUSE loosening and an ops resume;
(2) an agent tx that replaces the pause at its nonce;
(3) an orphan sent while an operator halt is active, after the worker has already signed with the agent.

### Source trace

1. **entrypoint** `contracts/src/Treasury.sol:134` — `Treasury.spend`: The holder of the misused agent key (T29) calls spend directly, outside the backend. _requireSpendingAgent (:143) passes while the treasury is unpaused, and Spent is emitted (:153).
2. **propagation** `apps/worker/src/jobs/reconcile.ts:144` — `runReconcile`: Each reconcile pass first runs reconcileNonces, which skips advanceNonce while any halt is active, and then calls watchOrphans over finalized Treasury logs.
3. **propagation** `apps/worker/src/jobs/orphans.ts:119` — `watchOrphans`: An orphan Spent raises the ORPHAN_SPEND halt: a new halt after an earlier one was resumed, or one coalesced into an already active halt.
4. **propagation** `apps/worker/src/jobs/orphans.ts:121` — `watchOrphans`: The pause request is inserted under the fixed id 'reconcile:orphan-pause' with ON CONFLICT DO NOTHING, so a second orphan's insert for the same facility is a no-op.
5. **propagation** `apps/worker/src/jobs/reconcile.ts:155` — `runReconcile`: sendQueuedPause runs for facilityIds[0], and only if watchOrphans did not throw.
6. **propagation** `apps/worker/src/jobs/reconcile.ts:124` — `sendQueuedPause`: The agent key is tried first. signAndStore commits the raw tx at the DB next_nonce before broadcast. sendStored returns nonce_consumed without throwing, so :125 logs treasury_pause_sent and returns. The lender (:120) is tried only if sendAction throws.
7. **sink** `apps/worker/src/jobs/reconcile.ts:115` — `sendQueuedPause`: Every later pass returns here because raw_signed_tx is not null. Treasury.paused() is never read, no new attempt is created and the lender is never tried, so the treasury stays unpaused.

### Evidence

- `apps/worker/src/jobs/reconcile.ts:33`: ORPHAN_PAUSE_ACTION is a single constant id.
- `packages/db/drizzle/0000_initial_schema.sql:307`: The chain_actions primary key is (facility_id, id), so there is one agent pause row per facility forever.
- `packages/chain/src/sender.ts:131`: signAndStore returns the stored tx for an already-signed row and signs nothing new.
- `packages/chain/src/broadcast.ts:39`: A 'nonce too low' reply is returned as status nonce_consumed instead of being thrown.
- `packages/chain/src/sender.ts:200`: sendStored skips markBroadcast on nonce_consumed and returns the result without throwing, so sendAction succeeds and the lender fallback is not reached.
- `packages/chain/src/recovery.ts:146`: A chain action whose nonce was consumed by a different call is reported 'unresolved' and keeps its state. Recovery takes no signer and never re-signs it.
- `apps/worker/src/jobs/halt-rules.ts:48`: An unresolved recovery outcome is an UNRESOLVED_ROW alert only.
- `apps/worker/src/jobs/reconcile.ts:89`: While halted, reconcileNonce (and its advanceNonce for external key use) is skipped for every key; only inspectNonces runs.
- `packages/chain/src/nonces.ts:65`: The allocator hands out the stored next_nonce. The chain pending count is read only when the signer has no row yet (:66-71).
- `apps/worker/src/store/halt.ts:64`: raiseHalt coalesces a new reason into an already active halt, so an orphan during an operator halt does not change nonce handling.
- `packages/chain/src/fees.ts:65`: FeeCapExceededError is thrown before signing; both keys share MAX_FEE_GWEI, so a deferral hits agent and lender alike.
- `contracts/src/TreasuryState.sol:195`: The pause is what blocks the agent: _requireSpendingAgent reverts Paused.
- `contracts/src/TreasuryModuleHooks.sol:20`: fundMilestone goes through the same _requireSpendingAgent, so only the pause (or a revocation) stops it.
- `contracts/src/Treasury.sol:300`: The agent is set only at the first plan commit and cannot be rotated.
- `contracts/src/Treasury.sol:182`: TIGHTEN_REVOKE_AGENT is permanent (no loosening clears _agentRevoked). Keeping the agent after an orphan therefore requires an unpause, which makes case A reachable.
- `contracts/src/TreasuryLoosenRules.sol:133`: LOOSEN_UNPAUSE with target 0 sets _paused = false and reopens the treasury.
- `apps/worker/README.md:61`: Stated invariant: an orphan Spent halts the worker and also sends Treasury.pause().
- `apps/worker/test/live/reconcile.live.test.ts:144`: Only a single orphan with no prior halt and an uncontested agent pause is tested.

### Blockers

- The run-3 execution policy forbids target execution: no OS-enforced sandbox with memory, disk and file-size limits, and the promotion allowlist is empty. The Anvil + Postgres reconcile scenarios that would show Treasury.paused()==false after reconcile therefore cannot be observed.

### Bounded local validation

Run this only in an approved sandbox: no external network, an empty environment, a read-only target, scratch-only writes, and resource and wall-clock limits. Add cases to apps/worker/test/live/reconcile.live.test.ts on Anvil + Postgres, reusing newWorld, finalizeAll and runOps. In each case, first let the worker sign one agent tx so the agent has a nonces row: one runTick pacing spend, then finalizeAll and runReconcile.

(C) Run runOps(['halt','--reason','ops'], ...). Send a spend from w.signers.agent through a wallet client, as at :146-157. Then run finalizeAll and runReconcile twice. Expect: chain_actions reconcile:orphan-pause holds a raw tx whose nonce equals the orphan tx's nonce; no reconcile:orphan-pause:lender row exists; the second pass shows a recovery outcome 'unresolved' for that row; and paused()==false.

(A) With no halt, send an orphan spend, then run finalizeAll and runReconcile and mine one block. Expect paused()==true, as in the existing case. Queue and execute a LOOSEN_UNPAUSE (target 0) with founder and lender signatures, advancing Anvil time past the timelock, then run ops resume. Send a second orphan spend, then run finalizeAll and runReconcile twice. Expect a new ORPHAN_SPEND halt, only the original reconcile:orphan-pause row, and paused()==false.

(B) With no halt, send an orphan spend, mine it, run finalizeAll, then turn Anvil automine off. Run runReconcile so it signs and broadcasts the agent pause. Before mining, send a 0-value tx from the agent at the same nonce with maxFeePerGas and maxPriorityFeePerGas at least 10% higher. Then mine, run finalizeAll and run runReconcile twice. Expect a recovery outcome 'unresolved' for chain_actions/reconcile:orphan-pause, no lender pause row, and paused()==false.

### Owner-observed deployment check

Owner-observed and read-only, on the final-1 test deployment. Search the worker logs for treasury_pause_sent followed by a reconcile_alert UNRESOLVED_ROW for chain_actions/reconcile:orphan-pause, and for halt_already_active with reason ORPHAN_SPEND. Then compare that row's nonce, signer and tx_hash with the agent's mined transaction at that nonce and with Treasury.paused() at latest. Whether a replacement (case B) is accepted depends on the node's txpool policy. Do not induce an orphan or send any transaction on a shared deployment.

## 3. settle-spend pays out, and has the oracle confirm or fail settlements, using mutable payments-row fields that are never bound to the on-chain spend

- **Fingerprint:** `apps/worker/src/jobs/settle.ts:facts:payout-not-bound-to-onchain-spend-intent`
- **Verifier:** `v-3` (independent, source-only)

### Claimed root cause

settle.ts and settle-decide.ts treat the DB payments row as the authority for whether a settlement exists and for its amount, payee, line, idempotency inputs and payout status. They never bind the row to the chain-attested spend: no intentId recompute from the committed planId, no isIntentUsed check, no Spent log. They also never bind the fail and retry decisions to the rail's actual payout state.

### Description

runSettle is the settle-spend cron job (settle.ts:202, registered under the shared job lock at runtime/app.ts:87). It takes every payments row with kind SPEND in state FINALIZED or SETTLEMENT_REQUESTED (settle.ts:69-80). It reads the chain only twice. (1) Treasury.settlementState(r.intent_id) at the finalized block (settle.ts:91) returns 0 both for an open spend and for an id that was never spent (TreasuryStorage.sol:109-110), and settle.ts:102 maps 0 to NONE. (2) payeeBinding is read for the row's own line_id/payee_id (settle.ts:92, 106). The amount, payee, line, invoice_hash, plan_version, payout_attempt and payout_status all come from the DB row. Nothing recomputes intentId from the committed planId, nothing calls isIntentUsed, and nothing reads the finalized Spent log that spec section 9.1 names as the trigger (project.md:482). The tick signing path is different: it only resumes a row whose intent equals a freshly computed proposal intent (decide.ts:48), and it recomputes the intent from the calldata (payment-call.ts:54). Source shows that a principal who can write public.payments, but holds no key, can do four things. (a) Insert a FINALIZED SPEND row with a made-up intent_id and any positive amount. The schema requires dummy values in the signed-tx columns, and the line/payee must be bound on-chain with a matching payees.payout_account_hash. A payout of that amount is requested. The later confirm fails gas estimation with SettlementClosed (Treasury.sol:428, sender.ts:143), so nothing is signed, and the row reports 'error' on every pass with no halt. (b) Change amount_minor, or change payee_id/line_id to another bound payee, on a real finalized spend before its payout. The rail is asked for the tampered payout, and confirmSettlement then closes the real spend as CONFIRMED. (c) Set payout_status=FAILED with a non-retryable code. This works after a SUCCEEDED payout but before the next pass confirms it, and also before any payout. decideSettlement returns fail without re-reading the rail (settle-decide.ts:53-56). The oracle's failSettlement then returns the amount to the line pocket, the global spent total and the payee's paidMinor (Treasury.sol:255-263), so the agent can spend it again while the payout stands. The contract only guarantees that the same invoice is not paid twice. (d) After a SUCCEEDED payout, change payout_attempt, invoice_hash or plan_version. The simplest way is payout_status=FAILED with TEMPORARY_TRANSFER_ERROR, which retries with attempt+1. Any of these changes the idempotency key (rail.ts:42-44), and MockRail dedupes on the key alone (mock-rail.ts:50-59), so a second payout is requested for the same spend. Controls that hold: the halt check before every value-moving step (settle.ts:187); the one-shot chain_actions ids, so each of confirm and fail is sent at most once; and the destination check against the on-chain binding, which binds only the row's own line/payee. Calibration: the spec labels DB values trusted (project.md:316). The T1 live test uses a DB update of payees only to simulate a changed destination; spec T1 itself is a social-engineering email. The architecture still lists 'DB row -> signed spend/payout' as a trust boundary. Today the payout leg is MockRail, whose rows in hogee_worker.mock_payouts any DB writer could insert directly. The only on-chain effect today is the oracle's confirm/fail attestation, and above all a failSettlement that returns budget units. Real-money impact needs XenditRail and a DB writer other than the worker; neither is in this diff. Fix direction: drive settlement from finalized Spent logs, or recompute intentId(planId, line, payee, invoice, amount) from the row and require it to equal intent_id with isIntentUsed true at finalized. Re-read the rail (by payout id and by earlier attempts' keys) before failSettlement or a new attempt. Halt on any mismatch.

### Source trace

1. **entrypoint** `apps/worker/src/jobs/settle.ts:202` — `runSettle`: The settle-spend cron sweep over the deployment's facilities, run under the shared job lock (runtime/app.ts:87). The lower-trust input is the content of public.payments, which any holder of the DB credentials can write.
2. **propagation** `apps/worker/src/jobs/settle.ts:77` — `loadRows`: Selects any SPEND row in FINALIZED/SETTLEMENT_REQUESTED. intent_id, line_id, payee_id, amount_minor, invoice_hash, plan_version and payout_status/attempt/id/failure_code all come from the row.
3. **propagation** `apps/worker/src/jobs/settle.ts:91` — `facts`: The only existence/state read is Treasury.settlementState(r.intent_id) at finalized. No intentId recompute, no isIntentUsed and no Spent log.
4. **propagation** `contracts/src/TreasuryStorage.sol:110` — `settlementState`: Returns _settlements[id].state, which is 0 (SETTLEMENT_NONE) for an unknown id as well as for an open spend. settle.ts:102 maps 0 to 'NONE'.
5. **propagation** `apps/worker/src/jobs/settle.ts:106` — `facts`: destinationOk compares the on-chain binding of the row's own line_id/payee_id with the stored payees.payout_account_hash. It does not bind the row to the spend's line, payee or amount.
6. **propagation** `apps/worker/src/jobs/settle-decide.ts:51` — `decideSettlement`: [second path] payout_status SUCCEEDED, read from the row, leads to confirm. settle.ts:165 has the oracle sign confirmSettlement(r.intent_id, keccak(payout_id)), which closes a real spend as CONFIRMED whatever amount or payee was paid.
7. **propagation** `apps/worker/src/jobs/settle-decide.ts:56` — `decideSettlement`: [second path] payout_status FAILED with a non-retryable code, read from the row, leads to fail without re-reading the rail. settle.ts:170 has the oracle sign failSettlement(r.intent_id), and Treasury.sol:261-263 returns the amount to the line pocket and the payee's paidMinor.
8. **propagation** `apps/worker/src/jobs/settle-decide.ts:60` — `decideSettlement`: chainState NONE plus destinationOk, with status NONE (or FAILED and retryable), leads to request_payout with attempt = payout_attempt + 1.
9. **propagation** `apps/worker/src/jobs/settle.ts:139` — `requestPayout`: The idempotency key is built from the row's invoice_hash, plan_version and attempt plus intent_id. Changing any of them gives a new key, and so a new payout for the same spend.
10. **sink** `apps/worker/src/jobs/settle.ts:138` — `requestPayout`: rail.requestPayout is called with amountMinor = BigInt(r.amount_minor) (line 141) to the payee's xendit_account_ref (line 143), all taken from DB rows. Today this is MockRail; with XenditRail it would be a real payout.

### Evidence

- `contracts/src/Treasury.sol:148`: spendId = intentId(_planId, lineId, payeeId, invoiceHash, amountMinor): the spend is fully determined by fields the worker could recompute from the row and the committed planId.
- `packages/chain/src/hashes.ts:79`: The intentId helper exists in @hogee/chain. settle never uses it.
- `packages/chain/src/payment-call.ts:54`: The signing path recomputes the intent from the calldata and the committed planId. Payout and attestation have no equivalent.
- `apps/worker/src/jobs/decide.ts:48`: The tick resumes only an unsigned row whose intent equals the freshly computed policy proposal, so a tampered row is not signed. The settle path has no comparable binding.
- `contracts/src/TreasuryStorage.sol:44`: isIntentUsed(id) distinguishes an unknown id (kind 0) from an open settlement. settle does not call it.
- `contracts/src/Treasury.sol:428`: _openSettlement reverts SettlementClosed when kind == 0, so confirm or fail for a fabricated intent_id cannot succeed on-chain.
- `packages/chain/src/sender.ts:143`: estimateGas runs before signing. A confirm for a fabricated id throws here, so the row reports 'error' on every pass and no halt is raised.
- `contracts/src/Treasury.sol:255`: failSettlement reduces the line's spentMinor, the global _spentMinor and the binding's paidMinor. The comment at lines 251-254 only rules out a second payment of the same invoice after a mis-reported failure.
- `apps/worker/src/rail/rail.ts:43`: The idempotency key is keccak256(invoiceHash, planVersion, attempt, settlementId). planVersion and attempt are not part of the on-chain intent.
- `apps/worker/src/rail/mock-rail.ts:53`: MockRail dedupes on the idempotency key only, and on conflict returns the stored payout without comparing amount or destination.
- `project.md:482`: The spec drives the settlement adapter from Spent and MilestoneReleased events at finalized, not from DB rows.
- `project.md:316`: Calibration: the spec's taint model labels values from our DB as trusted. Whether a lower-trust DB writer exists is therefore a deployment fact.
- `project.md:1012`: Going live plans a managed Postgres (Neon/Supabase), which widens who may hold write credentials to public.payments.
- `apps/worker/src/ops/cli.ts:2`: The ops CLI runs with DATABASE_URL, reads no key, and its intended authority is status/halt/resume only. Nothing in source restricts that DB role to the halts table.
- `apps/worker/test/live/settle.live.test.ts:117`: The T1 live test simulates a changed destination with a direct DB update of payees. No test covers a tampered or fabricated payments row.

### Blockers

- Run-3 policy forbids target execution (no sandbox that enforces resource limits, no promotion code). The payout and attestation outcomes for a tampered or fabricated payments row were therefore not observed in a local Postgres + Anvil fixture.
- Whether any principal other than the worker process can INSERT or UPDATE public.payments in a deployment is not visible in source. Today only the worker and the ops CLI (halt/resume only, run on the worker host) connect, using one example DB user. The task-1.12 API and a managed Postgres are not in this diff, and the spec labels DB values trusted. This decides whether a lower-trust attacker exists at all.
- Real-money impact depends on XenditRail (task 1.12, not in this diff). Today the payout leg is a MockRail row in hogee_worker.mock_payouts that a DB writer could insert directly. The only on-chain effects today are the oracle's confirmSettlement and failSettlement transactions, chiefly a failSettlement that returns budget units to the line pocket.

### Bounded local validation

Extend apps/worker/test/live/settle.live.test.ts. Use the existing throwaway Postgres + Anvil harness and the newWorld/spendOnce helpers, with no external network. (1) After spendOnce, run update payments set amount_minor = amount_minor * 10 for that id, then run runSettle twice. Expect a hogee_worker.mock_payouts row with the tampered amount, and Treasury.settlementState(intent_id) = 1 (CONFIRMED). (2) Insert a FINALIZED SPEND row that copies a real row's line_id, line_key, payee_id, decision_id and rationale_hash, with a random intent_id, a random tx_hash, a dummy raw_signed_tx, a signer_address the worker does not use, nonce 0 and the deployment chain_id. Run runSettle twice. Expect a mock_payouts row although isIntentUsed(intent_id) = false; on the second pass expect step 'error', no signed chain_actions row and no active halt. (3) After spendOnce, run runSettle once (mock payout SUCCEEDED). Then set payout_status = 'FAILED' and payout_failure_code = 'INVALID_DESTINATION', and run runSettle. Expect step 'fail', one SettlementFailed log and Treasury.pocket(line).spentMinor back to 0, while the mock payout row stays SUCCEEDED. (4) After a SUCCEEDED mock payout, set payout_status = 'FAILED' and payout_failure_code = 'TEMPORARY_TRANSFER_ERROR' (attempt < PAYOUT_MAX_ATTEMPTS), and run runSettle. Expect two mock_payouts rows for the same intent. After a fix, every case must end with no payout and no oracle attestation for the tampered row, and with an active halt.

### Owner-observed deployment check

Owner-observed only, with no audit traffic. On each deployed Postgres (the always-on host, and any managed Postgres used when going live), list the roles and the table privileges on public.payments and public.payees, e.g. information_schema.role_table_grants. Record which roles other than the worker's hold INSERT or UPDATE. Confirm whether the ops-CLI DATABASE_URL uses the worker's own role and who holds it. Confirm whether the task-1.12 API will share that role. Confirm which PayoutRail the deployed worker is constructed with (an unset rail means MockRail).

## 4. The account the rail pays (payees.xendit_account_ref) is not bound to the founder-signed payoutAccountHash that the destination check compares

- **Fingerprint:** `apps/worker/src/jobs/settle.ts:facts:rail-destination-not-bound-to-payout-account-hash`
- **Verifier:** `v-4` (independent, source-only)

### Claimed root cause

facts() compares the stored payees.payout_account_hash column with Treasury.payeeBinding(line, payee).payoutAccountHash (settle.ts:106) instead of deriving the hash from the account the rail actually pays. requestPayout sends payees.xendit_account_ref as the destination (settle.ts:143). The payees row keeps that paid reference and the attested hash as two unrelated columns (0000_initial_schema.sql:231-232), with no constraint, trigger, RLS or recomputation linking them. The structured {channel, accountNumber, holderName} needed to recompute the hash is not stored at all.

### Description

The T1 settlement control is meant to pay only the bank destination the founder signed. That destination is payoutAccountHash = keccak256(JCS({channel, accountNumber, holderName})), stored in Treasury.payeeBinding (project.md:442; schema comment at suppliers.ts:144). settle-spend reads two columns from the same payees row. destinationOk compares payees.payout_account_hash with the on-chain binding hash. The rail is paid payees.xendit_account_ref, a separate free-text column that is never hashed or compared; it only has to be non-null (settle.ts:106, 143). So a principal who can UPDATE payees can change xendit_account_ref alone, leave payout_account_hash as it is, and every later payout request for that payee goes to the new reference. The T1 live test models exactly this kind of DB writer, but it only tampers the hash. No DESTINATION_MISMATCH halt is raised. Once the rail reports SUCCEEDED, decideSettlement goes straight to confirm without checking the destination again (settle-decide.ts:51), and the ORACLE key calls confirmSettlement on-chain with payoutRefHash = keccak256(payout_id), which does not commit to the destination. The repo's own tests already change xendit_account_ref without touching the hash (settle.live.test.ts:89, :104) and expect the rail to be called with the new value. At commit 11cbb81, env.ts:110 refuses every rail except MockRail. The result reachable now is a mock payout recorded to the substituted destination plus a real on-chain SettlementConfirmed that falsely attests a payout to the bound payee. Redirecting real funds depends on XenditRail (task 1.12) paying xendit_account_ref; the code marks this gap as TODO(1.12).

### Source trace

1. **entrypoint** `apps/worker/src/jobs/settle.ts:202` — `runSettle`: The settle-spend sweep (the pg-boss handler at runtime/app.ts:87) processes each facility's DB rows. The lower-trust input is the public.payees row, which any DB writer can change.
2. **propagation** `apps/worker/src/jobs/settle.ts:73` — `loadRows`: Selects pa.payout_account_hash and pa.xendit_account_ref as two independent columns of the joined payees row.
3. **propagation** `apps/worker/src/jobs/settle.ts:106` — `facts`: destinationOk compares only the stored hash column with binding.payoutAccountHash. xendit_account_ref only has to be non-null and is never hashed or compared.
4. **propagation** `apps/worker/src/jobs/settle-decide.ts:58` — `decideSettlement`: The only destination gate. With destinationOk true it falls through to request_payout (line 60). Nothing else checks the reference.
5. **sink** `apps/worker/src/jobs/settle.ts:143` — `requestPayout`: rail.requestPayout is sent destination = r.xendit_account_ref, the value actually paid, which is not bound to the founder-signed hash.

### Evidence

- `project.md:442`: Spec: the founder signs payoutAccountHash over {channel, accountNumber, holderName}, and settlement refuses any other destination (T1).
- `packages/db/src/schema/suppliers.ts:144`: Schema doc: settlement must pay only to the account whose hash matches. The paid column xenditAccountRef (line 141) is plain text, separate from payoutAccountHash (line 147).
- `contracts/src/Treasury.sol:412`: _bind stores the signed SupplierApproval.payoutAccountHash in the on-chain PayeeBinding that facts() reads.
- `apps/worker/src/jobs/settle.ts:105`: TODO(1.12): recompute the hash from the registered {channel, accountNumber, holderName} the rail pays to. The code acknowledges the gap.
- `packages/db/drizzle/0000_initial_schema.sql:231`: xendit_account_ref is nullable text. payout_account_hash (line 232) has only a hex32 format check (line 241). The migration has no constraint, trigger, grant or RLS policy linking the two columns.
- `apps/worker/src/harness/rina.ts:116`: The seed writes xenditAccountRef = 'test-' + accountNumber and payoutAccountHash(account) (line 117) separately. They agree only because this one writer builds both from the same account.
- `apps/worker/test/live/settle.live.test.ts:89`: The existing test changes xendit_account_ref to 'test-121212' (and to 'test-123456' at line 104) without touching payout_account_hash. It expects request_payout to reach the rail with the substituted destination, not DESTINATION_MISMATCH. This is expected behaviour in source; it was not observed in this run.
- `apps/worker/test/live/settle.live.test.ts:117`: The T1 test models a payees writer, but tampers only payout_account_hash, which is caught. Changing xendit_account_ref alone is not tested as an attack.
- `apps/worker/src/jobs/settle-decide.ts:51`: After a SUCCEEDED payout the next step is confirm, which runs before the destination gate at line 58. The oracle attests settlement with no further destination check.
- `apps/worker/src/jobs/settle.ts:164`: confirmSettlement's payoutRefHash = keccak256(payout_id). The on-chain record does not commit to the destination paid.
- `apps/worker/src/config/env.ts:110`: At this commit PAYOUT_RAIL must be 'mock' (MockRail wired at runtime/app.ts:66). Real-funds redirection depends on XenditRail, which is not in this diff.
- `apps/worker/src/rail/rail.ts:17`: PayoutRequest.destination is documented as the payee's registered test account reference ('never free text'). The value supplied is an unverified free-text DB column.

### Blockers

- Run-3 execution policy forbids running target code: macOS cannot enforce the required resource limits and no reviewed promotion code exists. The substituted-destination mock payout and the resulting on-chain SettlementConfirmed have not been observed.
- Impact on real funds depends on components absent from commit 11cbb81. XenditRail and the production writer of payees.xendit_account_ref (supplier onboarding, task 1.12) are not present, and env.ts:110 refuses every rail except mock. Which deployed Postgres roles other than the worker can UPDATE public.payees is a deployment fact: the migration defines no grants or RLS.

### Bounded local validation

Use the settle.live.test.ts harness (Anvil + a throwaway TEST Postgres + MockRail; no external network). (1) w = newWorld(live); id = spendOnce(w). (2) Run update payees set xendit_account_ref = 'test-999999' where facility_id = w.facilityId and id = 'shopee-ads'. Leave payout_account_hash unchanged; 'test-999999' matches no staged failure suffix. (3) Run runSettle(w.deps(), [w.facilityId]) once. Expect step 'request_payout' with detail 'SUCCEEDED', activeHalt = null, and exactly one hogee_worker.mock_payouts row whose reference_id starts with the payment's tx_hash and whose destination = 'test-999999'. (4) Run runSettle again. Expect step 'confirm'. Then live.test.mine(1), finalize(w), and runSettle. Expect step 'close' with detail 'SETTLED' and one SettlementConfirmed log. Control run: skip step 2 and expect destination 'test-1000000001'. After the fix (the destination derived from stored {channel, accountNumber, holderName} whose payoutAccountHash must equal the binding), step 3 must return 'blocked' DESTINATION_MISMATCH, raise a halt, and create zero mock_payouts rows.

### Owner-observed deployment check

Owner-observed only, never audit traffic. In each deployed database, list the roles holding UPDATE on public.payees, for example from information_schema.role_table_grants where table_name = 'payees'. Confirm whether any role other than the worker and the onboarding service holds it. When task 1.12 lands, confirm from the XenditRail and onboarding source that the payout channel and account sent to Xendit are derived from the same {channel, accountNumber, holderName} whose payoutAccountHash is compared against Treasury.payeeBinding, and that xendit_account_ref cannot change independently of that hash.

## 5. releaseMilestone pays a re-bound supplier inside its restarted cooling (veto) window

- **Fingerprint:** `contracts/src/MilestoneEscrow.sol:releaseMilestone:payee-cooling-skipped-after-rebind`
- **Verifier:** `v-5` (independent, source-only)

### Claimed root cause

Payee cooling is enforced in each payment path's own pre-checks (spend and ownerSpend through _requirePayeeReady, fundMilestone through checkEscrowLine) instead of at the shared escrowRelease sink. As a result releaseMilestone, whose documented exemptions are only pause, line pauses, circuits and line validity, also skips cooling. On top of that, the payout destination is stored once per (line, payee) binding instead of per signed order or settlement. A re-bind therefore silently changes the destination of earlier orders' already-escrowed milestones.

### Description

A founder-signed SupplierApproval can re-bind a supplier payee that is already bound on its escrow line. bindPayee checks the envelope, the founder signature, the schedule, the platform-payee rule, that the line is active and escrowOnly, and that the orderId is unused (Treasury.sol:111-122). Nothing requires the payee to be unbound or the destination unchanged. _bind then restarts coolingUntil and overwrites the single per-(line, payee) payoutAccountHash (Treasury.sol:407-412). The test comment at TreasuryAdmin.t.sol:132 calls this T3: 'a destination change is vetoable again'. A supplier payee sits on an escrowOnly line, and ownerSpend reverts EscrowOnly there, so only the escrow paths can pay it. fundMilestone, including its autoRelease release, enforces cooling through checkEscrowLine (TreasuryModuleHooks.sol:31; H6). releaseMilestone does not. It checks the agent caller, the escrow-domain founder envelope, order and milestone state, the amount and the evidence (MilestoneEscrow.sol:97-105). escrowRelease then checks only the settlement id and the lifetime cap (TreasuryModuleHooks.sol:51-53), and the re-bind has just raised that cap. So a non-auto milestone of an earlier order, fully funded before the re-bind (for example ORDER_A idx 2, 280,000), can be released at once: paidMinor rises and a MILESTONE settlement for (line, payee) opens while now < coolingUntil. None of the signed MilestoneRelease (IHogee.sol:97-105), EscrowOrder or SettlementRecord carries a destination. The only destination in contract storage is therefore the re-bound hash, and the documented settlement adapter checks payouts against the binding (IHogee.sol:82, :194). The earlier order's signed hash survives only in its PayeeBound event log. In the T3 payee-swap scenario, a phished founder approves new bank details. The founder's routine inspection release of the earlier order is then settled against the unvetted destination, inside the window meant for vetoing it. There is no on-chain unbind. The only on-chain correction is another founder-signed re-bind, and by design pause does not stop releaseMilestone (require-table-final1.md:243; MilestoneRelease.t.sol:42). Cooling is therefore the only time-based guard, and this path skips it. The actual payout is off-chain, and milestone settlements are not yet wired in the worker (settle.ts:77). Whether funds really reach the new account is therefore unobserved. Smallest fix: in escrowRelease, which the autoRelease and releaseMilestone paths share, revert PayeeCooling while now < binding.coolingUntil. A more complete fix snapshots the order's signed payoutAccountHash at openOrder and has release or settlement use it, or require it to equal the binding at release.

### Source trace

1. **entrypoint** `contracts/src/Treasury.sol:105` — `Treasury.bindPayee`: Anyone (a relayer) submits a founder-signed SupplierApproval for an already-bound supplier payee on its escrowOnly line, with a new orderId and a new payoutAccountHash. Lines 111-122 require only a fresh nonce, a valid founder signature, a matching schedule, a non-platform payee, an active escrowOnly line and an unused orderId.
2. **propagation** `contracts/src/Treasury.sol:410` — `Treasury._bind`: The re-bind sets coolingUntil = now + coolingSeconds (line 407), raises lifetimeCapMinor by the new schedule total (line 411) and, at line 412, overwrites the payee's single payoutAccountHash with the new destination.
3. **propagation** `contracts/src/MilestoneEscrow.sol:94` — `MilestoneEscrow.releaseMilestone`: [second path] A relayer submits the founder's escrow-domain MilestoneRelease for an earlier order's non-auto milestone that was fully funded before the re-bind. The signed struct covers orderId, idx, amount, evidence and the envelope, not a destination.
4. **propagation** `contracts/src/MilestoneEscrow.sol:103` — `MilestoneEscrow.releaseMilestone`: Lines 103-105 check only milestone state (non-auto, not released, fully funded), the exact amount and the evidence hash. No binding or coolingUntil is read before _release at line 106.
5. **propagation** `contracts/src/MilestoneEscrow.sol:174` — `MilestoneEscrow._release`: Marks the milestone released and calls Treasury.escrowRelease with the order's lineId and payeeId and the full milestone amount.
6. **sink** `contracts/src/TreasuryModuleHooks.sol:57` — `TreasuryModuleHooks.escrowRelease`: After checking only the settlement id and the lifetime cap (lines 51-53), it raises the payee's paidMinor (line 54) and opens a MILESTONE settlement for (lineId, payeeId) while now < coolingUntil. The record carries no destination, so the destination of record is the binding's current, re-bound hash.

### Evidence

- `contracts/src/TreasuryModuleHooks.sol:31`: checkEscrowLine reverts PayeeCooling. Its only caller is fundMilestone (MilestoneEscrow.sol:74), which calls it before an autoRelease release (MilestoneEscrow.sol:86).
- `contracts/src/TreasuryState.sol:267`: _requirePayeeReady enforces PayeeCooling for spend (Treasury.sol:147) and ownerSpend (TreasuryGovernance.sol:62). ownerSpend rejects escrowOnly lines (TreasuryGovernance.sol:60), so a supplier payee is paid only through the escrow paths.
- `contracts/src/TreasuryModuleHooks.sol:49`: escrowRelease, the release sink shared by autoRelease and releaseMilestone, never reads coolingUntil.
- `contracts/src/interfaces/IHogee.sol:97`: The MilestoneRelease the founder signs contains orderId, idx, amountMinor, evidenceHash and the envelope, but no payoutAccountHash, so a release does not bind a destination.
- `contracts/src/interfaces/IHogee.sol:207`: EscrowOrder stores payeeId, lineId, totalMinor, milestoneCount, inspectionRequired and exists, but not the payoutAccountHash its SupplierApproval signed.
- `contracts/src/TreasuryState.sol:38`: SettlementRecord holds lineId, payeeId, amountMinor, kind and state, so a milestone settlement carries no destination snapshot.
- `contracts/src/interfaces/IHogee.sol:370`: H6 NatSpec on fundMilestone says PayeeCooling applies, autoRelease milestones included, so that a freshly bound supplier cannot be paid inside the veto window.
- `contracts/src/interfaces/IHogee.sol:82`: The founder signs the bank destination, and the settlement adapter must check it before every payout. The binding's payoutAccountHash is the destination it checks (IHogee.sol:194). After a re-bind, the earlier order's signed hash survives only in its PayeeBound event log (IHogeeBase.sol:74), not in contract storage.
- `contracts/test/TreasuryAdmin.t.sol:132`: Test comment for a re-bind with a new payoutAccountHash: 'T3: a destination change is vetoable again'. The re-bind restarts cooling and overwrites the hash.
- `contracts/test/MilestoneRelease.t.sol:60`: The only re-bind release test keeps the original hash and warps past COOLING before funding the new order. No test releases an earlier order's milestone during a restarted cooling period.
- `contracts/test/MilestoneRelease.t.sol:42`: releaseMilestone works while the treasury is paused, so pausing is not an in-window veto against this path.
- `docs/assurance/require-table-final1.md:243`: Release is documented as not blocked by pause, line pauses, circuits or line validity, because the BU are already escrowed. Cooling is not listed as an intended exemption.
- `docs/Hogee-Project-Brief.md:584`: T3 pass criterion: a legitimate payee change is vetoed during the cooling period; the change is cancelled and no funds move.
- `apps/worker/src/jobs/settle.ts:92`: The existing settlement job reads payeeBinding at latest, and its destination check compares that binding with the DB payee hash (line 106). Only kind SPEND rows are settled (line 77), so the milestone payout path is not implemented.
- `packages/core/src/policy/governance.ts:77`: The TS mirror evaluateReleaseMilestone has no cooling check either, so the off-chain policy layer does not compensate.

### Blockers

- This run forbids target execution (no forge), so the decisive on-chain regression has not been observed. The regression: after a re-bind with a new payoutAccountHash, releaseMilestone of an earlier order's fully funded non-auto milestone succeeds while payeeBinding.coolingUntil > block.timestamp.
- The actual payout is off-chain, and milestone settlements are not wired: the worker settles only kind = 'SPEND' rows (apps/worker/src/jobs/settle.ts:77). Source cannot show whether a future milestone settlement job would pay the binding's current (re-bound) destination during cooling, use the order's signed hash from its PayeeBound event, or hold the payout until coolingUntil. That choice decides whether funds actually move to the unvetted account.

### Bounded local validation

Add test_ReleaseMilestone_EarlierOrderDuringRebindCooling to contracts/test/MilestoneRelease.t.sol. Its setUp already runs _setUpSupplierA, which binds ORDER_A and warps past COOLING. Steps: (1) _fundBalanceA(), which funds idx 0 and 1, releases stage 2 and funds idx 2 with 280,000. (2) SupplierApproval memory a = _supplier(); (a.orderId, a.nonce) = ('order-a-002', 78); a.payoutAccountHash = keccak256('new bank account'); _bindSupplier(a). (3) Without vm.warp: MilestoneRelease memory r = _release2(); escrow.releaseMilestone(r, _signRelease(founderPk, r)). Today, expect success, then assert: treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).coolingUntil > block.timestamp; its payoutAccountHash == keccak256('new bank account'); its paidMinor == 430_000; treasury.settlementState(SID_BALANCE) == HogeeKinds.SETTLEMENT_NONE. After the fix, expect vm.expectRevert(IHogeeErrors.PayeeCooling.selector), and success after vm.warp(block.timestamp + COOLING). Run only forge test --match-test test_ReleaseMilestone_EarlierOrderDuringRebindCooling, inside an OS-enforced sandbox: no network, empty environment, read-only source copy, scratch-only writes, and CPU, memory and wall-clock limits.

### Owner-observed deployment check

Owner-observed, not audit traffic. The owner confirms from the task 1.12 milestone-settlement design or code which payout account a MILESTONE settlement pays: the binding's payoutAccountHash and payee row at payout time, or the hash signed by the order's SupplierApproval (its PayeeBound event for that orderId). The owner also confirms whether any off-chain hold blocks a milestone payout while payeeBinding.coolingUntil > now. If the job pays the current binding with no cooling hold, the on-chain gap moves real funds to an unvetted destination.
