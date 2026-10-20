# Static analysis: Slither + Aderyn triage (task 1.14, 2026-10-18)

Scope: `contracts/src` (19 source units, 2,226 nSLOC; the `final-1` source) at `p1/dev` `6c0c52e`. The contracts
last changed in `df155b7` (PR #7, final-1 contracts and the run-3 fixes). Dependencies, tests and scripts are excluded.
`loop-1` deploys from the `loop-1-src` tag, which this run did not scan or touch.

**Result: no true positives, so no contract change.** Slither reported 89 results from 13 detectors and Aderyn 51
instances from 12 detectors. 67 are false positives (the hazard the tool describes cannot happen here) and 73 are
accepted design (the tool reads the code correctly, but the behaviour is intended and documented). The ABI, the
storage layout and the `final-1` deployment plan are unchanged.

## Summary

| Tool | Detector | Tool severity | Count | Verdict | Fix |
|---|---|---|---|---|---|
| Slither | `uninitialized-state` | High | 10 | false positive | — |
| Slither | `reentrancy-no-eth` | Medium | 1 | false positive | — |
| Slither | `uninitialized-local` | Medium | 1 | false positive | — |
| Slither | `unused-return` | Medium | 9 | false positive | — |
| Slither | `events-maths` | Low | 2 | accepted design | — |
| Slither | `missing-zero-check` | Low | 5 | accepted design | — |
| Slither | `reentrancy-events` | Low | 4 | false positive | — |
| Slither | `timestamp` | Low | 17 | accepted design | — |
| Slither | `assembly` | Informational | 1 | accepted design | — |
| Slither | `cyclomatic-complexity` | Informational | 2 | accepted design | — |
| Slither | `naming-convention` | Informational | 10 | accepted design | — |
| Slither | `unused-state` | Informational | 13 | accepted design | — |
| Slither | `constable-states` | Optimization | 14 | false positive | — |
| Aderyn | `reentrancy-state-change` | High | 7 | false positive | — |
| Aderyn | `unsafe-casting` | High | 7 | false positive | — |
| Aderyn | `yul-return` | High | 1 | accepted design | — |
| Aderyn | `costly-loop` | Low | 10 | accepted design | — |
| Aderyn | `internal-function-used-once` | Low | 1 | accepted design | — |
| Aderyn | `large-numeric-literal` | Low | 2 | false positive | — |
| Aderyn | `literal-instead-of-constant` | Low | 7 | accepted design | — |
| Aderyn | `require-revert-in-loop` | Low | 1 | accepted design | — |
| Aderyn | `state-change-without-event` | Low | 3 | accepted design | — |
| Aderyn | `state-no-address-check` | Low | 2 | false positive | — |
| Aderyn | `unchecked-return` | Low | 3 | false positive | — |
| Aderyn | `uninitialized-local-variable` | Low | 7 | false positive | — |
| **Total** | | | **140** | **0 true positive, 67 false positive, 73 accepted design** | |

By tool: Slither has 39 false positives and 50 accepted design; Aderyn has 28 false positives and 23 accepted design.

Most of Slither's High and Optimization results come from one source. Treasury and its delegate-only module
`TreasuryGovernance` both inherit `TreasuryState`. Slither analyses the module as a standalone contract, where those
variables are never written. The module only ever runs by `delegatecall` in Treasury's storage, where Treasury writes
them. See [The governance module](#the-governance-module-delegatecall).

## Tools and how to reproduce

| Tool | Version | Source and install |
|---|---|---|
| Slither | 0.11.6 (PyPI `slither-analyzer`, released 2026-07-28), crytic-compile 0.4.2 | `uv tool install slither-analyzer==0.11.6` |
| Aderyn | 0.6.8 (GitHub release `aderyn-v0.6.8`, Cyfrin/aderyn, 2026-01-22) | The release's own `aderyn-installer.sh`, run with `ADERYN_UNMANAGED_INSTALL=$HOME/.local/bin` (no profile edits, no updater). The `aarch64-apple-darwin` tarball's sha256 `624c6652…4aac` matches both the release `.sha256` file and the checksum inside the installer |
| Foundry / solc | forge 1.8.5, solc 0.8.37, evm `cancun`, OZ 5.7.0 (Soldeer) | As in `docs/VERSIONS.md` |

```bash
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
cd contracts
slither . --filter-paths "dependencies/|test/|script/" --exclude-dependencies --checklist > slither.md
aderyn . --src src -o aderyn.md
```

Slither exits 255 whenever it reports results; that is not a failure. Both runs used the default detector sets
(Slither 102 detectors over 40 contracts; Aderyn 88 detectors).

## Verdicts

- **True positive:** a real defect. It gets a failing Foundry test, then the fix.
- **False positive:** the tool's claim does not hold here (the state is written, the call cannot re-enter, the cast is
  bounded, the value is checked).
- **Accepted design:** the tool describes the code correctly, but the behaviour is intended, documented in the require
  tables or G0-DECISIONS, and has no exploitable consequence.

Many of these lines already carry `forge-lint: disable-next-line(...)` comments with the same reasoning. forge lint
raises the equivalent lints, and they were reviewed when the code was written.

---

## The governance module (delegatecall)

require-table-final1 "Governance module (delegatecall)": Treasury creates `TreasuryGovernance` in its constructor
and keeps the address in an immutable. `ownerSpend`, `releaseStage`, `queueLoosen`, `executeLoosen` and `cancelLoosen`
forward unchanged by `delegatecall` (`Treasury._delegate`). A direct call to the module reverts `NotOwner` (G-1,
`onlyDelegated`). Both contracts inherit the same `TreasuryState` and declare no state of their own.
`pnpm contracts:storage-layout` checks this in CI, and on this commit it reports that Treasury and TreasuryGovernance
share 34 entries (label, slot, offset, type). `test/TreasuryGovernanceModule.t.sol` has a direct-call revert test for
each of the five entry points.

### Slither `uninitialized-state` (High) — 10, false positive

Each variable is declared in `src/TreasuryState.sol` and reported only in the context of the module's functions.
Treasury writes each one in the storage the module runs in:

| Variable | Read in (module context) | Written by Treasury at |
|---|---|---|
| `_planVersion` (:116) | `_checkLoosen`, `_addPayee`, `_isActive`, `_requirePayeeReady`, `ownerSpend` | `Treasury.syncPlan` (Treasury.sol:289) |
| `_agentRevoked` (:123) | `_requireSpendingAgent`, `_requireAgent`, `_requireTightener` | `Treasury.tighten` REVOKE_AGENT (Treasury.sol:182) |
| `_agent` (:120) | the three guards above, `_requireFounder`, `_requireLender` | `Treasury.syncPlan`, first commit (Treasury.sol:302) |
| `_planId` (:113) | `ownerSpend` (intentId) | `Treasury.syncPlan`, first commit (Treasury.sol:299) |
| `_platformPayout` (:140) | `_checkLoosen` (ADD_PAYEE, WITHDRAW_RESERVE) | Treasury constructor (Treasury.sol:68) |
| `_salesCount` (:154) | `_gateMet` (METRIC_ORDERS) | `creditRevenue` (TreasuryModuleHooks.sol:85) |
| `_fundedMinor` (:98) | `_requireOwnerAmount` | `Treasury.fund` (Treasury.sol:96) |
| `_planTotalMinor` (:127) | `_raiseReleased` (releaseStage) | `Treasury.syncPlan`, first commit (Treasury.sol:300) |
| `_revenueMinor` (:106) | `_gateMet` (METRIC_SALES_MINOR) | `creditRevenue` (TreasuryModuleHooks.sol:82) |
| `_escrowedMinor` (:104) | `_requireOwnerAmount` | `escrowFund` (TreasuryModuleHooks.sol:45), `failSettlement` (Treasury.sol:268) |

The module's own storage is never used: every entry point is `onlyDelegated`, and the only other externals are
HogeeDomain/TreasuryState views (`isNonceUsed`, `domainSeparator`, the public immutables), which move nothing.

### Slither `constable-states` (Optimization) — 14, false positive

Same cause. Slither suggests `constant` for `_reserveBps`, `_salesCount`, `_reserveSkimmedMinor`, `_revenueMinor`,
`_fundedMinor`, `_escrowedMinor`, `_capMinor`, `_planTotalMinor`, `_planId`, `_agentRevoked`, `_agent`,
`_reserveFloorBps`, `_planVersion` and `_opened` (all in `src/TreasuryState.sol`). Each is written by Treasury:
`openFacility` writes `_capMinor`, `_reserveFloorBps` and `_opened` (Treasury.sol:85-87); `syncPlan` and `tighten`
write `_reserveBps` (Treasury.sol:293, :177); `creditRevenue` writes `_reserveSkimmedMinor` (TreasuryModuleHooks.sol:84).
The others are in the table above. Making any of them `constant` would break the ledger.

### Slither `unused-state` (Informational) — 13, accepted design

Each derived contract has to inherit the whole `TreasuryState`, or the two storage layouts would differ. Some members
are used by only one side:

- not used in `TreasuryGovernance` (TreasuryState.sol): `SETTLEMENT_KIND_MILESTONE` (:61), `MAX_LIVE_SPENDS_PER_WINDOW`
  (:63), `BPS` (:69), `_capMinor` (:92), `_reserveFloorBps` (:93), `_opened` (:94), `_reserveBps` (:124), `_windows`
  (:131), `_orderUsed` (:143), `_reserveSkimmedMinor` (:149);
- not used in `Treasury`: `SETTLEMENT_KIND_RESERVE` (:62), `LOOSEN_GRACE` (:66), `MAX_QUEUED_LOOSENS` (:68). Treasury's
  `pause` loop is bounded by the module's `MAX_QUEUED_LOOSENS` check at queue time.

Constants occupy no storage, and the state variables are the shared layout itself.

---

## Reentrancy and external calls

Apart from OpenZeppelin `P256`'s static call to the RIP-7212 precompile (passkey verification), every external call in
`src` goes to another contract of the same deployment, held in a constructor immutable with no setter (require-table-final1 "all constructor immutables, no setters, no upgradeability"). The deploy scripts assert
the links, and `VerifyFinal` V-2…V-8 re-check them on chain. Every state-changing callee checks its caller
(`escrowFund` / `escrowRelease`: `msg.sender == escrow`; `creditRevenue`: `== salesOracle`; `syncPlan`: `== registry`;
`openOrder`: `== treasury`), and none of them makes an external call. So no call can re-enter its caller. No ETH or
other on-chain asset moves anywhere: budget units are an internal ledger (D4).

### Slither `reentrancy-no-eth` (Medium) — 1, false positive

`MilestoneEscrow.fundMilestone` (MilestoneEscrow.sol:63-84). `m.released` and `m.evidenceHash` are written in
`_release` (:160-161) after the call to `Treasury.escrowFund` (:80). `escrowFund` (TreasuryModuleHooks.sol:35-46) only
checks and updates counters and makes no external call. `m.fundedMinor` is written before the call (:78), and the
release call itself (:163) comes after `m.released = true`. No path calls back into the escrow.

### Slither `reentrancy-events` (Low) — 4, false positive

- `MilestoneFunded` (MilestoneEscrow.sol:82) after `escrowFund` (:80);
- `MilestoneReleased` (MilestoneEscrow.sol:165) after `escrowRelease` (:163), reported twice (through `fundMilestone`
  :83 and in `_release` itself);
- `PlanCommitted` (PlanRegistry.sol:282, via `_emitCommitted` :152) after `Treasury.syncPlan` (:139).

The callees are the trusted immutables above and cannot call back, so the event order inside the transaction is fixed.
`PlanCommitted` is emitted after `syncPlan` on purpose: it logs `releasedMinor` as Treasury just set it.

### Aderyn `reentrancy-state-change` (High) — 7, false positive

| Location | External call before the write | Why it is safe |
|---|---|---|
| MilestoneEscrow.sol:49, :52 (constructor) | `escrow()`, `registry()`, `lender()` views | Constructor reads; the writes are immutables. The escrow has no runtime code until the constructor returns, so nothing can call it |
| MilestoneEscrow.sol:67, :71 (`fundMilestone`) | `requireSpendingAgent`, `checkEscrowLine` | `view` functions, so `STATICCALL`: they cannot change state or re-enter with a write |
| PlanRegistry.sol:91 (`registerFounderKey`) | `oracle()`, `observer()` | `view` (`STATICCALL`) on the immutable Treasury (require-table-final1 row 5) |
| SalesOracle.sol:24 (constructor) | `salesOracle()`, `oracle()` | Constructor reads; the writes are immutables |
| TreasuryGovernance.sol:145 (`cancelLoosen`) | `founderKey()` | `view` (`STATICCALL`) on the immutable PlanRegistry, to authorise the caller (require-table-final1 cancelLoosen row 1) |

---

## Arithmetic and casts

### Aderyn `unsafe-casting` (High) — 7, false positive

`TreasuryLoosenRules._applyLoosen` narrows the co-signed `uint256 newValue`. It runs only from `executeLoosen`, right
after `_checkLoosen` re-checks the kind's bounds on the current state (require-table-final1 executeLoosen row 3, and
"Loosen kinds: rules … at queue and at execution"). Each bound fits the target type:

