# Hogee run-6 fixes: post-fix skills re-check

Target: `<repo>`, `p1/dev` at `e8d95fe`. I reviewed the source from a `git archive` copy, so nothing was run in the checkout. Scope: `dea4454..e8d95fe` (the merge `6591913` plus `1264bbd^1..e8d95fe`) on the listed paths, with callers and contracts read where a fix depends on them.
Skills applied: security-review (and its cloud-infrastructure-security.md), nodejs-keccak256, and llm-trading-agent-security (evidence integrity, decision records and replay only).
Paths below are relative to the repo root.

## HIGH

### H1. The new replay fails every honest OwnerSpent on a paused or circuit-open line (regression from v-5, 8762dd7)
- `tools/verify-evidence/src/replay.ts:222-231`: `onOwnerSpent` calls `outflowLine`.
- `replay.ts:201`: `outflowLine` runs `lineChecks`.
- `replay.ts:132-133`: `lineChecks` adds "the line's circuit is open" and "the line is paused".
- The contract does not check either. `contracts/src/TreasuryGovernance.sol:48-62` (`ownerSpend`) says "no pause of any kind (§8.8)" and checks only active/validUntil, escrowOnly, payee, intent, invoice and amount.
- Core policy agrees with the contract. `packages/core/src/policy/owner-spend.ts:40-56` has no pause or circuit check, so the product does sign and relay these.
- The old `onOwnerSpent` (dea4454) did not check pause or circuit. The v-5 refactor added it.

Scenario: three anchored denials trip LOGISTICS (`CircuitTripped`), or the agent tightens with `PAUSE_LINE`. The founder then pays the invoice through the manual fallback (OwnerSpend, which mines `OwnerSpent`). After that, every bundle fails "event replay" with "OwnerSpent …: the line's circuit is open". `make verify` prints NOT VERIFIED, and the exporter's self-check logs `verified:false`. The manual fallback exists for exactly this situation.

Smallest fix: pass a flag to `lineChecks` so that OwnerSpent checks only version/active and validUntil, plus escrowOnly, which `outflowLine` already checks. Skip `circuitOpen` and `paused`. Add a fixture case: circuit trips, then OwnerSpent, then the bundle must still verify.

## MEDIUM

### M1. The finality refusal blocks the local demo export, and the POST caller never sees why
- `packages/api/src/evidence/fetch.ts:151-156` refuses any receipt above `finalized`. This runs inside `build()`, in the background (`packages/api/src/evidence/export.ts:256-273`), after `POST /api/evidence/export` has already returned `{runId}` (`packages/api/src/routes/evidence.ts:43-44`). The route therefore never receives an `EvidenceChainError`, which e8d95fe claims to surface. The reason lands only in `evidence_runs.error`, and no route reads `evidence_runs` (grep finds no reader; `listRuns` reads the disk). The run never appears and `GET /api/evidence/:runId` answers 404. The FAILED row also arms `tooSoon`, so the founder's retry gets "exported less than 60 s ago".
- Local dev-live / Anvil: `scripts/dev-live/src/main.ts:95` starts Anvil with automine and no `--block-time`, and Anvil's `finalized` is latest − 64 (`apps/worker/src/harness/loop.ts:33`). Nothing in dev-live mines blocks, so after the last demo transaction every export stays refused until 64 more transactions are mined. In practice the export is stuck.
- Sepolia: the export is refused for about 13-19 minutes after any facility transaction.
- Each refused attempt first re-reads every receipt (`fetch.ts:141-150`) and only then reads the head.

Smallest fix:
1. Read `finalized` first and refuse before fetching receipts.
2. Run the readiness check (in-flight rows, and the newest row `block` vs `finalized`) synchronously before claiming the run, so the 409 carries the reason.
3. Start dev-live Anvil with `--block-time 1 --slots-in-an-epoch 1`.

### M2. The signature-request cap lets an anonymous caller lock the founder out of signing, and can lock out an honest founder on idle Anvil
- `packages/api/src/services/signing/request-bounds.ts:46-50`.
- `packages/api/src/routes/signatures.ts:134-138`: the cap counts PENDING **and** REJECTED.
- `signatures.ts:127-133`: only PENDING requests are reuse candidates.

