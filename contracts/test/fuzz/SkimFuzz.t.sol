// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {HogeeKinds} from "../../src/interfaces/IHogee.sol";
import {HogeeTestBase} from "../utils/HogeeTestBase.sol";

/// SalesOracle reserve skim: for any sale amounts and any reserveBps the plan may hold (floor 300 .. 10,000 after
/// TIGHTEN_RAISE_RESERVE_BPS), each sale skims floor(amount * reserveBps / 10,000) into the reserve, the reserve is
/// the sum of the skims, revenue the sum of the sales, and a skim never exceeds its sale.
contract SkimFuzzTest is HogeeTestBase {
    function setUp() public override {
        super.setUp();
        _setUpRina();
    }

    function testFuzz_RecordSale_SkimIsTheFloorOfReserveBps(uint128 amount, uint16 bpsSeed) public {
        uint16 bps = _setReserveBps(bpsSeed);
        _recordSale(1, amount);
        uint256 skim = (uint256(amount) * bps) / 10_000;
        assertEq(treasury.reserve(), skim);
        assertLe(skim, amount);
        assertEq(treasury.revenue(), amount);
        (uint128 skimmed,, uint64 count) = treasury.revenueLedger();
        assertEq(skimmed, skim);
        assertEq(count, 1);
    }

    function testFuzz_RecordSale_ReserveIsTheSumOfTheSkims(uint96[8] memory amounts, uint16 bpsSeed) public {
        uint16 bps = _setReserveBps(bpsSeed);
        uint256 skims;
        uint256 revenue;
        for (uint256 i; i < amounts.length; ++i) {
            _recordSale(i, amounts[i]);
            skims += (uint256(amounts[i]) * bps) / 10_000;
            revenue += amounts[i];
        }
        assertEq(treasury.reserve(), skims);
        assertEq(treasury.revenue(), revenue);
        assertLe(skims, revenue);
        (uint128 skimmed, uint128 withdrawn,) = treasury.revenueLedger();
        assertEq(uint256(skimmed) - withdrawn, treasury.reserve());
        assertEq(treasury.balances().fundedMinor, 1_000_000); // a sale moves no budget
    }

    /// reserveBps in [current 500, 10,000] (only a tighten can move it, and only up).
    function _setReserveBps(uint16 seed) internal returns (uint16 bps) {
        bps = uint16(bound(seed, 500, 10_000));
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, bps, "d");
    }
}
