// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Line, Stage, Sig, SupplierApproval} from "./interfaces/IHogee.sol";

/// Plan data PlanRegistry pushes to Treasury at the end of commitPlan (implementation detail, not frozen).
struct PlanSync {
    bytes32 planId;
    uint32 version;
    uint128 totalMinor;
    address agent;
    uint64 agentExpiry;
    uint16 reserveBps;
}

/// Treasury constructor input for the final-1 set (task 1.8; not frozen). All four are immutables.
/// escrow / salesOracle = 0 is the loop-1 shape (D17): no escrow orders and no sales, so the escrow and revenue hooks
/// can never be called.
struct TreasuryLinks {
    address escrow; // MilestoneEscrow of this deployment (its CREATE address, precomputed by the deploy script)
    address salesOracle; // SalesOracle of this deployment (same)
    address observer; // optional OBSERVER (§8.2): may veto (cancelLoosen) a queued loosening; 0 = none
    uint64 loosenTimelockSeconds; // §8.8: 24 h in production, 120 s in the demo; 1 s to 30 days
}

/// Treasury functions that only PlanRegistry calls, plus the extra views it reads. Not part of the frozen ABI
/// (contracts/src/interfaces): the worker, API and UI never call these.
interface ITreasuryHooks {
    /// PlanRegistry only (else NotOwner). Mirrors the committed plan into the spend path. The first commit also
    /// records the stages and releases stage 0; a re-commit writes plan parameters only (G0 audit v-1).
    function syncPlan(PlanSync calldata s, Line[] calldata lines, Stage[] calldata stages) external;
    /// Whether `payeeId` is in the static platform registry fixed at deployment.
    function platformPayoutAccountHash(bytes32 payeeId) external view returns (bytes32);
    /// Current (mutable) agent authorisation and reserve, for PlanRegistry.currentPlan().
    function agentState() external view returns (address agent, uint64 expiry, bool revoked, uint16 reserveBps);
    /// Whether `payeeId` was bound to `lineId` by a founder-signed approval (bindPayee; 1.8 LOOSEN_ADD_PAYEE), as
    /// opposed to the automatic binding of a listed static platform payee. Read by the replan rule (PlanReplan).
    function isSignedPayee(bytes32 lineId, bytes32 payeeId) external view returns (bool);
    /// Whether the stage's releaseMinor is counted in releasedMinor, for PlanRegistry.stage().
    function isStageReleased(bytes32 stageId) external view returns (bool);
    /// The ORACLE role (constructor immutable), for PlanRegistry's role-separation checks (run-2 audit).
    function oracle() external view returns (address);
}

/// PlanRegistry view Treasury uses to verify founder signatures against the single registered founder key.
interface IFounderVerifier {
    /// ok: the signature verifies for the registered founder key. ecdsaSigner: the recovered address for kind 0
    /// (0 if malformed), 0 for kind 1. Callers map a known non-owner signer to NotOwner.
    function checkFounderSig(bytes32 digest, Sig calldata sig) external view returns (bool ok, address ecdsaSigner);
}

/// Treasury entry points for this deployment's MilestoneEscrow and SalesOracle (task 1.8; not frozen: the worker, API
/// and UI never call these). Each reverts NotOwner unless the caller is the linked contract.
interface ITreasuryModuleHooks {
    /// View for MilestoneEscrow.fundMilestone rows 1-3 (spend rows 1-3): `caller` is the current plan's agent, not
    /// revoked (NotAgent), the treasury is not paused (Paused), the agent key has not expired (AgentExpired).
    function requireSpendingAgent(address caller) external view;
    /// View for fundMilestone rows 6-10: the escrow line is active and valid (LineExpired), its circuit closed
    /// (CircuitOpen) and not paused (Paused); the order payee is bound to it (PayeeNotBound) and cooled
    /// (PayeeCooling, H6). No listing rule: a supplier is bound by its signed approval, never listed by a plan.
    function checkEscrowLine(bytes32 lineId, bytes32 payeeId) external view;
    /// MilestoneEscrow only: moves `amountMinor` of the line's pocket into escrow. CapExceeded above the line balance,
    /// releasedMinor or funded BU (§8.4; not perTxCap or the window cap).
    function escrowFund(bytes32 lineId, uint128 amountMinor) external;
    /// MilestoneEscrow only, when a milestone releases (autoRelease or releaseMilestone): pays the payee out of escrow
    /// (paid += amount, within its lifetime cap, else CapExceeded) and opens settlement `settlementId`
    /// (SettlementClosed if it ever existed). PayeeCooling while the payee's binding is cooling (a re-bind restarts it).
    function escrowRelease(bytes32 settlementId, bytes32 lineId, bytes32 payeeId, uint128 amountMinor) external;
    /// SalesOracle only, after its ORACLE and unique-sale checks. Adds the sale to revenue and skims reserveBps
    /// (current value, rounded down) into the reserve; emits RevenueRecorded and ReserveSkimmed. StalePlan before the
    /// first plan (no reserveBps yet).
    function creditRevenue(bytes32 saleIdHash, uint128 amountMinor) external;
}

/// MilestoneEscrow functions only its Treasury calls (task 1.8; not frozen). Each reverts NotOwner for any other caller.
/// No failure hook (re-check M-1): Treasury.failSettlement of a milestone release returns the BU to the supplier line
/// itself, and the milestone stays released for good.
interface IEscrowHooks {
    /// Treasury.bindPayee, after the founder's SupplierApproval is verified: opens order `a.orderId` for `a.payee` on
    /// `a.lineId` with the pre-signed schedule (scheduleHash already checked; 1-8 milestones; orderId unique).
    function openOrder(SupplierApproval calldata a, uint128[] calldata schedule, bool[] calldata autoRelease) external;
}

/// Constructor links MilestoneEscrow and SalesOracle read back from Treasury (public immutables; not frozen).
interface ITreasuryLinks {
    function registry() external view returns (address);
    function escrow() external view returns (address);
    function salesOracle() external view returns (address);
    /// The optional OBSERVER (0 = none), for PlanRegistry's role-separation checks (audit run-3).
    function observer() external view returns (address);
}
