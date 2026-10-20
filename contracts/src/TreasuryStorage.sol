// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ITreasury, Facility, Balances, Pocket, PayeeBinding, QueuedLoosen, HogeeKinds} from "./interfaces/IHogee.sol";
import {TreasuryState} from "./TreasuryState.sol";
import {RollingWindow} from "./RollingWindow.sol";
import {ITreasuryHooks, TreasuryLinks} from "./HogeeHooks.sol";

/// @title TreasuryStorage: the Treasury read views (split out of Treasury.sol for size). State, immutables and guards
///         live in TreasuryState, which the delegate-only TreasuryGovernance module shares.
/// @notice Budget units (BU) are an internal ledger in minor units: non-transferable, not pegged, not redeemable,
///         no external balance surface (D4). Nothing here moves value outside this contract.
abstract contract TreasuryStorage is TreasuryState, ITreasury, ITreasuryHooks {
    using RollingWindow for RollingWindow.Queue;

    constructor(address registry_, address oracle_, uint64 coolingSeconds_, TreasuryLinks memory links)
        TreasuryState(registry_, oracle_, coolingSeconds_, links)
    {}

    // ---------------------------------------------------------------------------------------------------------
    // Views (§26.9 and G0-DECISION)
    // ---------------------------------------------------------------------------------------------------------

    function pocket(bytes32 lineId) external view returns (Pocket memory p) {
        LineState storage l = _lines[lineId];
        uint256 used = uint256(l.spentMinor) + l.escrowedMinor;
        p.allocatedMinor = l.allocatedMinor;
        p.spentMinor = l.spentMinor;
        p.escrowedMinor = l.escrowedMinor;
        // forge-lint: disable-next-line(unsafe-typecast)
        p.availableMinor = _isActive(l) && l.allocatedMinor > used ? uint128(l.allocatedMinor - used) : 0; // < alloc
        p.perTxCapMinor = l.perTxCapMinor;
        p.windowCapMinor = l.windowCapMinor;
        p.windowSpentMinor = rollingSpent(lineId);
        p.windowSeconds = l.windowSeconds;
        p.validUntil = l.validUntil;
        p.pacingMinor = l.pacingMinor;
        p.escrowOnly = l.escrowOnly;
        p.paused = l.paused;
        p.circuitOpen = l.circuitOpen;
    }

    function isIntentUsed(bytes32 intentId) external view returns (bool) {
        return _settlements[intentId].kind != 0;
    }

    /// Sum of the line's spends that are still inside its rolling window.
    function rollingSpent(bytes32 lineId) public view returns (uint128 sumMinor) {
        (sumMinor,) = _windows[lineId].live(_now(), _lines[lineId].windowSeconds);
    }

    function reserve() external view returns (uint128) {
        return _reserveMinor;
    }

    function revenue() external view returns (uint128) {
        return _revenueMinor;
    }

    function releasedMinor() external view returns (uint128) {
        return _releasedMinor;
    }

    function agentExpiry() external view returns (uint64) {
        return _agentExpiry;
    }

    function facility() external view returns (Facility memory) {
        return
            Facility({
                capMinor: _capMinor, reserveFloorBps: _reserveFloorBps, fundedMinor: _fundedMinor, opened: _opened
            });
    }

    function balances() external view returns (Balances memory) {
        return Balances({
            fundedMinor: _fundedMinor,
            releasedMinor: _releasedMinor,
            spentMinor: _spentMinor,
            escrowedMinor: _escrowedMinor,
            revenueMinor: _revenueMinor,
            reserveMinor: _reserveMinor
        });
    }

    /// Invoice-backed lines only; pacing slots are tracked by lineSequence.
    function isInvoicePaid(bytes32 invoiceHash) external view returns (bool) {
        return _invoicePaid[invoiceHash];
    }

    function payeeBinding(bytes32 lineId, bytes32 payeeId) external view returns (PayeeBinding memory) {
        return _bindings[lineId][payeeId];
    }

    /// Next expected slot for an active pacing line (starts at 1); 0 for any other line.
    function lineSequence(bytes32 lineId) external view returns (uint64) {
        LineState storage l = _lines[lineId];
        return _isActive(l) && l.pacingMinor > 0 ? l.seq + 1 : 0;
    }

    /// The queued request and its status; a QUEUED one past expiresAt reads as EXPIRED.
    function queuedLoosen(bytes32 loosenId) external view returns (QueuedLoosen memory q) {
        q = _loosens[loosenId];
        if (q.status == HogeeKinds.LOOSEN_STATUS_QUEUED && _now() > q.expiresAt) {
            q.status = HogeeKinds.LOOSEN_STATUS_EXPIRED;
        }
    }

    function settlementState(bytes32 settlementId) external view returns (uint8) {
        return _settlements[settlementId].state;
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    // ---- not frozen: read by PlanRegistry ----

    function platformPayoutAccountHash(bytes32 payeeId) external view returns (bytes32) {
        return _platformPayout[payeeId];
    }

    function agentState() external view returns (address agent, uint64 expiry, bool revoked, uint16 reserveBps) {
        return (_agent, _agentExpiry, _agentRevoked, _reserveBps);
    }

    function isSignedPayee(bytes32 lineId, bytes32 payeeId) external view returns (bool) {
        return _signedPayee[lineId][payeeId];
    }

    function isStageReleased(bytes32 stageId) external view returns (bool) {
        return _stages[stageId].released;
    }

    function lender() external view returns (address) {
        return _LENDER;
    }

    function oracle() external view returns (address) {
        return _ORACLE;
    }

    // ---- not frozen: task 1.8 ledger detail ----

    /// The reserve's inflow and outflow totals (reserve == skimmed - withdrawn) and the recorded sale count (the
    /// METRIC_ORDERS gate). Read by the §8.9 invariant 2 and 3 tests and the offline verifier.
    function revenueLedger()
        external
        view
        returns (uint128 reserveSkimmedMinor, uint128 reserveWithdrawnMinor, uint64 salesCount)
    {
        return (_reserveSkimmedMinor, _reserveWithdrawnMinor, _salesCount);
    }
}
