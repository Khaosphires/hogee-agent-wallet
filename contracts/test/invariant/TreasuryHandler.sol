// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {
    PlanApproval,
    PlanState,
    Line,
    Stage,
    Pocket,
    Sig,
    SupplierApproval,
    PayeeBinding,
    HogeeKinds
} from "../../src/interfaces/IHogee.sol";
import {HogeeTypes} from "../../src/interfaces/HogeeTypes.sol";
import {PlanRegistry} from "../../src/PlanRegistry.sol";
import {Treasury} from "../../src/Treasury.sol";
import {PlanSync} from "../../src/HogeeHooks.sol";
import {RinaFixture} from "../utils/RinaFixture.sol";

/// Invariant handler: drives the agent (spend, tighten, recordDenied), the oracle (confirm/fail), the founder
/// (re-commits that tighten or loosen one field, G0 audit v-1) and the clock, and makes the agent try every admin
/// entry point. Ghost variables record what actually happened.
contract TreasuryHandler is Test, RinaFixture {
    PlanRegistry internal immutable registry;
    Treasury internal immutable treasury;
    address internal immutable agent;
    uint256 internal immutable agentPk;
    uint256 internal immutable founderPk;
    address internal immutable oracle;

    bytes32[7] internal lineIds =
        [bytes32("SUPPLIER"), "PACKAGING", "LOGISTICS", "ADS", "PLATFORM_FEES", "CONTINGENCY", "LICENSING"];
    bytes32[5] internal payeeIds = [bytes32("spx-logistics"), "shopee-ads", "shopee-fees", "0xevil", "supplier-a"];

    // ---- ghosts ----
    uint256 public ghostSpent;
    uint256 public ghostRefunded;
    uint256 public ghostSpendCount;
    // successful spends whose payee was not bound + cooled on that line, or not listed on it by the current version
    uint256 public ghostUnboundPaid;
    uint256 public ghostAdminSuccess; // admin calls by the agent that did not revert
    uint256 public ghostDoubleInvoice; // an invoice paid by two successful spends
    uint256 public ghostWindowBreach; // a successful spend that left the window above its cap
    uint256 public ghostReplans; // successful founder re-commits
    uint256 public ghostReplanBreach; // a successful re-commit that loosened something or changed runtime state
    bytes32[] public spendIds;
    mapping(bytes32 invoiceHash => uint256) internal _invoiceUses;
    mapping(bytes32 spendId => uint128) internal _amounts;
    uint256 internal _invoiceSeq;
    // founderReplans snapshot
    uint128 internal _released;
    uint16 internal _reserveBefore;
    uint64 internal _expiryBefore;
    mapping(bytes32 lineId => Pocket) internal _pocketBefore;
    mapping(bytes32 lineId => bytes32[]) internal _payeesBefore;

    constructor(
        PlanRegistry registry_,
        Treasury treasury_,
        address agent_,
        uint256 agentPk_,
        uint256 founderPk_,
        address oracle_
    ) {
        registry = registry_;
        treasury = treasury_;
        agent = agent_;
        agentPk = agentPk_;
        founderPk = founderPk_;
        oracle = oracle_;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Agent
    // ---------------------------------------------------------------------------------------------------------

    /// Three quarters of the calls use a payable (line, platform payee) pair, so successful spends are frequent;
    /// the rest mix lines and payees freely (unbound, cross-line, escrow-only, outside the plan).
    function spend(uint256 lineSeed, uint256 payeeSeed, uint256 amountSeed, uint256 invoiceSeed) external {
        bytes32 lineId = lineIds[lineSeed % lineIds.length];
        bytes32 payeeId = payeeIds[payeeSeed % payeeIds.length];
        if (payeeSeed % 4 != 0) {
            uint256 k = lineSeed % 3;
            (lineId, payeeId) = k == 0
                ? (bytes32("LOGISTICS"), bytes32("spx-logistics"))
                : k == 1 ? (bytes32("ADS"), bytes32("shopee-ads")) : (bytes32("PLATFORM_FEES"), bytes32("shopee-fees"));
        }
        uint256 perTx = treasury.pocket(lineId).perTxCapMinor;
        uint128 amount = uint128(bound(amountSeed, 0, perTx + perTx / 4 + 1)); // mostly within, sometimes over
        bytes32 invoice = _pickInvoice(lineId, invoiceSeed);
        PayeeBinding memory before = treasury.payeeBinding(lineId, payeeId);
        bool ready = before.bound && block.timestamp >= before.coolingUntil && _listed(lineId, payeeId);
        uint32 version = registry.planVersion();

        vm.prank(agent);
        try treasury.spend(lineId, payeeId, amount, invoice, version, "decision", "rationale") returns (bytes32 id) {
            spendIds.push(id);
            _amounts[id] = amount;
            ghostSpent += amount;
            ++ghostSpendCount;
            if (!ready) ++ghostUnboundPaid;
            if (treasury.pocket(lineId).pacingMinor == 0 && ++_invoiceUses[invoice] > 1) ++ghostDoubleInvoice;
            if (treasury.rollingSpent(lineId) > treasury.pocket(lineId).windowCapMinor) ++ghostWindowBreach;
        } catch {}
    }

    /// Lower a per-tx or window cap to 50-110 % of its current value (above 100 % must revert NotOwner).
    /// Pause and revoke are unit-tested; here they would end every run.
    function tighten(uint256 kindSeed, uint256 lineSeed, uint256 value) external {
        uint8 kind = uint8(1 + (kindSeed % 2));
        bytes32 lineId = lineIds[lineSeed % lineIds.length];
        uint256 cap = kind == 1 ? treasury.pocket(lineId).perTxCapMinor : treasury.pocket(lineId).windowCapMinor;
        vm.prank(agent);
        try treasury.tighten(kind, lineId, bound(value, cap / 2, cap + cap / 10), "decision") {} catch {}
    }

    function recordDenied(uint256 lineSeed) external {
        bytes32 lineId = lineSeed % 4 == 0 ? lineIds[lineSeed % lineIds.length] : bytes32(0);
        vm.prank(agent);
        try treasury.recordDenied(lineId, "decision", "CAP_EXCEEDED", bytes32(lineSeed)) {} catch {}
    }

    // ---------------------------------------------------------------------------------------------------------
    // Founder re-commits (G0 audit v-1)
    // ---------------------------------------------------------------------------------------------------------

    /// Re-signs the current on-chain state as version n+1 with one field moved up or down. A loosening must revert;
    /// a successful one must leave every cap, expiry and runtime counter where the replan rule allows. Field 5 drops
    /// the line's payees, or re-lists its version-1 payees (a loosening once an earlier replan dropped them).
    function founderReplans(uint256 lineSeed, uint256 fieldSeed, uint256 delta, bool loosen) external {
        (PlanApproval memory a, Line[] memory lines, Stage[] memory stages) = _currentAsNextVersion();
        uint256 d = bound(delta, 1, 2_000);
        uint256 li = lineSeed % lines.length;
        uint256 field = fieldSeed % 6;
        if (field == 0) {
            uint128 c = lines[li].perTxCapMinor;
            if (!loosen && c < d) return;
            lines[li].perTxCapMinor = loosen ? c + uint128(d) : c - uint128(d);
        } else if (field == 1) {
            lines[li].validUntil = loosen ? lines[li].validUntil + uint64(d) : lines[li].validUntil - uint64(d);
        } else if (field == 2) {
            lines[li].windowSeconds = loosen ? lines[li].windowSeconds - uint32(d) : lines[li].windowSeconds + uint32(d);
        } else if (field == 3) {
            a.reserveBps = loosen ? a.reserveBps - uint16(d % 100) : a.reserveBps + uint16(d % 100);
        } else if (field == 4) {
            a.agentExpiry = loosen ? a.agentExpiry + uint64(d) : a.agentExpiry - uint64(d);
        } else {
            lines[li].payeeIds = loosen ? _lines()[li].payeeIds : new bytes32[](0); // stored order == _lines()
        }
        a.linesHash = HogeeTypes.hashLines(lines);
        _snapshot();
        bytes32 digest = HogeeTypes.digest(registry.domainSeparator(), HogeeTypes.hashPlanApproval(a));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(founderPk, digest);
        Sig memory sig = Sig({kind: HogeeKinds.SIG_ECDSA, data: abi.encodePacked(r, s, v)});
        try registry.commitPlan(a, lines, stages, sig) {
            ++ghostReplans;
            if (_loosenedSinceSnapshot()) ++ghostReplanBreach;
        } catch {}
    }

    // ---------------------------------------------------------------------------------------------------------
    // Oracle and clock
    // ---------------------------------------------------------------------------------------------------------

    function settle(uint256 idx, bool confirm) external {
        if (spendIds.length == 0) return;
        bytes32 id = spendIds[idx % spendIds.length];
        uint128 amount = _amounts[id];
        vm.prank(oracle);
        if (confirm) {
            try treasury.confirmSettlement(id, keccak256("ref")) {} catch {}
            return;
        }
        try treasury.failSettlement(id, "INVALID_DESTINATION") {
            ghostRefunded += amount; // returned to the line pocket; the invariants check pocket sums
        } catch {}
    }

    function warp(uint256 dt) external {
        uint256 t = block.timestamp + bound(dt, 0, 3 days);
        if (t > T0 + 59 * DAY) return; // stay inside agent expiry and line validity
        vm.warp(t);
    }

    // ---------------------------------------------------------------------------------------------------------
    // The agent tries every admin entry point (§8.9 invariant 7)
    // ---------------------------------------------------------------------------------------------------------

    function agentTriesAdmin(uint256 which) external {
        uint256 w = which % 10;
        vm.startPrank(agent);
        bool ok;
        if (w == 0) {
            ok = _try(abi.encodeCall(treasury.openFacility, (type(uint128).max, 0)));
        } else if (w == 1) {
            ok = _try(abi.encodeCall(treasury.fund, (1)));
        } else if (w == 2) {
            ok = _try(abi.encodeCall(registry.registerFounderKey, (bytes32(0), bytes32(0), agent)), address(registry));
        } else if (w == 3) {
            ok = _try(abi.encodeCall(treasury.syncPlan, (_sync(), _lines(), _stages())));
        } else if (w == 4) {
            ok = _try(abi.encodeCall(treasury.confirmSettlement, (_lastSpend(), bytes32(0))));
        } else if (w == 5) {
            ok = _try(abi.encodeCall(treasury.failSettlement, (_lastSpend(), "X")));
        } else if (w == 6) {
            ok = _agentBindsPayee();
        } else if (w == 7) {
            ok = _agentCommitsPlan();
        } else if (w == 8) {
            ok = _try(abi.encodeCall(treasury.tighten, (1, "ADS", type(uint128).max, "d")));
        } else {
            ok = _try(abi.encodeCall(treasury.tighten, (3, bytes32(0), 0, "d"))); // lower the reserve to 0
        }
        vm.stopPrank();
        if (ok) ++ghostAdminSuccess;
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    /// The current state (stored lines, Treasury's caps, agent state) re-signed as the next version: tighten-only.
    function _currentAsNextVersion()
        private
        view
        returns (PlanApproval memory a, Line[] memory lines, Stage[] memory stages)
    {
        bytes32[] memory ids = registry.lineIds();
        lines = new Line[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            Line memory l = registry.line(ids[i]);
            Pocket memory p = treasury.pocket(ids[i]);
            (l.amountMinor, l.perTxCapMinor, l.windowCapMinor) = (p.allocatedMinor, p.perTxCapMinor, p.windowCapMinor);
            (l.windowSeconds, l.validUntil, l.pacingMinor) = (p.windowSeconds, p.validUntil, p.pacingMinor);
            l.escrowOnly = p.escrowOnly;
            lines[i] = l;
        }
        bytes32[] memory sIds = registry.stageIds();
        stages = new Stage[](sIds.length);
        for (uint256 i; i < sIds.length; ++i) {
            (stages[i],) = registry.stage(sIds[i]);
        }
        PlanState memory cur = registry.currentPlan();
        a = _planApproval();
        (a.agent, a.version, a.prevPlanHash) = (cur.agent, cur.version + 1, cur.planHash);
        a.planHash = keccak256(abi.encode("hogee/test/replan", cur.version + 1));
        (a.reserveBps, a.agentExpiry) = (cur.reserveBps, cur.agentExpiry);
        a.stagesHash = HogeeTypes.hashStages(stages);
        (a.nonce, a.expiry) = (5000 + cur.version, uint64(block.timestamp + DAY));
    }

    function _snapshot() private {
        _released = treasury.releasedMinor();
        PlanState memory cur = registry.currentPlan();
        (_reserveBefore, _expiryBefore) = (cur.reserveBps, cur.agentExpiry);
        bytes32[] memory ids = registry.lineIds();
        for (uint256 i; i < ids.length; ++i) {
            _pocketBefore[ids[i]] = treasury.pocket(ids[i]);
            _payeesBefore[ids[i]] = registry.line(ids[i]).payeeIds;
        }
    }

    function _loosenedSinceSnapshot() private view returns (bool) {
        if (treasury.releasedMinor() != _released) return true;
        PlanState memory cur = registry.currentPlan();
        if (cur.reserveBps < _reserveBefore || cur.agentExpiry > _expiryBefore || cur.agent != agent) return true;
        bytes32[] memory ids = registry.lineIds();
        for (uint256 i; i < ids.length; ++i) {
            Pocket memory b = _pocketBefore[ids[i]];
            Pocket memory p = treasury.pocket(ids[i]);
            if (p.perTxCapMinor > b.perTxCapMinor || p.windowCapMinor > b.windowCapMinor) return true;
            if (p.validUntil > b.validUntil || p.windowSeconds < b.windowSeconds) return true;
            if (p.pacingMinor > b.pacingMinor || p.allocatedMinor != b.allocatedMinor) return true;
            if (p.spentMinor != b.spentMinor) return true;
            // windowSpentMinor is computed live over the line's window: a longer window (a tightening) can bring an
            // older spend back inside it, so it may rise then; otherwise it must not move, and it may never fall.
            bool longer = p.windowSeconds > b.windowSeconds;
            if (longer ? p.windowSpentMinor < b.windowSpentMinor : p.windowSpentMinor != b.windowSpentMinor) return true;
            if (p.paused != b.paused || p.circuitOpen != b.circuitOpen) return true;
            if (_addsPayee(registry.line(ids[i]).payeeIds, _payeesBefore[ids[i]])) return true;
        }
        return false;
    }

    function _addsPayee(bytes32[] memory payees, bytes32[] storage before) private view returns (bool) {
        for (uint256 i; i < payees.length; ++i) {
            if (!_contains(before, payees[i])) return true;
        }
        return false;
    }

    /// Independent of Treasury's stamp: whether the plan as PlanRegistry stores it lists the payee on the line now.
    function _listed(bytes32 lineId, bytes32 payeeId) private view returns (bool) {
        bytes32[] memory payees = registry.line(lineId).payeeIds;
        for (uint256 i; i < payees.length; ++i) {
            if (payees[i] == payeeId) return true;
        }
        return false;
    }

    function _contains(bytes32[] storage ids, bytes32 id) private view returns (bool) {
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == id) return true;
        }
        return false;
    }

    function spendCount() external view returns (uint256) {
        return spendIds.length;
    }

    function _try(bytes memory data) private returns (bool) {
        return _try(data, address(treasury));
    }

    function _try(bytes memory data, address target) private returns (bool ok) {
        (ok,) = target.call(data);
    }

    function _agentBindsPayee() private returns (bool) {
        SupplierApproval memory a = _supplierApproval();
        (a.payee, a.orderId, a.nonce) = ("0xevil", keccak256(abi.encode(_invoiceSeq++)), 1000 + _invoiceSeq);
        a.expiry = uint64(block.timestamp + DAY);
        bytes32 digest = HogeeTypes.digest(treasury.domainSeparator(), HogeeTypes.hashSupplierApproval(a));
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        return _try(abi.encodeCall(treasury.bindPayee, (a, schedule, autoRelease, _sign(digest))));
    }

    function _agentCommitsPlan() private returns (bool) {
        PlanApproval memory a = _planApproval();
        (a.agent, a.version, a.prevPlanHash, a.nonce) = (agent, 2, a.planHash, 2000 + _invoiceSeq++);
        a.expiry = uint64(block.timestamp + DAY);
        bytes32 digest = HogeeTypes.digest(registry.domainSeparator(), HogeeTypes.hashPlanApproval(a));
        return _try(abi.encodeCall(registry.commitPlan, (a, _lines(), _stages(), _sign(digest))), address(registry));
    }

    function _sign(bytes32 digest) private view returns (Sig memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        return Sig({kind: HogeeKinds.SIG_ECDSA, data: abi.encodePacked(r, s, v)});
    }

    function _sync() private view returns (PlanSync memory) {
        return PlanSync(PLAN_ID, 9, type(uint128).max, agent, uint64(block.timestamp + 80 * DAY), 0);
    }

    function _lastSpend() private view returns (bytes32) {
        return spendIds.length == 0 ? bytes32(0) : spendIds[spendIds.length - 1];
    }

    /// Mostly fresh invoices; sometimes a reused one (T17) or, on ADS, the next or a wrong pacing slot.
    function _pickInvoice(bytes32 lineId, uint256 seed) private returns (bytes32) {
        if (lineId == "ADS") {
            uint256 next = treasury.lineSequence(lineId);
            return bytes32(seed % 4 == 0 ? next + (seed % 3) - 1 : next);
        }
        if (seed % 5 == 0 && _invoiceSeq > 0) return keccak256(abi.encode(seed % _invoiceSeq));
        return keccak256(abi.encode(_invoiceSeq++));
    }
}
