# Hogee run-7 fixes: post-fix skills re-check

Target: worktree `<repo>/.claude/worktrees/g2-merge`, branch `wip/g2-merge` at `2068855`. I reviewed it from a `git archive 2068855` copy and ran nothing in the worktree.

Scope: `521171b..2068855`. That is the merges `2a23046` (wip/run7-scripts), `4b0ee31` (wip/run7-api) and `2068855` (wip/run6b), plus commit `dc2fee2`. Where a fix depends on its callers, contracts or the verifier, I read those too.

Skills applied:
- security-review, with its cloud-infrastructure-security.md;
- nodejs-keccak256;
- llm-trading-agent-security, limited to spend bounds, evidence integrity and key handling.

Paths are relative to the repo root.

Verdict: most fixes close their leads. One HIGH regression reopens the run-6 v-1 impact, through a table the new window does not cover. Two MEDIUM items are new anonymous lockout shapes created by the run-7 writer bounds.

## HIGH

### H1. M2's "never refuse" makes `signature_requests` unbounded again, and the export still hard-caps that table, so the v-1 "every export 409 for good" is back

**Where:**
- `packages/api/src/services/signing/request-bounds.ts:61-66`: `decideRequest` never refuses, and a new pair evicts the oldest.
- `packages/api/src/routes/signatures.ts:150-154` and `:91-96`: each create expires the older rows, then inserts a new row and a SIGNATURE trace.
- `packages/api/src/evidence/collect.ts:104-111`: `signatures()` still goes through `capped()` (`:49-53`). Past 50,000 rows it throws `EvidenceTooLargeError`, and `routes/evidence.ts:48` answers 409.
- `docs/G0-DECISIONS.md:509-511` says the total bound for these writers "is M4's windowed collect". That window (`collect.ts:173-217`) covers only `traces`.

**Scenario.** The precondition is a committed plan with the founder key on-chain (`signatures.ts:69-70`). An anonymous caller (who reads as founder):
1. Opens 11 or more OPEN timelock exceptions. These are allowed under the cap of 20, for example `RAISE_CAP` with distinct `newCapMinor` values, or `UNPAUSE` per lineKey.
2. Calls `POST /api/signatures/request {kind: LoosenRequest, refId: <exception i>}` round-robin over them.

Each call finds its own pair evicted (EXPIRED), so it is not a reuse candidate. It inserts a new row and evicts the next pair. That is one new row per call. A single pair also works: request, 5 bad submits (REJECTED), request again, at six calls per row.

About 50,001 calls later every export is refused, permanently. Nothing prunes `signature_requests`. On Sepolia the only reset is deleting the facility.

This is run-6 v-1's verified impact, reopened by the M2 fix, while §16 documents it as covered.

Two other tables still refuse at the hard cap, through writers §15 lists as not yet inventoried:
- `llm_calls`: every `POST /api/chat` turn writes a named LLM_CALL trace and an `llm_calls` row. The rows hit the `capped()` limit (`collect.ts:219-233`), and their traces count toward the named-trace cap (`collect.ts:176-178`).
- In DEMO_MODE, `POST /api/proposals/spend` writes exceptions, payments and denials, each with a named trace.

**Smallest fix.** Collect only the requests a bundle can use:

```
status = 'SUBMITTED' or signature_json is not null or chain_action_id is not null
```

These are the only ones `tools/verify-evidence` reads (`signatures.ts:94-96`, `plans.ts:182`). Count the rest as omitted, as `omittedTraces` does, and keep `capped()` on the subset.

Then correct G0 §16 "Signing is lockout-free, not bounded" and §15 "Still open 1". The window bounds unnamed traces only, not `signature_requests`, `llm_calls` or named traces.

Regression test: about 60,000 EXPIRED or REJECTED requests with no submission, and `exportEvidence` still succeeds.

## MEDIUM

### M1. The inspection-upload cap is permanent and anyone can fill it, so an anonymous caller fixes the milestone's evidence hash for good

