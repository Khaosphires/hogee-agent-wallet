// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    Line,
    Stage,
    Sig,
    SupplierApproval,
    StageRelease,
    OwnerSpend,
    LoosenRequest,
    PayeeBinding,
    HogeeKinds
} from "./interfaces/IHogee.sol";
import {HogeeTypes} from "./interfaces/HogeeTypes.sol";
import {TreasuryStorage} from "./TreasuryStorage.sol";
import {TreasuryModuleHooks} from "./TreasuryModuleHooks.sol";
import {TreasuryGovernance} from "./TreasuryGovernance.sol";
import {RollingWindow} from "./RollingWindow.sol";
import {PlanSync, TreasuryLinks, IEscrowHooks} from "./HogeeHooks.sol";

/// @title Treasury: the budget-unit ledger and the agent's spend path (project.md §8.1, §8.4, §8.8).
/// @notice Task 1.4: openFacility, fund, bindPayee, spend, tighten, pause, recordDenied + circuit breaker,
///         confirmSettlement / failSettlement and every view. Task 1.8: the MilestoneEscrow / SalesOracle hooks
///         (TreasuryModuleHooks), and ownerSpend, releaseStage and the loosening queue, which run in the delegate-only
///         TreasuryGovernance module this constructor creates (size split). Pockets are an internal mapping in minor
///         units: no transferable balance, no external balance surface (D4). Every check, in order:
///         docs/assurance/require-table-loop1.md and docs/assurance/require-table-final1.md.
contract Treasury is TreasuryModuleHooks {
    using RollingWindow for RollingWindow.Queue;

    /// Delegate-only module with the founder/lender-signed entry points (TreasuryGovernance), created here with the
    /// same arguments; immutable, so the code a delegatecall can run is fixed for life.
    address private immutable _GOVERNANCE;

    uint256 private constant MAX_MILESTONES = 8;
    uint8 private constant CIRCUIT_THRESHOLD = 3;
    /// Denial-count window for keys that are not an active line (lineId 0 or a line outside the plan).
    uint64 private constant DEFAULT_DENIAL_WINDOW = 1 days;

    /// @param links MilestoneEscrow / SalesOracle of this deployment (0 = loop-1 shape), the optional observer and the
    /// loosening timelock (1 s to 30 days, else C(13)).
    /// @param platformPayeeIds static platform registry (§8.3), e.g. a marketplace's ads account; fixed for life.
    /// @param platformPayoutHashes keccak256(utf8(JCS({channel, accountNumber, holderName}))) per platform payee.
    /// Same length, every id and hash non-zero (a zero hash reads as "not a platform payee"), no duplicate id, else
    /// C(13): checked here, not only by the deploy script (run-2 audit).
    // Roles are checked non-zero by the deploy scripts; a zero address here only bricks this deployment.
    // forge-lint: disable-next-item(missing-zero-check)
    constructor(
        address registry_,
        address oracle_,
        uint64 coolingSeconds_,
        TreasuryLinks memory links,
        bytes32[] memory platformPayeeIds,
        bytes32[] memory platformPayoutHashes
    ) TreasuryStorage(registry_, oracle_, coolingSeconds_, links) {
        _GOVERNANCE = address(new TreasuryGovernance(registry_, oracle_, coolingSeconds_, links));
        uint256 n = platformPayeeIds.length;
        if (n != platformPayoutHashes.length) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        for (uint256 i; i < n; ++i) {
            bytes32 id = platformPayeeIds[i];
            bytes32 accountHash = platformPayoutHashes[i];
            if (id == bytes32(0) || accountHash == bytes32(0) || _platformPayout[id] != bytes32(0)) {
                // Constructor input check: one bad entry must fail the whole deployment.
                // forge-lint: disable-next-line(require-revert-in-loop)
                revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
            }
            _platformPayout[id] = accountHash;
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Lender
    // ---------------------------------------------------------------------------------------------------------

    function openFacility(uint128 capMinor, uint16 reserveFloorBps) external {
        if (msg.sender != _LENDER) revert NotLender();
        if (reserveFloorBps > BPS) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        if (_planVersion != 0) {
            if (capMinor < _planTotalMinor) revert PlanInvariantViolated(HogeeKinds.CONST_LINES_EXCEED_FACILITY_CAP);
            if (reserveFloorBps > _reserveBps) revert PlanInvariantViolated(HogeeKinds.CONST_RESERVE_BELOW_FLOOR);
        }
        // No `capMinor >= fundedMinor` row: funded <= plan total (fund) <= capMinor (above), and totalMinor is fixed
        // by version 1 (G0 audit v-1). Before any plan, funded is 0.
        _capMinor = capMinor;
        _reserveFloorBps = reserveFloorBps;
        _opened = true;
        emit FacilityOpened(msg.sender, capMinor, reserveFloorBps);
    }

    function fund(uint128 amountMinor) external {
        if (msg.sender != _LENDER) revert NotLender();
        uint256 funded = uint256(_fundedMinor) + amountMinor;
        if (funded > _planTotalMinor || funded > _capMinor) revert CapExceeded();
        // forge-lint: disable-next-item(unsafe-typecast)
        _fundedMinor = uint128(funded); // funded <= _planTotalMinor (uint128), checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        emit Funded(amountMinor, uint128(funded));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Founder-signed (anyone may submit; the relayer gains no authority)
    // ---------------------------------------------------------------------------------------------------------

    function bindPayee(
        SupplierApproval calldata a,
        uint128[] calldata schedule,
        bool[] calldata autoRelease,
        Sig calldata founder
    ) external {
        _useEnvelope(a.deploymentId, a.expiry, a.nonce);
        _requireFounder(_digest(HogeeTypes.hashSupplierApproval(a)), founder);
        _requireSchedule(a, schedule, autoRelease);
        // A static platform payee is uncapped and keeps its fixed account: a signed binding of one would break code
        // 11 (lifetime cap == schedule total) and replace that account (run-2 audit).
        if (_platformPayout[a.payee] != bytes32(0)) {
            revert PlanInvariantViolated(HogeeKinds.CONST_PAYEE_CAP_OVER_SCHEDULE);
        }
        LineState storage l = _lines[a.lineId];
        if (!_isActive(l) || _now() > l.validUntil) revert LineExpired();
        if (!l.escrowOnly) revert PlanInvariantViolated(HogeeKinds.CONST_SUPPLIER_LINE_NOT_ESCROW);
        if (_orderUsed[a.orderId]) revert DuplicateIntent();
        _bind(a);
        // The order lives in MilestoneEscrow (0 on the loop-1 shape, which has no escrow). The only external call: this
        // deployment's immutable escrow, after every effect here.
        if (escrow != address(0)) IEscrowHooks(escrow).openOrder(a, schedule, autoRelease);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Agent
    // ---------------------------------------------------------------------------------------------------------

    /// §8.4. spendId == intentId == settlementId.
    function spend(
        bytes32 lineId,
        bytes32 payeeId,
        uint128 amountMinor,
        bytes32 invoiceHash,
        uint32 planVersion,
        bytes32 decisionId,
        bytes32 rationaleHash
    ) external returns (bytes32 spendId) {
        _requireSpendingAgent(msg.sender);
        if (decisionId == bytes32(0) || rationaleHash == bytes32(0)) revert MissingDecision();
        if (lineId == LINE_RESERVE) revert ReserveLocked(); // T8: the reserve is not a line
        _requireLineOpen(lineId, planVersion);
        _requirePayeeReady(lineId, payeeId);
        spendId = HogeeTypes.intentId(_planId, lineId, payeeId, invoiceHash, amountMinor);
        if (_settlements[spendId].kind != 0) revert DuplicateIntent();
        _requireInvoice(_lines[lineId], invoiceHash, amountMinor);
        _requireCaps(lineId, payeeId, amountMinor);
        _recordSpend(spendId, lineId, payeeId, invoiceHash, amountMinor);
        emit Spent(spendId, lineId, payeeId, amountMinor, invoiceHash, decisionId, rationaleHash, planVersion);
    }

    function tighten(uint8 kind, bytes32 target, uint256 newValue, bytes32 decisionId) external {
        bool isAgent = _requireTightener();
        if (isAgent && decisionId == bytes32(0)) revert MissingDecision();
        uint256 oldValue;
        if (kind == HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP || kind == HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP) {
            LineState storage l = _requireActiveLine(target);
            bool perTx = kind == HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP;
            oldValue = perTx ? l.perTxCapMinor : l.windowCapMinor;
            if (newValue > oldValue) revert NotOwner(); // raising needs the owner's LoosenRequest (T6)
            // newValue <= oldValue, which is a uint128: the casts cannot truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (perTx) l.perTxCapMinor = uint128(newValue);
            // forge-lint: disable-next-line(unsafe-typecast)
            else l.windowCapMinor = uint128(newValue);
        } else if (kind == HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS) {
            if (target != bytes32(0) || newValue > BPS) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
            // No plan reserve yet: the first syncPlan would silently overwrite it (run-2 audit).
            if (_planVersion == 0) revert StalePlan();
            oldValue = _reserveBps;
            if (newValue < oldValue) revert NotOwner();
            // forge-lint: disable-next-line(unsafe-typecast)
            _reserveBps = uint16(newValue); // <= 10_000, checked above
        } else if (kind == HogeeKinds.TIGHTEN_REVOKE_AGENT) {
            if (target != bytes32(0) || newValue != 0) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
            oldValue = _agentRevoked ? 1 : 0;
            newValue = 1;
            _agentRevoked = true;
        } else if (kind == HogeeKinds.TIGHTEN_PAUSE_LINE) {
            if (newValue != 0) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
            LineState storage l = _requireActiveLine(target);
            oldValue = l.paused ? 1 : 0;
            newValue = 1;
            l.paused = true;
            emit TreasuryPaused(target, msg.sender);
        } else {
            revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        }
        emit Tightened(kind, target, msg.sender, oldValue, newValue, decisionId);
    }

    /// Tighten-only. Pausing an unpaused treasury cancels every queued loosening (§8.8; at most MAX_QUEUED_LOOSENS, so
    /// the loop is bounded). While paused, a second pause cancels nothing: what is queued then (UNPAUSE above all) was
    /// co-signed to end the pause, and a key that keeps pausing must not be able to block it (owner, lender and
    /// observer can still cancelLoosen any one of them).
    function pause() external {
        _requireTightener();
        bool wasPaused = _paused;
        _paused = true;
        uint256 n = wasPaused ? 0 : _queuedIds.length;
        for (uint256 i; i < n; ++i) {
            bytes32 id = _queuedIds[i];
            _loosens[id].status = HogeeKinds.LOOSEN_STATUS_CANCELLED;
            emit LoosenCancelled(id, msg.sender);
        }
        if (n != 0) delete _queuedIds;
        emit TreasuryPaused(bytes32(0), msg.sender);
    }

    /// Circuit breaker (§8.8): 3 denials on an active line within its window open the line's circuit. The same
    /// count rate-limits every key: an open circuit (or, for keys that are not an active line, a 1-day block after
    /// 3 denials) makes further calls revert CircuitOpen, so injected proposals cost bounded gas (T26).
    function recordDenied(bytes32 lineId, bytes32 decisionId, bytes32 reasonCode, bytes32 proposalHash) external {
        _requireAgent();
        if (decisionId == bytes32(0) || reasonCode == bytes32(0)) revert MissingDecision();
        LineState storage l = _lines[lineId];
        bool isLine = lineId != bytes32(0) && _isActive(l);
        DenialTrack storage d = _denials[lineId];
        uint64 now_ = _now();
        if (isLine ? l.circuitOpen : now_ < d.blockedUntil) revert CircuitOpen();

        uint64 window = isLine ? l.windowSeconds : DEFAULT_DENIAL_WINDOW;
        uint8 n = 1;
        if (d.last != 0 && now_ < uint256(d.last) + window) ++n;
        if (d.prev != 0 && now_ < uint256(d.prev) + window) ++n;
        d.prev = d.last;
        d.last = now_;
        emit Denied(decisionId, lineId, reasonCode, proposalHash, n);
        if (n < CIRCUIT_THRESHOLD) return;
        if (isLine) {
            l.circuitOpen = true;
            emit CircuitTripped(lineId, n);
        } else {
            d.blockedUntil = now_ + window;
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Oracle
    // ---------------------------------------------------------------------------------------------------------

    function confirmSettlement(bytes32 settlementId, bytes32 payoutRefHash) external {
        _openSettlement(settlementId).state = HogeeKinds.SETTLEMENT_CONFIRMED;
        emit SettlementConfirmed(settlementId, payoutRefHash);
    }

    /// Returns the amount to its source (M8). Spend / ownerSpend: the line pocket; the intent stays used, the invoice
    /// stays paid and the window keeps the attempt, so a mis-reported failure can never lead to a second payment of the
    /// same invoice. Milestone release (re-check M-1): the supplier line pocket (line and total escrowed, as
    /// escrowFund added them; escrowRelease left them). The milestone stays released in MilestoneEscrow and its
    /// settlementId closed, so it is never re-funded or paid twice; paying the supplier again takes a new
    /// founder-signed SupplierApproval (a new order). Reserve withdrawal: the reserve.
    function failSettlement(bytes32 settlementId, bytes32 code) external {
        SettlementRecord storage r = _openSettlement(settlementId);
        r.state = HogeeKinds.SETTLEMENT_FAILED;
        uint128 amount = r.amountMinor;
        uint8 kind = r.kind;
        if (kind == SETTLEMENT_KIND_SPEND) {
            _lines[r.lineId].spentMinor -= amount;
            _spentMinor -= amount;
            _bindings[r.lineId][r.payeeId].paidMinor -= amount;
        } else if (kind == SETTLEMENT_KIND_MILESTONE) {
            _lines[r.lineId].escrowedMinor -= amount;
            _escrowedMinor -= amount;
            _bindings[r.lineId][r.payeeId].paidMinor -= amount;
        } else {
            _reserveMinor += amount;
            _reserveWithdrawnMinor -= amount;
        }
        emit SettlementFailed(settlementId, code);
    }

    // ---------------------------------------------------------------------------------------------------------
    // PlanRegistry hook (not frozen)
    // ---------------------------------------------------------------------------------------------------------

    /// PlanRegistry only: mirrors the committed plan into the spend path. PlanRegistry has already checked that a
    /// re-commit only tightens (G0 audit v-1), so a re-commit writes plan parameters only: the version, agentExpiry,
    /// reserveBps, the line configs and which payees each line lists. It never touches runtime state (pause, line
    /// pauses, circuits and denial counts, window spend, lineSequence, binding data, used intents/invoices,
    /// agentRevoked) or releasedMinor.
    function syncPlan(PlanSync calldata s, Line[] calldata lines, Stage[] calldata stages) external {
        if (msg.sender != registry) revert NotOwner();
        bool first = _planVersion == 0;
        _planVersion = s.version;
        // Logged by PlanRegistry's PlanCommitted (agentExpiry, reserveBps) in the same transaction.
        // forge-lint: disable-next-line(missing-events-access-control)
        _agentExpiry = s.agentExpiry;
        _reserveBps = s.reserveBps;
        for (uint256 i; i < lines.length; ++i) {
            _syncLine(lines[i], s.version);
        }
        if (!first) return;

        _planId = s.planId;
        _planTotalMinor = s.totalMinor;
        // forge-lint: disable-next-line(missing-events-access-control)
        _agent = s.agent;
        for (uint256 i; i < stages.length; ++i) {
            _stages[stages[i].stageId] =
                StageState({releaseMinor: stages[i].releaseMinor, known: true, released: false});
        }
        _raiseReleased(stages[0].stageId); // only the first commit releases stage 0
    }

    // ---------------------------------------------------------------------------------------------------------
    // Founder- and lender-signed entry points run in the governance module (task 1.8 size split)
    // ---------------------------------------------------------------------------------------------------------

    /// Not frozen: the delegate-only module address (for verification and the deployment summary).
    function governance() external view returns (address) {
        return _GOVERNANCE;
    }

    /// Lender-signed stage release + the stage gate (TreasuryGovernance.releaseStage, by delegatecall).
    function releaseStage(StageRelease calldata, Sig calldata) external {
        _delegate();
    }

    /// Founder's manual fallback (TreasuryGovernance.ownerSpend, by delegatecall); emits OwnerSpent.
    function ownerSpend(OwnerSpend calldata, Sig calldata) external returns (bytes32) {
        _delegate();
    }

    /// Founder + lender co-signed loosening (TreasuryGovernance.queueLoosen, by delegatecall).
    function queueLoosen(LoosenRequest calldata, Sig calldata, Sig calldata) external returns (bytes32) {
        _delegate();
    }

    /// After the timelock, before the grace period ends (TreasuryGovernance.executeLoosen, by delegatecall).
    function executeLoosen(bytes32) external {
        _delegate();
    }

    /// Owner EOA, lender or observer veto (TreasuryGovernance.cancelLoosen, by delegatecall).
    function cancelLoosen(bytes32) external {
        _delegate();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal: spend checks (require-table rows 5-23) and effects
    // ---------------------------------------------------------------------------------------------------------

    /// Rows 5-9.
    function _requireLineOpen(bytes32 lineId, uint32 planVersion) private view {
        LineState storage l = _lines[lineId];
        bool active = _isActive(l);
        if (active && l.escrowOnly) revert EscrowOnly();
        if (planVersion != _planVersion) revert StalePlan();
        if (!active || _now() > l.validUntil) revert LineExpired();
        if (l.circuitOpen) revert CircuitOpen();
        if (l.paused) revert Paused();
    }

    /// Rows 17-23. Prunes the line's rolling window (a write) before reading it. Row 17 also rejects a zero amount
    /// (run-2 audit: it would burn an invoice or pacing slot, a window entry and a live-spend slot for nothing).
    function _requireCaps(bytes32 lineId, bytes32 payeeId, uint128 amountMinor) private {
        LineState storage l = _lines[lineId];
        if (amountMinor == 0 || amountMinor > l.perTxCapMinor) revert CapExceeded();
        RollingWindow.Queue storage q = _windows[lineId];
        q.prune(_now(), l.windowSeconds);
        if (q.tail - q.head >= MAX_LIVE_SPENDS_PER_WINDOW) revert CapExceeded();
        if (uint256(q.sumMinor) + amountMinor > l.windowCapMinor) revert CapExceeded();
        if (uint256(l.spentMinor) + l.escrowedMinor + amountMinor > l.allocatedMinor) revert CapExceeded();
        PayeeBinding storage b = _bindings[lineId][payeeId];
        if (uint256(b.paidMinor) + amountMinor > b.lifetimeCapMinor) revert CapExceeded();
        uint256 outflow = uint256(_spentMinor) + _escrowedMinor + amountMinor;
        if (outflow > _releasedMinor || outflow > _fundedMinor) revert CapExceeded();
    }

    function _recordSpend(bytes32 spendId, bytes32 lineId, bytes32 payeeId, bytes32 invoiceHash, uint128 amountMinor)
        private
    {
        _recordOutflow(spendId, lineId, payeeId, invoiceHash, amountMinor);
        _windows[lineId].push(_now(), amountMinor);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal: helpers
    // ---------------------------------------------------------------------------------------------------------

    /// bindPayee rows 5-7 (row 5 also needs an orderId: the escrow order key). Row 6a (audit run-3): no zero
    /// milestone. fundMilestone refuses 0, yet a zero milestone reads as fully funded, so a founder release would open
    /// a zero settlement.
    function _requireSchedule(SupplierApproval calldata a, uint128[] calldata schedule, bool[] calldata autoRelease)
        private
        pure
    {
        uint256 n = schedule.length;
        if (
            n == 0 || n > MAX_MILESTONES || n != autoRelease.length || a.orderId == bytes32(0) || a.payee == bytes32(0)
                || a.payoutAccountHash == bytes32(0)
        ) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        if (a.scheduleHash != HogeeTypes.scheduleHash(schedule, autoRelease)) revert InvalidSignature();
        uint256 total = 0;
        for (uint256 i; i < n; ++i) {
            uint128 amount = schedule[i];
            // Input check on a signed schedule (at most 8 entries): one zero milestone fails the whole binding.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (amount == 0) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
            total += amount;
        }
        if (total != a.totalMinor) revert PlanInvariantViolated(HogeeKinds.CONST_PAYEE_CAP_OVER_SCHEDULE);
    }

    /// bindPayee effects: lifetime cap += schedule total; a re-bind (new destination or order) restarts cooling (T3).
    function _bind(SupplierApproval calldata a) private {
        _orderUsed[a.orderId] = true;
        _signedPayee[a.lineId][a.payee] = true;
        PayeeBinding storage b = _bindings[a.lineId][a.payee];
        uint64 coolingUntil = _now() + coolingSeconds;
        uint128 cap = _saturatingAdd(b.lifetimeCapMinor, a.totalMinor);
        b.bound = true;
        b.coolingUntil = coolingUntil;
        b.lifetimeCapMinor = cap;
        b.payoutAccountHash = a.payoutAccountHash;
        // The only preceding external call is the view checkFounderSig on this deployment's immutable PlanRegistry.
        // forge-lint: disable-next-item(reentrancy-events)
        emit PayeeBound(
            a.payee, a.lineId, a.orderId, coolingUntil, cap, a.supplierId, a.scheduleHash, a.payoutAccountHash
        );
    }

    function _requireActiveLine(bytes32 lineId) private view returns (LineState storage l) {
        l = _lines[lineId];
        if (!_isActive(l)) revert LineExpired();
    }

    function _openSettlement(bytes32 settlementId) private view returns (SettlementRecord storage r) {
        if (msg.sender != _ORACLE) revert NotOracle();
        r = _settlements[settlementId];
        if (r.kind == 0 || r.state != HogeeKinds.SETTLEMENT_NONE) revert SettlementClosed();
    }

    /// Applies the signed line config. Spent/escrowed, the window, pauses and circuits carry over (a plan signed by
    /// the founder alone must not reopen a line the agent, owner or lender paused). Every listed payee is stamped
    /// with this version (spend row 10: a payee this version does not list is not payable). Listed static platform
    /// payees that are not yet bound to this line are bound now: uncapped, no cooling (fixed at deployment).
    /// `version` == _planVersion: syncPlan stores it before calling here.
    function _syncLine(Line calldata src, uint32 version) private {
        bytes32 id = src.lineId;
        LineState storage l = _lines[id];
        l.version = version;
        l.windowSeconds = src.windowSeconds;
        l.validUntil = src.validUntil;
        l.escrowOnly = src.escrowOnly;
        l.allocatedMinor = src.amountMinor;
        l.perTxCapMinor = src.perTxCapMinor;
        l.windowCapMinor = src.windowCapMinor;
        l.pacingMinor = src.pacingMinor;
        uint64 now_ = _now();
        for (uint256 p; p < src.payeeIds.length; ++p) {
            bytes32 payee = src.payeeIds[p];
            _listedVersion[id][payee] = version;
            PayeeBinding storage b = _bindings[id][payee];
            bytes32 account = _platformPayout[payee];
            if (b.bound || account == bytes32(0)) continue;
            b.bound = true;
            b.coolingUntil = now_;
            b.lifetimeCapMinor = type(uint128).max;
            b.payoutAccountHash = account;
            emit PayeeBound(payee, id, bytes32(0), now_, type(uint128).max, bytes32(0), bytes32(0), account);
        }
    }

    /// Runs this call (same selector and arguments) in the governance module, in this contract's storage and
    /// address, and returns or reverts with the module's result. The target is the constructor-created immutable.
    function _delegate() private {
        address module = _GOVERNANCE;
        // Never returns to Solidity code, so scratch and free memory may be overwritten (as in OZ Proxy._delegate).
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), module, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    function _saturatingAdd(uint128 a, uint128 b) private pure returns (uint128) {
        uint256 c = uint256(a) + b;
        // forge-lint: disable-next-line(unsafe-typecast)
        return c > type(uint128).max ? type(uint128).max : uint128(c); // c <= max on this branch
    }
}
