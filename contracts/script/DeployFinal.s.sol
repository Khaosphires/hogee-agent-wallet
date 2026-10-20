// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/Script.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {DeployLoop} from "./DeployLoop.s.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {SalesOracle} from "../src/SalesOracle.sol";
import {TreasuryLinks} from "../src/HogeeHooks.sol";

/// @title DeployFinal: deploys the `final-1` set (D17): PlanRegistry, Treasury, MilestoneEscrow and SalesOracle, linked
///         through constructor immutables, and prints the deployment manifest.
/// @notice Every DeployLoop input and check applies unchanged (inherited: CHAIN_TAG must name the chain, COOLING_SECONDS
///         1 s to 30 days, explicit and >= 120 s off Anvil, Anvil default accounts refused as lender/oracle off Anvil,
///         the clock scale must match FISCO_MS, JUDGING_WINDOW_END in the future, SafeCast, the platform payee
///         pre-checks). The four CREATE addresses are precomputed from the broadcaster's nonce (registry n, treasury
///         n+1, escrow n+2, sales oracle n+3); Treasury creates its delegate-only governance module itself. Every link
///         is asserted.
///
/// Inputs (environment; addresses and labels only, never a key; the broadcaster key comes from the forge CLI):
///   everything DeployLoop reads (LENDER_ADDRESS, ORACLE_ADDRESS, CHAIN_TAG, FISCO_MS, COOLING_SECONDS,
///                          JUDGING_WINDOW_END, PLATFORM_PAYEE_IDS, PLATFORM_PAYOUT_HASHES), except:
///   DEPLOYMENT_ID          label, default "final-1"; never "loop-1" (that set is deployed from the pre-1.8 commit)
///   LOOSEN_TIMELOCK_SECONDS §8.8 loosening timelock, 1 s to 30 days (120 s in the labelled demo, 24 h in production).
///                          Default 120 on Anvil only: any other chain must set it, to at least 120 s. Production
///                          must use 24 h (86400)
///   OBSERVER_ADDRESS       optional OBSERVER (cancelLoosen veto); default none. Never the lender or the oracle (nor,
///                          on-chain, the owner EOA or the agent); off Anvil, never an Anvil default account
/// PLATFORM_PAYEE_IDS must include the tax payee a LOOSEN_WITHDRAW_RESERVE pays (e.g. "lhdn-tax"): the reserve can only
/// be withdrawn to a static platform payee, whose payout account is fixed here.
///
/// Anvil:  anvil &  then
///   LENDER_ADDRESS=0x… ORACLE_ADDRESS=0x… OBSERVER_ADDRESS=0x… PLATFORM_PAYEE_IDS=… PLATFORM_PAYOUT_HASHES=… \
///     forge script script/DeployFinal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil #0 key>
/// Write the JSON between the BEGIN/END markers to packages/chain/deployments/<chainTag>-<deploymentId>.json.
/// The links above are asserted only in the simulation. Once the transactions are mined, check the deployed set on the
/// chain with the read-only VerifyFinal (no --broadcast, no key; inputs and a jq recipe in script/VerifyFinal.s.sol):
///   CHAIN_ID=… EXPECTED_DEPLOYMENT_ID=… EXPECTED_CHAIN_TAG=… REGISTRY_ADDRESS=0x… TREASURY_ADDRESS=0x… \
///   GOVERNANCE_ADDRESS=0x… ESCROW_ADDRESS=0x… SALES_ORACLE_ADDRESS=0x… LENDER_ADDRESS=0x… ORACLE_ADDRESS=0x… \
///   OBSERVER_ADDRESS=0x… COOLING_SECONDS=… LOOSEN_TIMELOCK_SECONDS=… \
///     forge script script/VerifyFinal.s.sol --rpc-url <rpc>
contract DeployFinal is DeployLoop {
    uint256 internal constant DEMO_LOOSEN_TIMELOCK_SECONDS = 120;
    uint256 internal constant MAX_LOOSEN_TIMELOCK_SECONDS = 30 days;

    struct FinalConfig {
        Config base;
        address observer;
        uint64 loosenTimelockSeconds;
    }

    struct Deployed {
        PlanRegistry registry;
        Treasury treasury;
        MilestoneEscrow escrow;
        SalesOracle sales;
    }

    /// The returned pair is DeployLoop's shape; the full set is in the printed manifest.
    function run() external override returns (PlanRegistry registry, Treasury treasury) {
        FinalConfig memory f = _finalConfig();
        uint256 startBlock = block.number;
        Deployed memory d = _deployFinal(f);
        _printFinal(f, d);
        console2.log("BEGIN DEPLOYMENT JSON");
        console2.log(_finalManifest(f, startBlock, d));
        console2.log("END DEPLOYMENT JSON");
        return (d.registry, d.treasury);
    }

    // ---------------------------------------------------------------------------------------------------------
    // config
    // ---------------------------------------------------------------------------------------------------------

    function _finalConfig() internal view returns (FinalConfig memory f) {
        f.base = _config(); // DeployLoop's inputs and checks
        f.base.deploymentId = vm.envOr("DEPLOYMENT_ID", string("final-1"));
        f.observer = vm.envOr("OBSERVER_ADDRESS", address(0));
        f.loosenTimelockSeconds =
            _loosenTimelock(vm.envExists("LOOSEN_TIMELOCK_SECONDS"), vm.envOr("LOOSEN_TIMELOCK_SECONDS", uint256(0)));
        _checkFinalConfig(f);
    }

    /// DeployLoop's checks plus the final-1 inputs (split out so tests can drive them without the environment).
    function _checkFinalConfig(FinalConfig memory f) internal view {
        _checkConfig(f.base);
        require(
            keccak256(bytes(f.base.deploymentId)) != keccak256("loop-1"), "DEPLOYMENT_ID loop-1 belongs to the loop set"
        );
        uint64 t = f.loosenTimelockSeconds;
        require(t > 0 && t <= MAX_LOOSEN_TIMELOCK_SECONDS, "LOOSEN_TIMELOCK_SECONDS must be 1 s to 30 days");
        require(
            t >= MIN_SECONDS_OFF_ANVIL || block.chainid == ANVIL_CHAIN_ID,
            "LOOSEN_TIMELOCK_SECONDS must be >= 120 s off Anvil (production: 24 h)"
        );
        _checkObserver(f);
    }

    /// The optional observer (0 = none) holds a veto on its own key: never the lender or the oracle (Treasury enforces
    /// the same, C(13); PlanRegistry keeps the owner EOA and the agent off it), and off Anvil never a public key.
    function _checkObserver(FinalConfig memory f) internal view {
        if (f.observer == address(0)) return;
        require(
            f.observer != f.base.lender && f.observer != f.base.oracle,
            "OBSERVER_ADDRESS must differ from LENDER_ADDRESS and ORACLE_ADDRESS"
        );
        if (block.chainid != ANVIL_CHAIN_ID) {
            require(!_isAnvilAccount(f.observer), "OBSERVER_ADDRESS must not be an Anvil default account off Anvil");
        }
    }

    /// The 120 s demo default applies on Anvil only; any other chain must set LOOSEN_TIMELOCK_SECONDS explicitly.
    function _loosenTimelock(bool isSet, uint256 raw) internal view returns (uint64) {
        require(isSet || block.chainid == ANVIL_CHAIN_ID, "LOOSEN_TIMELOCK_SECONDS must be set explicitly off Anvil");
        return SafeCast.toUint64(isSet ? raw : DEMO_LOOSEN_TIMELOCK_SECONDS);
    }

    // ---------------------------------------------------------------------------------------------------------
    // deploy
    // ---------------------------------------------------------------------------------------------------------

    function _deployFinal(FinalConfig memory f) internal returns (Deployed memory d) {
        Config memory c = f.base;
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        _requireDeployer(deployer); // the links below are precomputed from this deployer's nonces
        uint256 nonce = vm.getNonce(deployer);
        address treasuryAt = vm.computeCreateAddress(deployer, nonce + 1);
        TreasuryLinks memory links = TreasuryLinks({
            escrow: vm.computeCreateAddress(deployer, nonce + 2),
            salesOracle: vm.computeCreateAddress(deployer, nonce + 3),
            observer: f.observer,
            loosenTimelockSeconds: f.loosenTimelockSeconds
        });
        d.registry = new PlanRegistry(
            c.lender, treasuryAt, _tag(c.deploymentId), _tag(c.chainTag), c.fiscoMs, c.judgingWindowEnd
        );
        d.treasury = new Treasury(
            address(d.registry), c.oracle, c.coolingSeconds, links, c.platformPayeeIds, c.platformPayoutHashes
        );
        d.escrow = new MilestoneEscrow(address(d.treasury));
        d.sales = new SalesOracle(address(d.treasury));
        vm.stopBroadcast();
        _checkLinks(c, d, treasuryAt, links);
    }

    function _checkLinks(Config memory c, Deployed memory d, address treasuryAt, TreasuryLinks memory links)
        internal
        view
    {
        Treasury t = d.treasury;
        require(address(t) == treasuryAt && d.registry.treasury() == address(t), "registry -> treasury link mismatch");
        require(t.registry() == address(d.registry), "treasury -> registry link mismatch");
        require(address(d.escrow) == links.escrow && t.escrow() == address(d.escrow), "escrow link mismatch");
        require(address(d.sales) == links.salesOracle && t.salesOracle() == address(d.sales), "sales link mismatch");
        require(d.escrow.treasury() == address(t) && d.sales.treasury() == address(t), "module -> treasury mismatch");
        require(t.lender() == c.lender && d.registry.lender() == c.lender, "lender mismatch");
        require(t.oracle() == c.oracle && d.sales.oracle() == c.oracle, "oracle mismatch");
        require(t.governance().code.length > 0, "governance module missing");
        bytes32 rd = d.registry.domainSeparator();
        bytes32 td = t.domainSeparator();
        bytes32 ed = d.escrow.domainSeparator();
        require(rd != td && td != ed && rd != ed, "domains must differ per contract");
    }

    // ---------------------------------------------------------------------------------------------------------
    // output
    // ---------------------------------------------------------------------------------------------------------

    function _printFinal(FinalConfig memory f, Deployed memory d) internal view {
        console2.log("PlanRegistry    ", address(d.registry));
        console2.log("Treasury        ", address(d.treasury));
        console2.log("  governance    ", d.treasury.governance());
        console2.log("MilestoneEscrow ", address(d.escrow));
        console2.log("SalesOracle     ", address(d.sales));
        console2.log("deploymentId    ", f.base.deploymentId);
        console2.log("chainTag        ", f.base.chainTag);
        console2.log("lender          ", f.base.lender);
        console2.log("oracle          ", f.base.oracle);
        console2.log("observer        ", f.observer);
        console2.log("coolingSeconds  ", f.base.coolingSeconds);
        console2.log("loosenTimelock  ", f.loosenTimelockSeconds);
        console2.log("judgingWindowEnd", f.base.judgingWindowEnd);
        for (uint256 i; i < f.base.platformPayeeLabels.length; ++i) {
            console2.log("platform payee  ", f.base.platformPayeeLabels[i]);
        }
    }

    /// packages/chain/src/deployments.ts DeploymentManifest with all four contracts.
    function _finalManifest(FinalConfig memory f, uint256 startBlock, Deployed memory d)
        internal
        view
        returns (string memory)
    {
        string memory contracts_ = string.concat(
            _entry("PlanRegistry", address(d.registry)),
            ",",
            _entry("Treasury", address(d.treasury)),
            ",",
            _entry("MilestoneEscrow", address(d.escrow)),
            ",",
            _entry("SalesOracle", address(d.sales))
        );
        return string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"deploymentId":"',
            f.base.deploymentId,
            '","chainTag":"',
            f.base.chainTag,
            '","contracts":{',
            contracts_,
            '},"blockNumber":',
            vm.toString(startBlock),
            ',"deployedAt":"',
            _deployedAt(f.base.fiscoMs),
            '"}'
        );
    }

    function _entry(string memory name, address addr) internal pure returns (string memory) {
        return string.concat('"', name, '":{"address":"', vm.toString(addr), '"}');
    }
}
