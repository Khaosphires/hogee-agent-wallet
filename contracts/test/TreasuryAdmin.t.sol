// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Sig, Facility, PayeeBinding, SupplierApproval} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// Treasury lender and founder-signed paths: openFacility, fund, bindPayee. One test per revert row of the require
/// table. tighten/pause/recordDenied/settlement/stubs: TreasuryControls.t.sol.
contract TreasuryAdminTest is HogeeTestBase {
    // ---------------------------------------------------------------------------------------------------------
    // openFacility
    // ---------------------------------------------------------------------------------------------------------

    function test_OpenFacility_StoresAndEmits() public {
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.FacilityOpened(lender, 1_000_000, 300);
        _openFacility();
        Facility memory f = treasury.facility();
        assertEq(f.capMinor, 1_000_000);
        assertEq(f.reserveFloorBps, 300);
        assertEq(f.fundedMinor, 0);
        assertTrue(f.opened);
    }

    function test_OpenFacility_LenderMayAdjustWithinThePlan() public {
        _setUpRina();
        vm.prank(lender);
        treasury.openFacility(2_000_000, 500);
        assertEq(treasury.facility().capMinor, 2_000_000);
    }

    function test_Revert_NotLender_openFacility() public {
        vm.prank(agent);
        vm.expectRevert(IHogeeErrors.NotLender.selector);
        treasury.openFacility(1_000_000, 300);
    }

    function test_Revert_PlanInvariantViolated_13_openFacility_floorOver100Pct() public {
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 13));
        treasury.openFacility(1_000_000, 10_001);
    }

    function test_Revert_PlanInvariantViolated_1_openFacility_capBelowCommittedPlan() public {
        _setUpRina();
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 1));
        treasury.openFacility(999_999, 300);
    }

    function test_Revert_PlanInvariantViolated_7_openFacility_floorAbovePlanReserve() public {
        _setUpRina();
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 7));
        treasury.openFacility(1_000_000, 501);
    }

    // ---------------------------------------------------------------------------------------------------------
    // fund
    // ---------------------------------------------------------------------------------------------------------

    function test_Fund_AccumulatesAndEmits() public {
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
        vm.prank(lender);
        treasury.fund(400_000);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.Funded(600_000, 1_000_000);
        vm.prank(lender);
        treasury.fund(600_000);
        assertEq(treasury.facility().fundedMinor, 1_000_000);
        assertEq(treasury.balances().fundedMinor, 1_000_000);
    }

    function test_Revert_NotLender_fund() public {
        _setUpRina();
        vm.prank(founder);
        vm.expectRevert(IHogeeErrors.NotLender.selector);
        treasury.fund(1);
    }

    function test_Revert_CapExceeded_fund_overPlanTotal() public {
        _setUpRina(); // funded 1,000,000 == plan total
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.fund(1);
    }

    function test_Revert_CapExceeded_fund_beforeAnyPlan() public {
        _openFacility();
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.CapExceeded.selector);
        treasury.fund(1);
    }

    // ---------------------------------------------------------------------------------------------------------
    // bindPayee
    // ---------------------------------------------------------------------------------------------------------

    function test_BindPayee_SupplierA_BindsWithCoolingAndCap() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        Sig memory sig = _signSupplier(a);
        vm.expectEmit(address(treasury));
        emit IHogeeEvents.PayeeBound(
            SUPPLIER_A, L_SUPPLIER, ORDER_A, T0 + COOLING, 430_000, SUPPLIER_A, a.scheduleHash, a.payoutAccountHash
        );
        vm.prank(relayer);
        treasury.bindPayee(a, schedule, autoRelease, sig);
        PayeeBinding memory b = treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A);
        assertTrue(b.bound);
        assertEq(b.coolingUntil, T0 + COOLING);
        assertEq(b.lifetimeCapMinor, 430_000);
        assertEq(b.paidMinor, 0);
        assertEq(b.payoutAccountHash, keccak256(bytes(SUPPLIER_A_ACCOUNT_JCS)));
        assertTrue(treasury.isNonceUsed(a.nonce));
    }

    function test_BindPayee_RebindRestartsCoolingAndAddsCap() public {
        _setUpRina();
        _bindSupplier(_supplier());
        vm.warp(block.timestamp + 1 days);
        SupplierApproval memory a = _supplier();
        (a.orderId, a.nonce) = ("order-a-002", 3);
        a.payoutAccountHash = keccak256("new bank account");
        _bindSupplier(a);
        PayeeBinding memory b = treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A);
        assertEq(b.coolingUntil, block.timestamp + COOLING); // T3: a destination change is vetoable again
        assertEq(b.lifetimeCapMinor, 860_000);
        assertEq(b.payoutAccountHash, keccak256("new bank account"));
    }

    function test_Revert_InvalidSignature_bindPayee_structForOtherDeployment() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        a.deploymentId = "loop-1";
        _expectBindRevert(a, _signSupplier(a), IHogeeErrors.InvalidSignature.selector);
    }

    /// T16: a signed SupplierApproval submitted after its expiry.
    function test_Revert_SignatureExpired_bindPayee() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        Sig memory sig = _signSupplier(a);
        vm.warp(a.expiry + 1);
        _expectBindRevert(a, sig, IHogeeErrors.SignatureExpired.selector);
    }

    /// T16: nonce reuse.
    function test_Revert_InvalidSignature_bindPayee_nonceReused() public {
        _setUpRina();
        _bindSupplier(_supplier());
        SupplierApproval memory a = _supplier();
        a.orderId = "order-a-002"; // fresh order, same nonce 2
        _expectBindRevert(a, _signSupplier(a), IHogeeErrors.InvalidSignature.selector);
    }

    /// T28: signed for this struct but under another deployment's domain (same deploymentId, other chainTag).
    function test_Revert_InvalidSignature_bindPayee_otherDomain() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        bytes32 foreign = HogeeTypes.digest(
            HogeeTypes.domainSeparator(address(treasury), "fisco", DEPLOYMENT_ID), HogeeTypes.hashSupplierApproval(a)
        );
        _expectBindRevert(a, _ecdsa(founderPk, foreign), IHogeeErrors.InvalidSignature.selector);
    }

    /// T2: the agent tries to bind a payee by signing the approval itself.
    function test_Revert_NotOwner_bindPayee_signedByAgent() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        _expectBindRevert(a, _ecdsa(agentPk, _supplierDigest(a)), IHogeeErrors.NotOwner.selector);
    }

    function test_Revert_NotOwner_bindPayee_signedByLender() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        _expectBindRevert(a, _ecdsa(lenderPk, _supplierDigest(a)), IHogeeErrors.NotOwner.selector);
    }

    function test_Revert_PlanInvariantViolated_13_bindPayee_emptySchedule() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        Sig memory sig = _signSupplier(a);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 13));
        treasury.bindPayee(a, new uint128[](0), new bool[](0), sig);
    }

    function test_Revert_PlanInvariantViolated_13_bindPayee_lengthMismatch() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        (uint128[] memory schedule,) = _schedule();
        Sig memory sig = _signSupplier(a);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 13));
        treasury.bindPayee(a, schedule, new bool[](2), sig);
    }

    function test_Revert_PlanInvariantViolated_13_bindPayee_zeroPayoutAccount() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        a.payoutAccountHash = bytes32(0);
        _expectBindRevert(a, _signSupplier(a), abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 13));
    }

    /// Run-2 audit: an order needs an id (the escrow order key).
    function test_Revert_PlanInvariantViolated_13_bindPayee_zeroOrderId() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        a.orderId = bytes32(0);
        _expectBindRevert(a, _signSupplier(a), abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 13));
    }

    /// Audit run-3: a zero milestone can never be funded (fundMilestone refuses 0) but reads as fully funded, so a
    /// founder release would open a zero settlement. A signed schedule with one is malformed.
    function test_Revert_PlanInvariantViolated_13_bindPayee_zeroMilestone() public {
        _setUpRina();
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        (schedule[1], schedule[2]) = (0, 400_000); // same total (430,000), signed as such
        SupplierApproval memory a = _supplier();
        a.scheduleHash = HogeeTypes.scheduleHash(schedule, autoRelease);
        Sig memory sig = _signSupplier(a);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 13));
        treasury.bindPayee(a, schedule, autoRelease, sig);
        assertFalse(treasury.payeeBinding(L_SUPPLIER, a.payee).bound);
    }

    function test_Revert_InvalidSignature_bindPayee_scheduleNotSigned() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        Sig memory sig = _signSupplier(a);
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        autoRelease[2] = true; // relayer flips the balance milestone to auto-release
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        treasury.bindPayee(a, schedule, autoRelease, sig);
    }

    function test_Revert_PlanInvariantViolated_11_bindPayee_capNotScheduleTotal() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        a.totalMinor = 430_001;
        _expectBindRevert(a, _signSupplier(a), abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 11));
    }

    /// Run-2 audit: a static platform payee is uncapped (decision #1), so a signed binding of one could never keep
    /// its lifetime cap at the schedule total (code 11), and would replace its fixed payout account.
    function test_Revert_PlanInvariantViolated_11_bindPayee_platformPayee() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        a.payee = P_ADS;
        _expectBindRevert(a, _signSupplier(a), abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 11));
        assertFalse(treasury.payeeBinding(L_SUPPLIER, P_ADS).bound);
    }

    function test_Revert_LineExpired_bindPayee_lineNotInPlan() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        a.lineId = "TOOLING";
        _expectBindRevert(a, _signSupplier(a), IHogeeErrors.LineExpired.selector);
    }

    function test_Revert_PlanInvariantViolated_10_bindPayee_directPayLine() public {
        _setUpRina();
        SupplierApproval memory a = _supplier();
        a.lineId = L_PACKAGING;
        _expectBindRevert(a, _signSupplier(a), abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, 10));
    }

    function test_Revert_DuplicateIntent_bindPayee_orderReused() public {
        _setUpRina();
        _bindSupplier(_supplier());
        SupplierApproval memory a = _supplier();
        a.nonce = 9;
        _expectBindRevert(a, _signSupplier(a), IHogeeErrors.DuplicateIntent.selector);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _expectBindRevert(SupplierApproval memory a, Sig memory sig, bytes4 selector) private {
        _expectBindRevert(a, sig, abi.encodeWithSelector(selector));
    }

    function _expectBindRevert(SupplierApproval memory a, Sig memory sig, bytes memory err) private {
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        vm.expectRevert(err);
        treasury.bindPayee(a, schedule, autoRelease, sig);
    }
}
