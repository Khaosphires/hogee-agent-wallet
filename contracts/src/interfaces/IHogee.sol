// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {HogeeKinds} from "./HogeeKinds.sol"; // frozen numeric codes (tighten/loosen kinds, CONST_*, METRIC_*)
// G0-REVIEW: errors, events and domain views moved to IHogeeBase.sol (file size); re-imported here.
import {IHogeeErrors, IHogeeEvents, IHogeeDomain} from "./IHogeeBase.sol";

/*
 * Hogee frozen on-chain interface (gate G0; project.md §8, §26.9).
 *
 * - Budget units (BU) are an internal ledger of one facility: not pegged, not redeemable, no external
 *   balance surface. Every amount is uint128 minor units (1 BU = 100 minor).
 * - Ids are bytes32. lineId = stringToHex(lineKey, {size: 32}) (right-padded UTF-8, §26.3); payeeId is the
 *   id of a registered test payout account (payees are off-chain bank accounts, not addresses);
 *   decisionId is a UUIDv7 left-padded to bytes32.
 * - Times are unix seconds (uint64). On FISCO the implementation's _now() divides block.timestamp by 1000.
 * - Free-form codes (reasonCode, settlement failure code) are stringToHex(code, {size: 32}).
 * - After G0 only additive changes are allowed (§26.10). Lines marked G0-DECISION await lead approval.
 */

// ---------------------------------------------------------------------------------------------------------
// Structs (file level). The six signed structs are EIP-712 types; see HogeeTypes.sol for the type strings.
// ---------------------------------------------------------------------------------------------------------

/// Signature wrapper. kind 0 (ECDSA): 65 bytes r‖s‖v. kind 1 (WebAuthn): abi.encode(WebAuthn.WebAuthnAuth)
/// from OZ 5.x = (bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData,
/// string clientDataJSON), s in the low half of the P-256 order.
struct Sig {
    uint8 kind;
    bytes data;
}

/// Founder approval of a plan version. Verified by PlanRegistry.
struct PlanApproval {
    bytes32 planId;
    uint32 version;
    bytes32 prevPlanHash; // compare-and-swap against the stored planHash (0 for version 1)
    bytes32 planHash; // keccak256(utf8(JCS(PlanManifest)))
    bytes32 countryPackHash; // keccak256(utf8(JCS(CountryPack)))
    // G0-DECISION: binds the Line[] and Stage[] calldata of commitPlan to the signature (§13.1 #5, T27).
    bytes32 linesHash; // HogeeTypes.hashLines(lines) = keccak256(abi.encode(lines))
    bytes32 stagesHash; // HogeeTypes.hashStages(stages) = keccak256(abi.encode(stages))
    uint128 totalMinor;
    uint16 reserveBps;
    address agent; // agent session key authorised by this plan
    uint64 agentExpiry;
    bytes32 deploymentId;
    uint256 nonce;
    uint64 expiry; // signature expiry
}

/// One budget line (pocket) of a plan.
struct Line {
    bytes32 lineId;
    uint128 amountMinor;
    uint128 perTxCapMinor; // constitution: <= 25% of amountMinor; applies to spend only
    uint128 windowCapMinor; // constitution: <= 50% of amountMinor; rolling window of windowSeconds
    uint32 windowSeconds;
    uint64 validUntil; // constitution: <= now + 90 days
    // G0-DECISION: 0 = invoice-backed line. >0 = no-invoice pacing line (e.g. ADS): invoiceHash must be the
    // line's next sequence number (ITreasury.lineSequence) and amount <= pacingMinor (§8.4).
    uint128 pacingMinor;
    bool escrowOnly; // payable only through MilestoneEscrow (the SUPPLIER line must set this)
    bytes32[] payeeIds; // must already be bound or in the static platform registry (a plan cannot add payees)
}

/// Staged release. Stage index 0 is released at commitPlan (constitution: <= 40% of the total).
struct Stage {
    bytes32 stageId;
    uint128 releaseMinor;
    uint8 metric; // HogeeKinds.METRIC_*
    uint128 target; // minor units for METRIC_SALES_MINOR, a count for METRIC_ORDERS
    uint64 deadline;
}

