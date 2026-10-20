// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {
    PlanApproval,
    Sig,
    SupplierApproval,
    MilestoneRelease,
    LoosenRequest,
    StageRelease,
    OwnerSpend,
    HogeeKinds
} from "../../src/interfaces/IHogee.sol";
import {HogeeTypes} from "../../src/interfaces/HogeeTypes.sol";
import {PlanRegistry} from "../../src/PlanRegistry.sol";
import {Treasury} from "../../src/Treasury.sol";
import {MilestoneEscrow} from "../../src/MilestoneEscrow.sol";
import {SalesOracle} from "../../src/SalesOracle.sol";
import {PlanSync} from "../../src/HogeeHooks.sol";
import {RinaFixture} from "../utils/RinaFixture.sol";

/// §8.9 invariant 7 on the final-1 set: the agent key tries every admin, oracle, hook and founder/lender-signed entry
/// point of all four contracts (signing the structs itself), and submits a valid founder-signed milestone release;
/// none may succeed. Counted in ghostAdminSuccess.
contract FinalAgentAdmin is Test, RinaFixture {
    PlanRegistry internal immutable registry;
    Treasury internal immutable treasury;
    MilestoneEscrow internal immutable escrow;
    SalesOracle internal immutable sales;
    address internal immutable agent;
    uint256 internal immutable agentPk;
    uint256 internal immutable founderPk;

    uint256 public ghostAdminSuccess;
    uint256 internal _nonce = 90_000;

    constructor(
        PlanRegistry r,
        Treasury t,
        MilestoneEscrow e,
        SalesOracle s,
        address agent_,
        uint256 agentPk_,
        uint256 founderPk_
    ) {
        (registry, treasury, escrow, sales, agent, agentPk, founderPk) = (r, t, e, s, agent_, agentPk_, founderPk_);
    }

    function agentTriesAdmin(uint256 which) external {
        uint256 w = which % 21;
        bytes memory data;
        address target = address(treasury);
        if (w == 0) {
            data = abi.encodeCall(treasury.openFacility, (type(uint128).max, 0));
        } else if (w == 1) {
            data = abi.encodeCall(treasury.fund, (1));
        } else if (w == 2) {
            (target, data) = (address(registry), abi.encodeCall(registry.registerFounderKey, (0, 0, agent)));
        } else if (w == 3) {
            data = abi.encodeCall(treasury.syncPlan, (_sync(), _lines(), _stages()));
        } else if (w == 4) {
            data = abi.encodeCall(treasury.confirmSettlement, (_sid(0), 0));
        } else if (w == 5) {
            data = abi.encodeCall(treasury.failSettlement, (_sid(0), "X"));
        } else if (w == 6) {
            data = _agentBindPayee();
        } else if (w == 7) {
            data = abi.encodeCall(treasury.tighten, (1, "ADS", type(uint128).max, "d"));
        } else if (w == 8) {
            data = abi.encodeCall(treasury.tighten, (3, 0, 0, "d"));
        } else if (w == 9) {
            (target, data) = (address(sales), abi.encodeCall(sales.recordSale, (keccak256("x"), 1)));
        } else if (w == 10) {
            data = _agentReleaseStage();
        } else if (w == 11) {
            data = _agentQueueLoosen();
        } else if (w == 12) {
            data = _agentOwnerSpend();
        } else if (w == 13) {
            (target, data) = (address(escrow), _releaseBalanceSignedByFounder());
        } else if (w == 14) {
            data = abi.encodeCall(treasury.cancelLoosen, (keccak256("any")));
        } else if (w == 15) {
            data = abi.encodeCall(treasury.creditRevenue, (keccak256("x"), 1));
        } else if (w == 16) {
            data = abi.encodeCall(treasury.escrowFund, ("SUPPLIER", 1));
        } else if (w == 17) {
            data = abi.encodeCall(treasury.escrowRelease, (keccak256("x"), "SUPPLIER", SUPPLIER_A, 1));
        } else if (w == 18) {
            (target, data) = (address(escrow), _agentOpenOrder());
        } else if (w == 19) {
            (target, data) = (address(registry), _agentCommitPlan());
        } else {
            (target, data) = (treasury.governance(), _agentOwnerSpend()); // the module itself, not through Treasury
        }
        vm.prank(agent);
        (bool ok,) = target.call(data);
        if (ok) ++ghostAdminSuccess;
    }

    // ---------------------------------------------------------------------------------------------------------
    // the agent signs owner / lender structs itself
    // ---------------------------------------------------------------------------------------------------------

    function _agentBindPayee() private returns (bytes memory) {
        SupplierApproval memory a = _supplierApproval();
        (a.payee, a.orderId, a.nonce, a.expiry) = ("0xevil", keccak256(abi.encode(++_nonce)), _nonce, _expiry());
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        Sig memory sig = _sign(agentPk, _treasuryDigest(HogeeTypes.hashSupplierApproval(a)));
        return abi.encodeCall(treasury.bindPayee, (a, schedule, autoRelease, sig));
    }

    /// The escrow's only Treasury hook, called directly with a fresh order (re-check M-1 dropped releaseFailed).
    function _agentOpenOrder() private returns (bytes memory) {
        SupplierApproval memory a = _supplierApproval();
        a.orderId = keccak256(abi.encode("hogee/test/agent-order", ++_nonce));
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        return abi.encodeCall(escrow.openOrder, (a, schedule, autoRelease));
    }

    function _agentReleaseStage() private returns (bytes memory) {
        StageRelease memory r = StageRelease("stage-2", 600_000, DEPLOYMENT_ID, ++_nonce, _expiry());
        return
            abi.encodeCall(treasury.releaseStage, (r, _sign(agentPk, _treasuryDigest(HogeeTypes.hashStageRelease(r)))));
    }

    function _agentQueueLoosen() private returns (bytes memory) {
        LoosenRequest memory r =
            LoosenRequest(HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, "ADS", 0, 30_000, DEPLOYMENT_ID, ++_nonce, _expiry());
        Sig memory sig = _sign(agentPk, _treasuryDigest(HogeeTypes.hashLoosenRequest(r)));
        return abi.encodeCall(treasury.queueLoosen, (r, sig, sig));
    }

    function _agentOwnerSpend() private returns (bytes memory) {
        OwnerSpend memory r = OwnerSpend(
            "LOGISTICS", "spx-logistics", 1_000, keccak256(abi.encode(++_nonce)), DEPLOYMENT_ID, _nonce, _expiry()
        );
        return abi.encodeCall(treasury.ownerSpend, (r, _sign(agentPk, _treasuryDigest(HogeeTypes.hashOwnerSpend(r)))));
    }

    function _agentCommitPlan() private returns (bytes memory) {
        PlanApproval memory a = _planApproval();
        (a.agent, a.version, a.prevPlanHash, a.nonce, a.expiry) = (agent, 2, a.planHash, ++_nonce, _expiry());
        bytes32 digest = HogeeTypes.digest(registry.domainSeparator(), HogeeTypes.hashPlanApproval(a));
        return abi.encodeCall(registry.commitPlan, (a, _lines(), _stages(), _sign(agentPk, digest)));
    }

    /// A release the founder really signed: only the relayer may submit it, never the agent key (T5).
    function _releaseBalanceSignedByFounder() private returns (bytes memory) {
        MilestoneRelease memory r =
            MilestoneRelease(ORDER_A, 2, 280_000, keccak256("inspection"), DEPLOYMENT_ID, ++_nonce, _expiry());
        bytes32 digest = HogeeTypes.digest(escrow.domainSeparator(), HogeeTypes.hashMilestoneRelease(r));
        return abi.encodeCall(escrow.releaseMilestone, (r, _sign(founderPk, digest)));
    }

    function _sync() private view returns (PlanSync memory) {
        return PlanSync(PLAN_ID, 9, type(uint128).max, agent, uint64(block.timestamp + 80 * DAY), 0);
    }

    function _sid(uint8 idx) private pure returns (bytes32) {
        return HogeeTypes.milestoneSettlementId(ORDER_A, idx);
    }

    function _expiry() private view returns (uint64) {
        return uint64(block.timestamp + DAY);
    }

    function _treasuryDigest(bytes32 structHash) private view returns (bytes32) {
        return HogeeTypes.digest(treasury.domainSeparator(), structHash);
    }

    function _sign(uint256 pk, bytes32 digest) private pure returns (Sig memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return Sig({kind: HogeeKinds.SIG_ECDSA, data: abi.encodePacked(r, s, v)});
    }
}
