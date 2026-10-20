// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../src/interfaces/IHogeeBase.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";
import {TreasuryLinks} from "../src/HogeeHooks.sol";

/// Treasury constructor checks (run-2 audit): role separation and the static platform payee registry.
contract TreasuryConstructorTest is HogeeTestBase {
    /// The oracle can refund settlements: it must never be the lender.
    function test_Revert_NotOracle_constructor_oracleIsLender() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        _expectConstructorRevert(
            lender, _links(address(0), address(0)), ids, hashes, abi.encodeWithSelector(IHogeeErrors.NotOracle.selector)
        );
    }

    /// Audit run-3: the observer is its own key. As the lender or the oracle it would merge a veto into a role that
    /// already acts on this treasury.
    function test_Revert_PlanInvariantViolated_13_constructor_observerIsLender() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        TreasuryLinks memory l = _links(address(0), address(0));
        l.observer = lender;
        _expectConstructorRevert(oracle, l, ids, hashes, _malformed());
    }

    function test_Revert_PlanInvariantViolated_13_constructor_observerIsOracle() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        TreasuryLinks memory l = _links(address(0), address(0));
        l.observer = oracle;
        _expectConstructorRevert(oracle, l, ids, hashes, _malformed());
    }

    /// No observer (0) is allowed: the veto is optional.
    function test_Constructor_NoObserver() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        TreasuryLinks memory l = _links(address(0), address(0));
        l.observer = address(0);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        PlanRegistry r = new PlanRegistry(lender, predicted, DEPLOYMENT_ID, CHAIN_TAG, false, JUDGING_END);
        Treasury t = new Treasury(address(r), oracle, COOLING, l, ids, hashes);
        assertEq(t.observer(), address(0));
    }

    /// The static platform registry is checked on-chain, not only by the deploy script.
    function test_Revert_PlanInvariantViolated_13_constructor_platformArraysDifferInLength() public {
        (bytes32[] memory ids,) = _platformPayees();
        _expectMalformed(ids, new bytes32[](2));
    }

    function test_Revert_PlanInvariantViolated_13_constructor_zeroPlatformPayeeId() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        ids[1] = bytes32(0);
        _expectMalformed(ids, hashes);
    }

    /// A zero hash would read as "not a platform payee" (platformPayoutAccountHash == 0).
    function test_Revert_PlanInvariantViolated_13_constructor_zeroPlatformPayoutHash() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        hashes[2] = bytes32(0);
        _expectMalformed(ids, hashes);
    }

    function test_Revert_PlanInvariantViolated_13_constructor_duplicatePlatformPayee() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        ids[2] = ids[0];
        _expectMalformed(ids, hashes);
    }

    /// §8.8: a zero timelock would make every loosening instant.
    function test_Revert_PlanInvariantViolated_13_constructor_zeroLoosenTimelock() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        TreasuryLinks memory l = _links(address(0), address(0));
        l.loosenTimelockSeconds = 0;
        _expectConstructorRevert(oracle, l, ids, hashes, _malformed());
    }

    /// A timelock above 30 days is an input error (production is 24 h): it would park every loosening for good.
    function test_Revert_PlanInvariantViolated_13_constructor_loosenTimelockOver30Days() public {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        TreasuryLinks memory l = _links(address(0), address(0));
        l.loosenTimelockSeconds = 30 days + 1;
        _expectConstructorRevert(oracle, l, ids, hashes, _malformed());
    }

    function test_Constructor_StoresTheLinks() public view {
        assertEq(treasury.observer(), observer);
        assertEq(treasury.loosenTimelockSeconds(), TIMELOCK);
    }

    function test_Constructor_StoresThePlatformRegistry() public view {
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        for (uint256 i; i < ids.length; ++i) {
            assertEq(treasury.platformPayoutAccountHash(ids[i]), hashes[i]);
        }
        assertEq(treasury.platformPayoutAccountHash("0xevil"), bytes32(0));
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _malformed() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, HogeeKinds.CONST_MALFORMED_PLAN);
    }

    function _expectMalformed(bytes32[] memory ids, bytes32[] memory hashes) internal {
        _expectConstructorRevert(oracle, _links(address(0), address(0)), ids, hashes, _malformed());
    }

    function _expectConstructorRevert(
        address oracle_,
        TreasuryLinks memory links,
        bytes32[] memory ids,
        bytes32[] memory hashes,
        bytes memory err
    ) internal {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        PlanRegistry r = new PlanRegistry(lender, predicted, DEPLOYMENT_ID, CHAIN_TAG, false, JUDGING_END);
        vm.expectRevert(err);
        new Treasury(address(r), oracle_, COOLING, links, ids, hashes);
    }
}
