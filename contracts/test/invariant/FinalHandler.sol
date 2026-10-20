// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {
    Sig,
    MilestoneRelease,
    LoosenRequest,
    StageRelease,
    OwnerSpend,
    QueuedLoosen,
    PayeeBinding,
    HogeeKinds
} from "../../src/interfaces/IHogee.sol";
import {HogeeTypes} from "../../src/interfaces/HogeeTypes.sol";
import {PlanRegistry} from "../../src/PlanRegistry.sol";
import {Treasury} from "../../src/Treasury.sol";
import {MilestoneEscrow} from "../../src/MilestoneEscrow.sol";
import {SalesOracle} from "../../src/SalesOracle.sol";
import {RinaFixture} from "../utils/RinaFixture.sol";

/// Invariant handler for the final-1 set: the agent (spend, fundMilestone, pause), the founder (ownerSpend, balance
/// release), the lender (stage 2), founder + lender loosenings (queue, execute after the timelock, cancel), the oracle
/// (sales, settlements) and the clock; the agent also tries every admin and signed entry point (AgentAdmin).
/// Ghosts record what happened, independently of the contracts' own counters.
contract FinalHandler is Test, RinaFixture {
    struct Keys {
        uint256 agent;
        uint256 founder;
        uint256 lender;
        address oracle;
    }

    PlanRegistry internal immutable registry;
    Treasury internal immutable treasury;
    MilestoneEscrow internal immutable escrow;
    SalesOracle internal immutable sales;
    address internal immutable agent;
    uint256 internal immutable agentPk;
    uint256 internal immutable founderPk;
    uint256 internal immutable lenderPk;
    address internal immutable oracle;

    // ---- ghosts ----
    uint256 public ghostRevenue; // sum of recorded sale amounts
    uint256 public ghostSkimmed; // sum of floor(amount * reserveBps / 10,000) at each sale
    uint256 public ghostWithdrawn; // executed WITHDRAW_RESERVE minus failed ones
    uint256 public ghostReserveBreach; // the reserve fell outside an executed, timelocked WITHDRAW_RESERVE
    uint256 public ghostUnboundPaid; // an outflow to a payee that was not bound (+ listed and cooled for spends)
    uint256 public ghostDoubleInvoice; // an invoice paid twice (agent and owner spends together)
    uint256 public ghostEarlyLoosen; // a loosening executed before its executableAt
    uint256 public calls;
    /// Successful calls per action (coverage of the success paths, read by the coverage probe).
    mapping(bytes32 action => uint256) public ok;
    bytes32[] public settlementIds;
    bytes32[] public loosenIds;
    mapping(bytes32 settlementId => uint128) internal _withdrawAmount;
    mapping(bytes32 invoiceHash => uint256) internal _invoiceUses;
    uint256 internal _seq;
    uint256 internal _nonce = 10_000;

    constructor(PlanRegistry r, Treasury t, MilestoneEscrow e, SalesOracle s, address agent_, Keys memory k) {
        (registry, treasury, escrow, sales, agent) = (r, t, e, s, agent_);
        (agentPk, founderPk, lenderPk, oracle) = (k.agent, k.founder, k.lender, k.oracle);
    }

    /// Every action checks invariant 3 around itself: the reserve falls only in an executed WITHDRAW_RESERVE.
    modifier reserveWatch(bool mayWithdraw) {
        uint128 before = treasury.reserve();
        _;
        if (treasury.reserve() < before && !mayWithdraw) ++ghostReserveBreach;
        ++calls;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Agent
    // ---------------------------------------------------------------------------------------------------------

    function agentSpend(uint256 lineSeed, uint256 amountSeed) external reserveWatch(false) {
        uint256 k = lineSeed % 3;
        (bytes32 lineId, bytes32 payeeId) = k == 0
            ? (bytes32("LOGISTICS"), bytes32("spx-logistics"))
            : k == 1 ? (bytes32("ADS"), bytes32("shopee-ads")) : (bytes32("PLATFORM_FEES"), bytes32("shopee-fees"));
        uint128 amount = uint128(bound(amountSeed, 1, treasury.pocket(lineId).perTxCapMinor + 1));
        bytes32 invoice = lineId == "ADS" ? bytes32(uint256(treasury.lineSequence(lineId))) : _invoice();
        bool ready = _payable(lineId, payeeId);
        uint32 v = registry.planVersion();
        vm.prank(agent);
        try treasury.spend(lineId, payeeId, amount, invoice, v, "decision", "rationale") returns (bytes32 id) {
            settlementIds.push(id);
            ++ok["spend"];
            if (!ready) ++ghostUnboundPaid;
            if (lineId != "ADS" && ++_invoiceUses[invoice] > 1) ++ghostDoubleInvoice;
        } catch {}
    }

    function fundMilestone(uint256 idxSeed, uint256 amountSeed) external reserveWatch(false) {
        uint8 idx = uint8(idxSeed % 3);
        // Half the time exactly what the milestone still needs (so autoRelease and the balance release happen).
        uint128 left = escrow.milestones(ORDER_A)[idx].amountMinor - escrow.milestones(ORDER_A)[idx].fundedMinor;
        uint128 amount = amountSeed % 2 == 0 ? left : uint128(bound(amountSeed, 0, 300_000));
        bool bound_ = treasury.payeeBinding("SUPPLIER", SUPPLIER_A).bound;
        vm.prank(agent);
        try escrow.fundMilestone(ORDER_A, idx, amount, "decision", "rationale") {
            ++ok["fund"];
            if (!bound_) ++ghostUnboundPaid;
            if (escrow.milestones(ORDER_A)[idx].released && idx < 2) settlementIds.push(_sid(idx));
        } catch {}
    }

    function agentPause(uint256 seed) external reserveWatch(false) {
        if (seed % 8 != 0) return; // rare: a pause stops agent outflow until a co-signed UNPAUSE executes
        vm.prank(agent);
        try treasury.pause() {
            ++ok["pause"];
        } catch {}
    }

    // ---------------------------------------------------------------------------------------------------------
    // Founder, lender, oracle
    // ---------------------------------------------------------------------------------------------------------

    function ownerSpend(uint256 lineSeed, uint256 amountSeed) external reserveWatch(false) {
        (bytes32 lineId, bytes32 payeeId) = lineSeed % 2 == 0
            ? (bytes32("LOGISTICS"), bytes32("spx-logistics"))
            : (bytes32("PLATFORM_FEES"), bytes32("shopee-fees"));
        OwnerSpend memory r = OwnerSpend(
            lineId, payeeId, uint128(bound(amountSeed, 1, 30_000)), _invoice(), DEPLOYMENT_ID, ++_nonce, _expiry()
        );
        Sig memory sig = _sign(founderPk, _treasuryDigest(HogeeTypes.hashOwnerSpend(r)));
        bool ready = _payable(lineId, payeeId);
        try treasury.ownerSpend(r, sig) returns (bytes32 id) {
            settlementIds.push(id);
            ++ok["owner"];
            if (!ready) ++ghostUnboundPaid;
            if (++_invoiceUses[r.invoiceHash] > 1) ++ghostDoubleInvoice;
        } catch {}
    }

    function releaseBalance() external reserveWatch(false) {
        MilestoneRelease memory r =
            MilestoneRelease(ORDER_A, 2, 280_000, keccak256("inspection"), DEPLOYMENT_ID, ++_nonce, _expiry());
        bytes32 digest = HogeeTypes.digest(escrow.domainSeparator(), HogeeTypes.hashMilestoneRelease(r));
        try escrow.releaseMilestone(r, _sign(founderPk, digest)) {
            settlementIds.push(_sid(2));
            ++ok["release"];
        } catch {}
    }

    function recordSale(uint256 amountSeed) external reserveWatch(false) {
        uint128 amount = uint128(bound(amountSeed, 0, 150_000));
        (,,, uint16 bps) = treasury.agentState();
        vm.prank(oracle);
        try sales.recordSale(keccak256(abi.encode("sale", ++_seq)), amount) {
            ghostRevenue += amount;
            ghostSkimmed += (uint256(amount) * bps) / 10_000;
            ++ok["sale"];
        } catch {}
    }

    function releaseStage2() external reserveWatch(false) {
        StageRelease memory r = StageRelease("stage-2", 600_000, DEPLOYMENT_ID, ++_nonce, _expiry());
        try treasury.releaseStage(r, _sign(lenderPk, _treasuryDigest(HogeeTypes.hashStageRelease(r)))) {
            ++ok["stage"];
        } catch {}
    }

    function settle(uint256 idx, bool confirm) external reserveWatch(false) {
        if (settlementIds.length == 0) return;
        bytes32 id = settlementIds[idx % settlementIds.length];
        vm.prank(oracle);
        if (confirm) {
            try treasury.confirmSettlement(id, keccak256("ref")) {} catch {}
            return;
        }
        try treasury.failSettlement(id, "INVALID_DESTINATION") {
            ghostWithdrawn -= _withdrawAmount[id];
            ++ok["fail"];
        } catch {}
    }

    // ---------------------------------------------------------------------------------------------------------
    // Loosening (founder + lender, timelock)
    // ---------------------------------------------------------------------------------------------------------

    /// WITHDRAW_RESERVE up to the reserve, a small CONTINGENCY -> ADS pocket move, an ADS window raise, UNPAUSE.
    function queueLoosen(uint256 kindSeed, uint256 valueSeed) external reserveWatch(false) {
        uint256 k = kindSeed % 4;
        LoosenRequest memory r;
        if (k == 0) {
            uint256 reserve_ = treasury.reserve();
            r = _req(HogeeKinds.LOOSEN_WITHDRAW_RESERVE, "lhdn-tax", 0, bound(valueSeed, 1, reserve_ + 1));
        } else if (k == 1) {
            r = _req(HogeeKinds.LOOSEN_MOVE_POCKETS, "CONTINGENCY", "ADS", bound(valueSeed, 1, 2_000));
        } else if (k == 2) {
            r = _req(HogeeKinds.LOOSEN_RAISE_WINDOW_CAP, "ADS", 0, bound(valueSeed, 0, 70_000));
        } else {
            r = _req(HogeeKinds.LOOSEN_UNPAUSE, 0, 0, 0);
        }
        bytes32 digest = _treasuryDigest(HogeeTypes.hashLoosenRequest(r));
        try treasury.queueLoosen(r, _sign(founderPk, digest), _sign(lenderPk, digest)) returns (bytes32 id) {
            loosenIds.push(id);
            ++ok["queue"];
        } catch {}
    }

    function executeLoosen(uint256 idx) external {
        if (loosenIds.length == 0) return;
        bytes32 id = loosenIds[idx % loosenIds.length];
        QueuedLoosen memory q = treasury.queuedLoosen(id);
        bool withdraw = q.kind == HogeeKinds.LOOSEN_WITHDRAW_RESERVE;
        _execute(id, q, withdraw);
    }

    function cancelLoosen(uint256 idx) external reserveWatch(false) {
        if (loosenIds.length == 0) return;
        vm.prank(idx % 2 == 0 ? registry.lender() : agent); // the agent's veto must fail (NotOwner)
        try treasury.cancelLoosen(loosenIds[idx % loosenIds.length]) {
            ++ok["cancel"];
        } catch {}
    }

    function warp(uint256 dt) external reserveWatch(false) {
        uint256 t = block.timestamp + bound(dt, 0, 2 days);
        if (t > T0 + 29 * DAY) return; // inside the stage-2 deadline, agent expiry and line validity
        vm.warp(t);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _execute(bytes32 id, QueuedLoosen memory q, bool withdraw) private reserveWatch(withdraw) {
        try treasury.executeLoosen(id) {
            if (block.timestamp < q.executableAt) ++ghostEarlyLoosen;
            ++ok[withdraw ? bytes32("withdraw") : bytes32("execute")];
            if (withdraw) {
                // forge-lint: disable-next-line(unsafe-typecast)
                _withdrawAmount[id] = uint128(q.newValue);
                ghostWithdrawn += q.newValue;
                settlementIds.push(id);
            }
        } catch {}
    }

    /// Bound, listed by the current version and cooled (spend row 10-11), checked independently of Treasury's stamp.
    function _payable(bytes32 lineId, bytes32 payeeId) private view returns (bool) {
        PayeeBinding memory b = treasury.payeeBinding(lineId, payeeId);
        if (!b.bound || block.timestamp < b.coolingUntil) return false;
        bytes32[] memory listed = registry.line(lineId).payeeIds;
        for (uint256 i; i < listed.length; ++i) {
            if (listed[i] == payeeId) return true;
        }
        return false;
    }

    function _req(uint8 kind, bytes32 target, bytes32 aux, uint256 value) private returns (LoosenRequest memory) {
        return LoosenRequest(kind, target, aux, value, DEPLOYMENT_ID, ++_nonce, _expiry());
    }

    function _invoice() private returns (bytes32) {
        return keccak256(abi.encode("invoice", ++_seq));
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

    function settlementCount() external view returns (uint256) {
        return settlementIds.length;
    }
}
