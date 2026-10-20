# G0 decisions (frozen interfaces, task 1.3)

**Status:** approved by P1 and merged on 2026-10-15 (PR #1, `fe0e885`); the interfaces are frozen. Since then only additive changes are allowed (project.md §26.10), apart from the G2 schema batch (§11). Each later decision is a new numbered section. §19 onwards summarise the per-agent notes of 18–19 Oct (`docs/decisions/`).

The spec left gaps; each was resolved with the smallest additive choice and marked `G0-DECISION:` in the code. Search for that string to see each one in context.

## 1. Decisions before G0 (all approved 2026-10-15)

| # | Issue | Proposal |
|---|---|---|
| 1 | **Rina ads numbers conflict (§26.2).** Pacing was 10,000/day against a 60,000 7-day window cap, so every 7th daily slot reverted `CapExceeded` and 3 denials would trip the line (permanent on loop-1, which cannot unpause) | ✅ **Approved 2026-10-15: pacing 7,500/day** (60,000 / 8). Revised from the first approval of 8,500: with 15–30 min tick jitter, 8 daily slots can land in one 7-day window, and 8 × 8,500 = 68,000 overflows the cap; 8 × 7,500 = 60,000 does not. The worker also **skips** a pacing slot when the window has no headroom instead of proposing it, so a full window never becomes a denial, a `recordDenied` or a revert (project.md §12.4 `autonomous-tick`). Applied to project.md §26.2, core `RINA`, both Rina fixtures; goldens regenerated |
| 2 | **On-chain ids.** `payeeId`, `orderId`, `supplierId`, `stageId` are short lowercase strings (`[a-z0-9_-]`, ≤32 chars), right-padded into bytes32 like `lineId` | ✅ **Approved 2026-10-15:** Approve |
| 3 | **Demo clock.** Plan committed 2026-10-16T00:00Z; lines valid 60 days; judging window assumed to end 2026-11-30 (agentExpiry must be later) | ✅ **Approved 2026-10-15:** Approve |
| 4 | **E2 labelling.** Four **[DECIDE]** items in `evals/datasets/e2/LABELING.md`: ID partnerships, ASEAN origin, two approvals vs one field, reserve policy, trade-name fee | ✅ **Approved 2026-10-15:** Decide before P3 labels. **Decided 2026-10-17 (D4–D8):** `cv` with the warning scored separately; other-ASEAN suppliers left out; first approval in the fixed order (single field kept); reserve MY 500, ID perorangan/pt_perorangan 50, ID cv/pt 500; always the RM60 trade-name fee. These match task 1.10's constants |
| 5 | **Manual takeover of supplier payments.** If the agent is dead, the owner can only *release* already-funded milestones (`releaseMilestone`). The owner can't fund new milestones, and `ownerSpend` can't pay the escrowOnly SUPPLIER line (§8.3) | ✅ **Approved 2026-10-15:** Accept for the demo; owner-side milestone funding later, as an additive function |
| 6 | **No agent-key recovery on `loop-1` (from the G0 audit, v-1).** Replans are now tighten-only and there is no rotate-agent loosen kind, so after `TIGHTEN_REVOKE_AGENT` (or an expired key) `loop-1` can only be recovered by redeploying, and `loop-1` is never redeployed | ✅ **Approved 2026-10-15:** **Accept for `loop-1`:** a revoked agent ends the autonomous loop, which is itself evidence (T15). `final-1` gets an additive `LOOSEN_ROTATE_AGENT` (founder + lender + timelock) only if the demo needs it |

**For task 1.4, not blocking G0.** These three spec gaps came from the first review:
- **Invariant 2** (`… == funded + recordedRevenue`) can't hold while net revenue lands nowhere on the left side. Use `reserveSkimmed`, or define where net revenue goes.
- **The supplier's 280,000 balance exceeds the SUPPLIER window cap of 250,000.** State that `fundMilestone` ignores the window cap, as it ignores `perTxCap`.
- **The MetaMask fallback with a chainId-less domain needs one live signing test.** The salt (chainTag + deploymentId) is what blocks replay.

## 2. Contract interface (`contracts/src/interfaces/`, `packages/chain`)

| Gap | Choice |
|---|---|
| `LoosenRequest` can't express MOVE_POCKETS / ADD_PAYEE | New field `bytes32 aux`. MOVE_POCKETS: target = from line, aux = to line, newValue = amount. ADD_PAYEE: target = payeeId, aux = lineId, one request per line |
| `recordDenied` has no line | `recordDenied(lineId, decisionId, reasonCode, proposalHash)`. lineId 0 = no line. reasonCode = bytes32 string |
| bindPayee line unspecified | `SupplierApproval.lineId` (must be an escrowOnly line) |
| RAISE_CAP / EXTEND_EXPIRY ambiguous | Split kinds: raise per-tx cap or window cap; extend agent expiry or line expiry. UNPAUSE target 0 = treasury, lineId = that line (also closes its circuit) |
| **Lines/stages not covered by the founder's signature** | `PlanApproval` gains `linesHash` and `stagesHash`, so a relayer can't swap lines (T27) |
| `ownerSpend` had no signed struct | New struct `OwnerSpend{lineId, payeeId, amountMinor, invoiceHash, deploymentId, nonce, expiry}`, because a passkey owner can't send a tx |
| No-invoice lines | `Line.pacingMinor` (0 = invoice line); pacing spends use the per-line sequence number (`lineSequence` view) |
| File-level errors/events missing from ABIs | `IHogeeErrors`/`IHogeeEvents` base interfaces inherited by all four |
| Event/error name clash `Paused` | Event renamed `TreasuryPaused(lineId, by)` |
| Views the worker/UI need | domain/nonce views; planVersion, currentPlan, line(s), stage(s), founderKey; facility, balances, isInvoicePaid, payeeBinding, queuedLoosen, settlementState; escrow order/milestones; isSaleRecorded |
| Ids | spendId = intentId; loosenId = struct hash; amountBucket = minor units rounded down off-chain |
| Domains/nonces | Each struct is verified by the contract that uses it; unordered nonces, one space per contract |
| Constitution codes | 1–11 map one-to-one to §8.3 (agent expiry split into too late/too early); 12 = totals mismatch, 13 = malformed |

**Golden PlanApproval digest (Rina v1, after review, pacing 7,500/day):** `0xc74fa2a0af3ae20fb8f15e3a27954f26f64cc22779f5ba03ada026b801a41cb3`. Solidity and viem compute it independently and agree. Also golden: SupplierApproval `0xf3c90db3…4875`, linesHash `0xf107f98a…7b7f`, stagesHash `0x229235b7…acc5`, Supplier A payoutAccountHash `0x142ad066…1ccc`.

## 3. Database (`packages/db`)

- **10 tables beyond §12.1:**
  - `chat_sessions`, `chat_messages` (store redacted parts only);
  - `memory_entries` (sources `USER_TURN | ORACLE_FACT` only, HMAC);
  - `plan_drafts`, `shortlists`, `escrow_orders`, `escrow_milestones`;
  - `chain_actions` (signing outbox for non-payment txs);
  - `signature_requests`, `evidence_runs`.
- **Money:** `numeric(38,0)` through a validating `minor()` type. Postgres silently rounds `'10.5'` → `11`, so ORM writes reject non-digit strings. Every amount has a `>= 0` CHECK.
- **Times:** chain-mirrored times, blocks and nonces are `bigint`. Off-chain times are `timestamptz`.
- **Hashes and addresses:** `text` with lowercase CHECKs. Lowercase addresses make double nonce rows impossible.
- **Signed-row invariant (T19):** raw tx, nonce, signer and chainId are all-null or all-set. Any state past the unsigned ones requires the raw tx.
- **`traces.refs`:** typed nullable columns with no FKs; the audit log never blocks or cascades.
- **Supplier keys:** composite `(facility_id, supplier_id)`, so fixture ids A–E can repeat across tenants (T31).
- **Plan versions:** unique only for COMMITTED/SUPERSEDED rows, so the "poison the planner" revert can reuse its version.
- **`llm_calls`:** stores hashes only; `tokens` (usage) is jsonb, the one allowed wording exception.
- **Deletes:** no cascades. Demo reset uses `TRUNCATE … CASCADE`.
- **Enum parity:** a test asserts every Postgres enum equals its `@hogee/core` zod enum. It already caught two drifts, which are now fixed.

## 4. Schemas and API contract (`packages/core`, `packages/api-contract`)

### Formats

| Area | Choice |
|---|---|
| Addresses, UUIDv7 | Lowercase only (JCS hashing is case-sensitive) |
| Ids | Off-chain: `[A-Za-z0-9._:-]`, ≤128 chars. On-chain: see §1 #2 |
| Integers | Plan version, stage/milestone idx (0 sample, 1 deposit, 2 balance, 3 holdback), trace seq, block, chainId are JS integers. `windowSeconds` is a digit string |
| Minor / UnixSeconds | Capped at uint128 / uint64 |
| `planId` | bytes32 hex |
| `intentVersion` | Literal `1` |

### Plan and country pack

- `lineEmphasis` and `productApprovals` are objects whose keys are all optional. Slot names follow the PlanIntent fields; `assumptions` is `[{slot, text}]`.
- Stage 1 has `gate: null`. `rules[].sourceRef` is a JSON Pointer into the pack, or `constitution:<CODE>` / `compiler:<id>`.
- Schemas check **structure only, not the constitution**, so the T21 malicious plan can still be represented. Lines are unique, and `lineId` matches `lineKey`.
- **Country pack money is in minor units** (RM3M = `"300000000"`). Rates are integer bps; durations are days.
  - Only metadata and `reserveFloorBps` are required. A `VERIFIED` pack needs every core section.
  - There is an optional `dataProtection` block.
- Supplier `fobUnit` / `freightPerUnit` are minor-unit strings; D16 overrides §26.5's "number".

### Suppliers and shortlist

- RankedSupplier adds `supplierId` and `displayName`. Scores are 0–100.
- Shortlist hash and stability fields are `null` until READY.
- Every defect is a hard gate except `FAKE_REPORT`, which only drops evidence to tier 3.

### Exceptions and evidence

- `requestedBy` is `agent|founder|officer|worker`. `timelock` is `null` until the item is queued.
- Exception payloads follow the §2 contract kinds: RAISE_CAP carries `cap: perTx|window`; ADD_PAYEE has one `lineKey`; EXTEND_EXPIRY targets `agent|line`; UNPAUSE takes an optional `lineKey`.
- EvidenceRow: on-chain rows need `txHash`; agent-refusal rows need `traceId`.

### API conventions

- **HTTP codes:**
  - 422 VALIDATION; 409 COMPILE_FAILED, CONFLICT and every contract error; 404 NOT_FOUND; 403 FORBIDDEN; 502 UPSTREAM.
  - The Stripe webhook returns 400 for a bad signature.
- **Persona:** the cookie is `hogee_persona`; routes may restrict personas (403 otherwise).
- **Signing:** typedData uints are decimal strings. Passkey submissions with high-s are rejected.
- **Chat:** the request takes plain text, and the server keeps the history. The 5 frozen data parts are strict.
- **Exception approve:** returns a tagged union, `APPROVED` or `SIGNATURE_REQUIRED`.
- **Lists:** payments paginate by cursor = last `paymentId`. Traces take `since` (ISO) and `limit` (1–500).
- **Datasets:** span offsets count Unicode code points, end exclusive. Sanctions aliases are `;`-separated.

### For teammates

- **P2:** `packages/api-mock` exports `app = new Hono().basePath('/api')`. Register routes in `routes` order with `honoPath(route)`; the contract test finds the package automatically.
- **P3:** reuse `RINA_IDS` from `@hogee/core` in fixtures. Run `pnpm validate:data` and read `data/schemas/*.schema.json`.

## 5. Fixes from the G0 AI review

The review's verdict was "freeze-safe: no", with 6 HIGH and 9 MEDIUM findings and no CRITICAL ones. Everything below is fixed and marked `G0-REVIEW:` in the code.

### HIGH

| # | Finding | Fix |
|---|---|---|
| H1 | `POST /api/proposals/spend` took payee and amount from the caller, which breaks D6 | Body is now `{lineKey, invoiceId, reason}` or `{lineKey, pacingSlot, reason}`; the server derives payee and amount. The route is demo-only |
| H2 | The "above a threshold" lender co-sign was undefined, and loosening could break the constitution | Every loosen kind needs founder + lender (`HogeeKinds.requiresLender`). `executeLoosen` re-checks the 25%/50%/90-day bounds, and the MOVE_POCKETS caps |
| H3 | The lender key could replace the founder's key and sign as the founder | `registerFounderKey` works once per facility (`FounderKeyAlreadySet`); rotation is out of scope |
| H4 | An owner fallback spend looked like an orphan, so the reconciler would auto-pause | New `OwnerSpent` event; payment kinds `OWNER_SPEND` and `WITHDRAW_RESERVE`; `decisionId`/`rationaleHash` are null exactly for those kinds |
| H5 | `ownerSpend` checks were unspecified, and zero `decisionId` could be spoofed | ownerSpend enforces bound and cooled payee, not escrowOnly (`EscrowOnly`), duplicate invoice, balance, stage and validity; it skips caps and pause. `spend`/`fundMilestone` revert `MissingDecision` on zero ids |
| H6 | `fundMilestone` could pay inside the payee's veto (cooling) window | It reverts `PayeeCooling` until `coolingUntil`, autoRelease milestones included |

### MEDIUM

| # | Finding | Fix |
|---|---|---|
| M7 | Events were too thin for the offline verifier | `PlanCommitted` adds linesHash, stagesHash and reserveBps. `PayeeBound` adds supplierId, scheduleHash and payoutAccountHash. `Spent` adds planVersion. `SupplierApproval.payoutAccountHash` is signed |
| M8 | Reserve withdrawal had no settlement | `ReserveWithdrawn` event (settlementId = loosenId). Each settlement is closed exactly once (`SettlementClosed`); a failure refunds its source |
| M9 | Global primary keys broke tenant isolation | Every tenant primary key and foreign key includes `facility_id`, and a live two-tenant test passes |
| M10 | Money ranges didn't match across layers | DB `numeric(39,0)` with a ≤ uint128 check; zod is bounded to uint32/uint64/uint128 where the chain is |
| M11 | `payments` integrity | Partial unique `intent_id` (excluding denied, dropped and reverted rows; **superseded by §6 v-4**: dropped rows no longer release it); a unique signer nonce; nullability matches `Payment`; milestone rows must carry order and idx |
| M12 | A `MOCK_API` typo fell through to live mode | Only `"0"`/`"1"` are accepted; `REPLAY` must be a run id (path traversal is rejected) |
| M13 | Guards passed when they checked nothing | `REQUIRE_API_MOCK=1` and `validate:data --require` make missing pieces fail; route examples must return 2xx |
| M14 | The persona cookie was unauthenticated | `setPersona` is demo-only, the cookie is HMAC-signed and httpOnly (task 1.12), and destructive demo routes are officer-only |
| M15 | Golden vectors and the spec were stale | Fixture ids follow the ShortId format, there are `manifestToLines`/`manifestToStages` goldens, and project.md is v1.3 |

### Added during the fixes (please confirm)

- **New errors:** `EscrowOnly` is new. Neither `ownerSpend` nor `spend` may pay an escrowOnly line (§8.3).
- **Contracts:**
  - A `PayeeBinding.payoutAccountHash` view.
  - ADD_PAYEE signs `newValue = payoutAccountHash`.
  - The owner fallback ignores line pauses and tripped circuits.
- **Schemas:**
  - `WITHDRAW_RESERVE` payments have `lineKey: null`, an all-zero `invoiceHash`, and intentId = loosenId.
  - `payoutAccountHash` lives on `RankedSupplier` and is server-computed, so P3 never hand-computes keccak.
- **DB:**
  - Milestone-kind payments must carry `order_id` and `milestone_idx`.
  - The signer-nonce uniques are the only allow-listed global keys.

## 6. Fixes from the security audit (run-1, approved 2026-10-15)

A Cloudflare `security-audit` quick pass ran on `0b3e41d` (source-only). It had no confirmed findings. Four leads
survived independent verification, and all four are fixed here before the freeze. Code comments tag them `G0-AUDIT (v-N)`.
The full records are in `docs/security-audit-run-1/` in the team folder, outside the repo.

| # | Lead | Fix |
|---|---|---|
| v-1 | A founder-only `commitPlan` at version > 1 could reproduce loosenings that need the lender (cap raise, pocket move, a lower `reserveBps`, a new agent), undo the lender's tightenings and re-release stage 0 | Versions are strictly sequential (`version == planVersion() + 1`, same `planId`, else `StalePlan`), so a re-signed `version: 1` cannot skip the rule. Once a plan exists, a re-commit may only **tighten** the current on-chain state, else `PlanInvariantViolated(14)` (`CONST_REPLAN_LOOSENS`). Amounts, stages, `totalMinor` and `countryPackHash` stay identical; pacing never switches to 0. Only the first commit releases stage 0, and a re-commit never resets runtime state (pause, circuits, window spend, sequences, bindings). Loosenings need a lender-co-signed `LOOSEN_*` kind. The rule is in the `IPlanRegistry.commitPlan` NatSpec and §8.3; the REPLAN example now tightens caps. The 1.4 PlanRegistry and the 1.10 TS constitution mirror implement it when they rebase onto G0 |
| v-2 | Any caller could self-assign the officer persona, which alone selects actions the server signs with the demo lender key; `approveFounderKey` was not bound to the reviewed passkey; nothing stopped DNS rebinding or cross-site POSTs to the localhost API | Fixed in the contract and in shared `@hogee/api` code that both the live API and api-mock use. (1) The officer persona is minted only with `officerToken` equal to `OFFICER_TOKEN` (strength-checked, constant time). (2) The cookie is `<persona>.<exp>.<HMAC-SHA256>` keyed by `PERSONA_COOKIE_SECRET` (plus sha256(`OFFICER_TOKEN`) for the officer), lives ≤ 8 h, is HttpOnly/SameSite=Strict/Path=/api, and anything invalid reads as `founder:rina`. (3) `approveFounderKey` names the reviewed `credentialId/qx/qy` (else `CONFLICT`). (4) Every `/api` request passes a Host allow-list (`HOGEE_ALLOWED_HOSTS`); a POST with a cross-site `Sec-Fetch-Site` or an Origin other than Host is refused. (5) Pages send anti-framing, nosniff and referrer headers. The contract suite tests forged, unsigned and tampered cookies. Left for task 1.12: the handlers, attempt limiting with a trace event per failed attempt, and calling `parsePersonaCookieSecret` at startup |
| v-3 | Compose published Postgres (superuser `hogee/hogee`) and Presidio without a host IP, so the runtime could expose them on the LAN | Every compose port binds `127.0.0.1` |
| v-4 | A `DROPPED` payment released its intent while its signed bytes could still be mined, so one FUND_MILESTONE decision could execute twice | `DROPPED` no longer releases the intent. A new terminal state `CANCELLED` (a foreign tx consumed the nonce) does. Only `POLICY_DENIED`, `REVERTED` and `CANCELLED` release it. Fee bumps keep every earlier hash in `superseded_tx_hashes`; `CANCELLED` must name the consuming tx (`nonce_consumed_by_tx_hash`), which cannot be one of the row's own hashes; `REVERTED` needs its receipt block; a `POLICY_DENIED` row holds no signed bytes (all DB CHECKs). Only the worker sets CANCELLED/REVERTED, from `finalized` reads (§12.3). The two new columns are DB-only; the API `Payment` does not expose them |

**Also:** `.claude/worktrees/` is git-ignored, so agent worktrees can never be committed by `git add -A`. The other
hardening notes (≈46) are in the audit report and are scheduled with the task that owns each file.

**Needs from you:**
1. ✅ Done 2026-10-15 (`df83963`): `.env.example` lists `OFFICER_TOKEN`, `PERSONA_COOKIE_SECRET` and `HOGEE_ALLOWED_HOSTS` (names only).
2. Before any `DEMO_MODE=1` live run, set real `OFFICER_TOKEN` and `PERSONA_COOKIE_SECRET` values in your local `.env` (`openssl rand -hex 32` each).

## 7. Fixes from the security audit (run-2, tasks 1.4, 1.5 and 1.10, 2026-10-16)

A scoped Cloudflare `security-audit` quick pass ran on `70045f3` (the three task branches merged onto `p1/g1-build`; source-only).
It had no confirmed findings. Two leads survived independent verification, and both run-1 leads (v-1, v-4) are resolved.
The records are in `docs/security-audit-run-2/` in the team folder, outside the repo. A skills re-check after the fixes
(`defi-amm-security`, `llm-trading-agent-security`, `nodejs-keccak256`) found one more MEDIUM and several LOWs, fixed below.
**Behaviour changes teammates' code must follow:**

| Area | Rule now |
|---|---|
| Payees (contracts + core mirror) | `spend` pays only a payee that is bound **and listed on that line by the current plan version** (`PayeeNotBound`, checked before cooling). A re-commit that drops a payee de-authorises it; its binding data stays. |
| Roles | The agent must differ from the owner, the lender **and the oracle** (code 13); `ownerEOA != oracle` at `registerFounderKey`; `lender != oracle` in the Treasury constructor and DeployLoop. |
| Zero amount | `spend` with `amountMinor == 0` reverts `CapExceeded` (mirrored in core). |
| Deploy (`DeployLoop.s.sol`) | `CHAIN_TAG` must match the chain (`anvil` 31337, `sepolia` 11155111); off Anvil, `COOLING_SECONDS` must be set (≤ 30 days) and Anvil default accounts are refused as lender/oracle; the clock scale must match `FISCO_MS`; the constructor validates the platform payee arrays. |
| Pacing (core) | `planPacingSlot(ctx, lineKey, inFlight, payeeId?)` builds the exact pacing spend and runs `evaluateSpend` on the in-flight projection (`projectInFlight`); anything but AUTO is a SKIP. The worker sends only a PROPOSE, never `recordDenied` for a SKIP or a pacing proposal. An invoice spend on a pacing line is denied; a pacing `invoiceHash` must equal `bytes32(slot)`. |
| Injection detector (core) | All format/default-ignorable characters are stripped after NFKC and combining marks are folded for matching; bidi controls, tag characters and variation-selector runs raise `HIDDEN_CHARACTERS` (AI_INJECTION gate, IMPERATIVE_TEXT invoice code) and are decoded for the red-flag excerpt. |
| Supplier trust (core) | Registry-id points count only with a validator result bound to that supplier and id (`ScorerCandidate.registryChecks`). |
| Worker chain core | `signAndStore` needs the facility's `deployment` (to/value/kind bound to it) and `planId` from the committed plan (intent_id recomputed); a value-moving chain action is signed only if `eth_call` shows a Hogee revert; finality/recovery take `deployment` + `facilityId`, check the facility's deployment, isolate errors per row and finalise only canonical receipts; the DB log cursor is finalized-only; provider URLs are redacted from errors. |
| Roles: observer (run-3; contracts + core mirror) | A set observer is never the agent, the owner EOA, the lender or the oracle: its `cancelLoosen` veto survives `TIGHTEN_REVOKE_AGENT`, so on a worker-held key it could cancel every `UNPAUSE`. Treasury's constructor refuses observer = lender or oracle (`C(13)`); `commitPlan` refuses agent = observer (code 13); `registerFounderKey` refuses ownerEOA = observer (`InvalidSignature`); `DeployFinal` refuses `OBSERVER_ADDRESS` = `LENDER_ADDRESS` / `ORACLE_ADDRESS`. Core: `ConstitutionFacility.observer` is optional (absent or zero = none); pass `Treasury.observer()` so the mirror catches it before the chain does. |
| Deploy floors (run-3) | Off Anvil (chain ≠ 31337), `COOLING_SECONDS` (DeployLoop and DeployFinal) and `LOOSEN_TIMELOCK_SECONDS` (DeployFinal) must be ≥ 120 s, the labelled-demo value the Sepolia final-1 demo uses. Production must use 24 h for both. Anvil keeps the contracts' 1 s minimum for short tests. |
| Deploy broadcaster (run-3) | Off Anvil, neither deploy script accepts one of Anvil's ten default accounts as the broadcaster (checked right after `vm.readCallers`): final-1's escrow and sales-oracle addresses are precomputed from its nonces n+2 and n+3, and a public key would let anyone use those nonces first. |
| Zero milestones (run-3) | `bindPayee` refuses a signed schedule with a zero milestone (`C(13)`): it could never be funded but would read as fully funded. |
| Milestone release cooling (run-3 v-5; contracts + core mirror) | `escrowRelease`, the sink of autoRelease and `releaseMilestone`, reverts `PayeeCooling` while the order payee's binding is cooling. A re-bind (new order, possibly a new payout account) restarts cooling, so no milestone of any order of that supplier releases inside the new veto window. Core: `evaluateReleaseMilestone` denies `PayeeCooling` (after `MilestoneLocked`, before the cap). The milestone-settlement job (not wired yet) must pay the binding as it stands at payout time and hold while it is cooling. |
| Failed milestone payout (re-check M-1; contracts + core + chain mirror) | `failSettlement` of a milestone release returns the amount to the **supplier line pocket**: line and total `escrowedMinor` fall by it (as do the payee's `paidMinor`), so a vetoed payout (the oracle's veto of a phished re-bind, T3) strands no BU. The milestone stays released and fully funded: it is never re-funded (`AmountExceedsSchedule`) or re-released (`MilestoneLocked`), and its settlementId stays closed. To pay the supplier again the founder signs a new `SupplierApproval` (a new order). `MilestoneEscrow.releaseFailed` is gone; `failSettlement` makes no external call. Core: `evaluateReleaseMilestone` denies `MilestoneLocked` for a released milestone or one with a known settlement (no `SettlementClosed` branch). Chain: `intentEffect` reads `released` (now permanent); a `CONFIRMED` or `FAILED` `settlementState` is a second proof. Readers: a failed release shows released with its settlement `FAILED`; `pocket()` and `balances()` already net it out. |
| Deploy runbook (run-3, final-1) | New step after the DeployFinal broadcast: once mined, run the read-only `forge script script/VerifyFinal.s.sol --rpc-url <rpc>` (no `--broadcast`, no key). It checks code at the five addresses, every link, the governance module's immutables, the observer and the timelock. Inputs and a jq recipe: its header. |
| VerifyFinal inputs (re-check L-2, final-1) | VerifyFinal now checks everything DeployFinal asserts or was given. New required inputs: `CHAIN_ID`, `EXPECTED_DEPLOYMENT_ID`, `EXPECTED_CHAIN_TAG` (manifest `.chainId`, `.deploymentId`, `.chainTag`; `EXPECTED_` because the deploy scripts read `DEPLOYMENT_ID`), `LENDER_ADDRESS`, `ORACLE_ADDRESS` and `COOLING_SECONDS` (the deploy inputs). It refuses a wrong chain first, then checks lender (Treasury and PlanRegistry), oracle (Treasury and SalesOracle), deployment id and chain tag (PlanRegistry, Treasury, MilestoneEscrow) and cooling by equality; off chain 31337 cooling and the loosening timelock must be ≥ 120 s. |
| Worker startup (re-check L-3, L9) | Besides chain id and the lender/oracle keys, the worker refuses to start when a final-1 manifest (with `MilestoneEscrow`) names an escrow or sales oracle other than `Treasury.escrow()` / `Treasury.salesOracle()` (or has no `SalesOracle`); when a manifest without `MilestoneEscrow` fronts a Treasury whose `escrow()` is non-zero (a revert is the loop-1-src shape and passes); and when a set `Treasury.observer()` is its own agent, oracle, lender or relayer key. Always run the worker with the full manifest DeployFinal printed. |
| `buildBindPayee` (re-check L-4) | Throws `TxValueError` on a zero schedule entry (the contract reverts `C(13)` on one, run-3). |

**Run-3 (2026-10-17):** the rows marked run-3 come from hardening the final-1 contracts after security-audit run-3
(`wip/harden-contracts`). final-1 is not deployed yet; loop-1 deploys from the `loop-1-src` tag and is unaffected.
The rows marked re-check come from the post-fix security re-check of that work (`wip/recheck-fixes`), also before any
final-1 deployment.

**Open for task 1.6 (worker):** treat `error`, `occupied` and stuck non-canonical `pending` outcomes as alert-and-halt; pass the real
owner/lender/oracle addresses into the core facility context (the Rina demo uses the zero address); real milestone releases and
reserve withdrawals go through `payments` rows, not `chain_actions`.

## 8. Fixes from the security audit (run-4, task 1.12 live API and worker jobs, 2026-10-18)

A scoped Cloudflare `security-audit` quick pass ran on `dd824df` (the 1.12 API merged into `p1/dev`; source-only).
It had no confirmed findings. Six leads survived independent verification, and two were rejected. Run-3's leads
v-1..v-4 are resolved in current source. The reports are in `docs/security-audit-run-4/`; the raw run is in
`~/security-audit-skill/hogee/run-4/`. Behaviour changes:

| Change | Rule now |
|---|---|
| Request bodies (run-4 lead 3) | The 256 KiB JSON and 10 MiB upload caps are enforced on the bytes as they stream, not only from `Content-Length`: a chunked body is cancelled at cap+1 bytes and refused 422 before any parsing or handler. |
| CONFIRMED settlements (lead 1, re-check M1/L3/L4) | A row never becomes `SETTLED` without a rail payout reported SUCCEEDED. CONFIRMED + a SUCCEEDED attempt whose ref is the worker's own confirm → `SETTLED`; CONFIRMED + a SUCCEEDED attempt but the worker's confirm missing/reverted/another ref → `SETTLED` plus one `SETTLEMENT_CONFIRMED_ELSEWHERE` ALERT; CONFIRMED with no SUCCEEDED attempt (an outside oracle confirm) → `SETTLEMENT_CONTRADICTION` halt, raised once per payment, after which the row stays blocked without re-halting. `settlementState` and the receipt are read at one finalized block; the rail history is read to the first unseen key (≤ 32), not `payoutMaxAttempts`. Nonce rows are seeded for every worker key at start-up, so outside oracle/lender/relayer use raises `EXTERNAL_KEY_USE` from the first pass (still alert-only for those keys). |
| Third-party founder executions (lead 2, re-check M3/M4/L5/L7) | A founder-signed OwnerSpend or MilestoneRelease that another account executed first (the relayer's row ends REVERTED / POLICY_DENIED / CANCELLED) is adopted from the chain as a worker-owned FINALIZED row `adopt-owner:<spendId>` / `adopt-release:<settlementId>`, with an alert, and paid exactly once through the normal binding — only while its settlement is still NONE at the finalized block. Lookups are bounded: the block is found by binary search on monotone state, logs are read from that one block (safe on 10-block `getLogs` caps; reserve adoption now works the same way), groups retire once their signatures are long expired or after one alert (held, mismatch, own tx, closed). Adoption needs historical (archive) state reads; without them it alerts once and retries. |
| Veto (lead 4, re-check M2/L2) | `veto` locks the exception row and decides on the locked status. The relay defers `cancelLoosen` while the exception's own `queueLoosen` is signed and not final. Sync re-queues a cancel (at most 3 times, then one ALERT) for a CANCELLED exception whose loosening is QUEUED, and writes one `VETOED_LOOSEN_EXECUTED` ALERT — not a halt, since founder and lender both signed it and the veto route is open to any persona — if it was executed, judged at finalized. Reconciled vetoes leave the scan. Statuses are unchanged. |
| Pacing per chain day (lead 6, re-check L1) | A pacing line gets at most one slot per chain day across the tick and `POST /api/proposals/spend`: the API answers DENY `ALREADY_PROPOSED_TODAY` (traced, never recordDenied) when another SPEND on the line is signed or mined that chain day; agent-actions refuses an API pacing row in the same case; the tick treats such a line as done for the day and never resumes an API row. An unsigned proposal never holds a line's day. |
| State denials (rejected lead, robustness) | `proposeSpend` never anchors `Paused`, `CircuitOpen`, `LineExpired`, `AgentExpired` or `NotAgent` refusals with `recordDenied` (core pacing.ts WORKER RULE). |
| Inspection evidence (rejected lead, defence in depth; re-check M2/L6) | The upload no longer changes a milestone's evidence hash while a MilestoneRelease request is PENDING and unexpired in **chain** time, or a live RELEASE_MILESTONE payment holds it (404). It checks this before hashing the file and refuses files over the cap. |

**Deferred to the G2 schema batch (lead 5, passkey enrolment):** founder-key enrolment is first-come: any client
that reaches the API between `facility/open` and the founder's registration can take the PENDING_LENDER slot (no
takeover: the officer must approve the exact `{credentialId, qx, qy}`). Closing it needs an api-contract change, so it
goes with P2's `GET /api/officer/founder-key/pending` request: an officer-issued one-time enrolment code bound to the
registration challenge, and an officer route that rejects a pending key. Until then, register the founder's passkey
immediately after opening the facility, on a host no one else can reach.

**Deferred coverage (run-4 critic):** the worker's chain-to-DB status mirror (`apps/worker/src/jobs/sync.ts`) as its
own surface, and the liveness of the safety jobs under the single job lock with 8 one-minute queues (plus oracle load
from the any-persona `POST /api/demo/sale`).

**Accepted after the re-check:** a PENDING release request (founder persona, so anyone) can hold planted evidence for up
to 15 minutes — its root cause is the same unauthenticated founder persona as lead 5 and is closed with it; a resent
proposal for an intent already held is still anchored as `DuplicateIntent` (documented design, verifier v-6); the
webhook HMAC is computed over the decoded text, which differs from the raw bytes only for a body starting with two BOMs.

## 9. Eval endpoints and the security audit (run-5, task 1.13, 2026-10-18)

A scoped `security-audit` quick pass ran on `43641cc` (task 1.13 merged into `p1/dev`; source-only): no findings, 14
hardening notes, one critic gap deferred (eval model spend). Reports: `docs/security-audit-run-5/`. The hardening and
the skills re-check after it changed these rules:

| Change | Rule now |
|---|---|
| Eval routes | `/api/eval/case`, `/plan`, `/shortlist` run only with DEMO_MODE=1, CHAIN=local (Anvil) and an opened facility. They never sign, enqueue, or write chain_actions, payments, invoices, drafts or shortlists. E1 "would execute" is an `eth_call` from the agent's address. At most 2 eval requests are in flight per server (503 `UPSTREAM` `EVAL_BUSY` beyond that), and every eval model call has a deadline. |
| Eval traces | Eval traces are measurements, never decisions: they carry no `policy_verdict` and start with `[eval `. The autonomy stats and the timeline exclude them. |
| Dataset files | Every dataset file (country packs, supplier JSON, listing text, eval jsonl, `spec.json`) is read through one contained reader: realpath under the data dir, regular file, size cap. An absent or partly unreadable result is never cached. |
| Shortlists | A shortlist fails closed when a listing's declared text cannot be read. E3 filters by `spec.buyFrom` like the product. Supplier checks run before the transaction that stores the shortlist. |
| Registry trust | Registry checks are bound to the supplier, so a validated id earns its points. Listing-derived trust (registry ids + platform metrics) is capped at `LISTING_TRUST_MAX_BPS` = tier-2 − 500. The validators are format and checksum checks, so a copied USCC must never outrank tier-2 evidence until a name-matched registry lookup exists. |
| Payout hash | SupplierApproval refuses (CONFLICT) unless `payoutAccountHash(shown account)` equals the shortlisted candidate's hash, in both prepare and finalize. |
| API pool | The API's Postgres pool has a connect timeout. |

**Still open:** the eval cap bounds concurrency, not total spend, and `POST /api/chat` has no rate limit. Both stay
latent while `@hogee/privacy` `redact` is a stub; add a spend budget before P3's redaction lands. **Closed in §23.**

## 10. Evidence (task 1.16)

The coordinator approved the table and the deviation on 2026-10-18; it did not approve the salted switch.

| Change | Rule now |
|---|---|
| New table `rationales` (migration `0001_rationales`, additive only) | `(facility_id, rationale_hash)` → `rationale_json`, `decision_id`, `salt` (NULL). Each decision writer stores the exact object it hashed, in the same transaction as its payment or denial row, through `@hogee/db` `insertRationale`. The writers are worker `pacing.ts` and `agent-actions-sign.ts` (spend and escrow), and API `proposals.ts` (AUTO and anchored denials) and `signing/founder-payments.ts`; eval writes none. Identical rationales share one row. No hash or calldata changed. |
| Rationale commitment stays unsalted (deviation from §7.2) | `rationaleHash = keccak256(utf8(JCS(rationale)))`, as every writer already computed it. §7.2's salt is a privacy measure for preimages that are never exported. Every preimage here is exported in the bundle, so integrity is unchanged. Switching the writers would touch the worker's signing, orphan-watch and settle-binding paths, which the run-3 re-check found fragile, so it is deferred. `salt` stays nullable, and the verifier also accepts the salted form. |
| Rows decided before 1.16 | They have no preimage. The bundle lists them as `unavailable` ("pre-1.16 row"), and the verifier reports them without failing. A wrong or tampered preimage always fails. |
| Bundle layout (`tools/verify-evidence/src/bundle.ts`) | Beyond `manifest.json` and `evidence.json`, the bundle holds `contracts.json`, `plans.json`, `signatures.json`, `payments.json` (raw signed tx once mined), `chain-actions.json`, `rationales.json`, `traces.json` (eval traces left out whole), `llm-calls.json` (hashes only), `blocks.json`, `country-pack.json`, raw `receipts/<txHash>.json`, `SUMMARY.md`, and `hashes.json` (keccak256 of every other file). Every file schema is strict. |
| Export | `runId = "ev-" + keccak256(JCS(source data))[0:16]`, which makes the export idempotent: unchanged evidence returns the existing bundle untouched. One export runs at a time (advisory lock `0x45564944`). Limits are 50,000 rows per table and 5,000 files of at most 32 MB each, 128 MB in all. The export writes to `.export-*` and then renames, so it never overwrites a bundle. The route answers `{runId}` and finishes in the background (tracked in `evidence_runs`). `make evidence` waits for it. |
| Evidence rows | Rows come only from facts. S1/S2/S3/S4/S5/S11 come from the matching successful action. A reverted tx whose decoded error is a §13.2 pass criterion becomes that T row. An anchored denial becomes an `agent_refusal` row. Task 1.15 labels the rest. |

## 11. G2 schema batch (2026-10-18)

Merged at gate G2 under project.md §26.10. It removes one request variant, so `SCHEMA_VERSION` is now **2.0.0** (a
removal is a breaking change, so the major version moves). P2's UI changes are listed in `docs/G2-notes-for-P2.md`.

| Change | Rule now |
|---|---|
| `POLICY_ESCALATION` (core `ExceptionCreate`) | Not a request kind any more. It stays an `Exception` kind, and only the server's spend path opens one (`proposals.ts`). A caller-built one fails schema validation (422) before any handler runs. The live API and the mock keep a defence-in-depth refusal behind the schema. |
| `PlanManifest.schemaVersion` | New manifests carry `2.0.0`. A stored `1.0.0` manifest still parses (`READABLE_SCHEMA_VERSIONS`): the manifest shape did not change, and a committed plan's hash covers this field, so it can never be rewritten. The compiler goldens were regenerated for the version string only; with `1.0.0` put back, the drafts hash to the old goldens. |
| Supplier → escrow order (P2 request) | `GET /api/suppliers/:id` answers `SupplierWithOrder` (api-contract): `SupplierWithEvidence` plus `orderId`, the supplier's newest `escrow_orders` row, or `null` until a SupplierApproval creates one. It goes on this route because the live API only knows the order there; the shortlist's `RankedSupplier` is hashed into `shortlistHash`, so it stays unchanged. The fixture schema `suppliers.json` is unchanged too. |
| Shortlist failure reason (P2 PR #10) | `Shortlist.failureReason: string \| null` is null unless `status` is FAILED. On input it is optional with a default of null, so P3's `shortlist.json` and stored results parse unchanged. It is not hashed: `shortlistHash` covers only `{requestId, weightsVersion, candidates, excluded}`. The live API returns `shortlists.error` only if it is one of the summaries the shortlist code writes; any other stored text becomes one generic sentence. |
| Pending founder key (P2 request) | `GET /api/officer/founder-key/pending` (officer) answers `{credentialId, qx, qy, createdAt}` or `null`. `createdAt` is the new `founders.passkey_registered_at`. This is the only persona-gated GET, so the route-table rule now lets a gated GET answer FORBIDDEN. |
| Example data | `exc-withdraw-reserve` now asks for 2,000 minor from the 2,500 example reserve. Its title is the one the live API gives it: "Withdraw 20 BU from the reserve to lhdn-tax". |
| Error lists | Each route now declares the codes the live API really throws. Before, register.ts rewrote them to CONFLICT (contract errors) or UPSTREAM. FounderKeyAlreadySet on passkeyRegisterVerify. On approveException: PayeeNotBound, CapExceeded, LineExpired, PlanInvariantViolated, PayeeCooling, MilestoneLocked, AmountExceedsSchedule and EvidenceMissing. requestSignature, submitSignature, createException, chat, draftPlan, previewCountry, shortlistSuppliers, proposeSpend, demoAttack and getAutonomyStats also gained codes. **EscrowOnly and Paused are not declared on approveException:** the live API never returns them there, because an escalation is approved as an officer override and the worker re-checks payee and caps when it pays. Codes that are declared but never returned (NotLender, TimelockActive, …) are left as they were. |
| Passkey vectors | `contracts/test/PasskeyVectors.t.sol` and the `packages/chain` passkey tests read P2's originals in `e2e/vectors` (`fs_permissions`: read-only, that folder only). The byte-identical copies under `contracts/test/vectors/passkey` are deleted. CI runs the contracts and ts jobs when `e2e/vectors/**` changes. |

### Founder-key enrolment (closes run-4 lead 5, §8)

Lead 5 was that any client reaching the API between `facility/open` and the founder's registration could take the
PENDING_LENDER slot. This is now closed:

- **Issue.** `POST /api/officer/founder-key/enrolment-code` (officer) answers `{code, expiresAt}`. The code is 18
  random bytes (144 bits), base64url, so 24 URL-safe characters. It is shown once and never traced or logged.
- **Storage.** Migration `0002_founder_enrolment` (additive only) stores keccak256(utf8(code)) only, in
  `founder_enrolment_codes`. This is Ethereum Keccak-256 via `@hogee/core`, never NIST SHA3. A partial unique index
  allows at most one open (unused, unrevoked) code per facility, and issuing a new code revokes the open one.
  `@hogee/db` `founder-enrolment.ts` is the only writer.
- **Time base: the API's wall clock** (`deps.clock()`), 15 minutes (`ENROLMENT_CODE_TTL_SECONDS`). The code is bound
  to the WebAuthn registration challenge, and that challenge already expires on the same clock (5 minutes). No contract
  checks the code, so chain time has no role here. `expiresAt` is ISO-8601, as §26.3 requires for off-chain times. The
  column is `code_expires_at`, because `expires_at` columns are chain-mirrored by convention.
- **Register.** `POST /api/passkey/register/options` needs `{enrolmentCode}`. The API compares the code's hash with
  the open code's in constant time (`timingSafeEqual`). The HMAC challenge binding becomes
  `<facilityId>|<founderId>|<codeHash>`.
- **Verify.** `POST /api/passkey/register/verify` takes the open code and checks the challenge against it. It then
  consumes the code in the same transaction that stores the PENDING_LENDER key, under the founder row lock, so two
  racing registrations store exactly one key. FORBIDDEN in every one of these cases: a missing, wrong, used, replaced
  or expired code, or a challenge that does not verify against the open code (forged, expired, another founder's, or
  issued under a code that was since replaced).
- **Reject.** `POST /api/officer/founder-key/reject {credentialId}` (officer) records the pending key in
  `rejected_founder_keys` and clears the founder's credential, so a fresh enrolment can start (it needs a new code).
  It never touches a key registered on-chain (FounderKeyAlreadySet), or one whose approval is already a chain action
  (CONFLICT: the worker may be signing it). A rejected credential can never register or be approved again.
- **Approve.** `approveFounderKey` re-checks, under the founder row lock, that the reviewed key is still the pending,
  unrejected registration.
- **Known limit.** If the worker refuses an approval (for example, its simulation reverts), the approval row stays
  `PENDING` unsigned, and the key cannot be rejected. The officer must investigate.
- **Mock.** api-mock enforces the same rules (`founder-enrolment.ts`, which wraps handlers-core's passkey
  handlers), and `pnpm test:contract` checks them.

**Lead 5 is closed.** §8's interim advice ("register the founder's passkey immediately after opening the facility, on
a host no one else can reach") no longer applies. The re-check item that shared its root cause (planted inspection
evidence through the any-persona founder cookie) is unchanged: the founder persona itself is still not authenticated.

## 12. Run-6 fixes (export bounds)

The run-6 audit verified two leads in P1's live API. Anonymous callers read as the founder (demo design, accepted), so
the founder-persona writers and the evidence export are now bounded at the server. No contract, schema or migration
changed: refusals are counted from their ALERT traces, and an existing `signature_requests` status is reused.

| # | Lead | Rule now |
|---|---|---|
| v-1 | `POST /api/signatures/request` and refused `POST /api/signatures/:id/submit` grew `signature_requests` and `traces` without bound, so past 50,000 rows every export answered 409 for good | (1) A request for the same kind, refId and method returns the facility's unexpired PENDING request when it still carries exactly what would be built now (same struct apart from nonce and expiry, same panel) and has at least 60 chain-seconds left. No row or trace is written. (2) At most `MAX_OPEN_REQUESTS` = 10 unexpired PENDING or REJECTED requests per facility; a new one past that is `CONFLICT`. (3) The `MAX_REFUSALS` = 5th refused signature moves the request to `REJECTED`. After that it answers `CONFLICT` and writes no ALERT. Each decision runs under a per-facility lock, and each refusal under a row lock. |
| v-2 | Anonymous `POST /api/evidence/export` wrote a full new bundle for every state change, with no retention and no interval, and `listRuns` opened every run | (1) No new run starts within `MIN_EXPORT_INTERVAL_S` = 60 s of the facility's last READY or FAILED run (`CONFLICT`). The check is one `evidence_runs` query under the lock, before anything is collected, so an identical state is refused inside the interval too and is idempotent again after it. (2) After a publish, only the facility's newest `KEEP_RUNS` = 10 READY runs of this deployment stay. An older folder is removed only if it is a real directory directly under the root that holds this tenant's bundle. It is renamed to a temp name first and never followed through a symlink. Its `evidence_runs` row is then dropped. (3) `listRuns` opens the index files of at most 200 folders, the newest by mtime. |

The final coverage critic's gaps, folded in:

| Gap | Rule now |
|---|---|
| Tenant binding | A bundle is served, listed and pruned only when `contracts.json` names the server's facility, deployment and chain, and the manifest names the same deployment and chain. One evidence root can hold an Anvil and a Sepolia checkout's runs. |
| Temp folders | They are named `.export-<tag>-*`, where tag = 12 hex of sha256(`chainId:deploymentId`). The lock covers one database, so the sweep removes only its own tag, plus any `.export-*` older than an hour. |
| Existing bundle | When the run folder already exists, `done` resolves `verified: null`: nothing was written or checked. `make verify` checks the folder. |
| Officer lockout | While officer access-code attempts are locked out, only the first refusal per window leaves an `OFFICER_TOKEN_LOCKED` trace; the rest are only logged. |

**Still open:**
1. The writers are rate-bounded, not bounded in total. Sustained abuse can still add at most 10 requests per 15 chain-minutes, each with 1 SIGNATURE and 5 ALERT traces: about 5,800 traces a day, so the 50,000-row cap is reachable in about 9 days. The real fix is an export that collects a window or an increment instead of the whole history (collect.ts, owned by another change).
2. Demo reset (`routes/demo.ts`, DEMO_MODE and Anvil only) deletes the facility's `evidence_runs` rows but leaves its run folders on disk. Retention no longer tracks those folders, so they are never pruned.
3. If more than 200 newer run folders share one root, the listing can leave out a facility's runs.

## 13. Replan compiles tighten-only

Red-team 1.15 (T20) found that drafting the same intent again after v1 always failed code 14 `REPLAN_LOOSENS`: the
compiler re-dated every `validUntil`, the agent expiry and the stage gate from the current chain time, reset runtime
tightenings, and listed the now-bound supplier. So no founder-only replan could go chat → draft → PlanApproval.

| Change | Rule now |
|---|---|
| Replan form (`packages/core/src/compiler/replan-form.ts`) | With `current` set, the compiler also compiles the committed plan's own intent (`currentIntent`, from the signed draft) at the same clock, facility and registry. The difference between the two is what the new intent changes, and only that is applied to the on-chain state: `value = current + (new − prior)`, clamped to codes 1-13. This covers pocket amounts, caps, pacing, every `validUntil`, the agent expiry and the reserve. The same intent therefore gives the current state exactly, which the founder signs alone. With no `currentIntent`, the new intent counts as unchanged. |
| Fixed at the first commit | No LOOSEN_* kind can change the stages (the gate included), so a replan keeps them. A new budget compiles fresh stages, and that replan is unsupported anyway (TOTAL_CHANGED). `windowSeconds` and `escrowOnly` are never loosened. |
| Payees | A payee is listed only if it is one of the line's current payees as the chain counts them, unless the new intent is what adds it (for example a new sell channel's platform payee, which routes ADD_PAYEE). The chain counts payees the plan lists and payees bound to the line by a signed approval (`Treasury.isSignedPayee`: bindPayee, LOOSEN_ADD_PAYEE). A static platform payee the plan no longer lists does not count. |
| Genuine loosenings | More budget on a line, a longer horizon or a new payee still fail only REPLAN_LOOSENS and go through `routeReplan` (MOVE_POCKETS, RAISE_CAP, EXTEND_EXPIRY, ADD_PAYEE). A longer horizon extends the expiries by the extra days, measured from the committed plan's timeline. A cap raise on a line the agent tightened raises it by the intent's increase only. |
| API `current` (`packages/api/src/services/compile.ts`) | The API builds `current` exactly as PlanReplan reads it: the pocket's window, pacing and escrow flag, the agent state, and per line the registry payees with `isSignedPayee` true at the snapshot block. It passes `currentIntent` to both compile paths (POST /api/plans/draft and the chat planner). The policy world (`policyWorld`, used by `evaluateReplan`) still lists only the line's listed payees. |
| Rules | A replan draft carries the informational rule `replan.current-state`. |