/// Founder's choice of supplier plus the pre-signed milestone schedule. Verified by Treasury (bindPayee).
struct SupplierApproval {
    bytes32 orderId;
    bytes32 supplierId;
    bytes32 payee; // payeeId (ShortId, stringToHex) of the supplier's registered test payout account
    // G0-REVIEW (M7, T1): keccak256(utf8(JCS({channel, accountNumber, holderName}))) of that payout account.
    // The founder signs the bank destination; the settlement adapter must check it before every payout.
    bytes32 payoutAccountHash;
    bytes32 lineId; // G0-DECISION: the line the payee binds to (must be escrowOnly)
    bytes32 scheduleHash; // HogeeTypes.scheduleHash(schedule, autoRelease)
    uint128 totalMinor; // sum of the schedule; becomes the payee's lifetime cap
    bytes32 quoteHash;
    bytes32 shortlistHash;
    uint8 chosenIndex;
    bool inspectionRequired;
    bytes32 deploymentId;
    uint256 nonce;
    uint64 expiry;
}

/// Founder release of a non-auto milestone. Verified by MilestoneEscrow.
struct MilestoneRelease {
    bytes32 orderId;
    uint8 idx;
    uint128 amountMinor;
    bytes32 evidenceHash; // inspection evidence; required (EvidenceMissing) when the order needs inspection
    bytes32 deploymentId;
    uint256 nonce;
    uint64 expiry;
}

/// Loosening request; executes after the timelock. Verified by Treasury. Field meaning per kind: HogeeKinds.LOOSEN_*.
/// G0-REVIEW (H2): co-signed by founder AND lender for every kind where HogeeKinds.requiresLender(kind) (all today).
struct LoosenRequest {
    uint8 kind;
    bytes32 target;
    bytes32 aux; // G0-DECISION: second operand (MOVE_POCKETS to-line, ADD_PAYEE line); 0 when unused
    uint256 newValue;
    bytes32 deploymentId;
    uint256 nonce;
    uint64 expiry;
}

/// Lender release of a stage. Verified by Treasury.
struct StageRelease {
    bytes32 stageId;
    uint128 amountMinor; // must equal the stage's releaseMinor
    bytes32 deploymentId;
    uint256 nonce;
    uint64 expiry;
}

/// G0-DECISION: founder's manual fallback spend (ownerSpend, NFRA 二十六). §8.7 had no typed struct for it,
/// and a passkey owner cannot send a transaction, so the relayer submits this signed struct. Verified by Treasury.
/// G0-REVIEW (H4): emits OwnerSpent, never Spent.
struct OwnerSpend {
    bytes32 lineId;
    bytes32 payeeId;
    uint128 amountMinor;
    bytes32 invoiceHash;
    bytes32 deploymentId;
    uint256 nonce;
    uint64 expiry;
}

// ---- View structs (G0-DECISION: read surface for the worker, API and UI; not signed) ----

struct PlanState {
    bytes32 planId;
    uint32 version;
    bytes32 planHash;
    bytes32 countryPackHash;
    uint128 totalMinor;
    uint16 reserveBps; // current value (tighten may raise it)
    address agent;
    uint64 agentExpiry;
    bool agentRevoked;
    uint64 committedAt;
}

struct Facility {
    uint128 capMinor;
    uint16 reserveFloorBps;
    uint128 fundedMinor;
    bool opened;
}

struct Balances {
    uint128 fundedMinor;
    uint128 releasedMinor;
    uint128 spentMinor; // spend + ownerSpend
    uint128 escrowedMinor; // funded into milestones
    uint128 revenueMinor;
    uint128 reserveMinor;
}

/// Current state of one line. Caps reflect tighten/loosen changes since commitPlan.
struct Pocket {
    uint128 allocatedMinor; // line amount after MOVE_POCKETS
    uint128 spentMinor;
    uint128 escrowedMinor;
    uint128 availableMinor; // allocated - spent - escrowed
    uint128 perTxCapMinor;
    uint128 windowCapMinor;
    uint128 windowSpentMinor;
    uint32 windowSeconds;
    uint64 validUntil;
    uint128 pacingMinor;
    bool escrowOnly;
    bool paused;
    bool circuitOpen;
}

