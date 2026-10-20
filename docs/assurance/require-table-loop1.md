# Require table: `loop-1` contracts (task 1.4)

> Task 1.8 (`final-1`) adds MilestoneEscrow, SalesOracle, ownerSpend, releaseStage and the loosening queue, and changes
> a few rows here (spend row 4a, pause, failSettlement, the Treasury constructor): see `require-table-final1.md`. This
> table stays the record of `loop-1`, which is deployed from the pre-1.8 commit.

Every check in every external function of `PlanRegistry` and `Treasury` as deployed for `loop-1` (D17), **in the order the
code runs it**. The first failing row decides the revert. Lead review item (ROLE-P1 A.4): every row here is a `require`
the lead signs off on.

Notation:
- `now` = `_now()` (seconds; `block.timestamp / 1000` when the deployment's FISCO flag is set, §8.8).
- "active line" = the line is part of the **current** plan version (a line dropped by a later plan is not active).
- `C(n)` = `PlanInvariantViolated(n)` with the `HogeeKinds.CONST_*` code `n`.
- Signature envelope (rows marked **ENV**) is the same for every founder-signed struct:

| # | Check | Error | Rule |
|---|---|---|---|
| ENV-1 | `s.deploymentId == deploymentId()` | `InvalidSignature` | §8.7 (every struct carries deploymentId), T28 |
| ENV-2 | `now <= s.expiry` | `SignatureExpired` | §8.7, T16 |
| ENV-3 | `!isNonceUsed(s.nonce)` (unordered nonces, one space per verifying contract) | `InvalidSignature` | §8.7, T16 |
| ENV-4 | founder signature over `toTypedDataHash(domainSeparator, hashStruct(s))` is valid: kind 0 = ECDSA (65 bytes, low-s) recovering the registered `ownerEOA`; kind 1 = `WebAuthn.verify` (UV required, low-s) against the registered `(qx, qy)`; any other kind fails | `NotOwner` if kind 0 recovers the current **agent** or the **lender** (a known non-owner role signed an owner struct: T2, T6, H3); otherwise `InvalidSignature` | §8.7, T16, T28 |
| ENV-5 | (effect) the nonce is marked used | — | §8.7 |

A wrong digest (other chainTag/deploymentId/contract, swapped calldata) recovers a random address, so it reverts
`InvalidSignature` (T27, T28). Only a recovered **agent** or **lender** address maps to `NotOwner`.

---

## PlanRegistry

### `registerFounderKey(qx, qy, ownerEOA)`

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | `msg.sender == lender` | `NotLender` | §8.2, §26.9 |
| 2 | no founder key registered yet | `FounderKeyAlreadySet` | H3 |
| 3 | at least one usable key: `ownerEOA != 0` or `(qx, qy) != (0, 0)` | `InvalidSignature` | §8.7 (a key that can never verify would brick the facility) |
| 4 | `ownerEOA != lender` | `InvalidSignature` | H3 (decision: the lender can never be the owner) |
| 5 | if `ownerEOA != 0`: `ownerEOA != Treasury.oracle()` | `InvalidSignature` | run-2 audit (role separation: the oracle can never be the owner) |
| 6 | if `(qx, qy) != (0, 0)`: `P256.isValidPublicKey(qx, qy)` | `InvalidSignature` | §8.7 passkey path |
| — | effect: store key, emit `FounderKeyRegistered` | — | |

### `commitPlan(approval, lines, stages, founder)`

Anyone may submit (the relayer has no on-chain role; the founder signature is the authority, §8.2).

| # | Check | Error | Rule |
|---|---|---|---|
| 1–4 | ENV-1 … ENV-4 over `PlanApproval` (verifying contract = PlanRegistry) | see ENV | §8.7, T16, T28 |
| 5 | `approval.linesHash == keccak256(abi.encode(lines))` and `approval.stagesHash == keccak256(abi.encode(stages))` | `InvalidSignature` | §8.7, T27 (the signature does not cover this calldata) |
| 6 | `approval.version == planVersion() + 1` (so a re-signed version 1 or a skipped version is stale) | `StalePlan` | §8.1 compare-and-swap, §8.3, G0 audit v-1 |
| 7 | `approval.prevPlanHash == currentPlan().planHash` (0 for version 1) | `StalePlan` | §8.1 compare-and-swap |
| 8 | version > 1: `approval.planId == currentPlan().planId` | `StalePlan` | §8.3 (planId unchanged), G0 audit v-1 |
| 9 | constitution, codes 1–13 (next table) | `C(code)` | §8.3, D7, T21 |
| 10 | stored `planVersion() > 0` (stored state, not the signed number): the re-commit only tightens the current on-chain state (replan table below) | `C(14)` `REPLAN_LOOSENS` | §8.3, G0 audit v-1 |

Order (same as the 1.10 TS mirror `commitPlanOutcome`): sequencing (rows 6–8, `StalePlan`) is decided before the
constitution (row 9, codes 1–13), which is decided before the replan rule (row 10, code 14). A stale approval that also
breaks a constitution code reverts `StalePlan`.
| — | effects, first commit: nonce used; store plan, lines (in signed order), stages and `stagesHash`; push the plan to Treasury (`syncPlan`, below), which records the stages and releases stage 0; emit `PlanCommitted` | — | |
| — | effects, re-commit: nonce used; store version, `planHash`, `committedAt` and the new line parameters (the stored line **order** is kept; planId, agent, totals, country pack and stages are unchanged by row 10); `syncPlan` writes plan parameters only; emit `PlanCommitted` (its `releasedMinor` is unchanged) | — | |

**Constitution** (`PlanConstitution.check`). If several rules fail, the revert code is **13 first, then 12, then the
lowest of 1–10**; code 14 (row 10) only runs when all of them pass. Code 11 is enforced in `bindPayee` (the plan carries
no payee caps). All arithmetic in uint256.

| Code | Check (violation ⇒ revert) | §8.3 rule |
|---|---|---|
| 13 `MALFORMED_PLAN` | `lines.length` ∉ [1, 16]; `stages.length` ∉ [1, 8]; `totalMinor == 0`; `agent == 0`; `reserveBps > 10_000`; then (role separation, decision) `agent` equal to the founder's `ownerEOA`, the lender or the oracle (`Treasury.oracle()`; run-2 audit: an agent that is the oracle could `failSettlement` its own spends and re-spend the refund); any `lineId == 0` or duplicate; any `windowSeconds == 0`; a line with > 8 payees, a payeeId 0 or a duplicate payeeId; any `stageId == 0` or duplicate; `stages[0].metric != METRIC_NONE`; `stages[i>0].metric` ∉ {SALES_MINOR, ORDERS} | structural (G0) |
| 12 `TOTALS_MISMATCH` | `Σ lines.amountMinor != totalMinor` or `Σ stages.releaseMinor != totalMinor` | structural (G0) |
| 1 `LINES_EXCEED_FACILITY_CAP` | `totalMinor > facility().capMinor` (0 if `openFacility` never ran) | sum of lines ≤ facility cap |
| 2 `AGENT_EXPIRY_TOO_LATE` | `agentExpiry > now + 90 days` | agentExpiry ≤ now + 90 d |
| 3 `AGENT_EXPIRY_TOO_EARLY` | `agentExpiry <= judgingWindowEnd` (constructor immutable; demo 2026-11-30T23:59:59Z) | later than the judging window |
| 4 `PER_TX_CAP_OVER_25PCT` | any line `perTxCapMinor * 4 > amountMinor` | perTxCap ≤ 25 % |
| 5 `WINDOW_CAP_OVER_50PCT` | any line `windowCapMinor * 2 > amountMinor` | window cap ≤ 50 % |
| 6 `LINE_VALIDITY_TOO_LONG` | any line `validUntil > now + 90 days` | validUntil ≤ now + 90 d |
| 7 `RESERVE_BELOW_FLOOR` | `reserveBps < facility().reserveFloorBps` | reserveBps ≥ floor |
| 8 `STAGE1_OVER_40PCT` | `stages[0].releaseMinor * 10 > totalMinor * 4` | stage 1 ≤ 40 % |
| 9 `PLAN_ADDS_PAYEE` | a line's payeeId is neither bound **to that line** (`Treasury.payeeBinding(lineId, p).bound`) nor in Treasury's static platform registry | a plan cannot introduce payees |
| 10 `SUPPLIER_LINE_NOT_ESCROW` | `lineId == "SUPPLIER"` and `!escrowOnly` | supplier line only through escrow |

**Replan rule** (`PlanReplan.loosens`, row 10; G0 audit v-1). "Current" means the on-chain state now: the stored plan
plus everything Treasury changed since (tightenings by the agent, owner or lender; in 1.8, lender-co-signed loosenings
such as MOVE_POCKETS or EXTEND_*). Only the founder signs a `PlanApproval`, so any of these reverts `C(14)`; a loosening
needs a lender-co-signed `LOOSEN_*` kind (1.8), and one with no kind yet (e.g. a new agent) needs a new additive kind or
a new deployment (G0-DECISIONS §1 #6).

| # | Check (violation ⇒ `C(14)`) | Current value read from |
|---|---|---|
| R1 | `totalMinor`, `countryPackHash` and `stagesHash` equal the stored ones (stages identical, same order) | PlanRegistry storage |
| R2 | `agent` equals the current agent | `Treasury.agentState()` |
| R3 | `agentExpiry <= ` current agentExpiry | `Treasury.agentState()` |
| R4 | `reserveBps >= ` current reserveBps (after `TIGHTEN_RAISE_RESERVE_BPS`) | `Treasury.agentState()` |
| R5 | same set of lineIds: `lines.length` equals the stored count and every lineId is a stored line (no duplicates: code 13) | PlanRegistry storage |
| R6 | per line: `amountMinor == ` current allocation (after MOVE_POCKETS) | `Treasury.pocket(lineId)` |
| R7 | per line: `perTxCapMinor`, `windowCapMinor` and `validUntil <= ` current (after tighten) | `Treasury.pocket(lineId)` |
| R8 | per line: `windowSeconds >= ` current (a longer window is tighter) | `Treasury.pocket(lineId)` |
| R9 | per line: `pacingMinor <= ` current, and 0 only if it is 0 now (an invoice line stays one, a pacing line never switches off) | `Treasury.pocket(lineId)` |
| R10 | per line: `escrowOnly` never cleared (setting it is a tightening) | `Treasury.pocket(lineId)` |
| R11 | per line: every payeeId is one of the line's current payees: in its stored `payeeIds`, or bound to that line since by a founder-signed approval (`Treasury.isSignedPayee(lineId, p)`: bindPayee, 1.8 ADD_PAYEE). A static platform payee counts only while the line lists it (its automatic binding is not a signed one), so listing one the line does not list now, including one an earlier version dropped, is an addition | PlanRegistry storage, Treasury |

Dropping a payee from a line is a tightening of the plan, and it takes effect in `spend` (run-2 audit): spend pays only a
payee that the **current** version lists on that line (spend row 10). The dropped payee's binding data (paid, cap,
payout account) stays, but it is no longer payable, and R11 stops a later version from listing it again unless a signed
approval binds it since. A reordered line list passes (R5 is a set check) and the stored order is kept. R11 matches the
1.10 TS constitution mirror.

**`Treasury.syncPlan`** (hook, called only by PlanRegistry at the end of `commitPlan`): `msg.sender == PlanRegistry`
else `NotOwner` (T6: nobody else can change the plan). Effects, every commit: store the version, `agentExpiry` and
`reserveBps`; for each line set the pocket config (amount, caps, window, validUntil, pacing, escrowOnly) to the signed
values, which row 10 guarantees are equal or tighter; stamp every listed payee with this version (spend row 10: a payee
the current version does not list is not payable; the version is stored before any line is synced); bind every listed
static platform payee that is not yet bound to that line (no cooling, uncapped, emits `PayeeBound` with zero
orderId/supplierId/scheduleHash; on a re-commit R11 makes this a no-op). First commit only: store planId, `totalMinor` and the agent, record every stage `{releaseMinor}`, and
release stage 0 through `_raiseReleased` (below). A re-commit **never** resets or clears runtime state (treasury pause,
line pauses, circuits and denial counts, rolling-window spend, `lineSequence`, payee bindings/paid/cooling, used intents
and invoices, `agentRevoked`) and never raises `releasedMinor`.

**`Treasury._raiseReleased(stageId)`** (internal; the **only** writer of `releasedMinor`, task 1.4 item c):

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | the stage was recorded by the first commit | `CapExceeded` | §8.4 stage stop-loss |
| 2 | the stage is not released yet | `CapExceeded` | each stage is released once |
| 3 | `releasedMinor + stage.releaseMinor <= totalMinor` | `CapExceeded` | never above the plan total |
| — | effects: mark released; `releasedMinor += releaseMinor` (logged by `PlanCommitted.releasedMinor` on the first commit; 1.8's `releaseStage` emits `StageReleased`) | — | |

So `releasedMinor == Σ releaseMinor of the released stages <= Σ stages == totalMinor` (code 12). On loop-1 the only
caller is the first commit (stage 0); rows 1–3 are exercised through the test-only `TreasuryHarness`
(`TreasuryRelease.t.sol`) and the invariant `releasedMinor == released-stage total`, unchanged by founder re-commits.

---

## Treasury

### `openFacility(capMinor, reserveFloorBps)`

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | `msg.sender == lender` | `NotLender` | §8.2 |
| 2 | `reserveFloorBps <= 10_000` | `C(13)` | structural |
| 3 | a plan exists: `capMinor >= plan totalMinor` | `C(1)` | §8.9 inv. 6 (a stored plan always satisfies the constitution) |
| 4 | a plan exists: `reserveFloorBps <= current reserveBps` | `C(7)` | §8.9 inv. 6 |
| — | effects: store; `opened = true`; emit `FacilityOpened`. Re-callable by the lender under rows 2–4 (lowering or raising the cap never loosens an agent limit) | — | |

The former row 5 (`capMinor >= fundedMinor`, `CapExceeded`) is removed: it became unreachable. `fund` keeps
`fundedMinor <= totalMinor`, row 3 keeps `totalMinor <= capMinor`, and `totalMinor` is fixed by version 1 (replan R1).
Before the first plan `fundedMinor` is 0.

### `fund(amountMinor)`

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | `msg.sender == lender` | `NotLender` | §8.2 |
| 2 | `fundedMinor + amount <= plan totalMinor` (0 before the first plan) | `CapExceeded` | §8.2 issuance capped at the plan total |
| 3 | `fundedMinor + amount <= facility.capMinor` | `CapExceeded` | facility cap |
| — | effect: `fundedMinor += amount`; emit `Funded` | — | |

### `bindPayee(approval, schedule, autoRelease, founder)`

Anyone may submit. Not blocked by pause (no funds move; cooling still applies).

| # | Check | Error | Rule |
|---|---|---|---|
| 1–4 | ENV-1 … ENV-4 over `SupplierApproval` (verifying contract = Treasury) | see ENV | §8.7, T2, T16 |
| 5 | `schedule.length == autoRelease.length`, length ∈ [1, 8], `orderId != 0`, `payee != 0`, `payoutAccountHash != 0` | `C(13)` | structural (`orderId != 0`: run-2 audit) |
| 6 | `approval.scheduleHash == keccak256(abi.encode(schedule, autoRelease))` | `InvalidSignature` | §8.7 (signature must cover the schedule) |
| 7 | `Σ schedule == approval.totalMinor` (the lifetime cap equals the schedule total) | `C(11)` | §8.3 payee cap ≤ schedule |
| 8 | `payee` is not a static platform payee (`platformPayoutAccountHash(payee) == 0`): a platform payee is uncapped, so a signed binding could never keep its cap at the schedule total, and it would replace the fixed payout account | `C(11)` | §8.3 payee cap ≤ schedule, run-2 audit |
| 9 | `approval.lineId` is an active line with `now <= validUntil` | `LineExpired` | |
| 10 | that line is `escrowOnly` | `C(10)` | §8.3 supplier only through escrow |
| 11 | `orderId` not used before | `DuplicateIntent` | one order, one binding |
| — | effects: nonce used; order marked; binding `{bound, coolingUntil = now + coolingSeconds, lifetimeCap += totalMinor, payoutAccountHash = signed}` (a re-bind restarts cooling, T3) and marked signed (`isSignedPayee`, replan R11); emit `PayeeBound`. Escrow order opening is MilestoneEscrow's (`TODO(1.8)`) | — | |

### `spend(lineId, payeeId, amount, invoiceHash, planVersion, decisionId, rationaleHash)` — §8.4

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | `msg.sender == plan agent` and agent not revoked | `NotAgent` | §8.4, T15 |
| 2 | treasury not paused | `Paused` | §8.4, T10 |
| 3 | `now <= agentExpiry` | `AgentExpired` | §8.4, T15 |
| 4 | `decisionId != 0 && rationaleHash != 0` | `MissingDecision` | §8.4, H5 |
| 5 | not (active line and `escrowOnly`) | `EscrowOnly` | §8.4 |
| 6 | `planVersion == planVersion()` | `StalePlan` | §8.4, T20 |
| 7 | line active and `now <= validUntil` | `LineExpired` | §8.4 |
| 8 | line circuit not open | `CircuitOpen` | §8.8 |
| 9 | line not paused (`TIGHTEN_PAUSE_LINE`) | `Paused` | §8.8 |
| 10 | `payeeBinding(lineId, payeeId).bound` **and** the current plan version lists `payeeId` on `lineId` (stamped by `syncPlan`; 1.8's `LOOSEN_ADD_PAYEE` must stamp the current version too). A payee a re-commit dropped keeps its binding data but fails this row | `PayeeNotBound` | §8.4, T1, run-2 audit |
| 11 | `now >= coolingUntil` | `PayeeCooling` | §8.4, T3. On loop-1 every payee a direct-pay line can pay is a platform payee (no cooling); rows 11 and 21 bite for payees added by 1.8's `LOOSEN_ADD_PAYEE` and are tested through the test-only harness |
| 12 | `intentId = keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, amount))` not used | `DuplicateIntent` | §8.4, T7 |
| 13 | invoice line (`pacingMinor == 0`): `!isInvoicePaid(invoiceHash)` (global across lines) | `DuplicateInvoice` | §8.4, T17 |
| 14 | pacing line: `uint(invoiceHash) >= lineSequence(lineId)` (a lower slot is already paid) | `DuplicateInvoice` | §8.4 pacing |
| 15 | pacing line: `uint(invoiceHash) == lineSequence(lineId)` (no skipping ahead) | `CapExceeded` | §8.4 pacing |
| 16 | pacing line: `amount <= pacingMinor` | `CapExceeded` | §8.4 pacing, T4 |
| 17 | `0 < amount <= perTxCapMinor` (current, after tighten). A zero amount would burn an invoice or pacing slot, a window entry and a live-spend slot | `CapExceeded` | §8.4, T4, run-2 audit |
| 18 | fewer than 64 live spends in the line's rolling window | `CapExceeded` | decision: gas bound |
| 19 | `rollingSpent(lineId) + amount <= windowCapMinor` (true sliding window: a spend made at `t` counts while `now < t + windowSeconds`, with the line's **current** windowSeconds, so a longer window from a re-commit covers earlier spends) | `CapExceeded` | §8.4, T4, T22 |
| 20 | `amount <= allocated − spent − escrowed` | `CapExceeded` | §8.4 line balance |
| 21 | `binding.paidMinor + amount <= binding.lifetimeCapMinor` | `CapExceeded` | §8.3 payee cap |
| 22 | `spentMinor + escrowedMinor + amount <= releasedMinor` | `CapExceeded` | §8.4 stage |
| 23 | `spentMinor + escrowedMinor + amount <= fundedMinor` | `CapExceeded` | decision: never spend unfunded BU |
| — | effects: intent used + settlement record; invoice marked paid (invoice line) or sequence + 1 (pacing line); pocket/total/payee spent += amount; window entry; emit `Spent(…, planVersion)`; return `spendId = intentId` | — | |

### `tighten(kind, target, newValue, decisionId)` — instant, tighten-only

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | caller is the active agent (not revoked, not expired), the owner EOA or the lender; the agent itself gets `NotAgent` if revoked and `AgentExpired` if expired | `NotAgent` / `AgentExpired` | §8.2 |
| 2 | agent caller: `decisionId != 0` | `MissingDecision` | H5 (every agent action is traceable) |
| 3 | `LOWER_PER_TX_CAP` / `LOWER_WINDOW_CAP`: `target` is an active line | `LineExpired` | |
| 4 | … and `newValue <= current cap` | `NotOwner` | §13.1 #2: raising needs the owner's LoosenRequest (T6) |
| 5 | `RAISE_RESERVE_BPS`: `target == 0` and `newValue <= 10_000` | `C(13)` | |
| 6 | … and a plan is committed (`planVersion() > 0`); before it, the first `syncPlan` would overwrite the value with the signed `reserveBps` | `StalePlan` | run-2 audit |
| 7 | … and `newValue >= current reserveBps` | `NotOwner` | T6 |
| 8 | `REVOKE_AGENT`: `target == 0 && newValue == 0` | `C(13)` | |
| 9 | `PAUSE_LINE`: `newValue == 0`, then `target` is an active line | `C(13)` / `LineExpired` | |
| 10 | unknown kind | `C(13)` | |
| — | effects: apply; emit `Tightened(kind, target, by, old, new, decisionId)` (revoke/pause log the flag 0 → 1); `PAUSE_LINE` also emits `TreasuryPaused(lineId, by)` | — | |

### `pause()`

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | same caller rule as `tighten` row 1 | `NotAgent` / `AgentExpired` | §8.2 |
| — | effects: `paused = true`; emit `TreasuryPaused(0, by)`. Cancelling queued loosenings is `TODO(1.8)` (none can exist on loop-1) | — | §8.8 |

### `recordDenied(lineId, decisionId, reasonCode, proposalHash)` — circuit breaker

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | `msg.sender == plan agent` and not revoked | `NotAgent` | §26.9 onlyAgent |
| 2 | `now <= agentExpiry` | `AgentExpired` | |
| 3 | `decisionId != 0 && reasonCode != 0` | `MissingDecision` | D14 |
| 4 | active line: circuit not open; other keys (lineId 0 or not in the plan): not rate-limited (`now >= blockedUntil`) | `CircuitOpen` | §8.8 rate limit, T26 |
| — | effects: `n` = denials for this key within the window (line: `windowSeconds`; other keys: 1 day), counting this one; emit `Denied(…, n)`. At `n == 3`: active line → `circuitOpen = true`, emit `CircuitTripped(lineId, 3)`; other keys → `blockedUntil = now + 1 day` (rate limit only, nothing pauses). Allowed while paused | — | §8.8 |

### `confirmSettlement(settlementId, payoutRefHash)` / `failSettlement(settlementId, code)`

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | `msg.sender == oracle` | `NotOracle` | §8.2 |
| 2 | a settlement record exists for `settlementId` and its state is `NONE` (open) | `SettlementClosed` | M8 (unknown ids are not open either) |
| — | confirm: state `CONFIRMED`; emit `SettlementConfirmed` | — | |
| — | fail: state `FAILED`; return the amount to its source (pocket spent, total spent, payee paid −= amount); emit `SettlementFailed`. The intent stays used and the invoice stays paid (a corrected invoice gets a new hash), and the rolling window keeps counting the attempt: no double payment even if a failure is mis-reported | — | M8 |

### Loop-1 stubs (task 1.8; declared because `Treasury is ITreasury`)

| Function | Reverts | Why |
|---|---|---|
| `releaseStage(req, lender)` | `InvalidSignature` | **intentionally a reverting stub on loop-1**: §8.1 scopes loop-1 to the spend path, so loop-1 only ever releases stage 0 (first commit). 1.8 implements it for `final-1` and must go through `_raiseReleased` (`TODO(1.8)`) |
| `ownerSpend(req, founder)` | `InvalidSignature` | loop-1 accepts no OwnerSpend (`TODO(1.8)`) |
| `queueLoosen(req, founder, lender)` | `InvalidSignature` | loop-1 accepts no LoosenRequest (`TODO(1.8)`) |
| `executeLoosen(id)` / `cancelLoosen(id)` | `TimelockActive` | nothing can be queued on loop-1, so nothing is executable or cancellable (`TODO(1.8)`) |
| `queuedLoosen(id)` | — | returns the zero struct (status NONE) |

### Deployment: constructors and `script/DeployLoop.s.sol` (run-2 audit)

`loop-1` is deployed once and never again, so a wrong input must stop the deployment rather than produce it.

| # | Check | Error | Rule |
|---|---|---|---|
| T-1 | Treasury constructor: `oracle != lender` (the lender is read from PlanRegistry) | `NotOracle` | role separation (decision #4) |
| T-2 | Treasury constructor: `platformPayeeIds.length == platformPayoutHashes.length`; every id and hash non-zero (a zero hash reads as "not a platform payee"); no duplicate id | `C(13)` | §8.3 static platform registry (decision #1) |

`DeployLoop` checks before anything is broadcast (script `require`s): `LENDER_ADDRESS` and `ORACLE_ADDRESS` non-zero and
different; `0 < COOLING_SECONDS <= 30 days` (Treasury adds it to `_now()`, which is unix seconds on every chain, so a
huge value would overflow and make `bindPayee` always revert); `CHAIN_TAG` names the chain (`anvil` on 31337, `sepolia`
on 11155111, a FISCO tag `fisco` / `fisco-*` on any other chain) and `FISCO_MS=true` needs a FISCO tag (a FISCO tag may
run on either clock: FISCO BCOS 3.x with `feature_evm_timestamp=1` keeps seconds); `FISCO_MS` matches the chain clock (`block.timestamp > 1e12` iff true, else `_now()` reads as 1970 or the far
future and every expiry check is wrong); `JUDGING_WINDOW_END`
is in the future (seconds, or milliseconds / 1000 under `FISCO_MS`); `COOLING_SECONDS` and `JUDGING_WINDOW_END` fit
uint64 (`SafeCast`). Off Anvil (`block.chainid != 31337`): `COOLING_SECONDS` must be set explicitly (the 120 s demo
default applies on Anvil only), and neither role may be one of Anvil's ten default accounts (public keys). The script
also pre-checks T-2 with readable messages (platform labels are ShortIds).

### Views (no checks)

PlanRegistry: `planVersion`, `currentPlan` (agentExpiry/agentRevoked/reserveBps are the current Treasury values),
`lineIds` (version-1 order), `line` (as signed in the current version; current caps are `Treasury.pocket`), `stageIds`,
`stage` (`released` is Treasury's record), `founderKey`, `lender`, `domainSeparator`, `deploymentId`, `chainTag`,
`isNonceUsed`. Treasury hooks (not frozen): `agentState`, `platformPayoutAccountHash`, `isSignedPayee`, `isStageReleased`. Treasury: `pocket`, `isIntentUsed`, `rollingSpent`, `reserve` (0 on loop-1), `revenue` (0 on loop-1),
`releasedMinor`, `agentExpiry`, `facility`, `balances`, `isInvoicePaid` (invoice lines only; pacing slots use
`lineSequence`), `payeeBinding`, `lineSequence` (next slot, starts at 1; 0 for invoice lines), `queuedLoosen`,
`settlementState`, `paused`, plus the IHogeeDomain views.

---

## Decisions where the spec or the frozen interface is silent (lead review)

| # | Topic | Decision |
|---|---|---|
| 1 | Platform payees (ADS / LOGISTICS / PLATFORM_FEES) | Treasury's constructor takes a static platform registry `(payeeId, payoutAccountHash)[]`, fixed for life (§8.3 "static platform registry"). `commitPlan` binds every listed platform payee to the line that lists it: no cooling, uncapped (`PayeeBinding.lifetimeCapMinor = max`), `PayeeBound` with zero orderId/supplierId/scheduleHash. Other payees need `bindPayee` (escrow lines) or LOOSEN_ADD_PAYEE (1.8). Bindings are per line: a supplier bound to SUPPLIER cannot be listed on a direct-pay line (code 9). |
| 2 | Relayer | No on-chain role: any address may submit a founder-signed struct (the signature is the authority; there is no `NotRelayer` error). |
| 3 | Agent / lender signing an owner struct | ECDSA that recovers the current agent or the lender reverts `NotOwner` (T2, T6, H3); every other verification failure is `InvalidSignature` (T16, T27, T28). |
| 4 | Role separation | `registerFounderKey` rejects `ownerEOA == lender` and `ownerEOA == oracle`; the constitution rejects `agent == ownerEOA`, `agent == lender` or `agent == oracle` (code 13); the Treasury constructor (`NotOracle`) and `DeployLoop` reject `oracle == lender`. Not in §8.3; added so the agent can never sign owner structs or settle (refund) its own spends (run-2 audit). |
| 5 | Stage release across plan versions | Only the first commit releases stage 0, through `_raiseReleased` (the only writer of `releasedMinor`). A re-commit cannot change the stages (replan R1) and never touches `releasedMinor`, so the lender's stage gate stays meaningful. |
| 6 | Funding | `fund` is capped at the current plan total and the facility cap; `spend` also requires `outflow <= fundedMinor` (never spend unfunded BU). |
| 7 | Plan v2 effects | G0 audit v-1: a re-commit may only tighten (replan table); its signed caps, validity, pacing, window and escrowOnly replace the current values, which are never looser. Every runtime state carries over, **including `agentRevoked`**: a revoked or expired agent key ends the loop-1 autonomous run (G0-DECISIONS §1 #6). One planId per facility. |
| 8 | Rolling window | Exact sliding window (a spend at `t` counts while `now < t + windowSeconds`, current windowSeconds; it can only grow after v1, so entries stay ordered), at most 64 live spends per line per window (gas bound), same-block spends merged. |
| 9 | Pacing lines | `invoiceHash = bytes32(slot)`, slot = `lineSequence` (starts at 1). A lower slot is `DuplicateInvoice`, a higher one `CapExceeded`. Pacing slots are per line, not in the global invoice set. |
| 10 | Settlement failure | Refunds pocket, total and payee paid; the intent and the invoice stay consumed and the window keeps the attempt (no double payment if a failure is mis-reported). Unknown ids revert `SettlementClosed`. |
| 11 | Circuit breaker | Sliding count of the last 3 denials per key. Active line: 3 in its window opens the circuit (`CircuitTripped`), later calls revert `CircuitOpen`. lineId 0 / lines outside the plan: rate limit only (blocked 1 day after 3 in a day). `decisionId` and `reasonCode` must be non-zero. |
| 12 | WebAuthn (kind 1) | Implemented with OZ `WebAuthn.verify` (UV required, low-s). `Sig.data` is the flat tuple `abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON)` that OZ `tryDecodeAuth` reads; the form with one leading 0x20 offset word (Solidity `abi.encode(auth)`, viem single-tuple) is also accepted. |
| 13 | Clock | `_now()` divides by 1000 when the deployment's FISCO flag is set (constructor immutable, read by Treasury from PlanRegistry). |
