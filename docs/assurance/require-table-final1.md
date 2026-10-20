# Require table: `final-1` contracts (task 1.8)

Every check in every external function that task 1.8 adds or changes, **in the order the code runs it**. The first
failing row decides the revert. Rows of `require-table-loop1.md` that are not listed here are unchanged. Lead review
item (ROLE-P1): every row here is a `require` the lead signs off on.

Notation as in `require-table-loop1.md`: `now` = `_now()`, "active line" = part of the current plan version,
`C(n)` = `PlanInvariantViolated(n)`, ENV-1 … ENV-5 = the signature envelope (deploymentId, expiry, nonce, founder
signature, nonce used).

## Contracts and the size split

`final-1` = four contracts plus one module (all constructor immutables, no setters, no upgradeability):

| Contract | Runtime (B) | Role |
|---|---|---|
| `PlanRegistry` | 20,771 | role checks also read `Treasury.observer()` (audit run-3, below) |
| `Treasury` | 20,539 | ledger, spend path, bindPayee, tighten/pause, settlement, hooks for the escrow and the sales oracle; forwards the five signed entry points below to its governance module |
| `TreasuryGovernance` | 12,227 | `ownerSpend`, `releaseStage`, `queueLoosen`, `executeLoosen`, `cancelLoosen` (created by Treasury's constructor, run only by `delegatecall`) |
| `MilestoneEscrow` | 5,645 | orders and milestones; `fundMilestone`, `releaseMilestone` |
| `SalesOracle` | 731 | `recordSale` |

EIP-170 limit 24,576 B; Treasury's initcode (with the module's) is 36,714 B of 49,152 (sizes after the post-fix
re-check, `forge build --sizes`).

**Governance module (delegatecall).** Treasury's runtime would pass EIP-170 with the five founder/lender-signed entry
points, so they live in `TreasuryGovernance`. Treasury creates it in its own constructor with the same arguments (so
every immutable but the domain separator is equal) and keeps its address in an immutable; Treasury's
`ownerSpend/releaseStage/queueLoosen/executeLoosen/cancelLoosen` forward the call data unchanged (`Treasury._delegate`).
The code then runs in Treasury's storage and address. Both contracts inherit the same `TreasuryState` (every state
variable of the Treasury) and declare no state of their own, so the storage layouts are identical. Signatures are
checked against Treasury's domain by `_treasuryDigest` (computed from `address(this)`, which is Treasury under
`delegatecall`). A direct call to the module reverts `NotOwner` (`onlyDelegated`). Events are emitted from Treasury's
address. CI checks the layout claim (audit run-3): `scripts/check-storage-layout.ts` (`pnpm contracts:storage-layout`)
runs after `forge build` in the contracts job and fails unless both contracts have the same ordered (label, slot,
offset, type) storage entries.