struct PayeeBinding {
    bool bound;
    uint64 coolingUntil; // spends revert PayeeCooling before this time
    uint128 lifetimeCapMinor; // type(uint128).max when uncapped (platform payees)
    uint128 paidMinor;
    bytes32 payoutAccountHash; // G0-REVIEW (M7): signed payout destination the settlement adapter checks
}

struct QueuedLoosen {
    uint8 kind;
    bytes32 target;
    bytes32 aux;
    uint256 newValue;
    uint64 executableAt;
    uint64 expiresAt;
    uint8 status; // HogeeKinds.LOOSEN_STATUS_*
}

struct EscrowOrder {
    bytes32 payeeId;
    bytes32 lineId;
    uint128 totalMinor;
    uint8 milestoneCount;
    bool inspectionRequired;
    bool exists;
}

struct Milestone {
    uint128 amountMinor; // signed schedule amount
    uint128 fundedMinor; // cumulative; <= amountMinor (AmountExceedsSchedule)
    bool autoRelease;
    bool released;
    bytes32 evidenceHash;
}

// ---------------------------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------------------------

interface IPlanRegistry is IHogeeErrors, IHogeeEvents, IHogeeDomain {
    /// LENDER only. qx = qy = 0 means an ECDSA-only owner.
    /// G0-REVIEW (H3): once per facility; a second call reverts FounderKeyAlreadySet. Key rotation is out of
    /// scope (a lost passkey falls back to the ownerEOA; otherwise redeploy and re-sign).
    function registerFounderKey(bytes32 qx, bytes32 qy, address ownerEOA) external;

    /// Verifies the founder signature over `approval` (which commits to linesHash/stagesHash), runs the
    /// constitution (reverts PlanInvariantViolated(code) even with a valid signature) and releases stage 0.
    /// G0-AUDIT (v-1). Sequencing: approval.version == planVersion() + 1 and planId unchanged, else StalePlan (the
    /// first commit has planVersion() == 0, version 1 and prevPlanHash 0). Codes 1-13 are checked first. Then, once
    /// planVersion() > 0 (stored state, not the signed number), only the founder has signed, so the new version may
    /// only TIGHTEN the current on-chain state, else PlanInvariantViolated(CONST_REPLAN_LOOSENS):
    /// - the same set of lineIds (stored order kept); every amountMinor equals the line's current allocation (after
    ///   MOVE_POCKETS); stages, totalMinor and countryPackHash identical to the current version;
    /// - per line: perTxCapMinor, windowCapMinor and validUntil <= current; windowSeconds >= current; pacingMinor
    ///   <= current and zero only if it is zero now; escrowOnly never cleared; payeeIds within the line's current
    ///   payees (its payeeIds plus payees bound to it since);
    /// - reserveBps >= current; agent unchanged; agentExpiry <= current.
    /// Only the first commit releases stage 0. A re-commit writes plan parameters only: it never resets or clears
    /// runtime state (pause, line pauses, circuits and denial counts, window spend, lineSequence, payee bindings,
    /// used intents and invoices, agentRevoked) and never raises releasedMinor. Any other change is a loosening and
    /// needs a lender-co-signed LOOSEN_* kind; one with no kind yet (e.g. a new agent) needs a new additive kind or
    /// a new deployment.
    function commitPlan(
        PlanApproval calldata approval,
        Line[] calldata lines,
        Stage[] calldata stages,
        Sig calldata founder
    ) external;

    // ---- views (G0-DECISION) ----
    function planVersion() external view returns (uint32);
    function currentPlan() external view returns (PlanState memory);
    function lineIds() external view returns (bytes32[] memory);
    function line(bytes32 lineId) external view returns (Line memory);
    function stageIds() external view returns (bytes32[] memory);
    function stage(bytes32 stageId) external view returns (Stage memory stage_, bool released);
    function founderKey() external view returns (bytes32 qx, bytes32 qy, address ownerEOA);
    function lender() external view returns (address);
}

interface ITreasury is IHogeeErrors, IHogeeEvents, IHogeeDomain {
    // ---- lender ----
    function openFacility(uint128 capMinor, uint16 reserveFloorBps) external;
    function fund(uint128 amountMinor) external;
    function releaseStage(StageRelease calldata req, Sig calldata lender) external;

