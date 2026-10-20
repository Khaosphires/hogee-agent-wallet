// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Sig, OwnerSpend, LoosenRequest, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../src/interfaces/IHogeeBase.sol";
import {TreasuryGovernance} from "../src/TreasuryGovernance.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// The delegate-only governance module (task 1.8 size split): Treasury creates it in its constructor and runs the
/// founder/lender-signed entry points in it by delegatecall, in Treasury's own storage. Called directly, it refuses.
contract TreasuryGovernanceModuleTest is HogeeTestBase {
    function test_Module_IsCreatedByTreasuryWithTheSameLinks() public view {
        TreasuryGovernance m = TreasuryGovernance(treasury.governance());
        assertGt(address(m).code.length, 0);
        assertEq(m.registry(), address(registry));
        assertEq(m.coolingSeconds(), treasury.coolingSeconds());
        assertEq(m.loosenTimelockSeconds(), treasury.loosenTimelockSeconds());
        assertEq(m.observer(), treasury.observer());
        assertEq(m.salesOracle(), treasury.salesOracle());
        assertEq(m.deploymentId(), treasury.deploymentId());
        assertEq(m.chainTag(), treasury.chainTag());
    }

    function test_Revert_NotOwner_governance_directCallReleaseStage() public {
        _setUpRina();
        TreasuryGovernance m = TreasuryGovernance(treasury.governance());
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        m.releaseStage(_stage2(), Sig(0, ""));
    }

    /// G-1 on every module entry point (audit run-3 coverage): a founder-signed request that Treasury would accept is
    /// refused by the module itself with NotOwner (the guard runs before the signature check, which would fail too:
    /// the module's address(this) is not Treasury's), and Treasury's state is untouched.
    function test_Revert_NotOwner_governance_directCallOwnerSpend() public {
        _setUpRina();
        TreasuryGovernance m = TreasuryGovernance(treasury.governance());
        OwnerSpend memory r =
            OwnerSpend(L_LOGISTICS, P_LOGISTICS, 10_000, _invoice(1), DEPLOYMENT_ID, 6, uint64(block.timestamp) + DAY);
        Sig memory sig = _signOwnerSpend(founderPk, r);
        vm.prank(relayer);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        m.ownerSpend(r, sig);
        assertFalse(treasury.isNonceUsed(r.nonce));
        assertEq(treasury.pocket(L_LOGISTICS).spentMinor, 0);
    }

    function test_Revert_NotOwner_governance_directCallQueueLoosen() public {
        _setUpRina();
        TreasuryGovernance m = TreasuryGovernance(treasury.governance());
        LoosenRequest memory r = _loosen(HogeeKinds.LOOSEN_UNPAUSE, bytes32(0), bytes32(0), 0, 50);
        Sig memory f = _signLoosen(founderPk, r);
        Sig memory l = _signLoosen(lenderPk, r);
        vm.prank(relayer);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        m.queueLoosen(r, f, l);
        assertFalse(treasury.isNonceUsed(r.nonce));
    }

    /// A loosening queued through Treasury and past its timelock: the module refuses to execute it directly, Treasury
    /// still executes it.
    function test_Revert_NotOwner_governance_directCallExecuteLoosen() public {
        _setUpRina();
        TreasuryGovernance m = TreasuryGovernance(treasury.governance());
        bytes32 id = _queue(_loosen(HogeeKinds.LOOSEN_UNPAUSE, bytes32(0), bytes32(0), 0, 50));
        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(stranger);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        m.executeLoosen(id);
        assertEq(treasury.queuedLoosen(id).status, HogeeKinds.LOOSEN_STATUS_QUEUED);
        vm.prank(stranger);
        treasury.executeLoosen(id);
        assertEq(treasury.queuedLoosen(id).status, HogeeKinds.LOOSEN_STATUS_EXECUTED);
    }

    /// Even the lender, who may cancel through Treasury, is refused by the module directly.
    function test_Revert_NotOwner_governance_directCallCancelLoosen() public {
        _setUpRina();
        TreasuryGovernance m = TreasuryGovernance(treasury.governance());
        bytes32 id = _queue(_loosen(HogeeKinds.LOOSEN_UNPAUSE, bytes32(0), bytes32(0), 0, 50));
        vm.prank(lender);
        vm.expectRevert(IHogeeErrors.NotOwner.selector);
        m.cancelLoosen(id);
        assertEq(treasury.queuedLoosen(id).status, HogeeKinds.LOOSEN_STATUS_QUEUED);
    }
}