| Line | Cast | Bound from `_checkLoosen` |
|---|---|---|
| :60 | `perTxCapMinor = uint128(newValue)` (RAISE_PER_TX_CAP) | `newValue <= allocatedMinor / 4`, and `allocatedMinor` is a uint128 (code 4) |
| :62 | `windowCapMinor = uint128(newValue)` (RAISE_WINDOW_CAP) | `newValue <= allocatedMinor / 2` (code 5) |
| :66 | `_agentExpiry = uint64(newValue)` (EXTEND_AGENT_EXPIRY) | `newValue <= _now() + 90 days`, and `_now()` is unix seconds (code 2) |
| :68 | `validUntil = uint64(newValue)` (EXTEND_LINE_EXPIRY) | `newValue <= _now() + 90 days` (code 6) |
| :70, :71 | `allocatedMinor ∓= uint128(newValue)` (MOVE_POCKETS) | `newValue <= allocated − spent − escrowed` of the from-line; the `+=` is checked 0.8 arithmetic, and the sum of allocations stays the plan total |
| :75 | `_withdrawReserve(…, uint128(newValue))` | `0 < newValue <= _reserveMinor` (uint128) |

A cap written back at :60/:62 can undo a later `TIGHTEN_LOWER_*` of the same line. That is the run-3 lead v-6
("queued loosening overrides later tightening"), which was rejected as documented design: founder and lender both
signed the value, it is re-bounded at execution, and each tightener can tighten again or `pause()` to cancel the queue
(require-table-final1 decision 6; `docs/security-audit-run-3/findings.json`). This run does not change that verdict.