    // ---- founder-signed (relayer submits) ----
    /// Binds `approval.payee` to `approval.lineId` (cooling period) and opens the escrow order with the
    /// pre-signed schedule; scheduleHash must equal HogeeTypes.scheduleHash(schedule, autoRelease).
    function bindPayee(
        SupplierApproval calldata approval,
        uint128[] calldata schedule,
        bool[] calldata autoRelease,
        Sig calldata founder
    ) external;
    /// Founder's manual fallback (NFRA 二十六). G0-REVIEW (H4/H5): emits OwnerSpent (not Spent); spendId ==
    /// intentId (same formula as spend, marks the intent used) == settlementId.
    /// ENFORCES: founder signature + expiry + nonce; not an escrowOnly line (EscrowOnly); payee bound to the
    /// line (PayeeNotBound) and cooled (PayeeCooling); DuplicateInvoice; line balance and releasedMinor
    /// (CapExceeded); validUntil (LineExpired).
    /// G0-REVIEW: manual takeover of supplier payments goes through releaseMilestone for already-funded
    /// milestones; owner-side milestone funding is out of scope for G0.
    /// SKIPS: the agent checks (role, expiry, planVersion), the perTx/window caps, and pause, including line
    /// pauses and a tripped circuit (§8.8: pause never blocks the owner's manual fallback).
    function ownerSpend(OwnerSpend calldata req, Sig calldata founder) external returns (bytes32 spendId);
    /// G0-REVIEW (H2): both `founder` and `lender` must be valid for every kind where
    /// HogeeKinds.requiresLender(req.kind) (all current kinds), else InvalidSignature. No threshold.
    /// loosenId = HogeeTypes.hashLoosenRequest(req) (the EIP-712 struct hash).
    function queueLoosen(LoosenRequest calldata req, Sig calldata founder, Sig calldata lender)
        external
        returns (bytes32 loosenId);
    /// Anyone may execute once executableAt has passed and before expiresAt.
    /// G0-REVIEW (H2): re-checks the §8.3 bounds the change touches, at execution time, and reverts
    /// PlanInvariantViolated(code): RAISE_PER_TX_CAP <= 25% of the line (CONST_PER_TX_CAP_OVER_25PCT);
    /// RAISE_WINDOW_CAP <= 50% of the line (CONST_WINDOW_CAP_OVER_50PCT); EXTEND_AGENT_EXPIRY <= now + 90 days
    /// (CONST_AGENT_EXPIRY_TOO_LATE); EXTEND_LINE_EXPIRY <= now + 90 days (CONST_LINE_VALIDITY_TOO_LONG);
    /// MOVE_POCKETS keeps the from-line's caps <= 25% / 50% of its reduced amount (same two codes).
    /// WITHDRAW_RESERVE emits ReserveWithdrawn(loosenId, taxPayeeId, amount) and is settled like a spend.
    function executeLoosen(bytes32 loosenId) external;
    /// Owner EOA, lender or observer (veto within the timelock window).
    function cancelLoosen(bytes32 loosenId) external;

    // ---- agent ----
    /// §8.4. Returns spendId == intentId = keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, amountMinor)).
    /// G0-REVIEW (H5): reverts MissingDecision if decisionId or rationaleHash is 0. Emits Spent.
    /// G0-REVIEW (§8.3/§8.4): reverts EscrowOnly on an escrowOnly line (pay those via fundMilestone).
    function spend(
        bytes32 lineId,
        bytes32 payeeId,
        uint128 amountMinor,
        bytes32 invoiceHash,
        uint32 planVersion,
        bytes32 decisionId,
        bytes32 rationaleHash
    ) external returns (bytes32 spendId);
    /// Tighten-only change (HogeeKinds.TIGHTEN_*). Agent, owner EOA or lender; instant.
    function tighten(uint8 kind, bytes32 target, uint256 newValue, bytes32 decisionId) external;
    /// Tighten-only; cancels everything queued. Agent, owner EOA or lender.
    function pause() external;
    /// G0-DECISION: lineId added (the circuit breaker counts denials per line, §8.8); 0 = not line-specific.
    /// reasonCode = stringToHex(code, {size: 32}) where code is a §8.5 error name or a policy reason code.
    function recordDenied(bytes32 lineId, bytes32 decisionId, bytes32 reasonCode, bytes32 proposalHash) external;