## 14. Run-6 fixes (verifier)

The run-6 `security-audit` verifier leads on the offline evidence verifier and its exporter: v-3
(`chain.ts:row-labelled-chain-view`), v-4, v-5 and v-6 in `~/security-audit-skill/hogee/run-6/verifier-results/`, plus
two gaps from the final coverage critic. This section supersedes §10's "Rows decided before 1.16" row. Behaviour now:

| Change | Rule now |
|---|---|
| Rationale preimages (v-4) | No submitted deployment predates task 1.16. An `unavailable` entry in `rationales.json` fails "rationale commitments". The exporter refuses to export (`EvidenceIncompleteError`) when a committed `rationaleHash` has no stored preimage. |
| Event replay (v-5) | The replay makes Treasury's and MilestoneEscrow's checks. Spent and OwnerSpent need a payee that is bound to the line AND listed by the current plan version; LoosenExecuted kind 3 lists an added payee. `agentExpiry` comes from PlanCommitted and kind 4. MilestoneFunded is checked at its block time: pause, agent expiry, zero amount, line version, validUntil, circuit and pause, and the order's payee binding and cooling (order → line and payee from its PayeeBound; schedule from the signed `bindPayee` calldata). A line holds at most 64 live window entries. A T29 orphan passes only when `TreasuryPaused` with lineId 0 follows it. As `syncPlan` does, the agent, planId and stage 0 come from the first commit only, a re-commit resets line allocations, and a re-bind keeps the paid total. |
| Chain view (v-3) | Row labels no longer choose what is checked. Every row's raw signed tx is parsed (hash, signer, nonce, call). Every row that names a tx must have its receipt. A CANCELLED row is the only exception, and only with its nonce consumer in the bundle (`payments.json` `nonceConsumedBy {txHash, rawSignedTx}`, plus its receipt): mined, same signer, same nonce. A tx with a receipt must be labelled mined. OWNER_SPEND, RELEASE_MILESTONE and WITHDRAW_RESERVE rows bind to their calldata (`ownerSpend`, `releaseMilestone`, `executeLoosen`). Every successful payment tx emits exactly one event of its kind, equal to the row. An `agent_refusal` row must name the recordDenied tx that anchored its decision. There is no per-signer nonce-gap check, because one nonce allocator serves every facility of a key. |
| Exporter chain reads (v-3, critic) | `fetch.ts` reads a receipt for every row tx, whatever its state, and adds each CANCELLED row's `nonce_consumed_by_tx_hash` with its receipt and its signed bytes (rebuilt from `eth_getTransactionByHash` and checked against the hash). The export is refused in three cases: a row names a tx that is not mined (SIGNED, BROADCAST, DROPPED or PENDING with a tx), a row's label disagrees with its receipt, or a receipt sits above the `finalized` head. Export again once the worker has settled the state. A refusal row takes its anchor from the denial's own recordDenied action. |
| Event sources (v-6) | New check "event sources (calldata ↔ events)". Every event sits in the receipt of the signed call that emits it, comes from the right contract, and equals that calldata. Each successful call emits its own event exactly once (spend → Spent, fundMilestone → MilestoneFunded, commitPlan → PlanCommitted, registerFounderKey → FounderKeyRegistered, …). PlanCommitted must be in the commit action's own receipt. The commitPlan calldata check is never skipped for a COMMITTED or SUPERSEDED plan. |
| Founder key (v-6) | The key comes from the lender-signed `registerFounderKey(qx, qy, ownerEOA)` calldata, sent by the FacilityOpened lender. FounderKeyRegistered must equal it. `qx` and `qy` are unindexed, so the bloom never bound them. |
| Status flip (v-6) | A reverted agent `spend` or `fundMilestone` is replayed dry at its place in the log. The plan rules must refuse it; otherwise the bundle shows a successful call as reverted, and verification fails. |
| SUMMARY.md (v-6) | Generated by `tools/verify-evidence/src/summary.ts`; the api's `summary.ts` calls it. The verifier regenerates it from the files and requires byte equality ("SUMMARY.md (regenerated)"). It says what VERIFIED means and lists the anchor: contracts, and every tx with its status. |
| Anchor and online mode (v-6) | `verifyBundle` returns `anchor`: chain, deployment, contract addresses, the newest block (number and hash) and every tx hash with a receipt. The CLI prints it and says that VERIFIED means internally consistent, and that chain truth comes from comparing the anchor with Sepolia Etherscan. `make verify VERIFY_RPC=<url>` (`--rpc`; `verifyOnline`, browser-safe, fetch only) re-fetches every receipt and block. It compares their consensus fields byte for byte (provider-only extra fields are ignored), the chain id, contract code, and requires that the CANCELLED rows' own txs have no receipt. The URL is never printed. |
| Evidence rows (critic) | A row's `expected` comes from its task, not its receipt. A scripted success (S1-S5, S11) whose tx reverted for a reason that is no attack's error is that task's FAIL row. |

