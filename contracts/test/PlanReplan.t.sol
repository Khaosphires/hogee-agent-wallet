// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PlanApproval, Line, Stage, Sig, Pocket, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";
import {TreasuryHarness} from "./utils/TreasuryHarness.sol";

/// G0 audit v-1 (IPlanRegistry.commitPlan NatSpec, project.md §8.3, §8.9 "Replan"): versions are sequential, and
/// once a plan exists a founder-only re-commit may only tighten the current on-chain state, else
/// PlanInvariantViolated(CONST_REPLAN_LOOSENS). A re-commit never resets runtime state or raises releasedMinor.
contract PlanReplanTest is HogeeTestBase {
    bytes32 internal constant TOOLMAKER = "tool-maker";

    function setUp() public override {
        super.setUp();
        _setUpRina();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Sequencing (StalePlan)
    // ---------------------------------------------------------------------------------------------------------

    /// A re-signed version 1 cannot dodge the replan rule: it is stale before the constitution runs.
    function test_Revert_StalePlan_commit_resignedV1ThatLoosens() public {
        PlanApproval memory a = _rinaApproval();
        (a.nonce, a.reserveBps, a.agent) = (77, 300, makeAddr("agent-2"));
        _expectStale(a, _lines(), _stages());
    }

    function test_Revert_StalePlan_commit_skipsAVersion() public {
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.version = 3;
        _expectStale(a, _lines(), _stages());
    }

    function test_Revert_StalePlan_commit_v2Again() public {
        _commit(_approvalV2(_lines(), _stages()), _lines(), _stages());
        PlanApproval memory a = _approvalV2(_lines(), _stages()); // version 2 again, fresh nonce
        a.nonce = 103;
        _expectStale(a, _lines(), _stages());
    }

    function test_Revert_StalePlan_commit_recommitWithWrongPrevPlanHash() public {
        PlanApproval memory a = _approvalV2(_lines(), _stages()); // tighten-only otherwise
        a.prevPlanHash = keccak256("hogee/test/plan-v0");
        _expectStale(a, _lines(), _stages());
    }

    /// Sequencing is decided before the constitution (TS mirror commitPlanOutcome): a stale approval that also
    /// breaks code 4 reverts StalePlan.
    function test_Revert_StalePlan_commit_beforeConstitutionCodes() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_ADS)].perTxCapMinor = 30_001; // code 4
        PlanApproval memory a = _approvalFor(lines, _stages()); // version 1 again
        a.nonce = 78;
        _expectStale(a, lines, _stages());
        a = _approvalV2(lines, _stages());
        a.version = 3; // skipped version
        _expectStale(a, lines, _stages());
    }

    function test_Revert_StalePlan_commit_firstCommitWithPrevPlanHash() public {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        a.prevPlanHash = keccak256("a plan that never existed");
        _expectStale(a, _lines(), _stages());
    }

    // ---------------------------------------------------------------------------------------------------------
    // REPLAN_LOOSENS (code 14): one test per loosening
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_PlanInvariantViolated_14_raisesPerTxCap() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].perTxCapMinor = 10_000;
        _freshV1(lines);
        lines[_lineIndex(lines, L_LOGISTICS)].perTxCapMinor = 10_001; // still <= 25 % (code 4 passes)
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_raisesWindowCap() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].windowCapMinor = 30_000;
        _freshV1(lines);
        lines[_lineIndex(lines, L_LOGISTICS)].windowCapMinor = 30_001;
        _expectLoosens(lines, _stages());
    }

    /// The comparison is with the current on-chain state, so restating the v1 cap undoes a tightening.
    function test_Revert_PlanInvariantViolated_14_undoesATightenedCap() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP, L_ADS, 40_000, "d");
        _expectLoosens(_lines(), _stages()); // signs the v1 window cap 60,000
    }

    function test_Revert_PlanInvariantViolated_14_movesPocketAmounts() public {
        Line[] memory lines = _lines();
        Line memory c = lines[_lineIndex(lines, L_CONTINGENCY)];
        (c.amountMinor, c.perTxCapMinor, c.windowCapMinor) = (90_000, 22_500, 45_000); // caps tightened to fit
        lines[_lineIndex(lines, L_ADS)].amountMinor = 130_000; // caps unchanged, totals still match
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_changesTotal() public {
        Line[] memory lines = _lines();
        Line memory c = lines[_lineIndex(lines, L_CONTINGENCY)];
        (c.amountMinor, c.perTxCapMinor, c.windowCapMinor) = (0, 0, 0);
        Stage[] memory stages = _stages();
        (stages[0].releaseMinor, stages[1].releaseMinor) = (360_000, 540_000);
        PlanApproval memory a = _approvalV2(lines, stages);
        a.totalMinor = 900_000;
        _expectLoosens(a, lines, stages);
    }

    function test_Revert_PlanInvariantViolated_14_lowersReserveBps() public {
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.reserveBps = 400; // still >= the 300 floor (code 7 passes)
        _expectLoosens(a, _lines(), _stages());
    }

    function test_Revert_PlanInvariantViolated_14_undoesARaisedReserve() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 700, "d");
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.reserveBps = 600;
        _expectLoosens(a, _lines(), _stages());
    }

    function test_Revert_PlanInvariantViolated_14_changesTheAgent() public {
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.agent = makeAddr("agent-2");
        _expectLoosens(a, _lines(), _stages());
    }

    function test_Revert_PlanInvariantViolated_14_extendsAgentExpiry() public {
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.agentExpiry += 1;
        _expectLoosens(a, _lines(), _stages());
    }

    function test_Revert_PlanInvariantViolated_14_extendsLineValidUntil() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].validUntil += 1;
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_shortensTheWindow() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].windowSeconds = WINDOW - 1;
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_setsPacingToZero() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_ADS)].pacingMinor = 0; // would turn ADS into an invoice line
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_raisesPacing() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_ADS)].pacingMinor = 7_501;
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_makesAnInvoiceLinePacing() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].pacingMinor = 1;
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_clearsEscrowOnly() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_CONTINGENCY)].escrowOnly = true;
        _freshV1(lines);
        lines[_lineIndex(lines, L_CONTINGENCY)].escrowOnly = false;
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_changesAStageTarget() public {
        Stage[] memory stages = _stages();
        stages[1].target = 150_000; // an easier stage-2 gate
        _expectLoosens(_lines(), stages);
    }

    function test_Revert_PlanInvariantViolated_14_movesStageAmounts() public {
        Stage[] memory stages = _stages();
        (stages[0].releaseMinor, stages[1].releaseMinor) = (300_000, 700_000);
        _expectLoosens(_lines(), stages);
    }

    function test_Revert_PlanInvariantViolated_14_changesCountryPackHash() public {
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.countryPackHash = keccak256("hogee/test/country-pack-ID");
        _expectLoosens(a, _lines(), _stages());
    }

    function test_Revert_PlanInvariantViolated_14_dropsALine() public {
        Line[] memory all = _lines();
        Line[] memory lines = new Line[](5);
        uint256 j;
        for (uint256 i; i < all.length; ++i) {
            if (all[i].lineId == L_LOGISTICS) {
                all[i + 1].amountMinor += all[i].amountMinor; // fold into ADS so totals still match
                continue;
            }
            lines[j++] = all[i];
        }
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_addsALine() public {
        Line[] memory all = _lines();
        Line[] memory lines = new Line[](7);
        for (uint256 i; i < all.length; ++i) {
            lines[i] = all[i];
        }
        lines[6] = Line("LICENSING", 0, 0, 0, WINDOW, T0 + 60 * DAY, 0, false, new bytes32[](0));
        _expectLoosens(lines, _stages());
    }

    function test_Revert_PlanInvariantViolated_14_replacesALine() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_CONTINGENCY)].lineId = "BUFFER"; // same count, same amounts, new id
        _expectLoosens(lines, _stages());
    }

    /// A platform payee passes code 9 (static registry) but is not one of the line's current payees.
    function test_Revert_PlanInvariantViolated_14_addsAPayee() public {
        Line[] memory lines = _lines();
        bytes32[] memory payees = new bytes32[](2);
        (payees[0], payees[1]) = (P_ADS, P_FEES);
        lines[_lineIndex(lines, L_ADS)].payeeIds = payees;
        _expectLoosens(lines, _stages());
    }

    /// Codes 1-13 are checked first.
    function test_Revert_PlanInvariantViolated_4_beforeReplanRule() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_ADS)].perTxCapMinor = 30_001; // loosens and breaks the 25 % rule
        PlanApproval memory a = _approvalV2(lines, _stages());
        Sig memory sig = _signPlan(a);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 4));
        registry.commitPlan(a, lines, _stages(), sig);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Tighten-only re-commits
    // ---------------------------------------------------------------------------------------------------------

    function test_Recommit_IdenticalPlanCommits() public {
        _commit(_approvalV2(_lines(), _stages()), _lines(), _stages());
        assertEq(registry.planVersion(), 2);
        assertEq(registry.currentPlan().planHash, keccak256("hogee/test/plan-v2"));
    }

    /// §8.9 "Replan": a tighten-only v2 commits and leaves releasedMinor, window spend, pauses, circuits and every
    /// tightening unchanged.
    function test_Recommit_TightenOnly_KeepsRuntimeStateAndEveryTightening() public {
        bytes32 logSpend = _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        _spendAds(1, 7_500);
        vm.startPrank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_LOGISTICS, 15_000, "d");
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 600, "d");
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_PACKAGING, 0, "d");
        for (uint256 i; i < 3; ++i) {
            treasury.recordDenied(L_CONTINGENCY, _nextDecision(), "CAP_EXCEEDED", bytes32(i));
        }
        vm.stopPrank();
        vm.prank(lender);
        treasury.pause();
        uint128 logWindow = treasury.rollingSpent(L_LOGISTICS);

        Line[] memory lines = _lines();
        Line memory ads = lines[_lineIndex(lines, L_ADS)];
        (ads.perTxCapMinor, ads.windowCapMinor, ads.pacingMinor) = (20_000, 50_000, 7_000);
        ads.windowSeconds = WINDOW + uint32(DAY); // a longer window is tighter
        Line memory lg = lines[_lineIndex(lines, L_LOGISTICS)];
        (lg.perTxCapMinor, lg.validUntil) = (15_000, T0 + 50 * DAY); // keeps the agent's tightening
        PlanApproval memory a = _approvalV2(lines, _stages());
        (a.reserveBps, a.agentExpiry) = (600, T0 + 55 * DAY);
        _commit(a, lines, _stages());

        assertEq(registry.planVersion(), 2);
        assertEq(treasury.releasedMinor(), 400_000, "releasedMinor");
        (, bool r1) = registry.stage("stage-1");
        (, bool r2) = registry.stage("stage-2");
        assertTrue(r1);
        assertFalse(r2);
        // the new tightenings apply
        Pocket memory p = treasury.pocket(L_ADS);
        (uint128 perTx, uint128 cap, uint128 pacing, uint32 w) =
            (p.perTxCapMinor, p.windowCapMinor, p.pacingMinor, p.windowSeconds);
        assertEq(perTx, 20_000);
        assertEq(cap, 50_000);
        assertEq(pacing, 7_000);
        assertEq(w, WINDOW + DAY);
        assertEq(registry.currentPlan().reserveBps, 600);
        assertEq(treasury.agentExpiry(), T0 + 55 * DAY);
        // runtime state carries over
        p = treasury.pocket(L_LOGISTICS);
        assertEq(p.perTxCapMinor, 15_000);
        assertEq(p.validUntil, T0 + 50 * DAY);
        assertEq(p.spentMinor, 20_000);
        assertEq(treasury.rollingSpent(L_LOGISTICS), logWindow);
        assertEq(treasury.rollingSpent(L_ADS), 7_500);
        assertEq(treasury.lineSequence(L_ADS), 2);
        assertEq(treasury.payeeBinding(L_ADS, P_ADS).paidMinor, 7_500);
        assertTrue(treasury.isIntentUsed(logSpend));
        assertTrue(treasury.isInvoicePaid(_invoice(1)));
        assertTrue(treasury.pocket(L_PACKAGING).paused);
        assertTrue(treasury.pocket(L_CONTINGENCY).circuitOpen);
        assertTrue(treasury.paused());
        assertFalse(registry.currentPlan().agentRevoked);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CircuitOpen.selector); // the denial count survives too
        treasury.recordDenied(L_CONTINGENCY, _nextDecision(), "CAP_EXCEEDED", "x");
    }

    /// A longer window applies to the spends already in it: they count for the full new window (T22-style +-1 s).
    function test_Recommit_LongerWindowAppliesToEarlierSpends() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(1));
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(2)); // the 40,000 window cap is full
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].windowSeconds = WINDOW + uint32(DAY);
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        vm.warp(T0 + WINDOW + DAY - 1);
        assertEq(treasury.rollingSpent(L_LOGISTICS), 40_000);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(3), 2, "d", "r");
        vm.warp(T0 + WINDOW + DAY);
        assertEq(treasury.rollingSpent(L_LOGISTICS), 0);
        _spend(L_LOGISTICS, P_LOGISTICS, 20_000, _invoice(3));
    }

    function test_Recommit_KeepsTheAgentRevoked() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_REVOKE_AGENT, 0, 0, "d");
        _commit(_approvalV2(_lines(), _stages()), _lines(), _stages());
        assertTrue(registry.currentPlan().agentRevoked);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 2, "d", "r");
    }

    /// Same set of lineIds in another order: accepted, and the stored order is kept.
    function test_Recommit_ReorderedLinesKeepTheStoredOrder() public {
        Line[] memory lines = _lines();
        (lines[0], lines[5]) = (lines[5], lines[0]);
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        bytes32[] memory ids = registry.lineIds();
        assertEq(ids[0], L_SUPPLIER);
        assertEq(ids[5], L_CONTINGENCY);
        assertEq(registry.line(L_SUPPLIER).amountMinor, 500_000);
    }

    /// Making a line escrow-only is a tightening.
    function test_Recommit_MayMakeALineEscrowOnly() public {
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_LOGISTICS)].escrowOnly = true;
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.EscrowOnly.selector);
        treasury.spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 2, "d", "r");
    }

    /// Dropping a payee from a line is a tightening, and spend pays only payees the current version lists (run-2
    /// audit): the dropped payee is no longer payable, although its binding data (paid, cap, account) stays.
    function test_Revert_PayeeNotBound_spend_payeeDroppedByRecommit() public {
        _spendAds(1, 7_500);
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_ADS)].payeeIds = new bytes32[](0);
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        assertEq(registry.line(L_ADS).payeeIds.length, 0);
        assertTrue(treasury.payeeBinding(L_ADS, P_ADS).bound);
        assertEq(treasury.payeeBinding(L_ADS, P_ADS).paidMinor, 7_500);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeNotBound.selector);
        treasury.spend(L_ADS, P_ADS, 7_500, bytes32(uint256(2)), 2, "d", "r");
        _spend(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1)); // a payee v2 still lists stays payable
    }

    /// A payee added to the line since (1.8's ADD_PAYEE, via the harness) is payable only while the plan lists it:
    /// a re-commit that leaves it out drops it.
    function test_Revert_PayeeNotBound_spend_addedPayeeLeftOutByRecommit() public {
        TreasuryHarness h = _deployHarness();
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
        vm.prank(lender);
        treasury.fund(1_000_000);
        h.harnessAddPayee(L_CONTINGENCY, TOOLMAKER, 30_000);
        vm.warp(block.timestamp + COOLING);
        _spend(L_CONTINGENCY, TOOLMAKER, 1_000, _invoice(1));
        _commit(_approvalV2(_lines(), _stages()), _lines(), _stages()); // CONTINGENCY lists no payee
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeNotBound.selector);
        treasury.spend(L_CONTINGENCY, TOOLMAKER, 1_000, _invoice(2), 2, "d", "r");
    }

    /// A platform payee is a current payee only while the line lists it: once v2 drops it, re-listing it is an
    /// addition (its auto-binding from v1 is not a signed binding). Matches the 1.10 TS mirror.
    function test_Revert_PlanInvariantViolated_14_relistsADroppedPlatformPayee() public {
        Line[] memory lines = _lines();
        uint256 i = _lineIndex(lines, L_ADS);
        bytes32[] memory payees = lines[i].payeeIds;
        lines[i].payeeIds = new bytes32[](0);
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        lines[i].payeeIds = payees;
        PlanApproval memory a = _approvalV2(lines, _stages());
        (a.version, a.prevPlanHash, a.planHash, a.nonce) = (3, a.planHash, keccak256("hogee/test/plan-v3"), 103);
        _expectLoosens(a, lines, _stages());
    }

    /// A payee bound to the line by a signed approval since (here 1.8's ADD_PAYEE, via the harness) may be listed.
    function test_Recommit_MayListAPayeeAddedToTheLineSince() public {
        TreasuryHarness h = _deployHarness();
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
        h.harnessAddPayee(L_CONTINGENCY, TOOLMAKER, 30_000);
        Line[] memory lines = _lines();
        bytes32[] memory payees = new bytes32[](1);
        payees[0] = TOOLMAKER;
        lines[_lineIndex(lines, L_CONTINGENCY)].payeeIds = payees;
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        assertEq(registry.line(L_CONTINGENCY).payeeIds[0], TOOLMAKER);
        vm.prank(lender);
        treasury.fund(1_000_000);
        vm.warp(block.timestamp + COOLING);
        _spend(L_CONTINGENCY, TOOLMAKER, 1_000, _invoice(1)); // listed by v2: still payable
    }

    // ---------------------------------------------------------------------------------------------------------
    // releasedMinor (item c): stage 0 on the first commit only
    // ---------------------------------------------------------------------------------------------------------

    function test_ReleasedMinor_Stage0OnTheFirstCommitOnly() public {
        assertEq(treasury.releasedMinor(), 400_000);
        _commit(_approvalV2(_lines(), _stages()), _lines(), _stages());
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        (a.version, a.prevPlanHash, a.planHash, a.nonce) = (3, a.planHash, keccak256("hogee/test/plan-v3"), 103);
        _commit(a, _lines(), _stages());
        assertEq(treasury.releasedMinor(), 400_000);
        assertEq(treasury.balances().releasedMinor, 400_000);
        (Stage memory s1, bool r1) = registry.stage("stage-1");
        (, bool r2) = registry.stage("stage-2");
        assertEq(s1.releaseMinor, 400_000);
        assertTrue(r1);
        assertFalse(r2);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    /// Fresh deployment with `lines` as plan v1 (Rina stages), funded.
    function _freshV1(Line[] memory lines) internal {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        _openFacility();
        _registerFounder();
        _commit(_approvalFor(lines, _stages()), lines, _stages());
        vm.prank(lender);
        treasury.fund(1_000_000);
    }

    function _expectLoosens(Line[] memory lines, Stage[] memory stages) internal {
        _expectLoosens(_approvalV2(lines, stages), lines, stages);
    }

    function _expectLoosens(PlanApproval memory a, Line[] memory lines, Stage[] memory stages) internal {
        Sig memory sig = _signPlan(a);
        vm.expectRevert(
            abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, HogeeKinds.CONST_REPLAN_LOOSENS)
        );
        registry.commitPlan(a, lines, stages, sig);
    }

    function _expectStale(PlanApproval memory a, Line[] memory lines, Stage[] memory stages) internal {
        Sig memory sig = _signPlan(a);
        vm.expectRevert(IHogeeErrors.StalePlan.selector);
        registry.commitPlan(a, lines, stages, sig);
    }
}
