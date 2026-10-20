// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Line, Sig, QueuedLoosen, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {PlanSync} from "../src/HogeeHooks.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// Treasury controls: tighten, pause, recordDenied (circuit breaker, T26), settlement (M8) and the plan hook (T6).
/// One test per revert row of the require table.
contract TreasuryControlsTest is HogeeTestBase {
    // ---------------------------------------------------------------------------------------------------------
    // tighten
    // ---------------------------------------------------------------------------------------------------------

    function test_Tighten_LowerPerTxCap_EmitsOldAndNew() public {
        _setUpRina();
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.Tightened(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, agent, 30_000, 8_500, "d");
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, 8_500, "d");
        assertEq(treasury.pocket(L_ADS).perTxCapMinor, 8_500);
    }

    function test_Tighten_LowerWindowCap() public {
        _setUpRina();
        vm.prank(lender);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP, L_ADS, 59_500, 0);
        assertEq(treasury.pocket(L_ADS).windowCapMinor, 59_500);
    }

    function test_Tighten_RaiseReserveBps() public {
        _setUpRina();
        vm.prank(founder);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 800, 0);
        assertEq(registry.currentPlan().reserveBps, 800);
    }

    function test_Tighten_RevokeAgentLogsTheFlag() public {
        _setUpRina();
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.Tightened(HogeeKinds.TIGHTEN_REVOKE_AGENT, 0, agent, 0, 1, "d");
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_REVOKE_AGENT, 0, 0, "d");
        assertTrue(registry.currentPlan().agentRevoked);
    }

    function test_Tighten_PauseLineEmitsTreasuryPausedForTheLine() public {
        _setUpRina();
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.TreasuryPaused(L_ADS, lender);
        vm.prank(lender);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_ADS, 0, 0);
        assertTrue(treasury.pocket(L_ADS).paused);
        assertFalse(treasury.paused());
    }

    function test_Tighten_EqualValueIsAllowed() public {
        _setUpRina();
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, 30_000, "d");
        assertEq(treasury.pocket(L_ADS).perTxCapMinor, 30_000);
    }

    function test_Revert_NotAgent_tighten_stranger() public {
        _setUpRina();
        vm.prank(stranger);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_ADS, 0, "d");
    }

    function test_Revert_NotAgent_tighten_revokedAgent() public {
        _setUpRina();
        vm.prank(founder);
        treasury.tighten(HogeeKinds.TIGHTEN_REVOKE_AGENT, 0, 0, 0);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_ADS, 0, "d");
    }

    function test_Revert_AgentExpired_tighten() public {
        _setUpRina();
        vm.warp(T0 + 60 * DAY + 1);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.AgentExpired.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_ADS, 0, "d");
    }

    function test_Revert_MissingDecision_tighten_agentWithoutDecision() public {
        _setUpRina();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MissingDecision.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_ADS, 0, 0);
    }

    function test_Revert_LineExpired_tighten_lineNotInPlan() public {
        _setUpRina();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.LineExpired.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, "LICENSING", 0, "d");
    }

    /// T6: the agent tries to raise a cap.
    function test_Revert_NotOwner_tighten_raisePerTxCap() public {
        _setUpRina();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, 30_001, "d");
    }

    function test_Revert_NotOwner_tighten_raiseWindowCapEvenAsLender() public {
        _setUpRina();
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP, L_ADS, 60_001, 0);
    }

    /// T12: "set reserve to 0%" can only arrive as a tighten, which cannot lower it.
    function test_Revert_NotOwner_tighten_lowerReserve() public {
        _setUpRina();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 0, "d");
    }

    /// Run-2 audit: before the first commit there is no plan reserve to raise, and the first syncPlan would
    /// silently overwrite the value with the signed reserveBps.
    function test_Revert_StalePlan_tighten_raiseReserveBeforeFirstCommit() public {
        _openFacility();
        _registerFounder();
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.StalePlan.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 800, 0);
        vm.prank(founder);
        vm.expectRevert(IHogeeErrors.StalePlan.selector);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 800, 0);
        _commit(_rinaApproval(), _lines(), _stages());
        vm.prank(lender);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 800, 0);
        assertEq(registry.currentPlan().reserveBps, 800);
    }

    function test_Revert_PlanInvariantViolated_13_tighten_malformed() public {
        _setUpRina();
        bytes memory err = abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 13);
        vm.startPrank(agent);
        vm.expectRevert(err);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, L_ADS, 600, "d"); // target must be 0
        vm.expectRevert(err);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 10_001, "d");
        vm.expectRevert(err);
        treasury.tighten(HogeeKinds.TIGHTEN_REVOKE_AGENT, L_ADS, 0, "d");
        vm.expectRevert(err);
        treasury.tighten(HogeeKinds.TIGHTEN_REVOKE_AGENT, 0, 1, "d");
        vm.expectRevert(err);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_ADS, 1, "d");
        vm.expectRevert(err);
        treasury.tighten(0, L_ADS, 0, "d");
        vm.expectRevert(err);
        treasury.tighten(6, L_ADS, 0, "d");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------------------
    // pause
    // ---------------------------------------------------------------------------------------------------------

    function test_Pause_ByAgentOwnerOrLender() public {
        _setUpRina();
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.TreasuryPaused(bytes32(0), agent);
        vm.prank(agent);
        treasury.pause();
        assertTrue(treasury.paused());
        vm.prank(founder);
        treasury.pause();
        vm.prank(lender);
        treasury.pause();
        assertTrue(treasury.paused());
    }

    function test_Revert_NotAgent_pause_stranger() public {
        _setUpRina();
        vm.prank(stranger);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.pause();
    }

    function test_Revert_AgentExpired_pause() public {
        _setUpRina();
        vm.warp(T0 + 60 * DAY + 1);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.AgentExpired.selector);
        treasury.pause();
    }

    // ---------------------------------------------------------------------------------------------------------
    // recordDenied + circuit breaker
    // ---------------------------------------------------------------------------------------------------------

    /// T26: injected off-plan spends. The circuit trips at the 3rd denial; the 4th reverts cheaply.
    function test_T26_CircuitTripsAfterThreeDenials() public {
        _setUpRina();
        _deny(L_ADS, 1);
        _deny(L_ADS, 2);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.CircuitTripped(L_ADS, 3);
        _deny(L_ADS, 3);
        assertTrue(treasury.pocket(L_ADS).circuitOpen);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CircuitOpen.selector);
        treasury.recordDenied(L_ADS, "d4", "PAYEE_NOT_IN_PLAN", 0);
        _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1)); // other lines keep paying
    }

    function test_RecordDenied_EmitsRunningCount() public {
        _setUpRina();
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.Denied("d1", L_ADS, "CAP_EXCEEDED", keccak256("p"), 1);
        vm.prank(agent);
        treasury.recordDenied(L_ADS, "d1", "CAP_EXCEEDED", keccak256("p"));
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.Denied("d2", L_ADS, "CAP_EXCEEDED", keccak256("p"), 2);
        vm.prank(agent);
        treasury.recordDenied(L_ADS, "d2", "CAP_EXCEEDED", keccak256("p"));
    }

    /// The count slides with the line window: 2 denials, a full window later 1 more does not trip.
    function test_RecordDenied_CountSlidesWithTheLineWindow() public {
        _setUpRina();
        _deny(L_ADS, 1);
        _deny(L_ADS, 2);
        vm.warp(T0 + WINDOW);
        _deny(L_ADS, 3);
        assertFalse(treasury.pocket(L_ADS).circuitOpen);
        _deny(L_ADS, 4);
        assertFalse(treasury.pocket(L_ADS).circuitOpen);
        _deny(L_ADS, 5); // 3 inside one window
        assertTrue(treasury.pocket(L_ADS).circuitOpen);
    }

    function test_RecordDenied_NonLineKeyIsRateLimitedNotPaused() public {
        _setUpRina();
        _deny(bytes32(0), 1);
        _deny(bytes32(0), 2);
        _deny(bytes32(0), 3);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CircuitOpen.selector);
        treasury.recordDenied(bytes32(0), "d4", "INJECTION", 0);
        assertFalse(treasury.paused());
        vm.warp(T0 + 1 days);
        _deny(bytes32(0), 5);
    }

    function test_RecordDenied_AllowedWhilePaused() public {
        _setUpRina();
        vm.prank(lender);
        treasury.pause();
        _deny(L_ADS, 1);
    }

    function test_Revert_NotAgent_recordDenied() public {
        _setUpRina();
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.recordDenied(L_ADS, "d", "r", 0);
    }

    function test_Revert_AgentExpired_recordDenied() public {
        _setUpRina();
        vm.warp(T0 + 60 * DAY + 1);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.AgentExpired.selector);
        treasury.recordDenied(L_ADS, "d", "r", 0);
    }

    function test_Revert_MissingDecision_recordDenied() public {
        _setUpRina();
        vm.startPrank(agent);
        vm.expectRevert(IHogeeErrors.MissingDecision.selector);
        treasury.recordDenied(L_ADS, 0, "r", 0);
        vm.expectRevert(IHogeeErrors.MissingDecision.selector);
        treasury.recordDenied(L_ADS, "d", 0, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------------------------------------------

    function test_ConfirmSettlement_ClosesOnce() public {
        _setUpRina();
        bytes32 id = _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.SettlementConfirmed(id, keccak256("payout-ref"));
        vm.prank(oracle);
        treasury.confirmSettlement(id, keccak256("payout-ref"));
        assertEq(treasury.settlementState(id), HogeeKinds.SETTLEMENT_CONFIRMED);
        vm.prank(oracle);
        vm.expectRevert(IHogeeErrors.SettlementClosed.selector);
        treasury.confirmSettlement(id, keccak256("payout-ref"));
        vm.prank(oracle);
        vm.expectRevert(IHogeeErrors.SettlementClosed.selector);
        treasury.failSettlement(id, "INVALID_DESTINATION");
    }

    /// M8: a failed payout returns the amount to the pocket; the intent and the invoice stay consumed.
    function test_FailSettlement_RefundsThePocketOnly() public {
        _setUpRina();
        bytes32 id = _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.SettlementFailed(id, "INVALID_DESTINATION");
        vm.prank(oracle);
        treasury.failSettlement(id, "INVALID_DESTINATION");
        assertEq(treasury.settlementState(id), HogeeKinds.SETTLEMENT_FAILED);
        assertEq(treasury.pocket(L_LOGISTICS).spentMinor, 0);
        assertEq(treasury.pocket(L_LOGISTICS).availableMinor, 80_000);
        assertEq(treasury.balances().spentMinor, 0);
        assertEq(treasury.payeeBinding(L_LOGISTICS, P_LOGISTICS).paidMinor, 0);
        assertTrue(treasury.isIntentUsed(id));
        assertTrue(treasury.isInvoicePaid(_invoice(1)));
        assertEq(treasury.rollingSpent(L_LOGISTICS), 20_000);
        vm.prank(oracle);
        vm.expectRevert(IHogeeErrors.SettlementClosed.selector);
        treasury.confirmSettlement(id, 0);
    }

    function test_Revert_NotOracle_confirmSettlement() public {
        _setUpRina();
        bytes32 id = _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        vm.prank(agent); // T24-style: the agent cannot act as the oracle
        vm.expectRevert(IHogeeErrors.NotOracle.selector);
        treasury.confirmSettlement(id, 0);
    }

    function test_Revert_NotOracle_failSettlement() public {
        _setUpRina();
        bytes32 id = _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.NotOracle.selector);
        treasury.failSettlement(id, "X");
    }

    function test_Revert_SettlementClosed_unknownSettlementId() public {
        _setUpRina();
        vm.startPrank(oracle);
        vm.expectRevert(IHogeeErrors.SettlementClosed.selector);
        treasury.confirmSettlement(keccak256("never spent"), 0);
        vm.expectRevert(IHogeeErrors.SettlementClosed.selector);
        treasury.failSettlement(keccak256("never spent"), "X");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Plan hook and the signed entry points
    // ---------------------------------------------------------------------------------------------------------

    /// T6: nobody but PlanRegistry can push a plan into Treasury.
    function test_Revert_NotOwner_syncPlan_directCall() public {
        _setUpRina();
        PlanSync memory s = PlanSync("p", 9, 1, agent, T0 + 80 * DAY, 0);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.syncPlan(s, _lines(), _stages());
    }

    /// The former loop-1 stubs are live (task 1.8): unsigned requests fail the signature check, and an id that was
    /// never queued is neither executable nor reported as queued.
    function test_SignedEntryPoints_RejectUnsignedRequestsAndUnknownIds() public {
        _setUpRina();
        Sig memory sig = Sig(0, "");
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        treasury.ownerSpend(_ownerSpend(), sig);
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        treasury.queueLoosen(_loosenRequest(), sig, sig);
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        treasury.releaseStage(_stageRelease(), sig);
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.executeLoosen(keccak256("id"));
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.cancelLoosen(keccak256("id"));
        QueuedLoosen memory q = treasury.queuedLoosen(keccak256("id"));
        assertEq(q.status, HogeeKinds.LOOSEN_STATUS_NONE);
    }

    function test_Views_RolesAndConstants() public view {
        assertEq(treasury.lender(), lender);
        assertEq(treasury.oracle(), oracle);
        assertEq(treasury.coolingSeconds(), COOLING);
        (, bytes32[] memory hashes) = _platformPayees();
        assertEq(treasury.platformPayoutAccountHash(P_ADS), hashes[1]);
        assertEq(treasury.platformPayoutAccountHash("printer-kl"), bytes32(0));
        assertEq(registry.judgingWindowEnd(), JUDGING_END);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _deny(bytes32 lineId, uint256 n) private {
        vm.prank(agent);
        treasury.recordDenied(lineId, bytes32(n), "PAYEE_NOT_IN_PLAN", keccak256(abi.encode(n)));
    }
}