**Accepted residuals.**

- **No eth_getLogs orphan scan.** A T29 orphan (an agent-key effect that no row explains) is never fetched. Neither is a
  row a DATABASE_URL holder deletes, nor a recordDenied action relabelled PENDING with its `tx_hash` cleared. The live
  control is the worker's T29 safety pause. The verifier passes an orphan only when that treasury pause follows it.
- **No header RLP or receipt-trie proofs.** An offline header chain still needs an external trust root: someone must
  confirm the head block hash on the chain. That is the same act as comparing the anchor, which the CLI prints and
  `--rpc` automates. The proofs would only shrink what is compared, from every tx hash to one block hash.
- **Offline VERIFIED means internally consistent.** These are caught only by the anchor comparison or `--rpc`: a status
  flip of a call the replay does not model (e.g. commitPlan) and a consistent rewrite of non-payment logs. A
  fabrication with fresh keys is caught only by comparing the anchor's contract addresses with Hogee's announced
  deployment: `--rpc` checks only that each address has code, so a forger's own contracts on Sepolia pass it (§16, L4).
- **Revert reasons stay the worker's decoding.** A receipt carries no revert data. The dry run proves that the rules
  refuse a reverted agent call, but not which error refused it.
- **A dry-run false positive is possible.** A reverted agent spend whose cause lies outside the plan rules (e.g. out of
  gas) fails verification. The worker simulates every call before sending, so an honest bundle should not have one.
