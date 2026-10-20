// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PlanApproval, Line, Stage, ITreasury, HogeeKinds} from "./interfaces/IHogee.sol";
import {ITreasuryHooks} from "./HogeeHooks.sol";

/// @title PlanConstitution: the on-chain constitution (§8.3, D7) checked by PlanRegistry.commitPlan.
/// @notice Pure rules over the signed plan plus Treasury reads (facility, oracle, payee registry). A plan that breaks a
///         rule reverts PlanInvariantViolated(code) even with a valid founder signature (T21).
///         Precedence when several rules fail: 13 (malformed), then 12 (totals), then the lowest of 1-10.
///         Code 11 (payee cap vs schedule) is enforced in Treasury.bindPayee: a plan carries no payee caps.
///         The TS mirror (task 1.10) must follow the same order. See docs/assurance/require-table-loop1.md.
library PlanConstitution {
    uint256 internal constant MAX_LINES = 16;
    uint256 internal constant MAX_STAGES = 8;
    uint256 internal constant MAX_PAYEES_PER_LINE = 8;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_HORIZON = 90 days;

    /// Inputs that do not come from the signed plan.
    struct Context {
        uint128 capMinor; // Treasury.facility().capMinor
        uint16 reserveFloorBps; // Treasury.facility().reserveFloorBps
        uint64 now_; // _now()
        uint64 judgingWindowEnd; // PlanRegistry immutable
        address treasury;
        address ownerEOA; // registered founder EOA (0 for a passkey-only owner)
        address lender;
        address oracle; // Treasury.oracle()
        address observer; // Treasury.observer() (0 = none; the agent is never 0, so it cannot match)
    }

    /// @return code 0 if the plan satisfies the constitution, else the HogeeKinds.CONST_* code to revert with.
    function check(PlanApproval calldata a, Line[] calldata lines, Stage[] calldata stages, Context memory ctx)
        internal
        view
        returns (uint8 code)
    {
        if (_malformed(a, lines, stages)) return HogeeKinds.CONST_MALFORMED_PLAN;
        // Role separation (decision): the agent key can never be an owner, lender or oracle key, or "alone, the agent
        // can only tighten" (§13.1 #2) would not hold. As the oracle it could failSettlement its own spends to refund
        // the counters and spend past allocation, released and funded (run-2 audit). Nor the observer: its
        // cancelLoosen veto survives TIGHTEN_REVOKE_AGENT and could cancel every UNPAUSE (audit run-3).
        if (a.agent == ctx.ownerEOA || a.agent == ctx.lender || a.agent == ctx.oracle || a.agent == ctx.observer) {
            return HogeeKinds.CONST_MALFORMED_PLAN;
        }
        if (_totalsMismatch(a.totalMinor, lines, stages)) return HogeeKinds.CONST_TOTALS_MISMATCH;
        if (a.totalMinor > ctx.capMinor) return HogeeKinds.CONST_LINES_EXCEED_FACILITY_CAP;
        uint256 horizon = uint256(ctx.now_) + MAX_HORIZON;
        if (a.agentExpiry > horizon) return HogeeKinds.CONST_AGENT_EXPIRY_TOO_LATE;
        if (a.agentExpiry <= ctx.judgingWindowEnd) return HogeeKinds.CONST_AGENT_EXPIRY_TOO_EARLY;
        code = _lineCode(lines, horizon);
        if (code != 0) return code;
        if (a.reserveBps < ctx.reserveFloorBps) return HogeeKinds.CONST_RESERVE_BELOW_FLOOR;
        if (uint256(stages[0].releaseMinor) * 10 > uint256(a.totalMinor) * 4) {
            return HogeeKinds.CONST_STAGE1_OVER_40PCT;
        }
        if (_addsPayee(lines, ctx.treasury)) return HogeeKinds.CONST_PLAN_ADDS_PAYEE;
        if (_supplierNotEscrow(lines)) return HogeeKinds.CONST_SUPPLIER_LINE_NOT_ESCROW;
        return 0;
    }

    /// Code 13: shape rules (G0-DECISION) that keep commitPlan's gas bounded and ids unambiguous.
    function _malformed(PlanApproval calldata a, Line[] calldata lines, Stage[] calldata stages)
        private
        pure
        returns (bool)
    {
        if (lines.length == 0 || lines.length > MAX_LINES) return true;
        if (stages.length == 0 || stages.length > MAX_STAGES) return true;
        if (a.totalMinor == 0 || a.agent == address(0) || a.reserveBps > BPS) return true;
        for (uint256 i; i < lines.length; ++i) {
            if (_lineMalformed(lines, i)) return true;
        }
        for (uint256 i; i < stages.length; ++i) {
            Stage calldata s = stages[i];
            if (s.stageId == bytes32(0)) return true;
            for (uint256 j; j < i; ++j) {
                if (stages[j].stageId == s.stageId) return true;
            }
            if (i == 0) {
                if (s.metric != HogeeKinds.METRIC_NONE) return true;
            } else if (s.metric != HogeeKinds.METRIC_SALES_MINOR && s.metric != HogeeKinds.METRIC_ORDERS) {
                return true;
            }
        }
        return false;
    }

    function _lineMalformed(Line[] calldata lines, uint256 i) private pure returns (bool) {
        Line calldata l = lines[i];
        if (l.lineId == bytes32(0) || l.windowSeconds == 0) return true;
        for (uint256 j; j < i; ++j) {
            if (lines[j].lineId == l.lineId) return true;
        }
        uint256 n = l.payeeIds.length;
        if (n > MAX_PAYEES_PER_LINE) return true;
        for (uint256 p; p < n; ++p) {
            if (l.payeeIds[p] == bytes32(0)) return true;
            for (uint256 q; q < p; ++q) {
                if (l.payeeIds[q] == l.payeeIds[p]) return true;
            }
        }
        return false;
    }

    /// Code 12: sum(lines) and sum(stages) must both equal totalMinor.
    function _totalsMismatch(uint128 totalMinor, Line[] calldata lines, Stage[] calldata stages)
        private
        pure
        returns (bool)
    {
        uint256 sumLines = 0;
        for (uint256 i; i < lines.length; ++i) {
            sumLines += lines[i].amountMinor;
        }
        uint256 sumStages = 0;
        for (uint256 i; i < stages.length; ++i) {
            sumStages += stages[i].releaseMinor;
        }
        return sumLines != totalMinor || sumStages != totalMinor;
    }

    /// Codes 4, 5, 6: the lowest one any line violates (0 if none).
    function _lineCode(Line[] calldata lines, uint256 horizon) private pure returns (uint8) {
        bool perTx = false;
        bool window = false;
        bool validity = false;
        for (uint256 i; i < lines.length; ++i) {
            Line calldata l = lines[i];
            uint256 amount = l.amountMinor;
            if (uint256(l.perTxCapMinor) * 4 > amount) perTx = true;
            if (uint256(l.windowCapMinor) * 2 > amount) window = true;
            if (l.validUntil > horizon) validity = true;
        }
        if (perTx) return HogeeKinds.CONST_PER_TX_CAP_OVER_25PCT;
        if (window) return HogeeKinds.CONST_WINDOW_CAP_OVER_50PCT;
        if (validity) return HogeeKinds.CONST_LINE_VALIDITY_TOO_LONG;
        return 0;
    }

    /// Code 9: every listed payee is bound to that line, or is a static platform payee (a plan cannot add payees).
    /// The loop is bounded (code 13 caps it at 16 lines x 8 payees) and only reads this deployment's Treasury.
    function _addsPayee(Line[] calldata lines, address treasury) private view returns (bool) {
        for (uint256 i; i < lines.length; ++i) {
            Line calldata l = lines[i];
            for (uint256 p; p < l.payeeIds.length; ++p) {
                bytes32 payee = l.payeeIds[p];
                // forge-lint: disable-next-line(calls-loop)
                if (ITreasury(treasury).payeeBinding(l.lineId, payee).bound) continue;
                // forge-lint: disable-next-line(calls-loop)
                if (ITreasuryHooks(treasury).platformPayoutAccountHash(payee) != bytes32(0)) continue;
                return true;
            }
        }
        return false;
    }

    /// Code 10: the SUPPLIER line must be escrowOnly.
    function _supplierNotEscrow(Line[] calldata lines) private pure returns (bool) {
        for (uint256 i; i < lines.length; ++i) {
            if (lines[i].lineId == HogeeKinds.LINE_SUPPLIER && !lines[i].escrowOnly) return true;
        }
        return false;
    }
}
