// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {SalesOracle} from "../src/SalesOracle.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// SalesOracle.recordSale (§8.1, §9.2): ORACLE only, unique sale ids, credits Treasury revenue and skims reserveBps
/// into the reserve (T23, T24; demo task 11). One test per revert row of the require table.
contract SalesOracleTest is HogeeTestBase {
    bytes32 internal constant SALE = keccak256("evt_hogee_test_1");

    function setUp() public override {
        super.setUp();
        _setUpRina();
    }

    // ---------------------------------------------------------------------------------------------------------
    // recordSale
    // ---------------------------------------------------------------------------------------------------------

    /// Demo task 11: a Stripe sale of 100,000 at reserveBps 500 skims 5,000 into the reserve.
    function test_RecordSale_CreditsRevenueAndSkimsTheReserve() public {
        vm.expectEmit(address(sales));
        emit IHogeeEvents.SaleRecorded(SALE, 100_000);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.RevenueRecorded(SALE, 100_000, 100_000);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.ReserveSkimmed(SALE, 5_000, 5_000);
        vm.prank(oracle);
        sales.recordSale(SALE, 100_000);

        assertTrue(sales.isSaleRecorded(SALE));
        assertEq(treasury.revenue(), 100_000);
        assertEq(treasury.reserve(), 5_000);
        assertEq(treasury.balances().revenueMinor, 100_000);
        assertEq(treasury.balances().reserveMinor, 5_000);
        (uint128 skimmed, uint128 withdrawn, uint64 count) = treasury.revenueLedger();
        assertEq(skimmed, 5_000);
        assertEq(withdrawn, 0);
        assertEq(count, 1);
    }

    function test_RecordSale_TotalsAccumulate() public {
        _recordSale(1, 100_000);
        _recordSale(2, 60_000);
        assertEq(treasury.revenue(), 160_000);
        assertEq(treasury.reserve(), 8_000);
    }

    /// The skim rounds down: the reserve never gets more than reserveBps of a sale.
    function test_RecordSale_SkimRoundsDown() public {
        _recordSale(1, 99);
        assertEq(treasury.reserve(), 4); // 99 * 500 / 10,000 = 4.95
        assertEq(treasury.revenue(), 99);
    }

    /// The skim uses the current reserveBps, after any TIGHTEN_RAISE_RESERVE_BPS.
    function test_RecordSale_UsesTheCurrentReserveBps() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 800, "d");
        _recordSale(1, 100_000);
        assertEq(treasury.reserve(), 8_000);
    }

    /// A sale whose bucket rounds to 0 is still an order (METRIC_ORDERS) and skims nothing.
    function test_RecordSale_ZeroBucketCountsAsAnOrder() public {
        _recordSale(1, 0);
        (,, uint64 count) = treasury.revenueLedger();
        assertEq(count, 1);
        assertEq(treasury.revenue(), 0);
        assertEq(treasury.reserve(), 0);
    }

    /// Recording a sale moves no BU: funded, released and spent are unchanged, and it works while paused.
    function test_RecordSale_WorksWhilePausedAndMovesNoBudget() public {
        vm.prank(lender);
        treasury.pause();
        _recordSale(1, 50_000);
        assertEq(treasury.balances().fundedMinor, 1_000_000);
        assertEq(treasury.releasedMinor(), 400_000);
        assertEq(treasury.balances().spentMinor, 0);
    }

    /// Demo task 11 / T24: the agent key cannot record a sale.
    function test_Revert_NotOracle_recordSale_agent() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotOracle.selector);
        sales.recordSale(SALE, 1_000_000);
    }

    function test_Revert_NotOracle_recordSale_lender() public {
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.NotOracle.selector);
        sales.recordSale(SALE, 1);
    }

    /// T23: a replayed Stripe event.
    function test_Revert_DuplicateSale_recordSale_replayed() public {
        vm.startPrank(oracle);
        sales.recordSale(SALE, 100_000);
        vm.expectRevert(IHogeeErrors.DuplicateSale.selector);
        sales.recordSale(SALE, 100_000);
        vm.stopPrank();
        assertEq(treasury.revenue(), 100_000);
    }

    /// Before the first plan there is no reserveBps: an unskimmed sale would still count toward a stage gate.
    function test_Revert_StalePlan_recordSale_beforeTheFirstPlan() public {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        (sales, escrow) = (lastSales, lastEscrow);
        vm.prank(oracle);
        vm.expectRevert(IHogeeErrors.StalePlan.selector);
        sales.recordSale(SALE, 1);
        assertFalse(sales.isSaleRecorded(SALE));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Treasury hook and constructor
    // ---------------------------------------------------------------------------------------------------------

    /// Only this deployment's SalesOracle may credit revenue; the oracle key itself cannot bypass the unique-id check.
    function test_Revert_NotOwner_creditRevenue_notTheSalesOracle() public {
        vm.prank(oracle);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.creditRevenue(SALE, 1);
    }

    function test_Revert_PlanInvariantViolated_13_constructor_salesOracleNotLinked() public {
        vm.expectRevert(
            abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, HogeeKinds.CONST_MALFORMED_PLAN)
        );
        new SalesOracle(address(treasury)); // treasury.salesOracle() is the one deployed in setUp
    }

    function test_Views_Links() public view {
        assertEq(sales.treasury(), address(treasury));
        assertEq(sales.oracle(), oracle);
        assertEq(treasury.salesOracle(), address(sales));
    }
}
