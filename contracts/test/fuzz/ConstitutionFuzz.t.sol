// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PlanApproval, Line, Stage, Sig, HogeeKinds} from "../../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../../src/interfaces/HogeeTypes.sol";
import {HogeeTestBase} from "../utils/HogeeTestBase.sol";

/// §8.9 fuzz: random manifests must either revert PlanInvariantViolated(code) or satisfy the constitution.
/// Differential: an independent reference model written from §8.3 + the require table predicts the exact code
/// (precedence 13, 12, then lowest 1-10); commitPlan must agree on every input. The TS mirror (task 1.10) can reuse
/// the same generator rules.
contract ConstitutionFuzzTest is HogeeTestBase {
    struct Gen {
        uint256 seed;
        uint256 i;
        bool noisy;
    }

    function setUp() public override {
        super.setUp();
        _openFacility();
        _registerFounder();
    }

    function testFuzz_CommitPlan_RevertsIffConstitutionViolated(uint256 seed) public {
        Gen memory g = Gen(seed, 0, false);
        (PlanApproval memory a, Line[] memory lines, Stage[] memory stages) = _randomPlan(g);
        uint8 expected = _referenceCode(a, lines, stages);
        Sig memory sig = _signPlan(a);
        if (expected != 0) {
            vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, expected));
            registry.commitPlan(a, lines, stages, sig);
            return;
        }
        registry.commitPlan(a, lines, stages, sig);
        // The stored plan satisfies the constitution (invariant 6, read back from storage).
        assertEq(registry.planVersion(), 1);
        Line[] memory stored = new Line[](lines.length);
        bytes32[] memory ids = registry.lineIds();
        for (uint256 i; i < ids.length; ++i) {
            stored[i] = registry.line(ids[i]);
        }
        assertEq(HogeeTypes.hashLines(stored), a.linesHash);
        assertEq(_referenceCode(a, stored, stages), 0);
    }

    /// A shrunk, mostly-valid variant: random perturbations of the Rina plan around each limit.
    function testFuzz_CommitPlan_RinaPerturbations(uint8 which, uint128 delta) public {
        delta = uint128(bound(delta, 1, 50_000));
        Line[] memory lines = _lines();
        Stage[] memory stages = _stages();
        PlanApproval memory a = _rinaApproval();
        uint8 expected;
        uint256 k = which % 6;
        if (k == 0) {
            lines[k].perTxCapMinor += delta;
            expected = 4;
        } else if (k == 1) {
            lines[k].windowCapMinor += delta;
            expected = 5;
        } else if (k == 2) {
            lines[k].validUntil = T0 + 90 * DAY + uint64(delta);
            expected = 6;
        } else if (k == 3) {
            a.reserveBps = uint16(299 - (delta % 300)); // below the 300 floor
            expected = 7;
        } else if (k == 4) {
            (stages[0].releaseMinor, stages[1].releaseMinor) = (400_000 + delta, 600_000 - delta);
            expected = 8;
        } else {
            a.agentExpiry = T0 + 90 * DAY + uint64(delta);
            expected = 2;
        }
        a.linesHash = HogeeTypes.hashLines(lines);
        a.stagesHash = HogeeTypes.hashStages(stages);
        assertEq(_referenceCode(a, lines, stages), expected);
        Sig memory sig = _signPlan(a);
        vm.expectRevert(abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, expected));
        registry.commitPlan(a, lines, stages, sig);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Generator
    // ---------------------------------------------------------------------------------------------------------

    /// Half the seeds build a clean plan (values at or under every limit); the other half inject faults at
    /// moderate rates, so every code 1-13 and the success path are all reached.
    function _randomPlan(Gen memory g)
        private
        view
        returns (PlanApproval memory a, Line[] memory lines, Stage[] memory stages)
    {
        g.noisy = _pick(g, 2) == 0;
        uint256 nLines = _bad(g, 20) ? _pick(g, 19) : 1 + _pick(g, 7);
        lines = new Line[](nLines);
        uint256 sum;
        for (uint256 i; i < nLines; ++i) {
            lines[i] = _randomLine(g, i);
            if (i == 0 && _bad(g, 10)) lines[i].amountMinor += 1_000_000; // code 1: over the facility cap
            sum += lines[i].amountMinor;
        }
        uint128 total = uint128(sum);
        if (_bad(g, 12)) total += 1; // totals mismatch
        stages = _randomStages(g, total);
        a = _rinaApproval();
        a.totalMinor = total;
        a.reserveBps =
            _bad(g, 6) ? uint16(_pick(g, 2) == 0 ? _pick(g, 300) : _pick(g, 10_100)) : uint16(300 + _pick(g, 300));
        a.agentExpiry = _bad(g, 8) ? uint64(JUDGING_END - _pick(g, 2)) : uint64(JUDGING_END + 1 + _pick(g, 30 * DAY));
        if (_bad(g, 10)) a.agentExpiry = uint64(T0 + 90 * DAY + 1 + _pick(g, DAY));
        if (_bad(g, 30)) a.agent = address(0);
        if (_bad(g, 40)) a.agent = _pick(g, 2) == 0 ? founder : lender; // role collision
        a.linesHash = HogeeTypes.hashLines(lines);
        a.stagesHash = HogeeTypes.hashStages(stages);
    }

    function _randomLine(Gen memory g, uint256 i) private pure returns (Line memory l) {
        l.lineId = bytes32(i + 100);
        if (i == 0 && _pick(g, 3) == 0) l.lineId = HogeeKinds.LINE_SUPPLIER;
        if (_bad(g, 30)) l.lineId = bytes32(0);
        if (_bad(g, 30)) l.lineId = bytes32(uint256(100)); // duplicates line 0 unless i == 0
        uint128 amount = uint128(_pick(g, 200_000));
        l.amountMinor = amount;
        l.perTxCapMinor = _nearLimit(g, amount / 4);
        l.windowCapMinor = _nearLimit(g, amount / 2);
        l.windowSeconds = _bad(g, 30) ? 0 : WINDOW;
        l.validUntil = _bad(g, 15) ? uint64(T0 + 90 * DAY + 1) : uint64(T0 + 30 * DAY + _pick(g, 60 * DAY + 1));
        l.pacingMinor = _pick(g, 4) == 0 ? uint128(_pick(g, 20_000)) : 0;
        l.escrowOnly = l.lineId == HogeeKinds.LINE_SUPPLIER ? !_bad(g, 4) : _pick(g, 4) == 0;
        l.payeeIds = _randomPayees(g);
    }

    function _randomPayees(Gen memory g) private pure returns (bytes32[] memory ids) {
        if (_bad(g, 25)) {
            ids = new bytes32[](9); // too many
            for (uint256 p; p < 9; ++p) {
                ids[p] = bytes32(p + 1);
            }
            return ids;
        }
        bytes32[3] memory platform = [P_ADS, P_FEES, P_LOGISTICS];
        uint256 n = _pick(g, 4);
        uint256 start = _pick(g, 3);
        ids = new bytes32[](n);
        for (uint256 p; p < n; ++p) {
            ids[p] = platform[(start + p) % 3];
        }
        if (n > 0 && _bad(g, 8)) ids[_pick(g, n)] = "0xevil"; // code 9
        if (n > 0 && _bad(g, 30)) ids[_pick(g, n)] = bytes32(0);
        if (n > 1 && _bad(g, 20)) ids[1] = ids[0];
    }

    function _randomStages(Gen memory g, uint128 total) private pure returns (Stage[] memory stages) {
        uint256 n = _bad(g, 20) ? _pick(g, 10) : 2 + _pick(g, 2);
        stages = new Stage[](n);
        if (n == 0) return stages;
        uint128 first = uint128((uint256(total) * (250 + _pick(g, 150))) / 1000); // 25-39.9 %
        if (_bad(g, 6)) first = uint128((uint256(total) * 4) / 10 + 1 + _pick(g, 1000)); // over 40 %
        if (first > total || n == 1) first = total;
        stages[0] = Stage("stage-0", first, _bad(g, 30) ? 1 : 0, 0, 0);
        uint128 rest = total - first;
        uint128 each = rest / uint128(n - 1 == 0 ? 1 : n - 1);
        for (uint256 i = 1; i < n; ++i) {
            uint128 part = i == n - 1 ? rest - each * uint128(n - 2) : each;
            uint8 metric = _bad(g, 30) ? uint8(_pick(g, 2) * 3) : uint8(1 + _pick(g, 2)); // 0 or 3 when bad
            bytes32 id = _bad(g, 40) ? bytes32(0) : bytes32(i + 1);
            stages[i] = Stage(id, part, metric, 100_000, T0 + 30 * DAY);
        }
    }

    function _nearLimit(Gen memory g, uint128 limit) private pure returns (uint128) {
        if (_bad(g, 10)) return limit + 1 + uint128(_pick(g, 10_000));
        if (_pick(g, 2) == 0) return limit;
        return limit > 0 ? uint128(_pick(g, limit)) : 0;
    }

    function _bad(Gen memory g, uint256 n) private pure returns (bool) {
        return g.noisy && _pick(g, n) == 0;
    }

    function _pick(Gen memory g, uint256 n) private pure returns (uint256) {
        if (n == 0) return 0;
        return uint256(keccak256(abi.encode(g.seed, g.i++))) % n;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Reference model (§8.3 + require table), independent of PlanConstitution.sol
    // ---------------------------------------------------------------------------------------------------------

    function _referenceCode(PlanApproval memory a, Line[] memory lines, Stage[] memory stages)
        private
        view
        returns (uint8)
    {
        if (_refMalformed(a, lines, stages)) return 13;
        uint256 sl;
        for (uint256 i; i < lines.length; ++i) {
            sl += lines[i].amountMinor;
        }
        uint256 ss;
        for (uint256 i; i < stages.length; ++i) {
            ss += stages[i].releaseMinor;
        }
        if (sl != a.totalMinor || ss != a.totalMinor) return 12;
        bool[11] memory v;
        v[1] = a.totalMinor > 1_000_000;
        v[2] = a.agentExpiry > block.timestamp + 90 days;
        v[3] = a.agentExpiry <= JUDGING_END;
        for (uint256 i; i < lines.length; ++i) {
            Line memory l = lines[i];
            if (uint256(l.perTxCapMinor) * 10_000 > uint256(l.amountMinor) * 2_500) v[4] = true;
            if (uint256(l.windowCapMinor) * 10_000 > uint256(l.amountMinor) * 5_000) v[5] = true;
            if (l.validUntil > block.timestamp + 90 days) v[6] = true;
            for (uint256 p; p < l.payeeIds.length; ++p) {
                bytes32 id = l.payeeIds[p];
                if (id != P_ADS && id != P_FEES && id != P_LOGISTICS) v[9] = true;
            }
            if (l.lineId == "SUPPLIER" && !l.escrowOnly) v[10] = true;
        }
        v[7] = a.reserveBps < 300;
        v[8] = uint256(stages[0].releaseMinor) * 100 > uint256(a.totalMinor) * 40;
        for (uint8 c = 1; c <= 10; ++c) {
            if (v[c]) return c;
        }
        return 0;
    }

    function _refMalformed(PlanApproval memory a, Line[] memory lines, Stage[] memory stages)
        private
        view
        returns (bool)
    {
        if (a.agent == founder || a.agent == lender) return true;
        if (lines.length < 1 || lines.length > 16 || stages.length < 1 || stages.length > 8) return true;
        if (a.totalMinor == 0 || a.agent == address(0) || a.reserveBps > 10_000) return true;
        for (uint256 i; i < lines.length; ++i) {
            if (lines[i].lineId == 0 || lines[i].windowSeconds == 0 || lines[i].payeeIds.length > 8) return true;
            for (uint256 j; j < lines.length; ++j) {
                if (j != i && lines[j].lineId == lines[i].lineId) return true;
            }
            bytes32[] memory ps = lines[i].payeeIds;
            for (uint256 p; p < ps.length; ++p) {
                if (ps[p] == 0) return true;
                for (uint256 q; q < ps.length; ++q) {
                    if (q != p && ps[q] == ps[p]) return true;
                }
            }
        }
        for (uint256 i; i < stages.length; ++i) {
            if (stages[i].stageId == 0) return true;
            for (uint256 j; j < stages.length; ++j) {
                if (j != i && stages[j].stageId == stages[i].stageId) return true;
            }
            uint8 m = stages[i].metric;
            if (i == 0 ? m != 0 : (m != 1 && m != 2)) return true;
        }
        return false;
    }
}