### Slither `events-maths` (Low) — 2, accepted design

- `escrowFund` `_escrowedMinor += amountMinor` (TreasuryModuleHooks.sol:45): logged by MilestoneEscrow's
  `MilestoneFunded` (amount and funded total) in the same call;
- `syncPlan` `_planVersion = s.version` (Treasury.sol:289): logged by PlanRegistry's `PlanCommitted` (version) in the
  same transaction.

### Aderyn `large-numeric-literal` (Low) — 2, false positive

`BPS = 10_000` (PlanConstitution.sol:17, TreasuryState.sol:69). Both are already named constants, and the underscore
separator is clearer than `1e4` for a basis-point base.

### Aderyn `literal-instead-of-constant` (Low) — 7, accepted design

- `32` three times at HogeeSigs.sol:30: the ABI word size in the 0x20-offset prefix check (require-table-loop1 decision 12);
- `4` at PlanConstitution.sol:55 and :132 and TreasuryLoosenRules.sol:90 and :107: the §8.3 percentages written as
  integer ratios (stage 1 ≤ 40 % as `×10 > ×4`, per-tx ≤ 25 % as `×4` or `/4`), each next to its `CONST_*` code. The
  TS constitution mirror uses the same ratios.

---

## Time

### Slither `timestamp` (Low) — 17, accepted design