**Where:**
- `packages/api/src/services/writer-bounds.ts:47-51` refuses after 5 recorded uploads.
- `packages/api/src/routes/suppliers.ts:157-166` counts them from the trace `inspection:<orderId>:<idx>`. Those trace rows are never deleted outside the DEMO reset.
- `packages/api/src/services/signing/founder-payments.ts:47-48`: MilestoneRelease signs the stored `evidence_hash`.

**Scenario.** A milestone waits for evidence. An anonymous caller uploads 5 different 1-byte PNGs. The stored hash is now junk #5. The founder's real report is refused (`409 "already has 5 inspection uploads; no more can be recorded"`), with no expiry and no officer override.

The founder can then either sign a release that commits the junk hash on-chain, or never release the milestone. Before run-7, the founder could always re-upload, because the last write won. This is a new lockout and integrity shape.

**Smallest fix.** Never refuse an upload of a new hash. Past `MAX_UPLOADS_PER_MILESTONE`, still update `evidence_hash`, but append no further trace event. The export stays bounded, and the founder's latest upload always wins.

Regression test: 5 uploads by an attacker, then a founder upload, and MilestoneRelease shows the founder's hash.

### M2. The shortlist window cap is a new anonymous lockout of the supplier step

**Where:**
- `packages/api/src/services/writer-bounds.ts:37-38`.
- `packages/api/src/routes/suppliers.ts:36-39` and `:44-47`: past 10 shortlists created in 600 s, a new spec is `CONFLICT`. FAILED shortlists count and are never reused.

**Scenario.** An anonymous caller POSTs 10 distinct valid `ShortlistSpec`s every 10 minutes. Every founder shortlist with a new spec is refused for as long as the attacker keeps going, so supplier approval and escrow cannot start. This is the run-6 M2 lockout shape, which §16 removed from signing, moved to the shortlist writer.

There is honest friction too. A founder retrying a FAILED shortlist (a check that is down) hits the cap after 10 tries.

The cap buys little:
- Shortlist TOOL_CALL traces are unnamed, so the new trace window already drops them from the export.
- `shortlists` is not collected at all.

**Smallest fix.** Keep the reuse. Replace the refusal with the signing pattern: create anyway, and mark older non-READY shortlists of the facility superseded. Alternatively, bound only FAILED retries per spec. Add §15 "Still open" text if the cap stays.

## LOW

**L1. `listExceptions` now returns every OPEN row with no limit, and one OPEN writer has no dedupe or cap.**
- `packages/api/src/services/exceptions.ts:56-68` lists all OPEN rows.
- `packages/api/src/routes/proposals.ts:61-66` (demo-only `proposeSpend`, which is live on any hosted demo, because DEMO_MODE is the only mode with an officer persona) inserts a POLICY_ESCALATION for every NEEDS_OFFICER verdict, with no dedupe or cap.
- If a flagged invoice exists (`core/policy/spend.ts:148`), repeating that proposal grows the response and the officer console without bound. Each row also names a trace, which counts toward the named-trace cap (H1).
- Fix: dedupe an OPEN escalation per invoiceId or pacingSlot and line. Cap the OPEN part of the list (for example, the newest 500 OPEN rows plus a count).

**L2. The explorer pin checks only the host, so row and contract links can still point at the wrong tx or contract.**
- `tools/verify-evidence/src/bundle.ts:77, 300, 307` accept any URL under `https://sepolia.etherscan.io/`.
- P2 renders `r.explorerUrl` with `r.txHash` as the link text (`apps/web/components/evidence/evidence-table.tsx:66-67`), and `c.verifiedUrl` as "verified source" (`evidence-view.tsx:100-101`). A tampered bundle can therefore send the judge to another, real Sepolia tx or contract.
- The CLI and SUMMARY are safe, because they rebuild links from the pinned base.
- Reach is low, because the UI loads only the server's own bundles.
- Fix: require `explorerUrl === ${base}/tx/${txHash}` and `verifiedUrl === ${base}/address/${address}#code`, which is what run-6 M5 asked for.

