// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Balances, Pocket, Stage} from "../../src/interfaces/IHogee.sol";
import {HogeeTestBase} from "../utils/HogeeTestBase.sol";
import {TreasuryHandler} from "./TreasuryHandler.sol";

/// §8.9 invariants on the loop-1 pair, with handler + ghost variables (TreasuryHandler).
///
/// Invariant 2 as written in §8.9 ("sum of pockets + spent + reserve + escrow == funded + recordedRevenue") cannot
/// hold: net revenue (revenue minus the reserve skim) is credited to nothing on the left side, and "pockets" are
/// budget allocations (they sum to the plan total), not BU on hand. The ledger identity tested here is:
///     idle + spent + escrowed + reserve == funded + reserveSkimmed - reserveWithdrawn
/// where idle = funded - spent - escrowed must be non-negative (never spend unfunded BU), revenue is a counter that
/// moves no BU, and reserveSkimmed / reserveWithdrawn are 0 on loop-1 (SalesOracle and WITHDRAW_RESERVE are 1.8).
/// Both sides are also reconciled with ghosts: spent == sum(Spent) - sum(SettlementFailed) == sum(pocket.spent).
contract TreasuryInvariantTest is HogeeTestBase {
    TreasuryHandler internal handler;

    function setUp() public override {
        super.setUp();
        _setUpRina();
        handler = new TreasuryHandler(registry, treasury, agent, agentPk, founderPk, oracle);
        targetContract(address(handler));
    }

    /// Invariant 2 (restated, see the contract doc): the BU ledger balances and outflow never exceeds funding.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_LedgerIdentity_IdlePlusOutflowEqualsFunded() public view {
        Balances memory b = treasury.balances();
        uint256 outflow = uint256(b.spentMinor) + b.escrowedMinor;
        assertLe(outflow, b.fundedMinor, "outflow above funded");
        uint256 idle = b.fundedMinor - outflow;
        uint256 reserveSkimmedMinusWithdrawn = 0; // loop-1 has no SalesOracle and no WITHDRAW_RESERVE
        assertEq(
            idle + b.spentMinor + b.escrowedMinor + b.reserveMinor,
            b.fundedMinor + reserveSkimmedMinusWithdrawn,
            "ledger identity"
        );
        assertEq(b.reserveMinor, 0, "no reserve path on loop-1");
        assertEq(b.revenueMinor, 0, "no revenue path on loop-1");
        assertEq(b.fundedMinor, 1_000_000);
    }

    /// Ghost reconciliation: spent == sum of successful spends - failed settlements == sum of pocket spent.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_SpentReconcilesWithGhostsAndPockets() public view {
        uint256 pockets;
        bytes32[] memory ids = registry.lineIds();
        for (uint256 i; i < ids.length; ++i) {
            pockets += treasury.pocket(ids[i]).spentMinor;
        }
        uint256 spent = treasury.balances().spentMinor;
        assertEq(spent, handler.ghostSpent() - handler.ghostRefunded(), "spent != ghost ledger");
        assertEq(pockets, spent, "pockets do not sum to spent");
    }

    /// Invariant 1: agent outflow stays inside every cap and goes only to bound, cooled payees that the current plan
    /// version lists on that line (run-2 audit: a payee a re-commit drops is not payable).
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_AgentOutflowWithinCapsAndOnlyToBoundPayees() public view {
        assertEq(handler.ghostUnboundPaid(), 0, "paid an unbound, cooling or unlisted payee");
        assertEq(handler.ghostWindowBreach(), 0, "a spend left the window above its cap");
        Balances memory b = treasury.balances();
        assertLe(uint256(b.spentMinor) + b.escrowedMinor, b.releasedMinor, "outflow above releasedMinor");
        bytes32[] memory ids = registry.lineIds();
        for (uint256 i; i < ids.length; ++i) {
            Pocket memory p = treasury.pocket(ids[i]);
            assertLe(uint256(p.spentMinor) + p.escrowedMinor, p.allocatedMinor, "pocket over its allocation");
        }
    }

    /// Invariant 5: no invoice is paid twice.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_NoInvoicePaidTwice() public view {
        assertEq(handler.ghostDoubleInvoice(), 0);
    }

    /// Invariant 7: the agent can never call an admin function successfully.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_AgentCannotCallAdminFunctions() public view {
        assertEq(handler.ghostAdminSuccess(), 0);
        assertEq(registry.planVersion(), 1 + handler.ghostReplans()); // only the founder's re-commits move it
        assertEq(treasury.facility().capMinor, 1_000_000);
    }

    /// Task 1.4 item (c) + G0 audit v-1: releasedMinor is exactly the released-stage total (stage 0 only on loop-1),
    /// never above totalMinor, and no re-commit changes it or loosens anything.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_ReleasedMinorIsTheReleasedStageTotalAndReplansOnlyTighten() public view {
        uint256 releasedStages;
        bytes32[] memory ids = registry.stageIds();
        for (uint256 i; i < ids.length; ++i) {
            (Stage memory s, bool released) = registry.stage(ids[i]);
            if (released) releasedStages += s.releaseMinor;
        }
        assertEq(treasury.releasedMinor(), releasedStages, "releasedMinor != released stages");
        assertLe(releasedStages, registry.currentPlan().totalMinor, "released above the plan total");
        assertEq(treasury.releasedMinor(), 400_000, "releasedMinor moved");
        assertEq(handler.ghostReplanBreach(), 0, "a re-commit loosened the state");
    }

    /// Invariant 6 (loop-1 form): the committed plan stays as signed, and tightening keeps every cap inside the
    /// constitution's 25 % / 50 % and the reserve at or above the floor.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_StoredPlanStaysWithinConstitution() public view {
        bytes32[] memory ids = registry.lineIds();
        assertEq(ids.length, 6);
        for (uint256 i; i < ids.length; ++i) {
            Pocket memory p = treasury.pocket(ids[i]);
            assertLe(uint256(p.perTxCapMinor) * 4, p.allocatedMinor, "per-tx cap above 25 %");
            assertLe(uint256(p.windowCapMinor) * 2, p.allocatedMinor, "window cap above 50 %");
        }
        assertGe(registry.currentPlan().reserveBps, treasury.facility().reserveFloorBps);
    }

    /// Regression (CI run 39324930394, shrunk sequence): a re-commit that lengthens a line's rolling window brings an
    /// older spend back inside it, so the live window-spent figure rises. That is a tightening (less headroom), not
    /// a loosening, and must not count as a replan breach.
    function test_ReplanLengtheningTheWindowRecountsOlderSpendIsNotALoosening() public {
        handler.founderReplans(13264, 776, 470000, false);
        handler.spend(80, 10, 77347162082008723819970676387604933191750718520171174975143553645563304338819, 600);
        handler.warp(2494);
        handler.warp(46772703051247169380938338980979570744698030253382542352207729274823063972654);
        handler.warp(1013041045004950384023611);
        handler.warp(19037);
        handler.warp(6000);
        handler.warp(7336);
        handler.warp(128275248667927476867295375156);
        bytes32 line = registry.lineIds()[4];
        Pocket memory before = treasury.pocket(line);
        handler.founderReplans(18448, 12488, 11455, false);
        Pocket memory afterReplan = treasury.pocket(line);
        assertEq(handler.ghostReplans(), 2, "both re-commits landed");
        assertGt(afterReplan.windowSeconds, before.windowSeconds, "the window got longer");
        assertGt(afterReplan.windowSpentMinor, before.windowSpentMinor, "the older spend counts again");
        assertEq(handler.ghostReplanBreach(), 0, "a tightening counted as a breach");
    }
}
