// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PayeeBinding} from "../../src/interfaces/IHogee.sol";
import {Treasury} from "../../src/Treasury.sol";
import {TreasuryLinks} from "../../src/HogeeHooks.sol";

/// Test-only Treasury that reaches states loop-1 has no external path to. Never deployed.
contract TreasuryHarness is Treasury {
    constructor(
        address registry_,
        address oracle_,
        uint64 coolingSeconds_,
        TreasuryLinks memory links,
        bytes32[] memory platformPayeeIds,
        bytes32[] memory platformPayoutHashes
    ) Treasury(registry_, oracle_, coolingSeconds_, links, platformPayeeIds, platformPayoutHashes) {}

    /// Stand-in for task 1.8's LOOSEN_ADD_PAYEE: binds `payee` to a direct-pay line with a cooling period and a
    /// lifetime cap. Since the replan rule (G0 audit v-1) a plan can no longer turn an escrow line into a direct-pay
    /// line, so this is how loop-1 tests reach spend rows 11 (PayeeCooling) and 21 (payee lifetime cap).
    /// Like 1.8's ADD_PAYEE, it lists the payee on the line for the current version (a later re-commit that leaves
    /// it out drops it).
    function harnessAddPayee(bytes32 lineId, bytes32 payee, uint128 lifetimeCapMinor) external {
        _signedPayee[lineId][payee] = true;
        _listedVersion[lineId][payee] = _planVersion;
        PayeeBinding storage b = _bindings[lineId][payee];
        b.bound = true;
        b.coolingUntil = _now() + coolingSeconds;
        b.lifetimeCapMinor = lifetimeCapMinor;
        b.payoutAccountHash = keccak256(abi.encode("hogee/test/payout", payee));
    }

    /// Calls the releasedMinor guard directly (1.8's releaseStage will be its second caller).
    function harnessRaiseReleased(bytes32 stageId) external {
        _raiseReleased(stageId);
    }

    /// Injects a stage the plan does not have, to reach the guard's "above the plan total" branch.
    function harnessAddStage(bytes32 stageId, uint128 releaseMinor) external {
        _stages[stageId] = StageState({releaseMinor: releaseMinor, known: true, released: false});
    }
}
