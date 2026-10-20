// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    PlanApproval,
    Line,
    Stage,
    SupplierApproval,
    MilestoneRelease,
    LoosenRequest,
    StageRelease,
    OwnerSpend,
    HogeeKinds
} from "../../src/interfaces/IHogee.sol";
import {HogeeTypes} from "../../src/interfaces/HogeeTypes.sol";

/// Rina demo numbers (project.md §26.2) as fixed on-chain fixtures. Shared by the golden EIP-712 tests and,
/// later, the contract unit tests. Mirrored in packages/chain/test/fixtures/rina.ts: change both together.
/// G0-REVIEW (M15): _lines()/_stages() equal manifestToLines/manifestToStages of the Rina PlanManifest
/// (packages/core/src/demo/rina.ts numbers); every id is a ShortId [a-z0-9_-]{1,32} (lineIds use the LineKey).
abstract contract RinaFixture {
    uint64 internal constant DAY = 86_400;
    uint64 internal constant T0 = 1_792_108_800; // 2026-10-16T00:00:00Z
    uint32 internal constant WINDOW = 604_800; // 7 days

    bytes32 internal constant CHAIN_TAG = "sepolia";
    bytes32 internal constant DEPLOYMENT_ID = "final-1";

    // Anvil's default first three deployment addresses and account #1.
    address internal constant PLAN_REGISTRY = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    address internal constant TREASURY = 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512;
    address internal constant ESCROW = 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0;
    address internal constant AGENT = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    // UUIDv7 0199e7a2-5b1c-7d3e-8f4a-1b2c3d4e5f60, left-padded to bytes32.
    bytes32 internal constant PLAN_ID = 0x000000000000000000000000000000000199e7a25b1c7d3e8f4a1b2c3d4e5f60;
    bytes32 internal constant ORDER_A = "order-a-001"; // RINA_IDS.supplierAOrderId
    bytes32 internal constant SUPPLIER_A = "supplier-a"; // RINA_IDS.supplierAId and supplierAPayeeId

    /// JCS (RFC 8785) of supplier A's test payout account {channel, accountNumber, holderName}, keys sorted.
    string internal constant SUPPLIER_A_ACCOUNT_JCS =
        '{"accountNumber":"1234567890","channel":"MY_DUITNOW","holderName":"Supplier A Co Ltd"}';

    function _lines() internal pure returns (Line[] memory lines) {
        lines = new Line[](6);
        lines[0] = _line("SUPPLIER", 500_000, 0, true, new bytes32[](0));
        lines[1] = _line("PACKAGING", 150_000, 0, false, new bytes32[](0));
        lines[2] = _line("LOGISTICS", 80_000, 0, false, _one("spx-logistics"));
        lines[3] = _line("ADS", 120_000, 7_500, false, _one("shopee-ads"));
        lines[4] = _line("PLATFORM_FEES", 50_000, 0, false, _one("shopee-fees"));
        lines[5] = _line("CONTINGENCY", 100_000, 0, false, new bytes32[](0));
    }

    function _stages() internal pure returns (Stage[] memory stages) {
        stages = new Stage[](2);
        stages[0] = Stage("stage-1", 400_000, HogeeKinds.METRIC_NONE, 0, 0);
        stages[1] = Stage("stage-2", 600_000, HogeeKinds.METRIC_SALES_MINOR, 200_000, T0 + 30 * DAY);
    }

    function _planApproval() internal pure returns (PlanApproval memory) {
        return PlanApproval({
            planId: PLAN_ID,
            version: 1,
            prevPlanHash: bytes32(0),
            planHash: keccak256("hogee/golden/plan-v1"),
            countryPackHash: keccak256("hogee/golden/country-pack-MY"),
            linesHash: HogeeTypes.hashLines(_lines()),
            stagesHash: HogeeTypes.hashStages(_stages()),
            totalMinor: 1_000_000,
            reserveBps: 500,
            agent: AGENT,
            agentExpiry: T0 + 60 * DAY,
            deploymentId: DEPLOYMENT_ID,
            nonce: 1,
            expiry: T0 + DAY
        });
    }

    /// Supplier A: sample 30,000 (auto), deposit 120,000 (auto), balance 280,000 (founder + stage 2).
    function _schedule() internal pure returns (uint128[] memory schedule, bool[] memory autoRelease) {
        schedule = new uint128[](3);
        autoRelease = new bool[](3);
        (schedule[0], schedule[1], schedule[2]) = (30_000, 120_000, 280_000);
        (autoRelease[0], autoRelease[1], autoRelease[2]) = (true, true, false);
    }

    function _supplierApproval() internal pure returns (SupplierApproval memory) {
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        return SupplierApproval({
            orderId: ORDER_A,
            supplierId: SUPPLIER_A,
            payee: SUPPLIER_A,
            payoutAccountHash: keccak256(bytes(SUPPLIER_A_ACCOUNT_JCS)),
            lineId: "SUPPLIER",
            scheduleHash: HogeeTypes.scheduleHash(schedule, autoRelease),
            totalMinor: 430_000,
            quoteHash: keccak256("hogee/golden/quote-A"),
            shortlistHash: keccak256("hogee/golden/shortlist"),
            chosenIndex: 0,
            inspectionRequired: true,
            deploymentId: DEPLOYMENT_ID,
            nonce: 2,
            expiry: T0 + DAY
        });
    }

    function _milestoneRelease() internal pure returns (MilestoneRelease memory) {
        return MilestoneRelease({
            orderId: ORDER_A,
            idx: 2,
            amountMinor: 280_000,
            evidenceHash: keccak256("hogee/golden/inspection-A"),
            deploymentId: DEPLOYMENT_ID,
            nonce: 3,
            expiry: T0 + DAY
        });
    }

    function _loosenRequest() internal pure returns (LoosenRequest memory) {
        return LoosenRequest({
            kind: HogeeKinds.LOOSEN_MOVE_POCKETS,
            target: "CONTINGENCY",
            aux: "ADS",
            newValue: 20_000,
            deploymentId: DEPLOYMENT_ID,
            nonce: 4,
            expiry: T0 + DAY
        });
    }

    function _stageRelease() internal pure returns (StageRelease memory) {
        return StageRelease({
            stageId: "stage-2", amountMinor: 600_000, deploymentId: DEPLOYMENT_ID, nonce: 5, expiry: T0 + DAY
        });
    }

    function _ownerSpend() internal pure returns (OwnerSpend memory) {
        return OwnerSpend({
            lineId: "PACKAGING",
            payeeId: "payee-packaging-1",
            amountMinor: 30_000,
            invoiceHash: keccak256("hogee/golden/invoice-pk-1"),
            deploymentId: DEPLOYMENT_ID,
            nonce: 6,
            expiry: T0 + DAY
        });
    }

    function _line(bytes32 lineId, uint128 amount, uint128 pacing, bool escrowOnly, bytes32[] memory payeeIds)
        private
        pure
        returns (Line memory)
    {
        // Caps at the constitution maxima: perTx 25%, window 50%.
        return Line(lineId, amount, amount / 4, amount / 2, WINDOW, T0 + 60 * DAY, pacing, escrowOnly, payeeIds);
    }

    function _one(bytes32 id) private pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }
}