    // ---- oracle ----
    // settlementId = spendId (Spent, OwnerSpent), keccak256(abi.encode(orderId, idx)) (MilestoneReleased) or
    // loosenId (ReserveWithdrawn). G0-REVIEW (M8): each settlementId moves NONE -> CONFIRMED or NONE -> FAILED
    // exactly once; a second confirm/fail reverts SettlementClosed. Payout retries (attempt + 1) happen off-chain
    // before either call.

    function confirmSettlement(bytes32 settlementId, bytes32 payoutRefHash) external;
    /// G0-DECISION: code = stringToHex(payout failure code, {size: 32}), e.g. "INVALID_DESTINATION".
    /// G0-REVIEW (M8): returns the amount to its source (the line pocket for a spend/ownerSpend, the escrow
    /// milestone for a milestone release, the reserve for a reserve withdrawal) and emits SettlementFailed.
    function failSettlement(bytes32 settlementId, bytes32 code) external;

    // ---- views (§26.9) ----
    function pocket(bytes32 lineId) external view returns (Pocket memory);
    function isIntentUsed(bytes32 intentId) external view returns (bool);
    function rollingSpent(bytes32 lineId) external view returns (uint128);
    function reserve() external view returns (uint128);
    function revenue() external view returns (uint128);
    function releasedMinor() external view returns (uint128);
    function agentExpiry() external view returns (uint64);

    // ---- views (G0-DECISION) ----
    function facility() external view returns (Facility memory);
    function balances() external view returns (Balances memory);
    function isInvoicePaid(bytes32 invoiceHash) external view returns (bool);
    function payeeBinding(bytes32 lineId, bytes32 payeeId) external view returns (PayeeBinding memory);
    /// Next expected invoiceHash (as uint) for a pacing line (Line.pacingMinor > 0).
    function lineSequence(bytes32 lineId) external view returns (uint64);
    function queuedLoosen(bytes32 loosenId) external view returns (QueuedLoosen memory);
    /// HogeeKinds.SETTLEMENT_*; CONFIRMED and FAILED are terminal.
    function settlementState(bytes32 settlementId) external view returns (uint8);
    function paused() external view returns (bool);
}

interface IMilestoneEscrow is IHogeeErrors, IHogeeEvents, IHogeeDomain {
    /// Agent only. Bounded by the signed schedule (cumulative), the supplier line balance and releasedMinor;
    /// not by perTxCap. An autoRelease milestone releases when fully funded.
    /// G0-REVIEW (H5): reverts MissingDecision if decisionId or rationaleHash is 0.
    /// G0-REVIEW (H6): reverts PayeeCooling before the order payee's coolingUntil, autoRelease milestones
    /// included, so a freshly bound supplier cannot be paid inside the veto window.
    function fundMilestone(bytes32 orderId, uint8 idx, uint128 amountMinor, bytes32 decisionId, bytes32 rationaleHash)
        external;
    /// Founder-signed release of a non-auto milestone (relayer submits). The agent alone gets MilestoneLocked.
    function releaseMilestone(MilestoneRelease calldata release, Sig calldata founder) external;

    // ---- views (G0-DECISION) ----
    function order(bytes32 orderId) external view returns (EscrowOrder memory);
    function milestones(bytes32 orderId) external view returns (Milestone[] memory);
}

interface ISalesOracle is IHogeeErrors, IHogeeEvents {
    /// ORACLE only. saleIdHash = keccak256(utf8(stripeEventId)); unique (DuplicateSale). Credits Treasury
    /// revenue and skims reserveBps into the reserve. G0-DECISION: amountBucket is minor units, rounded down
    /// off-chain to the bucket size so single sales stay private.
    function recordSale(bytes32 saleIdHash, uint128 amountBucket) external;

    // ---- views (G0-DECISION) ----
    function isSaleRecorded(bytes32 saleIdHash) external view returns (bool);
}