Attack scenario: a caller without a cookie reads as founder. It repeats this cycle ten times, about 60 calls in all: request X, submit 5 bad signatures (X becomes REJECTED), request X again (a new row). Ten distinct drafts (draft creation is founder-persona) work too. Every new request from the real founder then gets CONFLICT "There are already 10 open signature requests" for 900 chain-seconds, and the caller can renew this indefinitely. Before the fix, nothing could block signing.

Honest scenario: `chainNow` is the latest block's timestamp (`packages/api/src/services/chain.ts:25-27`), and it does not move on an idle automine Anvil. A founder who opens the sign dialog on about five successive drafts, with both methods, fills the cap (each dialog open requests one, `apps/web/components/sign/sign-dialog.tsx:63-70`). The requests never expire until some transaction is mined.

The reuse path also hands the attacker's pre-made request, possibly with 4 refusals already burned, to the founder.

Smallest fix: the bound cannot be both effective and lockout-free while anonymous equals founder. Require the signed founder persona cookie on `requestSignature` and `submitSignature`. If that is not acceptable for the demo, at least supersede: a new request of kind K expires the facility's older PENDING and REJECTED requests of kind K (PlanApproval), or of the same kind and refId for the per-item kinds, instead of refusing at the cap.

### M3. A refusal row now anchors to a reverted recordDenied, so the honest bundle fails "evidence rows" (regression)
- `packages/api/src/evidence/rows.ts:164` takes the denial's `Treasury.recordDenied` action `txHash` whatever its state.
- Before, the anchor was `denials.recorded_tx`, which the worker's sync sets only for LANDED actions (`apps/worker/src/jobs/sync.ts:172-176`).
- `tools/verify-evidence/src/audit.ts:103-105` fails any non-onchain row whose `txHash` receipt is not `0x1`.

Scenario: a burst of off-plan proposals. The policy reads the circuit from chain state, and nothing counts in-flight denials, which is why the red-team T26 has to `pump()` between proposals (`scripts/redteam/src/cases/payments.ts:237`). Two proposals are evaluated before the 3rd recordDenied mines. The extra recordDenied reverts `CircuitOpen` (`contracts/src/Treasury.sol:224`). The bundle then has an agent_refusal row anchored to a reverted tx, and `make verify` prints NOT VERIFIED. This is the T26 demo run against a live worker without pumping.

Smallest fix: use the action's tx only when the action state is INCLUDED or FINALIZED, else `d.recordedTx`, else no anchor.

### M4. v-1 is closed for two writers, but the impact behind it is still reachable through sibling writers
- `packages/api/src/evidence/collect.ts:19,42-45`: the root cause is unchanged. A whole-history 50,000-row cap fails the export closed for good.
- `POST /api/exceptions` is founder-persona. For every timelock kind it only calls `assertLoosenAllowed` (`packages/api/src/services/exception-create.ts:30`), with no open or duplicate bound. Each call inserts an exception and appends a trace (`packages/api/src/routes/exceptions.ts:47-54`).
- `/api/chat` (traces and llm_calls) and the demo-mode `/api/proposals/spend` are the same.

So an anonymous caller still gets "traces has more than 50000 rows → every export 409 for good" in about 50k cheap calls, not the "~9 days" estimate in G0 §12 "Still open #1".

Smallest fix: the windowed or incremental collect that §12 names. Until then, at least correct the residual in §12 and bound open timelock exceptions per kind and target.

### M5. The anchor's explorer and verification links come from the bundle, so the step that turns VERIFIED into chain truth can be phished
- `tools/verify-evidence/src/bundle.ts:72,87`: `verifiedUrl` and `explorer` accept any http(s) URL.
- `tools/verify-evidence/src/anchor.ts:49-56` prints "Anchor (compare with <explorer>)" and every tx link from that base.
- `tools/verify-evidence/src/summary.ts:48,74` regenerates the same links, so SUMMARY.md byte equality holds.
- Rows' `explorerUrl` (`packages/api/src/evidence/rows.ts:118`) is never checked (`audit.ts`).

Scenario: a tampered bundle sets `explorer` to a lookalike of sepolia.etherscan.io. It still verifies, and the CLI tells the judge to "compare with" the forger's site, which confirms everything. v-6's whole answer to an unanchored bundle is this human comparison.

