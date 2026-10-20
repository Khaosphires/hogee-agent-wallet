// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PayeeBinding, HogeeKinds} from "./interfaces/IHogee.sol";
import {TreasuryStorage} from "./TreasuryStorage.sol";
import {ITreasuryModuleHooks} from "./HogeeHooks.sol";

/// @title TreasuryModuleHooks: the ledger side of MilestoneEscrow and SalesOracle (task 1.8).
/// @notice The BU ledger stays in Treasury (pockets, escrowed, revenue, reserve); the escrow and the sales oracle keep
///         their own records and move Treasury's counters only through these hooks, each callable only by the
///         contract this Treasury was linked to in its constructor (immutables). On the loop-1 shape both links are
///         0, so no hook can ever run.
abstract contract TreasuryModuleHooks is TreasuryStorage, ITreasuryModuleHooks {
    // ---------------------------------------------------------------------------------------------------------
    // MilestoneEscrow
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc ITreasuryModuleHooks
    function requireSpendingAgent(address caller) external view {
        _requireSpendingAgent(caller);
    }

    /// @inheritdoc ITreasuryModuleHooks
    function checkEscrowLine(bytes32 lineId, bytes32 payeeId) external view {
        LineState storage l = _lines[lineId];
        if (!_isActive(l) || _now() > l.validUntil) revert LineExpired();
        if (l.circuitOpen) revert CircuitOpen();
        if (l.paused) revert Paused();
        PayeeBinding storage b = _bindings[lineId][payeeId];
        if (!b.bound) revert PayeeNotBound();
        if (_now() < b.coolingUntil) revert PayeeCooling();
    }

    /// @inheritdoc ITreasuryModuleHooks
    function escrowFund(bytes32 lineId, uint128 amountMinor) external {
        if (msg.sender != escrow) revert NotOwner();
        LineState storage l = _lines[lineId];
        if (uint256(l.spentMinor) + l.escrowedMinor + amountMinor > l.allocatedMinor) revert CapExceeded();
        uint256 outflow = uint256(_spentMinor) + _escrowedMinor + amountMinor;
        if (outflow > _releasedMinor || outflow > _fundedMinor) revert CapExceeded();
        // Logged by MilestoneEscrow's MilestoneFunded in the same call.
        // forge-lint: disable-next-line(missing-events-access-control, missing-events-arithmetic)
        l.escrowedMinor += amountMinor;
        // forge-lint: disable-next-line(missing-events-access-control, missing-events-arithmetic)
        _escrowedMinor += amountMinor;
    }

    /// @inheritdoc ITreasuryModuleHooks
    function escrowRelease(bytes32 settlementId, bytes32 lineId, bytes32 payeeId, uint128 amountMinor) external {
        if (msg.sender != escrow) revert NotOwner();
        if (_settlements[settlementId].kind != 0) revert SettlementClosed();
        PayeeBinding storage b = _bindings[lineId][payeeId];
        // Audit run-3 (v-5): a re-bind restarts cooling and replaces the payout account, so an earlier order's funded
        // milestone must not release (to the new, unvetted account) inside that window. Both release paths end here.
        if (_now() < b.coolingUntil) revert PayeeCooling();
        if (uint256(b.paidMinor) + amountMinor > b.lifetimeCapMinor) revert CapExceeded();
        b.paidMinor += amountMinor;
        // Logged by MilestoneEscrow's MilestoneReleased (settlementId) in the same call.
        // forge-lint: disable-next-line(missing-events-access-control)
        _settlements[settlementId] = SettlementRecord({
            lineId: lineId,
            payeeId: payeeId,
            amountMinor: amountMinor,
            kind: SETTLEMENT_KIND_MILESTONE,
            state: HogeeKinds.SETTLEMENT_NONE
        });
    }

    // ---------------------------------------------------------------------------------------------------------
    // SalesOracle
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc ITreasuryModuleHooks
    function creditRevenue(bytes32 saleIdHash, uint128 amountMinor) external {
        if (msg.sender != salesOracle) revert NotOwner();
        if (_planVersion == 0) revert StalePlan();
        // amountMinor * reserveBps / 10_000 <= amountMinor (reserveBps <= 10_000): the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 skim = uint128((uint256(amountMinor) * _reserveBps) / BPS);
        uint128 revenueTotal = _revenueMinor + amountMinor;
        uint128 reserveTotal = _reserveMinor + skim;
        _revenueMinor = revenueTotal;
        _reserveMinor = reserveTotal;
        _reserveSkimmedMinor += skim;
        ++_salesCount;
        emit RevenueRecorded(saleIdHash, amountMinor, revenueTotal);
        emit ReserveSkimmed(saleIdHash, skim, reserveTotal);
    }
}
