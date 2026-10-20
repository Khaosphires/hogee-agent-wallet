// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PlanApproval, Line, Pocket, ITreasury} from "./interfaces/IHogee.sol";
import {ITreasuryHooks} from "./HogeeHooks.sol";

/// @title PlanReplan: the tighten-only rule for a founder-only re-commit (G0 audit v-1, code 14).
/// @notice Checked by PlanRegistry.commitPlan after codes 1-13, once a plan is stored (planVersion() > 0). Only the
///         founder signs a PlanApproval, so a re-commit may only TIGHTEN the current on-chain state: the stored plan
///         plus everything that changed since in Treasury (tightenings, lender-co-signed loosenings, bindings).
///         Any loosening needs a lender-co-signed LOOSEN_* kind (task 1.8). The TS mirror (task 1.10) must apply
///         the same comparisons. See the IPlanRegistry.commitPlan NatSpec and docs/assurance/require-table-loop1.md.
library PlanReplan {
    /// Signed values of the current version that a re-commit must repeat exactly.
    struct Current {
        bytes32 countryPackHash;
        bytes32 stagesHash;
        uint128 totalMinor;
        uint256 lineCount;
    }

    /// @return true if the re-commit loosens the current on-chain state (revert CONST_REPLAN_LOOSENS).
    /// @param stored the current plan's lines as stored by PlanRegistry (zero struct for an id not in the plan).
    function loosens(
        PlanApproval calldata a,
        Line[] calldata lines,
        Current memory cur,
        mapping(bytes32 lineId => Line) storage stored,
        address treasury
    ) internal view returns (bool) {
        // Stages and the total are identical (stagesHash == hashStages(stages) was checked against the calldata).
        if (a.totalMinor != cur.totalMinor || a.countryPackHash != cur.countryPackHash) return true;
        if (a.stagesHash != cur.stagesHash) return true;
        // Current agent state lives in Treasury (TIGHTEN_RAISE_RESERVE_BPS, 1.8 EXTEND_AGENT_EXPIRY).
        // forge-lint: disable-next-line(unused-return)
        (address agent, uint64 expiry,, uint16 reserveBps) = ITreasuryHooks(treasury).agentState();
        if (a.agent != agent || a.agentExpiry > expiry || a.reserveBps < reserveBps) return true;
        // Same set of lineIds: same count, every id in the current plan, no duplicates (code 13 already ran).
        if (lines.length != cur.lineCount) return true;
        for (uint256 i; i < lines.length; ++i) {
            if (_lineLoosens(lines[i], stored[lines[i].lineId], treasury)) return true;
        }
        return false;
    }

    /// One line against its current Treasury pocket (caps after tighten, allocation after MOVE_POCKETS).
    function _lineLoosens(Line calldata n, Line storage s, address treasury) private view returns (bool) {
        bytes32 id = n.lineId;
        if (s.lineId != id) return true; // not a line of the current plan
        // The loop is bounded (code 13: <= 16 lines) and only reads this deployment's immutable Treasury.
        // forge-lint: disable-next-line(calls-loop)
        Pocket memory p = ITreasury(treasury).pocket(id);
        if (n.amountMinor != p.allocatedMinor) return true;
        if (n.perTxCapMinor > p.perTxCapMinor || n.windowCapMinor > p.windowCapMinor) return true;
        if (n.validUntil > p.validUntil || n.windowSeconds < p.windowSeconds) return true;
        // pacingMinor <= current, and a pacing line never becomes an invoice line (0 only if 0 now).
        if (n.pacingMinor > p.pacingMinor || (p.pacingMinor != 0 && n.pacingMinor == 0)) return true;
        if (p.escrowOnly && !n.escrowOnly) return true;
        return _addsPayee(n, s, treasury);
    }

    /// Every listed payee is one of the line's current payees: its stored payeeIds, or bound to it by a signed
    /// approval since (bindPayee, 1.8 LOOSEN_ADD_PAYEE). A static platform payee counts only while the line lists
    /// it: its automatic binding is not a signed one, so re-listing a dropped one is an addition (same as the 1.10
    /// TS mirror). Bounded by code 13 (<= 8 payees per line).
    function _addsPayee(Line calldata n, Line storage s, address treasury) private view returns (bool) {
        for (uint256 p; p < n.payeeIds.length; ++p) {
            bytes32 payee = n.payeeIds[p];
            if (_listed(s.payeeIds, payee)) continue;
            // forge-lint: disable-next-line(calls-loop)
            if (ITreasuryHooks(treasury).isSignedPayee(n.lineId, payee)) continue;
            return true;
        }
        return false;
    }

    function _listed(bytes32[] storage ids, bytes32 id) private view returns (bool) {
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == id) return true;
        }
        return false;
    }
}
