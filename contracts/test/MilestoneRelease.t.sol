// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    Balances,
    Milestone,
    MilestoneRelease,
    Pocket,
    SupplierApproval,
    Sig,
    HogeeKinds
} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// MilestoneEscrow.releaseMilestone (§8.1, §26.2 supplier A balance): a non-auto milestone is released only by the
/// founder's MilestoneRelease signature with the inspection evidence hash; the agent alone gets MilestoneLocked (T5,
/// demo task 8); the 70 % balance releases after stage 2 (demo task 12). Settlement of milestone releases (M8).
contract MilestoneReleaseTest is HogeeTestBase {
    bytes32 internal constant SID_BALANCE = keccak256(abi.encode(ORDER_A, uint8(2)));

    function setUp() public override {
        super.setUp();
        _setUpSupplierA();
    }

    // ---------------------------------------------------------------------------------------------------------
    // releaseMilestone
    // ---------------------------------------------------------------------------------------------------------

    /// Demo task 12: inspection evidence + Rina's signature release the 280,000 balance.
    function test_ReleaseMilestone_FounderReleasesTheBalance() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        vm.expectEmit(address(escrow));
        emit IHogeeEvents.MilestoneReleased(ORDER_A, 2, SUPPLIER_A, 280_000, r.evidenceHash, SID_BALANCE);
        vm.prank(relayer);
        escrow.releaseMilestone(r, _signRelease(founderPk, r));

        Milestone memory m = escrow.milestones(ORDER_A)[2];
        assertTrue(m.released);
        assertEq(m.evidenceHash, r.evidenceHash);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 430_000);
        assertTrue(escrow.isNonceUsed(r.nonce));
        assertEq(SID_BALANCE, HogeeTypes.milestoneSettlementId(ORDER_A, 2));
    }

    /// G0-DECISIONS §1 #5 / §8.8: the founder's manual takeover is not blocked by a pause.
    function test_ReleaseMilestone_WorksWhilePaused() public {
        _fundBalanceA();
        vm.prank(agent);
        treasury.pause();
        MilestoneRelease memory r = _release2();
        escrow.releaseMilestone(r, _signRelease(founderPk, r));
        assertTrue(escrow.milestones(ORDER_A)[2].released);
    }

    /// An order without inspection needs no evidence hash (a second order for supplier A: one 10,000 milestone).
    function test_ReleaseMilestone_NoEvidenceNeededWithoutInspection() public {
        uint128[] memory schedule = new uint128[](1);
        bool[] memory autoRelease = new bool[](1);
        schedule[0] = 10_000;
        SupplierApproval memory a = _supplier();
        (a.orderId, a.nonce, a.inspectionRequired) = ("order-a-002", 78, false);
        (a.scheduleHash, a.totalMinor) = (HogeeTypes.scheduleHash(schedule, autoRelease), 10_000);
        treasury.bindPayee(a, schedule, autoRelease, _signSupplier(a));
        vm.warp(block.timestamp + COOLING); // a re-bind restarts cooling (T3)
        _fundOrder("order-a-002", 0, 10_000);
        MilestoneRelease memory r = _release2();
        (r.orderId, r.idx, r.amountMinor, r.evidenceHash) = ("order-a-002", 0, 10_000, 0);
        escrow.releaseMilestone(r, _signRelease(founderPk, r));
        assertTrue(escrow.milestones("order-a-002")[0].released);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).lifetimeCapMinor, 440_000);
    }

    /// Audit run-3 (v-5): a re-bind restarts the supplier's cooling and replaces its payout account. A fully funded
    /// milestone of an earlier order must not release inside that window: its settlement would pay the new, unvetted
    /// account of record. Treasury.escrowRelease, the sink of both release paths, refuses it with PayeeCooling.
    function test_ReleaseMilestone_EarlierOrderDuringRebindCooling() public {
        _fundBalanceA();
        SupplierApproval memory a = _supplier();
        (a.orderId, a.nonce, a.payoutAccountHash) = ("order-a-002", 78, keccak256("new bank account"));
        _bindSupplier(a);
        MilestoneRelease memory r = _release2();
        Sig memory sig = _signRelease(founderPk, r);

        vm.prank(relayer);
        vm.expectRevert(IHogeeErrors.PayeeCooling.selector);
        escrow.releaseMilestone(r, sig);
        assertFalse(escrow.milestones(ORDER_A)[2].released);
        assertEq(treasury.settlementState(SID_BALANCE), HogeeKinds.SETTLEMENT_NONE);
        assertFalse(treasury.isIntentUsed(SID_BALANCE));

        vm.warp(block.timestamp + COOLING); // the veto window is over: the same signed release now goes through
        vm.prank(relayer);
        escrow.releaseMilestone(r, sig);
        assertTrue(escrow.milestones(ORDER_A)[2].released);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).payoutAccountHash, keccak256("new bank account"));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Reverts, in require-table order
    // ---------------------------------------------------------------------------------------------------------

    /// T5 / demo task 8: the agent key submits a release, even one carrying a valid founder signature.
    function test_Revert_MilestoneLocked_releaseMilestone_agentCaller() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        Sig memory sig = _signRelease(founderPk, r);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MilestoneLocked.selector);
        escrow.releaseMilestone(r, sig);
    }

    /// Demo task 8 as staged: the agent tries to release the balance with no founder signature at all.
    function test_Revert_MilestoneLocked_releaseMilestone_agentWithoutSignature() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MilestoneLocked.selector);
        escrow.releaseMilestone(_release2(), Sig(0, ""));
    }

    function test_Revert_InvalidSignature_releaseMilestone_otherDeployment() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        r.deploymentId = "loop-1";
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_SignatureExpired_releaseMilestone() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        Sig memory sig = _signRelease(founderPk, r);
        vm.warp(r.expiry + 1);
        _expectReleaseRevert(r, sig, IHogeeErrors.SignatureExpired.selector);
    }

    function test_Revert_InvalidSignature_releaseMilestone_nonceReused() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        escrow.releaseMilestone(r, _signRelease(founderPk, r));
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.InvalidSignature.selector);
    }

    /// A relayer submits a release the agent signed (ENV-4: a known non-owner signer).
    function test_Revert_NotOwner_releaseMilestone_signedByAgent() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        _expectReleaseRevert(r, _signRelease(agentPk, r), IHogeeErrors.NotOwner.selector);
    }

    function test_Revert_NotOwner_releaseMilestone_signedByLender() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        _expectReleaseRevert(r, _signRelease(lenderPk, r), IHogeeErrors.NotOwner.selector);
    }

    /// The MilestoneRelease verifying contract is the escrow: a signature over Treasury's domain does not verify.
    function test_Revert_InvalidSignature_releaseMilestone_signedForTheTreasuryDomain() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        Sig memory sig = _ecdsa(founderPk, _treasuryDigest(HogeeTypes.hashMilestoneRelease(r)));
        _expectReleaseRevert(r, sig, IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_PayeeNotBound_releaseMilestone_unknownOrder() public {
        MilestoneRelease memory r = _release2();
        r.orderId = "order-x";
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.PayeeNotBound.selector);
    }

    function test_Revert_PayeeNotBound_releaseMilestone_idxOutOfRange() public {
        MilestoneRelease memory r = _release2();
        r.idx = 3;
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.PayeeNotBound.selector);
    }

    /// Before stage 2 the balance cannot be funded, so even the founder's signature finds it locked.
    function test_Revert_MilestoneLocked_releaseMilestone_balanceNotFullyFunded() public {
        _fund(0, 30_000);
        _fund(1, 120_000);
        MilestoneRelease memory r = _release2();
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.MilestoneLocked.selector);
    }

    /// autoRelease milestones release on funding, never by signature.
    function test_Revert_MilestoneLocked_releaseMilestone_autoReleaseMilestone() public {
        MilestoneRelease memory r = _release2();
        (r.idx, r.amountMinor) = (0, 30_000);
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.MilestoneLocked.selector);
    }

    function test_Revert_MilestoneLocked_releaseMilestone_alreadyReleased() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        escrow.releaseMilestone(r, _signRelease(founderPk, r));
        r.nonce = 33;
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.MilestoneLocked.selector);
    }

    function test_Revert_AmountExceedsSchedule_releaseMilestone_amountDiffersFromTheSchedule() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        r.amountMinor = 280_001;
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.AmountExceedsSchedule.selector);
    }

    function test_Revert_EvidenceMissing_releaseMilestone_inspectionRequired() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        r.evidenceHash = 0;
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.EvidenceMissing.selector);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Settlement of milestone releases (settlementId = keccak256(abi.encode(orderId, idx)))
    // ---------------------------------------------------------------------------------------------------------

    function test_ConfirmSettlement_MilestoneRelease() public {
        _fund(0, 30_000);
        bytes32 sid = HogeeTypes.milestoneSettlementId(ORDER_A, 0);
        vm.prank(oracle);
        treasury.confirmSettlement(sid, keccak256("xendit-payout-ref"));
        assertEq(treasury.settlementState(sid), HogeeKinds.SETTLEMENT_CONFIRMED);
    }

    /// M8, re-check M-1: a failed payout of a founder-released milestone returns its BU to the supplier line (line and
    /// total escrowed fall by the amount, payee paid too), so pocket, escrow and outflow headroom read exactly as before
    /// the milestone was funded. The milestone stays released and dead: it never releases or funds again.
    function test_FailSettlement_NonAutoMilestone_ReturnsTheAmountToTheLine() public {
        _fund(0, 30_000);
        _fund(1, 120_000);
        _releaseStage2();
        Ledger memory before = _ledger();
        _fund(2, 280_000);
        MilestoneRelease memory r = _release2();
        escrow.releaseMilestone(r, _signRelease(founderPk, r));
        assertEq(treasury.pocket(L_SUPPLIER).escrowedMinor, before.lineEscrowed + 280_000);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.SettlementFailed(SID_BALANCE, "INVALID_DESTINATION");
        vm.prank(oracle);
        treasury.failSettlement(SID_BALANCE, "INVALID_DESTINATION");

        _assertLedger(before);
        assertEq(treasury.settlementState(SID_BALANCE), HogeeKinds.SETTLEMENT_FAILED);
        Milestone memory m = escrow.milestones(ORDER_A)[2];
        assertTrue(m.released);
        assertEq(m.fundedMinor, 280_000);
        _expectFundRevert(ORDER_A, 2, IHogeeErrors.AmountExceedsSchedule.selector);
    }

    /// Re-check M-1: the failed milestone stays released, so a second founder release is refused before Treasury
    /// (MilestoneLocked), and its settlementId stays closed for good.
    function test_Revert_MilestoneLocked_releaseMilestone_afterAFailedSettlement() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        escrow.releaseMilestone(r, _signRelease(founderPk, r));
        vm.prank(oracle);
        treasury.failSettlement(SID_BALANCE, "INVALID_DESTINATION");
        r.nonce = 34;
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.MilestoneLocked.selector);
        assertTrue(treasury.isIntentUsed(SID_BALANCE));
    }

    /// Re-check M-1: a failed autoRelease payout returns its BU to the line too; the milestone stays released and
    /// fully funded, so it can be neither re-funded (AmountExceedsSchedule) nor signed out (MilestoneLocked).
    function test_FailSettlement_AutoMilestone_ReturnsTheAmountToTheLine() public {
        Ledger memory before = _ledger();
        _fund(0, 30_000); // autoRelease: released on funding
        bytes32 sid = HogeeTypes.milestoneSettlementId(ORDER_A, 0);
        vm.prank(oracle);
        treasury.failSettlement(sid, "INVALID_DESTINATION");

        _assertLedger(before);
        assertTrue(escrow.milestones(ORDER_A)[0].released);
        _expectFundRevert(ORDER_A, 0, IHogeeErrors.AmountExceedsSchedule.selector);
        MilestoneRelease memory r = _release2();
        (r.idx, r.amountMinor) = (0, 30_000);
        _expectReleaseRevert(r, _signRelease(founderPk, r), IHogeeErrors.MilestoneLocked.selector);
    }

    /// Re-check M-1: to pay the supplier again after a failed payout (e.g. a phished account the oracle vetoed), the
    /// founder signs a new SupplierApproval: a new order, funded from the BU the failure returned to the line. Before
    /// the fix those BU stayed escrowed for good and this funding exceeded the line (CapExceeded).
    function test_FailSettlement_NewOrderToTheSameSupplierPaysFromTheReturnedBalance() public {
        _fundBalanceA();
        MilestoneRelease memory r = _release2();
        escrow.releaseMilestone(r, _signRelease(founderPk, r));
        vm.prank(oracle);
        treasury.failSettlement(SID_BALANCE, "INVALID_DESTINATION");

        uint128[] memory schedule = new uint128[](1);
        bool[] memory autoRelease = new bool[](1);
        (schedule[0], autoRelease[0]) = (280_000, true);
        SupplierApproval memory a = _supplier();
        (a.orderId, a.nonce, a.payoutAccountHash) = ("order-a-002", 78, keccak256("corrected bank account"));
        (a.scheduleHash, a.totalMinor) = (HogeeTypes.scheduleHash(schedule, autoRelease), 280_000);
        treasury.bindPayee(a, schedule, autoRelease, _signSupplier(a));
        vm.warp(block.timestamp + COOLING); // the re-bind restarts cooling (T3)
        _fundOrder("order-a-002", 0, 280_000); // autoRelease: released on funding

        assertTrue(escrow.milestones("order-a-002")[0].released);
        assertEq(treasury.pocket(L_SUPPLIER).escrowedMinor, 430_000);
        assertEq(treasury.balances().escrowedMinor, 430_000);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 430_000);
        bytes32 sid = HogeeTypes.milestoneSettlementId("order-a-002", 0);
        vm.prank(oracle);
        treasury.confirmSettlement(sid, keccak256("xendit-payout-ref"));
        assertEq(treasury.settlementState(sid), HogeeKinds.SETTLEMENT_CONFIRMED);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    /// The supplier line's pocket, the global escrow and outflow headroom, and supplier A's paid amount.
    struct Ledger {
        uint128 lineAvailable;
        uint128 lineEscrowed;
        uint128 totalEscrowed;
        uint128 totalSpent;
        uint128 paid;
    }

    function _ledger() internal view returns (Ledger memory l) {
        Pocket memory p = treasury.pocket(L_SUPPLIER);
        Balances memory b = treasury.balances();
        (l.lineAvailable, l.lineEscrowed, l.totalEscrowed, l.totalSpent) =
        (p.availableMinor, p.escrowedMinor, b.escrowedMinor, b.spentMinor);
        l.paid = treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor;
    }

    function _assertLedger(Ledger memory want) internal view {
        Ledger memory got = _ledger();
        assertEq(got.lineAvailable, want.lineAvailable, "line available");
        assertEq(got.lineEscrowed, want.lineEscrowed, "line escrowed");
        assertEq(got.totalEscrowed, want.totalEscrowed, "total escrowed");
        assertEq(got.totalSpent, want.totalSpent, "total spent");
        assertEq(got.paid, want.paid, "payee paid");
    }

    function _expectReleaseRevert(MilestoneRelease memory r, Sig memory sig, bytes4 err) internal {
        vm.prank(relayer);
        vm.expectRevert(err);
        escrow.releaseMilestone(r, sig);
    }

    function _expectFundRevert(bytes32 orderId, uint8 idx, bytes4 err) internal {
        vm.prank(agent);
        vm.expectRevert(err);
        escrow.fundMilestone(orderId, idx, 1, "d", "r");
    }

    function _fundOrder(bytes32 orderId, uint8 idx, uint128 amount) internal {
        vm.prank(agent);
        escrow.fundMilestone(orderId, idx, amount, "d", "r");
    }
}
