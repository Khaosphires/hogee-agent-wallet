// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Line, EscrowOrder, Milestone, SupplierApproval, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// MilestoneEscrow.fundMilestone (§8.4 milestone funding): agent only; bounded by the signed schedule (cumulative),
/// the supplier line balance, releasedMinor and funded BU; not by perTxCap or the window cap; PayeeCooling until the
/// veto window ends (H6); an autoRelease milestone releases when fully funded. Demo tasks 3-5.
contract MilestoneFundTest is HogeeTestBase {
    bytes32 internal constant SAMPLE_ID = keccak256("hogee/test/settlement-id");

    // ---------------------------------------------------------------------------------------------------------
    // bindPayee opens the order (demo task 3)
    // ---------------------------------------------------------------------------------------------------------

    function test_BindPayee_OpensTheEscrowOrderWithThePresignedSchedule() public {
        _setUpRina();
        _bindSupplier(_supplier());
        EscrowOrder memory o = escrow.order(ORDER_A);
        assertTrue(o.exists);
        assertEq(o.payeeId, SUPPLIER_A);
        assertEq(o.lineId, L_SUPPLIER);
        assertEq(o.totalMinor, 430_000);
        assertEq(o.milestoneCount, 3);
        assertTrue(o.inspectionRequired);
        Milestone[] memory m = escrow.milestones(ORDER_A);
        assertEq(m.length, 3);
        assertEq(m[0].amountMinor, 30_000);
        assertTrue(m[0].autoRelease);
        assertEq(m[2].amountMinor, 280_000);
        assertFalse(m[2].autoRelease);
        assertEq(m[2].fundedMinor, 0);
    }

    // ---------------------------------------------------------------------------------------------------------
    // fundMilestone
    // ---------------------------------------------------------------------------------------------------------

    /// Demo task 4: the agent pays the sample; it is autoRelease, so it releases in the same call.
    function test_FundMilestone_SampleAutoReleases() public {
        _setUpSupplierA();
        bytes32 sid = HogeeTypes.milestoneSettlementId(ORDER_A, 0);
        vm.expectEmit(address(escrow));
        emit IHogeeEvents.MilestoneFunded(ORDER_A, 0, 30_000, 30_000, "d", "r");
        vm.expectEmit(address(escrow));
        emit IHogeeEvents.MilestoneReleased(ORDER_A, 0, SUPPLIER_A, 30_000, bytes32(0), sid);
        vm.prank(agent);
        escrow.fundMilestone(ORDER_A, 0, 30_000, "d", "r");

        Milestone memory m = escrow.milestones(ORDER_A)[0];
        assertEq(m.fundedMinor, 30_000);
        assertTrue(m.released);
        assertEq(treasury.pocket(L_SUPPLIER).escrowedMinor, 30_000);
        assertEq(treasury.pocket(L_SUPPLIER).availableMinor, 470_000);
        assertEq(treasury.balances().escrowedMinor, 30_000);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 30_000);
        assertTrue(treasury.isIntentUsed(sid)); // the settlement record exists, still open
        assertEq(treasury.settlementState(sid), HogeeKinds.SETTLEMENT_NONE);
    }

    /// Demo task 5: the 30 % deposit, exactly as pre-signed.
    function test_FundMilestone_DepositExactlyAsPresigned() public {
        _setUpSupplierA();
        _fund(0, 30_000);
        _fund(1, 120_000);
        assertTrue(escrow.milestones(ORDER_A)[1].released);
        assertEq(treasury.balances().escrowedMinor, 150_000);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 150_000);
    }

    /// Partial fundings are cumulative; the autoRelease fires once, when the schedule amount is reached.
    function test_FundMilestone_PartialFundingsReleaseOnceWhenComplete() public {
        _setUpSupplierA();
        _fund(1, 70_000);
        assertFalse(escrow.milestones(ORDER_A)[1].released);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 0);
        _fund(1, 50_000);
        assertTrue(escrow.milestones(ORDER_A)[1].released);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 120_000);
    }

    /// The 280,000 balance exceeds the SUPPLIER per-tx (125,000) and window (250,000) caps: neither applies here.
    /// It is not autoRelease, so funding it releases nothing (the founder must sign).
    function test_FundMilestone_BalanceIgnoresPerTxAndWindowCapsAndStaysLocked() public {
        _setUpSupplierA();
        _fundBalanceA();
        Milestone memory m = escrow.milestones(ORDER_A)[2];
        assertEq(m.fundedMinor, 280_000);
        assertFalse(m.released);
        assertEq(treasury.balances().escrowedMinor, 430_000);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 150_000);
        assertEq(treasury.rollingSpent(L_SUPPLIER), 0); // escrow funding is not a window spend
    }

    /// fundMilestone does not use spend's listing rule: the supplier is bound by its signed approval, and a plan can
    /// never list it (a plan cannot add payees, and the SUPPLIER line is escrow-only).
    function test_FundMilestone_SupplierNeedNotBeListedOnTheLine() public {
        _setUpSupplierA();
        assertEq(registry.line(L_SUPPLIER).payeeIds.length, 0);
        _fund(0, 30_000);
        assertTrue(escrow.milestones(ORDER_A)[0].released);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Reverts, in require-table order
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_NotAgent_fundMilestone_stranger() public {
        _setUpSupplierA();
        _expectFundRevert(stranger, 0, 30_000, IHogeeErrors.NotAgent.selector);
    }

    function test_Revert_NotAgent_fundMilestone_revokedAgent() public {
        _setUpSupplierA();
        vm.prank(founder);
        treasury.tighten(HogeeKinds.TIGHTEN_REVOKE_AGENT, 0, 0, 0);
        _expectFundRevert(agent, 0, 30_000, IHogeeErrors.NotAgent.selector);
    }

    function test_Revert_Paused_fundMilestone_treasuryPaused() public {
        _setUpSupplierA();
        vm.prank(lender);
        treasury.pause();
        _expectFundRevert(agent, 0, 30_000, IHogeeErrors.Paused.selector);
    }

    function test_Revert_AgentExpired_fundMilestone() public {
        _setUpSupplierA();
        vm.warp(T0 + 60 * DAY + 1);
        _expectFundRevert(agent, 0, 30_000, IHogeeErrors.AgentExpired.selector);
    }

    function test_Revert_MissingDecision_fundMilestone_zeroDecision() public {
        _setUpSupplierA();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MissingDecision.selector);
        escrow.fundMilestone(ORDER_A, 0, 30_000, 0, "r");
    }

    function test_Revert_MissingDecision_fundMilestone_zeroRationale() public {
        _setUpSupplierA();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MissingDecision.selector);
        escrow.fundMilestone(ORDER_A, 0, 30_000, "d", 0);
    }

    function test_Revert_PayeeNotBound_fundMilestone_unknownOrder() public {
        _setUpSupplierA();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeNotBound.selector);
        escrow.fundMilestone("order-x", 0, 30_000, "d", "r");
    }

    function test_Revert_PayeeNotBound_fundMilestone_idxOutOfRange() public {
        _setUpSupplierA();
        _expectFundRevert(agent, 3, 1, IHogeeErrors.PayeeNotBound.selector);
    }

    /// A tighten-only v2 shortened the SUPPLIER line's validity; past it, escrow funding stops.
    function test_Revert_LineExpired_fundMilestone_afterValidUntil() public {
        _setUpSupplierA();
        Line[] memory lines = _lines();
        lines[0].validUntil = T0 + 10 * DAY;
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        vm.warp(T0 + 10 * DAY + 1);
        _expectFundRevert(agent, 0, 30_000, IHogeeErrors.LineExpired.selector);
    }

    function test_Revert_CircuitOpen_fundMilestone() public {
        _setUpSupplierA();
        vm.startPrank(agent);
        for (uint256 i = 1; i <= 3; ++i) {
            treasury.recordDenied(L_SUPPLIER, bytes32(i), "AMOUNT_EXCEEDS_SCHEDULE", bytes32(i));
        }
        vm.stopPrank();
        _expectFundRevert(agent, 0, 30_000, IHogeeErrors.CircuitOpen.selector);
    }

    /// TIGHTEN_PAUSE_LINE on SUPPLIER stops escrow funding (a tightening anyone with the role may make alone).
    function test_Revert_Paused_fundMilestone_linePaused() public {
        _setUpSupplierA();
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_SUPPLIER, 0, "d");
        _expectFundRevert(agent, 0, 30_000, IHogeeErrors.Paused.selector);
    }

    /// H6 / demo task 3: inside the payee's veto window even an autoRelease milestone cannot be funded.
    function test_Revert_PayeeCooling_fundMilestone_insideTheVetoWindow() public {
        _setUpRina();
        _bindSupplier(_supplier());
        vm.warp(block.timestamp + COOLING - 1);
        _expectFundRevert(agent, 0, 30_000, IHogeeErrors.PayeeCooling.selector);
    }

    function test_Revert_CapExceeded_fundMilestone_zeroAmount() public {
        _setUpSupplierA();
        _expectFundRevert(agent, 0, 0, IHogeeErrors.CapExceeded.selector);
    }

    /// T18: partial fundings that would exceed the milestone.
    function test_Revert_AmountExceedsSchedule_fundMilestone_partialsExceedTheMilestone() public {
        _setUpSupplierA();
        _fund(1, 100_000);
        _expectFundRevert(agent, 1, 20_001, IHogeeErrors.AmountExceedsSchedule.selector);
    }

    function test_Revert_AmountExceedsSchedule_fundMilestone_releasedMilestone() public {
        _setUpSupplierA();
        _fund(0, 30_000);
        _expectFundRevert(agent, 0, 1, IHogeeErrors.AmountExceedsSchedule.selector);
    }

    /// §26.2: the balance needs stage 2 (outflow would pass the 400,000 released at commit).
    function test_Revert_CapExceeded_fundMilestone_balanceBeforeStage2() public {
        _setUpSupplierA();
        _fund(0, 30_000);
        _fund(1, 120_000);
        _expectFundRevert(agent, 2, 280_000, IHogeeErrors.CapExceeded.selector);
    }

    /// The line balance binds across orders: a second supplier order on SUPPLIER cannot take the line past 500,000.
    function test_Revert_CapExceeded_fundMilestone_aboveTheLineBalance() public {
        _setUpSupplierA();
        _bindOrderB(100_000);
        vm.warp(block.timestamp + COOLING);
        _fundBalanceA(); // 430,000 escrowed
        _fundOrder("order-b-001", 0, 70_000);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        escrow.fundMilestone("order-b-001", 0, 1, "d", "r");
    }

    /// Never fund escrow from BU the lender has not issued.
    function test_Revert_CapExceeded_fundMilestone_aboveFunded() public {
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
        vm.prank(lender);
        treasury.fund(100_000);
        _bindSupplier(_supplier());
        vm.warp(block.timestamp + COOLING);
        _fund(0, 30_000);
        _expectFundRevert(agent, 1, 120_000, IHogeeErrors.CapExceeded.selector);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Hooks: only the linked contracts
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_NotOwner_escrowHooks_directCalls() public {
        _setUpSupplierA();
        vm.startPrank(agent);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.escrowFund(L_SUPPLIER, 1);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.escrowRelease(SAMPLE_ID, L_SUPPLIER, SUPPLIER_A, 1);
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        SupplierApproval memory a = _supplier();
        a.orderId = "order-x";
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        escrow.openOrder(a, schedule, autoRelease);
        vm.stopPrank();
    }

    function test_Revert_PlanInvariantViolated_13_constructor_escrowNotLinked() public {
        vm.expectRevert(
            abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, HogeeKinds.CONST_MALFORMED_PLAN)
        );
        new MilestoneEscrow(address(treasury));
    }

    function test_Views_EscrowLinksAndDomain() public view {
        assertEq(escrow.treasury(), address(treasury));
        assertEq(treasury.escrow(), address(escrow));
        assertEq(escrow.deploymentId(), DEPLOYMENT_ID);
        assertEq(escrow.domainSeparator(), HogeeTypes.domainSeparator(address(escrow), CHAIN_TAG, DEPLOYMENT_ID));
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _expectFundRevert(address caller, uint8 idx, uint128 amount, bytes4 err) internal {
        vm.prank(caller);
        vm.expectRevert(err);
        escrow.fundMilestone(ORDER_A, idx, amount, "d", "r");
    }

    function _fundOrder(bytes32 orderId, uint8 idx, uint128 amount) internal {
        vm.prank(agent);
        escrow.fundMilestone(orderId, idx, amount, "d", "r");
    }

    /// A second supplier order on SUPPLIER: one autoRelease milestone of `amount`.
    function _bindOrderB(uint128 amount) internal {
        uint128[] memory schedule = new uint128[](1);
        bool[] memory autoRelease = new bool[](1);
        (schedule[0], autoRelease[0]) = (amount, true);
        SupplierApproval memory a = _supplier();
        (a.orderId, a.supplierId, a.payee, a.nonce) = ("order-b-001", "supplier-b", "supplier-b", 77);
        (a.scheduleHash, a.totalMinor) = (HogeeTypes.scheduleHash(schedule, autoRelease), amount);
        treasury.bindPayee(a, schedule, autoRelease, _signSupplier(a));
    }
}