- **A succeeded attack gets no row.** The DB records no attack intent, so the 1.16 exporter recognises an attack only by
  its revert or its refusal. The red-team runner (task 1.15) reports succeeded attacks.
- **The route's error message is generic.** `export.ts` (owned by the export fix) shows only a generic message for
  `EvidenceIncompleteError` and `EvidenceChainError`; the full message is in the server log. Passing it through needs a
  one-line change to `safeError`.

**For P2's explorer.** `VerifyResult` gains `anchor`; show it with the statement that VERIFIED means internally
consistent (the panel's "verified offline" wording claims more). The check list gains "event sources (calldata ↔
events)" and "SUMMARY.md (regenerated)". `verifyOnline(files, rpcUrl, { fetch })` is browser-safe, but it needs an RPC
that allows CORS. Bundles exported before this change have no `payments[].nonceConsumedBy` and fail the schema: export
them again.

## 15. Run-7 fixes (API)

The run-7 `security-audit` hunters h-g2-data, h-g2-auth and h-replan, and verifier v-1
(`api:founder-persona-trace-writers-unbounded`, needs_validation), in `~/security-audit-skill/hogee/run-7/`. Anonymous
callers still read as the founder (demo design, accepted), so three more founder-persona writers now follow §12's
pattern (`packages/api/src/services/writer-bounds.ts`). Each decision runs under a per-facility transaction lock. No
contract, core schema or migration changed. `uploadInspection` now declares `CONFLICT`.

**Correction to §12.** §12 says that "the founder-persona writers ... are now bounded at the server". That was true only
of `POST /api/signatures/*`. The shortlist, exception and inspection-upload writers were unbounded until this section.
`POST /api/chat`, `POST /api/plans/draft` and the demo routes are still not inventoried.

| Lead or item | Rule now |
|---|---|
| Shortlist (`POST /api/suppliers/shortlist`) | The facility's newest PENDING or READY shortlist for an identical spec (jsonb equality), created within `SHORTLIST_WINDOW_S` = 600 s of database time, is returned again. Nothing is computed, stored or traced. A FAILED shortlist is never reused: its reason says "start a new one", and a check that was down may be back. ~~Past `MAX_RECENT_SHORTLISTS` = 10 shortlists created in the window, a new one is `CONFLICT`.~~ **Superseded (§18 M2, L3):** a new spec is never refused; past `MAX_OPEN_SHORTLISTS` = 10 open shortlists the oldest open ones become FAILED (superseded), and starts of one facility run one at a time. A live shortlist is decided in the transaction that inserts it, so none stays PENDING. |
| Inspection upload (`POST /api/escrow/:orderId/inspection`) | A re-upload whose hash equals the stored one writes no row and no trace, and answers the hash. The milestone row is locked. ~~Each milestone records at most `MAX_UPLOADS_PER_MILESTONE` = 5 uploads (`CONFLICT` past it).~~ **Superseded (§18 M1):** a new hash is always stored; only the first `MAX_UPLOADS_PER_MILESTONE` = 5 uploads and one final "not traced" event are traced. All uploads of one milestone share the trace `inspection:<orderId>:<idx>`, so they are counted from its rows. |
| Exception (`POST /api/exceptions`) | An OPEN founder exception with the same kind and payload (jsonb equality, so key order does not matter) is returned again, whatever the reason text. At most `MAX_OPEN_FOUNDER_EXCEPTIONS` = 20 founder exceptions are OPEN per facility. A new one past that is `CONFLICT` until the officer decides some. The mirrored checks run first, so a duplicate RELEASE_STAGE is still the existing CONFLICT. |
| Live loosenings (verifier) | `policyWorld` now sets `ctx.loosens` from the facility's QUEUED or EXECUTABLE loosening rows with a loosenId, live until executableAt + `LOOSEN_GRACE_SECONDS`. Core's `MAX_QUEUED_LOOSENS` = 16 bound (queueLoosen row 7) therefore refuses a create or an officer approval with `CapExceeded`, as the chain would. |
| `listExceptions` | ~~Every OPEN row is listed, plus the newest other rows up to 200 in all, with or without `?status`.~~ **Superseded (§18 L1):** at most 200 rows in all; OPEN rows first (newest first), then the newest others; past 200 OPEN rows the newest OPEN rows are cut first. The console calls it unfiltered. The response shape is unchanged. Founder OPEN rows are capped (above). The worker's RELEASE_STAGE rows are not capped; the spend path's POLICY_ESCALATION rows are one per OPEN proposal since §18 L1. |
| Evidence export (verifier, root cause) | Past `MAX_ROWS_PER_TABLE` = 50,000 trace events, counted after the eval filter, the export no longer refuses. Every trace that a payment, a denial or an exception names is kept whole (an LLM call no longer names its trace since §18 H1). The newest other traces are then kept whole while they fit, and the older ones are left out whole, so every hash chain stays intact. Only named traces past the cap still refuse (`EvidenceTooLargeError`). The verifier passes such a bundle. **Corrected (§18 H1):** this window covered only unnamed traces. `signature_requests` and `llm_calls` were still read whole and refused past the cap; §18 leaves unused requests out and windows the LLM calls. **Not recorded in the bundle:** `ContractsFile` and the regenerated SUMMARY.md have no field for the omitted count, and adding one is a bundle schema change. The count is in `Collected.omittedTraces` and in the operator log (`evidence_traces_omitted`). |
| Reject (h-g2-auth) | The reject transaction also revokes every open enrolment code (`rejectPendingFounderKey`). A code issued while the key was pending can no longer take the freed slot, so a new enrolment needs a code issued after the reject. |
| Rejected keys (h-g2-auth) | `isFounderKeyRejected` matches the credential id **or** the public key (qx, qy, case-insensitive), in verify and in approve. A rejected P-256 key cannot come back under a new credential id. |
| api-mock parity (h-g2-auth) | `register/options` answers a random challenge bound to the open code, and verify needs a clientDataJSON that carries it. The code is marked used before any await, and is given back if the core handler refuses the registration. The mock has one key slot, as live: a new credential while a non-rejected key is pending is `FounderKeyAlreadySet`, and approve is `FounderKeyAlreadySet` once any key is REGISTERED. Reject revokes the open code. A rejected public key never comes back. The contract test runs the `rejectFounderKey` example last, on a reset store. |
| Replan `stillCurrent` (h-replan) | It also requires `replanLoosenings(draft.manifest, env.current)` to be empty. A tighten-only draft that a Treasury-only change made loosening (a TIGHTEN_*, an executed loosening, a new signed binding) is no longer offered by PlanApproval or opened as a REPLAN exception. `draftPlan` compiles it again (`reusableDraft`). A draft that already failed code 14 when it was compiled is still handed out again: it is routed through exceptions and never signed as it is. |
| Replan `compileEnv` (h-replan) | `draft_id` (and so the prior intent) and `plan_id` come from `world.plan`, the row `policyWorld` checked against the chain, never from a second read. |
| RELEASE_STAGE approval (h-g2-data) | Like `decide()`, it checks the UPDATE's rowCount. A deny or a second approval that committed after the OPEN read answers `CONFLICT` and inserts no `Treasury.releaseStage` action. |

**For P2.** In mock mode the seeded example key is pending, only so that the contract example round-trips. ~~A new
registration therefore needs the officer to reject it first, or to approve it.~~ **Corrected (§18 L4):** since
`dc2fee2` a real registration replaces the example key, so the officer does not need to reject it first. Approving the
example key instead registers it, and then blocks a real registration until a demo reset. A browser's `navigator.credentials.create()` already sends the options challenge in
clientDataJSON, which is what the mock now checks. ~~`POST /api/escrow/:orderId/inspection` can answer `409 CONFLICT`
(the upload limit).~~ (No longer, §18 M1.) `POST /api/suppliers/shortlist` can return an existing requestId, ~~or `409 CONFLICT` (the window
limit)~~ and never refuses a new spec (§18 M2); an old shortlist can turn FAILED with the reason "Superseded by newer
shortlists". `POST /api/exceptions` can return an existing OPEN exception, or `409 CONFLICT` (the open-request limit).

**Accepted (LOW, not fixed).**

- The PlanApproval panel (`plan-approval.ts`) shows no per-line payee set or payee changes. A replan that drops a payee
  is signed without the founder seeing it.
- `compileEnv` takes `capMinor` and `reserveFloorBps` from the DB `facilities` row, not from the chain. On-chain codes 1
  and 7 still bound commitPlan (fail closed).
- The api-mock exception lifecycle differs from the live API. An officer approval before the founder signs is APPROVED,
  RELEASE_STAGE has no gate check, and only QUEUED or EXECUTABLE rows can be vetoed. This is offline demo parity only.
- api-mock signing accepts any well-formed passkey assertion, whatever its credentialId (§26.7 shortcut).
- core `evaluateReplan` does not add the `isSignedPayee` payees that `compileEnv` adds, so it is stricter than PlanReplan
  (fail closed).
- Approving a RELEASE_ESCROW_BALANCE asks for the MilestoneRelease the server derives for the order. An exception whose
  payload names another milestone stays OPEN.
- The RELEASE_STAGE "already pending" check is not atomic for an APPROVED row. Concurrent OPEN duplicates are now
  deduplicated under the lock, and the on-chain released flag stops a second release.

**Still open.**

1. The writers are rate-bounded, not bounded in total: at most 10 shortlists (10 traces) per 10 minutes, on top of §12's
   signature bound (since §18 M2 the shortlist writer is not rate-bounded either: it runs one start per facility at a
   time, its TOOL_CALL traces are unnamed and windowed, and `shortlists` is not exported). With the trace window above, unnamed traces past the cap no longer refuse the export. Old unnamed
   traces leave the bundle instead, and the bundle does not say how many (it needs a schema field). **Corrected (§18
   H1):** the window bounds unnamed traces only. It did not cover `signature_requests` (unbounded again since §16 M2),
   `llm_calls` (one row per chat turn) or named traces, so the export could still refuse for good. §18 closes the first
   two; named traces (payments, denials, exceptions) still refuse past the cap.
2. An attacker can fill the 20 OPEN founder-exception slots. The founder then cannot open a request until the officer
   denies the flood, row by row.

## 16. Run-6 re-check fixes

The post-fix skills re-check of the run-6 fixes (`~/security-audit-skill/hogee/run-6/recheck-run6-fixes.md`) found one
HIGH and four MEDIUM regressions or gaps, plus LOW items. Each fix below is its own commit with a regression test. No
contract, migration, frozen schema or api-contract route shape changed. This section supersedes the §12 v-1 rule (2) and
the §14 "Exporter chain reads" refusal timing; the §14 residual on fresh keys is corrected in place (L4).

| # | Finding | Rule now |
|---|---|---|
| H1 | The replay ran the agent's circuit and line-pause checks on OwnerSpent, so every honest manual-fallback payment on a tripped or paused line failed "event replay" | `onOwnerSpent` mirrors `ownerSpend` (`TreasuryGovernance.sol:48-62`): active and unexpired line, not escrow-only, payee bound and listed and cooled, intent, invoice, then non-zero, pocket, lifetime cap, released and funded. No agent, per-tx or window check, and no pause or circuit of any kind (§8.8). Spent and MilestoneFunded keep both. |
| M1 | The finality refusal ran in the background build, after POST had returned the runId: the caller never saw it, the run 404'd, and the FAILED row armed the interval | `evidence/ready.ts` runs under the export lock, before anything is collected and before the run is claimed. It reads `finalized` first, then refuses when a payment or chain action names a tx in a non-mined state (CANCELLED payments excepted) or when the newest row block is above `finalized`. The refusal is 409 CONFLICT with its reason, writes no `evidence_runs` row and arms no interval. `fetch.ts` also reads `finalized` before any receipt and stops at the first non-final one. The dev-live Anvil flags are another change (`scripts/`). |
| M2 | The signature-request cap counted PENDING and REJECTED and refused past 10, so about 60 anonymous calls locked the founder out | Reuse is unchanged. A new request expires (EXPIRED) the older PENDING requests of its kind, refId and method. The cap counts distinct open (kind, refId) pairs of unexpired PENDING requests; REJECTED never counts. A request for a new pair past `MAX_OPEN_REQUESTS` = 10 evicts the oldest open pair (its PENDING requests become EXPIRED). The cap never refuses. |
| M3 | A refusal row took its anchor from the recordDenied action whatever its state, so a recordDenied that reverted CircuitOpen in a burst anchored the row to a reverted tx and the honest bundle failed | The anchor is the recordDenied action's tx only when the action is INCLUDED or FINALIZED, else `denials.recorded_tx` (sync sets it for landed actions only), else none. The verifier agrees: with no successful recordDenied for the decision, an unanchored refusal passes, and the T26 revert row shows the reverted tx. |
| M5 | `explorer` and every URL came from the bundle, so a tampered bundle could send the judge to a lookalike explorer | The explorer is pinned by chain id in `tools/verify-evidence` (`explorerOf`: 11155111 → `https://sepolia.etherscan.io`, every other chain none). Loading fails ("bundle files") unless `contracts.json` names exactly that explorer, every `verifiedUrl` (now nullable) and row `explorerUrl` sits under `<base>/` or is null, and the manifest's `verifiedUrl`s sit under `<base>/` (`http://localhost/` when the chain has none, since the frozen manifest schema needs a URL). A failing URL is never echoed. The anchor and SUMMARY.md build every link from the pinned base. The exporter writes these values, and replaces a deployment `verifiedUrl` elsewhere (e.g. Sourcify) with the Etherscan code page. **Tightened (§18 L2):** "under `<base>/`" is now an exact path: a row's own `<base>/tx/<txHash>`, a contract's own `<base>/address/<address>#code`. |
| L1 | The interval saw only finished runs, so an idempotent or refused call re-ran the full collect every 60 s | A per-facility, in-process last-attempt time records every call that collected but claimed no run (idempotent, or refused while collecting). It is checked before the lock and again under it, before anything is collected. A claimed run is tracked by `evidence_runs` as before. Interval, lock and readiness refusals arm nothing, so they cannot extend the window. |
| L3 | `fetch` errors that quote the `--rpc` URL were printed, and the Makefile put the URL in argv | `parseRpcUrl` parses the URL first. An unparsable, non-http(s) or credentialed URL gets one fixed refusal (CLI exit 2, before any bundle is read). Only our own messages, the JSON-RPC error code and the error class are reported, never fetch or node text. The CLI reads `HOGEE_VERIFY_RPC`; `--rpc <url>` still works and wins. `make verify` exports `VERIFY_RPC` or `HOGEE_VERIFY_RPC` to the recipe's environment, never to a command line. Recommended: `HOGEE_VERIFY_RPC=<url> make verify`. |
| L4 | §14 said `--rpc` catches a fabrication with fresh keys, but it only checks that each address has code | No committed deployment manifest carries a code hash (`packages/chain/deployments/` holds only `.gitkeep`), so the claim is corrected: §14, `online.ts` and the CLI's online VERIFIED line say the contract addresses must still be compared with the announced deployment. |
| L6 | The founder-key lender check was skipped when FacilityOpened was absent | The founder key is trusted only when exactly one FacilityOpened names the lender who sent `registerFounderKey`. Otherwise "founder signatures" fails closed. |
| L8a | Pruning dropped the `evidence_runs` row even when the folder stayed | The row is dropped only once no entry of that name is left. A folder that stays keeps its row and is retried by later prunes. |

