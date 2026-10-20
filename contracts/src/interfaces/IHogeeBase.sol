// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/*
 * Errors, events and the signature-domain views shared by every Hogee contract (gate G0).
 * They live in base interfaces, not at file level (G0-DECISION): file-level errors/events are not part of an
 * interface's ABI, so the generated ABIs could not decode reverts or logs. Every I* interface in IHogee.sol
 * inherits all three. G0-REVIEW: split out of IHogee.sol to keep files under 500 lines; IHogee.sol re-imports
 * these names, so `import {IHogeeErrors} from "./IHogee.sol"` keeps working.
 */

/// The §8.5 list, plus the G0-REVIEW additions at the end.
interface IHogeeErrors {
    error PlanInvariantViolated(uint8 code); // HogeeKinds.CONST_*
    error StalePlan();
    error PayeeNotBound();
    error PayeeCooling();
    error CapExceeded();
    error LineExpired();
    error DuplicateIntent();
    error DuplicateInvoice();
    error DuplicateSale();
    error NotOwner();
    error NotLender();
    error NotAgent();
    error NotOracle();
    error AgentExpired();
    error ReserveLocked();
    error TimelockActive();
    error Paused();
    error MilestoneLocked();
    error EvidenceMissing();
    error AmountExceedsSchedule();
    error SignatureExpired();
    error InvalidSignature();
    error CircuitOpen();
    // G0-REVIEW (H3): registerFounderKey is once per facility; key rotation is out of scope (redeploy instead).
    error FounderKeyAlreadySet();
    // G0-REVIEW (H5): spend / fundMilestone with decisionId == 0 or rationaleHash == 0 (no traceable decision).
    error MissingDecision();
    // G0-REVIEW (M8): a settlementId is confirmed or failed exactly once; any second call reverts.
    error SettlementClosed();
    // G0-REVIEW (§8.3): spend / ownerSpend on an escrowOnly line; the supplier line is payable only through
    // MilestoneEscrow milestones.
    error EscrowOnly();
}

/// The §8.6 list, plus the G0-REVIEW additions. G0-DECISION: event `Paused` is named `TreasuryPaused`, because
/// Solidity forbids an event and the §8.5 error `Paused` with the same name in one contract.
/// lineId 0 in pause events = whole treasury. New fields are appended after the original ones.
interface IHogeeEvents {
    event FacilityOpened(address indexed lender, uint128 capMinor, uint16 reserveFloorBps);
    event FounderKeyRegistered(address indexed ownerEOA, bytes32 qx, bytes32 qy);
    /// G0-REVIEW (M7): linesHash, stagesHash and reserveBps let the offline verifier tie the plan to its
    /// signed PlanApproval without calldata.
    event PlanCommitted(
        bytes32 indexed planId,
        uint32 indexed version,
        bytes32 planHash,
        bytes32 prevPlanHash,
        bytes32 countryPackHash,
        uint128 totalMinor,
        address agent,
        uint64 agentExpiry,
        uint128 releasedMinor,
        bytes32 linesHash,
        bytes32 stagesHash,
        uint16 reserveBps
    );
    event Funded(uint128 amountMinor, uint128 fundedTotalMinor);
    /// orderId, supplierId and scheduleHash are 0 when the binding comes from a LOOSEN_ADD_PAYEE request.
    /// G0-REVIEW (M7): supplierId, scheduleHash and payoutAccountHash (the signed payout destination; the
    /// settlement adapter checks it before every payout, T1).
    event PayeeBound(
        bytes32 indexed payeeId,
        bytes32 indexed lineId,
        bytes32 indexed orderId,
        uint64 coolingUntil,
        uint128 lifetimeCapMinor,
        bytes32 supplierId,
        bytes32 scheduleHash,
        bytes32 payoutAccountHash
    );
    /// Agent spends only. spendId == intentId == settlementId. G0-REVIEW (M7): planVersion appended.
    event Spent(
        bytes32 indexed spendId,
        bytes32 indexed lineId,
        bytes32 indexed payeeId,
        uint128 amountMinor,
        bytes32 invoiceHash,
        bytes32 decisionId,
        bytes32 rationaleHash,
        uint32 planVersion
    );
    /// G0-REVIEW (H4): the founder's manual fallback (ownerSpend). A separate event, so the reconciler never
    /// mistakes it for an orphan agent spend. spendId == intentId == settlementId.
    event OwnerSpent(
        bytes32 indexed spendId,
        bytes32 indexed lineId,
        bytes32 indexed payeeId,
        uint128 amountMinor,
        bytes32 invoiceHash,
        uint32 planVersion
    );
    event RevenueRecorded(bytes32 indexed saleIdHash, uint128 amountMinor, uint128 revenueTotalMinor);
    event MilestoneFunded(
        bytes32 indexed orderId,
        uint8 indexed idx,
        uint128 amountMinor,
        uint128 fundedTotalMinor,
        bytes32 decisionId,
        bytes32 rationaleHash
    );
    /// settlementId = keccak256(abi.encode(orderId, idx)). evidenceHash is 0 for autoRelease milestones.
    event MilestoneReleased(
        bytes32 indexed orderId,
        uint8 indexed idx,
        bytes32 indexed payeeId,
        uint128 amountMinor,
        bytes32 evidenceHash,
        bytes32 settlementId
    );
    event SaleRecorded(bytes32 indexed saleIdHash, uint128 amountBucket);
    event ReserveSkimmed(bytes32 indexed saleIdHash, uint128 amountMinor, uint128 reserveTotalMinor);
    /// G0-REVIEW (M8): executed LOOSEN_WITHDRAW_RESERVE. settlementId = loosenId; settled like a spend.
    event ReserveWithdrawn(bytes32 indexed settlementId, bytes32 indexed taxPayeeId, uint128 amountMinor);
    event Tightened(
        uint8 indexed kind,
        bytes32 indexed target,
        address indexed by,
        uint256 oldValue,
        uint256 newValue,
        bytes32 decisionId
    );
    event LoosenQueued(
        bytes32 indexed loosenId,
        uint8 indexed kind,
        bytes32 target,
        bytes32 aux,
        uint256 newValue,
        uint64 executableAt,
        uint64 expiresAt
    );
    event LoosenExecuted(bytes32 indexed loosenId, uint8 indexed kind);
    event LoosenCancelled(bytes32 indexed loosenId, address indexed by);
    event StageReleased(bytes32 indexed stageId, uint128 amountMinor, uint128 releasedTotalMinor);
    event Denied(
        bytes32 indexed decisionId,
        bytes32 indexed lineId,
        bytes32 indexed reasonCode,
        bytes32 proposalHash,
        uint8 lineDenials
    );
    event TreasuryPaused(bytes32 indexed lineId, address indexed by);
    event Unpaused(bytes32 indexed lineId, address indexed by);
    event CircuitTripped(bytes32 indexed lineId, uint8 denials);
    event SettlementConfirmed(bytes32 indexed settlementId, bytes32 payoutRefHash);
    /// G0-REVIEW (M8): the amount has been returned to its source (line pocket, escrow milestone or reserve).
    event SettlementFailed(bytes32 indexed settlementId, bytes32 code);
}

/// Shared by every contract that verifies EIP-712 signatures (G0-DECISION: views for clients and verifier).
/// Nonces are unordered and scoped per verifying contract.
interface IHogeeDomain {
    function domainSeparator() external view returns (bytes32);
    function deploymentId() external view returns (bytes32);
    function chainTag() external view returns (bytes32);
    function isNonceUsed(uint256 nonce) external view returns (bool);
}