The protocol is time-based by specification: signature expiry, agent and line expiry, payee cooling, loosening
timelock and grace, rolling windows, stage deadlines, and the denial window (§8.4, §8.8). `_now()` is
`block.timestamp` (÷1000 on FISCO). On Sepolia (proof of stake) the slot fixes the timestamp, so a proposer cannot
choose it; on other chains its leeway is seconds. The shortest windows are the ≥ 120 s
cooling and timelock floors off Anvil (G0-DECISIONS §7 "Deploy floors"; production 24 h), and the rest are hours to
90 days. Instances:

| Function | Location | Comparison |
|---|---|---|
| `recordDenied` | Treasury.sol:224, :228, :229 | rate-limit horizon, denials within the window |
| `_checkLoosen` | TreasuryLoosenRules.sol:24, :33, :38 | line validity, 90-day horizons |
| `ownerSpend` | TreasuryGovernance.sol:61 | line validity |
| `_useEnvelope` | HogeeDomain.sol:66 | ENV-2 signature expiry |
| `checkEscrowLine` | TreasuryModuleHooks.sol:26, :31 | line validity, cooling |
| `_requireLineOpen` | Treasury.sol:354 | spend row 7 |
| `_requirePayeeReady` | TreasuryState.sol:275 | spend row 11 cooling |
| `queuedLoosen` | TreasuryStorage.sol:104 | EXPIRED view |
| `_requireSpendingAgent` | TreasuryState.sol:204 | spend row 3 |
| `_requireAgent` | TreasuryState.sol:210 | recordDenied row 2 |
| `escrowRelease` | TreasuryModuleHooks.sol:55 | row 2a cooling (run-3 v-5) |
| `executeLoosen` | TreasuryGovernance.sol:132, :133 | timelock, grace |
| `bindPayee` | Treasury.sol:120 | row 9 line validity |
| `_pruneExpired` | TreasuryGovernance.sol:168 | grace expiry |
| `commitPlan` | PlanRegistry.sol:134 | `code != 0`, which depends on `now` through codes 2, 3 and 6 |
| `_requireTightener` | TreasuryState.sol:217 | tighten row 1 |
| `_gateMet` | TreasuryGovernance.sol:227 | stage-gate deadline |