| # | Module guard | Error |
|---|---|---|
| G-1 | every module entry point: `address(this) != module` (reached only through Treasury's `delegatecall`) | `NotOwner` |

**Lender signature (ENV-4L).** The lender is an EOA: only kind 0 (65-byte ECDSA, low-s) can verify; any other kind or
a malformed signature recovers 0.

---

## PlanRegistry: the observer in the role checks (audit run-3)

The optional observer may `cancelLoosen` any queued loosening, and `TIGHTEN_REVOKE_AGENT` does not take that away. On a
key the agent (or another worker-held role) also holds, it could cancel every co-signed `UNPAUSE`. So a set observer
is never the agent, the owner EOA, the lender or the oracle (the last two: Treasury T-4).

| Function | Row (`require-table-loop1.md`) | Check | Error |
|---|---|---|---|
| `registerFounderKey` | 5 | if `ownerEOA != 0`: `ownerEOA != Treasury.oracle()` **and `ownerEOA != Treasury.observer()`** | `InvalidSignature` |
| `commitPlan` | constitution code 13 | role separation also refuses `agent == Treasury.observer()` (an observer of 0 never matches: the agent is non-zero) | `C(13)` |

---

## Treasury (changed functions)

### `constructor(registry, oracle, coolingSeconds, links, platformPayeeIds, platformPayoutHashes)`

| # | Check | Error | Rule |
|---|---|---|---|
| T-1 | `oracle != lender` (as loop-1) | `NotOracle` | role separation |
| T-4 | if `links.observer != 0`: `observer != lender` and `observer != oracle` | `C(13)` | role separation (audit run-3: the observer's veto sits on its own key) |
| T-3 | `0 < links.loosenTimelockSeconds <= 30 days` | `C(13)` | §8.8 (a zero timelock would make loosening instant) |
| T-2 | platform registry checks (as loop-1) | `C(13)` | §8.3 |
| — | effects: immutables `escrow`, `salesOracle`, `observer`, `loosenTimelockSeconds`; creates `TreasuryGovernance` with the same arguments | — | |

`links.escrow` / `links.salesOracle` = 0 is the loop-1 shape (no escrow orders, no sales; the hooks can never run).
`DeployLoop` passes that shape and the 24 h production timelock at its one call site; nothing else in it changed.

### `spend(...)`: one new row

| # | Check | Error | Rule |
|---|---|---|---|
| 4a | after rows 1-4 (agent, paused, expiry, decision): `lineId != "RESERVE"` | `ReserveLocked` | §26.2 the reserve is not a line; T8, demo task 11 |

### `bindPayee(...)`: one new row, one new effect

| # | Check | Error | Rule |
|---|---|---|---|
| 6a | after row 6 (schedule hash), while summing for row 7: every `schedule[i] > 0` | `C(13)` | audit run-3: a zero milestone can never be funded (`fundMilestone` refuses 0) but reads as fully funded, so a release would open a zero settlement |

After the loop-1 effects, if `escrow != 0`: `MilestoneEscrow.openOrder(approval, schedule, autoRelease)` opens the order
(rows 5-7 already checked length 1-8, the schedule hash, no zero milestone and the total; row 11 the unique orderId).

### `pause()`

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | same caller rule as loop-1 | `NotAgent` / `AgentExpired` | §8.2 |
| — | effects: `paused = true`; **if the treasury was not paused**: every live queued loosening → `CANCELLED`, `LoosenCancelled(id, by)` each (at most 16); emit `TreasuryPaused(0, by)` | — | §8.8 |

A second `pause()` while paused cancels nothing: what is queued then (above all `UNPAUSE`) was co-signed to end the
pause, and a key that keeps pausing must not be able to cancel it during every timelock. Owner, lender and observer
can still `cancelLoosen` any one of them; a rogue agent is stopped with `TIGHTEN_REVOKE_AGENT` (instant).

### `failSettlement(settlementId, code)`: refund by source (M8)

Rows 1-2 as loop-1 (`NotOracle`, `SettlementClosed`). Effects: state `FAILED`, then by record kind:

| Kind | Source the amount returns to |
|---|---|
| spend / ownerSpend | line pocket, total spent and payee paid (as loop-1); intent, invoice and window entry stay consumed |
| milestone release | **the supplier line pocket** (re-check M-1): line and total escrowed (as `escrowFund` added them; `escrowRelease` left them) and payee paid. No call to the escrow: the milestone stays released and fully funded, so it is never funded again (`AmountExceedsSchedule`) or released again (`MilestoneLocked`), and its settlementId stays closed. Paying the supplier again takes a new founder-signed `SupplierApproval` (a new order) |
| reserve withdrawal | reserve (`reserveWithdrawn` decreases) |

### Hooks for MilestoneEscrow and SalesOracle (`ITreasuryModuleHooks`, not frozen)

| Function | # | Check | Error |
|---|---|---|---|
| `requireSpendingAgent(caller)` (view) | 1-3 | spend rows 1-3 for `caller` | `NotAgent` / `Paused` / `AgentExpired` |
| `checkEscrowLine(lineId, payeeId)` (view) | 1 | line active and `now <= validUntil` | `LineExpired` |
| | 2 | line circuit closed | `CircuitOpen` |
| | 3 | line not paused | `Paused` |
| | 4 | binding `bound` (no listing rule) | `PayeeNotBound` |
| | 5 | `now >= coolingUntil` | `PayeeCooling` |
| `escrowFund(lineId, amount)` | 1 | `msg.sender == escrow` | `NotOwner` |
| | 2 | line `spent + escrowed + amount <= allocated` | `CapExceeded` |
| | 3 | `spent + escrowed + amount <= releasedMinor` and `<= funded` | `CapExceeded` |
| | — | effects: line and total escrowed += amount | |
| `escrowRelease(settlementId, lineId, payeeId, amount)` | 1 | `msg.sender == escrow` | `NotOwner` |
| | 2 | no settlement record for `settlementId` | `SettlementClosed` |
| | 2a | `now >= coolingUntil` of the payee's binding (audit run-3 v-5: a re-bind restarts cooling and replaces the payout account; autoRelease and `releaseMilestone` both end here) | `PayeeCooling` |
| | 3 | `paid + amount <= lifetimeCap` | `CapExceeded` |
| | — | effects: paid += amount; settlement record (kind milestone, open) | |
| `creditRevenue(saleIdHash, amount)` | 1 | `msg.sender == salesOracle` | `NotOwner` |
| | 2 | a plan is committed (`planVersion() > 0`; no reserveBps before it) | `StalePlan` |
| | — | effects: `skim = floor(amount * reserveBps / 10_000)` (current reserveBps); revenue += amount; reserve += skim; skimmed += skim; sales count += 1; emit `RevenueRecorded`, `ReserveSkimmed` | |

### Views

`queuedLoosen(id)`: the stored request; a `QUEUED` one with `now > expiresAt` reads as `EXPIRED`. Not frozen:
`governance()`, `escrow()`, `salesOracle()`, `observer()`, `loosenTimelockSeconds()`,
`revenueLedger() -> (reserveSkimmedMinor, reserveWithdrawnMinor, salesCount)`.

---

## Treasury entry points run in TreasuryGovernance

### `ownerSpend(req, founder)`: the founder's manual fallback (NFRA 二十六; G0 H4/H5)

| # | Check | Error | Rule |
|---|---|---|---|
| G-1 | module guard | `NotOwner` | |
| 1-4 | ENV-1 … ENV-4 over `OwnerSpend` (Treasury domain) | see ENV | §8.7, T2, T6, T16, T28 |
| 5 | `lineId != "RESERVE"` | `ReserveLocked` | T8 (the owner cannot spend the reserve either) |
| 6 | not (active line and `escrowOnly`) | `EscrowOnly` | §8.3, G0-DECISIONS §1 #5 |
| 7 | line active and `now <= validUntil` | `LineExpired` | §8.4 |
| 8 | payee bound **and listed on the line by the current version** | `PayeeNotBound` | spend row 10, run-2 audit |
| 9 | `now >= coolingUntil` | `PayeeCooling` | T3 |
| 10 | `intentId` (spend formula) not used | `DuplicateIntent` | T7 |
| 11 | invoice / pacing slot (spend rows 13-16) | `DuplicateInvoice` / `CapExceeded` | T17 |
| 12 | `amount > 0` | `CapExceeded` | |
| 13 | line `spent + escrowed + amount <= allocated` | `CapExceeded` | line balance |
| 14 | `paid + amount <= lifetimeCap` | `CapExceeded` | §8.3 |
| 15 | `spent + escrowed + amount <= releasedMinor` and `<= funded` | `CapExceeded` | stage stop-loss, funded BU |
| — | effects: nonce used; invoice paid or slot consumed; line/total spent and payee paid += amount; settlement record (spendId == intentId); **no window entry** (not agent outflow); emit `OwnerSpent(…, planVersion)`; return spendId | — | |

Skipped on purpose (§8.8, ITreasury NatSpec): the agent checks (role, revocation, expiry, planVersion), the per-tx and
window caps, the treasury pause, line pauses and tripped circuits.

### `releaseStage(req, lender)`: lender-signed StageRelease + the gate (§8.2, §26.2)

| # | Check | Error | Rule |
|---|---|---|---|
| G-1 | module guard | `NotOwner` | |
| 1-3 | ENV-1 … ENV-3 over `StageRelease` (Treasury domain) | see ENV | §8.7 |
| 4 | ENV-4L: the signature recovers the lender. A valid signature of a known non-lender role (agent, owner EOA, oracle) | `NotLender` | T23 |
| 4' | … any other failure (other kind, malformed, wrong digest, unknown signer) | `InvalidSignature` | T16, T28 |
| 5 | the stage was recorded by the first commit, is not released, and `req.amountMinor == releaseMinor` | `CapExceeded` | each stage once, exact amount |
| 6 | gate (as signed in the plan): `deadline == 0 or now <= deadline`, and `METRIC_SALES_MINOR`: `revenue >= target`; `METRIC_ORDERS`: recorded sales `>= target`; `METRIC_NONE` never | `CapExceeded` | stage gate ("salesMinor ≥ 200,000 within 30 days") |
| 7 | `_raiseReleased` rows 1-3 (as loop-1) | `CapExceeded` | |
| — | effects: nonce used; releasedMinor += releaseMinor; emit `StageReleased(stageId, amount, releasedTotal)` | — | |

Not blocked by pause (the lender's decision; pause stops agent outflow).

### `queueLoosen(req, founder, lender)` (§8.8, H2)

| # | Check | Error | Rule |
|---|---|---|---|
| G-1 | module guard | `NotOwner` | |
| 1-3 | ENV-1 … ENV-3 over `LoosenRequest` (Treasury domain) | see ENV | §8.7 |
| 4 | ENV-4 founder (agent or lender signer → `NotOwner`) | `NotOwner` / `InvalidSignature` | T6 |
| 5 | `requiresLender(kind)` (every kind) and the lender signature recovers the lender (ITreasury NatSpec: no threshold) | `InvalidSignature` | H2 |
| 6 | the kind's rules (next table), as at execution | per kind | H2 |
| 7 | expired entries pruned from the live list; then fewer than 16 live loosenings | `CapExceeded` | gas bound for pause |
| — | effects: nonce used; `loosenId = hashLoosenRequest(req)`; stored `{kind, target, aux, newValue, executableAt = now + timelock, expiresAt = executableAt + 7 days, QUEUED}`; added to the live list; emit `LoosenQueued` | — | |

Allowed while paused (the only way out of a pause is a co-signed `UNPAUSE`).

### `executeLoosen(loosenId)`: anyone

| # | Check | Error | Rule |
|---|---|---|---|
| G-1 | module guard | `NotOwner` | |
| 1 | status `QUEUED` (unknown, executed, cancelled → not executable) and `now >= executableAt` | `TimelockActive` | T9, demo task 12 |
| 2 | `now <= expiresAt` (grace period; inclusive) | `SignatureExpired` | §8.8 queued items expire |
| 3 | the kind's rules again, at execution time | per kind | H2 |
| — | effects: status `EXECUTED`; removed from the live list; apply (next table); emit `LoosenExecuted(id, kind)` | — | |

### `cancelLoosen(loosenId)`: veto

| # | Check | Error | Rule |
|---|---|---|---|
| G-1 | module guard | `NotOwner` | |
| 1 | caller is the lender, the observer (if set) or the owner EOA (if set) | `NotOwner` | §8.2 OBSERVER veto, T3 |
| 2 | status `QUEUED` (an expired one may still be cancelled) | `TimelockActive` | |
| — | effects: status `CANCELLED`; removed from the live list; emit `LoosenCancelled(id, by)` | — | |

### Loosen kinds: rules (`_checkLoosen`, at queue and at execution) and effects

| Kind | Rules, in order (violation ⇒ error) | Effect |
|---|---|---|
| 1 `RAISE_PER_TX_CAP` (target line) | line active (`LineExpired`); `newValue <= allocated / 4` (`C(4)`) | perTxCap = newValue |
| 2 `RAISE_WINDOW_CAP` (target line) | line active (`LineExpired`); `newValue <= allocated / 2` (`C(5)`) | windowCap = newValue |
| 3 `ADD_PAYEE` (target payee, aux line, newValue payoutAccountHash) | payee and hash non-zero (`C(13)`); line active (`LineExpired`) and `now <= validUntil` (`LineExpired`); line not escrowOnly (`C(10)`: supplier payees come from SupplierApproval); payee not a static platform payee (`C(11)`, as bindPayee row 8) | bound; `coolingUntil = now + coolingSeconds` (a re-add restarts it, T3); lifetimeCap = max (line caps bind it); payoutAccountHash = newValue; signed (`isSignedPayee`, replan R11); **listed by the current plan version** (spend row 10); emit `PayeeBound(payee, line, 0, coolingUntil, max, 0, 0, hash)` |
| 4 `EXTEND_AGENT_EXPIRY` (target 0) | `target == 0` (`C(13)`); a plan is committed (`StalePlan`); `newValue <= now + 90 days` (`C(2)`) | agentExpiry = newValue (revocation stays) |
| 5 `EXTEND_LINE_EXPIRY` (target line) | line active (`LineExpired`; an expired line is still active and can be extended); `newValue <= now + 90 days` (`C(6)`) | validUntil = newValue |
| 6 `MOVE_POCKETS` (target from, aux to, newValue amount) | `from != to` and `amount > 0` (`C(13)`); both lines active (`LineExpired`); `amount <= allocated − spent − escrowed` of the from-line (`CapExceeded`); from-line caps within 25 % / 50 % of `allocated − amount` (`C(4)`, `C(5)`) | from.allocated −= amount; to.allocated += amount (Σ allocated stays the plan total; a re-commit must carry the new amounts, replan R6) |
| 7 `UNPAUSE` (target 0 or line) | a line target is active (`LineExpired`) | target 0: `paused = false`. Line: line pause and circuit cleared, denial count reset; emit `Unpaused(target, by)` |
| 8 `WITHDRAW_RESERVE` (target taxPayeeId, newValue amount) | taxPayeeId is a static platform payee (`PayeeNotBound`: the destination is fixed at deployment, never free-form, T1); `0 < amount <= reserve` (`CapExceeded`) | reserve −= amount; withdrawn += amount; settlement record (kind reserve, settlementId = loosenId); emit `ReserveWithdrawn(loosenId, taxPayeeId, amount)` |
| other | — | `C(13)` |

---

## MilestoneEscrow

### `constructor(treasury)`

| # | Check | Error |
|---|---|---|
| 1 | `Treasury(treasury).escrow() == address(this)` | `C(13)` |
| — | effects: domain from Treasury's tags (verifying contract = this escrow, own nonce space); registry and lender read once | |

### `fundMilestone(orderId, idx, amount, decisionId, rationaleHash)`: agent only (§8.4)

| # | Check | Error | Rule |
|---|---|---|---|
| 1-3 | `Treasury.requireSpendingAgent(msg.sender)` | `NotAgent` / `Paused` / `AgentExpired` | §26.9 onlyAgent, T10, T15 |
| 4 | `decisionId != 0 && rationaleHash != 0` | `MissingDecision` | H5 |
| 5 | order exists and `idx < milestoneCount` | `PayeeNotBound` | |
| 6-10 | `Treasury.checkEscrowLine(order.lineId, order.payeeId)`: line active and valid, circuit closed, not paused, payee bound, cooled | `LineExpired` / `CircuitOpen` / `Paused` / `PayeeNotBound` / `PayeeCooling` | H6; **no listing rule** (the supplier is bound by its signed approval) |
| 11 | `amount > 0` | `CapExceeded` | |
| 12 | `milestone.funded + amount <= milestone.amount` (cumulative) | `AmountExceedsSchedule` | §8.4 signed schedule, T18 |
| 13-14 | `Treasury.escrowFund`: line balance, releasedMinor, funded | `CapExceeded` | §8.4; not perTxCap or the window cap |
| — | effects: milestone funded += amount; line and total escrowed += amount; emit `MilestoneFunded(orderId, idx, amount, fundedTotal, decisionId, rationaleHash)`; if `autoRelease` and now fully funded: release (below, evidenceHash 0) | — | |

### `releaseMilestone(release, founder)`: founder-signed (relayer submits)

| # | Check | Error | Rule |
|---|---|---|---|
| 1 | `msg.sender != current agent` (the agent alone never unlocks a milestone, even with a valid founder signature) | `MilestoneLocked` | T5, demo task 8 |
| 2-5 | ENV-1 … ENV-4 over `MilestoneRelease` (escrow domain; agent or lender signer → `NotOwner`) | see ENV | §8.7 |
| 6 | order exists and `idx < milestoneCount` | `PayeeNotBound` | |
| 7 | milestone not `autoRelease`, not released, and fully funded | `MilestoneLocked` | §8.1 (the balance needs stage 2 to be funded) |
| 8 | `release.amountMinor == milestone.amount` | `AmountExceedsSchedule` | |
| 9 | `inspectionRequired` ⇒ `evidenceHash != 0` | `EvidenceMissing` | §8.1 |
| 10 | `Treasury.escrowRelease`: settlement never existed; payee cooled (`now >= coolingUntil`); payee lifetime cap | `SettlementClosed` / `PayeeCooling` / `CapExceeded` | M8; T3, audit run-3 v-5. `SettlementClosed` is unreachable here since re-check M-1: a milestone with a settlement stays released (row 7) |
| — | effects: nonce used; released, evidenceHash stored; payee paid += amount; settlement (settlementId = keccak256(abi.encode(orderId, idx))); emit `MilestoneReleased` | — | |

Not blocked by pause, line pauses, circuits or line validity: the BU are already in escrow for this supplier, and this
is the owner's manual takeover (G0-DECISIONS §1 #5). **Cooling is enforced** (row 10, audit run-3 v-5): a re-bind of
the supplier (a new order, possibly a new payout account) restarts its cooling, and no milestone of any of its orders
releases until that veto window ends. An autoRelease milestone cannot release inside it either (`fundMilestone` checks
cooling first, and `escrowRelease` again).

### Treasury-only hooks

| Function | Check | Error |
|---|---|---|
| `openOrder(approval, schedule, autoRelease)` | `msg.sender == treasury` | `NotOwner` |

---

## SalesOracle

| Function | # | Check | Error | Rule |
|---|---|---|---|---|
| `constructor(treasury)` | 1 | `Treasury(treasury).salesOracle() == address(this)` | `C(13)` | |
| `recordSale(saleIdHash, amountBucket)` | 1 | `msg.sender == oracle` (read from Treasury) | `NotOracle` | T24, demo task 11 |
| | 2 | `saleIdHash` not recorded | `DuplicateSale` | T23 |
| | 3 | `Treasury.creditRevenue` rows (a plan is committed) | `StalePlan` | |
| | — | effects: recorded; emit `SaleRecorded`; Treasury credits revenue and skims the reserve | — | §8.1 |

A zero-amount bucket is recorded (it counts as an order for `METRIC_ORDERS` and skims 0). Allowed while paused.

---

## Deployment: `script/DeployFinal.s.sol`

Inherits every `DeployLoop` input and check (`run()` is now `virtual`). Audit run-3 added two off-Anvil checks to
DeployLoop on this branch, which DeployFinal inherits (loop-1 deploys from the `loop-1-src` tag and is unaffected):
`COOLING_SECONDS >= 120`, and a broadcaster that is not one of Anvil's ten default accounts. Additional checks before
anything is broadcast:

| Input | Check |
|---|---|
| `DEPLOYMENT_ID` | default `final-1`; never `loop-1` |
| `LOOSEN_TIMELOCK_SECONDS` | 1 s to 30 days (Treasury also enforces it, T-3); SafeCast to uint64; the 120 s demo default on Anvil only, any other chain must set it, **to at least 120 s** (audit run-3; production must use 24 h) |
| `COOLING_SECONDS` (inherited) | 1 s to 30 days; explicit off Anvil and **at least 120 s there** (audit run-3; production must use 24 h) |
| `OBSERVER_ADDRESS` | optional; **never `LENDER_ADDRESS` or `ORACLE_ADDRESS`** (audit run-3, Treasury T-4); off Anvil never one of Anvil's ten default accounts (a public key could veto every loosening) |
| broadcaster (inherited) | right after `vm.startBroadcast` / `vm.readCallers`, before any deployment: off Anvil never one of Anvil's ten default accounts (audit run-3: the escrow and sales-oracle links are precomputed from its nonces n+2 and n+3) |

After broadcast it asserts every link (registry ↔ treasury, treasury ↔ escrow, treasury ↔ sales oracle), lender,
oracle, the governance module's code and three distinct domain separators. These asserts run only in the forge
simulation. `PLATFORM_PAYEE_IDS` must include the tax payee `WITHDRAW_RESERVE` pays.

**Runbook step (audit run-3): `script/VerifyFinal.s.sol`.** Once the transactions are mined, run the read-only
`forge script script/VerifyFinal.s.sol --rpc-url <rpc>` (no `--broadcast`, no key). Inputs: `CHAIN_ID`,
`EXPECTED_DEPLOYMENT_ID`, `EXPECTED_CHAIN_TAG` (manifest `.chainId`, `.deploymentId`, `.chainTag`), `REGISTRY_ADDRESS`,
`TREASURY_ADDRESS`, `GOVERNANCE_ADDRESS`, `ESCROW_ADDRESS`, `SALES_ORACLE_ADDRESS`, `LENDER_ADDRESS`, `ORACLE_ADDRESS`,
`COOLING_SECONDS`, `LOOSEN_TIMELOCK_SECONDS` (all required) and `OBSERVER_ADDRESS` (default none); the script header has
a jq recipe that reads the saved manifest. Re-check L-2 added V-0 and V-11 to V-16, so the script checks everything
DeployFinal asserts or was given. Any failure reverts with the message below.

| # | Check (on the chain) | Message |
|---|---|---|
| V-0 | `block.chainid == CHAIN_ID` (re-check L-2: the RPC serves the manifest's chain) | `chain id mismatch` |
| V-1 | code at each of the five addresses | `no code at <INPUT>` |
| V-2 | `registry.treasury() == treasury` and `treasury.registry() == registry` | `registry <-> treasury link mismatch` |
| V-3 | `treasury.governance() == governance` | `treasury -> governance link mismatch` |
| V-4 | `treasury.escrow() == escrow` | `treasury -> escrow link mismatch` |
| V-5 | `treasury.salesOracle() == salesOracle` | `treasury -> sales oracle link mismatch` |
| V-6 | `escrow.treasury() == treasury` | `escrow -> treasury link mismatch` |
| V-7 | `salesOracle.treasury() == treasury` | `sales oracle -> treasury link mismatch` |
| V-8 | the governance module's registry, escrow, salesOracle, observer, timelock and coolingSeconds equal Treasury's | `governance immutables differ from treasury` |
| V-11 | `treasury.lender() == LENDER_ADDRESS` and `registry.lender() == LENDER_ADDRESS` (re-check L-2) | `lender mismatch` |
| V-12 | `treasury.oracle() == ORACLE_ADDRESS` and `salesOracle.oracle() == ORACLE_ADDRESS` (re-check L-2) | `oracle mismatch` |
| V-9 | `treasury.observer() == OBSERVER_ADDRESS` | `observer mismatch` |
| V-13 | `deploymentId()` of registry, treasury and escrow == `EXPECTED_DEPLOYMENT_ID` (re-check L-2) | `deployment id mismatch` |
| V-14 | `chainTag()` of registry, treasury and escrow == `EXPECTED_CHAIN_TAG` (re-check L-2) | `chain tag mismatch` |
| V-10 | `treasury.loosenTimelockSeconds() == LOOSEN_TIMELOCK_SECONDS` | `loosen timelock mismatch` |
| V-15 | `treasury.coolingSeconds() == COOLING_SECONDS` (re-check L-2) | `cooling seconds mismatch` |
| V-16 | off chain 31337: `coolingSeconds() >= 120` and `loosenTimelockSeconds() >= 120` (re-check L-2; DeployFinal's floors, production 24 h) | `cooling seconds must be >= 120 s off Anvil` / `loosen timelock must be >= 120 s off Anvil` |

---

## Decisions where the spec or the frozen interface is silent (lead review)

| # | Topic | Decision |
|---|---|---|
| 1 | "Agent spends reserve" (T8) | The reserve is not a line: `spend` and `ownerSpend` refuse `lineId "RESERVE"` with `ReserveLocked`. The only way to move reserve BU is a founder + lender `WITHDRAW_RESERVE` after the timelock. No ABI change; the TS forced send for T8 is `Treasury.spend` with that lineId |
| 2 | "Agent releases escrow balance" (T5) | `releaseMilestone` reverts `MilestoneLocked` whenever the caller is the agent key, before any other check, so the forced send always shows it (a founder-signed release is submitted by the relayer) |
| 3 | Stage gate errors | Gate unmet, past the deadline, wrong amount, unknown or released stage: `CapExceeded` (the stage stop-loss error of `_raiseReleased`). `METRIC_ORDERS` counts recorded sales |
| 4 | Lender signature | ECDSA only. `releaseStage`: a known non-lender signer gets `NotLender` (T23), anything else `InvalidSignature`. `queueLoosen`: any lender failure is `InvalidSignature` (frozen NatSpec) |
| 5 | Loosen lifecycle | Grace 7 days after `executableAt` (then `EXPIRED`, `SignatureExpired`); at most 16 live; rules checked at queue and again at execution; a not-queued id gets `TimelockActive` on execute and cancel (as the loop-1 stubs) |
| 6 | Pause | Cancels the queue only when it pauses an unpaused treasury (see `pause()`) |
| 7 | Observer | Optional constructor immutable; may cancel any queued loosening (as may the lender and the owner EOA). A set observer is never the agent, the owner EOA, the lender or the oracle (audit run-3) |
| 8 | ADD_PAYEE | Direct-pay lines only, not a platform payee; uncapped; cooled; listed by the current version (a re-commit that leaves it out drops it; R11 lets a later version list it again) |
| 9 | ownerSpend | Listing rule applies (a payee is payable only if the current version lists it); no window entry; on a pacing line it pays the next slot (pacing amount still applies) |
| 10 | Escrow vs line controls | `fundMilestone` stops for a paused, tripped or expired supplier line; `releaseMilestone` does not (funds already escrowed). Both stop while the payee is cooling (audit run-3 v-5) |
| 11 | Failed milestone settlement | **Re-check M-1:** the amount returns to the supplier line pocket (line and total escrowed fall by it, payee paid too), so no BU are stranded. The milestone stays released and dead (no re-fund: `AmountExceedsSchedule`; no re-release: `MilestoneLocked`) and its settlementId stays closed, so it is never paid twice. A new founder-signed `SupplierApproval` (new order) pays the supplier again. `MilestoneEscrow.releaseFailed` is gone. Before: the amount went back to the milestone, which could then neither re-fund nor release, so its BU were stranded and the oracle's veto of a phished re-bind (T3) cost the line for good |
| 12 | WITHDRAW_RESERVE destination | A static platform payee only (fixed payout account), else `PayeeNotBound` |
| 13 | Sales before the plan | `StalePlan` (no reserveBps yet, so the sale could not be skimmed) |
| 14 | §8.9 invariant 2 | Holds as worded: Σ pockets + spent + reserve + escrow == funded + recordedRevenue, where pockets = BU on hand in the line pockets (Σ `availableMinor` − unfunded allocation) + the **revenue pocket** (revenue − reserve skims: the founder's net sale revenue, recorded only, never agent-spendable), spent = spend + ownerSpend + reserve withdrawals (net of failed settlements), escrow = BU funded into milestones (released or not), net of releases whose payout failed (re-check M-1: those BU are back in the line pocket). `test/invariant/FinalInvariant.t.sol` |
