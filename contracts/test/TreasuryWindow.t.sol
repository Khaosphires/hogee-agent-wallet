// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pocket, Balances} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// Treasury rolling window (T22, forge/Anvil only: Sepolia's 12 s slots cannot hit +-1 s), ADS pacing against the
/// window cap, and the ledger views. How a re-commit treats caps, spent, pauses and the agent: PlanReplan.t.sol.
contract TreasuryWindowTest is HogeeTestBase {
    function setUp() public override {
        super.setUp();
        _setUpRina();
    }

    // ---------------------------------------------------------------------------------------------------------
    // T22: rolling window at +-1 s (forge only)
    // ---------------------------------------------------------------------------------------------------------

    /// A fixed window starting at T0 would reset at T0 + W and allow 2x the cap within 2 seconds. The rolling window
    /// does not: the full cap spent at T0 + W - 1 still counts at T0 + W + 1.
    function test_T22_FullCapAtWindowEndMinusOneThenPlusOneReverts() public {
        vm.warp(T0 + WINDOW - 1);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(2));
        vm.warp(T0 + WINDOW + 1);
        assertEq(treasury.rollingSpent(L_LOGISTICS), 40_000);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(3), 1, "d", "r");
    }

    /// A spend at t counts while now < t + W: still at t + W - 1, gone at t + W.
    function test_T22_SpendLeavesTheWindowExactlyAfterWindowSeconds() public {
        uint64 t = T0 + 3 * DAY;
        vm.warp(t);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(2));
        vm.warp(t + WINDOW - 1);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(3), 1, "d", "r");
        vm.warp(t + WINDOW);
        assertEq(treasury.rollingSpent(L_LOGISTICS), 0);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(3));
        assertEq(treasury.rollingSpent(L_LOGISTICS), 20_000);
    }

    /// Spends age out one by one, not all at once.
    function test_T22_WindowSlidesPerSpend() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        vm.warp(T0 + 3 * DAY);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(2));
        vm.warp(T0 + WINDOW); // the first spend left, the second is still in
        assertEq(treasury.rollingSpent(L_LOGISTICS), 20_000);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(3));
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(4), 1, "d", "r");
    }

    /// G0 decision §1 #1: with 15-30 min tick jitter, 8 daily ADS slots can land in one 7-day window. At 7,500/day
    /// they sum to 60,000, exactly the ADS window cap (the check is sum + amount > cap), so none reverts; the
    /// next minor unit in the same window does.
    function test_AdsPacing_EightSlotsInOneWindowExactlyFitTheCap() public {
        assertEq(treasury.pocket(L_ADS).windowCapMinor, 60_000);
        for (uint64 k; k < 8; ++k) {
            vm.warp(T0 + (k * (WINDOW - 1)) / 7); // slot 1 at T0 ... slot 8 at T0 + WINDOW - 1
            _spendAds(k + 1, 7_500);
        }
        assertEq(treasury.rollingSpent(L_ADS), 60_000);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_ADS, P_ADS, 1, bytes32(uint256(9)), 1, "d", "r");
        vm.warp(T0 + WINDOW); // slot 1 leaves the window: one more slot fits
        _spendAds(9, 7_500);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    function test_Views_BalancesAndPocketAfterSpends() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        _spendAds(1, 7_500);
        Balances memory b = treasury.balances();
        assertEq(b.fundedMinor, 1_000_000);
        assertEq(b.releasedMinor, 400_000);
        assertEq(b.spentMinor, 27_500);
        assertEq(b.escrowedMinor, 0);
        assertEq(b.revenueMinor, 0);
        assertEq(b.reserveMinor, 0);
        assertEq(treasury.reserve(), 0);
        assertEq(treasury.revenue(), 0);
        Pocket memory ads = treasury.pocket(L_ADS);
        assertEq(ads.allocatedMinor, 120_000);
        assertEq(ads.pacingMinor, 7_500);
        assertEq(ads.windowSeconds, WINDOW);
        assertEq(ads.validUntil, T0 + 60 * DAY);
        assertFalse(ads.escrowOnly);
        assertTrue(treasury.pocket(L_SUPPLIER).escrowOnly);
        assertEq(treasury.pocket("NOPE").availableMinor, 0);
    }

    // ---------------------------------------------------------------------------------------------------------
}
