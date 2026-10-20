// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPlanRegistry, PayeeBinding, QueuedLoosen, Sig, HogeeKinds} from "./interfaces/IHogee.sol";
import {HogeeTypes} from "./interfaces/HogeeTypes.sol";
import {HogeeDomain} from "./HogeeDomain.sol";
import {RollingWindow} from "./RollingWindow.sol";
import {IFounderVerifier, TreasuryLinks} from "./HogeeHooks.sol";

/// @title TreasuryState: Treasury storage, immutables and the guards shared by Treasury and its governance module.
/// @notice Split out of TreasuryStorage (task 1.8) so the delegate-only TreasuryGovernance module can use the exact
///         storage layout of Treasury without inheriting the ITreasury views. Every state variable of the Treasury
///         lives here (or in HogeeDomain); contracts deriving from it declare none, so both layouts are identical.
///         Budget units (BU) are an internal ledger in minor units: non-transferable, not pegged, not redeemable,
///         no external balance surface (D4). Nothing here moves value outside this contract.
abstract contract TreasuryState is HogeeDomain {
    using RollingWindow for RollingWindow.Queue;

    /// Effective config and counters of one plan line (a "pocket").
    struct LineState {
        uint32 version; // plan version this config belongs to; active iff == current version
        uint32 windowSeconds;
        uint64 validUntil;
        uint64 seq; // pacing slots paid so far (next expected slot = seq + 1)
        bool escrowOnly;
        bool paused; // TIGHTEN_PAUSE_LINE
        bool circuitOpen; // circuit breaker (§8.8)
        uint128 allocatedMinor;
        uint128 spentMinor;
        uint128 escrowedMinor;
        uint128 perTxCapMinor;
        uint128 windowCapMinor;
        uint128 pacingMinor;
    }

    /// What failSettlement must undo. kind 0 = no record (settlementId unknown, intent unused).
    struct SettlementRecord {
        bytes32 lineId;
        bytes32 payeeId;
        uint128 amountMinor;
        uint8 kind;
        uint8 state; // HogeeKinds.SETTLEMENT_*
    }

    /// A stage of the plan, recorded at the first commit (stages never change afterwards: PlanReplan).
    struct StageState {
        uint128 releaseMinor;
        bool known;
        bool released;
    }

    /// Last two denial times per key (lineId, or 0 / a line outside the plan) and the rate-limit horizon.
    struct DenialTrack {
        uint64 last;
        uint64 prev;
        uint64 blockedUntil;
    }

    uint8 internal constant SETTLEMENT_KIND_SPEND = 1; // spend, ownerSpend: refund to the line pocket
    uint8 internal constant SETTLEMENT_KIND_MILESTONE = 2; // milestone release: refund to the supplier line (M-1)
    uint8 internal constant SETTLEMENT_KIND_RESERVE = 3; // WITHDRAW_RESERVE: refund to the reserve
    uint256 internal constant MAX_LIVE_SPENDS_PER_WINDOW = 64;
    uint256 internal constant MAX_LOOSEN_TIMELOCK = 30 days;
    /// §8.8: a queued loosening can be executed from executableAt until executableAt + this, then it is EXPIRED.
    uint64 internal constant LOOSEN_GRACE = 7 days;
    /// Live (queued, unexpired) loosenings at once: bounds the loop in pause, which cancels them all.
    uint256 internal constant MAX_QUEUED_LOOSENS = 16;
    uint256 internal constant BPS = 10_000;
    /// The reserve is not a line (§26.2): this id is refused by spend and ownerSpend (ReserveLocked, T8); only a
    /// founder + lender LOOSEN_WITHDRAW_RESERVE after the timelock moves reserve BU.
    bytes32 internal constant LINE_RESERVE = "RESERVE";

    /// PlanRegistry of this deployment (source of the founder key, lender and domain tags).
    address public immutable registry;
    address internal immutable _LENDER;
    address internal immutable _ORACLE;
    /// Veto window for a newly bound payee (§8.1 payee registry + cooling period). Production must use 24 h; the deploy
    /// scripts refuse less than the labelled-demo 120 s off Anvil.
    uint64 public immutable coolingSeconds;
    /// MilestoneEscrow of this deployment (0 on the loop-1 shape).
    address public immutable escrow;
    /// SalesOracle of this deployment (0 on the loop-1 shape).
    address public immutable salesOracle;
    /// Optional OBSERVER (§8.2): may cancel a queued loosening; 0 = none.
    address public immutable observer;
    /// §8.8 loosening timelock: production must use 24 h; 120 s in the labelled demo, the deploy scripts' floor off
    /// Anvil. The constructor accepts 1 s to 30 days so Anvil tests can use short values.
    uint64 public immutable loosenTimelockSeconds;

    // ---- facility and ledger ----
    uint128 internal _capMinor;
    uint16 internal _reserveFloorBps;
    bool internal _opened;
    bool internal _paused;
    // Written by Treasury (fund, syncPlan, creditRevenue); the delegate-only module only reads it.
    // forge-lint: disable-next-line(uninitialized-state)
    uint128 internal _fundedMinor;
    /// Written only by _raiseReleased: the sum of the released stages' releaseMinor, <= plan total.
    uint128 internal _releasedMinor;
    uint128 internal _spentMinor;
    // Written by the MilestoneEscrow / SalesOracle hooks (task 1.8); always 0 on the loop-1 shape.
    // forge-lint: disable-next-line(uninitialized-state)
    uint128 internal _escrowedMinor;
    // forge-lint: disable-next-line(uninitialized-state)
    uint128 internal _revenueMinor;
    // forge-lint: disable-next-line(uninitialized-state)
    uint128 internal _reserveMinor;

    // ---- mirror of the current plan (pushed by PlanRegistry.syncPlan) plus its mutable agent state ----
    // Written by Treasury (fund, syncPlan, creditRevenue); the delegate-only module only reads it.
    // forge-lint: disable-next-line(uninitialized-state)
    bytes32 internal _planId;
    // Written by Treasury (fund, syncPlan, creditRevenue); the delegate-only module only reads it.
    // forge-lint: disable-next-line(uninitialized-state)
    uint32 internal _planVersion;
    uint64 internal _agentExpiry;
    // Written by Treasury (fund, syncPlan, creditRevenue); the delegate-only module only reads it.
    // forge-lint: disable-next-line(uninitialized-state)
    address internal _agent;
    // Written by Treasury (fund, syncPlan, creditRevenue); the delegate-only module only reads it.
    // forge-lint: disable-next-line(uninitialized-state)
    bool internal _agentRevoked;
    uint16 internal _reserveBps;
    // Written by Treasury (fund, syncPlan, creditRevenue); the delegate-only module only reads it.
    // forge-lint: disable-next-line(uninitialized-state)
    uint128 internal _planTotalMinor;

    mapping(bytes32 lineId => LineState) internal _lines;
    mapping(bytes32 stageId => StageState) internal _stages;
    mapping(bytes32 lineId => RollingWindow.Queue) internal _windows;
    mapping(bytes32 lineId => mapping(bytes32 payeeId => PayeeBinding)) internal _bindings;
    /// Bound by a founder-signed approval (bindPayee; LOOSEN_ADD_PAYEE), not by listing a static platform payee.
    mapping(bytes32 lineId => mapping(bytes32 payeeId => bool)) internal _signedPayee;
    /// Plan version that last listed the payee on the line (Treasury._syncLine; LOOSEN_ADD_PAYEE stamps the current
    /// version too). spend pays a payee only while this equals the current version, so a payee a re-commit drops stops
    /// being payable although its binding data stays (run-2 audit).
    mapping(bytes32 lineId => mapping(bytes32 payeeId => uint32 version)) internal _listedVersion;
    /// Static platform registry, fixed in the constructor (e.g. a marketplace's ads account): payoutAccountHash.
    mapping(bytes32 payeeId => bytes32 payoutAccountHash) internal _platformPayout;
    mapping(bytes32 settlementId => SettlementRecord) internal _settlements;
    mapping(bytes32 invoiceHash => bool) internal _invoicePaid;
    mapping(bytes32 orderId => bool) internal _orderUsed;
    mapping(bytes32 key => DenialTrack) internal _denials;

    // ---- task 1.8 (appended, so the loop-1 slots above keep their places) ----
    /// Every skim into the reserve (SalesOracle) and every executed WITHDRAW_RESERVE net of failed settlements, so
    /// reserve == skimmed - withdrawn (§8.9 invariant 2 and 3).
    uint128 internal _reserveSkimmedMinor;
    uint128 internal _reserveWithdrawnMinor;
    /// Recorded sales (METRIC_ORDERS stage gates; a zero-amount bucket still counts).
    // Written by Treasury (fund, syncPlan, creditRevenue); the delegate-only module only reads it.
    // forge-lint: disable-next-line(uninitialized-state)
    uint64 internal _salesCount;
    /// Founder + lender co-signed loosenings by loosenId (= HogeeTypes.hashLoosenRequest).
    mapping(bytes32 loosenId => QueuedLoosen) internal _loosens;
    /// The loosenings pause must cancel: queued, not yet executed or cancelled (expired ones are pruned on queue).
    bytes32[] internal _queuedIds;

    // Roles are checked non-zero by the deploy scripts; a zero address here only bricks this deployment.
    // forge-lint: disable-next-item(missing-zero-check)
    constructor(address registry_, address oracle_, uint64 coolingSeconds_, TreasuryLinks memory links)
        HogeeDomain(
            IPlanRegistry(registry_).deploymentId(),
            IPlanRegistry(registry_).chainTag(),
            HogeeDomain(registry_).fiscoMs()
        )
    {
        address lender_ = IPlanRegistry(registry_).lender();
        if (oracle_ == lender_) revert NotOracle(); // role separation (run-2 audit): the lender never settles
        // The optional observer's veto (cancelLoosen) sits on its own key (audit run-3); PlanConstitution keeps the
        // agent off it and PlanRegistry.registerFounderKey the owner EOA.
        address observer_ = links.observer;
        if (observer_ != address(0) && (observer_ == lender_ || observer_ == oracle_)) {
            revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        }
        uint64 timelock = links.loosenTimelockSeconds;
        if (timelock == 0 || timelock > MAX_LOOSEN_TIMELOCK) {
            revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        }
        registry = registry_;
        _LENDER = lender_;
        _ORACLE = oracle_;
        coolingSeconds = coolingSeconds_;
        escrow = links.escrow;
        salesOracle = links.salesOracle;
        observer = observer_;
        loosenTimelockSeconds = timelock;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Guards
    // ---------------------------------------------------------------------------------------------------------

    function _isActive(LineState storage l) internal view returns (bool) {
        return l.version != 0 && l.version == _planVersion;
    }

    /// spend rows 1-3 (fundMilestone rows 1-3 through Treasury.requireAgent): the current plan's agent, not revoked,
    /// treasury not paused, not expired.
    function _requireSpendingAgent(address caller) internal view {
        if (caller != _agent || _agentRevoked) revert NotAgent();
        if (_paused) revert Paused();
        if (_now() > _agentExpiry) revert AgentExpired();
    }

    /// recordDenied rows 1-2: the current plan's agent, not revoked, not expired (allowed while paused).
    function _requireAgent() internal view {
        if (msg.sender != _agent || _agentRevoked) revert NotAgent();
        if (_now() > _agentExpiry) revert AgentExpired();
    }

    /// tighten/pause row 1: the active agent, the owner EOA or the lender. Returns whether the caller is the agent.
    function _requireTightener() internal view returns (bool isAgent) {
        if (msg.sender == _agent && msg.sender != address(0)) {
            if (_agentRevoked) revert NotAgent();
            if (_now() > _agentExpiry) revert AgentExpired();
            return true;
        }
        if (msg.sender == _LENDER) return false;
        // forge-lint: disable-next-line(unused-return)
        (,, address ownerEOA) = IPlanRegistry(registry).founderKey(); // only the EOA can send a tx
        if (ownerEOA != address(0) && msg.sender == ownerEOA) return false;
        revert NotAgent();
    }

    /// The digest of a struct under Treasury's EIP-712 domain, from address(this). Equal to HogeeDomain._digest in
    /// Treasury; the governance module runs by delegatecall in Treasury's context, where address(this) is Treasury,
    /// while its own immutable separator names the module. Every struct verified in the module uses this.
    function _treasuryDigest(bytes32 structHash) internal view returns (bytes32) {
        return HogeeTypes.digest(HogeeTypes.domainSeparator(address(this), chainTag(), deploymentId()), structHash);
    }

    /// ENV-4 for structs verified by Treasury: the founder key lives in PlanRegistry.
    function _requireFounder(bytes32 digest, Sig calldata sig) internal view {
        (bool ok, address signer) = IFounderVerifier(registry).checkFounderSig(digest, sig);
        if (ok) return;
        if (signer != address(0) && (signer == _agent || signer == _LENDER)) revert NotOwner();
        revert InvalidSignature();
    }

    /// Lender co-signature: the lender is an EOA, so only kind 0 (65-byte ECDSA, low-s) can verify. Returns the
    /// recovered signer, or 0 for another kind or a malformed signature.
    function _lenderSigner(bytes32 digest, Sig calldata sig) internal pure returns (address signer) {
        if (sig.kind != HogeeKinds.SIG_ECDSA) return address(0);
        (address s, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig.data);
        return err == ECDSA.RecoverError.NoError ? s : address(0);
    }

    /// The only writer of releasedMinor (task 1.4 item c): the stage belongs to the plan, is released at most once,
    /// and the running total never exceeds the plan total. So releasedMinor == the sum of the released stages'
    /// releaseMinor <= sum(stages) == totalMinor (code 12). Callers: syncPlan (stage 0, first commit) and
    /// releaseStage after the lender signature and the gate.
    function _raiseReleased(bytes32 stageId) internal {
        StageState storage st = _stages[stageId];
        uint256 next = uint256(_releasedMinor) + st.releaseMinor;
        if (!st.known || st.released || next > _planTotalMinor) revert CapExceeded();
        st.released = true;
        // Logged by PlanCommitted.releasedMinor (stage 0, same transaction) or StageReleased (releaseStage).
        // next <= _planTotalMinor (uint128), checked above: the cast cannot truncate.
        // forge-lint: disable-next-item(missing-events-arithmetic, unsafe-typecast)
        _releasedMinor = uint128(next);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Payment checks and effects shared by spend (Treasury) and ownerSpend (TreasuryGovernance)
    // ---------------------------------------------------------------------------------------------------------

    /// spend rows 10-11. Row 10: bound to the line and listed on it by the current plan version (run-2 audit: a payee a
    /// re-commit drops keeps its binding data but is not payable). The caller checked the line is active, so
    /// _planVersion != 0.
    function _requirePayeeReady(bytes32 lineId, bytes32 payeeId) internal view {
        PayeeBinding storage b = _bindings[lineId][payeeId];
        if (!b.bound || _listedVersion[lineId][payeeId] != _planVersion) revert PayeeNotBound();
        if (_now() < b.coolingUntil) revert PayeeCooling();
    }

    /// spend rows 13-16.
    function _requireInvoice(LineState storage l, bytes32 invoiceHash, uint128 amountMinor) internal view {
        if (l.pacingMinor == 0) {
            if (_invoicePaid[invoiceHash]) revert DuplicateInvoice();
            return;
        }
        uint256 slot = uint256(invoiceHash);
        uint256 next = uint256(l.seq) + 1;
        if (slot < next) revert DuplicateInvoice(); // that pacing slot is already paid
        if (slot > next || amountMinor > l.pacingMinor) revert CapExceeded(); // no skipping ahead; slot amount
    }

    /// The effects of a payment out of a line pocket (spend and ownerSpend): invoice paid or pacing slot consumed,
    /// pocket / total / payee spent, and the settlement record (spendId == settlementId). spend also adds a window
    /// entry; ownerSpend does not (it is not agent outflow).
    function _recordOutflow(bytes32 spendId, bytes32 lineId, bytes32 payeeId, bytes32 invoiceHash, uint128 amountMinor)
        internal
    {
        LineState storage l = _lines[lineId];
        if (l.pacingMinor == 0) _invoicePaid[invoiceHash] = true;
        else ++l.seq;
        l.spentMinor += amountMinor;
        _spentMinor += amountMinor;
        _bindings[lineId][payeeId].paidMinor += amountMinor;
        // Logged by Spent / OwnerSpent (spendId == settlementId) in the same call.
        // forge-lint: disable-next-line(missing-events-access-control)
        _settlements[spendId] = SettlementRecord({
            lineId: lineId,
            payeeId: payeeId,
            amountMinor: amountMinor,
            kind: SETTLEMENT_KIND_SPEND,
            state: HogeeKinds.SETTLEMENT_NONE
        });
    }
}
