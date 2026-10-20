// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Line, Stage, Sig, OwnerSpend, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {TreasuryHarness} from "./utils/TreasuryHarness.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// Treasury.ownerSpend, the founder's manual fallback (NFRA 二十六; §8.4, G0 H4/H5): enforces the founder signature,
/// escrowOnly, the payee (bound, listed by the current version, cooled), duplicates, line balance, payee cap,
/// releasedMinor and funded BU, and validUntil; skips the agent checks, perTx/window caps and every pause. Plus the
/// reserve lock on spend (T8, demo task 11). One test per revert row of the require table.
contract TreasuryOwnerSpendTest is HogeeTestBase {
    bytes32 internal constant TOOLMAKER = "toolmaker-kl";

    function setUp() public override {
        super.setUp();
        _setUpRina();
    }

    // ---------------------------------------------------------------------------------------------------------
    // ownerSpend
    // ---------------------------------------------------------------------------------------------------------

    /// 30,000 is above LOGISTICS's 20,000 per-tx cap: the owner's fallback skips the agent's caps.
    function test_OwnerSpend_PaysAndEmitsOwnerSpent() public {
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 30_000, _invoice(1));
        bytes32 id = HogeeTypes.intentId(PLAN_ID, L_LOGISTICS, P_LOGISTICS, _invoice(1), 30_000);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.OwnerSpent(id, L_LOGISTICS, P_LOGISTICS, 30_000, _invoice(1), 1);
        vm.prank(relayer);
        bytes32 spendId = treasury.ownerSpend(r, _signOwnerSpend(founderPk, r));

        assertEq(spendId, id);
        assertTrue(treasury.isIntentUsed(id));
        assertTrue(treasury.isInvoicePaid(_invoice(1)));
        assertEq(treasury.pocket(L_LOGISTICS).spentMinor, 30_000);
        assertEq(treasury.payeeBinding(L_LOGISTICS, P_LOGISTICS).paidMinor, 30_000);
        assertEq(treasury.balances().spentMinor, 30_000);
        assertEq(treasury.rollingSpent(L_LOGISTICS), 0); // not an agent spend: the agent's window is untouched
        assertEq(treasury.settlementState(id), HogeeKinds.SETTLEMENT_NONE);
        assertTrue(treasury.isNonceUsed(r.nonce));
    }

    /// §8.8: pause never blocks the owner's manual fallback (treasury pause, line pause, open circuit).
    function test_OwnerSpend_IgnoresEveryPause() public {
        vm.startPrank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_PAUSE_LINE, L_LOGISTICS, 0, "d");
        for (uint256 i = 1; i <= 3; ++i) {
            treasury.recordDenied(L_LOGISTICS, bytes32(i), "CAP_EXCEEDED", bytes32(i));
        }
        treasury.pause();
        vm.stopPrank();
        _ownerPay(L_LOGISTICS, P_LOGISTICS, 10_000, _invoice(1), 6);
        assertEq(treasury.pocket(L_LOGISTICS).spentMinor, 10_000);
    }

    /// Two owner spends above the 40,000 window cap; and the agent key's revocation does not matter.
    function test_OwnerSpend_IgnoresTheWindowCapAndTheAgentState() public {
        vm.prank(founder);
        treasury.tighten(HogeeKinds.TIGHTEN_REVOKE_AGENT, 0, 0, 0);
        _ownerPay(L_LOGISTICS, P_LOGISTICS, 30_000, _invoice(1), 6);
        _ownerPay(L_LOGISTICS, P_LOGISTICS, 30_000, _invoice(2), 7);
        assertEq(treasury.pocket(L_LOGISTICS).spentMinor, 60_000);
    }

    /// On a pacing line the owner pays the next slot, which the agent can then not pay again.
    function test_OwnerSpend_PacingLineConsumesTheSlot() public {
        _ownerPay(L_ADS, P_ADS, 7_500, bytes32(uint256(1)), 6);
        assertEq(treasury.lineSequence(L_ADS), 2);
        vm.prank(agent); // a different amount, so not the same intent: the slot itself is spent
        vm.expectRevert(IHogeeErrors.DuplicateInvoice.selector);
        treasury.spend(L_ADS, P_ADS, 7_000, bytes32(uint256(1)), 1, "d", "r");
    }

    /// M8: a failed owner payout refunds the line pocket like an agent spend.
    function test_OwnerSpend_FailedSettlementRefundsThePocket() public {
        bytes32 id = _ownerPay(L_LOGISTICS, P_LOGISTICS, 30_000, _invoice(1), 6);
        vm.prank(oracle);
        treasury.failSettlement(id, "INVALID_DESTINATION");
        assertEq(treasury.pocket(L_LOGISTICS).spentMinor, 0);
        assertEq(treasury.payeeBinding(L_LOGISTICS, P_LOGISTICS).paidMinor, 0);
        assertTrue(treasury.isInvoicePaid(_invoice(1)));
    }

    // ---- envelope and signature ----

    function test_Revert_InvalidSignature_ownerSpend_otherDeployment() public {
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1));
        r.deploymentId = "loop-1";
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.InvalidSignature.selector);
    }

    function test_Revert_SignatureExpired_ownerSpend() public {
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1));
        Sig memory sig = _signOwnerSpend(founderPk, r);
        vm.warp(r.expiry + 1);
        _expectOwnerRevert(r, sig, IHogeeErrors.SignatureExpired.selector);
    }

    function test_Revert_InvalidSignature_ownerSpend_nonceReused() public {
        _ownerPay(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1), 6);
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1, _invoice(2)); // nonce 6 again
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.InvalidSignature.selector);
    }

    /// T2/T6: the agent signs an owner spend itself.
    function test_Revert_NotOwner_ownerSpend_signedByAgent() public {
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(agentPk, r), IHogeeErrors.NotOwner.selector);
    }

    function test_Revert_NotOwner_ownerSpend_signedByLender() public {
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(lenderPk, r), IHogeeErrors.NotOwner.selector);
    }

    function test_Revert_InvalidSignature_ownerSpend_strangerSigner() public {
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1));
        _expectOwnerRevert(
            r, _signOwnerSpend(uint256(keccak256("stranger")), r), IHogeeErrors.InvalidSignature.selector
        );
    }

    // ---- lines and payees ----

    /// The reserve is not a line: only a lender-co-signed WITHDRAW_RESERVE after the timelock moves it.
    function test_Revert_ReserveLocked_ownerSpend_reserve() public {
        OwnerSpend memory r = _os("RESERVE", P_LOGISTICS, 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.ReserveLocked.selector);
    }

    /// §8.3: the supplier line pays only through escrow milestones (G0-DECISIONS §1 #5).
    function test_Revert_EscrowOnly_ownerSpend_supplierLine() public {
        OwnerSpend memory r = _os(L_SUPPLIER, SUPPLIER_A, 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.EscrowOnly.selector);
    }

    function test_Revert_LineExpired_ownerSpend_lineNotInPlan() public {
        OwnerSpend memory r = _os("LICENSING", P_LOGISTICS, 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.LineExpired.selector);
    }

    function test_Revert_LineExpired_ownerSpend_afterValidUntil() public {
        Line[] memory lines = _lines();
        lines[2].validUntil = T0 + 10 * DAY;
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        vm.warp(T0 + 10 * DAY + 1);
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.LineExpired.selector);
    }

    /// T1: "pay 0xEvil" even with the founder's signature on the request.
    function test_Revert_PayeeNotBound_ownerSpend_unboundPayee() public {
        OwnerSpend memory r = _os(L_LOGISTICS, "0xevil", 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.PayeeNotBound.selector);
    }

    /// Bindings are per line: SPX is a LOGISTICS payee, not a PACKAGING one.
    function test_Revert_PayeeNotBound_ownerSpend_payeeOfAnotherLine() public {
        OwnerSpend memory r = _os(L_PACKAGING, P_LOGISTICS, 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.PayeeNotBound.selector);
    }

    /// Run-2 audit: a payee the current version no longer lists is not payable, by the owner either.
    function test_Revert_PayeeNotBound_ownerSpend_droppedByReplan() public {
        Line[] memory lines = _lines();
        lines[2].payeeIds = new bytes32[](0);
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.PayeeNotBound.selector);
    }

    /// T3: a newly added payee cannot be paid inside its veto window (ADD_PAYEE stand-in: the test harness).
    function test_Revert_PayeeCooling_ownerSpend_newPayee() public {
        TreasuryHarness h = _harnessWithToolmaker(30_000);
        OwnerSpend memory r = _os(L_CONTINGENCY, TOOLMAKER, 1, _invoice(1));
        Sig memory sig = _signOwnerSpend(founderPk, r);
        vm.expectRevert(IHogeeErrors.PayeeCooling.selector);
        h.ownerSpend(r, sig);
    }

    // ---- duplicates ----

    function test_Revert_DuplicateIntent_ownerSpend_sameIntent() public {
        _ownerPay(L_LOGISTICS, P_LOGISTICS, 1_000, _invoice(1), 6);
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 1_000, _invoice(1));
        r.nonce = 7;
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.DuplicateIntent.selector);
    }

    /// T17 across paths: an invoice the agent already paid cannot be paid again by the owner.
    function test_Revert_DuplicateInvoice_ownerSpend_invoicePaidByTheAgent() public {
        _spend(L_LOGISTICS, P_LOGISTICS, 1_000, _invoice(1));
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 2_000, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.DuplicateInvoice.selector);
    }

    function test_Revert_DuplicateInvoice_ownerSpend_pacingSlotAlreadyPaid() public {
        _spendAds(1, 7_500);
        OwnerSpend memory r = _os(L_ADS, P_ADS, 7_000, bytes32(uint256(1)));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.DuplicateInvoice.selector);
    }

    function test_Revert_CapExceeded_ownerSpend_pacingSlotAhead() public {
        OwnerSpend memory r = _os(L_ADS, P_ADS, 7_500, bytes32(uint256(2)));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    function test_Revert_CapExceeded_ownerSpend_pacingAmountAboveTheSlot() public {
        OwnerSpend memory r = _os(L_ADS, P_ADS, 7_501, bytes32(uint256(1)));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    // ---- amounts ----

    function test_Revert_CapExceeded_ownerSpend_zeroAmount() public {
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 0, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    function test_Revert_CapExceeded_ownerSpend_aboveTheLineBalance() public {
        _ownerPay(L_LOGISTICS, P_LOGISTICS, 60_000, _invoice(1), 6);
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 20_001, _invoice(2));
        r.nonce = 7;
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    function test_Revert_CapExceeded_ownerSpend_aboveThePayeeLifetimeCap() public {
        TreasuryHarness h = _harnessWithToolmaker(30_000);
        vm.warp(block.timestamp + COOLING);
        OwnerSpend memory r = _os(L_CONTINGENCY, TOOLMAKER, 30_001, _invoice(1));
        Sig memory sig = _signOwnerSpend(founderPk, r);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        h.ownerSpend(r, sig);
    }

    /// Stage stop-loss: a plan whose stage 1 releases 100,000; the owner cannot pay past it.
    function test_Revert_CapExceeded_ownerSpend_aboveReleasedMinor() public {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        _openFacility();
        _registerFounder();
        Stage[] memory stages = _stages();
        (stages[0].releaseMinor, stages[1].releaseMinor) = (100_000, 900_000);
        _commit(_approvalFor(_lines(), stages), _lines(), stages);
        vm.prank(lender);
        treasury.fund(1_000_000);
        _ownerPay(L_LOGISTICS, P_LOGISTICS, 80_000, _invoice(1), 6);
        OwnerSpend memory r = _os(L_FEES, P_FEES, 20_001, _invoice(2));
        r.nonce = 7;
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    function test_Revert_CapExceeded_ownerSpend_aboveFunded() public {
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
        vm.prank(lender);
        treasury.fund(10_000);
        OwnerSpend memory r = _os(L_LOGISTICS, P_LOGISTICS, 10_001, _invoice(1));
        _expectOwnerRevert(r, _signOwnerSpend(founderPk, r), IHogeeErrors.CapExceeded.selector);
    }

    // ---------------------------------------------------------------------------------------------------------
    // spend: the reserve is locked (T8, demo task 11)
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_ReserveLocked_spend_agentSpendsTheReserve() public {
        _recordSale(1, 100_000); // 5,000 skimmed into the reserve
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.ReserveLocked.selector);
        treasury.spend("RESERVE", "lhdn-tax", 5_000, _invoice(1), 1, "d", "r");
        assertEq(treasury.reserve(), 5_000);
    }

    /// The reserve row comes after the agent gate: a stranger still gets NotAgent.
    function test_Revert_NotAgent_spend_reserveByStranger() public {
        vm.prank(stranger);
        vm.expectRevert(IHogeeErrors.NotAgent.selector);
        treasury.spend("RESERVE", "lhdn-tax", 5_000, _invoice(1), 1, "d", "r");
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _os(bytes32 lineId, bytes32 payeeId, uint128 amount, bytes32 invoiceHash)
        internal
        view
        returns (OwnerSpend memory r)
    {
        r = _ownerSpend();
        (r.lineId, r.payeeId, r.amountMinor, r.invoiceHash) = (lineId, payeeId, amount, invoiceHash);
        r.expiry = uint64(block.timestamp) + DAY;
    }

    function _ownerPay(bytes32 lineId, bytes32 payeeId, uint128 amount, bytes32 invoiceHash, uint256 nonce)
        internal
        returns (bytes32)
    {
        OwnerSpend memory r = _os(lineId, payeeId, amount, invoiceHash);
        r.nonce = nonce;
        vm.prank(relayer);
        return treasury.ownerSpend(r, _signOwnerSpend(founderPk, r));
    }

    function _expectOwnerRevert(OwnerSpend memory r, Sig memory sig, bytes4 err) internal {
        vm.prank(relayer);
        vm.expectRevert(err);
        treasury.ownerSpend(r, sig);
    }

    /// The harness pair with Rina committed and funded, and a toolmaker bound to CONTINGENCY with a lifetime cap.
    function _harnessWithToolmaker(uint128 cap) internal returns (TreasuryHarness h) {
        h = _deployHarness();
        _setUpRina();
        h.harnessAddPayee(L_CONTINGENCY, TOOLMAKER, cap);
    }
}
