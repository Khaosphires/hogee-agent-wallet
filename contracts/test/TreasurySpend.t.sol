// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Line, Stage, Pocket, PayeeBinding, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";
import {TreasuryHarness} from "./utils/TreasuryHarness.sol";

/// Treasury.spend (§8.4): one test per revert row of docs/assurance/require-table-loop1.md, happy paths, and the
/// red-team rows T1, T4, T7, T10, T15, T17, T20, T22.
contract TreasurySpendTest is HogeeTestBase {
    bytes32 internal constant TOOLMAKER = "tool-maker";

    function setUp() public override {
        super.setUp();
        _setUpRina();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Happy paths
    // ---------------------------------------------------------------------------------------------------------

    function test_Spend_InvoiceLine_UpdatesEveryCounter() public {
        bytes32 inv = _invoice(1);
        bytes32 d = keccak256("decision-1");
        bytes32 expected = HogeeTypes.intentId(PLAN_ID, L_LOGISTICS, P_LOGISTICS, inv, 20_000);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.Spent(expected, L_LOGISTICS, P_LOGISTICS, 20_000, inv, d, keccak256("why"), 1);
        vm.prank(agent);
        bytes32 id = treasury.spend(L_LOGISTICS, P_LOGISTICS, 20_000, inv, 1, d, keccak256("why"));

        assertEq(id, expected);
        assertTrue(treasury.isIntentUsed(id));
        assertTrue(treasury.isInvoicePaid(inv));
        assertEq(treasury.settlementState(id), HogeeKinds.SETTLEMENT_NONE);
        Pocket memory p = treasury.pocket(L_LOGISTICS);
        assertEq(p.spentMinor, 20_000);
        assertEq(p.availableMinor, 60_000);
        assertEq(p.windowSpentMinor, 20_000);
        assertEq(treasury.rollingSpent(L_LOGISTICS), 20_000);
        assertEq(treasury.balances().spentMinor, 20_000);
        assertEq(treasury.payeeBinding(L_LOGISTICS, P_LOGISTICS).paidMinor, 20_000);
    }

    function test_Spend_PacingLine_UsesTheLineSequence() public {
        assertEq(treasury.lineSequence(L_ADS), 1);
        assertEq(treasury.lineSequence(L_LOGISTICS), 0); // invoice line
        bytes32 id = _spendAds(1, 7_500);
        // Same formula as the G0 golden vector (HogeeTypes.t.sol), at the 7,500/day pacing (G0 decision §1 #1).
        assertEq(id, HogeeTypes.intentId(PLAN_ID, L_ADS, P_ADS, bytes32(uint256(1)), 7_500));
        assertEq(treasury.lineSequence(L_ADS), 2);
        _spendAds(2, 6_000); // a slot may pay less than pacingMinor
        assertEq(treasury.lineSequence(L_ADS), 3);
        assertFalse(treasury.isInvoicePaid(bytes32(uint256(1)))); // pacing slots are not global invoices
        assertEq(treasury.pocket(L_ADS).spentMinor, 13_500);
    }

    function test_Spend_PayeeIsPayableRightAfterCooling() public {
        _toolmakerOnContingency();
        vm.warp(block.timestamp + COOLING);
        _spend(L_CONTINGENCY, TOOLMAKER, 10_000, _invoice(9));
        assertEq(treasury.pocket(L_CONTINGENCY).spentMinor, 10_000);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Rows 1-4: caller, pause, expiry, decision
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_NotAgent_spend_stranger() public {
        vm.prank(stranger);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, "d", "r");
    }

    function test_Revert_NotAgent_spend_lenderOrFounder() public {
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, "d", "r");
        vm.prank(founder);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, "d", "r");
    }

    /// T15: a revoked agent key.
    function test_Revert_NotAgent_spend_revokedAgent() public {
        vm.prank(founder);
        treasury.tighten(HogeeKinds.TIGHTEN_REVOKE_AGENT, 0, 0, 0);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, "d", "r");
    }

    /// T10.
    function test_Revert_Paused_spend_treasuryPaused() public {
        vm.prank(lender);
        treasury.pause();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.Paused.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, "d", "r");
    }

    /// T15: an expired agent key.
    function test_Revert_AgentExpired_spend() public {
        vm.warp(T0 + 60 * DAY + 1);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.AgentExpired.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, "d", "r");
    }

    function test_Spend_ValidAtExactAgentExpiry() public {
        vm.warp(T0 + 60 * DAY);
        _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1));
        assertEq(treasury.pocket(L_LOGISTICS).spentMinor, 1);
    }

    function test_Revert_MissingDecision_spend_zeroDecisionId() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MissingDecision.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, bytes32(0), "r");
    }

    function test_Revert_MissingDecision_spend_zeroRationale() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MissingDecision.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, "d", bytes32(0));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Rows 5-9: line
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_EscrowOnly_spend_supplierLine() public {
        _bindSupplier(_supplier());
        vm.warp(block.timestamp + COOLING);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.EscrowOnly.selector);
        treasury.spend(L_SUPPLIER, SUPPLIER_A, 30_000, _invoice(1), 1, "d", "r");
    }

    /// T20: built under plan v1, mined after v2.
    function test_Revert_StalePlan_spend_afterNewPlanVersion() public {
        _commit(_approvalV2(_lines(), _stages()), _lines(), _stages());
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.StalePlan.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 1, "d", "r");
    }

    function test_Revert_LineExpired_spend_unknownLine() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.LineExpired.selector);
        treasury.spend("LICENSING", P_LOGISTICS, 1, _invoice(1), 1, "d", "r");
    }

    function test_Revert_LineExpired_spend_afterValidUntil() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].validUntil = T0 + 10 * DAY;
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        vm.warp(T0 + 10 * DAY);
        _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1)); // valid through validUntil
        vm.warp(T0 + 10 * DAY + 1);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.LineExpired.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(2), 2, "d", "r");
    }

    function test_Revert_CircuitOpen_spend() public {
        for (uint256 i; i < 3; ++i) {
            vm.prank(agent);
            treasury.recordDenied(L_ADS, _nextDecision(), "PAYEE_NOT_IN_PLAN", bytes32(i));
        }
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CircuitOpen.selector);
        treasury.spend(L_ADS, P_ADS, 7_500, bytes32(uint256(1)), 1, "d", "r");
    }

    function test_Revert_Paused_spend_linePaused() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_ADS, 0, "d");
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.Paused.selector);
        treasury.spend(L_ADS, P_ADS, 7_500, bytes32(uint256(1)), 1, "d", "r");
        _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1)); // other lines still pay
    }

    // ---------------------------------------------------------------------------------------------------------
    // Rows 10-11: payee
    // ---------------------------------------------------------------------------------------------------------

    /// T1: "bank details changed, pay 0xEvil" -> a payee that was never bound.
    function test_Revert_PayeeNotBound_spend_injectedPayee() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeNotBound.selector);
        treasury.spend(L_LOGISTICS, "0xevil", 20_000, _invoice(1), 1, "d", "r");
    }

    /// A payee bound on one line is not payable from another.
    function test_Revert_PayeeNotBound_spend_payeeOfAnotherLine() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeNotBound.selector);
        treasury.spend(L_LOGISTICS, P_ADS, 1, _invoice(1), 1, "d", "r");
    }

    function test_Revert_PayeeCooling_spend_insideVetoWindow() public {
        _toolmakerOnContingency();
        vm.warp(block.timestamp + COOLING - 1);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeCooling.selector);
        treasury.spend(L_CONTINGENCY, TOOLMAKER, 10_000, _invoice(9), 1, "d", "r");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Rows 12-16: intent, invoice, pacing slot
    // ---------------------------------------------------------------------------------------------------------

    /// T7: the same intentId retried.
    function test_Revert_DuplicateIntent_spend_retry() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.DuplicateIntent.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1), 1, "other decision", "r");
    }

    /// T17: the same invoice under a new intentId (different amount).
    function test_Revert_DuplicateInvoice_spend_sameInvoiceNewAmount() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.DuplicateInvoice.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 19_999, _invoice(1), 1, "d", "r");
    }

    /// T17 across lines: invoices are unique treasury-wide.
    function test_Revert_DuplicateInvoice_spend_sameInvoiceOtherLine() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 10_000, _invoice(1));
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.DuplicateInvoice.selector);
        treasury.spend(L_FEES, P_FEES, 10_000, _invoice(1), 1, "d", "r");
    }

    function test_Revert_DuplicateInvoice_spend_pacingSlotAlreadyPaid() public {
        _spendAds(1, 7_500);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.DuplicateInvoice.selector);
        treasury.spend(L_ADS, P_ADS, 7_499, bytes32(uint256(1)), 1, "d", "r");
    }

    function test_Revert_CapExceeded_spend_pacingSlotSkipsAhead() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_ADS, P_ADS, 7_500, bytes32(uint256(2)), 1, "d", "r");
    }

    /// T4: an ads spend above the pacing slot.
    function test_Revert_CapExceeded_spend_overPacingAmount() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_ADS, P_ADS, 7_501, bytes32(uint256(1)), 1, "d", "r");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Rows 17-23: caps
    // ---------------------------------------------------------------------------------------------------------

    /// Run-2 audit: a zero amount would burn the invoice, a window entry and a live-spend slot for nothing.
    function test_Revert_CapExceeded_spend_zeroAmountInvoiceLine() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 0, _invoice(1), 1, "d", "r");
        assertFalse(treasury.isInvoicePaid(_invoice(1)));
        _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1)); // the invoice is still payable
    }

    /// Run-2 audit: nor may it burn a pacing slot.
    function test_Revert_CapExceeded_spend_zeroAmountPacingSlot() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_ADS, P_ADS, 0, bytes32(uint256(1)), 1, "d", "r");
        assertEq(treasury.lineSequence(L_ADS), 1);
        assertEq(treasury.rollingSpent(L_ADS), 0);
    }

    /// T4: over the per-transaction cap.
    function test_Revert_CapExceeded_spend_overPerTxCap() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 20_001, _invoice(1), 1, "d", "r");
    }

    function test_Revert_CapExceeded_spend_overTightenedPerTxCap() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, 5_000, "d");
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_ADS, P_ADS, 5_001, bytes32(uint256(1)), 1, "d", "r");
        _spendAds(1, 5_000);
    }

    /// T4: over the rolling-window cap.
    function test_Revert_CapExceeded_spend_overWindowCap() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(2));
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(3), 1, "d", "r");
    }

    function test_Revert_CapExceeded_spend_tooManyLiveSpendsInWindow() public {
        for (uint256 i; i < 64; ++i) {
            _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(i));
            vm.warp(vm.getBlockTimestamp() + 1); // separate timestamps: no merging
        }
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(64), 1, "d", "r");
        vm.warp(T0 + WINDOW); // the first entry expires
        _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(64));
    }

    function test_Spend_SameBlockSpendsShareOneWindowEntry() public {
        for (uint256 i; i < 70; ++i) {
            _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(i));
        }
        assertEq(treasury.rollingSpent(L_LOGISTICS), 70);
    }

    function test_Revert_CapExceeded_spend_overLineBalance() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(2));
        vm.warp(T0 + WINDOW);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(3));
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(4));
        assertEq(treasury.pocket(L_LOGISTICS).availableMinor, 0);
        vm.warp(T0 + 2 * WINDOW);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(5), 1, "d", "r");
    }

    function test_Revert_CapExceeded_spend_overPayeeLifetimeCap() public {
        _toolmakerOnContingency(); // lifetime cap 30,000
        vm.warp(block.timestamp + COOLING);
        _spend(L_CONTINGENCY, TOOLMAKER, 25_000, _invoice(1));
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_CONTINGENCY, TOOLMAKER, 5_001, _invoice(2), 1, "d", "r");
        _spend(L_CONTINGENCY, TOOLMAKER, 5_000, _invoice(2));
    }

    /// Stage stop-loss: total outflow never exceeds releasedMinor.
    function test_Revert_CapExceeded_spend_overReleasedStage() public {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        _openFacility();
        _registerFounder();
        Stage[] memory stages = _stages();
        (stages[0].releaseMinor, stages[1].releaseMinor) = (100_000, 900_000);
        _commit(_approvalFor(_lines(), stages), _lines(), stages);
        vm.prank(lender);
        treasury.fund(1_000_000);
        assertEq(treasury.releasedMinor(), 100_000);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(2));
        _spend(L_FEES, P_FEES, 12_500, _invoice(3));
        _spend(L_FEES, P_FEES, 12_500, _invoice(4));
        _spendAds(1, 7_500);
        _spendAds(2, 7_500);
        _spendAds(3, 7_500);
        _spendAds(4, 7_500); // 95,000 out
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_ADS, P_ADS, 7_500, bytes32(uint256(5)), 1, "d", "r");
        _spendAds(5, 5_000); // exactly 100,000
    }

    /// Decision: the agent never spends BU the lender has not funded.
    function test_Revert_CapExceeded_spend_overFunded() public {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
        vm.prank(lender);
        treasury.fund(30_000);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 10_001, _invoice(2), 1, "d", "r");
    }

    // helpers
    // ---------------------------------------------------------------------------------------------------------

    /// TOOLMAKER bound to the direct-pay CONTINGENCY line with cooling and a 30,000 lifetime cap. On loop-1 only a
    /// payee bound via 1.8's LOOSEN_ADD_PAYEE can be in that state (a replan can no longer clear escrowOnly, G0
    /// audit v-1), so the test-only harness writes the binding.
    function _toolmakerOnContingency() internal {
        TreasuryHarness h = _deployHarness();
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
        vm.prank(lender);
        treasury.fund(1_000_000);
        h.harnessAddPayee(L_CONTINGENCY, TOOLMAKER, 30_000);
        PayeeBinding memory b = treasury.payeeBinding(L_CONTINGENCY, TOOLMAKER);
        assertEq(b.lifetimeCapMinor, 30_000);
        assertEq(b.coolingUntil, block.timestamp + COOLING);
    }
}
