// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PayeeBinding, HogeeKinds} from "./interfaces/IHogee.sol";
import {IHogeeEvents} from "./interfaces/IHogeeBase.sol";
import {TreasuryState} from "./TreasuryState.sol";

/// @title TreasuryLoosenRules: what each LOOSEN_* kind may change and how (§8.8, G0-REVIEW H2).
/// @notice _checkLoosen runs when a request is queued and again when it executes, so a change that became unsafe in
///         between (a pocket move, a drained reserve, a later expiry horizon) cannot execute. It re-checks the §8.3
///         bounds the change touches: per-tx cap <= 25 % and window cap <= 50 % of the line (codes 4, 5), expiries
///         <= now + 90 days (codes 2, 6). Part of the delegate-only TreasuryGovernance module. Every row:
///         docs/assurance/require-table-final1.md.
abstract contract TreasuryLoosenRules is TreasuryState, IHogeeEvents {
    uint256 private constant MAX_HORIZON = 90 days;

    /// Reverts unless `kind` may apply `newValue` to `target` / `aux` now (see the require table, per kind).
    function _checkLoosen(uint8 kind, bytes32 target, bytes32 aux, uint256 newValue) internal view {
        if (kind == HogeeKinds.LOOSEN_RAISE_PER_TX_CAP || kind == HogeeKinds.LOOSEN_RAISE_WINDOW_CAP) {
            _checkCapRaise(kind == HogeeKinds.LOOSEN_RAISE_PER_TX_CAP, _activeLine(target), newValue);
        } else if (kind == HogeeKinds.LOOSEN_ADD_PAYEE) {
            if (target == bytes32(0) || newValue == 0) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
            LineState storage l = _activeLine(aux);
            if (_now() > l.validUntil) revert LineExpired();
            if (l.escrowOnly) revert PlanInvariantViolated(HogeeKinds.CONST_SUPPLIER_LINE_NOT_ESCROW);
            // A static platform payee is uncapped with a fixed account (same rule as bindPayee row 8).
            if (_platformPayout[target] != bytes32(0)) {
                revert PlanInvariantViolated(HogeeKinds.CONST_PAYEE_CAP_OVER_SCHEDULE);
            }
        } else if (kind == HogeeKinds.LOOSEN_EXTEND_AGENT_EXPIRY) {
            if (target != bytes32(0)) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
            if (_planVersion == 0) revert StalePlan(); // the first commit would overwrite it
            if (newValue > uint256(_now()) + MAX_HORIZON) {
                revert PlanInvariantViolated(HogeeKinds.CONST_AGENT_EXPIRY_TOO_LATE);
            }
        } else if (kind == HogeeKinds.LOOSEN_EXTEND_LINE_EXPIRY) {
            _activeLine(target);
            if (newValue > uint256(_now()) + MAX_HORIZON) {
                revert PlanInvariantViolated(HogeeKinds.CONST_LINE_VALIDITY_TOO_LONG);
            }
        } else if (kind == HogeeKinds.LOOSEN_MOVE_POCKETS) {
            _checkMove(target, aux, newValue);
        } else if (kind == HogeeKinds.LOOSEN_UNPAUSE) {
            if (target != bytes32(0)) _activeLine(target);
        } else if (kind == HogeeKinds.LOOSEN_WITHDRAW_RESERVE) {
            // The tax payee's destination is fixed at deployment (static platform registry), never free-form (T1).
            if (_platformPayout[target] == bytes32(0)) revert PayeeNotBound();
            if (newValue == 0 || newValue > _reserveMinor) revert CapExceeded();
        } else {
            revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        }
    }

    /// Applies a checked loosening. `loosenId` is the settlementId of a reserve withdrawal.
    function _applyLoosen(bytes32 loosenId, uint8 kind, bytes32 target, bytes32 aux, uint256 newValue) internal {
        // Every cast below is bounded by _checkLoosen: caps <= the line amount (uint128), expiries <= now + 90 days,
        // pocket and reserve amounts <= a uint128 balance.
        // forge-lint: disable-next-item(unsafe-typecast)
        if (kind == HogeeKinds.LOOSEN_RAISE_PER_TX_CAP) {
            _lines[target].perTxCapMinor = uint128(newValue);
        } else if (kind == HogeeKinds.LOOSEN_RAISE_WINDOW_CAP) {
            _lines[target].windowCapMinor = uint128(newValue);
        } else if (kind == HogeeKinds.LOOSEN_ADD_PAYEE) {
            _addPayee(target, aux, bytes32(newValue));
        } else if (kind == HogeeKinds.LOOSEN_EXTEND_AGENT_EXPIRY) {
            _agentExpiry = uint64(newValue);
        } else if (kind == HogeeKinds.LOOSEN_EXTEND_LINE_EXPIRY) {
            _lines[target].validUntil = uint64(newValue);
        } else if (kind == HogeeKinds.LOOSEN_MOVE_POCKETS) {
            _lines[target].allocatedMinor -= uint128(newValue);
            _lines[aux].allocatedMinor += uint128(newValue);
        } else if (kind == HogeeKinds.LOOSEN_UNPAUSE) {
            _unpause(target);
        } else {
            _withdrawReserve(loosenId, target, uint128(newValue));
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------------------

    function _activeLine(bytes32 lineId) private view returns (LineState storage l) {
        l = _lines[lineId];
        if (!_isActive(l)) revert LineExpired();
    }

    /// Codes 4 / 5: the new cap stays within 25 % / 50 % of the line's current allocation (uint256: no overflow).
    function _checkCapRaise(bool perTx, LineState storage l, uint256 newValue) private view {
        uint256 limit = perTx ? uint256(l.allocatedMinor) / 4 : uint256(l.allocatedMinor) / 2;
        if (newValue > limit) {
            revert PlanInvariantViolated(perTx
                    ? HogeeKinds.CONST_PER_TX_CAP_OVER_25PCT
                    : HogeeKinds.CONST_WINDOW_CAP_OVER_50PCT);
        }
    }

    /// MOVE_POCKETS: two different active lines, a non-zero amount within the from-line's unspent, unescrowed
    /// balance, and the from-line's caps still within 25 % / 50 % of its reduced allocation.
    function _checkMove(bytes32 from, bytes32 to, uint256 amount) private view {
        if (from == to || amount == 0) revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        LineState storage f = _activeLine(from);
        _activeLine(to);
        uint256 used = uint256(f.spentMinor) + f.escrowedMinor; // <= allocated (spend, ownerSpend, escrowFund)
        if (amount > f.allocatedMinor - used) revert CapExceeded();
        uint256 reduced = f.allocatedMinor - amount;
        if (uint256(f.perTxCapMinor) * 4 > reduced) {
            revert PlanInvariantViolated(HogeeKinds.CONST_PER_TX_CAP_OVER_25PCT);
        }
        if (uint256(f.windowCapMinor) * 2 > reduced) {
            revert PlanInvariantViolated(HogeeKinds.CONST_WINDOW_CAP_OVER_50PCT);
        }
    }

    /// ADD_PAYEE: bound to the line, listed by the current plan version (spend row 10), signed (replan R11), uncapped
    /// (line caps bind it), with its co-signed payout account and a fresh cooling period (T3; a re-add restarts it).
    function _addPayee(bytes32 payeeId, bytes32 lineId, bytes32 payoutAccountHash) private {
        uint64 coolingUntil = _now() + coolingSeconds;
        PayeeBinding storage b = _bindings[lineId][payeeId];
        b.bound = true;
        b.coolingUntil = coolingUntil;
        b.lifetimeCapMinor = type(uint128).max;
        b.payoutAccountHash = payoutAccountHash;
        _signedPayee[lineId][payeeId] = true;
        _listedVersion[lineId][payeeId] = _planVersion;
        emit PayeeBound(payeeId, lineId, 0, coolingUntil, type(uint128).max, 0, 0, payoutAccountHash);
    }

    /// UNPAUSE: target 0 reopens the treasury; a lineId reopens the line and closes its circuit with a fresh denial
    /// count (so the next denial does not trip it again at once).
    function _unpause(bytes32 target) private {
        if (target == bytes32(0)) {
            _paused = false;
        } else {
            LineState storage l = _lines[target];
            l.paused = false;
            l.circuitOpen = false;
            delete _denials[target];
        }
        emit Unpaused(target, msg.sender);
    }

    /// WITHDRAW_RESERVE: reserve -> the tax payee, settled like a spend (settlementId = loosenId; a failed payout
    /// returns the amount to the reserve).
    function _withdrawReserve(bytes32 loosenId, bytes32 taxPayeeId, uint128 amountMinor) private {
        _reserveMinor -= amountMinor;
        _reserveWithdrawnMinor += amountMinor;
        _settlements[loosenId] = SettlementRecord({
            lineId: bytes32(0),
            payeeId: taxPayeeId,
            amountMinor: amountMinor,
            kind: SETTLEMENT_KIND_RESERVE,
            state: HogeeKinds.SETTLEMENT_NONE
        });
        emit ReserveWithdrawn(loosenId, taxPayeeId, amountMinor);
    }
}
