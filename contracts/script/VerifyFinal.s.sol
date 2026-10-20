// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {TreasuryGovernance} from "../src/TreasuryGovernance.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {SalesOracle} from "../src/SalesOracle.sol";

/// @title VerifyFinal: read-only, post-broadcast check of a deployed `final-1` set (audit run-3). Broadcasts nothing.
/// @notice DeployFinal asserts every link only in the forge simulation, before its transactions are mined. Run this
///         against the chain once they are: it checks it runs on the manifest's chain, reads the five deployed
///         contracts back and asserts that each has code and that every link matches (registry <-> treasury,
///         treasury -> governance, treasury -> escrow, treasury -> sales oracle, escrow -> treasury, sales oracle ->
///         treasury), that the governance module carries the same immutables as Treasury, and (re-check L-2) every
///         other value DeployFinal asserts or was given: lender, oracle, deployment id and chain tag, the clock
///         scale (FISCO_MS), observer, cooling and loosening timelock. Off chain 31337 it also enforces DeployFinal's
///         120 s floors on cooling and the timelock. Any mismatch reverts with a message naming it.
///
/// Inputs (environment; addresses, labels and numbers only, never a key; all required unless marked). DeployFinal
/// prints the manifest rather than writing it, so the values come from the environment; fill them from the saved
/// manifest and the deploy inputs with jq (below):
///   CHAIN_ID                manifest .chainId (the RPC must serve this chain)
///   EXPECTED_DEPLOYMENT_ID  manifest .deploymentId (not DEPLOYMENT_ID, which the deploy scripts read)
///   EXPECTED_CHAIN_TAG      manifest .chainTag
///   REGISTRY_ADDRESS        manifest .contracts.PlanRegistry.address
///   TREASURY_ADDRESS        manifest .contracts.Treasury.address
///   GOVERNANCE_ADDRESS      DeployFinal's "governance" summary line, or
///                           `cast call $TREASURY_ADDRESS "governance()(address)" --rpc-url <rpc>`
///   ESCROW_ADDRESS          manifest .contracts.MilestoneEscrow.address
///   SALES_ORACLE_ADDRESS    manifest .contracts.SalesOracle.address
///   LENDER_ADDRESS          the lender DeployFinal was given
///   ORACLE_ADDRESS          the oracle DeployFinal was given
///   COOLING_SECONDS         the payee cooling DeployFinal was given (120 in the labelled demo, 86400 in production)
///   OBSERVER_ADDRESS        optional: the observer DeployFinal was given; default none (address 0)
///   LOOSEN_TIMELOCK_SECONDS the timelock DeployFinal was given (120 in the labelled demo, 86400 in production)
///   EXPECTED_FISCO_MS       optional: the FISCO_MS DeployFinal was given; default false (a seconds clock, which is
///                           also the FISCO mirror's: scripts/fisco/deploy.sh)
///
///   M=../packages/chain/deployments/<chainTag>-<deploymentId>.json
///   CHAIN_ID=$(jq -r .chainId $M) \
///   EXPECTED_DEPLOYMENT_ID=$(jq -r .deploymentId $M) \
///   EXPECTED_CHAIN_TAG=$(jq -r .chainTag $M) \
///   REGISTRY_ADDRESS=$(jq -r .contracts.PlanRegistry.address $M) \
///   TREASURY_ADDRESS=$(jq -r .contracts.Treasury.address $M) \
///   ESCROW_ADDRESS=$(jq -r .contracts.MilestoneEscrow.address $M) \
///   SALES_ORACLE_ADDRESS=$(jq -r .contracts.SalesOracle.address $M) \
///   GOVERNANCE_ADDRESS=0x… LENDER_ADDRESS=0x… ORACLE_ADDRESS=0x… OBSERVER_ADDRESS=0x… \
///   COOLING_SECONDS=120 LOOSEN_TIMELOCK_SECONDS=120 \
///     forge script script/VerifyFinal.s.sol --rpc-url <rpc>        (no --broadcast, no key)
contract VerifyFinal is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31_337;
    /// DeployFinal's floor for COOLING_SECONDS and LOOSEN_TIMELOCK_SECONDS off Anvil (labelled demo; production 24 h).
    uint256 internal constant MIN_SECONDS_OFF_ANVIL = 120;

    struct Expected {
        address registry;
        address treasury;
        address governance;
        address escrow;
        address salesOracle;
        address observer;
        uint64 loosenTimelockSeconds;
        address lender;
        address oracle;
        uint64 coolingSeconds;
        uint256 chainId;
        bytes32 deploymentId;
        bytes32 chainTag;
        bool fiscoMs;
    }

    function run() external view {
        Expected memory e = _expected();
        _verify(e);
        console2.log("VerifyFinal: OK (chain, code, links, roles, domain tags, cooling and timelock match)");
        console2.log("chainId         ", e.chainId);
        console2.log("fiscoMs         ", e.fiscoMs);
        console2.log("PlanRegistry    ", e.registry);
        console2.log("Treasury        ", e.treasury);
        console2.log("  governance    ", e.governance);
        console2.log("MilestoneEscrow ", e.escrow);
        console2.log("SalesOracle     ", e.salesOracle);
        console2.log("lender          ", e.lender);
        console2.log("oracle          ", e.oracle);
        console2.log("observer        ", e.observer);
        console2.log("coolingSeconds  ", e.coolingSeconds);
        console2.log("loosenTimelock  ", e.loosenTimelockSeconds);
    }

    function _expected() internal view returns (Expected memory e) {
        e.registry = vm.envAddress("REGISTRY_ADDRESS");
        e.treasury = vm.envAddress("TREASURY_ADDRESS");
        e.governance = vm.envAddress("GOVERNANCE_ADDRESS");
        e.escrow = vm.envAddress("ESCROW_ADDRESS");
        e.salesOracle = vm.envAddress("SALES_ORACLE_ADDRESS");
        e.observer = vm.envOr("OBSERVER_ADDRESS", address(0));
        e.loosenTimelockSeconds = SafeCast.toUint64(vm.envUint("LOOSEN_TIMELOCK_SECONDS"));
        e.lender = vm.envAddress("LENDER_ADDRESS");
        e.oracle = vm.envAddress("ORACLE_ADDRESS");
        e.coolingSeconds = SafeCast.toUint64(vm.envUint("COOLING_SECONDS"));
        e.chainId = vm.envUint("CHAIN_ID");
        e.deploymentId = _label(vm.envString("EXPECTED_DEPLOYMENT_ID"), "EXPECTED_DEPLOYMENT_ID must be 1-32 bytes");
        e.chainTag = _label(vm.envString("EXPECTED_CHAIN_TAG"), "EXPECTED_CHAIN_TAG must be 1-32 bytes");
        e.fiscoMs = vm.envOr("EXPECTED_FISCO_MS", false);
    }

    /// A manifest label right-padded to bytes32, as DeployLoop._tag stores it (the on-chain value is compared exactly).
    function _label(string memory label, string memory err) internal pure returns (bytes32) {
        bytes memory b = bytes(label);
        require(b.length > 0 && b.length <= 32, err);
        return bytes32(b);
    }

    /// The chain first (a wrong RPC), code next (a call to an address without code would fail with an unhelpful decode
    /// error), then every link, the roles, the domain tags and the timings.
    function _verify(Expected memory e) internal view {
        require(block.chainid == e.chainId, "chain id mismatch");
        require(e.registry.code.length > 0, "no code at REGISTRY_ADDRESS");
        require(e.treasury.code.length > 0, "no code at TREASURY_ADDRESS");
        require(e.governance.code.length > 0, "no code at GOVERNANCE_ADDRESS");
        require(e.escrow.code.length > 0, "no code at ESCROW_ADDRESS");
        require(e.salesOracle.code.length > 0, "no code at SALES_ORACLE_ADDRESS");
        Treasury t = Treasury(e.treasury);
        require(
            PlanRegistry(e.registry).treasury() == e.treasury && t.registry() == e.registry,
            "registry <-> treasury link mismatch"
        );
        require(t.governance() == e.governance, "treasury -> governance link mismatch");
        require(t.escrow() == e.escrow, "treasury -> escrow link mismatch");
        require(t.salesOracle() == e.salesOracle, "treasury -> sales oracle link mismatch");
        require(MilestoneEscrow(e.escrow).treasury() == e.treasury, "escrow -> treasury link mismatch");
        require(SalesOracle(e.salesOracle).treasury() == e.treasury, "sales oracle -> treasury link mismatch");
        _verifyGovernance(t, TreasuryGovernance(e.governance));
        _verifyRolesAndDomain(e, t);
        _verifyTimings(e, t);
    }

    /// DeployFinal._checkLinks' lender and oracle asserts, the EIP-712 salt tags of the three verifying contracts and
    /// their clock scale (a wrong FISCO_MS reads every expiry as 1970 or the far future).
    function _verifyRolesAndDomain(Expected memory e, Treasury t) internal view {
        PlanRegistry r = PlanRegistry(e.registry);
        MilestoneEscrow m = MilestoneEscrow(e.escrow);
        require(t.lender() == e.lender && r.lender() == e.lender, "lender mismatch");
        require(t.oracle() == e.oracle && SalesOracle(e.salesOracle).oracle() == e.oracle, "oracle mismatch");
        require(t.observer() == e.observer, "observer mismatch");
        bytes32 id = e.deploymentId;
        require(r.deploymentId() == id && t.deploymentId() == id && m.deploymentId() == id, "deployment id mismatch");
        bytes32 tag = e.chainTag;
        require(r.chainTag() == tag && t.chainTag() == tag && m.chainTag() == tag, "chain tag mismatch");
        bool ms = e.fiscoMs;
        require(r.fiscoMs() == ms && t.fiscoMs() == ms && m.fiscoMs() == ms, "fisco ms mismatch");
    }

    /// The given cooling and timelock, and off Anvil DeployFinal's 120 s floors (production: 24 h for both).
    function _verifyTimings(Expected memory e, Treasury t) internal view {
        uint64 timelock = t.loosenTimelockSeconds();
        uint64 cooling = t.coolingSeconds();
        require(timelock == e.loosenTimelockSeconds, "loosen timelock mismatch");
        require(cooling == e.coolingSeconds, "cooling seconds mismatch");
        if (block.chainid == ANVIL_CHAIN_ID) return;
        require(cooling >= MIN_SECONDS_OFF_ANVIL, "cooling seconds must be >= 120 s off Anvil");
        require(timelock >= MIN_SECONDS_OFF_ANVIL, "loosen timelock must be >= 120 s off Anvil");
    }

    /// Treasury created the module with its own arguments, so every immutable but the domain separator is equal.
    function _verifyGovernance(Treasury t, TreasuryGovernance g) internal view {
        require(
            g.registry() == t.registry() && g.escrow() == t.escrow() && g.salesOracle() == t.salesOracle()
                && g.observer() == t.observer() && g.loosenTimelockSeconds() == t.loosenTimelockSeconds()
                && g.coolingSeconds() == t.coolingSeconds() && g.fiscoMs() == t.fiscoMs(),
            "governance immutables differ from treasury"
        );
    }
}
