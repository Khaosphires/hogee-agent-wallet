// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {
    IPlanRegistry,
    ITreasury,
    PlanApproval,
    PlanState,
    Facility,
    Line,
    Stage,
    Sig,
    HogeeKinds
} from "./interfaces/IHogee.sol";
import {HogeeTypes} from "./interfaces/HogeeTypes.sol";
import {HogeeDomain} from "./HogeeDomain.sol";
import {HogeeSigs} from "./HogeeSigs.sol";
import {PlanConstitution} from "./PlanConstitution.sol";
import {PlanReplan} from "./PlanReplan.sol";
import {ITreasuryHooks, ITreasuryLinks, IFounderVerifier, PlanSync} from "./HogeeHooks.sol";

/// @title PlanRegistry: versioned founder-signed plans with the on-chain constitution (project.md §8.1, §8.3).
/// @notice Holds the founder key (registered once by the lender, H3), verifies PlanApproval signatures under the
///         custom EIP-712 domain, compare-and-swaps the plan hash (versions are sequential), rejects any plan that
///         breaks the constitution, rejects any re-commit that loosens the current state (G0 audit v-1) and pushes
///         the committed plan into Treasury, which releases stage 0 on the first commit only. No upgradeability:
///         redeploy instead. Every check: docs/assurance/require-table-loop1.md.
contract PlanRegistry is HogeeDomain, IPlanRegistry, IFounderVerifier {
    struct FounderKey {
        bytes32 qx;
        bytes32 qy;
        address ownerEOA;
        bool set;
    }

    address private immutable _LENDER;
    /// Treasury of this deployment (CREATE address precomputed by the deploy script; Treasury reads us back).
    address public immutable treasury;
    /// G0-DECISION (§1 #3): end of the judging window; the authorised agentExpiry must be later (CONST 3).
    uint64 public immutable judgingWindowEnd;

    FounderKey private _founder;

    // ---- current plan (signed values; the mutable agent/reserve/pocket state and stage releases live in Treasury) ----
    // The set of lines and the stages are fixed by version 1: a re-commit keeps them (PlanReplan), so an id is in the
    // current plan iff it is stored here.
    bytes32 private _planId;
    uint32 private _version;
    uint64 private _committedAt;
    address private _agent;
    bytes32 private _planHash;
    bytes32 private _countryPackHash;
    bytes32 private _stagesHash;
    uint128 private _totalMinor;

    bytes32[] private _lineIds;
    mapping(bytes32 lineId => Line) private _lines;
    bytes32[] private _stageIds;
    mapping(bytes32 stageId => Stage) private _stages;

    // Roles are checked non-zero by script/DeployLoop.s.sol; a zero address here only bricks this deployment.
    // forge-lint: disable-next-item(missing-zero-check)
    constructor(
        address lender_,
        address treasury_,
        bytes32 deploymentId_,
        bytes32 chainTag_,
        bool fiscoMs_,
        uint64 judgingWindowEnd_
    ) HogeeDomain(deploymentId_, chainTag_, fiscoMs_) {
        _LENDER = lender_;
        treasury = treasury_;
        judgingWindowEnd = judgingWindowEnd_;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Lender
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IPlanRegistry
    function registerFounderKey(bytes32 qx, bytes32 qy, address ownerEOA) external {
        if (msg.sender != _LENDER) revert NotLender();
        if (_founder.set) revert FounderKeyAlreadySet();
        bool hasPasskey = qx != bytes32(0) || qy != bytes32(0);
        if (ownerEOA == address(0) && !hasPasskey) revert InvalidSignature();
        if (ownerEOA == _LENDER) revert InvalidSignature(); // the lender can never be the owner (H3)
        // Nor the oracle (run-2 audit) or the observer (audit run-3): views on this deployment's immutable Treasury.
        if (ownerEOA != address(0)) {
            address t = treasury;
            if (ownerEOA == ITreasuryHooks(t).oracle() || ownerEOA == ITreasuryLinks(t).observer()) {
                revert InvalidSignature();
            }
        }
        if (hasPasskey && !P256.isValidPublicKey(qx, qy)) revert InvalidSignature();
        _founder = FounderKey({qx: qx, qy: qy, ownerEOA: ownerEOA, set: true});
        // forge-lint: disable-next-line(reentrancy-events)
        emit FounderKeyRegistered(ownerEOA, qx, qy); // only view calls to the immutable Treasury precede it
    }

    // ---------------------------------------------------------------------------------------------------------
    // Founder-signed (anyone may submit; the relayer gains no authority)
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IPlanRegistry
    function commitPlan(PlanApproval calldata a, Line[] calldata lines, Stage[] calldata stages, Sig calldata founder)
        external
    {
        _useEnvelope(a.deploymentId, a.expiry, a.nonce);
        _requireFounder(_digest(HogeeTypes.hashPlanApproval(a)), founder);
        if (a.linesHash != HogeeTypes.hashLines(lines) || a.stagesHash != HogeeTypes.hashStages(stages)) {
            revert InvalidSignature();
        }
        if (a.version != _version + 1 || a.prevPlanHash != _planHash) revert StalePlan();
        if (_version != 0 && a.planId != _planId) revert StalePlan();

        Facility memory f = ITreasury(treasury).facility();
        uint8 code = PlanConstitution.check(
            a,
            lines,
            stages,
            PlanConstitution.Context({
                capMinor: f.capMinor,
                reserveFloorBps: f.reserveFloorBps,
                now_: _now(),
                judgingWindowEnd: judgingWindowEnd,
                treasury: treasury,
                ownerEOA: _founder.ownerEOA,
                lender: _LENDER,
                oracle: ITreasuryHooks(treasury).oracle(),
                observer: ITreasuryLinks(treasury).observer()
            })
        );
        if (code != 0) revert PlanInvariantViolated(code);
        bool first = _version == 0; // stored state, not the signed number
        if (!first && _loosens(a, lines)) revert PlanInvariantViolated(HogeeKinds.CONST_REPLAN_LOOSENS);

        _storePlan(a, lines, stages, first);
        ITreasuryHooks(treasury)
            .syncPlan(
                PlanSync({
                    planId: a.planId,
                    version: a.version,
                    totalMinor: a.totalMinor,
                    agent: a.agent,
                    agentExpiry: a.agentExpiry,
                    reserveBps: a.reserveBps
                }),
                lines,
                stages
            );
        _emitCommitted(a);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Signature check shared with Treasury (not frozen)
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IFounderVerifier
    function checkFounderSig(bytes32 digest, Sig calldata sig) external view returns (bool ok, address ecdsaSigner) {
        FounderKey storage k = _founder;
        if (!k.set) return (false, address(0));
        return HogeeSigs.check(digest, sig, k.qx, k.qy, k.ownerEOA);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    function planVersion() external view returns (uint32) {
        return _version;
    }

    function currentPlan() external view returns (PlanState memory s) {
        if (_version == 0) return s;
        (address agent, uint64 expiry, bool revoked, uint16 reserveBps) = ITreasuryHooks(treasury).agentState();
        s = PlanState({
            planId: _planId,
            version: _version,
            planHash: _planHash,
            countryPackHash: _countryPackHash,
            totalMinor: _totalMinor,
            reserveBps: reserveBps,
            agent: agent,
            agentExpiry: expiry,
            agentRevoked: revoked,
            committedAt: _committedAt
        });
    }

    function lineIds() external view returns (bytes32[] memory) {
        return _lineIds;
    }

    /// The line as signed in the current plan (zero struct if the line is not in it). Current caps: Treasury.pocket.
    function line(bytes32 lineId) external view returns (Line memory l) {
        l = _lines[lineId];
    }

    function stageIds() external view returns (bytes32[] memory) {
        return _stageIds;
    }

    /// The stage as signed (zero struct if not in the plan); `released` is Treasury's record (the releasedMinor ledger).
    function stage(bytes32 stageId) external view returns (Stage memory stage_, bool released) {
        stage_ = _stages[stageId];
        if (stage_.stageId != bytes32(0)) released = ITreasuryHooks(treasury).isStageReleased(stageId);
    }

    function founderKey() external view returns (bytes32 qx, bytes32 qy, address ownerEOA) {
        return (_founder.qx, _founder.qy, _founder.ownerEOA);
    }

    function lender() external view returns (address) {
        return _LENDER;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------------------

    /// ENV-4: a known non-owner role (agent, lender) that signed an owner struct gets NotOwner (T6, H3); any other
    /// failure (wrong digest, wrong key, malformed) gets InvalidSignature (T16, T27, T28).
    function _requireFounder(bytes32 digest, Sig calldata sig) private view {
        FounderKey storage k = _founder;
        if (!k.set) revert InvalidSignature();
        (bool ok, address signer) = HogeeSigs.check(digest, sig, k.qx, k.qy, k.ownerEOA);
        if (ok) return;
        if (signer != address(0) && (signer == _agent || signer == _LENDER)) revert NotOwner();
        revert InvalidSignature();
    }

    /// G0 audit v-1: the first commit stores the plan; a re-commit only rewrites the line parameters (same set of
    /// lines, stored order kept) and the version. Stages, totals, the agent and the country pack never change.
    function _storePlan(PlanApproval calldata a, Line[] calldata lines, Stage[] calldata stages, bool first) private {
        _version = a.version;
        _committedAt = _now();
        _planHash = a.planHash;
        for (uint256 i; i < lines.length; ++i) {
            Line calldata src = lines[i];
            bytes32 id = src.lineId;
            if (first) _lineIds.push(id);
            Line storage dst = _lines[id];
            dst.lineId = id;
            dst.amountMinor = src.amountMinor;
            dst.perTxCapMinor = src.perTxCapMinor;
            dst.windowCapMinor = src.windowCapMinor;
            dst.windowSeconds = src.windowSeconds;
            dst.validUntil = src.validUntil;
            dst.pacingMinor = src.pacingMinor;
            dst.escrowOnly = src.escrowOnly;
            dst.payeeIds = src.payeeIds;
        }
        if (!first) return;

        _planId = a.planId;
        _agent = a.agent;
        _countryPackHash = a.countryPackHash;
        _stagesHash = a.stagesHash;
        _totalMinor = a.totalMinor;
        for (uint256 i; i < stages.length; ++i) {
            bytes32 id = stages[i].stageId;
            _stageIds.push(id);
            _stages[id] = stages[i];
        }
    }

    /// Code 14 (PlanReplan): the re-commit against the stored plan and Treasury's current state.
    function _loosens(PlanApproval calldata a, Line[] calldata lines) private view returns (bool) {
        PlanReplan.Current memory cur = PlanReplan.Current({
            countryPackHash: _countryPackHash,
            stagesHash: _stagesHash,
            totalMinor: _totalMinor,
            lineCount: _lineIds.length
        });
        return PlanReplan.loosens(a, lines, cur, _lines, treasury);
    }

    /// Emitted after syncPlan: the only external call goes to this deployment's immutable Treasury.
    function _emitCommitted(PlanApproval calldata a) private {
        // forge-lint: disable-next-item(reentrancy-events)
        emit PlanCommitted(
            a.planId,
            a.version,
            a.planHash,
            a.prevPlanHash,
            a.countryPackHash,
            a.totalMinor,
            a.agent,
            a.agentExpiry,
            ITreasury(treasury).releasedMinor(),
            a.linesHash,
            a.stagesHash,
            a.reserveBps
        );
    }
}
