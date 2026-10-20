// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {
    PlanApproval,
    Line,
    Stage,
    Sig,
    SupplierApproval,
    MilestoneRelease,
    LoosenRequest,
    StageRelease,
    OwnerSpend,
    HogeeKinds
} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../src/interfaces/IHogeeBase.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {SalesOracle} from "../src/SalesOracle.sol";
import {RinaFixture} from "../test/utils/RinaFixture.sol";

/// @title SmokeFinal: Anvil-only end-to-end smoke of a freshly deployed final-1 set (escrow, sale + stage 2, a loosening
///         through the timelock, ownerSpend). Two phases around a time jump, because the cooling period and the
///         loosening timelock need real block time to pass:
///   1. run():    lender opens the facility and registers the founder; relayer commits Rina's plan; lender funds;
///                relayer binds supplier A (cooling starts); oracle records a 200,000 sale (reserve skim); lender
///                releases stage 2; agent lowers the ADS per-tx cap; founder + lender queue a raise back and a reserve
///                withdrawal (an early execute reverts TimelockActive, checked locally); relayer submits an ownerSpend.
///   2. finish(): agent funds the sample, deposit and balance; relayer submits the founder's balance release with the
///                inspection hash; anyone executes both loosenings; the oracle confirms every settlement.
/// Signatures use Anvil's public test mnemonic (founder #4, lender #2); transactions go from Anvil's unlocked default
/// accounts (`--unlocked`). Never use on a public chain. Deploy with DeployFinal first, from account #0:
///   LENDER_ADDRESS=<#2> ORACLE_ADDRESS=<#3> OBSERVER_ADDRESS=<#6> \
///   PLATFORM_PAYEE_IDS=spx-logistics,shopee-ads,shopee-fees,lhdn-tax PLATFORM_PAYOUT_HASHES=<4 hashes> \
///     forge script script/DeployFinal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <#0 key>
///   REGISTRY=… TREASURY=… ESCROW=… SALES=… forge script script/SmokeFinal.s.sol --rpc-url http://127.0.0.1:8545 \
///     --broadcast --unlocked --sender <#0>
///   cast rpc evm_increaseTime 130 && cast rpc evm_mine
///   REGISTRY=… TREASURY=… ESCROW=… SALES=… forge script script/SmokeFinal.s.sol --sig "finish()" … (same flags)
contract SmokeFinal is Script, RinaFixture {
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    // Anvil default accounts (public test addresses); AGENT (#1) comes from RinaFixture.
    address internal constant LENDER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // #2
    address internal constant ORACLE = 0x90F79bf6EB2c4f870365E785982E1f101E93b906; // #3
    address internal constant FOUNDER = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; // #4
    address internal constant RELAYER = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc; // #5
    address internal constant OBSERVER = 0x976EA74026E726554dB657fA54763abd0C3a0aa9; // #6
    bytes32 internal constant TAX = "lhdn-tax";
    bytes32 internal constant OWNER_INVOICE = keccak256("hogee/smoke/owner-invoice-1");

    PlanRegistry internal registry;
    Treasury internal treasury;
    MilestoneEscrow internal escrow;
    SalesOracle internal sales;

    // ---------------------------------------------------------------------------------------------------------
    // Phase 1
    // ---------------------------------------------------------------------------------------------------------

    function run() external {
        _load();
        vm.startBroadcast(LENDER);
        treasury.openFacility(1_000_000, 300);
        registry.registerFounderKey(bytes32(0), bytes32(0), FOUNDER);
        vm.stopBroadcast();

        (PlanApproval memory a, Line[] memory lines, Stage[] memory stages) = _plan();
        Sig memory planSig = _sign(4, HogeeTypes.digest(registry.domainSeparator(), HogeeTypes.hashPlanApproval(a)));
        vm.broadcast(RELAYER);
        registry.commitPlan(a, lines, stages, planSig);
        vm.broadcast(LENDER);
        treasury.fund(1_000_000);

        SupplierApproval memory s = _supplierApproval();
        (s.deploymentId, s.expiry) = (registry.deploymentId(), _expiry());
        Sig memory supplierSig = _sign(4, _treasuryDigest(HogeeTypes.hashSupplierApproval(s)));
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        vm.broadcast(RELAYER);
        treasury.bindPayee(s, schedule, autoRelease, supplierSig);

        vm.broadcast(ORACLE);
        sales.recordSale(keccak256("evt_smoke_sale_1"), 200_000);
        StageRelease memory st = StageRelease("stage-2", 600_000, registry.deploymentId(), 5, _expiry());
        Sig memory stageSig = _sign(2, _treasuryDigest(HogeeTypes.hashStageRelease(st)));
        vm.broadcast(RELAYER);
        treasury.releaseStage(st, stageSig);

        vm.broadcast(AGENT);
        treasury.tighten(HogeeKinds.TIGHTEN_LOWER_PER_TX_CAP, "ADS", 20_000, "smoke-tighten");
        bytes32 raiseId = _queue(_raise());
        bytes32 withdrawId = _queue(_withdraw());
        try treasury.executeLoosen(raiseId) {
            revert("early execute must revert");
        } catch (bytes memory reason) {
            require(bytes4(reason) == IHogeeErrors.TimelockActive.selector, "expected TimelockActive");
        }

        OwnerSpend memory o = _ownerSpendReq();
        Sig memory ownerSig = _sign(4, _treasuryDigest(HogeeTypes.hashOwnerSpend(o)));
        vm.broadcast(RELAYER);
        treasury.ownerSpend(o, ownerSig);

        console2.log("phase 1 done: releasedMinor", treasury.releasedMinor(), "reserve", treasury.reserve());
        console2.log("raise loosenId / withdraw loosenId:");
        console2.logBytes32(raiseId);
        console2.logBytes32(withdrawId);
        console2.log("now: cast rpc evm_increaseTime 130 && cast rpc evm_mine, then --sig 'finish()'");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Phase 2 (after the time jump)
    // ---------------------------------------------------------------------------------------------------------

    function finish() external {
        _load();
        vm.startBroadcast(AGENT);
        escrow.fundMilestone(ORDER_A, 0, 30_000, "smoke-sample", "smoke");
        escrow.fundMilestone(ORDER_A, 1, 120_000, "smoke-deposit", "smoke");
        escrow.fundMilestone(ORDER_A, 2, 280_000, "smoke-balance", "smoke");
        vm.stopBroadcast();

        MilestoneRelease memory r = _milestoneRelease();
        (r.evidenceHash, r.deploymentId, r.expiry) = (keccak256("smoke-inspection"), registry.deploymentId(), _expiry());
        Sig memory releaseSig =
            _sign(4, HogeeTypes.digest(escrow.domainSeparator(), HogeeTypes.hashMilestoneRelease(r)));
        vm.broadcast(RELAYER);
        escrow.releaseMilestone(r, releaseSig);

        bytes32 raiseId = HogeeTypes.hashLoosenRequest(_raise());
        bytes32 withdrawId = HogeeTypes.hashLoosenRequest(_withdraw());
        vm.startBroadcast(RELAYER);
        treasury.executeLoosen(raiseId);
        treasury.executeLoosen(withdrawId);
        vm.stopBroadcast();

        bytes32 ownerId = HogeeTypes.intentId(PLAN_ID, "LOGISTICS", "spx-logistics", OWNER_INVOICE, 25_000);
        vm.startBroadcast(ORACLE);
        for (uint8 i; i < 3; ++i) {
            treasury.confirmSettlement(HogeeTypes.milestoneSettlementId(ORDER_A, i), keccak256(abi.encode("payout", i)));
        }
        treasury.confirmSettlement(ownerId, keccak256("payout-owner"));
        treasury.confirmSettlement(withdrawId, keccak256("payout-tax"));
        vm.stopBroadcast();

        require(treasury.pocket("ADS").perTxCapMinor == 30_000, "raise not applied");
        require(treasury.reserve() == 6_000, "reserve after withdrawal");
        require(treasury.balances().escrowedMinor == 430_000, "escrow total");
        require(escrow.milestones(ORDER_A)[2].released, "balance not released");
        console2.log("phase 2 done: escrowed", treasury.balances().escrowedMinor, "reserve", treasury.reserve());
        console2.log("ADS perTxCap", treasury.pocket("ADS").perTxCapMinor);
        console2.log("supplier paid", treasury.payeeBinding("SUPPLIER", SUPPLIER_A).paidMinor);
        console2.log("LOGISTICS spent (ownerSpend)", treasury.pocket("LOGISTICS").spentMinor);
        console2.log("settlementState(withdraw)", treasury.settlementState(withdrawId));
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _load() internal {
        require(block.chainid == 31_337, "SmokeFinal runs on Anvil only");
        registry = PlanRegistry(vm.envAddress("REGISTRY"));
        treasury = Treasury(vm.envAddress("TREASURY"));
        escrow = MilestoneEscrow(vm.envAddress("ESCROW"));
        sales = SalesOracle(vm.envAddress("SALES"));
        require(registry.lender() == LENDER && treasury.oracle() == ORACLE, "deploy with Anvil #2 lender, #3 oracle");
        require(treasury.observer() == OBSERVER, "deploy with Anvil #6 observer");
        require(treasury.escrow() == address(escrow) && treasury.salesOracle() == address(sales), "not one set");
    }

    /// Rina's plan with every time relative to the node's clock (the fixture's are fixed to 2026-10-16).
    function _plan() internal view returns (PlanApproval memory a, Line[] memory lines, Stage[] memory stages) {
        lines = _lines();
        for (uint256 i; i < lines.length; ++i) {
            lines[i].validUntil = uint64(block.timestamp + 60 days);
        }
        stages = _stages();
        stages[1].deadline = uint64(block.timestamp + 30 days);
        a = _planApproval();
        (a.linesHash, a.stagesHash) = (HogeeTypes.hashLines(lines), HogeeTypes.hashStages(stages));
        (a.agentExpiry, a.deploymentId, a.expiry) =
        (uint64(block.timestamp + 60 days), registry.deploymentId(), _expiry());
    }

    /// Loosening requests carry a fixed expiry (the judging window end) so phase 2 can recompute their ids.
    function _raise() internal view returns (LoosenRequest memory) {
        return LoosenRequest(
            HogeeKinds.LOOSEN_RAISE_PER_TX_CAP,
            "ADS",
            0,
            30_000,
            registry.deploymentId(),
            7,
            registry.judgingWindowEnd()
        );
    }

    function _withdraw() internal view returns (LoosenRequest memory) {
        return LoosenRequest(
            HogeeKinds.LOOSEN_WITHDRAW_RESERVE, TAX, 0, 4_000, registry.deploymentId(), 8, registry.judgingWindowEnd()
        );
    }

    function _queue(LoosenRequest memory q) internal returns (bytes32 loosenId) {
        bytes32 digest = _treasuryDigest(HogeeTypes.hashLoosenRequest(q));
        Sig memory founderSig = _sign(4, digest);
        Sig memory lenderSig = _sign(2, digest);
        vm.broadcast(RELAYER);
        loosenId = treasury.queueLoosen(q, founderSig, lenderSig);
    }

    /// 25,000 on LOGISTICS: above its 20,000 per-tx cap, which the owner's fallback skips.
    function _ownerSpendReq() internal view returns (OwnerSpend memory) {
        return OwnerSpend("LOGISTICS", "spx-logistics", 25_000, OWNER_INVOICE, registry.deploymentId(), 9, _expiry());
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    function _treasuryDigest(bytes32 structHash) internal view returns (bytes32) {
        return HogeeTypes.digest(treasury.domainSeparator(), structHash);
    }

    /// ECDSA with Anvil default account `index` (public test mnemonic).
    function _sign(uint32 index, bytes32 digest) internal pure returns (Sig memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vm.deriveKey(ANVIL_MNEMONIC, index), digest);
        return Sig({kind: HogeeKinds.SIG_ECDSA, data: abi.encodePacked(r, s, v)});
    }
}