Smallest fix: pin the explorer by chain id in the verifier (11155111 → `https://sepolia.etherscan.io`, otherwise null) and fail on anything else. Require `verifiedUrl === ${explorer}/address/${address}#code` (or an allowlisted Sourcify pattern) and `explorerUrl === ${explorer}/tx/${txHash}`. Print links built from the pinned base, not from the bundle.

## LOW

**L1. The interval misses idempotent and refused calls.**
- `export.ts:244` checks only finished runs. A `created:false` call (`export.ts:250-253`) and refusals thrown in `prepare`/`collect` or `gitCommitOf` (`export.ts:249,254`) never write a finished row.
- So after 60 s, every anonymous POST re-runs the full collect (up to 8 × 50,001 rows), the JSON round trip and the JCS keccak under the lock. G0 §12 v-2(1) says "a call costs this one query".
- The interval also makes `make evidence` exit 1 within 60 s of any finished or failed run, which is acceptable.
- Fix: keep a per-facility last-attempt time, in process or as a DB upsert, checked before `takeLock`.

**L2. A scripted step that reverts with an attack-mapped error still becomes a passing attack row.**
- `rows.ts:131-136` (`actionRow` tries `ATTACK_OF` before `SUCCESS_OF`) and `rows.ts:146-153` (S4/S5).
- Examples: the lender's over-cap `Treasury.fund` reverts `CapExceeded`, and the row reads "T4 … pass" instead of "S1 fail". The founder's commitPlan relayed late reverts `SignatureExpired`, and the row reads "T16 … pass".
- The critic's lead is closed only for non-attack revert reasons.
- Fix: classify by provenance first: a SUCCESS_OF kind whose ref_id is not `redteam:*`, or which has the expected role or linked founder signature, gives an S row with expected success.

**L3. The `--rpc` URL can be printed.**
- `tools/verify-evidence/src/online.ts:52` accepts any `^https?://`.
- `fetch` throws a TypeError that contains the full URL for URLs with credentials ("Request cannot be constructed from a URL that includes credentials: <url>") or unparsable ones ("Failed to parse URL from <url>").
- `online.ts:97` prints `error.message.slice(0,160)` in the check detail and in `--json`. This contradicts "the URL is never printed".
- The Makefile passes the URL in argv (`--rpc "$(VERIFY_RPC)"`), so `ps` shows it.
- Fix: parse it with `new URL()` up front and refuse credentials or bad input with a fixed message. Never interpolate fetch error messages; use `error.name`. Read the URL from an environment variable, not argv.

**L4. The online mode proves less than G0 §14 claims.**
- `online.ts:75-80` checks only that each contract has code.
- If the forger deploys their own contracts on Sepolia, a "fabrication with fresh keys" passes `--rpc` fully. G0 §14 lists it as caught by `--rpc`.
- Fix: compare addresses and `keccak(eth_getCode)` with the committed deployment manifest, or correct the doc and CLI text.
- `receiptConsensus` does compare everything it claims.
- A malicious RPC can only pass what it is trusted to pass, and its error text reaches only the terminal (`online.ts:69`).

**L5. The event-source rules leave fields that replay consumes unbound.**
- `tools/verify-evidence/src/events.ts:72`: Funded binds `amountMinor` only, while replay uses `fundedTotalMinor` (`replay.ts:356`).
- `events.ts:87`: StageReleased (`releasedTotalMinor`, used at `replay.ts:359-360`).
- `events.ts:47`: PlanCommitted `releasedMinor` (`replay.ts:97`).
- `events.ts:66-69`: executeLoosen's PayeeBound, Unpaused and ReserveWithdrawn are not tied to the queued loosen's kind, target, aux and newValue.
- Unindexed data is outside the bloom. An offline tamperer can inflate `fundedTotalMinor` with only a rehash (no bloom recompute), hiding "outflow exceeds funded", or add `Unpaused(line)` to an executeLoosen receipt. `--rpc` catches this, and it is a documented residual class, but it is cheap to close.
- Fix: replay keeps running sums and requires each event total to equal the sum. Bind executeLoosen's side events to the LoosenQueued fields.

**L6. The founder-key lender check is skipped when FacilityOpened is absent.**
- `tools/verify-evidence/src/signatures.ts:31-32`.
- An offline bundle that drops the openFacility row and receipt can ship a self-signed `registerFounderKey` with a fresh key, which forges founder signatures (T27). `--rpc` catches it.
- Fix: fail closed. Require exactly one FacilityOpened whenever any signature is checked.

