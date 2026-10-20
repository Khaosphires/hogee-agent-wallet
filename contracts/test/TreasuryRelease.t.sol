// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Stage} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";
import {TreasuryHarness} from "./utils/TreasuryHarness.sol";

/// Task 1.4 item (c): releasedMinor never exceeds what the stages allow. Treasury._raiseReleased is the only writer:
/// the stage must be in the plan and not yet released, and the total stays <= totalMinor. On loop-1 its only caller
/// is the first commit (stage 0); releaseStage is a reverting stub there (task 1.8), so the guard's other branches
/// are driven through the test-only harness.
contract TreasuryReleaseTest is HogeeTestBase {
    TreasuryHarness internal harness;

    function setUp() public override {
        super.setUp();
        harness = _deployHarness();
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
    }

    function test_RaiseReleased_FirstCommitReleasesStage0Only() public view {
        assertEq(treasury.releasedMinor(), 400_000);
        assertEq(_releasedStageTotal(), 400_000);
        assertTrue(treasury.isStageReleased("stage-1"));
        assertFalse(treasury.isStageReleased("stage-2"));
    }

    function test_Revert_CapExceeded_raiseReleased_stageAlreadyReleased() public {
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        harness.harnessRaiseReleased("stage-1");
    }

    function test_Revert_CapExceeded_raiseReleased_stageNotInThePlan() public {
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        harness.harnessRaiseReleased("stage-9");
    }

    function test_Revert_CapExceeded_raiseReleased_aboveThePlanTotal() public {
        harness.harnessAddStage("stage-x", 600_001); // 400,000 + 600,001 > 1,000,000
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        harness.harnessRaiseReleased("stage-x");
    }

    function test_Revert_CapExceeded_raiseReleased_beforeAnyPlan() public {
        harness = _deployHarness();
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        harness.harnessRaiseReleased("stage-1");
    }

    /// Releasing every stage reaches exactly totalMinor; nothing more can be released.
    function test_RaiseReleased_AllStagesReachExactlyTheTotal() public {
        harness.harnessRaiseReleased("stage-2");
        assertEq(treasury.releasedMinor(), 1_000_000);
        assertEq(_releasedStageTotal(), 1_000_000);
        (, bool released) = registry.stage("stage-2");
        assertTrue(released);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        harness.harnessRaiseReleased("stage-2");
    }

    /// Sum of releaseMinor over the stages PlanRegistry.stage() reports as released.
    function _releasedStageTotal() internal view returns (uint256 total) {
        bytes32[] memory ids = registry.stageIds();
        for (uint256 i; i < ids.length; ++i) {
            (Stage memory s, bool released) = registry.stage(ids[i]);
            if (released) total += s.releaseMinor;
        }
    }
}