---

## Inputs, returns and locals

### Slither `missing-zero-check` (Low) — 5, accepted design

Constructor arguments `Treasury` `registry_` / `oracle_` (Treasury.sol:50-51, passed on to `new TreasuryGovernance`),
`PlanRegistry` `lender_` / `treasury_` (PlanRegistry.sol:65-66), and `MilestoneEscrow`'s `registry_`
(MilestoneEscrow.sol:52, read from the linked Treasury, not an argument). `DeployLoop` (inherited by `DeployFinal`)
requires non-zero `LENDER_ADDRESS` / `ORACLE_ADDRESS` before anything is broadcast. `VerifyFinal` V-2 and V-11/V-12
check the links, lender and oracle on chain (require-table-loop1 "Deployment"; require-table-final1 VerifyFinal). A zero
would only brick its own deployment and never grants authority: a zero `registry_` reverts in Treasury's constructor
(the `deploymentId()` call decodes no return data), a zero lender or oracle can never be `msg.sender`, and code 13 keeps
the agent off a zero oracle.

### Aderyn `state-no-address-check` (Low) — 2, false positive

`_agent = a.agent` (PlanRegistry.sol:257) and `_agent = s.agent` (Treasury.sol:302). Constitution code 13 rejects
`agent == address(0)` (PlanConstitution.sol:71) before either write, and `syncPlan` is callable only by PlanRegistry
after that check (require-table-loop1 code 13 and `syncPlan`).

### Slither `unused-return` (Medium) — 9, false positive

Each call destructures a multi-value return and keeps what it needs. Nothing that signals failure is dropped:

- `ECDSA.tryRecoverCalldata` (TreasuryState.sol:246, HogeeSigs.sol:21): only the third value (`errArg`) is dropped,
  and `err` is checked;
- `agentState()` (MilestoneEscrow.sol:93 keeps the agent; PlanReplan.sol:36 keeps agent, expiry and reserveBps for R2-R4);
- `founderKey()` (TreasuryGovernance.sol:145, :215; TreasuryState.sol:222): only `ownerEOA` is needed (the passkey
  owner cannot send a transaction);
- `stage()` (TreasuryGovernance.sol:226): the gate needs the signed stage, and `released` is checked from Treasury's own
  record first (`releaseStage` :82);
- `RollingWindow.live` (TreasuryStorage.sol:49): `rollingSpent` returns the sum, not the count.

### Aderyn `unchecked-return` (Low) — 3, false positive

- `_requireTightener()` in `pause()` (Treasury.sol:201): it is called for its revert. The `isAgent` result only decides
  tighten's `decisionId` row, and the frozen `pause()` takes no `decisionId` (require-table-final1 `pause()` row 1:
  "same caller rule as loop-1");
- `_activeLine(target)` (TreasuryLoosenRules.sol:37) and `_activeLine(to)` (:103): called for the `LineExpired` revert;
  the storage pointer is not needed.

### Slither `uninitialized-local` (Medium) — 1, and Aderyn `uninitialized-local-variable` (Low) — 7, false positive

