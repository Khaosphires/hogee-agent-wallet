// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// ---------------------------------------------------------------------------------------------------------
// Frozen numeric codes for IHogee.sol (gate G0). Mirrored in packages/chain/src/kinds.ts (a vitest checks they match).
// ---------------------------------------------------------------------------------------------------------

library HogeeKinds {
    // Sig.kind
    uint8 internal constant SIG_ECDSA = 0;
    uint8 internal constant SIG_WEBAUTHN = 1;

    // ITreasury.tighten(kind, target, newValue, decisionId). The agent may do these alone.
    uint8 internal constant TIGHTEN_LOWER_PER_TX_CAP = 1; // target lineId; newValue <= current cap
    uint8 internal constant TIGHTEN_LOWER_WINDOW_CAP = 2; // target lineId; newValue <= current cap
    uint8 internal constant TIGHTEN_RAISE_RESERVE_BPS = 3; // target 0; current <= newValue <= 10_000
    uint8 internal constant TIGHTEN_REVOKE_AGENT = 4; // target 0; newValue 0
    uint8 internal constant TIGHTEN_PAUSE_LINE = 5; // target lineId; newValue 0

    // LoosenRequest.kind (queueLoosen -> timelock -> executeLoosen). G0-DECISION: §26.5 RAISE_CAP is split into
    // per-tx and window kinds; EXTEND_EXPIRY into agent and line kinds; ADD_PAYEE binds one line per request.
    uint8 internal constant LOOSEN_RAISE_PER_TX_CAP = 1; // target lineId; newValue new cap
    uint8 internal constant LOOSEN_RAISE_WINDOW_CAP = 2; // target lineId; newValue new cap
    // target payeeId; aux lineId; G0-REVIEW (M7, T1): newValue = uint256(payoutAccountHash), so founder and lender
    // sign the payout destination of a platform payee too.
    uint8 internal constant LOOSEN_ADD_PAYEE = 3;
    uint8 internal constant LOOSEN_EXTEND_AGENT_EXPIRY = 4; // target 0; newValue new agentExpiry
    uint8 internal constant LOOSEN_EXTEND_LINE_EXPIRY = 5; // target lineId; newValue new validUntil
    uint8 internal constant LOOSEN_MOVE_POCKETS = 6; // target from lineId; aux to lineId; newValue amountMinor
    uint8 internal constant LOOSEN_UNPAUSE = 7; // target 0 = treasury, or lineId (also closes its circuit)
    uint8 internal constant LOOSEN_WITHDRAW_RESERVE = 8; // target taxPayeeId; newValue amountMinor

    // QueuedLoosen.status
    uint8 internal constant LOOSEN_STATUS_NONE = 0;
    uint8 internal constant LOOSEN_STATUS_QUEUED = 1;
    uint8 internal constant LOOSEN_STATUS_EXECUTED = 2;
    uint8 internal constant LOOSEN_STATUS_CANCELLED = 3; // includes "cancelled by pause"
    uint8 internal constant LOOSEN_STATUS_EXPIRED = 4;

    // PlanInvariantViolated(code): one per §8.3 rule (1-11), plus structural checks (12-13, G0-DECISION) and the
    // replan rule (14, G0-AUDIT v-1).
    uint8 internal constant CONST_LINES_EXCEED_FACILITY_CAP = 1; // sum of lines > facility cap
    uint8 internal constant CONST_AGENT_EXPIRY_TOO_LATE = 2; // agentExpiry > now + 90 days
    uint8 internal constant CONST_AGENT_EXPIRY_TOO_EARLY = 3; // agentExpiry not after the judging window
    uint8 internal constant CONST_PER_TX_CAP_OVER_25PCT = 4; // a line's perTxCap > 25% of the line
    uint8 internal constant CONST_WINDOW_CAP_OVER_50PCT = 5; // a line's windowCap > 50% of the line
    uint8 internal constant CONST_LINE_VALIDITY_TOO_LONG = 6; // a line's validUntil > now + 90 days
    uint8 internal constant CONST_RESERVE_BELOW_FLOOR = 7; // reserveBps < facility.reserveFloorBps
    uint8 internal constant CONST_STAGE1_OVER_40PCT = 8; // stage 0 release > 40% of the total
    uint8 internal constant CONST_PLAN_ADDS_PAYEE = 9; // payeeId neither bound nor in the platform registry
    uint8 internal constant CONST_SUPPLIER_LINE_NOT_ESCROW = 10; // SUPPLIER line without escrowOnly
    uint8 internal constant CONST_PAYEE_CAP_OVER_SCHEDULE = 11; // payee lifetime cap > its schedule total
    uint8 internal constant CONST_TOTALS_MISMATCH = 12; // sum(lines) or sum(stages) != totalMinor
    uint8 internal constant CONST_MALFORMED_PLAN = 13; // no lines, duplicate ids, windowSeconds 0, bad metric
    uint8 internal constant CONST_REPLAN_LOOSENS = 14; // a re-commit loosens the current state (see commitPlan)

    // Stage.metric
    uint8 internal constant METRIC_NONE = 0; // stage 0: released at commitPlan
    uint8 internal constant METRIC_SALES_MINOR = 1;
    uint8 internal constant METRIC_ORDERS = 2;

    // ITreasury.settlementState
    uint8 internal constant SETTLEMENT_NONE = 0;
    uint8 internal constant SETTLEMENT_CONFIRMED = 1;
    uint8 internal constant SETTLEMENT_FAILED = 2;

    // lineId of the supplier line (stringToHex("SUPPLIER", {size: 32})), used by CONST_SUPPLIER_LINE_NOT_ESCROW.
    bytes32 internal constant LINE_SUPPLIER = "SUPPLIER";

    /// G0-REVIEW (H2): whether a loosen kind needs the lender's co-signature in queueLoosen (founder always signs).
    /// True for every current kind. A later kind may opt out additively with an explicit
    /// `if (kind == LOOSEN_X) return false;`. Unknown kinds fail safe (true); queueLoosen rejects them anyway.
    function requiresLender(uint8 kind) internal pure returns (bool) {
        if (kind >= LOOSEN_RAISE_PER_TX_CAP && kind <= LOOSEN_WITHDRAW_RESERVE) return true;
        return true;
    }
}
