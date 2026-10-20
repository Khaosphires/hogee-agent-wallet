// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PlanApproval, Line, Sig, LoosenRequest, PayeeBinding, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// Each LOOSEN_* kind (HogeeKinds; §8.8, H2): what it changes, and the §8.3 bounds it re-checks at queue time and
/// again at execution (PlanInvariantViolated(code)). One test per revert row of the require table.
contract TreasuryLoosenKindsTest is HogeeTestBase {
    bytes32 internal constant PRINTER = "printer-kl";
    bytes32 internal constant PRINTER_ACCOUNT = keccak256("hogee/test/printer-account");

    function setUp() public override {
        super.setUp();
        _setUpRina();
    }

    // ---------------------------------------------------------------------------------------------------------
    // RAISE_PER_TX_CAP / RAISE_WINDOW_CAP
    // ---------------------------------------------------------------------------------------------------------

    function test_RaiseWindowCap() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP, L_ADS, 40_000, "d");
        _queueAndExecute(_loosen(HogeeKinds.LOOSEN_RAISE_WINDOW_CAP, L_ADS, 0, 60_000, 400));
        assertEq(treasury.pocket(L_ADS).windowCapMinor, 60_000);
    }

    function test_Revert_PlanInvariantViolated_4_queueLoosen_perTxCapOver25Pct() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, L_ADS, 0, 30_001, 400), 4);
    }

    function test_Revert_PlanInvariantViolated_5_queueLoosen_windowCapOver50Pct() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_RAISE_WINDOW_CAP, L_ADS, 0, 60_001, 400), 5);
    }

    /// A value above uint128 is just over the bound (no overflow).
    function test_Revert_PlanInvariantViolated_4_queueLoosen_hugeValue() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, L_ADS, 0, type(uint256).max, 400), 4);
    }

    function test_Revert_LineExpired_queueLoosen_raiseOnALineNotInThePlan() public {
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, "LICENSING", 0, 1, 400), IHogeeErrors.LineExpired.selector
        );
    }

    /// H2: the bound is re-checked at execution. A pocket move shrinks ADS after the raise was queued.
    function test_Revert_PlanInvariantViolated_4_executeLoosen_lineShrankSinceQueued() public {
        vm.startPrank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, 20_000, "d");
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP, L_ADS, 50_000, "d");
        vm.stopPrank();
        bytes32 raise = _queue(_loosen(HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, L_ADS, 0, 30_000, 400));
        _queueAndExecute(_loosen(HogeeKinds.LOOSEN_MOVE_POCKETS, L_ADS, L_CONTINGENCY, 20_000, 401));
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, uint8(4)));
        treasury.executeLoosen(raise);
    }

    // ---------------------------------------------------------------------------------------------------------
    // ADD_PAYEE (target payeeId, aux lineId, newValue payoutAccountHash)
    // ---------------------------------------------------------------------------------------------------------

    function test_AddPayee_BindsListsAndCools() public {
        uint64 coolingUntil = uint64(block.timestamp) + TIMELOCK + COOLING;
        LoosenRequest memory r = _addPrinter(400);
        bytes32 id = _queue(r);
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.PayeeBound(PRINTER, L_PACKAGING, 0, coolingUntil, type(uint128).max, 0, 0, PRINTER_ACCOUNT);
        treasury.executeLoosen(id);

        PayeeBinding memory b = treasury.payeeBinding(L_PACKAGING, PRINTER);
        assertTrue(b.bound);
        assertEq(b.coolingUntil, coolingUntil);
        assertEq(b.lifetimeCapMinor, type(uint128).max);
        assertEq(b.payoutAccountHash, PRINTER_ACCOUNT);
        assertTrue(treasury.isSignedPayee(L_PACKAGING, PRINTER));

        // T3: inside the veto window the agent cannot pay it; afterwards it can (listed by the current version).
        bytes32 d = _nextDecision();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeCooling.selector);
        treasury.spend(L_PACKAGING, PRINTER, 1_000, _invoice(1), 1, d, d);
        vm.warp(coolingUntil);
        _spend(L_PACKAGING, PRINTER, 1_000, _invoice(1));
        assertEq(treasury.pocket(L_PACKAGING).spentMinor, 1_000);
    }

    /// Run-2 audit: the payee is payable only while the current version lists it; a later re-commit may list it
    /// again (R11: bound since by a signed approval).
    function test_AddPayee_DroppedByAReplanUntilListedAgain() public {
        _queueAndExecute(_addPrinter(400));
        vm.warp(block.timestamp + COOLING);
        Line[] memory lines = _lines();
        _commit(_approvalV2(lines, _stages()), lines, _stages()); // v2 does not list the printer
        bytes32 d = _nextDecision();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeNotBound.selector);
        treasury.spend(L_PACKAGING, PRINTER, 1_000, _invoice(1), 2, d, d);

        lines[1].payeeIds = new bytes32[](1);
        lines[1].payeeIds[0] = PRINTER;
        _commit(_approvalV3(lines), lines, _stages());
        _spend(L_PACKAGING, PRINTER, 1_000, _invoice(1));
    }

    function test_Revert_PlanInvariantViolated_13_queueLoosen_addPayeeWithoutAccount() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_ADD_PAYEE, PRINTER, L_PACKAGING, 0, 400), 13);
    }

    function test_Revert_PlanInvariantViolated_13_queueLoosen_addPayeeZeroId() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_ADD_PAYEE, 0, L_PACKAGING, uint256(PRINTER_ACCOUNT), 400), 13);
    }

    function test_Revert_LineExpired_queueLoosen_addPayeeToALineNotInThePlan() public {
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_ADD_PAYEE, PRINTER, "LICENSING", uint256(PRINTER_ACCOUNT), 400),
            IHogeeErrors.LineExpired.selector
        );
    }

    /// §8.3: the supplier line pays only through escrow; its payees come from SupplierApproval (bindPayee).
    function test_Revert_PlanInvariantViolated_10_queueLoosen_addPayeeToAnEscrowLine() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_ADD_PAYEE, PRINTER, L_SUPPLIER, uint256(PRINTER_ACCOUNT), 400), 10);
    }

    /// A static platform payee keeps its fixed account and is uncapped (same rule as bindPayee).
    function test_Revert_PlanInvariantViolated_11_queueLoosen_addAPlatformPayee() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_ADD_PAYEE, P_ADS, L_PACKAGING, uint256(PRINTER_ACCOUNT), 400), 11);
    }

    // ---------------------------------------------------------------------------------------------------------
    // EXTEND_AGENT_EXPIRY / EXTEND_LINE_EXPIRY
    // ---------------------------------------------------------------------------------------------------------

    function test_ExtendAgentExpiry() public {
        uint64 newExpiry = uint64(block.timestamp) + 85 * DAY;
        _queueAndExecute(_loosen(HogeeKinds.LOOSEN_EXTEND_AGENT_EXPIRY, 0, 0, newExpiry, 400));
        assertEq(treasury.agentExpiry(), newExpiry);
        assertEq(registry.currentPlan().agentExpiry, newExpiry);
    }

    function test_Revert_PlanInvariantViolated_2_queueLoosen_agentExpiryOver90Days() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_EXTEND_AGENT_EXPIRY, 0, 0, block.timestamp + 90 * DAY + 1, 400), 2);
    }

    function test_Revert_PlanInvariantViolated_13_queueLoosen_agentExpiryWithATarget() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_EXTEND_AGENT_EXPIRY, L_ADS, 0, block.timestamp + DAY, 400), 13);
    }

    /// Before the first plan the first commit would overwrite the agent expiry.
    function test_Revert_StalePlan_queueLoosen_agentExpiryBeforeThePlan() public {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        _registerFounder();
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_EXTEND_AGENT_EXPIRY, 0, 0, block.timestamp + DAY, 400),
            IHogeeErrors.StalePlan.selector
        );
    }

    function test_ExtendLineExpiry() public {
        uint64 until = uint64(block.timestamp) + 90 * DAY;
        _queueAndExecute(_loosen(HogeeKinds.LOOSEN_EXTEND_LINE_EXPIRY, L_ADS, 0, until, 400));
        assertEq(treasury.pocket(L_ADS).validUntil, until);
    }

    function test_Revert_PlanInvariantViolated_6_queueLoosen_lineValidityOver90Days() public {
        _expectQueueCode(
            _loosen(HogeeKinds.LOOSEN_EXTEND_LINE_EXPIRY, L_ADS, 0, block.timestamp + 90 * DAY + 1, 400), 6
        );
    }

    function test_Revert_LineExpired_queueLoosen_extendALineNotInThePlan() public {
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_EXTEND_LINE_EXPIRY, "LICENSING", 0, block.timestamp + DAY, 400),
            IHogeeErrors.LineExpired.selector
        );
    }

    // ---------------------------------------------------------------------------------------------------------
    // MOVE_POCKETS (target from-line, aux to-line, newValue amount)
    // ---------------------------------------------------------------------------------------------------------

    /// CONTINGENCY -> ADS 20,000 after lowering CONTINGENCY's caps to fit 25 % / 50 % of 80,000.
    function test_MovePockets() public {
        _lowerContingencyCaps();
        _queueAndExecute(_loosen(HogeeKinds.LOOSEN_MOVE_POCKETS, L_CONTINGENCY, L_ADS, 20_000, 400));
        assertEq(treasury.pocket(L_CONTINGENCY).allocatedMinor, 80_000);
        assertEq(treasury.pocket(L_ADS).allocatedMinor, 140_000);
        // G0 audit v-1: a later founder re-commit must carry the moved amounts (R6).
        Line[] memory lines = _lines();
        (lines[5].amountMinor, lines[5].perTxCapMinor, lines[5].windowCapMinor) = (80_000, 20_000, 40_000);
        lines[3].amountMinor = 140_000;
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        assertEq(registry.planVersion(), 2);
    }

    function test_Revert_PlanInvariantViolated_13_queueLoosen_moveToTheSameLine() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_MOVE_POCKETS, L_ADS, L_ADS, 1, 400), 13);
    }

    function test_Revert_PlanInvariantViolated_13_queueLoosen_moveZero() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_MOVE_POCKETS, L_CONTINGENCY, L_ADS, 0, 400), 13);
    }

    function test_Revert_LineExpired_queueLoosen_moveToALineNotInThePlan() public {
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_MOVE_POCKETS, L_CONTINGENCY, "LICENSING", 1, 400),
            IHogeeErrors.LineExpired.selector
        );
    }

    /// Only the from-line's unspent, unescrowed balance can move.
    function test_Revert_CapExceeded_queueLoosen_moveMoreThanAvailable() public {
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_MOVE_POCKETS, L_CONTINGENCY, L_ADS, 100_001, 400),
            IHogeeErrors.CapExceeded.selector
        );
    }

    /// The from-line's caps must stay within 25 % / 50 % of its reduced amount.
    function test_Revert_PlanInvariantViolated_4_queueLoosen_moveBreaksTheFromLinePerTxCap() public {
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_MOVE_POCKETS, L_CONTINGENCY, L_ADS, 1, 400), 4);
    }

    function test_Revert_PlanInvariantViolated_5_queueLoosen_moveBreaksTheFromLineWindowCap() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_CONTINGENCY, 20_000, "d");
        _expectQueueCode(_loosen(HogeeKinds.LOOSEN_MOVE_POCKETS, L_CONTINGENCY, L_ADS, 1, 400), 5);
    }

    // ---------------------------------------------------------------------------------------------------------
    // UNPAUSE (target 0 = treasury, or a lineId: also closes its circuit)
    // ---------------------------------------------------------------------------------------------------------

    function test_Unpause_Treasury() public {
        vm.prank(agent);
        treasury.pause();
        bytes32 id = _queue(_loosen(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0, 400));
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.Unpaused(0, stranger);
        vm.prank(stranger);
        treasury.executeLoosen(id);
        assertFalse(treasury.paused());
        _spendAds(1, 7_500);
    }

    /// A tripped line reopens with a fresh denial count, so one more denial does not trip it again.
    function test_Unpause_LineClosesTheCircuit() public {
        vm.startPrank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_ADS, 0, "d");
        for (uint256 i = 1; i <= 3; ++i) {
            treasury.recordDenied(L_ADS, bytes32(i), "CAP_EXCEEDED", bytes32(i));
        }
        vm.stopPrank();
        assertTrue(treasury.pocket(L_ADS).circuitOpen);
        _queueAndExecute(_loosen(HogeeKinds.LOOSEN_UNPAUSE, L_ADS, 0, 0, 400));
        assertFalse(treasury.pocket(L_ADS).paused);
        assertFalse(treasury.pocket(L_ADS).circuitOpen);
        vm.prank(agent);
        treasury.recordDenied(L_ADS, "d4", "CAP_EXCEEDED", "p4");
        assertFalse(treasury.pocket(L_ADS).circuitOpen);
        _spendAds(1, 7_500);
    }

    function test_Revert_LineExpired_queueLoosen_unpauseALineNotInThePlan() public {
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_UNPAUSE, "LICENSING", 0, 0, 400), IHogeeErrors.LineExpired.selector
        );
    }

    // ---------------------------------------------------------------------------------------------------------
    // WITHDRAW_RESERVE (target taxPayeeId, newValue amount): settled like a spend, settlementId = loosenId
    // ---------------------------------------------------------------------------------------------------------

    function test_WithdrawReserve_EmitsReserveWithdrawnAndSettles() public {
        _recordSale(1, 100_000);
        bytes32 id = _queue(_loosen(HogeeKinds.LOOSEN_WITHDRAW_RESERVE, P_TAX, 0, 3_000, 400));
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.ReserveWithdrawn(id, P_TAX, 3_000);
        treasury.executeLoosen(id);
        assertEq(treasury.reserve(), 2_000);
        (, uint128 withdrawn,) = treasury.revenueLedger();
        assertEq(withdrawn, 3_000);
        assertTrue(treasury.isIntentUsed(id));
        vm.prank(oracle);
        treasury.confirmSettlement(id, keccak256("tax-payout-ref"));
        assertEq(treasury.settlementState(id), HogeeKinds.SETTLEMENT_CONFIRMED);
    }

    /// M8: a failed tax payout returns the amount to the reserve.
    function test_WithdrawReserve_FailedSettlementRefundsTheReserve() public {
        _recordSale(1, 100_000);
        bytes32 id = _queueAndExecute(_loosen(HogeeKinds.LOOSEN_WITHDRAW_RESERVE, P_TAX, 0, 5_000, 400));
        vm.prank(oracle);
        treasury.failSettlement(id, "INVALID_DESTINATION");
        assertEq(treasury.reserve(), 5_000);
        (, uint128 withdrawn,) = treasury.revenueLedger();
        assertEq(withdrawn, 0);
    }

    /// The tax payee needs a fixed payout account (static platform registry): no free-form destination.
    function test_Revert_PayeeNotBound_queueLoosen_withdrawToAPayeeOutsideThePlatformRegistry() public {
        _recordSale(1, 100_000);
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_WITHDRAW_RESERVE, "0xevil", 0, 1, 400), IHogeeErrors.PayeeNotBound.selector
        );
    }

    function test_Revert_CapExceeded_queueLoosen_withdrawMoreThanTheReserve() public {
        _recordSale(1, 100_000);
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_WITHDRAW_RESERVE, P_TAX, 0, 5_001, 400), IHogeeErrors.CapExceeded.selector
        );
    }

    function test_Revert_CapExceeded_queueLoosen_withdrawZero() public {
        _recordSale(1, 100_000);
        _expectQueueRevert(
            _loosen(HogeeKinds.LOOSEN_WITHDRAW_RESERVE, P_TAX, 0, 0, 400), IHogeeErrors.CapExceeded.selector
        );
    }

    /// Re-checked at execution: two queued withdrawals cannot both drain the same reserve.
    function test_Revert_CapExceeded_executeLoosen_reserveDrainedSinceQueued() public {
        _recordSale(1, 100_000);
        bytes32 a = _queue(_loosen(HogeeKinds.LOOSEN_WITHDRAW_RESERVE, P_TAX, 0, 5_000, 400));
        bytes32 b = _queue(_loosen(HogeeKinds.LOOSEN_WITHDRAW_RESERVE, P_TAX, 0, 5_000, 401));
        vm.warp(block.timestamp + TIMELOCK);
        treasury.executeLoosen(a);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.executeLoosen(b);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _addPrinter(uint256 nonce) internal view returns (LoosenRequest memory) {
        return _loosen(HogeeKinds.LOOSEN_ADD_PAYEE, PRINTER, L_PACKAGING, uint256(PRINTER_ACCOUNT), nonce);
    }

    function _lowerContingencyCaps() internal {
        vm.startPrank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_CONTINGENCY, 20_000, "d");
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP, L_CONTINGENCY, 40_000, "d");
        vm.stopPrank();
    }

    /// Plan v3 on top of _approvalV2 (same stages).
    function _approvalV3(Line[] memory lines) internal view returns (PlanApproval memory a) {
        a = _approvalV2(lines, _stages());
        (a.version, a.prevPlanHash, a.planHash, a.nonce) =
        (3, keccak256("hogee/test/plan-v2"), keccak256("hogee/test/plan-v3"), 103);
    }

    function _expectQueueRevert(LoosenRequest memory r, bytes4 err) internal {
        (Sig memory f, Sig memory l) = (_signLoosen(founderPk, r), _signLoosen(lenderPk, r));
        vm.prank(relayer);
        vm.expectRevert(err);
        treasury.queueLoosen(r, f, l);
    }

    function _expectQueueCode(LoosenRequest memory r, uint8 code) internal {
        (Sig memory f, Sig memory l) = (_signLoosen(founderPk, r), _signLoosen(lenderPk, r));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, code));
        treasury.queueLoosen(r, f, l);
    }
}
