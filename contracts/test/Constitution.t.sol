// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PlanApproval, Line, Stage, Sig, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// §8.3 constitution: one test per PlanInvariantViolated code, the precedence rule (13, 12, then lowest 1-10),
/// the exact boundaries, and T21 (the founder signs an AI-drafted malicious plan; commitPlan still reverts).
contract ConstitutionTest is HogeeTestBase {
    function setUp() public override {
        super.setUp();
        _openFacility();
        _registerFounder();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Boundaries that must pass
    // ---------------------------------------------------------------------------------------------------------

    /// The Rina caps sit exactly at 25 % / 50 %, stage 1 exactly at 40 %; add the other exact limits.
    function test_Constitution_ExactLimitsPass() public {
        Line[] memory lines = _lines();
        lines[0].validUntil = T0 + 90 * DAY; // == now + 90 days
        PlanApproval memory a = _approvalFor(lines, _stages());
        a.agentExpiry = T0 + 90 * DAY;
        a.reserveBps = 300; // == floor
        _commit(a, lines, _stages());
        assertEq(registry.planVersion(), 1);
    }

    function test_Constitution_AgentExpiryOneSecondAfterJudgingWindowPasses() public {
        PlanApproval memory a = _rinaApproval();
        a.agentExpiry = JUDGING_END + 1;
        _commit(a, _lines(), _stages());
        assertEq(registry.currentPlan().agentExpiry, JUDGING_END + 1);
    }

    function test_Constitution_SixteenLinesPass() public {
        (Line[] memory lines, Stage[] memory stages) = _evenPlan(16);
        _commit(_approvalFor(lines, stages), lines, stages);
        assertEq(registry.lineIds().length, 16);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Code 13: malformed
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_PlanInvariantViolated_13_noLines() public {
        _expectCode(_approvalFor(new Line[](0), _stages()), new Line[](0), _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_seventeenLines() public {
        (Line[] memory lines, Stage[] memory stages) = _evenPlan(17);
        _expectCode(_approvalFor(lines, stages), lines, stages, 13);
    }

    function test_Revert_PlanInvariantViolated_13_noStages() public {
        _expectCode(_approvalFor(_lines(), new Stage[](0)), _lines(), new Stage[](0), 13);
    }

    function test_Revert_PlanInvariantViolated_13_nineStages() public {
        Stage[] memory stages = new Stage[](9);
        stages[0] = Stage("s0", 200_000, 0, 0, 0);
        for (uint256 i = 1; i < 9; ++i) {
            stages[i] = Stage(bytes32(i), 100_000, 1, 1, T0 + 30 * DAY);
        }
        _expectCode(_approvalFor(_lines(), stages), _lines(), stages, 13);
    }

    function test_Revert_PlanInvariantViolated_13_zeroTotal() public {
        PlanApproval memory a = _rinaApproval();
        a.totalMinor = 0;
        _expectCode(a, _lines(), _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_zeroAgent() public {
        PlanApproval memory a = _rinaApproval();
        a.agent = address(0);
        _expectCode(a, _lines(), _stages(), 13);
    }

    /// Role separation: an agent key that is also the founder's EOA could sign owner structs alone.
    function test_Revert_PlanInvariantViolated_13_agentIsFounderEoa() public {
        PlanApproval memory a = _rinaApproval();
        a.agent = founder;
        _expectCode(a, _lines(), _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_agentIsLender() public {
        PlanApproval memory a = _rinaApproval();
        a.agent = lender;
        _expectCode(a, _lines(), _stages(), 13);
    }

    /// Run-2 audit: an agent key that is also the oracle could failSettlement its own spends, refund the counters and
    /// spend past its allocation, the released stage and the funding.
    function test_Revert_PlanInvariantViolated_13_agentIsOracle() public {
        PlanApproval memory a = _rinaApproval();
        a.agent = oracle;
        _expectCode(a, _lines(), _stages(), 13);
    }

    /// Audit run-3: an agent key that is also the observer keeps the cancelLoosen veto after TIGHTEN_REVOKE_AGENT, so a
    /// revoked agent could cancel every co-signed UNPAUSE.
    function test_Revert_PlanInvariantViolated_13_agentIsObserver() public {
        PlanApproval memory a = _rinaApproval();
        a.agent = observer;
        _expectCode(a, _lines(), _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_reserveOver100Pct() public {
        PlanApproval memory a = _rinaApproval();
        a.reserveBps = 10_001;
        _expectCode(a, _lines(), _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_zeroLineId() public {
        Line[] memory lines = _lines();
        lines[1].lineId = bytes32(0);
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_duplicateLineId() public {
        Line[] memory lines = _lines();
        lines[5].lineId = L_PACKAGING;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_zeroWindowSeconds() public {
        Line[] memory lines = _lines();
        lines[2].windowSeconds = 0;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_ninePayeesOnALine() public {
        Line[] memory lines = _lines();
        bytes32[] memory payees = new bytes32[](9);
        for (uint256 i; i < 9; ++i) {
            payees[i] = bytes32(i + 1);
        }
        lines[1].payeeIds = payees;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_zeroPayeeId() public {
        Line[] memory lines = _lines();
        lines[3].payeeIds[0] = bytes32(0);
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_duplicatePayeeOnALine() public {
        Line[] memory lines = _lines();
        bytes32[] memory payees = new bytes32[](2);
        (payees[0], payees[1]) = (P_ADS, P_ADS);
        lines[3].payeeIds = payees;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 13);
    }

    function test_Revert_PlanInvariantViolated_13_zeroStageId() public {
        Stage[] memory stages = _stages();
        stages[1].stageId = bytes32(0);
        _expectCode(_approvalFor(_lines(), stages), _lines(), stages, 13);
    }

    function test_Revert_PlanInvariantViolated_13_duplicateStageId() public {
        Stage[] memory stages = _stages();
        stages[1].stageId = stages[0].stageId;
        _expectCode(_approvalFor(_lines(), stages), _lines(), stages, 13);
    }

    function test_Revert_PlanInvariantViolated_13_stage0HasAMetric() public {
        Stage[] memory stages = _stages();
        stages[0].metric = HogeeKinds.METRIC_SALES_MINOR;
        _expectCode(_approvalFor(_lines(), stages), _lines(), stages, 13);
    }

    function test_Revert_PlanInvariantViolated_13_laterStageWithoutMetric() public {
        Stage[] memory stages = _stages();
        stages[1].metric = HogeeKinds.METRIC_NONE;
        _expectCode(_approvalFor(_lines(), stages), _lines(), stages, 13);
    }

    function test_Revert_PlanInvariantViolated_13_unknownMetric() public {
        Stage[] memory stages = _stages();
        stages[1].metric = 3;
        _expectCode(_approvalFor(_lines(), stages), _lines(), stages, 13);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Code 12: totals
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_PlanInvariantViolated_12_linesDoNotSumToTotal() public {
        Line[] memory lines = _lines();
        lines[5].amountMinor -= 1;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 12);
    }

    function test_Revert_PlanInvariantViolated_12_stagesDoNotSumToTotal() public {
        Stage[] memory stages = _stages();
        stages[1].releaseMinor += 1;
        _expectCode(_approvalFor(_lines(), stages), _lines(), stages, 12);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Codes 1-10
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_PlanInvariantViolated_1_linesExceedFacilityCap() public {
        vm.prank(lender);
        treasury.openFacility(999_999, 300);
        _expectCode(_rinaApproval(), _lines(), _stages(), 1);
    }

    function test_Revert_PlanInvariantViolated_1_facilityNeverOpened() public {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        _registerFounder();
        _expectCode(_rinaApproval(), _lines(), _stages(), 1);
    }

    function test_Revert_PlanInvariantViolated_2_agentExpiryOver90Days() public {
        PlanApproval memory a = _rinaApproval();
        a.agentExpiry = T0 + 90 * DAY + 1;
        _expectCode(a, _lines(), _stages(), 2);
    }

    function test_Revert_PlanInvariantViolated_3_agentExpiryInsideJudgingWindow() public {
        PlanApproval memory a = _rinaApproval();
        a.agentExpiry = JUDGING_END;
        _expectCode(a, _lines(), _stages(), 3);
    }

    function test_Revert_PlanInvariantViolated_4_perTxCapOver25Pct() public {
        Line[] memory lines = _lines();
        lines[1].perTxCapMinor = lines[1].amountMinor / 4 + 1;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 4);
    }

    function test_Revert_PlanInvariantViolated_5_windowCapOver50Pct() public {
        Line[] memory lines = _lines();
        lines[2].windowCapMinor = lines[2].amountMinor / 2 + 1;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 5);
    }

    function test_Revert_PlanInvariantViolated_6_lineValidOver90Days() public {
        Line[] memory lines = _lines();
        lines[4].validUntil = T0 + 90 * DAY + 1;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 6);
    }

    function test_Revert_PlanInvariantViolated_7_reserveBelowFloor() public {
        PlanApproval memory a = _rinaApproval();
        a.reserveBps = 299;
        _expectCode(a, _lines(), _stages(), 7);
    }

    function test_Revert_PlanInvariantViolated_8_stage1Over40Pct() public {
        Stage[] memory stages = _stages();
        stages[0].releaseMinor += 1;
        stages[1].releaseMinor -= 1;
        _expectCode(_approvalFor(_lines(), stages), _lines(), stages, 8);
    }

    function test_Revert_PlanInvariantViolated_9_planAddsUnknownPayee() public {
        Line[] memory lines = _lines();
        lines[1].payeeIds = _single("printer-kl"); // not bound, not a platform payee
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 9);
    }

    /// A payee bound to SUPPLIER (escrow) cannot be moved to a direct-pay line by a new plan.
    function test_Revert_PlanInvariantViolated_9_supplierPayeeOnAnotherLine() public {
        _commit(_rinaApproval(), _lines(), _stages());
        _bindSupplier(_supplier());
        assertTrue(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).bound);
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_CONTINGENCY)].payeeIds = _single(SUPPLIER_A);
        _expectCode(_approvalV2(lines, _stages()), lines, _stages(), 9);
    }

    function test_CommitPlan_V2_MayListAPayeeBoundToThatLine() public {
        _commit(_rinaApproval(), _lines(), _stages());
        _bindSupplier(_supplier());
        Line[] memory lines = _lines();
        lines[0].payeeIds = _single(SUPPLIER_A);
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        assertEq(registry.line(L_SUPPLIER).payeeIds[0], SUPPLIER_A);
    }

    function test_Revert_PlanInvariantViolated_10_supplierLineNotEscrow() public {
        Line[] memory lines = _lines();
        lines[0].escrowOnly = false;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 10);
    }

    // ---------------------------------------------------------------------------------------------------------
    // T21 and precedence
    // ---------------------------------------------------------------------------------------------------------

    /// T21: "reserve 0, extra payee, perTxCap = line", validly signed by the founder. Lowest code wins: 4.
    function test_T21_FounderSignedMaliciousPlanReverts() public {
        Line[] memory lines = _lines();
        uint256 ads = _lineIndex(lines, L_ADS);
        lines[ads].perTxCapMinor = lines[ads].amountMinor;
        bytes32[] memory payees = new bytes32[](2);
        (payees[0], payees[1]) = (P_ADS, "0xevil-agency");
        lines[ads].payeeIds = payees;
        PlanApproval memory a = _approvalFor(lines, _stages());
        a.reserveBps = 0;
        _expectCode(a, lines, _stages(), HogeeKinds.CONST_PER_TX_CAP_OVER_25PCT);
    }

    function test_T21_ReserveZeroAlone() public {
        PlanApproval memory a = _rinaApproval();
        a.reserveBps = 0;
        _expectCode(a, _lines(), _stages(), HogeeKinds.CONST_RESERVE_BELOW_FLOOR);
    }

    function test_T21_ExtraPayeeAlone() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].payeeIds = _single("0xevil-agency");
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), HogeeKinds.CONST_PLAN_ADDS_PAYEE);
    }

    function test_T21_PerTxCapEqualsLineAlone() public {
        Line[] memory lines = _lines();
        lines[3].perTxCapMinor = lines[3].amountMinor;
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), HogeeKinds.CONST_PER_TX_CAP_OVER_25PCT);
    }

    function test_Precedence_MalformedBeatsTotalsBeatsRules() public {
        Line[] memory lines = _lines();
        lines[5].amountMinor -= 1; // 12
        lines[1].perTxCapMinor = lines[1].amountMinor; // 4
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 12);
        lines[2].windowSeconds = 0; // 13
        _expectCode(_approvalFor(lines, _stages()), lines, _stages(), 13);
    }

    function test_Precedence_LowestRuleCodeWins() public {
        Line[] memory lines = _lines();
        lines[0].escrowOnly = false; // 10
        lines[4].validUntil = T0 + 91 * DAY; // 6
        PlanApproval memory a = _approvalFor(lines, _stages());
        a.reserveBps = 100; // 7
        _expectCode(a, lines, _stages(), 6);
    }

    /// A failed commit leaves no state behind: the nonce is unused and no plan exists.
    function test_RevertedCommitLeavesNoState() public {
        PlanApproval memory a = _rinaApproval();
        a.reserveBps = 0;
        _expectCode(a, _lines(), _stages(), 7);
        assertFalse(registry.isNonceUsed(a.nonce));
        assertEq(registry.planVersion(), 0);
        assertEq(treasury.releasedMinor(), 0);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _expectCode(PlanApproval memory a, Line[] memory lines, Stage[] memory stages, uint8 code) private {
        Sig memory sig = _signPlan(a);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, code));
        registry.commitPlan(a, lines, stages, sig);
    }

    /// n lines splitting 1,000,000 evenly (the last absorbs the remainder), caps at the limits, no payees.
    function _evenPlan(uint256 n) private pure returns (Line[] memory lines, Stage[] memory stages) {
        lines = new Line[](n);
        uint128 each = uint128(1_000_000 / n);
        for (uint256 i; i < n; ++i) {
            uint128 amount = i == n - 1 ? uint128(1_000_000 - each * (n - 1)) : each;
            lines[i] = Line(
                bytes32(uint256(i + 1)),
                amount,
                amount / 4,
                amount / 2,
                WINDOW,
                T0 + 60 * DAY,
                0,
                false,
                new bytes32[](0)
            );
        }
        stages = _stages();
    }

    function _single(bytes32 id) private pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }
}
