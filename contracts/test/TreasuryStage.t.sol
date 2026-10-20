// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Line, Stage, Sig, StageRelease, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// Treasury.releaseStage (§8.2 LENDER approves stage gates, §26.2 stage 2: salesMinor >= 200,000 within 30 days).
/// Lender-signed StageRelease + the on-chain gate; releasedMinor rises only through _raiseReleased. One test per
/// revert row of the require table (T23: stage unlock without the officer -> NotLender).
contract TreasuryStageTest is HogeeTestBase {
    function setUp() public override {
        super.setUp();
        _setUpRina();
    }

    function test_ReleaseStage_GateMetReleasesStage2() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.StageReleased("stage-2", 600_000, 1_000_000);
        vm.prank(relayer);
        treasury.releaseStage(r, _signStage(lenderPk, r));
        assertEq(treasury.releasedMinor(), 1_000_000);
        (, bool released) = registry.stage("stage-2");
        assertTrue(released);
        assertTrue(treasury.isNonceUsed(r.nonce));
    }

    /// The lender's decision is not blocked by a pause (pause stops agent outflow, not the stage ledger).
    function test_ReleaseStage_WorksWhilePaused() public {
        vm.prank(agent);
        treasury.pause();
        _releaseStage2();
        assertEq(treasury.releasedMinor(), 1_000_000);
    }

    /// METRIC_ORDERS counts recorded sales (a zero-amount bucket is still an order).
    function test_ReleaseStage_OrdersMetricCountsSales() public {
        _commitOrdersPlan(3);
        _recordSale(1, 10);
        _recordSale(2, 0);
        StageRelease memory r = _stage2();
        bytes memory capExceeded = abi.encodeWithSelector(IHogeeErrors.CapExceeded.selector);
        Sig memory sig = _signStage(lenderPk, r);
        vm.expectRevert(capExceeded);
        treasury.releaseStage(r, sig);
        _recordSale(3, 10);
        treasury.releaseStage(r, sig);
        assertEq(treasury.releasedMinor(), 1_000_000);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Reverts: envelope and signature (ENV rows, lender variant)
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_InvalidSignature_releaseStage_otherDeployment() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        r.deploymentId = "loop-1";
        _expectStageRevert(r, _signStage(lenderPk, r), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_SignatureExpired_releaseStage() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        Sig memory sig = _signStage(lenderPk, r);
        vm.warp(r.expiry + 1);
        _expectStageRevert(r, sig, IHogeeErrors.SignatureExpired.selector);
    }

    function test_Revert_InvalidSignature_releaseStage_nonceReused() public {
        _releaseStage2();
        StageRelease memory r = _stage2(); // same nonce 5
        _expectStageRevert(r, _signStage(lenderPk, r), IHogeeErrors.InvalidSignature.selector);
    }

    /// T23: the agent signs the stage release itself.
    function test_Revert_NotLender_releaseStage_signedByAgent() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        _expectStageRevert(r, _signStage(agentPk, r), IHogeeErrors.NotLender.selector);
    }

    /// The founder cannot release a stage alone either (the lender approves stage gates, §8.2).
    function test_Revert_NotLender_releaseStage_signedByFounder() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        _expectStageRevert(r, _signStage(founderPk, r), IHogeeErrors.NotLender.selector);
    }

    function test_Revert_InvalidSignature_releaseStage_strangerSigner() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        _expectStageRevert(r, _signStage(uint256(keccak256("stranger")), r), IHogeeErrors.InvalidSignature.selector);
    }

    /// The lender is an ECDSA key: a WebAuthn-kind signature never verifies.
    function test_Revert_InvalidSignature_releaseStage_webauthnKind() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        Sig memory sig = _signStage(lenderPk, r);
        sig.kind = HogeeKinds.SIG_WEBAUTHN;
        _expectStageRevert(r, sig, IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_releaseStage_tamperedAmount() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        Sig memory sig = _signStage(lenderPk, r);
        r.amountMinor = 600_001;
        _expectStageRevert(r, sig, IHogeeErrors.InvalidSignature.selector);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Reverts: stage and gate (CapExceeded is the stage stop-loss error, as in _raiseReleased)
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_CapExceeded_releaseStage_gateNotMet() public {
        _recordSale(1, 199_999);
        StageRelease memory r = _stage2();
        _expectStageRevert(r, _signStage(lenderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    /// "within 30 days": the gate is read at release time and the deadline (T0 + 30 days) is inclusive.
    function test_Revert_CapExceeded_releaseStage_afterTheDeadline() public {
        _recordSale(1, 200_000);
        vm.warp(T0 + 30 * DAY + 1);
        StageRelease memory r = _stage2();
        _expectStageRevert(r, _signStage(lenderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    function test_ReleaseStage_AtTheDeadline() public {
        _recordSale(1, 200_000);
        vm.warp(T0 + 30 * DAY);
        _releaseStage2();
        assertEq(treasury.releasedMinor(), 1_000_000);
    }

    /// The signed amount must equal the stage's releaseMinor.
    function test_Revert_CapExceeded_releaseStage_amountMismatch() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        r.amountMinor = 599_999;
        _expectStageRevert(r, _signStage(lenderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    function test_Revert_CapExceeded_releaseStage_unknownStage() public {
        _recordSale(1, 200_000);
        StageRelease memory r = _stage2();
        r.stageId = "stage-3";
        _expectStageRevert(r, _signStage(lenderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    /// Stage 0 was released at the first commit (METRIC_NONE has no gate to meet).
    function test_Revert_CapExceeded_releaseStage_stage0() public {
        StageRelease memory r = _stage2();
        (r.stageId, r.amountMinor) = ("stage-1", 400_000);
        _expectStageRevert(r, _signStage(lenderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    function test_Revert_CapExceeded_releaseStage_twice() public {
        _releaseStage2();
        StageRelease memory r = _stage2();
        r.nonce = 55;
        _expectStageRevert(r, _signStage(lenderPk, r), IHogeeErrors.CapExceeded.selector);
        assertEq(treasury.releasedMinor(), 1_000_000);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _expectStageRevert(StageRelease memory r, Sig memory sig, bytes4 err) internal {
        vm.prank(relayer);
        vm.expectRevert(err);
        treasury.releaseStage(r, sig);
    }

    /// A fresh deployment whose stage 2 is gated on `orders` recorded sales instead of sales value.
    function _commitOrdersPlan(uint128 orders) internal {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        (sales, escrow) = (lastSales, lastEscrow);
        _openFacility();
        _registerFounder();
        Line[] memory lines = _lines();
        Stage[] memory stages = _stages();
        (stages[1].metric, stages[1].target) = (HogeeKinds.METRIC_ORDERS, orders);
        _commit(_approvalFor(lines, stages), lines, stages);
    }
}