**L3. Concurrent shortlists bypass the early check.**
- The early decision at `suppliers.ts:37` runs outside the lock. N parallel POSTs all pass it and each runs `computeShortlist` (FX, sanctions, registry checks) before the locked re-check stores at most 10.
- So the outbound check work is unbounded under concurrency.
- Fix: take the lock, or a per-facility in-flight flag, before `computeShortlist`.

**L4. The §15 note for P2 is wrong after dc2fee2.**
- `docs/G0-DECISIONS.md:448-449` says a mock registration needs the officer to reject or approve the seeded example key first.
- Since `dc2fee2`, a real registration replaces the example key (`packages/api-mock/src/founder-enrolment.ts:115-117, 176`). Approving the example now blocks real registration until a reset.
- Fix: update the note.

**L5. The secret scan still misses generated founder secrets.**
- The founder backup-wallet key (`scripts/redteam/src/stack.ts:230`, the on-chain `ownerEOA` on Sepolia) and the soft-passkey private key (`:231`) are not in `secretsOf` (`safety.ts:121-135`). This was a run-7 hardening item.
- No writer of either was found, so this is a gap in the backstop only.
- Fix: add both (hex, and the PKCS8 or JWK form).

**L6. The dev-live web env is a denylist.**
- `scripts/dev-live/src/config.ts:75-92` blanks secrets and modes. A developer's `apps/web/.env*` still supplies `HOGEE_EVIDENCE_DIR`, `HOGEE_DATA_DIR`, `FINAL_DEPLOYMENT_ID`, `RPC_POLLING_MS` and `NEXT_PUBLIC_EXPLORER_URL` to the stack.
- None of these is a key or a paid API, so the stated goal holds.
- Fix: refuse to start while `apps/web/.env*` exists, or blank every variable the API reads.

## Checked, no finding

**Windowed collect and honest bundles.** The verifier needs only:
- traces named by rows (payments, denials: `audit.ts:93-110`);
- `refs.llmCallId` (`audit.ts:49`).

All of these are in `NAMED_TRACES`. Traces are kept or dropped whole, so hash chains stay intact. The eval exclusion is unchanged. An omitted trace cannot fail an honest bundle.

Remaining costs:
- The stats `GROUP BY` is unbounded: one row per trace id, at most once a minute because of L1. This is minor.
- The bundle does not record omissions, as documented.

**Exception writer.**
- The dedupe and the cap run under the transaction lock.
- Payloads are `z.strictObject`, and jsonb equality ignores key order.
- A dedupe dodge (for example `"040000"` against `"40000"`) only fills the 20 slots that §15 "Still open 2" already documents.
- An anonymous caller cannot move OPEN to another state without a founder signature, and the officer is the only one who denies. So named exception traces are officer-bounded.

**RELEASE_STAGE `rowCount`.** It is correct.

**`ctx.loosens`.** It counts QUEUED and EXECUTABLE rows with a `loosen_id`. It fails closed against the chain.

**Replan.**
- `stillCurrent` adds `replanLoosenings` against the current `env.current`. `reusableDraft` keeps code-14 drafts. `compileEnv` takes `draft_id` and `plan_id` from `world.plan`.
- I found no loop: a stale tighten-only draft recompiles once.
- `exception-create.ts:45` and `plan-approval.ts:69` get the stricter check.

**G2 live.**
- The reject revokes every unused code in the same transaction.
- `isFounderKeyRejected` matches the credential id or the lowercased (qx, qy). Both come from the same parser, and approve passes the `founders` row's point.
- Code consumption stays inside the registration transaction.

**api-mock parity.**
- The challenge is bound to the open code id.
- The code is marked used before any await, and given back on refusal, unless a newer code was issued meanwhile.
- There is one slot: a new key while one is pending gets `FounderKeyAlreadySet`, as live does.
- Reject revokes the open code. Rejected points are kept.
- dc2fee2 drops the example key on the first real registration.
- One nit: the mock answers CONFLICT for a rejected key before it checks the code, where live answers FORBIDDEN first.

