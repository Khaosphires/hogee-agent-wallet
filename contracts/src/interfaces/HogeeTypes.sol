// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {
    PlanApproval,
    Line,
    Stage,
    SupplierApproval,
    MilestoneRelease,
    LoosenRequest,
    StageRelease,
    OwnerSpend
} from "./IHogee.sol";

/// @title HogeeTypes: canonical EIP-712 type strings, typehashes and pure hashing helpers (project.md §8.7).
/// @notice Custom domain (not OZ EIP712, which hard-codes block.chainid):
///         EIP712Domain(string name,string version,address verifyingContract,bytes32 salt), name "Hogee",
///         version "1", salt = keccak256(abi.encode(chainTag, deploymentId)). No chainId, so it also works on
///         FISCO (CHAINID = 0). Mirrored in packages/chain/src/eip712.ts; golden digests are asserted in both
///         contracts/test/HogeeTypes.t.sol and packages/chain/test/eip712.test.ts.
/// @dev Verifying contract per struct (G0-DECISION): PlanApproval -> PlanRegistry; SupplierApproval,
///      LoosenRequest, StageRelease, OwnerSpend -> Treasury; MilestoneRelease -> MilestoneEscrow.
///      Every signed struct has only static fields, so hashStruct = keccak256(abi.encode(TYPEHASH, s)).
library HogeeTypes {
    string internal constant DOMAIN_NAME = "Hogee";
    string internal constant DOMAIN_VERSION = "1";

    string internal constant EIP712_DOMAIN_TYPE =
        "EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)";
    string internal constant PLAN_APPROVAL_TYPE =
        "PlanApproval(bytes32 planId,uint32 version,bytes32 prevPlanHash,bytes32 planHash,bytes32 countryPackHash,bytes32 linesHash,bytes32 stagesHash,uint128 totalMinor,uint16 reserveBps,address agent,uint64 agentExpiry,bytes32 deploymentId,uint256 nonce,uint64 expiry)";
    // G0-REVIEW (M7): payoutAccountHash added after payee.
    string internal constant SUPPLIER_APPROVAL_TYPE =
        "SupplierApproval(bytes32 orderId,bytes32 supplierId,bytes32 payee,bytes32 payoutAccountHash,bytes32 lineId,bytes32 scheduleHash,uint128 totalMinor,bytes32 quoteHash,bytes32 shortlistHash,uint8 chosenIndex,bool inspectionRequired,bytes32 deploymentId,uint256 nonce,uint64 expiry)";
    string internal constant MILESTONE_RELEASE_TYPE =
        "MilestoneRelease(bytes32 orderId,uint8 idx,uint128 amountMinor,bytes32 evidenceHash,bytes32 deploymentId,uint256 nonce,uint64 expiry)";
    string internal constant LOOSEN_REQUEST_TYPE =
        "LoosenRequest(uint8 kind,bytes32 target,bytes32 aux,uint256 newValue,bytes32 deploymentId,uint256 nonce,uint64 expiry)";
    string internal constant STAGE_RELEASE_TYPE =
        "StageRelease(bytes32 stageId,uint128 amountMinor,bytes32 deploymentId,uint256 nonce,uint64 expiry)";
    string internal constant OWNER_SPEND_TYPE =
        "OwnerSpend(bytes32 lineId,bytes32 payeeId,uint128 amountMinor,bytes32 invoiceHash,bytes32 deploymentId,uint256 nonce,uint64 expiry)";

    // Precomputed keccak256 of the strings above (asserted in HogeeTypes.t.sol and eip712.test.ts).
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        0x36c25de3e541d5d970f66e4210d728721220fff5c077cc6cd008b3a0c62adab7;
    bytes32 internal constant PLAN_APPROVAL_TYPEHASH =
        0x79ade738b7faa5735e274b970b60b74a78381de71ba14db277e9699ab0fff10f;
    bytes32 internal constant SUPPLIER_APPROVAL_TYPEHASH =
        0x4c20466f0a224da371247d079d44046edeb43aa6df2125a4a5ef470da19fe1d2;
    bytes32 internal constant MILESTONE_RELEASE_TYPEHASH =
        0x99561ec6c6f3333ade59c63a6dd74240f30a7ccf0ad591d8e38cbbccfb7cfb7c;
    bytes32 internal constant LOOSEN_REQUEST_TYPEHASH =
        0x7c436c388e9be5950fd1e73eed20ba2be4044dc24a788bf108ccc8c0625a5cf9;
    bytes32 internal constant STAGE_RELEASE_TYPEHASH =
        0xa47efdc649d9de812e1ec466521dba27f2f1eedfda6cae0a592e75c0f721e6e0;
    bytes32 internal constant OWNER_SPEND_TYPEHASH = 0x915bed73783b116efd78330916948448ba772637dbeeff68be1e007c38b43962;

    // ---- domain ----

    function domainSalt(bytes32 chainTag, bytes32 deploymentId) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainTag, deploymentId));
    }

    function domainSeparator(address verifyingContract, bytes32 chainTag, bytes32 deploymentId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                verifyingContract,
                domainSalt(chainTag, deploymentId)
            )
        );
    }

    /// keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)
    function digest(bytes32 domainSeparator_, bytes32 structHash) internal pure returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator_, structHash);
    }

    // ---- hashStruct ----

    function hashPlanApproval(PlanApproval memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(PLAN_APPROVAL_TYPEHASH, s));
    }

    function hashSupplierApproval(SupplierApproval memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(SUPPLIER_APPROVAL_TYPEHASH, s));
    }

    function hashMilestoneRelease(MilestoneRelease memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(MILESTONE_RELEASE_TYPEHASH, s));
    }

    /// Also the loosenId returned by ITreasury.queueLoosen.
    function hashLoosenRequest(LoosenRequest memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(LOOSEN_REQUEST_TYPEHASH, s));
    }

    function hashStageRelease(StageRelease memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(STAGE_RELEASE_TYPEHASH, s));
    }

    function hashOwnerSpend(OwnerSpend memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(OWNER_SPEND_TYPEHASH, s));
    }

    // ---- commitments carried inside signed structs, and derived ids ----

    /// PlanApproval.linesHash
    function hashLines(Line[] memory lines) internal pure returns (bytes32) {
        return keccak256(abi.encode(lines));
    }

    /// PlanApproval.stagesHash
    function hashStages(Stage[] memory stages) internal pure returns (bytes32) {
        return keccak256(abi.encode(stages));
    }

    /// SupplierApproval.scheduleHash
    function scheduleHash(uint128[] memory schedule, bool[] memory autoRelease) internal pure returns (bytes32) {
        return keccak256(abi.encode(schedule, autoRelease));
    }

    /// §8.4 intentId; also the spendId of Spent.
    function intentId(bytes32 planId, bytes32 lineId, bytes32 payeeId, bytes32 invoiceHash, uint128 amountMinor)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, amountMinor));
    }

    /// settlementId of a milestone release (§9.1).
    function milestoneSettlementId(bytes32 orderId, uint8 idx) internal pure returns (bytes32) {
        return keccak256(abi.encode(orderId, idx));
    }
}
