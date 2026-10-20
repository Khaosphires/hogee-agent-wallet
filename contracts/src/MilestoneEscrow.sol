// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    IMilestoneEscrow,
    IPlanRegistry,
    ITreasury,
    EscrowOrder,
    Milestone,
    MilestoneRelease,
    SupplierApproval,
    Sig,
    HogeeKinds
} from "./interfaces/IHogee.sol";
import {HogeeTypes} from "./interfaces/HogeeTypes.sol";
import {HogeeDomain} from "./HogeeDomain.sol";
import {IEscrowHooks, IFounderVerifier, ITreasuryHooks, ITreasuryLinks, ITreasuryModuleHooks} from "./HogeeHooks.sol";

/// @title MilestoneEscrow: supplier milestones for one deployment (project.md §8.1, §8.4; demo tasks 3-5, 8, 12).
/// @notice Treasury.bindPayee opens an order with the founder's pre-signed schedule (sample -> deposit -> balance ->
///         holdback, each with an autoRelease flag). The agent funds milestones cumulatively, bounded by the signed
///         schedule (AmountExceedsSchedule), the supplier line balance, releasedMinor and funded BU (Treasury's
///         escrowFund hook; not perTxCap or the window cap), never inside the payee's cooling window (H6). An
///         autoRelease milestone releases when fully funded; any other needs the founder's MilestoneRelease with the
///         inspection evidence hash, and the agent alone always gets MilestoneLocked (T5). Neither releases while the
///         payee is cooling (Treasury.escrowRelease, PayeeCooling: a re-bind restarts cooling and replaces the payout
///         account, audit run-3). The BU ledger (escrowed, paid, settlements) stays in Treasury; this contract keeps
///         the orders and milestones and emits their events. A released milestone stays released for good: when its
///         payout fails, Treasury.failSettlement returns the BU to the supplier line and closes the settlement, and the
///         milestone can never be funded or released again (re-check M-1; a new order pays the supplier again).
///         No upgradeability: redeploy instead. Every check, in order: docs/assurance/require-table-final1.md.
contract MilestoneEscrow is HogeeDomain, IMilestoneEscrow, IEscrowHooks {
    /// Treasury of this deployment (its escrow link must name this contract).
    address public immutable treasury;
    /// PlanRegistry of this deployment (the founder key that signs MilestoneRelease).
    address public immutable registry;
    address private immutable _LENDER;

    mapping(bytes32 orderId => EscrowOrder) private _orders;
    mapping(bytes32 orderId => Milestone[]) private _milestones;

    // The treasury address is checked by reading its link back, which fails for anything but a linked Treasury.
    // forge-lint: disable-next-item(missing-zero-check)
    constructor(address treasury_)
        HogeeDomain(
            ITreasury(treasury_).deploymentId(), ITreasury(treasury_).chainTag(), HogeeDomain(treasury_).fiscoMs()
        )
    {
        if (ITreasuryLinks(treasury_).escrow() != address(this)) {
            revert PlanInvariantViolated(HogeeKinds.CONST_MALFORMED_PLAN);
        }
        address registry_ = ITreasuryLinks(treasury_).registry();
        treasury = treasury_;
        registry = registry_;
        _LENDER = IPlanRegistry(registry_).lender();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Agent
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IMilestoneEscrow
    function fundMilestone(bytes32 orderId, uint8 idx, uint128 amountMinor, bytes32 decisionId, bytes32 rationaleHash)
        external
    {
        ITreasuryModuleHooks t = ITreasuryModuleHooks(treasury);
        t.requireSpendingAgent(msg.sender);
        if (decisionId == bytes32(0) || rationaleHash == bytes32(0)) revert MissingDecision();
        EscrowOrder storage o = _orders[orderId];
        if (!o.exists || idx >= o.milestoneCount) revert PayeeNotBound();
        t.checkEscrowLine(o.lineId, o.payeeId);
        if (amountMinor == 0) revert CapExceeded();
        Milestone storage m = _milestones[orderId][idx];
        uint256 funded = uint256(m.fundedMinor) + amountMinor;
        if (funded > m.amountMinor) revert AmountExceedsSchedule();
        // funded <= m.amountMinor (uint128), checked above: the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        m.fundedMinor = uint128(funded);
        // The only external calls go to this deployment's immutable Treasury, which never calls back here.
        t.escrowFund(o.lineId, amountMinor);
        // forge-lint: disable-next-item(reentrancy-events, unsafe-typecast)
        emit MilestoneFunded(orderId, idx, amountMinor, uint128(funded), decisionId, rationaleHash);
        if (m.autoRelease && funded == m.amountMinor) _release(orderId, idx, o, m, bytes32(0));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Founder-signed (the relayer submits; it gains no authority)
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IMilestoneEscrow
    function releaseMilestone(MilestoneRelease calldata release, Sig calldata founder) external {
        // forge-lint: disable-next-line(unused-return)
        (address agent,,,) = ITreasuryHooks(treasury).agentState();
        if (msg.sender == agent) revert MilestoneLocked(); // T5: the agent alone never unlocks a milestone
        _useEnvelope(release.deploymentId, release.expiry, release.nonce);
        _requireFounder(_digest(HogeeTypes.hashMilestoneRelease(release)), founder, agent);
        EscrowOrder storage o = _orders[release.orderId];
        if (!o.exists || release.idx >= o.milestoneCount) revert PayeeNotBound();
        Milestone storage m = _milestones[release.orderId][release.idx];
        if (m.autoRelease || m.released || m.fundedMinor != m.amountMinor) revert MilestoneLocked();
        if (release.amountMinor != m.amountMinor) revert AmountExceedsSchedule();
        if (o.inspectionRequired && release.evidenceHash == bytes32(0)) revert EvidenceMissing();
        _release(release.orderId, release.idx, o, m, release.evidenceHash);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Treasury hooks
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IEscrowHooks
    function openOrder(SupplierApproval calldata a, uint128[] calldata schedule, bool[] calldata autoRelease) external {
        if (msg.sender != treasury) revert NotOwner();
        uint256 n = schedule.length; // 1-8 and == autoRelease.length (Treasury.bindPayee row 5)
        // n <= 8 (Treasury.bindPayee row 5): the cast cannot truncate.
        // forge-lint: disable-next-item(unsafe-typecast)
        _orders[a.orderId] = EscrowOrder({
            payeeId: a.payee,
            lineId: a.lineId,
            totalMinor: a.totalMinor,
            milestoneCount: uint8(n),
            inspectionRequired: a.inspectionRequired,
            exists: true
        });
        Milestone[] storage ms = _milestones[a.orderId];
        for (uint256 i; i < n; ++i) {
            ms.push(
                Milestone({
                    amountMinor: schedule[i],
                    fundedMinor: 0,
                    autoRelease: autoRelease[i],
                    released: false,
                    evidenceHash: 0
                })
            );
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views (G0-DECISION)
    // ---------------------------------------------------------------------------------------------------------

    function order(bytes32 orderId) external view returns (EscrowOrder memory) {
        return _orders[orderId];
    }

    function milestones(bytes32 orderId) external view returns (Milestone[] memory) {
        return _milestones[orderId];
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------------------

    /// Marks the milestone released (for good, re-check M-1) and has Treasury pay the payee out of escrow and open the
    /// settlement (SettlementClosed if this milestone's settlement ever existed).
    function _release(bytes32 orderId, uint8 idx, EscrowOrder storage o, Milestone storage m, bytes32 evidenceHash)
        private
    {
        bytes32 settlementId = HogeeTypes.milestoneSettlementId(orderId, idx);
        m.released = true;
        m.evidenceHash = evidenceHash;
        uint128 amount = m.amountMinor;
        ITreasuryModuleHooks(treasury).escrowRelease(settlementId, o.lineId, o.payeeId, amount);
        // forge-lint: disable-next-line(reentrancy-events)
        emit MilestoneReleased(orderId, idx, o.payeeId, amount, evidenceHash, settlementId);
    }

    /// ENV-4 for MilestoneRelease (verifying contract = this escrow): a known non-owner signer (the agent, the lender)
    /// reverts NotOwner; any other failure InvalidSignature.
    function _requireFounder(bytes32 digest, Sig calldata sig, address agent) private view {
        (bool ok, address signer) = IFounderVerifier(registry).checkFounderSig(digest, sig);
        if (ok) return;
        if (signer != address(0) && (signer == agent || signer == _LENDER)) revert NotOwner();
        revert InvalidSignature();
    }
}