**Supersede and evict.**
- Submit refuses EXPIRED and any status other than PENDING (`signatures.ts:256-258`), and its UPDATE re-checks `status = 'PENDING'`.
- The content key is deterministic, so a parallel request for the same item reuses rather than supersedes.
- A supersede happens only after a real state change, and the old request would have failed at finalize then anyway.
- I found no lockout shape beyond the documented "race the founder" residual (burn refusals, or evict across 10 or more pairs), and the founder recovers by requesting again.

**Readiness and interval.**
- `finalized` is read first.
- The in-flight sets match the `payment_state` and `chain_action_state` enums. DROPPED is retried by the worker (`inflight.ts:34`), so it is not terminal.
- Readiness, lock and interval refusals arm nothing.
- An idempotent call, or one refused while collecting, arms the per-process attempt map, which is pruned.
- `fetch.ts` stops at the first non-final receipt.

**Retention L8a.** The row is dropped only when no entry of that name remains (`lstat`).

**Verifier.**
- OwnerSpent replay mirrors `TreasuryGovernance.sol:48-62` exactly: active and unexpired, not escrow-only, payee ready, intent, invoice, then `_requireOwnerAmount`, with no pause or circuit.
- MilestoneFunded and Spent keep both checks.
- L6: an honest bundle always has exactly one FacilityOpened, because `openFacility` is always an API chain action, and the demo reset deletes the facility's rows.
- M3: the exporter (INCLUDED or FINALIZED) and the verifier (receipt `0x1`) agree.
- `explorerOf` drives the anchor and SUMMARY.
- `parseRpcUrl` refuses credentials, and only our own messages or the error class are printed.
- The Makefile passes the URL through the environment only.
- Browser-safe: only `cli.ts` and `read-dir.ts` import `node:` modules, and `index.ts` imports neither.
- Old local bundles (whose `contracts.json` `verifiedUrl` is `http://localhost/...`) now fail "bundle files". No bundle is committed (`evidence/.gitkeep` only), so re-export.

**Red-team redaction.**
- `errorRecord` and `errorReason` redact URLs (escaped, encoded and schemeless) and cut local paths in the message, the stack frames (the `name: message` lines are dropped) and the cause chain.
- The plug-child stderr and `crash.json` are redacted too.
- The plug child gets its DB and RPC URLs through `PLUG_CHILD` in the env, not argv.
- The officer's enrolment code is kept out of the transcript.
- The scan now has the RPC URLs (with a path or query of 16 characters or more, and the password), the DB URL and the Xendit key. It runs in its own `finally`.
- `jsonLogger` is the worker's redacting logger.

**Preflight.**
- The chain and DB checks run under the lock, before migrate, before the halt clear and before `publishRoles`. The gas check runs before the roles.
- Sepolia requires an empty `facilities` table and a Treasury with no facility open.
- Anvil refuses facilities of other chains.
- The T29 `capFees` throws above the cap.

**dev-live Postgres.**
- `initdb --auth=scram-sha-256` sets both local and host auth, and `unix_socket_directories=''`, so no trust is left.
- The password goes only to a 0600 `--pwfile` (deleted after use) and a 0600 `PGPASSFILE` inside a 0700 `.data`.
- It is never on argv or printed: the printed URL has no password.
- `pg` and pg-boss read `PGPASSFILE`.
- Anvil runs with `--no-cors --block-time 1 --slots-in-an-epoch 1`.

**`route.ts`.** It refuses `REPLAY` together with `MOCK_API=0`. No repo script sets both.

**Keccak.**
- Every new Ethereum hash is keccak (viem, or noble `keccak_256` in `keccak256Utf8` and `hashObject`).
- `hashtextextended` is used only for advisory-lock keys, and sha256 only for the temp tag.
- The only `sha3-256` in the tree is a negative test (`packages/api/test/enrolment.test.ts:21`).

**Leaks.**
- No new bundle field, error message (`ready.ts`: row ids, states, block numbers) or log line carries a URL, key or local path.
- `online.ts` reports the error class only.

**P2 contract.**
- `EvidenceBundle` is unchanged.
- `ContractsFile.verifiedUrl` is now nullable, which still accepts strings.
- The new `CONFLICT` answers (shortlist, exception, inspection) are documented in §15.
