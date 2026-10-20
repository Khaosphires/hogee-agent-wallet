// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PlanApproval, PlanState, Line, Stage, Sig, PayeeBinding} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// PlanRegistry: founder key, signature envelope, compare-and-swap and the happy path. Constitution codes are in
/// Constitution.t.sol.
contract PlanRegistryTest is HogeeTestBase {
    /// HogeeTypes.t.sol golden: hashLines(RinaFixture._lines()).
    bytes32 private constant GOLDEN_LINES_HASH = 0xf107f98a529a7babf40d18450be14ad9a7d9be6c882bb6611b43de466b217b7f;
    // ---------------------------------------------------------------------------------------------------------
    // registerFounderKey
    // ---------------------------------------------------------------------------------------------------------

    function test_RegisterFounderKey_StoresKeyAndEmits() public {
        vm.expectEmit(address(registry));
        emit IHogeeEvents.FounderKeyRegistered(founder, bytes32(0), bytes32(0));
        _registerFounder();
        (bytes32 qx, bytes32 qy, address eoa) = registry.founderKey();
        assertEq(qx, bytes32(0));
        assertEq(qy, bytes32(0));
        assertEq(eoa, founder);
    }

    function test_RegisterFounderKey_PasskeyOnly() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(0xA11CE);
        vm.prank(lender);
        registry.registerFounderKey(bytes32(x), bytes32(y), address(0));
        (bytes32 qx,, address eoa) = registry.founderKey();
        assertEq(qx, bytes32(x));
        assertEq(eoa, address(0));
    }

    function test_Revert_NotLender_registerFounderKey() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotLender.selector);
        registry.registerFounderKey(bytes32(0), bytes32(0), agent);
    }

    function test_Revert_FounderKeyAlreadySet_secondRegistration() public {
        _registerFounder();
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.FounderKeyAlreadySet.selector);
        registry.registerFounderKey(bytes32(0), bytes32(0), lender); // H3: the lender cannot swap in its own key
    }

    function test_Revert_InvalidSignature_registerFounderKey_noUsableKey() public {
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        registry.registerFounderKey(bytes32(0), bytes32(0), address(0));
    }

    /// H3: the lender cannot make itself the founder's EOA on the one allowed registration.
    function test_Revert_InvalidSignature_registerFounderKey_lenderAsOwner() public {
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        registry.registerFounderKey(bytes32(0), bytes32(0), lender);
    }

    /// Run-2 audit: the oracle can never be the founder's EOA (role separation).
    function test_Revert_InvalidSignature_registerFounderKey_oracleAsOwner() public {
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        registry.registerFounderKey(bytes32(0), bytes32(0), oracle);
    }

    /// Audit run-3: the observer can never be the founder's EOA (its veto must stay a separate key).
    function test_Revert_InvalidSignature_registerFounderKey_observerAsOwner() public {
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        registry.registerFounderKey(bytes32(0), bytes32(0), observer);
    }

    function test_Revert_InvalidSignature_registerFounderKey_pointNotOnCurve() public {
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        registry.registerFounderKey(bytes32(uint256(1)), bytes32(uint256(2)), founder);
    }

    // ---------------------------------------------------------------------------------------------------------
    // commitPlan: happy path
    // ---------------------------------------------------------------------------------------------------------

    function test_CommitPlan_RinaV1_StoresPlanAndReleasesStage1() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        vm.expectEmit(address(registry));
        emit IHogeeEvents.PlanCommitted(
            a.planId,
            1,
            a.planHash,
            bytes32(0),
            a.countryPackHash,
            1_000_000,
            agent,
            a.agentExpiry,
            400_000,
            a.linesHash,
            a.stagesHash,
            500
        );
        registry.commitPlan(a, _lines(), _stages(), sig);

        assertEq(registry.planVersion(), 1);
        PlanState memory s = registry.currentPlan();
        assertEq(s.planId, PLAN_ID);
        assertEq(s.planHash, a.planHash);
        assertEq(s.countryPackHash, a.countryPackHash);
        assertEq(s.totalMinor, 1_000_000);
        assertEq(s.reserveBps, 500);
        assertEq(s.agent, agent);
        assertEq(s.agentExpiry, T0 + 60 * DAY);
        assertFalse(s.agentRevoked);
        assertEq(s.committedAt, T0);
        assertEq(treasury.releasedMinor(), 400_000);
        assertEq(treasury.agentExpiry(), T0 + 60 * DAY);
        assertTrue(registry.isNonceUsed(1));
    }

    function test_CommitPlan_ViewsReturnTheSignedLinesAndStages() public {
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());

        bytes32[] memory ids = registry.lineIds();
        assertEq(ids.length, 6);
        assertEq(ids[3], L_ADS);
        Line memory ads = registry.line(L_ADS);
        assertEq(ads.amountMinor, 120_000);
        assertEq(ads.perTxCapMinor, 30_000);
        assertEq(ads.pacingMinor, 7_500); // G0 decision §1 #1
        assertEq(ads.payeeIds.length, 1);
        assertEq(ads.payeeIds[0], P_ADS);
        assertEq(HogeeTypes.hashLines(_linesFromRegistry()), GOLDEN_LINES_HASH);

        (Stage memory s1, bool r1) = registry.stage("stage-1");
        (Stage memory s2, bool r2) = registry.stage("stage-2");
        assertEq(s1.releaseMinor, 400_000);
        assertTrue(r1);
        assertEq(s2.target, 200_000);
        assertFalse(r2);
        assertEq(registry.stageIds().length, 2);
        assertEq(registry.line("NOPE").lineId, bytes32(0));
    }

    function test_CommitPlan_BindsListedPlatformPayeesWithoutCooling() public {
        _openFacility();
        _registerFounder();
        (, bytes32[] memory hashes) = _platformPayees();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.PayeeBound(P_ADS, L_ADS, bytes32(0), T0, type(uint128).max, 0, 0, hashes[1]);
        registry.commitPlan(a, _lines(), _stages(), sig);
        PayeeBinding memory b = treasury.payeeBinding(L_ADS, P_ADS);
        assertTrue(b.bound);
        assertEq(b.coolingUntil, T0);
        assertEq(b.lifetimeCapMinor, type(uint128).max);
        assertEq(b.payoutAccountHash, hashes[1]);
        assertFalse(treasury.payeeBinding(L_PACKAGING, P_ADS).bound); // bound per line, not globally
    }

    function test_CommitPlan_AnyoneMaySubmit() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        vm.prank(stranger);
        registry.commitPlan(a, _lines(), _stages(), sig);
        assertEq(registry.planVersion(), 1);
    }

    function test_CommitPlan_V2_CompareAndSwap() public {
        _setUpRina();
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_ADS)].perTxCapMinor = 20_000;
        PlanApproval memory a = _approvalV2(lines, _stages());
        _commit(a, lines, _stages());
        assertEq(registry.planVersion(), 2);
        assertEq(registry.currentPlan().planHash, a.planHash);
        assertEq(treasury.pocket(L_ADS).perTxCapMinor, 20_000);
        assertEq(treasury.releasedMinor(), 400_000); // max(400k, stage 0 of v2), not additive
    }

    function test_CommitPlan_PassesWithKind1WebAuthnSignature() public {
        _openFacility();
        uint256 pk = 0xB0B;
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        vm.prank(lender);
        registry.registerFounderKey(bytes32(x), bytes32(y), founder);
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _webauthn(pk, _planDigest(a), 0x05, true);
        registry.commitPlan(a, _lines(), _stages(), sig);
        assertEq(registry.planVersion(), 1);
    }

    function test_CommitPlan_WebAuthnAcceptsStructEncodingWithOffsetWord() public {
        _openFacility();
        uint256 pk = 0xB0B;
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        vm.prank(lender);
        registry.registerFounderKey(bytes32(x), bytes32(y), founder);
        PlanApproval memory a = _rinaApproval();
        registry.commitPlan(a, _lines(), _stages(), _webauthn(pk, _planDigest(a), 0x05, false));
        assertEq(registry.planVersion(), 1);
    }

    // ---------------------------------------------------------------------------------------------------------
    // commitPlan: signature envelope (ENV-1..4), T16, T27, T28
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_InvalidSignature_commit_structForOtherDeployment() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        a.deploymentId = "loop-1";
        _expectCommitRevert(a, _signPlan(a), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_SignatureExpired_commit_afterExpiry() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        vm.warp(a.expiry + 1); // T16
        _expectCommitRevert(a, sig, IHogeeErrors.SignatureExpired.selector);
    }

    function test_CommitPlan_ValidAtExactExpiry() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        vm.warp(a.expiry);
        registry.commitPlan(a, _lines(), _stages(), sig);
        assertEq(registry.planVersion(), 1);
    }

    function test_Revert_InvalidSignature_commit_nonceReused() public {
        _setUpRina();
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.nonce = 1; // T16: v1 used nonce 1
        _expectCommitRevert(a, _signPlan(a), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_commit_replayedSameApproval() public {
        _setUpRina();
        PlanApproval memory a = _rinaApproval();
        _expectCommitRevert(a, _signPlan(a), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_commit_noFounderKey() public {
        _openFacility();
        PlanApproval memory a = _rinaApproval();
        _expectCommitRevert(a, _signPlan(a), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_commit_strangerSigned() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        (, uint256 pk) = makeAddrAndKey("mallory");
        _expectCommitRevert(a, _ecdsa(pk, _planDigest(a)), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_NotOwner_commit_signedByAgent() public {
        _setUpRina();
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        _expectCommitRevert(a, _ecdsa(agentPk, _planDigest(a)), IHogeeErrors.NotOwner.selector); // T6
    }

    function test_Revert_NotOwner_commit_signedByLender() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        _expectCommitRevert(a, _ecdsa(lenderPk, _planDigest(a)), IHogeeErrors.NotOwner.selector); // H3
    }

    function test_Revert_InvalidSignature_commit_malformedEcdsaLength() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        sig.data = bytes.concat(sig.data, hex"00");
        _expectCommitRevert(a, sig, IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_commit_unknownSigKind() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        sig.kind = 2;
        _expectCommitRevert(a, sig, IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_commit_webauthnForEcdsaOnlyOwner() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        _expectCommitRevert(a, _webauthn(0xB0B, _planDigest(a), 0x05, true), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_commit_webauthnWithoutUserVerification() public {
        _openFacility();
        uint256 pk = 0xB0B;
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        vm.prank(lender);
        registry.registerFounderKey(bytes32(x), bytes32(y), address(0));
        PlanApproval memory a = _rinaApproval();
        _expectCommitRevert(a, _webauthn(pk, _planDigest(a), 0x01, true), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_commit_webauthnOtherKey() public {
        _openFacility();
        (uint256 x, uint256 y) = vm.publicKeyP256(0xB0B);
        vm.prank(lender);
        registry.registerFounderKey(bytes32(x), bytes32(y), address(0));
        PlanApproval memory a = _rinaApproval();
        _expectCommitRevert(a, _webauthn(0xC0C, _planDigest(a), 0x05, true), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_InvalidSignature_commit_webauthnGarbage() public {
        _openFacility();
        (uint256 x, uint256 y) = vm.publicKeyP256(0xB0B);
        vm.prank(lender);
        registry.registerFounderKey(bytes32(x), bytes32(y), address(0));
        PlanApproval memory a = _rinaApproval();
        _expectCommitRevert(a, Sig({kind: 1, data: hex"1234"}), IHogeeErrors.InvalidSignature.selector);
    }

    /// T27: the relayer swaps the lines the founder signed.
    function test_Revert_InvalidSignature_commit_swappedLines() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        Line[] memory lines = _lines();
        lines[_lineIndex(lines, L_ADS)].payeeIds[0] = P_FEES;
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        registry.commitPlan(a, lines, _stages(), sig);
    }

    function test_Revert_InvalidSignature_commit_swappedStages() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _signPlan(a);
        Stage[] memory stages = _stages();
        stages[1].target = 1;
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        registry.commitPlan(a, _lines(), stages, sig);
    }

    /// T28: a signature made for another chainTag (same deploymentId) never verifies here.
    function test_Revert_InvalidSignature_commit_crossChainReplay() public {
        (PlanRegistry other,) = _deploy(DEPLOYMENT_ID, "fisco", false);
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        bytes32 foreign = HogeeTypes.digest(other.domainSeparator(), HogeeTypes.hashPlanApproval(a));
        _expectCommitRevert(a, _ecdsa(founderPk, foreign), IHogeeErrors.InvalidSignature.selector);
    }

    // ---------------------------------------------------------------------------------------------------------
    // commitPlan: compare-and-swap
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_StalePlan_commit_versionSkipsAhead() public {
        _openFacility();
        _registerFounder();
        PlanApproval memory a = _rinaApproval();
        a.version = 2;
        _expectCommitRevert(a, _signPlan(a), IHogeeErrors.StalePlan.selector);
    }

    function test_Revert_StalePlan_commit_wrongPrevPlanHash() public {
        _setUpRina();
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.prevPlanHash = keccak256("not the current plan");
        _expectCommitRevert(a, _signPlan(a), IHogeeErrors.StalePlan.selector);
    }

    function test_Revert_StalePlan_commit_secondV1() public {
        _setUpRina();
        PlanApproval memory a = _rinaApproval();
        a.nonce = 77; // a fresh signature for version 1 again
        _expectCommitRevert(a, _signPlan(a), IHogeeErrors.StalePlan.selector);
    }

    function test_Revert_StalePlan_commit_differentPlanId() public {
        _setUpRina();
        PlanApproval memory a = _approvalV2(_lines(), _stages());
        a.planId = keccak256("another plan");
        _expectCommitRevert(a, _signPlan(a), IHogeeErrors.StalePlan.selector);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Domain views and FISCO clock
    // ---------------------------------------------------------------------------------------------------------

    function test_DomainViews() public view {
        assertEq(registry.deploymentId(), DEPLOYMENT_ID);
        assertEq(registry.chainTag(), CHAIN_TAG);
        assertEq(registry.domainSeparator(), HogeeTypes.domainSeparator(address(registry), CHAIN_TAG, DEPLOYMENT_ID));
        assertEq(treasury.domainSeparator(), HogeeTypes.domainSeparator(address(treasury), CHAIN_TAG, DEPLOYMENT_ID));
        assertEq(treasury.deploymentId(), DEPLOYMENT_ID);
        assertEq(registry.lender(), lender);
        assertEq(registry.treasury(), address(treasury));
        assertEq(treasury.registry(), address(registry));
        assertFalse(registry.fiscoMs());
    }

    /// §8.8: on FISCO block.timestamp is in milliseconds; _now() divides by 1000.
    function test_FiscoClock_UsesMilliseconds() public {
        (PlanRegistry r, Treasury t) = _deploy(DEPLOYMENT_ID, "fisco", true);
        assertTrue(t.fiscoMs());
        vm.warp(uint256(T0) * 1000);
        vm.prank(lender);
        t.openFacility(1_000_000, 300);
        vm.prank(lender);
        r.registerFounderKey(bytes32(0), bytes32(0), founder);
        PlanApproval memory a = _rinaApproval();
        Sig memory sig = _ecdsa(founderPk, HogeeTypes.digest(r.domainSeparator(), HogeeTypes.hashPlanApproval(a)));
        r.commitPlan(a, _lines(), _stages(), sig);
        assertEq(r.currentPlan().committedAt, T0);
    }

    function test_CurrentPlan_EmptyBeforeFirstCommit() public view {
        PlanState memory s = registry.currentPlan();
        assertEq(s.version, 0);
        assertEq(s.agent, address(0));
        (Stage memory st, bool released) = registry.stage("stage-1");
        assertEq(st.stageId, bytes32(0));
        assertFalse(released);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _expectCommitRevert(PlanApproval memory a, Sig memory sig, bytes4 selector) private {
        Line[] memory lines = _lines();
        Stage[] memory stages = _stages();
        vm.expectRevert(selector);
        registry.commitPlan(a, lines, stages, sig);
    }

    function _linesFromRegistry() private view returns (Line[] memory lines) {
        bytes32[] memory ids = registry.lineIds();
        lines = new Line[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            lines[i] = registry.line(ids[i]);
        }
    }
}
