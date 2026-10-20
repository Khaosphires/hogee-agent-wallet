// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    IPlanRegistry,
    Stage,
    Sig,
    StageRelease,
    OwnerSpend,
    LoosenRequest,
    QueuedLoosen,
    PayeeBinding,
    HogeeKinds
} from "./interfaces/IHogee.sol";
import {HogeeTypes} from "./interfaces/HogeeTypes.sol";
import {TreasuryState} from "./TreasuryState.sol";
import {TreasuryLoosenRules} from "./TreasuryLoosenRules.sol";
import {TreasuryLinks} from "./HogeeHooks.sol";

/// @title TreasuryGovernance: Treasury's founder- and lender-signed entry points, run by delegatecall (task 1.8).
/// @notice Treasury's runtime would pass the EIP-170 limit with these, so they live here. Treasury creates this module
///         in its own constructor with the same arguments (so every immutable but the domain separator matches), keeps
///         its address immutable, and forwards the call unchanged (Treasury._delegate). Here the code runs in
///         Treasury's storage and address: both contracts inherit the same TreasuryState and declare no state of
///         their own, so the layouts are identical. Signatures are checked against Treasury's domain through
///         _treasuryDigest (address(this) is Treasury under delegatecall). A direct call reverts NotOwner.
///         Every check, in order: docs/assurance/require-table-final1.md.
contract TreasuryGovernance is TreasuryLoosenRules {
    /// This module's own address: a call that does not come through Treasury's delegatecall runs with this address.
    address private immutable _SELF;

    constructor(address registry_, address oracle_, uint64 coolingSeconds_, TreasuryLinks memory links)
        TreasuryState(registry_, oracle_, coolingSeconds_, links)
    {
        _SELF = address(this);
    }

    modifier onlyDelegated() {
        _onlyDelegated();
        _;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Founder
    // ---------------------------------------------------------------------------------------------------------

    /// ITreasury.ownerSpend: the founder's manual fallback (NFRA 二十六). Same payee, duplicate, balance, stage and
    /// validity rules as spend; no agent checks, no perTx/window caps, no pause of any kind (§8.8). Emits OwnerSpent.
    function ownerSpend(OwnerSpend calldata req, Sig calldata founder)
        external
        onlyDelegated
        returns (bytes32 spendId)
    {
        _useEnvelope(req.deploymentId, req.expiry, req.nonce);
        _requireFounder(_treasuryDigest(HogeeTypes.hashOwnerSpend(req)), founder);
        bytes32 lineId = req.lineId;
        if (lineId == LINE_RESERVE) revert ReserveLocked();
        LineState storage l = _lines[lineId];
        bool active = _isActive(l);
        if (active && l.escrowOnly) revert EscrowOnly();
        if (!active || _now() > l.validUntil) revert LineExpired();
        _requirePayeeReady(lineId, req.payeeId);
        spendId = HogeeTypes.intentId(_planId, lineId, req.payeeId, req.invoiceHash, req.amountMinor);
        if (_settlements[spendId].kind != 0) revert DuplicateIntent();
        _requireInvoice(l, req.invoiceHash, req.amountMinor);
        _requireOwnerAmount(l, lineId, req.payeeId, req.amountMinor);
        _recordOutflow(spendId, lineId, req.payeeId, req.invoiceHash, req.amountMinor);
        // The only external call before this is the view checkFounderSig on this deployment's PlanRegistry.
        // forge-lint: disable-next-line(reentrancy-events)
        emit OwnerSpent(spendId, lineId, req.payeeId, req.amountMinor, req.invoiceHash, _planVersion);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Lender
    // ---------------------------------------------------------------------------------------------------------

    /// ITreasury.releaseStage: the lender's signature plus the stage gate, then _raiseReleased (§8.2, §26.2).
    function releaseStage(StageRelease calldata req, Sig calldata lenderSig) external onlyDelegated {
        _useEnvelope(req.deploymentId, req.expiry, req.nonce);
        _requireLender(_treasuryDigest(HogeeTypes.hashStageRelease(req)), lenderSig);
        StageState storage st = _stages[req.stageId];
        if (!st.known || st.released || req.amountMinor != st.releaseMinor) revert CapExceeded();
        if (!_gateMet(req.stageId)) revert CapExceeded();
        _raiseReleased(req.stageId);
        // The only external calls before this are views on this deployment's immutable PlanRegistry.
        // forge-lint: disable-next-line(reentrancy-events)
        emit StageReleased(req.stageId, req.amountMinor, _releasedMinor);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Loosening: founder + lender, then the timelock (§8.8, H2)
    // ---------------------------------------------------------------------------------------------------------

    /// ITreasury.queueLoosen. loosenId = HogeeTypes.hashLoosenRequest(req) (the nonce makes it unique).
    function queueLoosen(LoosenRequest calldata req, Sig calldata founder, Sig calldata lender)
        external
        onlyDelegated
        returns (bytes32 loosenId)
    {
        _useEnvelope(req.deploymentId, req.expiry, req.nonce);
        loosenId = HogeeTypes.hashLoosenRequest(req);
        bytes32 digest = _treasuryDigest(loosenId);
        _requireFounder(digest, founder);
        // ITreasury NatSpec: no threshold, both signatures for every kind that requires the lender (all of them).
        if (HogeeKinds.requiresLender(req.kind) && _lenderSigner(digest, lender) != _LENDER) {
            revert InvalidSignature();
        }
        _checkLoosen(req.kind, req.target, req.aux, req.newValue);
        _pruneExpired();
        if (_queuedIds.length >= MAX_QUEUED_LOOSENS) revert CapExceeded();
        uint64 executableAt = _now() + loosenTimelockSeconds;
        uint64 expiresAt = executableAt + LOOSEN_GRACE;
        _loosens[loosenId] = QueuedLoosen({
            kind: req.kind,
            target: req.target,
            aux: req.aux,
            newValue: req.newValue,
            executableAt: executableAt,
            expiresAt: expiresAt,
            status: HogeeKinds.LOOSEN_STATUS_QUEUED
        });
        _queuedIds.push(loosenId);
        // The only external calls before this are views on this deployment's immutable PlanRegistry.
        // forge-lint: disable-next-line(reentrancy-events)
        emit LoosenQueued(loosenId, req.kind, req.target, req.aux, req.newValue, executableAt, expiresAt);
    }

    /// ITreasury.executeLoosen: anyone, from executableAt to expiresAt (inclusive), with the kind's bounds re-checked.
    function executeLoosen(bytes32 loosenId) external onlyDelegated {
        QueuedLoosen storage q = _loosens[loosenId];
        uint64 now_ = _now();
        if (q.status != HogeeKinds.LOOSEN_STATUS_QUEUED || now_ < q.executableAt) revert TimelockActive();
        if (now_ > q.expiresAt) revert SignatureExpired();
        (uint8 kind, bytes32 target, bytes32 aux, uint256 newValue) = (q.kind, q.target, q.aux, q.newValue);
        _checkLoosen(kind, target, aux, newValue);
        q.status = HogeeKinds.LOOSEN_STATUS_EXECUTED;
        _dequeue(loosenId);
        _applyLoosen(loosenId, kind, target, aux, newValue);
        emit LoosenExecuted(loosenId, kind);
    }

    /// ITreasury.cancelLoosen: the owner EOA, the lender or the observer vetoes a queued loosening (T3).
    function cancelLoosen(bytes32 loosenId) external onlyDelegated {
        // forge-lint: disable-next-line(unused-return)
        (,, address ownerEOA) = IPlanRegistry(registry).founderKey();
        bool may = msg.sender == _LENDER || (observer != address(0) && msg.sender == observer)
            || (ownerEOA != address(0) && msg.sender == ownerEOA);
        if (!may) revert NotOwner();
        QueuedLoosen storage q = _loosens[loosenId];
        if (q.status != HogeeKinds.LOOSEN_STATUS_QUEUED) revert TimelockActive();
        q.status = HogeeKinds.LOOSEN_STATUS_CANCELLED;
        _dequeue(loosenId);
        // forge-lint: disable-next-line(reentrancy-events)
        emit LoosenCancelled(loosenId, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------------------

    /// Drops expired loosenings from the live list (they stay QUEUED in storage; queuedLoosen reports EXPIRED and
    /// executeLoosen refuses them). Bounded by MAX_QUEUED_LOOSENS.
    function _pruneExpired() private {
        uint64 now_ = _now();
        uint256 n = _queuedIds.length;
        uint256 i = 0;
        while (i < n) {
            if (_loosens[_queuedIds[i]].expiresAt < now_) {
                _queuedIds[i] = _queuedIds[n - 1];
                _queuedIds.pop();
                --n;
            } else {
                ++i;
            }
        }
    }

    /// Removes `loosenId` from the live list if it is there (an expired one may already be pruned).
    function _dequeue(bytes32 loosenId) private {
        uint256 n = _queuedIds.length;
        for (uint256 i; i < n; ++i) {
            if (_queuedIds[i] == loosenId) {
                _queuedIds[i] = _queuedIds[n - 1];
                _queuedIds.pop();
                return;
            }
        }
    }

    /// ownerSpend amount rows: spend rows 17, 20-23 without the per-tx and window caps (never pay 0, never past the
    /// line balance, the payee's lifetime cap, releasedMinor or funded BU).
    function _requireOwnerAmount(LineState storage l, bytes32 lineId, bytes32 payeeId, uint128 amountMinor)
        private
        view
    {
        if (amountMinor == 0) revert CapExceeded();
        if (uint256(l.spentMinor) + l.escrowedMinor + amountMinor > l.allocatedMinor) revert CapExceeded();
        PayeeBinding storage b = _bindings[lineId][payeeId];
        if (uint256(b.paidMinor) + amountMinor > b.lifetimeCapMinor) revert CapExceeded();
        uint256 outflow = uint256(_spentMinor) + _escrowedMinor + amountMinor;
        if (outflow > _releasedMinor || outflow > _fundedMinor) revert CapExceeded();
    }

    function _onlyDelegated() private view {
        if (address(this) == _SELF) revert NotOwner();
    }

    /// The lender co-signature of a stage release. A valid ECDSA signature of a known non-lender role (agent, owner
    /// EOA, oracle) reverts NotLender (T23: stage unlock without the officer); anything else InvalidSignature.
    function _requireLender(bytes32 digest, Sig calldata sig) private view {
        address signer = _lenderSigner(digest, sig);
        if (signer == _LENDER) return; // _LENDER is never 0 (PlanRegistry needs it to register the founder)
        if (signer != address(0)) {
            // forge-lint: disable-next-line(unused-return)
            (,, address ownerEOA) = IPlanRegistry(registry).founderKey();
            if (signer == _agent || signer == ownerEOA || signer == _ORACLE) revert NotLender();
        }
        revert InvalidSignature();
    }

    /// Stage gate as signed in the plan: METRIC_SALES_MINOR compares recorded revenue, METRIC_ORDERS the number of
    /// recorded sales, both with the target and by the deadline (inclusive; 0 = none). Stage 0 (METRIC_NONE) has no
    /// gate: it is released at the first commit.
    function _gateMet(bytes32 stageId) private view returns (bool) {
        // forge-lint: disable-next-line(unused-return)
        (Stage memory s,) = IPlanRegistry(registry).stage(stageId);
        if (s.deadline != 0 && _now() > s.deadline) return false;
        if (s.metric == HogeeKinds.METRIC_SALES_MINOR) return _revenueMinor >= s.target;
        if (s.metric == HogeeKinds.METRIC_ORDERS) return _salesCount >= s.target;
        return false;
    }
}
