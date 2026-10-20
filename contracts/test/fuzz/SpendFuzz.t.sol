// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pocket} from "../../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../../src/interfaces/IHogeeBase.sol";
import {HogeeTestBase} from "../utils/HogeeTestBase.sol";

/// §8.9 fuzz of spend: random sequences of amounts and clock jumps (including exactly at, one before and one after
/// the moment the oldest spend leaves the window) against an independent sliding-window model. Every call must
/// succeed exactly when the model says the caps allow it, and otherwise revert CapExceeded.
contract SpendFuzzTest is HogeeTestBase {
    struct Entry {
        uint64 t;
        uint128 amount;
    }

    struct LineModel {
        bytes32 lineId;
        bytes32 payeeId;
        uint128 perTx;
        uint128 windowCap;
        uint128 allocated;
        uint128 spent;
        Entry[] entries;
    }

    LineModel[2] internal models;
    uint256 internal seed;
    uint256 internal draws;
    uint128 internal totalOut;

    function setUp() public override {
        super.setUp();
        _setUpRina();
        _initModel(0, L_LOGISTICS, P_LOGISTICS);
        _initModel(1, L_FEES, P_FEES);
    }

    function testFuzz_Spend_MatchesSlidingWindowModel(uint256 seed_) public {
        seed = seed_;
        uint64 deadline = T0 + 55 * DAY;
        for (uint256 step; step < 24; ++step) {
            LineModel storage m = models[_draw(2)];
            uint128 amount = _amount(m);
            vm.warp(_nextTime(m, deadline));
            bool ok = _predict(m, amount);
            uint32 version = registry.planVersion();
            vm.prank(agent);
            try treasury.spend(m.lineId, m.payeeId, amount, _invoice(step), version, "d", "r") {
                assertTrue(ok, "spend succeeded but the model says a cap is exceeded");
                m.entries.push(Entry(uint64(vm.getBlockTimestamp()), amount));
                m.spent += amount;
                totalOut += amount;
            } catch (bytes memory err) {
                assertFalse(ok, "spend reverted but the model says it fits");
                assertEq(bytes4(err), IHogeeErrors.CapExceeded.selector);
            }
            assertEq(treasury.rollingSpent(m.lineId), _rolling(m), "rollingSpent != model");
            Pocket memory p = treasury.pocket(m.lineId);
            assertEq(p.spentMinor, m.spent);
            assertLe(p.windowSpentMinor, m.windowCap);
        }
        assertEq(treasury.balances().spentMinor, totalOut);
    }

    /// Nobody but the agent spends, and the agent never pays a payee that is not bound to the line (T1).
    function testFuzz_Spend_NeverPaysAnUnboundPayeeOrForeignCaller(address caller, bytes32 payee, uint128 amount)
        public
    {
        vm.assume(payee != P_LOGISTICS);
        amount = uint128(bound(amount, 0, 20_000));
        vm.prank(caller);
        if (caller != agent) {
            vm.expectRevert(IHogeeErrors.NotAgent.selector);
        } else {
            vm.expectRevert(IHogeeErrors.PayeeNotBound.selector);
        }
        treasury.spend(L_LOGISTICS, payee, amount, _invoice(1), 1, "d", "r");
    }

    // ---------------------------------------------------------------------------------------------------------
    // model
    // ---------------------------------------------------------------------------------------------------------

    function _initModel(uint256 i, bytes32 lineId, bytes32 payeeId) private {
        Pocket memory p = treasury.pocket(lineId);
        LineModel storage m = models[i];
        m.lineId = lineId;
        m.payeeId = payeeId;
        m.perTx = p.perTxCapMinor;
        m.windowCap = p.windowCapMinor;
        m.allocated = p.allocatedMinor;
    }

    function _rolling(LineModel storage m) private view returns (uint128 sum) {
        for (uint256 i; i < m.entries.length; ++i) {
            if (vm.getBlockTimestamp() < uint256(m.entries[i].t) + WINDOW) sum += m.entries[i].amount;
        }
    }

    /// A zero amount never fits (run-2 audit).
    function _predict(LineModel storage m, uint128 amount) private view returns (bool) {
        return amount > 0 && amount <= m.perTx && _rolling(m) + amount <= m.windowCap && m.spent + amount <= m.allocated
            && totalOut + amount <= 400_000;
    }

    /// Amounts cluster around the caps: exactly the per-tx cap, just over it, the remaining window headroom, zero,
    /// random.
    function _amount(LineModel storage m) private returns (uint128) {
        uint256 r = _draw(6);
        if (r == 5) return 0;
        if (r == 0) return m.perTx;
        if (r == 1) return m.perTx + 1;
        if (r == 2) {
            uint128 rolling = _rolling(m);
            return rolling >= m.windowCap ? 1 : m.windowCap - rolling;
        }
        return uint128(_draw(uint256(m.perTx) + 2_000));
    }

    /// Clock jumps: none, 1 s, up to a day, or exactly at / one before / one after the oldest live entry's expiry.
    function _nextTime(LineModel storage m, uint64 deadline) private returns (uint256 t) {
        t = vm.getBlockTimestamp();
        uint256 r = _draw(6);
        if (r == 1) {
            t += 1;
        } else if (r == 2) {
            t += _draw(DAY);
        } else if (r >= 3) {
            uint256 expiry = _oldestLiveExpiry(m);
            if (expiry != 0) {
                uint256 target = expiry + r - 4; // r 3 -> expiry - 1, r 4 -> expiry, r 5 -> expiry + 1
                if (target > t) t = target;
            }
        }
        if (t > deadline) t = vm.getBlockTimestamp();
    }

    function _oldestLiveExpiry(LineModel storage m) private view returns (uint256) {
        for (uint256 i; i < m.entries.length; ++i) {
            uint256 e = uint256(m.entries[i].t) + WINDOW;
            if (vm.getBlockTimestamp() < e) return e;
        }
        return 0;
    }

    function _draw(uint256 n) private returns (uint256) {
        return uint256(keccak256(abi.encode(seed, draws++))) % n;
    }
}
