// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Balances, Pocket, Milestone, Stage, HogeeKinds} from "../../src/interfaces/IHogee.sol";
import {HogeeTypes} from "../../src/interfaces/HogeeTypes.sol";
import {HogeeTestBase} from "../utils/HogeeTestBase.sol";
import {FinalHandler} from "./FinalHandler.sol";
import {FinalAgentAdmin} from "./FinalAgentAdmin.sol";

/// §8.9 invariants on the final-1 set (PlanRegistry + Treasury + MilestoneEscrow + SalesOracle), with handlers and
/// ghost variables: agent spends and escrow funding, owner spends, the balance release, sales and the stage-2 gate,
/// founder + lender loosenings through the timelock (reserve withdrawals included), settlements and the clock.
///
/// Invariant 2, as §8.9 words it: sum of pockets + spent + reserve + escrow == funded + recordedRevenue. It holds
/// with each term defined by where its BU sit (G0-DECISIONS §1 asked where net revenue goes):
///   pockets = the BU on hand in the line pockets (sum of pocket.availableMinor, minus the allocation the lender has
///             not funded yet) + the revenue pocket (recorded revenue minus the reserve skims: the founder's net sale
///             revenue, recorded only, never spendable by the agent);
///   spent   = spend + ownerSpend + executed reserve withdrawals, net of failed settlements (every outflow that is not
///             escrow); reserve = Treasury.reserve(); escrow = BU funded into milestones (released or not), net of
///             releases whose payout failed (re-check M-1: those BU are back in the supplier line pocket).
/// Each term is read from a different on-chain view, and the revenue / skim / withdrawal totals also match ghosts.
contract FinalInvariantTest is HogeeTestBase {
    FinalHandler internal handler;
    FinalAgentAdmin internal admin;

    function setUp() public override {
        super.setUp();
        _setUpSupplierA();
        vm.startPrank(agent); // room under CONTINGENCY's caps for the handler's small pocket moves
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, L_CONTINGENCY, 20_000, "d");
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_WINDOW_CAP, L_CONTINGENCY, 40_000, "d");
        vm.stopPrank();
        handler = new FinalHandler(
            registry, treasury, escrow, sales, agent, FinalHandler.Keys(agentPk, founderPk, lenderPk, oracle)
        );
        admin = new FinalAgentAdmin(registry, treasury, escrow, sales, agent, agentPk, founderPk);
        targetContract(address(handler));
        targetContract(address(admin));
    }

    /// §8.9 invariant 2 (exact wording; terms defined in the contract doc).
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_2_PocketsPlusSpentReserveEscrowEqualFundedPlusRevenue() public view {
        Balances memory b = treasury.balances();
        (uint128 skimmed, uint128 withdrawn,) = treasury.revenueLedger();
        uint256 linePockets;
        bytes32[] memory ids = registry.lineIds();
        for (uint256 i; i < ids.length; ++i) {
            linePockets += treasury.pocket(ids[i]).availableMinor;
        }
        uint256 unfunded = registry.currentPlan().totalMinor - b.fundedMinor;
        uint256 pockets = linePockets - unfunded + (b.revenueMinor - skimmed);
        uint256 spent = uint256(b.spentMinor) + withdrawn;
        assertEq(pockets + spent + b.reserveMinor + b.escrowedMinor, uint256(b.fundedMinor) + b.revenueMinor, "inv 2");
        assertEq(b.revenueMinor, handler.ghostRevenue(), "revenue != recorded sales");
        assertEq(skimmed, handler.ghostSkimmed(), "skims != reserveBps of each sale");
        assertEq(withdrawn, handler.ghostWithdrawn(), "withdrawn != executed minus failed");
    }

    /// §8.9 invariant 3: the reserve never decreases except via a WITHDRAW_RESERVE executed after its timelock.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_3_ReserveFallsOnlyThroughATimelockedWithdrawal() public view {
        assertEq(handler.ghostReserveBreach(), 0, "reserve fell outside WITHDRAW_RESERVE");
        assertEq(handler.ghostEarlyLoosen(), 0, "a loosening executed before its timelock");
        (uint128 skimmed, uint128 withdrawn,) = treasury.revenueLedger();
        assertEq(treasury.reserve(), uint256(skimmed) - withdrawn, "reserve != skimmed - withdrawn");
    }

    /// §8.9 invariant 4: escrow funded per milestone <= its signed schedule; the escrow ledger matches the milestones,
    /// minus each released milestone whose payout failed (re-check M-1: its BU went back to the line; it stays released
    /// and fully funded, so it can never be funded or paid again).
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_4_EscrowPerMilestoneWithinTheSchedule() public view {
        Milestone[] memory m = escrow.milestones(ORDER_A);
        uint256 total;
        for (uint256 i; i < m.length; ++i) {
            assertLe(m[i].fundedMinor, m[i].amountMinor, "milestone above its schedule");
            if (m[i].released) assertEq(m[i].fundedMinor, m[i].amountMinor, "released before fully funded");
            bytes32 sid = HogeeTypes.milestoneSettlementId(ORDER_A, uint8(i));
            bool failed = treasury.settlementState(sid) == HogeeKinds.SETTLEMENT_FAILED;
            if (failed) assertTrue(m[i].released, "a failed payout un-released its milestone");
            total += failed ? 0 : m[i].fundedMinor;
        }
        assertEq(treasury.pocket(L_SUPPLIER).escrowedMinor, total, "line escrow != milestones");
        assertEq(treasury.balances().escrowedMinor, total, "total escrow != milestones");
    }

    /// §8.9 invariant 1: outflow within releasedMinor, funded BU and every pocket; outflow only to bound payees
    /// (listed and cooled for spends); every cap within 25 % / 50 % of its (possibly moved) allocation.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_1_OutflowWithinCapsAndOnlyToBoundPayees() public view {
        assertEq(handler.ghostUnboundPaid(), 0, "paid an unbound, unlisted or cooling payee");
        Balances memory b = treasury.balances();
        uint256 outflow = uint256(b.spentMinor) + b.escrowedMinor;
        assertLe(outflow, b.releasedMinor, "outflow above releasedMinor");
        assertLe(outflow, b.fundedMinor, "outflow above funded");
        uint256 allocated;
        bytes32[] memory ids = registry.lineIds();
        for (uint256 i; i < ids.length; ++i) {
            Pocket memory p = treasury.pocket(ids[i]);
            assertLe(uint256(p.spentMinor) + p.escrowedMinor, p.allocatedMinor, "pocket over its allocation");
            assertLe(uint256(p.perTxCapMinor) * 4, p.allocatedMinor, "per-tx cap above 25 %");
            assertLe(uint256(p.windowCapMinor) * 2, p.allocatedMinor, "window cap above 50 %");
            allocated += p.allocatedMinor;
        }
        assertEq(allocated, 1_000_000, "pocket moves changed the plan total");
        assertLe(treasury.payeeBinding(L_SUPPLIER, SUPPLIER_A).paidMinor, 430_000, "supplier paid above its cap");
    }

    /// §8.9 invariant 5: no invoice is paid twice, by the agent and the owner together.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_5_NoInvoicePaidTwice() public view {
        assertEq(handler.ghostDoubleInvoice(), 0);
    }

    /// §8.9 invariant 7: the agent never succeeds at an admin, oracle, hook or founder/lender-signed entry point.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_7_AgentCannotCallAdminOrSignedEntryPoints() public view {
        assertEq(admin.ghostAdminSuccess(), 0);
        assertEq(registry.planVersion(), 1);
        assertEq(treasury.facility().capMinor, 1_000_000);
    }

    /// releasedMinor is exactly the released-stage total (stage 2 only through the lender's signature and the gate).
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_ReleasedMinorIsTheReleasedStageTotal() public view {
        uint256 released;
        bytes32[] memory ids = registry.stageIds();
        for (uint256 i; i < ids.length; ++i) {
            (Stage memory s, bool isReleased) = registry.stage(ids[i]);
            if (isReleased) released += s.releaseMinor;
        }
        assertEq(treasury.releasedMinor(), released);
        if (released > 400_000) assertGe(treasury.revenue(), 200_000, "stage 2 released below its gate");
    }
}