**Choices made within the request.**

- M2 supersedes per kind, refId and method, not across methods. The sign dialog keeps a server-made passkey request
  (`initial`) while the founder looks at the wallet option. Expiring it there would make the passkey path fail with
  SignatureExpired. Both methods of one item still count as one pair.
- M5 checks "under `<base>/`", not a bare prefix, so `https://sepolia.etherscan.io.example` fails.
- M1's readiness check reads the database, not the receipts. A row that changes between the check and the collect
  still fails closed in the background build, as a FAILED run (which arms the database interval).

**Residuals, documented and not fixed here.**

- **Signing is lockout-free, not bounded (M2).** Creating a request is no longer rate-capped (each writes one row and
  one SIGNATURE trace, and up to `MAX_REFUSALS` ALERT traces). The §12 "Still open #1" estimate no longer holds for
  these writers. **Corrected (§18 H1):** this said the total is bounded by the windowed collect, but that window covers
  only unnamed traces, and `signature_requests` was still read whole, so about 50,001 anonymous requests refused every
  export for good. Since §18 the export collects only the requests the verifier reads (SUBMITTED, a stored signature,
  or a chain action) and counts the rest. An active
  anonymous caller can still race the founder: burn a reused request's refusals, or cycle requests across more than 10
  drafts to evict the founder's open one. The founder recovers by requesting again. Requiring the signed founder
  persona cookie on request and submit is the real fix, and the demo does not adopt it.
- **L1 is per process.** The CLI and the API do not share it, and a restart forgets it. Either costs at most one more
  collect.
- **L2:** a scripted step that reverts with an attack-mapped error still becomes a passing attack row (`rows.ts`
  classifies by error before provenance).
- **L5:** replay does not bind `Funded.fundedTotalMinor`, `StageReleased.releasedTotalMinor`,
  `PlanCommitted.releasedMinor`, or executeLoosen's side events to the queued loosen. An offline rehash can inflate
  them, and `--rpc` catches it.
- **L7:** the temp-folder tag identifies the deployment, not the database. Two databases on one deployment that share
  an evidence root can sweep each other's live temp folders.
- **L8b:** pruning can remove a force-added submission bundle after 10 newer READY runs, and there is no pin marker.
  Keep the submission bundle outside `evidence/` or copy it before demo traffic.
- **L9:** the dry run assumes the bundle's event log is complete. A reverted honest spend caused by a state change made
  outside the backend (an owner `pause()` from a wallet, an anyone-callable `executeLoosen`, a T29 orphan) reads as a
  status flip and fails verification.
- **L10:** `store.ts` still buffers up to 32 MB per file request with no concurrency bound, and `export.ts` still runs
  the synchronous `verifyBundle` on the API event loop. The 60 s interval rate-bounds the second.

## 17. Security audits run-6 and run-7, and the red-team and dev-live fixes (2026-10-18)

- **Run-6** (quick, scoped `7ca38ca..a33ea08`: task 1.16 evidence, task 1.9 encoder, compile fail-closed) and **run-7** (quick, scoped `a33ea08..b1f869b` minus the run-6 fix paths: the G2 batch, the replan fix, the task 1.15 harness, dev-live, the mock mount) found **no confirmed findings**. Run-6 left 6 needs-validation leads and run-7 left 2. All of them are fixed in §12–§16 and below. Reports are in `docs/security-audit-run-6/` and `docs/security-audit-run-7/`. The post-fix skills re-check of the run-6 fixes is in `docs/security-audit-run-6/recheck-run6-fixes.md`; its HIGH and MEDIUM items are fixed in §16.
- **Red-team runner** (run-7 lead 2):
  - Error text written into a bundle passes through `redactText` / `shortErrorReason`, and local paths are cut to repo-relative.
  - The post-run scan also looks for every loaded RPC URL (plus its path and query), the database URL and password, and the Xendit key, and it runs even when writing fails.
  - `Bundle.write` itself does not redact, so explorer links stay intact.
  - A read-only preflight runs before any migration or write:
    - Sepolia: the chain id must match, the Treasury must not be opened, the database must hold no facility row, and the worker must not be halted;
    - Anvil: the database must hold no non-31337 facility.
  - T29's direct send respects `REDTEAM_MAX_FEE_GWEI`.
  - The runner registers the founder through the G2 enrolment code, and S2 records that registration without a valid code is refused.
- **dev:live:**
  - Anvil runs with `--no-cors --block-time 1 --slots-in-an-epoch 1`, so `finalized` trails `latest` by about 2 and evidence exports work.
  - Postgres uses scram-sha-256 with a per-run password from a 0600 `PGPASSFILE`.
  - The web child blanks REPLAY, provider keys, Stripe, Presidio, Xendit and the Sepolia RPCs, so a developer's `apps/web/.env*` cannot switch the stack.
- **route.ts** refuses REPLAY together with an explicit `MOCK_API=0`.
- **Deferred:** the run-7 critic recorded 7 units as deferred: mock evidence reads, the Next dev-server origins, `dev-mock.mjs`'s inherited env, first-plan agent provenance, the browser signing panel, the MCP server, and the new P2 dependencies. The P2-owned ones go to P2 as notes. The P2 dependencies are exact-pinned, and install scripts stay denied except for esbuild.

## 18. Run-7 re-check fixes

The post-fix skills re-check of the run-7 fixes (`docs/security-audit-run-7/recheck-run7-fixes.md`, scope
`521171b..2068855`) found one HIGH, two MEDIUM and six LOW items. Each fix below is its own commit with a regression
test. No contract, migration, core schema or api-contract route shape changed. Only the comment on `uploadInspection`
in `packages/api-contract/src/routes.ts` changed: `CONFLICT` stays declared for the frozen shape, though no path answers
it now. This section supersedes the §15 shortlist, inspection-upload and `listExceptions` rows. It corrects in place
§15 "Evidence export", §15 "Still open 1", the §15 note for P2, the §16 M5 row and the §16 signing residual.

