// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PlanApproval, Line, Pocket, Sig, HogeeKinds} from "../../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "../utils/HogeeTestBase.sol";

/// G0 audit v-1 fuzz: a random v2 keeps, tightens or loosens every field the replan rule covers, starting from a
/// v1 whose caps the agent may already have tightened. An independent model says whether the v2 loosens the
/// current state. commitPlan must revert PlanInvariantViolated(14) iff the model says so, and after any successful
/// re-commit no cap, expiry or pacing went up, no window got shorter, the reserve did not drop, and releasedMinor
/// and every runtime counter are unchanged. Codes 1-13 never fire: every value stays inside the constitution.
contract ReplanFuzzTest is HogeeTestBase {
    uint8 private constant KEEP = 0;
    uint8 private constant TIGHTEN = 1;
    uint8 private constant LOOSEN = 2;

    uint256 private _seed;
    uint256 private _n;
    bool private _loosens; // the model's verdict for the current run
    bytes32[] private _ids;
    mapping(bytes32 lineId => Pocket) private _before;
    mapping(bytes32 lineId => uint128) private _windowBefore;
    mapping(bytes32 lineId => uint64) private _sequenceBefore;

    function setUp() public override {
        super.setUp();
        _setUpRina();
        _spend(L_LOGISTICS, P_LOGISTICS, 15_000, _invoice(1));
        _spendAds(1, 7_500);
    }

    function testFuzz_Recommit_RevertsIffItLoosensAndNeverChangesRuntimeState(uint256 seed) public {
        (_seed, _n, _loosens) = (seed, 0, false);
        _agentTightensSomeCaps();
        _snapshot();

        Line[] memory lines = _lines();
        for (uint256 i; i < lines.length; ++i) {
            _perturbLine(lines[i]);
        }
        PlanApproval memory a = _approvalV2(lines, _stages());
        a.reserveBps = _perturbReserve(registry.currentPlan().reserveBps);
        a.agentExpiry = _perturbExpiry(treasury.agentExpiry());

        Sig memory sig = _signPlan(a);
        if (_loosens) {
            vm.expectRevert(
                abi.encodeWithSelector(IHogeeErrors.PlanInvariantViolated.selector, HogeeKinds.CONST_REPLAN_LOOSENS)
            );
            registry.commitPlan(a, lines, _stages(), sig);
            return;
        }
        uint16 reserveBefore = registry.currentPlan().reserveBps;
        uint64 expiryBefore = treasury.agentExpiry();
        registry.commitPlan(a, lines, _stages(), sig);
        assertEq(registry.planVersion(), 2);
        assertEq(treasury.releasedMinor(), 400_000, "releasedMinor changed");
        assertGe(registry.currentPlan().reserveBps, reserveBefore, "reserve dropped");
        assertLe(treasury.agentExpiry(), expiryBefore, "agent expiry extended");
        assertEq(registry.currentPlan().agent, agent);
        for (uint256 i; i < _ids.length; ++i) {
            _assertNoLineLoosened(_ids[i]);
        }
    }

    /// Run-2 audit: after a re-commit that drops a random subset of the listed payees, spend pays exactly the payees
    /// the current version lists. A dropped payee reverts PayeeNotBound although its binding data stays.
    function testFuzz_Recommit_SpendPaysOnlyPayeesTheCurrentVersionLists(uint8 mask) public {
        bytes32[3] memory ids = [L_LOGISTICS, L_ADS, L_FEES];
        bytes32[3] memory payees = [P_LOGISTICS, P_ADS, P_FEES];
        Line[] memory lines = _lines();
        for (uint256 i; i < 3; ++i) {
            if (mask & (1 << i) != 0) lines[_lineIndex(lines, ids[i])].payeeIds = new bytes32[](0);
        }
        _commit(_approvalV2(lines, _stages()), lines, _stages());
        for (uint256 i; i < 3; ++i) {
            assertTrue(treasury.payeeBinding(ids[i], payees[i]).bound, "binding data must stay");
            bytes32 invoice = ids[i] == L_ADS ? bytes32(uint256(2)) : _invoice(100 + i); // ADS slot 1 is paid
            vm.prank(agent);
            if (mask & (1 << i) != 0) vm.expectRevert(IHogeeErrors.PayeeNotBound.selector);
            treasury.spend(ids[i], payees[i], 1, invoice, 2, "d", "r");
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Generator + model
    // ---------------------------------------------------------------------------------------------------------

    function _rand(uint256 n) private returns (uint256) {
        return uint256(keccak256(abi.encode(_seed, _n++))) % n;
    }

    /// About 30 fields move per run; a 1/32 loosening rate gives a mix of committed (~1/3) and reverted runs.
    function _mode() private returns (uint8) {
        uint256 r = _rand(32);
        if (r == 0) return LOOSEN;
        return r < 12 ? TIGHTEN : KEEP;
    }

    /// Half of the runs start from caps the agent already lowered (the replan must not undo them).
    function _agentTightensSomeCaps() private {
        if (_rand(2) == 0) return;
        vm.startPrank(agent);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_LOGISTICS, 15_000 + _rand(5_000), "d");
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP, L_ADS, 30_000 + _rand(30_000), "d");
        treasury.tighten(HogeeKinds.TIGHTEN_RAISE_RESERVE_BPS, 0, 500 + _rand(200), "d");
        vm.stopPrank();
    }

    function _snapshot() private {
        _ids = registry.lineIds();
        for (uint256 i; i < _ids.length; ++i) {
            bytes32 id = _ids[i];
            _before[id] = treasury.pocket(id);
            _windowBefore[id] = treasury.rollingSpent(id);
            _sequenceBefore[id] = treasury.lineSequence(id);
        }
    }

    /// Starts from the current Treasury pocket (so KEEP is never a loosening) and moves each field.
    function _perturbLine(Line memory l) private {
        Pocket memory p = _before[l.lineId];
        l.perTxCapMinor = _perturbCap(p.perTxCapMinor, l.amountMinor / 4);
        l.windowCapMinor = _perturbCap(p.windowCapMinor, l.amountMinor / 2);
        l.validUntil = _perturbValidUntil(p.validUntil);
        l.windowSeconds = _perturbWindow(p.windowSeconds);
        l.pacingMinor = _perturbPacing(p.pacingMinor);
        l.escrowOnly = p.escrowOnly || (l.lineId != L_SUPPLIER && _rand(8) == 0); // only ever set (tighter)
    }

    /// A cap moves within [0, constitution max]; above the current value is a loosening.
    function _perturbCap(uint128 current, uint128 max) private returns (uint128) {
        uint8 m = _mode();
        if (m == TIGHTEN && current > 0) return uint128(_rand(current));
        if (m == LOOSEN && current < max) {
            _loosens = true;
            return current + 1 + uint128(_rand(max - current));
        }
        return current;
    }

    function _perturbValidUntil(uint64 current) private returns (uint64) {
        uint8 m = _mode();
        if (m == TIGHTEN) return current - 1 - uint64(_rand(5 days));
        if (m == LOOSEN) {
            _loosens = true;
            return current + 1 + uint64(_rand(5 days)); // still <= now + 90 days (code 6)
        }
        return current;
    }

    /// A longer window is tighter; a shorter one loosens.
    function _perturbWindow(uint32 current) private returns (uint32) {
        uint8 m = _mode();
        if (m == TIGHTEN) return current + 1 + uint32(_rand(1 days));
        if (m == LOOSEN) {
            _loosens = true;
            return current - 1 - uint32(_rand(1 days));
        }
        return current;
    }

    /// Pacing may only go down and never to 0; an invoice line (0) must stay 0.
    function _perturbPacing(uint128 current) private returns (uint128) {
        uint8 m = _mode();
        if (m == TIGHTEN && current > 1) return 1 + uint128(_rand(current - 1));
        if (m == LOOSEN) {
            _loosens = true;
            if (current != 0 && _rand(2) == 0) return 0;
            return current + 1 + uint128(_rand(1_000));
        }
        return current;
    }

    /// Never below the 300 floor (code 7).
    function _perturbReserve(uint16 current) private returns (uint16) {
        uint8 m = _mode();
        if (m == TIGHTEN) return current + 1 + uint16(_rand(100));
        if (m == LOOSEN && current > 300) {
            _loosens = true;
            return current - 1 - uint16(_rand(current - 300));
        }
        return current;
    }

    /// Stays after the judging window (code 3) and within now + 90 days (code 2).
    function _perturbExpiry(uint64 current) private returns (uint64) {
        uint8 m = _mode();
        if (m == TIGHTEN) return current - 1 - uint64(_rand(2 days));
        if (m == LOOSEN) {
            _loosens = true;
            return current + 1 + uint64(_rand(2 days));
        }
        return current;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Property after a successful re-commit
    // ---------------------------------------------------------------------------------------------------------

    function _assertNoLineLoosened(bytes32 id) private view {
        Pocket memory b = _before[id];
        Pocket memory p = treasury.pocket(id);
        assertLe(p.perTxCapMinor, b.perTxCapMinor, "per-tx cap raised");
        assertLe(p.windowCapMinor, b.windowCapMinor, "window cap raised");
        assertLe(p.validUntil, b.validUntil, "validUntil extended");
        assertGe(p.windowSeconds, b.windowSeconds, "window shortened");
        assertLe(p.pacingMinor, b.pacingMinor, "pacing raised");
        assertEq(p.pacingMinor == 0, b.pacingMinor == 0, "pacing switched on or off");
        assertTrue(p.escrowOnly || !b.escrowOnly, "escrowOnly cleared");
        assertEq(p.allocatedMinor, b.allocatedMinor, "allocation moved");
        assertEq(p.spentMinor, b.spentMinor, "spent changed");
        assertEq(p.paused, b.paused, "line pause changed");
        assertEq(p.circuitOpen, b.circuitOpen, "circuit changed");
        assertEq(treasury.rollingSpent(id), _windowBefore[id], "window spend changed");
        if (p.pacingMinor != 0) assertEq(treasury.lineSequence(id), _sequenceBefore[id], "lineSequence changed");
    }
}
