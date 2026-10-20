// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MilestoneRelease, Sig, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// project.md §19.1 scripted tasks 3-5, 8, 11 and 12 on the final-1 set, in demo order, each with the exact outcome
/// the script names (✅ or the revert). Every Sepolia hash in the demo comes from one of these calls.
contract DemoTasksTest is HogeeTestBase {
    function setUp() public override {
        super.setUp();
        _setUpRina(); // tasks 1-2: funded 10,000 BU, plan v1 committed (stage 1 = 400,000 released)
    }

    /// Task 3: Rina picks supplier A and signs the SupplierApproval; bindPayee starts the cooling period.
    function test_Task03_RinaSignsSupplierA_BindPayeeStartsCooling() public {
        uint64 coolingUntil = uint64(block.timestamp) + COOLING;
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.PayeeBound(
            SUPPLIER_A,
            L_SUPPLIER,
            ORDER_A,
            coolingUntil,
            430_000,
            SUPPLIER_A,
            _supplier().scheduleHash,
            _supplier().payoutAccountHash
        );
        _bindSupplier(_supplier()); // submitted by anyone (the relayer in the demo)
        assertTrue(escrow.order(ORDER_A).exists);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.PayeeCooling.selector); // inside the veto window
        escrow.fundMilestone(ORDER_A, 0, 30_000, "d", "r");
    }

    /// Task 4: the agent pays the sample; it releases at once and the payout references the release.
    function test_Task04_AgentPaysTheSample() public {
        _supplierCooled();
        bytes32 sid = HogeeTypes.milestoneSettlementId(ORDER_A, 0);
        vm.expectEmit(address(escrow));
        emit IHogeeEvents.MilestoneReleased(ORDER_A, 0, SUPPLIER_A, 30_000, 0, sid);
        _fund(0, 30_000);
        vm.prank(oracle); // Xendit payout done: the settlement adapter confirms it
        treasury.confirmSettlement(sid, keccak256("xendit-disbursement-sample"));
        assertEq(treasury.settlementState(sid), HogeeKinds.SETTLEMENT_CONFIRMED);
    }

    /// Task 5: the agent funds the deposit exactly as pre-signed; one minor unit more is refused.
    function test_Task05_AgentFundsTheDepositExactlyAsPresigned() public {
        _supplierCooled();
        _fund(0, 30_000);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.AmountExceedsSchedule.selector);
        escrow.fundMilestone(ORDER_A, 1, 120_001, "d", "r");
        _fund(1, 120_000);
        assertTrue(escrow.milestones(ORDER_A)[1].released);
        assertEq(treasury.balances().escrowedMinor, 150_000);
    }

    /// Task 8: the agent tries to release the escrow balance.
    function test_Task08_AgentReleasesTheEscrowBalance_MilestoneLocked() public {
        _supplierCooled();
        _fund(0, 30_000);
        _fund(1, 120_000);
        MilestoneRelease memory r = _release2();
        Sig memory sig = _signRelease(agentPk, r);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MilestoneLocked.selector);
        escrow.releaseMilestone(r, sig);
        assertFalse(escrow.milestones(ORDER_A)[2].released);
    }

    /// Task 11: a Stripe sale skims the reserve; the agent can neither record a sale nor spend the reserve.
    function test_Task11_SaleSkimsTheReserve_AgentRecordSaleAndReserveSpendRevert() public {
        vm.prank(oracle);
        sales.recordSale(keccak256("evt_demo_sale_1"), 100_000);
        assertEq(treasury.reserve(), 5_000);

        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotOracle.selector);
        sales.recordSale(keccak256("evt_forged"), 1_000_000);

        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.ReserveLocked.selector);
        treasury.spend("RESERVE", P_TAX, 5_000, _invoice(11), 1, "d", "r");
        assertEq(treasury.reserve(), 5_000);
    }

    /// Task 12: the agent lowers the ads cap; an early raise is refused; inspection evidence + Rina's signature release
    /// the 70 % balance; pause, and the next spend is refused.
    function test_Task12_TightenThenEarlyRaiseThenBalanceThenPause() public {
        vm.prank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, 20_000, "d-tighten");
        assertEq(treasury.pocket(L_ADS).perTxCapMinor, 20_000);

        bytes32 raise = _queue(_loosen(HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, L_ADS, 0, 30_000, 400));
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.executeLoosen(raise);

        _supplierCooled();
        _fundBalanceA(); // sample, deposit, sales 200,000 + the lender's stage-2 release, then the balance
        MilestoneRelease memory r = _release2();
        Sig memory sig = _signRelease(founderPk, r);
        vm.prank(relayer);
        escrow.releaseMilestone(r, sig);
        assertTrue(escrow.milestones(ORDER_A)[2].released);
        assertEq(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 430_000);

        vm.prank(founder);
        treasury.pause();
        bytes32 d = _nextDecision();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.Paused.selector);
        treasury.spend(L_ADS, P_ADS, 7_500, bytes32(uint256(1)), 1, d, d);
        assertEq(treasury.queuedLoosen(raise).status, HogeeKinds.LOOSEN_STATUS_CANCELLED); // §8.8
    }

    /// The scripted run end to end: tasks 3, 4, 5, 8, 11 and 12 in order on one deployment.
    function test_DemoRun_Tasks3To12InOrder() public {
        _bindSupplier(_supplier()); // 3
        vm.warp(block.timestamp + COOLING);
        _fund(0, 30_000); // 4
        _fund(1, 120_000); // 5
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.MilestoneLocked.selector); // 8
        escrow.releaseMilestone(_release2(), Sig(0, ""));
        _recordSale(1, 200_000); // 11: sale and skim
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotOracle.selector);
        sales.recordSale(keccak256("evt_forged"), 1);
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.ReserveLocked.selector);
        treasury.spend("RESERVE", P_TAX, 1, _invoice(11), 1, "d", "r");
        vm.prank(agent); // 12
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_ADS, 20_000, "d");
        bytes32 raise = _queue(_loosen(HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, L_ADS, 0, 30_000, 400));
        vm.expectRevert(IHogeeErrors.TimelockActive.selector);
        treasury.executeLoosen(raise);
        treasury.releaseStage(_stage2(), _signStage(lenderPk, _stage2()));
        _fund(2, 280_000);
        MilestoneRelease memory r = _release2();
        escrow.releaseMilestone(r, _signRelease(founderPk, r));
        vm.prank(agent);
        treasury.pause();
        bytes32 d = _nextDecision();
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.Paused.selector);
        treasury.spend(L_ADS, P_ADS, 7_500, bytes32(uint256(1)), 1, d, d);
        assertEq(treasury.releasedMinor(), 1_000_000);
        assertEq(treasury.reserve(), 10_000);
    }

    function _supplierCooled() internal {
        _bindSupplier(_supplier());
        vm.warp(block.timestamp + COOLING);
    }
}