- Slither: `oldValue` in `Treasury.tighten` (Treasury.sol:159) is assigned in every branch that does not revert (the
  final `else` reverts `C(13)`);
- Aderyn: loop counters `uint256 i;` / `j;` / `p;` / `q;`, which Solidity zero-initialises (PlanConstitution.sol:78,
  :93, :98, :100, :147; PlanReplan.sol:67; Treasury.sol:456). This is the codebase's loop style.

---

## Loops, size and style

### Aderyn `costly-loop` (Low) — 10, accepted design

Every loop that writes storage has a hard bound from the require tables:

| Location | Loop | Bound |
|---|---|---|
| MilestoneEscrow.sol:125 | `openOrder` milestones | ≤ 8 (bindPayee row 5) |
| PlanRegistry.sol:239, Treasury.sol:294 | lines in `_storePlan` / `syncPlan` | ≤ 16 (code 13) |
| PlanRegistry.sol:261, Treasury.sol:303 | stages | ≤ 8 (code 13) |
| Treasury.sol:456 | payees per line in `_syncLine` | ≤ 8 (code 13) |
| RollingWindow.sol:29 | `prune` pops | ≤ 64 entries (spend row 18) |
| Treasury.sol:205 | `pause` cancels the queue | ≤ 16 (queueLoosen row 7) |
| TreasuryGovernance.sol:167, :181 | `_pruneExpired`, `_dequeue` | ≤ 16 (queueLoosen row 7) |

### Aderyn `require-revert-in-loop` (Low) — 1, accepted design

`_requireSchedule` (Treasury.sol:400, revert at :404): a signed schedule with one zero milestone must fail as a whole
(require-table-final1 bindPayee row 6a, audit run-3). Skipping the bad entry would change what the founder signed.

### Aderyn `state-change-without-event` (Low) — 3, accepted design

`MilestoneEscrow.openOrder` (:111), `escrowFund` (TreasuryModuleHooks.sol:35) and `escrowRelease` (:49) are hooks.
Their caller logs the change in the same transaction: `PayeeBound` (orderId, supplierId, scheduleHash, cap, payout
account; G0-REVIEW M7), `MilestoneFunded` and `MilestoneReleased` (settlementId).

### Slither `assembly` (Informational) — 1, and Aderyn `yul-return` (High) — 1, accepted design

`Treasury._delegate` (Treasury.sol:472-482; the `return` at :480) forwards the call to the immutable governance module
and returns or reverts with its result. It is the `OpenZeppelin Proxy._delegate` pattern and is meant to halt there.
The five forwarding functions have no code after the call (require-table-final1 "Governance module").

### Slither `cyclomatic-complexity` (Informational) — 2, accepted design

`Treasury.tighten` (Treasury.sol:156-194, 16) and `TreasuryLoosenRules._checkLoosen` (TreasuryLoosenRules.sol:18-52,
19). Each is a dispatch on the frozen `TIGHTEN_*` / `LOOSEN_*` kind, one branch per require-table row, which keeps the
rule order readable against the table.

### Slither `naming-convention` (Informational) — 10, accepted design

Private or internal immutables named `_UPPER_CASE`: `Treasury._GOVERNANCE` (:34), `TreasuryState._LENDER` / `_ORACLE`
(:76-77), `HogeeDomain._DEPLOYMENT_ID` / `_CHAIN_TAG` / `_DOMAIN_SEPARATOR` / `_FISCO_MS` (:12-16),
`PlanRegistry._LENDER` (:37), `MilestoneEscrow._LENDER` (:37), `TreasuryGovernance._SELF` (:30). This is the
codebase's (and forge-lint's) convention for immutables.

### Aderyn `internal-function-used-once` (Low) — 1, accepted design

`HogeeTypes.domainSalt` (HogeeTypes.sol:62) is kept separate because it names the §8.7 salt formula, which the viem
side and the golden vectors reproduce.

---

## Fixes and re-check

No finding is a true positive, so there is no fix, no new test, no contract or ABI change, and no contract fix to
security re-check. The `loop-1-src` tag is untouched. Run on this commit:

- `FOUNDRY_PROFILE=ci forge test`: 30 suites, 534 tests passed, 0 failed;
- `pnpm contracts:storage-layout` (`node scripts/check-storage-layout.ts`): OK, 34 shared entries.

`pnpm abi:check` and `pnpm typecheck` were not needed: no contract or TypeScript source changed.
