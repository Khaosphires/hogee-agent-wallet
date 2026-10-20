// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {PlanApproval, Sig, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {RinaFixture} from "../test/utils/RinaFixture.sol";

/// @title SmokeLoop: Anvil-only end-to-end smoke of a freshly deployed loop-1 pair.
/// @notice The founder's PlanApproval is signed by the NODE with eth_signTypedData_v4 (the MetaMask path) over the
///         chainId-less custom domain, so this is the live wallet-signing check G0-DECISIONS §1 asks for. Then:
///         lender opens the facility + registers the founder, a relayer commits, the lender funds, the agent pays
///         ADS slot 1 and the oracle confirms. Needs Anvil's unlocked default accounts (`--unlocked`); never use on
///         a public chain.
///   REGISTRY=0x… TREASURY=0x… forge script script/SmokeLoop.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///     --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
contract SmokeLoop is Script, RinaFixture {
    // Anvil default accounts (public test addresses).
    address internal constant LENDER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // #2
    address internal constant ORACLE = 0x90F79bf6EB2c4f870365E785982E1f101E93b906; // #3
    address internal constant FOUNDER = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; // #4
    address internal constant RELAYER = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc; // #5

    function run() external {
        PlanRegistry registry = PlanRegistry(vm.envAddress("REGISTRY"));
        Treasury treasury = Treasury(vm.envAddress("TREASURY"));
        require(treasury.oracle() == ORACLE && registry.lender() == LENDER, "deploy with Anvil #2 lender, #3 oracle");

        vm.startBroadcast(LENDER);
        treasury.openFacility(1_000_000, 300);
        registry.registerFounderKey(bytes32(0), bytes32(0), FOUNDER);
        vm.stopBroadcast();

        PlanApproval memory a = _planApproval();
        a.deploymentId = registry.deploymentId();
        bytes memory sig = vm.rpc("eth_signTypedData_v4", _signParams(registry, a));
        bytes32 digest = HogeeTypes.digest(registry.domainSeparator(), HogeeTypes.hashPlanApproval(a));
        console2.log("PlanApproval digest (contract):");
        console2.logBytes32(digest);
        console2.log("eth_signTypedData_v4 signature:");
        console2.logBytes(sig);

        vm.startBroadcast(RELAYER);
        registry.commitPlan(a, _lines(), _stages(), Sig({kind: HogeeKinds.SIG_ECDSA, data: sig}));
        vm.stopBroadcast();

        vm.startBroadcast(LENDER);
        treasury.fund(1_000_000);
        vm.stopBroadcast();

        vm.startBroadcast(AGENT);
        bytes32 spendId = treasury.spend("ADS", "shopee-ads", 7_500, bytes32(uint256(1)), 1, "smoke-1", "smoke");
        vm.stopBroadcast();

        vm.startBroadcast(ORACLE);
        treasury.confirmSettlement(spendId, keccak256("smoke-payout-ref"));
        vm.stopBroadcast();

        console2.log("planVersion", registry.planVersion());
        console2.log("releasedMinor", treasury.releasedMinor());
        console2.log("ADS spent", treasury.pocket("ADS").spentMinor);
        console2.log("spendId (intentId of Rina ADS slot 1 at 7,500/day):");
        console2.logBytes32(spendId);
        console2.log("settlementState", treasury.settlementState(spendId));
    }

    /// ["<founder>", <EIP-712 typed data>] with the custom domain {name, version, verifyingContract, salt}.
    function _signParams(PlanRegistry registry, PlanApproval memory a) internal view returns (string memory) {
        string memory types = string.concat(
            '{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"verifyingContract","type":"address"},{"name":"salt","type":"bytes32"}],',
            '"PlanApproval":[{"name":"planId","type":"bytes32"},{"name":"version","type":"uint32"},',
            '{"name":"prevPlanHash","type":"bytes32"},{"name":"planHash","type":"bytes32"},',
            '{"name":"countryPackHash","type":"bytes32"},{"name":"linesHash","type":"bytes32"},',
            '{"name":"stagesHash","type":"bytes32"},{"name":"totalMinor","type":"uint128"},',
            '{"name":"reserveBps","type":"uint16"},{"name":"agent","type":"address"},',
            '{"name":"agentExpiry","type":"uint64"},{"name":"deploymentId","type":"bytes32"},',
            '{"name":"nonce","type":"uint256"},{"name":"expiry","type":"uint64"}]}'
        );
        string memory domain = string.concat(
            '{"name":"Hogee","version":"1","verifyingContract":"',
            vm.toString(address(registry)),
            '","salt":"',
            vm.toString(HogeeTypes.domainSalt(registry.chainTag(), registry.deploymentId())),
            '"}'
        );
        return string.concat(
            '["',
            vm.toString(FOUNDER),
            '",{"types":',
            types,
            ',"primaryType":"PlanApproval","domain":',
            domain,
            ',"message":',
            _message(a),
            "}]"
        );
    }

    function _message(PlanApproval memory a) internal pure returns (string memory) {
        string memory head = string.concat(
            '{"planId":"',
            vm.toString(a.planId),
            '","version":"',
            vm.toString(uint256(a.version)),
            '","prevPlanHash":"',
            vm.toString(a.prevPlanHash),
            '","planHash":"',
            vm.toString(a.planHash),
            '","countryPackHash":"',
            vm.toString(a.countryPackHash),
            '","linesHash":"',
            vm.toString(a.linesHash),
            '","stagesHash":"',
            vm.toString(a.stagesHash)
        );
        return string.concat(
            head,
            '","totalMinor":"',
            vm.toString(uint256(a.totalMinor)),
            '","reserveBps":"',
            vm.toString(uint256(a.reserveBps)),
            '","agent":"',
            vm.toString(a.agent),
            '","agentExpiry":"',
            vm.toString(uint256(a.agentExpiry)),
            '","deploymentId":"',
            vm.toString(a.deploymentId),
            '","nonce":"',
            vm.toString(a.nonce),
            '","expiry":"',
            vm.toString(uint256(a.expiry)),
            '"}'
        );
    }
}