**L7. The temp tag identifies the deployment, not the database.**
- `packages/api/src/evidence/retention.ts:25,40-45`.
- Two databases against one deployment that share a root, for example a scratch DB on the same Anvil deployment, still sweep each other's live `.export-<tag>-*` folders, because "own tag" assumes our lock covers them.
- Fix: add the database identity to the tag, for example `system_identifier` or `current_database()` plus host.

**L8. Retention edge cases.**
- `retention.ts:84-91` deletes the `evidence_runs` row even when the folder was not removed. `ownsRun` can be false for our own run, for example when an index file is over 4 MB or the schema drifted. Such a folder is never listed or pruned again.
- Pruning also removes the force-added submission bundle (`.gitignore: evidence/*`, "git add -f") from the working tree after 10 newer READY runs, and anonymous traffic can force those in about 11 minutes. A later `git add -A` then stages its deletion.
- Fix: delete the row only when the folder is gone. Skip pinned runs, for example a `KEEP` marker or a configured list.

**L9. The dry-run assumes the bundle's event log is complete.**
- `replay.ts:333-338`.
- State changes made outside the backend are absent: an owner-EOA `pause()` from a wallet, an anyone-callable `executeLoosen`, or a T29 orphan using window or pocket. An honest agent spend that reverted because of one of them is reported as "a successful tx shown as reverted", and verification fails.
- G0 §14 names only out-of-gas.
- Fix: document this, or report the case as a note unless the bundle shows no external state change before it.

**L10. Two critic gaps are neither fixed nor listed as open.**
- `packages/api/src/evidence/store.ts:47,180` still buffers and copies up to 32 MB per file request, with no concurrency bound.
- `export.ts:263` still runs the synchronous `verifyBundle` on the API event loop. The 60 s interval now rate-bounds the second.

## Checked, no finding
- **Reuse race and key.** A per-facility `pg_advisory_xact_lock` covers the decision and the insert (`signatures.ts:85`). `contentKey` is a keccak JCS hash of a deterministic struct and panel (the panel builder is pure), with nonce, expiry and digest stripped. `prepare()` has no side effects. Refusal counting runs under `FOR UPDATE`, and REJECTED is terminal and counted. Five typos do not strand the founder: reopening the dialog creates a new request.
- **Officer lockout.** It is traced once per window, so traces are bounded at about 6 per 15 minutes.
- **Tenant binding.** Reads, listing and pruning compare facility, deployment and chain in both `contracts.json` and the manifest (`store.ts:96-97`).
- **Deletion safety.** Deletion uses lstat, rename-then-recheck, and `unlink` for a swapped link (`retention.ts:63-73`). The sweep skips symlinks, and `fs.rm` does not follow them. Prune runs under the export lock. A concurrent reader either finishes on its open fd or gets 404.
- **CANCELLED proof.** It is sound. A consumer must have the same signer, the same nonce, a different hash and a receipt. A consumer with deployment logs and no owner fails (`chain.ts:238`). Online, a CANCELLED row's own tx must have no receipt (`online.ts:92-95`). Hiding a mined tx as CANCELLED needs a receipt rewrite, which `--rpc` catches.
- **SUMMARY byte equality.** The exporter and the verifier share one generator and the same inputs. I found no honest drift.
- **Event-source rules.** They match every `emit` site in `contracts/src` for the 19 calls.
- **Founder key.** It comes from the calldata. PlanRegistry allows one registration, and the code checks that.
- **Browser safety.** `verifyBundle` and `verifyOnline` import no `node:` module. Only `cli.ts` and `read-dir.ts` do, and the index never imports them. `structuredClone` and global `fetch` are fine.
- **Keccak.** Every Ethereum hash is keccak (viem, or `@noble/hashes` `keccak_256` in core `hashObject`). No `sha3-256` appears anywhere. SHA-256 appears only in the temp tag (not security-relevant), the WebAuthn rpIdHash and the client-data hash, both of which the spec requires.
- **Bundle and error contents.** Neither carries an RPC URL, path or secret. `safeError` stores refusal messages only, which contain row ids and hashes. The CLI's absolute path goes to the local stdout only.
- **Finalized read ordering.** Receipts are read at `latest` and then re-checked against canonical blocks by number, so a reorg fails closed.
