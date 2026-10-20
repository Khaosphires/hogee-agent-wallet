// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ISalesOracle, HogeeKinds} from "./interfaces/IHogee.sol";
import {ITreasuryHooks, ITreasuryModuleHooks, ITreasuryLinks} from "./HogeeHooks.sol";

/// @title SalesOracle: ORACLE-only sale records for one deployment (project.md §8.1, §9.2; demo task 11).
/// @notice Each Stripe sale is recorded once (saleIdHash = keccak256(utf8(stripeEventId)); DuplicateSale on a replay,
///         T23). Treasury's creditRevenue hook then adds it to revenue and skims the plan's current reserveBps into the
///         reserve. amountBucket is minor units rounded down off-chain to the bucket size (G0-DECISION). Recording a
///         sale moves no BU and is allowed while paused. No upgradeability: redeploy instead.
///         Every check, in order: docs/assurance/require-table-final1.md.
contract SalesOracle is ISalesOracle {
    /// Treasury of this deployment (its salesOracle link must name this contract).
    address public immutable treasury;
    /// The ORACLE role, read once from Treasury (the same key settles payouts there).
    address public immutable oracle;

    mapping(bytes32 saleIdHash => bool) private _recorded;

    // The treasury address is checked by reading its link back, which fails for anything but a linked Treasury.
    // forge-lint: disable-next-item(missing-zero-check)
    constructor(address treasury_) {
        if (ITreasuryLinks(treasury_).salesOracle() != address(this)) {
            revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        }
        treasury = treasury_;
        oracle = ITreasuryHooks(treasury_).oracle();
    }

    /// @inheritdoc ISalesOracle
    function recordSale(bytes32 saleIdHash, uint128 amountBucket) external {
        if (msg.sender != oracle) revert NotOracle();
        if (_recorded[saleIdHash]) revert DuplicateSale();
        _recorded[saleIdHash] = true;
        emit SaleRecorded(saleIdHash, amountBucket);
        // The only external call: this deployment's immutable Treasury (StalePlan before the first plan).
        ITreasuryModuleHooks(treasury).creditRevenue(saleIdHash, amountBucket);
    }

    /// @inheritdoc ISalesOracle
    function isSaleRecorded(bytes32 saleIdHash) external view returns (bool) {
        return _recorded[saleIdHash];
    }
}