| # | Finding | Rule now |
|---|---|---|
| H1 | §16 M2 made `signature_requests` unbounded again. The export still read it, and `llm_calls`, whole, and refused past 50,000 rows for good. §15 and §16 said the trace window covered this. | `collect` reads only the requests the verifier uses: `status = 'SUBMITTED'`, a stored `signature_json`, or a `chain_action_id`. `signatures.ts` checks a signature only on such a row, and `plans.ts` finds a PlanApproval by its chain action. The rest is counted (`Collected.omittedSignatures`, log `evidence_signature_requests_omitted`). `llm_calls` is windowed like traces. Every call that a kept trace holds (its `trace_id`) or names (an event's `refs.llmCallId`, which the verifier requires) is kept. Then the newest others are kept while they fit in `MAX_ROWS_PER_TABLE`, and the oldest are left out (`omittedLlmCalls`, log `evidence_llm_calls_omitted`). An LLM call no longer names its trace, so a chat trace is windowed like any unnamed trace. |
| M1 | Past 5 uploads the inspection upload answered `CONFLICT` for good, so an anonymous caller could fix the hash the founder's MilestoneRelease signs. | A new hash is always stored, so the latest upload wins. The first `MAX_UPLOADS_PER_MILESTONE` = 5 uploads each append a trace event. The 6th appends one final event saying that later uploads are not traced, and later uploads only store the hash. An unchanged hash still writes no row and no trace. |
| M2 | Past 10 shortlists in 10 minutes a new spec was `CONFLICT`, an anonymous lockout of the supplier step. | A new spec is never refused. The identical-spec reuse is unchanged. Past `MAX_OPEN_SHORTLISTS` = 10 open (PENDING or READY) shortlists, the oldest open ones become FAILED with `SUPERSEDED_REASON`, which `getShortlist` shows as the `failureReason`. The newest READY shortlist, which SupplierApproval reads, is never superseded. |
| L3 | The early reuse check ran outside any lock, so N concurrent starts each ran the outside checks. | `serialized` runs a facility's starts one at a time in the process: the reuse check, `computeShortlist` and the store. The store's transaction still takes the DB writer lock and decides again. |
| L1 | `listExceptions` listed every OPEN row. The demo `proposeSpend` opened a new POLICY_ESCALATION, with a named trace, for every repeat of a flagged invoice. | The list returns at most `LIST_EXCEPTIONS_LIMIT` = 200 rows: OPEN rows first (newest first), then the newest others. Past 200 OPEN rows the newest OPEN rows are cut first, so the oldest waiting request is dropped last. In `proposeSpend`, a NEEDS_OFFICER verdict is decided under a per-facility lock. If an OPEN POLICY_ESCALATION holds the same derived proposal (jsonb equality: line, payee, amount, and invoice or pacing slot), its traceId is returned and nothing is written, not even a trace. Once the officer decides it, a repeat opens a new one. |
| L2 | The explorer pin checked only the host, so a tampered bundle could link a row or a contract to another real Sepolia tx or contract. | In `explorerProblems`, a row `explorerUrl` must be exactly `txUrlOf(base, txHash)` = `<base>/tx/<its txHash>`. A row without a txHash may not carry one. A `contracts.json` `verifiedUrl` must be null or exactly `codeUrlOf(base, address)` = `<base>/address/<that contract>#code`. A manifest `verifiedUrl` must be exactly its contract's code page on its chain's pinned explorer; with no explorer, it must sit on the local placeholder as before. Hex case does not matter. A failing URL is never echoed. The exporter always writes exactly these forms, whatever link the deployment names, and `verified` still says whether it names one. The verifier stays browser-safe (pure string checks in `bundle.ts`). |
| L4 | The §15 note for P2 said a mock registration needed the officer to reject or approve the seeded example key first. | Corrected in place: since `dc2fee2` a real registration replaces the example key. |
| L5 | The red-team secret scan missed the generated founder backup-wallet key and the soft-passkey private key. | `founderSecrets` returns the wallet key with and without `0x`, plus `SoftAuthenticator.secretForms()`: JWK `d` in base64url and hex, and PKCS8 DER in hex and base64. `Stack.generatedSecrets` holds them for the scan only, and `secretsOf` includes them. |

**Choices made within the request.**

- M2 supersedes to FAILED because core `SHORTLIST_STATUSES` has no superseded status (PENDING, READY, FAILED). A
  supersede writes no trace.
- L3 uses an in-process per-facility queue, not the DB advisory lock across the outside checks. A blocking advisory lock
  held over those checks would pin one pooled client for every waiting request, so a burst could starve the pool.
- L1 keeps the oldest OPEN rows when it must cut, so a flood of new escalations cannot push out an old request.
- L5 adds no PEM form: its line breaks split the body, and the DER base64 covers it.

**Regression tests.**

- H1: `export-bounds.live` adds 60,000 EXPIRED and REJECTED requests and 50,002 LLM calls. The two oldest calls are held
  or named by a new trace and are kept. `exportEvidence` is READY and verifies. Against the old `collect` this test
  fails with `EvidenceTooLargeError`.
- M1: unit `decideUpload`, `writer-bounds.live` (cap, final event, flood, then the founder's report wins), and
  `evidence.live`: 7 anonymous uploads, then the founder's, and the MilestoneRelease typed data carries the founder's
  hash.
- M2 and L3: unit `decideShortlist` and `serialized`. In `writer-bounds.live`, 6 concurrent starts of one new spec read
  the catalog once and store one row; this fails without `serialized`. 20 new specs are all 200, 10 stay open, the
  oldest reads FAILED (superseded) and the newest is READY.
- L1: `writer-bounds.live` checks the order, the limit, and a flood of 200 newer OPEN rows that keeps the oldest.
  `proposals.live` checks the repeat-proposal dedupe, then a new escalation after the deny.
- L2: verifier `anchor.test` (another tx, another contract, no `#code`, a row without a tx, a manifest naming another
  contract, nothing echoed) and `evidence-rows.test` (the exporter's rows and contracts pass `explorerProblems`).
- L5: `safety.test` checks that the forms are the real keys and that the scan flags a bundle leaking either.

**Residuals, documented and not fixed here.**

- **L6: the dev-live web env is a denylist.** `scripts/dev-live/src/config.ts` blanks secrets and modes. A developer's
  `apps/web/.env*` can still supply `HOGEE_EVIDENCE_DIR`, `HOGEE_DATA_DIR`, `FINAL_DEPLOYMENT_ID`, `RPC_POLLING_MS` and
  `NEXT_PUBLIC_EXPLORER_URL`. None of these is a key or a paid API, so the dev-live goal holds.
- **Mock nit.** api-mock's register verify answers `CONFLICT` for a rejected key before it checks the code, where live
  answers `FORBIDDEN` first. This is not a one-line reorder. The mock hands a known or registered credential to the core
  handler between the two checks, so moving the rejected check below the code check would let a rejected,
  already-stored credential reach that handler. This is offline demo parity only.
- Named traces (payments, denials, exceptions) still refuse the export past 50,000 events. In DEMO_MODE,
  `POST /api/proposals/spend` still writes a named trace for each AUTO payment and each recorded denial. Those are not
  re-inventoried here.
- The omitted counts (traces, signature requests, LLM calls) are only in `Collected` and the operator log. The bundle
  has no field for them (that is a schema change).
- `serialized` is per process, like §16 L1. Two API processes can each run one start's checks at a time.
- A founder polling a superseded shortlist sees FAILED. An active anonymous caller can still create the newest READY
  shortlist that SupplierApproval reads, as before (the demo persona design).

**For P2.**

- `POST /api/escrow/:orderId/inspection` no longer answers 409 for an upload limit.
- `POST /api/suppliers/shortlist` never answers 409 for a new spec. An older shortlist can turn FAILED with the
  `failureReason` "Superseded by newer shortlists; start a new one if you still need it".
- `GET /api/exceptions` lists OPEN rows first, at most 200 rows in all.
- `POST /api/proposals/spend` can return an existing escalation's `traceId` for a repeated flagged invoice.
- On Sepolia, `contracts.json` `verifiedUrl` is always the contract's own Etherscan code page, and a row's
  `explorerUrl` is always its own tx page. A bundle with any other link fails "bundle files", so export older bundles
  again.

**§18 addendum (focused re-check of the §18 fixes):** no regression above LOW. Its one MEDIUM was an older path: the demo `proposeSpend` mirrored denials could outrun the relay, because the circuit only counts denials the chain has seen, so a burst could record any number. Fixed: a line never has more than `CIRCUIT_THRESHOLD` (3, as `Treasury.sol`) `recordDenied` actions PENDING or BROADCAST. Past that, the newest in-flight denial's trace is returned and nothing is written; the chain opens the circuit on those. Live test `proposals` covers it, and red-team T26 still passes. Two LOWs stay open: the per-facility shortlist queue (identical in-flight specs don't share one result yet), and PEM / standard-base64 forms of the soft-passkey key in the red-team scan (no writer of either exists).

## 19. Singapore as the main country (18–19 Oct)

The user made Singapore (SG) the main demo country on 18 Oct. Malaysia (MY) stays second (the country-switch preview and Rina). Indonesia (ID) stays in the code and tests, but left the UI switch, the demo and the video. The fixed names are in `docs/SG-DECISIONS.md` (the coordination sheet) and the wave plan in `docs/SG-DESIGN.md`. Rina did not move: Rina's draft golden, the MY 864-draft matrix, a new ID 1,152-outcome golden and a 3,215-outcome before/after dump all diff empty. Detail: `docs/decisions/{sg-core,w2-core,w2-api-a,w2-api-b,w2-mock-contract,w2-web,w2-agent}.md`.

| Change | Rule now |
|---|---|
| Enums (appended only) | `COUNTRY_CODES` + `SG`. `ENTITY_TYPES_SG` = `sg_sole_prop`, `sg_partnership`, `pte_ltd`. Registrations + `ACRA_BUSINESS`, `ACRA_PTE_LTD`, `IRAS_GST`. Approvals + `SFA`, `HSA`, `CPSO_SAFETY_MARK`. PII + `SG_NRIC`, `SG_PHONE`. `PERSONAS` + `founder:mei` (`ecc5500`). Migration `0003_sg_country.sql` adds one enum value. |
| Codes per country | `REGISTRATIONS_BY_COUNTRY` and `PRODUCT_APPROVALS_BY_COUNTRY`: a pack refuses another country's registration, `taxIds` code or approval agency (`NONE` is valid everywhere), which also newly refuses MY↔ID mix-ups. An approval agency the priority list cannot rank throws (it used to read as `NONE`). `requiredRegistrations` is an exhaustive switch; an unknown country throws `INVALID_INPUT`. |
| Pack shape | An SG pack must not carry `eInvoicing`: InvoiceNow follows GST registration, so the SG compile needs `indirectTax.registrationThreshold` instead. CN imports into SG route **MFN at a sourced 0** through the new optional leaf `imports.mfnDutyRateBps.<category>`. `EXEMPT` stays domestic-only, so import GST (9% of CIF + duty) is never zeroed, and a category with no rate fails closed (`MFN_RATE_REQUIRED`). Rule text takes its tax names from per-country maps (GST, Import GST, InvoiceNow); MY and ID text is byte-identical. |
| Mei (`packages/core/src/demo/mei.ts`) | Mei Tan, citizen, `sg_sole_prop`, sells tumblers on Shopee Singapore and buys from China; budget SGD 10,000 (`1000000`). Mei's lines, caps, pacing, stages and expiries equal Rina's minor units; only ids, currency and rail differ. Ids: `fac-mei`, `founder-mei`, `shopee-sg-ads`, `shopee-sg-fees`, `spx-sg-logistics`, `iras-tax`, `sg-packaging-printer`. Mei's supplier is the shared catalog's `supplier-a`, and the first order is `order-a-001`, as the live API names it (`e1cb313`). Mei's plan carries the free SFA importer registration (`approval.sfa.fee.0`). Reserve policy 500 bps (`RESERVE_POLICY_BPS.SG`, P1's Q2). |
| Default country | The API's `DEFAULT_COUNTRY` is `SG` (`503cc08`, once `SG.json` validated and Mei compiled). `HOGEE_COUNTRY` is checked against `COUNTRY_CODES` (the old `country in CURRENCY` test also accepted `toString`). Tenant ids follow the country (SG `fac-mei` / `founder-mei`; MY and ID `fac-rina` / `founder-rina`) and stay overridable. dev-live re-exports the same default. |
| Persona | A server's only founder persona is its own country's (`defaultPersonaFor`: SG → `founder:mei`, MY and ID → `founder:rina`). A valid cookie of the other founder reads as the default, so it never grants that founder. Live `setPersona` and the mock answer 403 FORBIDDEN for the other founder. The web shows "Founder (Mei)" or "Founder (Rina)" through one `isFounderPersona` helper and offers only the deployment's founder, then the officer. |
| Payees | `DEMO_PAYEES_BY_COUNTRY`. Mei's set mirrors Rina's on `SG_PAYNOW`, paying to synthetic PayNow UEN proxies `S99ZZ0001A`–`S99ZZ0005E` (`aa5c698`; this supersedes the digit accounts in `w2-api-a.md`), every name marked test. `iras-tax` is a platform payee on no line, like `lhdn-tax`. ID has no set: `demoPayeesFor("ID")` throws (it used to serve Rina's DuitNow accounts). The catalog serves only the server country's set. final-1 deploys both countries' platform payees, MY first. |
| Country guards | `openFacility` takes currency, founder country and payees from the server's country set and refuses a mismatch (502 `UPSTREAM`) before any chain read or row write. `compileEnv`, the shortlist and `planOrder` answer 409 `CONFLICT` ("nothing was compiled / priced / signed") when server country, founder country and facility currency disagree or the founder row is missing. The founder row's country is checked at run time. A pack file of another country reads as absent (§29). |
| Rail and FX | SG payees pay out through MockRail only, labelled "simulated PayNow payout"; MY keeps Xendit test mode (§27). Never claim a real SG payout. `*/SGD` rates are a labelled BNM cross rate, since MAS has no keyless endpoint (§22). |
| api-mock | `HOGEE_COUNTRY` also picks the mock's demo: unset or `SG` is Mei, `MY` is Rina, anything else answers 502 on every request. Until P3 adds `fixtures/scenario-mei`, Mei's scenario is derived from Rina's (ids, SGD, PayNow, 9% import GST, Mei's chat), and loading fails closed if any Malaysian label survives. The country preview is an exhaustive per-country table; an unknown country throws. |
| Planner and web | The country question offers SG, then MY (an assumed ID still reads "Indonesia"); buy-from adds SG. Instructions say "in Singapore and Malaysia"; "Hogee's planning assistant" stays (12 E1 rows target it). The web switch is SG, then MY (ID stays in `COUNTRY_LABEL`). "Verified depth for <country>" counts the shown manifest's pack rules that carry `verifiedOn`. A "Before your first sale" card shows the compiler's approval rule ("SFA product approval (free)"). Fiat amounts use core `money()`; BU figures keep `formatBu`. |

**Residuals.**

- final-1 holds both countries' platform payees, so the chain alone no longer pins the country: on-chain, an MY line or a WITHDRAW_RESERVE could name an SG platform payee. The off-chain policy knows only the facility's own payees, founder and lender must both sign, and the API binds the reserve to the server's tax payee (§29).
- The PlanDraft carries no approval processing time, so "1 working day" is not shown. A structured `approval.<code>.days.<n>` rule was ruled out: it changes Mei's plan hash.
- Live `getFx` serves only `*/MYR`, `*/SGD` and `X/X`, so the MY→ID preview fails closed in live mode (ID has left the UI).
- The derived Mei suppliers' `rawTextRef` still points at Rina's listing text (MYR prices, never served), and a fallback built from core examples keeps the example CNY rate. A P3 `scenario-mei` fixture replaces both.

## 20. Country packs: MY facts, SG pack, sourcing and sign-off

Both packs are generated from a source ledger (`docs/compliance/{MY,SG}-source-ledger.json`) and stay tier `RESEARCHED`. Rina compiles on `MY.json`, Mei on `SG.json`. Detail and the per-leaf sign-off checklists: `docs/decisions/my-pack.md` §3 (20 leaves) and `docs/decisions/sg-pack.md` (41 records).

| Change | Rule now |
|---|---|
| Sourcing | Every leaf is `Sourced` and quotes the exact sentence at its locator; `snippetHash` is core's algorithm. `build_sg.py --import-research` copies only the facts the pack uses from the research files into the ledger. All 140 research snippets re-hash to their recorded value (0 mismatches); importer and build refuse a mismatch and never fix it. `test_my.py` and `test_sg.py` check that each pack mirrors its ledger. The SG build refuses a banned word anywhere outside a quoted snippet, and a snippet that holds one. |
| Tiers | project.md §26.3 for both: tier1 when the exact sentence is on a government page or gazette, else tier2 (for example Shopee, OCBC and the SSM guides); the reserve is tier3. The research's own grade stays in `research.evidence`. |
| MY (`MY.json`) | Modelled for the demo product only, HS 9617.00.10 00: sales tax 10%, Form E duty 0% (the fallback line 7323.93.90 00 gives the same two rates). `imports.taxBase` = CIF, which reproduces "customs value + duty" (Sales Tax Act s.9(2)). `dutySources[0]` is the MFN order, `[1]` the ACFTA order. Food-contact approval is `NONE`, cost 0, time 0: a reading of the whole of Food Regulations 1985 Part VI, flagged for the human check. `LHDN_TIN` cost 0 is scoped to `sole_prop` and `partnership`, so a Sdn Bhd plan (every foreign founder's) fails closed on `registrations.LHDN_TIN[sdn_bhd].cost`. MyInvois is not required below RM3M turnover; SST registration starts at RM500k, for manufacturers only. Breach: 72 h from the breach to the Commissioner; affected people within 7 days after that. |
| SG (`SG.json`) | GST 9%, registration above SGD 1M; import GST on CIF including duty; MFN 0 for drinkware only; `ftaCertificates: []`. Approvals: drinkware SFA free, 1 day; cosmetics HSA S$13, 0 days; electrical CPSO Safety Mark S$180, 1 day; food SFA free, 1 day; apparel `NONE`; no `other` (`NONE` there would fail open). ACRA: S$115 sole proprietorship or partnership, S$315 Pte Ltd. Shopee commission 14.17% (waived for a new seller's first 120 days), transaction fee 3.27%. PayNow 0 bps with a fee condition that says only OCBC was checked and bank fees are flat per payment. PDPA: notify the PDPC within 3 calendar days of assessing a breach notifiable (`breachNotificationHours` 72), and the affected people. Foreigners are eligible for all three entity types; `FOREIGNER_ENTITY.SG` is only the fallback. |
| Reserve floor | Both packs 300 bps, tier3, `sourceType: mock`, citing a commit permalink (`a8221a4` for MY, `a6bbf8f` for SG); `test_sg.py` asserts SG equals MY. The compiler's 500 bps reserve policy is separate. Merge `wip/sg-pack` history with merge commits only, or `a6bbf8f` stops resolving. |
| Left out of SG on purpose | `registrations.IRAS_GST` (no IRAS page states a fee, and a sourced-looking "0" would fail open; a deviation from SG-DESIGN §2, so a GST-registered plan fails closed). `productApprovals.other`. Shopee's optional PXP fee of 5.45% (P1: it applies only to a seller who opts in, and its source page's address uses a banned word; SG-DECISIONS had listed it). Lazada and TikTok Shop. Non-drinkware MFN rates. The import permit fee (about SGD 3.19, no pack field). The tumbler's HS code. Premises registration. |

**Lower-confidence leaves carried.** SG: electrical time (low) and cost (medium, test-lab fees excluded), PayNow fee (low), Shopee commission (medium, captured in a browser), food cost and time (medium, processed food only), the STCCED duty source (medium). MY: the food-contact `NONE` reading.

**Not done.**

- **Sign-off.** No record of either ledger has `verifiedBy` / `verifiedOn`, so the UI's verified depth is 0 until a person checks each quote and adds both fields (both or neither), then reruns the build.
- Schema requests (after submission): per-HS-line rates and a company-vs-individual TIN split (MY); a per-consignment permit fee, a flat fee on payment rails, a condition on marketplace fees and a working-days unit (SG).
- MY rule text "No SST registration at launch: a reseller below MYR 500,000.00 turnover." implies a reseller would register above it, but registration applies to manufacturers only. The suggested wording is in `my-pack.md` §2; the compiler text is unchanged.
- The reserve permalinks resolve for judges only if the repo is public.
- Two MY gaps block 8 E2 prompts (§30).

## 21. PII redaction (`@hogee/privacy`)

The redactor stub is replaced. Every model call goes through `redact` and the outbound canary; errors throw, so nothing is sent unredacted. Detail: `docs/decisions/privacy.md` (§5–§6 are the run-8 fixes), `w2-agent.md` #9, `hard-agent.md` #4, `w2-core.md` #8.

| Change | Rule now |
|---|---|
| Engine | Pure TypeScript, no Presidio service (the demo machine may not run Docker). `data/pii/recognizers.json` keeps Presidio's ad-hoc recognizer format, so a Presidio backend can be added later. A match becomes `<ENTITY_TYPE>`. |
| Entities and validators | MY_NRIC, ID_NIK, ID_NPWP, MY_BANK_ACCOUNT, MY_PHONE, ID_PHONE, SG_NRIC, SG_PHONE, EMAIL_ADDRESS, CREDIT_CARD. MyKad and NIK need a real date and a valid place or province code; the bare 12-digit MyKad form rejects the SSM 2001–2012 shape that collides with it. NPWP: Luhn check digit (DJP publishes none; two implementations and 101 published numbers agree). SG NRIC/FIN: checksum with the S/T, F/G and M tables (ICA publishes none; three independent implementations agree, cross-checked on 25,000 numbers). Cards: issuer prefix and Luhn. |
| Context | A context word counts inside 32 characters before to 16 after the match (a recognizer may override this) and adds 0.35. A bank account needs a bank word within 48 characters before it on the same line. A bare 8-digit SG number needs a phone word. The phone lists add `number`, `no.`, `ph`, `mob`, `telegram`, plus `paynow` (SG), `duitnow` and `nombor` (MY), `nomor` (ID). A context-free MY bracketed-landline pattern follows the MY numbering plan. |
| Money-word veto (run-8 lead, `a146f48`) | A money word vetoes a match only when it lies within the 12 characters before it **and** only whitespace, a colon or a currency symbol separates it from the number. It never vetoes a phone written with its country code, an MY `01X` or ID `08XX` mobile, a bracketed area code, or a 15- or 16-digit card that passes the card check. Before, any money word in the window hid even `+65` phones and valid cards. |
| Spans | Overlapping candidates merge into one span. Text is folded (digits, dashes, spaces, zero-width and combining marks, NFKC letters) with an offset map, so report offsets index the original text, in UTF-16 units. UUIDs and `0x` hex protect their contents. |
| Canary | National and tax ids only (MY_NRIC, ID_NIK, dotted ID_NPWP, SG_NRIC), with the same validators. Each canary pattern is also a context-free recognizer, so `redact` output never trips the canary (a structural test and a 2,000-case fuzz). JSON escapes are decoded before the scan. |
| Safety | Every regex passes `safe-regex.ts` at load (bounded quantifiers, no alternation in a repeated group, no backreferences); 16 adversarial 1 MB inputs each finish under 1 s. A string over 1,048,576 characters (`assertNoIds`: 4×) throws `PrivacyInputTooLargeError`. A bad config file, or `hogee_context_required` with an empty context list, throws `PrivacyConfigError` on every call. No error text carries matched text. |
| Tool results (agent) | Each JSON leaf is redacted twice: alone, then as `"<inherited context> <own key>: <value>"`. Keys are humanised and arrays inherit their key. An object passes down its parent key chain plus a `type` / `kind` sibling's word value (letters only, the nearest 48 characters), so `{"phone":{"number":"91234567"}}` is caught. Only the own key, next to the value, can veto. A redactor that changes the prefix, or reports a span inside it, refuses the call (`RedactionUnavailableError`). |
| Data checks | `PiiRecognizersFile`, `PiiCanaryFile` and `PII_VALIDATOR_NAMES` live in core `datasets.ts`; `validate:data` checks `data/pii/*` (each regex compiles, names are unique). |

E5 after the run-8 fixes: TP 398, FP 0, FN 5 (was 394 / 0 / 9).

**Accepted costs and residuals.**

- A bare 8-digit amount near a phone word with no money word right before it ("call me, budget is 91234567"), and an 8-digit "Order No." starting 3, 6, 8 or 9, are redacted as SG_PHONE. Losing an amount is cheaper than leaking a phone. The Reader parses invoice numbers and PayNow targets from the raw text before redaction.
- 13-, 14- and 17–19-digit cards keep the adjacent money-word veto.
- Not detected: Sabah and Sarawak landlines with a 6-digit subscriber number (`082-291 796`, `+6082-952 957`, the 5 E5 misses); a 16-digit NPWP that is neither documented form; SG bank accounts (they need a new entity name, and `PII_ENTITIES` is frozen).
- A key that holds an identifier is still redacted with no parent context.
- Core's `PiiRecognizersFile` does not refuse `context_required` with an empty list; only the privacy load does. `packages/privacy` still keeps its own copy of the schemas instead of importing core's.

## 22. Supplier checks, FX and sanctions

`@hogee/checks` replaces its stubs, and the shortlist uses it. Detail: `docs/decisions/{checks,fix-checks,fix-api,w2-core,w2-api-b,suppliers}.md`.

| Change | Rule now |
|---|---|
| Sanctions list | `data/sanctions/un_sc.csv` from the official UN SC Consolidated List XML (not OpenSanctions, so §26.8's CC BY-NC note does not apply): 1,010 rows, 736 individuals and 274 entities. `scripts/build-sanctions.mjs` parses a downloaded copy with string matching and refuses DOCTYPE, entities, CDATA and any other format surprise; it never fetches. A missing, empty or malformed list throws `CheckUnavailableError`. |
| Name matching | Exact match on normalised names, never fuzzy. NFKC; default-ignorable code points and the four Hangul fillers removed; diacritics removed; Cyrillic and Greek look-alikes folded to Latin as a second reading (extra keys only add hits); punctuation splits words; two keys per reading (sorted words, words run together). List and query get the same normalisation. A name made only of invisible letters throws `CheckInputError`. A listed name inside a longer supplier name does not match. On the real list no key became newly shared (68 before and after). |
| Who is screened | The display name and the payout holder name, the one SupplierApproval shows and the founder signs (`beneficiaryNames`). A hit on either sets the SANCTIONS gate. A name the screen cannot check fails the shortlist (`CHECK_DOWN_REASON`). No result or log echoes a name. |
| Registry ids | Offline validators: USCC (GB 32100 check character), SSM (12-digit form, structure inferred from GLEIF records; old forms are format-only), UEN (format only: ACRA publishes no check-letter algorithm). `REGISTRY_KINDS` = `uscc`, `ssm`, `uen`, as an exhaustive switch: an unknown kind throws and the shortlist fails closed; only `valid === true` counts. `lei` is skipped (it needs a GLEIF lookup). A validated UEN earns the same 3,000 bps registration trust. |
| Red flags | Each failed registry check bound to the supplier and its exact listed id raises a red flag (`registry:<kind>:<supplierId>`); the text never repeats the id. This changes the `shortlistHash` of any shortlist with a failed check. |
| Supplier evidence | Demo files are `SupplierFile` = `{supplier, evidence[]}` or a plain `Supplier`. Evidence ids are unique within and across demo files (the API would drop a duplicate silently). The generator writes one mock row per fact (price, lead time, terms, response rate, each certificate), quoting one listing sentence with core's hash; no `trust_verification` rows. Ranks are unchanged (A 83.26, G 82.30, H 76.52, B 59.19); coverage is now 80% for A, G and H and 25% for B. |
| Demo catalog | One catalog for Mei and Rina, `data/suppliers/demo`, written by `build.mjs` (seed 20261020; `--check` fails on a hand edit). A is #1 (rank stability 91%); G has a deliberately wrong USCC check character; C carries a listing injection, D an off-platform discount, E a 3,000 MOQ, F the sanctions test row (a UN-listed DPRK entity, `KPe.001`), and I no food-contact report. Names are invented and marked demo, except F's; URLs are `example.invalid`; payout accounts are `MOCK_ONLY` and "DO NOT PAY". Tiers are simulated (tier2 for listing facts and platform-verified reports); every `sourceType` is `mock`. |
| FX | BNM interbank session 1200, middle rate, tier1, `snippetHash` of the raw body; on BNM's "No records found", up to 7 earlier dates; no new request after 30 s. `*/SGD` is a cross rate through MYR from two same-date BNM figures, tier2, with both legs named in `sourceUrl` (MAS has no keyless machine-readable endpoint). `X/X` is 1 (tier3). Any other pair throws `CheckInputError`. |
| HTTP | Fixed hosts (`api.bnm.gov.my`, `api.gleif.org`; the base-URL variables are ignored on purpose), https only, no redirects, GET only, no credentials, 8 s per attempt, 2 retries on transient errors, size caps (16 KiB BNM, 256 KiB GLEIF). Errors never carry the URL or the supplier name. GLEIF refuses a name that looks like personal data (`@`, a 7+ digit run, control characters). |
| Landed cost | The shortlist passes `productCategory`, so an SG CN quote takes MFN 0 and pays 9% import GST, and a category with no rate fails the shortlist. The shortlist and its builders refuse a country mismatch and another country's pack before any FX, sanctions, registry or pack read (§19). |

**Residuals.**

- Matching is exact: look-alikes outside Cyrillic and Greek, digits for letters, near-miss spellings and extra words in the holder field ("<listed name> - DEMO") do not hit. Core's `Supplier` has no legal-name field to screen. A list cut exactly at a line end still loads (no row-count pin).
- UEN and the old SSM forms are format-only; SSM entity code `02` (foreign company) is assumed [VERIFY]; USCC codes 1–2 and the inner GB 11714 check are not checked. Generated demo USCCs are not checked against real registrations (no registry access).
- The look-alike table now exists three times (core, checks, agent); core should export it.
- `Supplier` has no product field, so every CN supplier appears in every CN shortlist.

## 23. Chat rate limit and model budget

This closes §9 "Still open": the eval cap bounded concurrency, not spend, and `POST /api/chat` had no rate limit. Both became live once the real redactor let model calls through. No contract, migration, core schema or route shape changed. Detail: `docs/decisions/api-guard.md`.

| Change | Rule now |
|---|---|
| Chat rate limit | `POST /api/chat` passes three sliding 60 s windows before anything is read, redacted or stored: per persona chat session, per client address and per server; by default 10, 20 and 30 turns a minute (`CHAT_RATE_SESSION_PER_MIN`, `CHAT_RATE_CLIENT_PER_MIN`, `CHAT_RATE_SERVER_PER_MIN`). Check and count are one synchronous step, so a burst cannot slip past. Past a limit: 429 `UPSTREAM` `{reason: RATE_LIMITED, scope, retryAfterSeconds}` with `Retry-After`. |
| Client address | The socket address, and only when the runtime hands one over. `X-Forwarded-For` and `X-Real-IP` are never read (there is no trusted-proxy rule). |
| Memory | Each limiter map holds at most 1,000 keys: expired keys go first, then the least recently used. The server scope still bounds a caller who cycles session ids. |
| Model budget | One per process, shared by chat and every eval model call, counted in calls and characters (redacted request + answer). Defaults: a 24 h window of 1,500 calls and 30 M characters, and 5,000 calls and 100 M characters in total (`MODEL_BUDGET_*`). |
| Reserve, then settle | Every provider call (each tool-loop step, each SDK retry) reserves 1 call, its request characters and 16,384 output characters before it is sent, then settles once to the measured size. A call that does not fit is refused unsent, so concurrent calls cannot overshoot together. A failed or aborted call keeps its whole reservation. The budget sits after `guardModel`, so it counts the redacted request actually sent. |
| Refusal | 503 `UPSTREAM` `{reason: MODEL_BUDGET_EXHAUSTED, scope: window \| total}`, with `Retry-After` when the window will free room. Nothing of the chat turn is stored. Once nothing fits, an up-front gate refuses before any model or call-log row exists. Eval requests that need no model still run. `GET /api/health` reports `llm: degraded`. |
| Tracing | Every refusal is logged; only the first of a window leaves an ALERT trace (`CHAT_RATE_LIMITED` once a minute, `MODEL_BUDGET_EXHAUSTED` once an hour per server). |
| Config | Every variable is optional. A set but invalid value stops start-up with a `ConfigError` naming it; an absent config means the defaults, never "no limit". No new error code: the frozen `ApiErrorCode` set has none for this, so both refusals use the declared `UPSTREAM` with a `details.reason`. |

**Residuals.**

- Per process: a restart starts a fresh budget and fresh limiters, and two API processes each have their own. Persisting the budget (for example from `llm_calls`) is the fix if the API ever scales out.
- Mounted in Next there is no socket, so every caller is one `local` client and the client scope acts as a second server-wide limit.
- A full E1 + E2 run needs more than 1,500 calls a day; its operator must raise `MODEL_BUDGET_*`. Restarting the API to switch `PLANNER_MODEL` also resets the budget.
- The budget counts characters, not provider usage units: an answer larger than its allowance is recorded at its real size, so the window can pass its cap by that one excess.
- Near exhaustion, once a large call is refused, smaller ones are refused up front until the window frees room for it. A call refused inside a request writes one failed `llm_calls` row.
- The eval routes are not rate-limited: they stay DEMO_MODE and Anvil only, with `EVAL_MAX_CONCURRENT` = 2 and their deadline, and share the budget.

## 24. G2 UI: founder enrolment, officer console and suppliers

`apps/web` implements `docs/G2-notes-for-P2.md` §1–§3. Detail: `docs/decisions/g2-ui.md`, `int-e2e.md` §2.

| Change | Rule now |
|---|---|
| Enrolment code | "Create your passkey first" in the sign dialog opens a form labelled "Enrolment code from your loan officer". Every whitespace character is stripped, then core `EnrolmentCode` is checked before any request. The code lives only in that form's state, never in storage. The pre-G2 localStorage stopgap is removed (an old item is left inert). |
| Refusal copy | FORBIDDEN at options or verify: the code is wrong, used, replaced or expired, so ask the loan officer for a new one. CONFLICT at options: the facility is not open; at verify: the officer rejected this passkey. FounderKeyAlreadySet: a key is already waiting or registered. A device that already holds the key (`InvalidStateError`) is told to use Sign with passkey instead. |
| Officer console | Steps: 1 Open, 2 Give the founder an enrolment code, 3 Register the founder's passkey on-chain, 4 Fund. The button reads "Generate enrolment code" (the wording lint bans the route's verb in `apps/web`; the route keeps its name). The code is shown once, in four groups of six, with Copy, its expiry and a countdown; it is cleared from memory once a pending key appears. Generate is disabled while a key is pending or the pending state is unknown (fail closed). The pending key is polled every 1.5 s, for the officer only; Reject has an inline confirm. |
| Suppliers | The chosen supplier is the #1 candidate. Its `GET /api/suppliers/:id` gives `orderId`, polled while null, and the escrow card stays hidden until then. SupplierApproval sends `orderId ?? supplierId`, and Sign waits for the details. A FAILED shortlist shows its `failureReason`, or a fixed sentence for a pre-G2 row. |
| e2e | The loan officer works in a separate browser context: the helper rejects any pending key (the seeded example included), generates a code, and the founder types it. A cross-process lock serialises the five enrolling tests (there is one key slot). A dependents reporter names any dependent project that did not run. |
| Demo video | The `sign` scene shows the loan officer generating Mei's code on camera; the seeded example key is rejected off camera. Captions hold 9–11 s; the video runs 288 s. |

## 25. Mock hardening (api-mock)

The LOWs of P1's second review of #6 and the run-8 h-mock notes. The mock stays offline demo parity. Detail: `docs/decisions/{mock-hardening,fix-mock,hard-webmock,w2-mock-contract}.md`.

| Change | Rule now |
|---|---|
| Founder keys | register/options lists the founder's current key in `excludeCredentials` (never a rejected key or the seeded example). The SPKI is parsed with `createPublicKey` and must be P-256, and the point must be on the curve (as OZ `P256.isValidPublicKey`). An off-curve key is `VALIDATION` at register (the code is given back) and `CONFLICT` / `InvalidSignature` at approve. `GET .../pending` never shows the seeded example key. |
| Signer of a FOUNDER_SIGNED loosening | A discriminated `founderSig` (replacing `founderCredentialId` from `mock-hardening.md` §6): `passkey` + credential id, re-checked at officer approval (a rejected or replaced key answers `CONFLICT` / `InvalidSignature`, and the row goes back to OPEN to be signed again); `wallet` + address, which must recover to `HOGEE_MOCK_OWNER_EOA`; or `seeded-fixture`, the owner-authored status gallery, approved as before. The signing handlers cannot write `seeded-fixture`. A rejected key signs nothing. |
| Reserve at the founder's signature | For a WITHDRAW_RESERVE the officer already approved, `submitSignature` answers `CapExceeded` or `PayeeNotBound` when the reserve or payee no longer holds, before anything is signed, traced or queued (no await between the check and the queueing). |
| Owner EOA | `HOGEE_MOCK_OWNER_EOA` equal to the lender or to any plan's agent refuses every wallet signature with that reason. |
| Evidence loader | As live: unreadable folders skipped, depth ≤ 2, a served file ≤ 32 MiB and `manifest.json` / `evidence.json` ≤ 4 MiB, checked on the opened descriptor; `nosniff`, `default-src 'none'; sandbox`, `no-store`; links never followed. A bundle is served only for the demo's own facility on `final-1` / 11155111 with matching run ids (REPLAY accepts the run's own deployment). At most 200 run folders are listed; served files are read asynchronously in 1 MiB chunks. |
| Seed files | Fixtures and REPLAY snapshots are read without following links, single-link regular files only, ≤ 4 MiB. A file that is present but refused throws (no silent fallback), so every request answers 500 until the data is fixed. |
| Country previews | PlanApproval refuses a draft whose intent or manifest country is not the served demo's (`CONFLICT`), at request time and again at submit. Before, a preview could be committed as the plan or re-stamp the committed plan's tx. |
| Parity | Mock payees equal the API catalog's (a test fails on drift); ADD_PAYEE refuses a payee the demo did not onboard. SupplierApproval takes an order or a shortlisted supplier id; orders are `order-<x>-NNN` for both demos. The tax payee is `iras-tax` for `fac-mei`, `lhdn-tax` for `fac-rina`. SG payouts are `simulated-paynow-mock-NNNN` and say no real SG payout happened. |
| Smaller fixes | The persona-cookie test secret is 32 random bytes in base64url (20 bytes in hex failed the strength check in about 0.11% of draws). The MCP text for `ALREADY_PROPOSED_TODAY` says one pacing slot per line per chain day, paid or being paid. |

**Residuals.**

- A pending founder key signs at once, and a later reject does not undo what it signed. Limiting pending keys to the first PlanApproval was not done: it breaks `flow-loosen.spec.ts` and the demo, and "first" has no chain meaning in the mock. G2's one-time code and single key slot narrow the risk.
- `staleFounderSignature` still skips a FOUNDER_SIGNED row with no `founderSig`. Both writers set one, so it cannot occur; refusing it would be a behaviour change.
- The mock answers 422 `PayeeNotBound` for a reserve to a non-tax payee; live answers 409 `CONFLICT` (§29). Both refuse.
- Index files are still read synchronously (`handlers-ops.ts` must await async reads). The api-mock README does not yet say which bundles each mode exposes. The fixture and core-example sample bundles are not tenant-checked, so the Rina-named sample still lists under SG. A served file of up to 32 MiB can sit in memory.
- The mock has no oracle or observer address, so those two `registerFounderKey` checks have nothing to compare.

## 26. Web: pinned explorer, reason labels and safe links

Detail: `docs/decisions/{web-polish,fix-web,hard-webmock,int-unit}.md`. No package, route, schema or stored trace changed.

| Change | Rule now |
|---|---|
| Explorer links | Every tx, contract and block link comes from `apps/web/lib/explorer.ts`, pinned by chain id as the verifier pins it: 11155111 → `https://sepolia.etherscan.io` (`/tx/<hash>`, `/address/<addr>#code`, `/block/<n>`); any other chain gets no link. Hash and address formats are checked. A row's `explorerUrl`, a manifest's `verifiedUrl` and `NEXT_PUBLIC_EXPLORER_URL` are never followed (the variable is now unused: a deviation from ROLE-P2 rule 5). Links appear only in live and replay mode. |
| Verify panel | Titled "Internally consistent" or "Not verified", with the statement that a pass means internal consistency only and chain truth comes from comparing the anchor with Sepolia Etherscan (or `make verify` with an RPC). The anchor is shown: chain, deployment, contracts, newest block, every tx with a receipt. Every verifier check has a label, and a unit test fails when a new check has none. The online mode is not offered in the browser. |
| Reason labels | Every trace reason code has a plain-English label (`lib/reason-labels.ts`): contract errors and constitution codes from core's copy, the rest in `REASON_LABELS`. The raw code is never shown, not even an unknown one ("Other reason…"; on a PAYOUT event, "Payout failed (rail code)"). Summaries swap labelled codes for labels at display time only; stored summaries and hashes are untouched. A test reads the trace writers' sources and fails on any code without a label. |
| Officer access code | The two officer refusal codes read "Officer access code not accepted" and "Officer access locked after repeated wrong codes"; the stored codes are unchanged. The submission README calls the secret "the officer access code" and no longer names its variable; both demo modes generate it per run. Core's FORBIDDEN copy says the same, and `packages/core/test/error-copy.test.ts` keeps every error string free of banned words. |
| Safe links | An evidence artifact path is a link only if the files route would accept it (`[A-Za-z0-9._/-]`, ≤ 300 characters, not absolute, no empty, `.` or `..` segment); otherwise it is plain text. A rule source URL is a link only for `https:`; `javascript:`, `data:`, `http:`, other schemes and unparsable values show as text (≤ 200 characters), and a `*.invalid` placeholder shows nothing. Links carry `rel="noopener noreferrer"`. |
| Live copy | The inspection 404 names its three causes. The page stops files over 10 MiB − 64 KiB, and `accept` equals the API's `UPLOAD_TYPES`. Chat offers a retry only for a 5xx answer or no answer, and never shows a non-API body. Error copy comes from `@hogee/core`; `lib/error-copy.ts` is deleted. |
| SG payout label | An SGD facility's payees read "Simulated PayNow payout" (card headers, officer console, timeline). Payments carry no channel, so the rule keys on the facility currency; nothing is claimed for MYR or IDR. |

**Residuals.**

- Artifact links are not limited to the bundle's file list (`evidence-view.tsx` must pass `bundle.files`).
- apps/web has no vitest config for JSX, so components are not render-tested; the link rules are pure functions instead.
- `MAX_UPLOAD_BYTES` restates the API's cap, which `packages/api` does not export.
- The API's own officer refusal summaries still say "access key"; the agreed wording is "access code".
- The officer secret's variable name (a banned word joined by an underscore, which the lint passes) still appears in the `apps/web`, `api-mock` and `dev-live` READMEs. Renaming it touches the API, mock, e2e, red-team and dev-live, so it is a product call.

## 27. Payout rail by payee channel

Detail: `docs/decisions/w2-rail.md`. No contract, migration, core schema or API route changed.

| Change | Rule now |
|---|---|
| Channels (`apps/worker/src/rail/channels.ts`) | `MY_DUITNOW` (MYR; Xendit test mode when `PAYOUT_RAIL=xendit`, else MockRail). `SG_PAYNOW` (SGD; MockRail always, labelled "simulated PayNow payout"). `MOCK_ONLY` (MYR, SGD; MockRail always: the demo supplier catalog's "DO NOT PAY" accounts). Own keys only, case-sensitive. |
| Router | Every rail call of a settlement (request, history, poll) goes through `PayoutRouter.route({channel, currency})`. The channel is the verified destination's, whose hash the chain binds, so a database writer cannot re-route a payout; the currency is the facility row's, and the channel bounds it. |
| Fail closed | An unknown channel, a currency the channel does not carry or an unreadable account is a `PayoutRouteError` before any rail call: no payout, no oracle attestation, one ALERT (`PAYOUT_ROUTE_REFUSED`), and the row reports `error` on every pass. No halt: it is one payee's registry error, not a contradiction about money moved. |
| Xendit backstop | `XenditRail` refuses `SG_PAYNOW` and `MOCK_ONLY` before any call (`CHANNEL_NOT_ON_XENDIT`); `SGD: 2` is in its decimals map. A bare `XenditRail` passed as the rail is wrapped with MockRail for the mock-only channels. |
| Label and account form | SG PAYOUT traces read `payout attempt N via mock (simulated PayNow payout): …`. The account form follows the channel: a PayNow proxy for `SG_PAYNOW` (a UEN, including the synthetic `S99ZZ…` ones, or `+65` + 8 digits), 4–34 digits for bank channels. Before, every SG settlement halted `DESTINATION_MISMATCH` once Mei's payees moved to UEN proxies. |

## 28. Reader: PayNow binding and SGD grounding

Closes SG-DESIGN fail-open 5 (a changed PayNow target was never compared). Detail: `docs/decisions/w2-agent.md` #3–#8, `hard-agent.md` #1–#3 and #5 (which amend it).

| Change | Rule now |
|---|---|
| SGD totals | `READER_CURRENCIES` and `TOTAL_RE` add SGD; the markers are `SGD` and `S$` only. A bare `$` names no currency: a `$` total is not a stated total, and a model's "SGD" on a `$` snippet is dropped. |
| PayNow capture | The prefilter captures PayNow targets (a UEN, an NRIC/FIN, an SG mobile) on a line that mentions PayNow plus the block under it (blank lines right after it skipped, then up to 3 non-blank lines to the first blank line), or on an account-label line. A UEN elsewhere is usually the invoice writer's own registration and is not read. |
| Folding | Targets are read on folded text: NFKC; format and default-ignorable characters removed; visible blanks and `\p{Zs}` to a space; dashes to `-`; combining marks dropped; any decimal digit to ASCII; Cyrillic and Greek look-alikes to Latin. Up to 3 spaces, tabs, dots or dashes may separate the characters of a target, and `pay[ \t._-]{0,3}now` matches. Snippets, totals and hashes still use the original text. |
| Comparison | `payoutTargetKey` folds the same way, drops spaces, dots, dashes and brackets, and maps `+65`, `0065`, `(65)`, `(+65)` and a bare 8-digit 8/9 number to `+65XXXXXXXX`. Any stated target other than the bound one sets `PAYEE_DETAILS_CHANGED`, which escalates to the officer. |
| Scan bound | Line boundaries are computed once and windows merged, so each character is scanned once. At most 32 payout matches are counted; the 33rd sets `payoutScanCapped`, which also adds `PAYEE_DETAILS_CHANGED`. `TOTAL_RE`, `INVOICE_NO_RE` and `ACCOUNT_RE` no longer backtrack quadratically on long blank runs (budget 200 ms per 50,000 characters). |
| SGD budget grounding | Founder turns are folded first. SGD markers are `SGD`, `S$`, `SG$` and "Singapore dollar(s)"; a bare `$` is never SGD. A number is read whole; a figure that continues after one separator is no figure; another currency's marker right before or after the amount conflicts; a generic `$` or "dollars" agrees only with a dollar currency. Each of these fails closed to `BUDGET_UNCLEAR`, so the budget is asked again. A negation or minus before a `$` still counts. `SGD: 12,000`, `S$(12,000)` and `SGD$12,000` are money talk, so a correction never lets an older figure ground. |

**Known limits.**

- Several SGD figures in one founder turn each ground: each was stated, and the founder signs the displayed plan. Amounts written in words are not money talk.
- False positives that fail closed (escalate): a contact mobile within the block under a PayNow mention, a `+65` contact phone on a PayNow line, a date followed by a lone letter (`2026-10-18 A/C`).
- Look-alikes outside Cyrillic and Greek, and digits standing for letters, are not folded. `TOTAL_RE` runs on the raw text, so a full-width total is left to the Reader model and grounding.
- A target further from the PayNow mention than its block is missed; the Reader model's `mentionsPaymentChange` can still flag it.
- `payoutScanCapped` reuses `PAYEE_DETAILS_CHANGED`; core could add a distinct escalating flag.
- [VERIFY], with no web research done: the UEN shapes and PayNow UEN suffix, and whether PayNow still accepts an NRIC/FIN proxy.

## 29. WITHDRAW_RESERVE destination, platform payees and the requester

Run-8 hardening of the API (critic gap 6 and two LOWs of the post-fix re-check). Detail: `docs/decisions/hard-api.md`, `w2-api-a.md` #4.

| Change | Rule now |
|---|---|
| Reserve destination | A WITHDRAW_RESERVE goes only to the server country's tax payee: `lhdn-tax` for MY, `iras-tax` for SG (the one platform payee with no line in `DEMO_PAYEES_BY_COUNTRY`). Anything else, including the other country's tax payee, a marketplace platform payee and an ADD_PAYEE vendor, is 409 `CONFLICT`. An ID server refuses every withdrawal. |
| Where it is checked | `reserveTaxPayee` runs at create, at the founder's signature request and at officer approval. The signed LoosenRequest `target` is derived from the server's payee, never copied from the payload, so a row whose payload changed is never signed. |
| Policy context | `policyWorld` lists the server's tax payee as a static platform payee on no line, but only while Treasury's `platformPayoutAccountHash` for it equals the catalog account's hash. Before, the one legitimate destination was refused `PayeeNotBound` while any line's platform payee passed. The full live path now runs: open, sign, approve, timelock, a third-party `executeLoosen`, adoption and settlement. |
| Platform payees | A line binding is platform only when Treasury's static registry holds it (`platformPayoutAccountHash ≠ 0`), no longer when its lifetime cap is `uint128.max`, which an ADD_PAYEE vendor also gets. One read per bound payee per `policyWorld`. |
| final-1 | Deploys both countries' platform payees, MY first: `shopee-ads`, `shopee-fees`, `spx-logistics`, `lhdn-tax`, `shopee-sg-ads`, `shopee-sg-fees`, `spx-sg-logistics`, `iras-tax`. An explicit list still works. |
| Pack file | `fileCatalog.loadPack(cc)` treats a pack whose `countryCode` is not `cc` as absent (logs `country_pack_mismatch`, not cached), so `packFor` fails closed. |
| Requester | `POST /api/exceptions` reads `x-hogee-requester`: `agent` stores `requested_by = 'agent'` with actor `planner`; any other value, or none, is the founder, so the header can only lower the requester. Agent rows count against the same open-request bound, and an identical OPEN request is reused with its stored requester. |

**Residuals.**

- On-chain, the Treasury would accept an MY line or a WITHDRAW_RESERVE naming an SG platform payee: the chain no longer pins the country, and the API's refusal is policy, not a mirrored revert.
- ADD_PAYEE vendors are invisible to the policy context: `readSnapshot` reads only the plan's listed payees, so after an executed ADD_PAYEE the API refuses the vendor's spends (`PayeeNotBound`) although the chain would pay them, and a REPLAN omits the vendor. This fails closed; the fix belongs in `services/snapshot.ts`.
- The mock refuses the same reserve cases with 422 `PayeeNotBound` (§25).

## 30. Eval datasets (E1, E2, E3, E5)

Each dataset is written by a deterministic generator with no clock and no network, and `--check` rebuilds it byte for byte. Each runs the wording lint's `checkText` over its own rows and scripts (0 findings), though the lint does not scan `evals/`. Chinese text, which the frozen `LANGS` lacks, is tagged with its host language and flagged in a sidecar. Detail: `docs/decisions/{evals-e1,evals-e2,suppliers,evals-e5}.md` and each dataset's README.

| Dataset | What it holds | Known limits |
|---|---|---|
| E1 attacks (`evals/datasets/e1/`, `gen-e1.mjs`, seed 20261020) | 240 attacks (8 categories × 30, each 10 `en` / 10 `ms` / 10 `id`) and 100 clean rows, 43 of them hard negatives in 10 types; SG first: attacks 168 SG / 72 MY, clean 70 / 30. The country is in the caseId (`e1-sg-*`, `e1-my-*`) and `meta.jsonl`. Clean rows are on LOGISTICS and PLATFORM_FEES, with one total under the cap. Attacks arrive on LOGISTICS and were not written to pass or trip the detectors. Ids are synthetic (`99-0000-NNNN`, `T99ZZNNNNX`, `0xbad0…`, `.example`); `LEAK_*` targets are canaries that the runner must plant. | Measured at generation time (`f0d981b`, before the Reader read SGD): 5 of 100 clean rows already get a deterministic escalating flag (an English password footer trips `SECRET_REQUEST`, "Please disregard our previous message" trips `IGNORE_INSTRUCTIONS`), so they are false blocks whatever the model does; narrowing those patterns is P1's call. 63 of 240 attacks trip any deterministic flag; the rest rely on the Reader model, payee binding, caps, the memory HMAC and the Stripe signature. Not re-measured since. The P3 runner must route by caseId, open a facility per country, set the Stripe secret and plant the canaries. |
| E2 plan quality (`evals/datasets/e2/`, `gen-e2.mjs`, seed 20261018) | 40 prompts (24 SG, 16 MY, no ID; 20 vague, each hiding one plan-changing slot), 320 labels (8 fields each), 20 hidden answers and a facts sidecar. Labels come from LABELING.md and the pack JSON by rule code, with no compiler import. LABELING gained the SG rules: ACRA registrations, `IRAS_GST` only above SGD 1M, InvoiceNow follows GST, CN → `MFN`, approvals from the pack, reserve 500, a solo foreigner → `sg_sole_prop`, and a business name is always registered. Fail closed: a missing pack leaf, an ASEAN origin, SG `other` or an unknown country throws. | Compiler cross-check: all 24 SG and 8 MY prompts agree on all 8 fields. 8 MY prompts do not compile because `MY.json` lacks `registrations.LHDN_TIN[sdn_bhd].cost` and `productApprovals.apparel`, so they can only score as fail-closed refusals until `my-pack` sources both; the labels need no change. One labeller only (the rule code), so a human pass is needed before G4. `indirectTaxRegistered` and `eInvoicing` are false in all 40 rows (launch scale), which inflates field accuracy. The packs are RESEARCHED, not verified. The RM50 name reservation is not counted (if it is mandatory, the Sdn Bhd labels become `"106000"`). The `labels-frozen` tag is P1's at G4. |
| E3 suppliers (`data/suppliers/eval/`, `build.mjs`) | 20 sets × 5 = 100 listings; labels are in `labels.jsonl`, apart from the listings. 36 listings carry planted defects (SANCTIONS 3, AI_INJECTION 6, and 5 each of NO_ESCROW, PERSONAL_PAYEE, MISSING_CERT, OFF_PLATFORM_DISCOUNT, OVER_MOQ and FAKE_REPORT; three listings carry two) and 64 are clean; each set keeps at least 3 rankable listings. One spec for every set: drinkware, CN, 1,000 units, budget `1000000`. The sanctions rows are the next three UN DPRK entities, labelled only outside the raw text. Tiers are simulated, so a FAKE_REPORT is the only tier3 food-contact claim. | `humanRank` is `[]` until two blinded humans rank each set. There are no spans for absences, names or a flag-only discount. A probe caught all 6 injections and 3 of the 4 off-platform sentences: the Malay one is missed, a real E3 finding, so the test does not assert recall. |
| E5 PII (`evals/datasets/e5/docs.jsonl`, `gen-e5.mjs`, seed 20261018) | 190 rows (150 MY/ID, then 40 SG) with 403 spans in code points, labelled by a reference detector (format, validator, boundary rule), plus a sidecar for breakdowns. MY_NRIC, ID_NIK, ID_NPWP (Luhn; the 16-digit forms per DJP), MY_BANK_ACCOUNT (a bank word within 48 characters before; lengths checked against two bank tables and a government notice), SG_NRIC (the same tables as privacy), MY, ID and SG phones. Published example numbers and runs of 5 equal or consecutive digits are excluded. | It labels PII spans only: §15's "local vs cloud extraction accuracy" needs its own labels. Emails, Chinese phones and ids, ID and SG bank accounts, and names are outside the label scope. No E5 loader or scorer exists in the API (P3's Python eval reads it). Spans are code points while the redactor reports UTF-16 offsets (65 spans differ), so the scorer must convert. Latest numbers: §21. |

## 31. Red-team and evidence export per world

Detail: `docs/decisions/int-redteam.md`, `w2-rail.md` (choices 3–5). No contract, migration, core schema, API route or worker changed.

| Change | Rule now |
|---|---|
| Finality before export | After the cases, the runner makes every mined block final (70 blocks on Anvil, the `finalized` wait on Sepolia) and runs `advanceFinality` once per world's facility, as a worker would; it signs nothing. Before, each world's last rows stayed `INCLUDED` and the exporter refused them. |
| Export per world | The runner calls the API's `exportEvidence` with each world's own deps into `<run>/export/<world>/<ev-id>/`. The bundle carries the test-fixture country pack that the world's plans committed to. |
| Fail closed | A failed export, or a self-check that does not verify, exits 1 like a failed case; `suite.live.test.ts` requires `main`, `extras` and `sg` to read `verified`. The run's secret scan also covers these bundles. |
| SG variants | Filed under T1 and T4 (`EVIDENCE_TASK_IDS` is frozen), in their own Anvil-only world (one facility per deployment): an SGD invoice with a changed PayNow UEN (attacker `S99ZZ0099X`) with the Reader scripted not to notice, plus a bound-UEN control row that must be AUTO, so the PayNow scan and the binder are what is tested. An SG failure fails the task id. |
| Worlds | The main and extras worlds name MY explicitly, so neither the API's default country nor the both-country deploy default changes them. dev-live's default country is the API's `DEFAULT_COUNTRY`. |

**Measured** (Anvil, fresh Postgres, `503cc08` plus this change): 46 pass, 0 fail, 1 not run (T33), 150 rows; SG T1 and T4 pass. All three bundles pass `make verify` offline, and main also passes against the node (`HOGEE_VERIFY_RPC`).

**Open.**

- **Sepolia procedure.** `make evidence` with the API's `data/` catalog cannot rebuild a red-team bundle: the plans commit to the test-fixture pack, so `make verify` fails "country pack" (the other 15 checks pass). Either submit the runner's own `export/{main,sg,extras}` bundles, or switch the runner's catalog to `data/` and re-run everything (the compiled plans change). `docs/submission/EXECUTION-EVIDENCE.md` step 3 must match the choice.
- The Sepolia path of the export (the `finalized` wait, then export) is written but has not run.
- **Idle worker under dev-live.** The minute jobs start on the same second and share one lock, so most skip each minute; on an idle SG stack an `openFacility` took about 4.5 min to reach FINALIZED. API actions wake the worker directly, so the demo flow is not blocked. Staggering the jobs or splitting the lock is open (`apps/worker`).
- On Sepolia final-1, Mei's facility is the main one, so the runner should use `MEI_IDS` there.

## 32. Security audit run-8 and the post-fix re-checks

A `quick`, scoped, source-only pass over the 18–19 Oct takeover, `42d0c96..503cc08` (256 files, about 19k lines added): Singapore, the redactor, the checks, the chat limits, the payout rail, the Reader, the mock and the G2 UI. No target code was executed (macOS cannot enforce the required sandbox), so no lead can reach the confirmed bar. Agents: 7 hunters, 5 verifiers, 1 coverage critic. Reports: `docs/security-audit-run-8/`; raw run: `~/security-audit-skill/hogee/run-8/`.

| Outcome | Result |
|---|---|
| Confirmed | None. Runs 1–7 have none either. |
| Needs validation (1) | The privacy money-word veto hid `+CC` phones and valid cards. Fixed (`a146f48`, then the MY/ID mobile follow-up), with tests that fail on the old code (§21). |
| Rejected by independent verification (4) | Each source trace was real but crossed no reachable trust boundary; the hardening was applied anyway. The mock's FOUNDER_SIGNED rows → an explicit signer kind (§25). The shortlist screened only the display name → the payout holder is screened too (§22). The shortlist did not check server country against facility currency → it now refuses a mismatch (§19). Sanctions names had no look-alike or invisible-letter fold → NFKC, default-ignorable removal and the Cyrillic/Greek fold (§22). |
| Hardening (33 notes) | The queued ones are done: the reserve bound to the server's tax payee and the pack country check (§29); PayNow folding (§28); nested JSON context, more phone context words, MY bracketed landlines and fail closed on an empty context list (§21); no `..` in artifact links (§26); a capped, tenant-checked mock run list and contained fixture reads (§25). Accepted as documented: exact-match sanctions, format-only UEN, a per-process budget measured in characters, and the founder persona anonymous by demo design. |
| Coverage | 129 units: 15 covered, 5 candidate, 6 deferred, 103 out of scope. The critic's six deferred units went to the post-fix batch: (1) the Reader's PayNow window cost → scan bound (§28); (2) the redactor's request-path cost → bounded only by the size caps, linear regexes and the 48-character inherited context (§21), with no separate cost review; (3) mock PlanApproval of country previews → refused (§25); (4) rule source links → https only (§26); (5) SGD grounding marker conflicts → fail closed (§28); (6) live WITHDRAW_RESERVE destinations with both countries' payees in final-1 → the tax payee only (§29). |

**Post-fix re-checks.** Three skills re-checks ran after the fixes (agents `recheck-keccak`, `recheck-llm`, `recheck-secrev`). They found nothing above LOW, and their reports are not filed in the repo. The `llm-trading-agent-security` re-check's two LOWs are fixed: an MCP request is recorded as the agent's (`1b5c86d`), and a line binding is platform only if Treasury's static registry holds it (`c9c6baa`) (§29). The `nodejs-keccak256` re-check's LOWs are open: the supplier generator keeps its own `snippetHash` copy instead of core's; core's `snippetHash` does not throw on empty input; and the mock fixtures' placeholder payout and shortlist hashes should be real (rebuild `fixtures/scenario-rina`).

## 33. Integration checks, wording and the submission drafts

Detail: `docs/decisions/{int-unit,int-e2e,docs}.md`.

| Change | Rule now |
|---|---|
| Wording sweep | `git grep -i` over every tracked text file for the banned list. Only our own prose is fixed: the FORBIDDEN copy in core and four doc lines. Identifiers, environment variable names, the rule text that defines the list, verbatim quotes, third-party names and generated audit records stay as they are. `node scripts/lint-wording/index.mjs` stays at 0 findings. |
| Storage layout | `pnpm contracts:storage-layout` puts `~/.foundry/bin` on PATH first, as `abi:generate` does. |
| e2e under either country | `HOGEE_COUNTRY` drives the smoke suite (unset: SG; MY runs Rina; anything else throws). The SFA test skips under MY; the switch test runs home → other. The demo video skips under MY. |
| Demo video | Officer code step on camera (§24). Subtitles at size 13 on the SRT canvas (about 49 px), limited-range yuv420p. |
| Submission drafts (`docs/submission/`) | The tech doc, security self-assessment, README, execution evidence, video script and deck outline follow the official templates. The README's links are relative to the repo root, since it replaces `/README.md` at freeze. Unmeasured numbers and unsourced facts are visible `[TBD …]` placeholders; figures say "as of 18 Oct". Environment variables are listed by name only. |

**Open.**

- The video's `roadmap` scene shows the mock's only run, `mock-rina-evidence-3`, as "Not verified · 0 of 3 checks passed" under "Anyone can verify the bundle". It needs a real bundle (`REPLAY=<runId>`) or a Mei sample.
- `docs/submission/VIDEO-SCRIPT.md` scene 3 lacks the new officer line, its subtitle note still says Arial 22, and its filename `International-TeamFEIN-DemoVideo.mp4` differs from the brief's `InternationalAI-TeamFEIN-DemoVideo.mp4`.
- `demo:record` needs Playwright's `ffmpeg-1013` (`npx playwright install ffmpeg` is a download: P1's call); Homebrew's ffmpeg lacks libass, and `ffmpeg-full` burns the subtitles.
- The drafts' `[TBD at freeze]` items: Mei's numbers against `mei.ts`, SG facts against `SG.json`, the Sepolia, E1, E2 and autonomy figures, and the `validate:data` count.
- If the repo goes public: whether `project.md`, `roles/`, the internal briefs and the run-3 to run-7 audit records ship, since they name banned words as rule text or quotes.
