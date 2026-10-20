// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Milestone} from "../../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "../utils/HogeeTestBase.sol";

/// §8.9 fuzz `fundMilestone` and invariant 4 at the unit level: random partial fundings of supplier A's milestones
/// (stage 2 released, so only the schedule binds) succeed exactly when the cumulative stays within the signed
/// schedule, never move the line's escrow past it, and release an autoRelease milestone exactly when complete.
contract EscrowFuzzTest is HogeeTestBase {
    uint256 internal constant STEPS = 12;

    function setUp() public override {
        super.setUp();
        _setUpSupplierA();
        _releaseStage2();
    }

    function testFuzz_FundMilestone_CumulativeNeverExceedsTheSchedule(uint256[STEPS] memory seeds) public {
        uint128[3] memory schedule = [uint128(30_000), 120_000, 280_000];
        uint256[3] memory funded;
        for (uint256 i; i < STEPS; ++i) {
            uint8 idx = uint8(seeds[i] % 3);
            // Mostly a fitting partial amount, sometimes 0 or more than what is left.
            uint128 amount = uint128(bound(seeds[i] >> 8, 0, uint256(schedule[idx]) + 1_000));
            bool fits = amount != 0 && funded[idx] + amount <= schedule[idx];
            vm.prank(agent);
            if (fits) {
                escrow.fundMilestone(ORDER_A, idx, amount, "d", "r");
                funded[idx] += amount;
            } else {
                vm.expectRevert(
                    amount == 0 ? IHogeeErrors.CapExceeded.selector : IHogeeErrors.AmountExceedsSchedule.selector
                );
                escrow.fundMilestone(ORDER_A, idx, amount, "d", "r");
            }
            _assertEscrow(schedule, funded);
        }
    }

    function _assertEscrow(uint128[3] memory schedule, uint256[3] memory funded) internal view {
        Milestone[] memory m = escrow.milestones(ORDER_A);
        uint256 total;
        for (uint256 k; k < 3; ++k) {
            assertEq(m[k].fundedMinor, funded[k], "milestone funded != model");
            assertLe(m[k].fundedMinor, schedule[k], "milestone above its schedule");
            // autoRelease (sample, deposit) releases exactly when complete; the balance never releases by funding.
            assertEq(m[k].released, k < 2 && funded[k] == schedule[k], "release flag != model");
            total += funded[k];
        }
        assertEq(treasury.pocket(L_SUPPLIER).escrowedMinor, total, "line escrow != sum of milestones");
        assertEq(treasury.balances().escrowedMinor, total, "total escrow != sum of milestones");
        assertLe(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 430_000, "paid above the lifetime cap");
    }
}
