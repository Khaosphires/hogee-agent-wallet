// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Sig, LoosenRequest, QueuedLoosen, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// The loosening queue (§8.8, H2): queueLoosen needs the founder AND the lender, executeLoosen runs only after the
/// timelock and before the grace period ends (T9: TimelockActive), cancelLoosen is the owner's, lender's or
/// observer's veto (T3), and pause cancels everything queued. One test per revert row of the require table.
contract TreasuryLoosenQueueTest is HogeeTestBase {
    uint64 internal constant GRACE = 7 days;

    function setUp() public override {
        super.setUp();
        _setUpRina();
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, 20_000, "d"); // room for a raise back to 30,000
    }

    // ---------------------------------------------------------------------------------------------------------
    // queueLoosen
    // ---------------------------------------------------------------------------------------------------------

    function test_QueueLoosen_StoresTheRequestAndEmits() public {
        LoosenRequest memory r = _raiseAds(400);
        bytes32 id = HogeeTypes.hashLoosenRequest(r);
        uint64 execAt = uint64(block.timestamp) + TIMELOCK;
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.LoosenQueued(id, HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, L_ADS, 0, 30_000, execAt, execAt + GRACE);
        assertEq(_queue(r), id);
        QueuedLoosen memory q = treasury.queuedLoosen(id);
        assertEq(q.kind, HogeeKinds.LOOSEN_RAISE_PER_TX_CAP);
        assertEq(q.target, L_ADS);
        assertEq(q.newValue, 30_000);
        assertEq(q.executableAt, execAt);
        assertEq(q.expiresAt, execAt + GRACE);
        assertEq(q.status, HogeeKinds.LOOSEN_STATUS_QUEUED);
        assertTrue(treasury.isNonceUsed(400));
        assertEq(treasury.pocket(L_ADS).perTxCapMinor, 20_000); // nothing changes before execution
    }

    /// H2: every current kind needs the lender's co-signature.
    function test_RequiresLender_EveryKind() public pure {
        for (uint8 k = HogeeKinds.LOOSEN_RAISE_PER_TX_CAP; k <= HogeeKinds.LOOSEN_WITHDRAW_RESERVE; ++k) {
            assertTrue(HogeeKinds.requiresLender(k));
        }
    }

    /// The only way out of a pause is a loosening (UNPAUSE), so queueing works while paused.
    function test_QueueLoosen_WorksWhilePaused() public {
        vm.prank(agent);
        treasury.pause();
        bytes32 id = _queue(_loosen(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0, 400));
        assertEq(treasury.queuedLoosen(id).status, HogeeKinds.LOOSEN_STATUS_QUEUED);
    }

    function test_Revert_InvalidSignature_queueLoosen_otherDeployment() public {
        LoosenRequest memory r = _raiseAds(400);
        r.deploymentId = "loop-1";
        _expectQueueRevert(
            r, _signLoosen(founderPk, r), _signLoosen(lenderPk, r), IHogeeErrors.InvalidSignature.selector
        );
    }

    function test_Revert_SignatureExpired_queueLoosen() public {
        LoosenRequest memory r = _raiseAds(400);
        (Sig memory f, Sig memory l) = (_signLoosen(founderPk, r), _signLoosen(lenderPk, r));
        vm.warp(r.expiry + 1);
        _expectQueueRevert(r, f, l, IHogeeErrors.SignatureExpired.selector);
    }

    function test_Revert_InvalidSignature_queueLoosen_nonceReused() public {
        _queue(_raiseAds(400));
        LoosenRequest memory r = _loosen(HogeeKinds.LOOSEN_RAISE_WINDOW_CAP, L_ADS, 0, 60_000, 400);
        _expectQueueRevert(
            r, _signLoosen(founderPk, r), _signLoosen(lenderPk, r), IHogeeErrors.InvalidSignature.selector
        );
    }

    /// T6: the agent signs as founder (and as lender) to raise a cap.
    function test_Revert_NotOwner_queueLoosen_agentSignsAsFounder() public {
        LoosenRequest memory r = _raiseAds(400);
        Sig memory a = _signLoosen(agentPk, r);
        _expectQueueRevert(r, a, a, IHogeeErrors.NotOwner.selector);
    }

    /// H2: the founder alone cannot loosen; signing twice is not a co-signature.
    function test_Revert_InvalidSignature_queueLoosen_founderSignsAsLender() public {
        LoosenRequest memory r = _raiseAds(400);
        Sig memory f = _signLoosen(founderPk, r);
        _expectQueueRevert(r, f, f, IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_queueLoosen_agentAsLender() public {
        LoosenRequest memory r = _raiseAds(400);
        _expectQueueRevert(
            r, _signLoosen(founderPk, r), _signLoosen(agentPk, r), IHogeeErrors.InvalidSignature.selector
        );
    }

    function test_Revert_InvalidSignature_queueLoosen_lenderWebauthnKind() public {
        LoosenRequest memory r = _raiseAds(400);
        Sig memory l = _signLoosen(lenderPk, r);
        l.kind = HogeeKinds.SIG_WEBAUTHN;
        _expectQueueRevert(r, _signLoosen(founderPk, r), l, IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_PlanInvariantViolated_13_queueLoosen_unknownKind() public {
        _expectKindRevert(0);
        _expectKindRevert(9);
    }

    /// At most 16 live loosenings (gas bound for pause); expired ones free their slots.
    function test_Revert_CapExceeded_queueLoosen_queueFull() public {
        for (uint256 i; i < 16; ++i) {
            _queue(_loosen(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0, 500 + i));
        }
        LoosenRequest memory r = _loosen(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0, 600);
        _expectQueueRevert(r, _signLoosen(founderPk, r), _signLoosen(lenderPk, r), IHogeeErrors.CapExceeded.selector);
        vm.warp(block.timestamp + TIMELOCK + GRACE + 1);
        r = _loosen(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0, 601);
        assertEq(treasury.queuedLoosen(_queue(r)).status, HogeeKinds.LOOSEN_STATUS_QUEUED);
    }

    // ---------------------------------------------------------------------------------------------------------
    // executeLoosen
    // ---------------------------------------------------------------------------------------------------------

    /// Demo task 12 continued: after the timelock anyone (here a stranger) executes the co-signed raise.
    function test_ExecuteLoosen_AfterTheTimelock() public {
        bytes32 id = _queue(_raiseAds(400));
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.LoosenExecuted(id, HogeeKinds.LOOSEN_RAISE_PER_TX_CAP);
        vm.prank(stranger);
        treasury.executeLoosen(id);
        assertEq(treasury.pocket(L_ADS).perTxCapMinor, 30_000);
        assertEq(treasury.queuedLoosen(id).status, HogeeKinds.LOOSEN_STATUS_EXECUTED);
    }

    /// T9 / demo task 12: the early cap raise.
    function test_Revert_TimelockActive_executeLoosen_early() public {
        bytes32 id = _queue(_raiseAds(400));
        vm.warp(block.timestamp + TIMELOCK - 1);
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.executeLoosen(id);
    }

    function test_Revert_TimelockActive_executeLoosen_unknownId() public {
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.executeLoosen(keccak256("never queued"));
    }

    function test_Revert_TimelockActive_executeLoosen_twice() public {
        bytes32 id = _queueAndExecute(_raiseAds(400));
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.executeLoosen(id);
    }

    /// The grace period ends at executableAt + 7 days (inclusive); after it the request is EXPIRED.
    function test_Revert_SignatureExpired_executeLoosen_afterTheGracePeriod() public {
        bytes32 id = _queue(_raiseAds(400));
        uint64 expiresAt = treasury.queuedLoosen(id).expiresAt;
        vm.warp(expiresAt + 1);
        assertEq(treasury.queuedLoosen(id).status, HogeeKinds.LOOSEN_STATUS_EXPIRED);
        vm.expectRevert(IHogeeErrors.SignatureExpired.selector);
        treasury.executeLoosen(id);
    }

    function test_ExecuteLoosen_AtTheEndOfTheGracePeriod() public {
        bytes32 id = _queue(_raiseAds(400));
        vm.warp(treasury.queuedLoosen(id).expiresAt);
        treasury.executeLoosen(id);
        assertEq(treasury.pocket(L_ADS).perTxCapMinor, 30_000);
    }

    // ---------------------------------------------------------------------------------------------------------
    // cancelLoosen and pause
    // ---------------------------------------------------------------------------------------------------------

    /// T3: the observer vetoes inside the timelock window; nothing moves.
    function test_CancelLoosen_ObserverVeto() public {
        bytes32 id = _queue(_raiseAds(400));
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.LoosenCancelled(id, observer);
        vm.prank(observer);
        treasury.cancelLoosen(id);
        assertEq(treasury.queuedLoosen(id).status, HogeeKinds.LOOSEN_STATUS_CANCELLED);
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.executeLoosen(id);
        assertEq(treasury.pocket(L_ADS).perTxCapMinor, 20_000);
    }

    function test_CancelLoosen_OwnerAndLender() public {
        bytes32 a = _queue(_raiseAds(400));
        bytes32 b = _queue(_loosen(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0, 401));
        vm.prank(founder);
        treasury.cancelLoosen(a);
        vm.prank(lender);
        treasury.cancelLoosen(b);
        assertEq(treasury.queuedLoosen(a).status, HogeeKinds.LOOSEN_STATUS_CANCELLED);
        assertEq(treasury.queuedLoosen(b).status, HogeeKinds.LOOSEN_STATUS_CANCELLED);
    }

    function test_Revert_NotOwner_cancelLoosen_agent() public {
        bytes32 id = _queue(_raiseAds(400));
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.cancelLoosen(id);
    }

    function test_Revert_NotOwner_cancelLoosen_stranger() public {
        bytes32 id = _queue(_raiseAds(400));
        vm.prank(stranger);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        treasury.cancelLoosen(id);
    }

    function test_Revert_TimelockActive_cancelLoosen_notQueued() public {
        bytes32 id = _queueAndExecute(_raiseAds(400));
        vm.startPrank(lender);
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.cancelLoosen(id);
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.cancelLoosen(keccak256("never queued"));
        vm.stopPrank();
    }

    /// §8.8: pause cancels everything queued (a loosening queued after the pause survives: the way out).
    function test_Pause_CancelsEveryQueuedLoosening() public {
        bytes32 a = _queue(_raiseAds(400));
        bytes32 b = _queue(_loosen(HogeeKinds.LOOSEN_RAISE_WINDOW_CAP, L_ADS, 0, 60_000, 401));
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.LoosenCancelled(a, agent);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.LoosenCancelled(b, agent);
        vm.prank(agent);
        treasury.pause();
        assertEq(treasury.queuedLoosen(a).status, HogeeKinds.LOOSEN_STATUS_CANCELLED);
        assertEq(treasury.queuedLoosen(b).status, HogeeKinds.LOOSEN_STATUS_CANCELLED);

        bytes32 u = _queueAndExecute(_loosen(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0, 402));
        assertEq(treasury.queuedLoosen(u).status, HogeeKinds.LOOSEN_STATUS_EXECUTED);
        assertFalse(treasury.paused());
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.executeLoosen(a);
    }

    /// The way out of a pause cannot be blocked by re-pausing: pause cancels the queue only when it pauses an
    /// unpaused treasury, so an agent key that keeps calling pause() cannot cancel the co-signed UNPAUSE.
    function test_Pause_AgainWhilePausedKeepsTheUnpauseQueued() public {
        vm.prank(agent);
        treasury.pause();
        bytes32 u = _queue(_loosen(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0, 402));
        vm.prank(agent);
        treasury.pause();
        assertEq(treasury.queuedLoosen(u).status, HogeeKinds.LOOSEN_STATUS_QUEUED);
        vm.warp(block.timestamp + TIMELOCK);
        treasury.executeLoosen(u);
        assertFalse(treasury.paused());
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _raiseAds(uint256 nonce) internal view returns (LoosenRequest memory) {
        return _loosen(HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, L_ADS, 0, 30_000, nonce);
    }

    function _expectQueueRevert(LoosenRequest memory r, Sig memory f, Sig memory l, bytes4 err) internal {
        vm.prank(relayer);
        vm.expectRevert(err);
        treasury.queueLoosen(r, f, l);
    }

    function _expectKindRevert(uint8 kind) internal {
        LoosenRequest memory r = _loosen(kind, L_ADS, 0, 1, 700 + kind);
        (Sig memory f, Sig memory l) = (_signLoosen(founderPk, r), _signLoosen(lenderPk, r));
        vm.expectRevert(
            abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, HogeeKinds.CONST_MALFORMED_PLAN)
        );
        treasury.queueLoosen(r, f, l);
    }
}
