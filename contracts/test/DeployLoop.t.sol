// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {DeployLoop} from "../script/DeployLoop.s.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";

contract DeployLoopHarness is DeployLoop {
    function iso(uint256 ts) external pure returns (string memory) {
        return _isoUtc(ts);
    }

    function tag(string memory label) external pure returns (bytes32) {
        return _tag(label);
    }

    function check(Config memory c) external view {
        _checkConfig(c);
    }

    function cooling(bool isSet, uint256 raw) external view returns (uint64) {
        return _coolingSeconds(isSet, raw);
    }

    function judgingEnd(uint256 raw) external pure returns (uint64) {
        return _judgingWindowEnd(raw);
    }

    function requireDeployer(address deployer) external view {
        _requireDeployer(deployer);
    }

    function deployedAt(bool fiscoMs) external view returns (string memory) {
        return _deployedAt(fiscoMs);
    }
}

/// The deploy script links the pair, wires roles from the environment and formats the manifest. The config checks
/// (run-2 audit) are driven through the harness with explicit configs: forge runs tests in parallel and the process
/// environment is shared, so only setUp() writes it, always with the same values.
contract DeployLoopTest is Test {
    uint256 internal constant SEPOLIA = 11_155_111;
    uint256 internal constant FISCO_CHAIN = 20_200;
    address internal constant ANVIL_ACCOUNT_0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant ANVIL_ACCOUNT_9 = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;

    DeployLoopHarness internal script;

    function setUp() public {
        script = new DeployLoopHarness();
        vm.setEnv("LENDER_ADDRESS", vm.toString(makeAddr("lender")));
        vm.setEnv("ORACLE_ADDRESS", vm.toString(makeAddr("oracle")));
        vm.setEnv("DEPLOYMENT_ID", "loop-1");
        vm.setEnv("CHAIN_TAG", "anvil");
        vm.setEnv("PLATFORM_PAYEE_IDS", "shopee-ads,shopee-fees");
        vm.setEnv(
            "PLATFORM_PAYOUT_HASHES",
            string.concat(vm.toString(keccak256("ads-account")), ",", vm.toString(keccak256("fees-account")))
        );
    }

    function test_Run_DeploysALinkedPairWithEnvRoles() public {
        (PlanRegistry registry, Treasury treasury) = script.run();
        assertEq(registry.treasury(), address(treasury));
        assertEq(treasury.registry(), address(registry));
        assertEq(registry.lender(), makeAddr("lender"));
        assertEq(treasury.oracle(), makeAddr("oracle"));
        assertEq(registry.deploymentId(), bytes32("loop-1"));
        assertEq(treasury.chainTag(), bytes32("anvil"));
        assertEq(treasury.coolingSeconds(), 120);
        assertEq(registry.judgingWindowEnd(), 1_796_083_199);
        assertEq(treasury.platformPayoutAccountHash("shopee-ads"), keccak256("ads-account"));
        assertEq(treasury.platformPayoutAccountHash("shopee-fees"), keccak256("fees-account"));
        assertEq(
            registry.domainSeparator(),
            HogeeTypes.domainSeparator(address(registry), bytes32("anvil"), bytes32("loop-1"))
        );
    }

    function test_IsoUtc() public view {
        assertEq(script.iso(1_792_108_800), "2026-10-16T00:00:00Z");
        assertEq(script.iso(1_796_083_199), "2026-11-30T23:59:59Z");
        assertEq(script.iso(951_782_400), "2000-02-29T00:00:00Z");
        assertEq(script.iso(0), "1970-01-01T00:00:00Z");
    }

    /// The manifest's deployedAt is UTC seconds on either clock.
    function test_DeployedAt_ScalesAMillisecondClock() public {
        vm.warp(1_792_108_800);
        assertEq(script.deployedAt(false), "2026-10-16T00:00:00Z");
        vm.warp(1_792_108_800_000);
        assertEq(script.deployedAt(true), "2026-10-16T00:00:00Z");
    }

    function test_TagMatchesToBytes32Tag() public view {
        assertEq(script.tag("final-1"), bytes32("final-1"));
        assertEq(script.tag("sepolia"), bytes32("sepolia"));
    }

    function test_CheckConfig_AcceptsTheDefaultAnvilConfig() public {
        script.check(_config());
    }

    /// Role separation (run-2 audit): the lender never settles.
    function test_Revert_CheckConfig_lenderIsOracle() public {
        DeployLoop.Config memory c = _config();
        c.oracle = c.lender;
        vm.expectRevert(bytes("LENDER_ADDRESS and ORACLE_ADDRESS must differ"));
        script.check(c);
    }

    // ---------------------------------------------------------------------------------------------------------
    // CHAIN_TAG <-> block.chainid, FISCO_MS
    // ---------------------------------------------------------------------------------------------------------

    function test_CheckConfig_SepoliaTagOnSepolia() public {
        vm.chainId(SEPOLIA);
        script.check(_config("sepolia"));
    }

    function test_Revert_CheckConfig_sepoliaTagOnAnvil() public {
        vm.expectRevert(bytes("CHAIN_TAG must be anvil on chain 31337"));
        script.check(_config("sepolia"));
    }

    function test_Revert_CheckConfig_anvilTagOnSepolia() public {
        vm.chainId(SEPOLIA);
        vm.expectRevert(bytes("CHAIN_TAG must be sepolia on chain 11155111"));
        script.check(_config("anvil"));
    }

    function test_Revert_CheckConfig_unknownTagOnAnotherChain() public {
        vm.chainId(FISCO_CHAIN);
        vm.expectRevert(bytes("CHAIN_TAG does not match block.chainid"));
        script.check(_config("anvil"));
    }

    /// A FISCO chain whose genesis does not set feature_evm_timestamp reports block.timestamp in milliseconds.
    function test_CheckConfig_FiscoTagWithFiscoMs() public {
        vm.chainId(FISCO_CHAIN);
        vm.warp(1_792_108_800_000);
        DeployLoop.Config memory c = _config("fisco");
        c.fiscoMs = true;
        script.check(c);
        c.chainTag = "fisco-air";
        script.check(c);
    }

    /// FISCO BCOS 3.x with feature_evm_timestamp=1 in the genesis (and forge's simulation, which reads the RPC's
    /// seconds header) has a seconds clock: a fisco tag with FISCO_MS=false is accepted there.
    function test_CheckConfig_FiscoTagOnASecondsClock() public {
        vm.chainId(FISCO_CHAIN);
        vm.warp(1_792_108_800); // seconds
        DeployLoop.Config memory c = _config("fisco");
        script.check(c);
        c.chainTag = "fisco-air";
        script.check(c);
    }

    /// The clock check still ties FISCO_MS to the clock: a fisco tag on a millisecond clock needs FISCO_MS=true.
    function test_Revert_CheckConfig_fiscoTagOnAMillisecondClockWithoutFiscoMs() public {
        vm.chainId(FISCO_CHAIN);
        vm.warp(1_792_108_800_000); // milliseconds
        vm.expectRevert(bytes("FISCO_MS=false needs a block.timestamp in seconds"));
        script.check(_config("fisco"));
        vm.expectRevert(bytes("FISCO_MS=false needs a block.timestamp in seconds"));
        script.check(_config("fisco-air"));
    }

    /// FISCO_MS must match the chain's clock, or _now() reads as 1970 (or the far future) and every expiry check
    /// silently passes or fails.
    function test_Revert_CheckConfig_fiscoMsOnASecondsClock() public {
        vm.chainId(FISCO_CHAIN);
        vm.warp(1_792_108_800); // seconds
        DeployLoop.Config memory c = _config("fisco");
        c.fiscoMs = true;
        vm.expectRevert(bytes("FISCO_MS=true needs a millisecond block.timestamp"));
        script.check(c);
    }

    function test_Revert_CheckConfig_millisecondClockWithoutFiscoMs() public {
        vm.chainId(SEPOLIA);
        vm.warp(1_792_108_800_000); // milliseconds
        vm.expectRevert(bytes("FISCO_MS=false needs a block.timestamp in seconds"));
        script.check(_config("sepolia"));
    }

    function test_Revert_CheckConfig_fiscoMsOnSepolia() public {
        vm.chainId(SEPOLIA);
        DeployLoop.Config memory c = _config("sepolia");
        c.fiscoMs = true;
        vm.expectRevert(bytes("FISCO_MS=true needs a fisco CHAIN_TAG"));
        script.check(c);
    }

    function test_Revert_CheckConfig_fiscoMsOnAnvil() public {
        vm.warp(1_792_108_800_000); // even on a millisecond clock
        DeployLoop.Config memory c = _config("anvil");
        c.fiscoMs = true;
        vm.expectRevert(bytes("FISCO_MS=true needs a fisco CHAIN_TAG"));
        script.check(c);
    }

    /// A fisco tag is not accepted on the chains that have their own tag.
    function test_Revert_CheckConfig_fiscoTagOnAnvilOrSepolia() public {
        vm.expectRevert(bytes("CHAIN_TAG must be anvil on chain 31337"));
        script.check(_config("fisco"));
        vm.chainId(SEPOLIA);
        vm.expectRevert(bytes("CHAIN_TAG must be sepolia on chain 11155111"));
        script.check(_config("fisco"));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Off Anvil: no Anvil default accounts, explicit COOLING_SECONDS
    // ---------------------------------------------------------------------------------------------------------

    function test_CheckConfig_AnvilDefaultAccountsAllowedOnAnvil() public {
        DeployLoop.Config memory c = _config("anvil");
        (c.lender, c.oracle) = (ANVIL_ACCOUNT_0, ANVIL_ACCOUNT_9);
        script.check(c);
    }

    function test_Revert_CheckConfig_anvilDefaultLenderOffAnvil() public {
        vm.chainId(SEPOLIA);
        DeployLoop.Config memory c = _config("sepolia");
        c.lender = ANVIL_ACCOUNT_0;
        vm.expectRevert(bytes("LENDER_ADDRESS and ORACLE_ADDRESS must not be Anvil default accounts off Anvil"));
        script.check(c);
    }

    function test_Revert_CheckConfig_anvilDefaultOracleOffAnvil() public {
        vm.chainId(SEPOLIA);
        DeployLoop.Config memory c = _config("sepolia");
        c.oracle = ANVIL_ACCOUNT_9;
        vm.expectRevert(bytes("LENDER_ADDRESS and ORACLE_ADDRESS must not be Anvil default accounts off Anvil"));
        script.check(c);
    }

    /// A FISCO chain is "off Anvil": its lender may not hold a public Anvil key either.
    function test_Revert_CheckConfig_anvilDefaultLenderOnFisco() public {
        vm.chainId(FISCO_CHAIN);
        vm.warp(1_792_108_800);
        DeployLoop.Config memory c = _config("fisco");
        c.lender = ANVIL_ACCOUNT_0;
        vm.expectRevert(bytes("LENDER_ADDRESS and ORACLE_ADDRESS must not be Anvil default accounts off Anvil"));
        script.check(c);
    }

    /// Audit run-3: a broadcaster whose key is public could use the deployer nonces the linked CREATE addresses are
    /// precomputed from before the script does.
    function test_Revert_RequireDeployer_anvilDefaultAccountOffAnvil() public {
        vm.chainId(SEPOLIA);
        vm.expectRevert(bytes("the broadcaster must not be an Anvil default account off Anvil"));
        script.requireDeployer(ANVIL_ACCOUNT_0);
        vm.expectRevert(bytes("the broadcaster must not be an Anvil default account off Anvil"));
        script.requireDeployer(ANVIL_ACCOUNT_9);
        script.requireDeployer(makeAddr("deployer"));
    }

    function test_RequireDeployer_AnvilDefaultAccountAllowedOnAnvil() public view {
        script.requireDeployer(ANVIL_ACCOUNT_0);
    }

    /// _now() + coolingSeconds must never overflow (bindPayee would always revert). _now() is seconds on every chain,
    /// so the bound is 30 days in seconds under FISCO_MS too.
    function test_Revert_CheckConfig_coolingOverThirtyDays() public {
        DeployLoop.Config memory c = _config("anvil");
        c.coolingSeconds = 30 days;
        script.check(c);
        c.coolingSeconds = 30 days + 1;
        vm.expectRevert(bytes("COOLING_SECONDS must be <= 30 days"));
        script.check(c);
        c.coolingSeconds = type(uint64).max;
        vm.expectRevert(bytes("COOLING_SECONDS must be <= 30 days"));
        script.check(c);
    }

    /// Audit run-3: off Anvil the payee veto window is at least the labelled-demo 120 s (production: 24 h). Anvil
    /// keeps the contract's 1 s minimum for short local runs.
    function test_Revert_CheckConfig_coolingUnder120sOffAnvil() public {
        vm.chainId(SEPOLIA);
        DeployLoop.Config memory c = _config("sepolia");
        c.coolingSeconds = 119;
        vm.expectRevert(bytes("COOLING_SECONDS must be >= 120 s off Anvil (production: 24 h)"));
        script.check(c);
        c.coolingSeconds = 1;
        vm.expectRevert(bytes("COOLING_SECONDS must be >= 120 s off Anvil (production: 24 h)"));
        script.check(c);
        c.coolingSeconds = 120;
        script.check(c);
        c.coolingSeconds = 24 hours;
        script.check(c);
    }

    /// The 120 s floor holds on a FISCO chain on either clock.
    function test_Revert_CheckConfig_coolingUnder120sOnFisco() public {
        vm.chainId(FISCO_CHAIN);
        vm.warp(1_792_108_800); // seconds
        DeployLoop.Config memory c = _config("fisco");
        c.coolingSeconds = 60;
        vm.expectRevert(bytes("COOLING_SECONDS must be >= 120 s off Anvil (production: 24 h)"));
        script.check(c);
        c.coolingSeconds = 120;
        script.check(c);
        vm.warp(1_792_108_800_000); // milliseconds
        c.fiscoMs = true;
        c.coolingSeconds = 60;
        vm.expectRevert(bytes("COOLING_SECONDS must be >= 120 s off Anvil (production: 24 h)"));
        script.check(c);
    }

    function test_CheckConfig_ShortCoolingAllowedOnAnvil() public {
        DeployLoop.Config memory c = _config("anvil");
        c.coolingSeconds = 1;
        script.check(c);
    }

    function test_Cooling_DemoDefaultOnlyOnAnvil() public {
        assertEq(script.cooling(false, 0), 120);
        assertEq(script.cooling(true, 86_400), 86_400);
        vm.chainId(SEPOLIA);
        assertEq(script.cooling(true, 86_400), 86_400);
        vm.expectRevert(bytes("COOLING_SECONDS must be set explicitly off Anvil"));
        script.cooling(false, 0);
    }

    // ---------------------------------------------------------------------------------------------------------
    // uint64 casts and the judging window
    // ---------------------------------------------------------------------------------------------------------

    function test_Revert_Cooling_overflowsUint64() public {
        uint256 raw = uint256(type(uint64).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 64, raw));
        script.cooling(true, raw);
    }

    function test_Revert_JudgingWindowEnd_overflowsUint64() public {
        uint256 raw = uint256(type(uint64).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 64, raw));
        script.judgingEnd(raw);
    }

    function test_Revert_CheckConfig_judgingWindowAlreadyOver() public {
        DeployLoop.Config memory c = _config("anvil");
        vm.warp(c.judgingWindowEnd);
        vm.expectRevert(bytes("JUDGING_WINDOW_END must be in the future"));
        script.check(c);
        vm.warp(c.judgingWindowEnd - 1);
        script.check(c);
    }

    function test_Revert_TagRejectsBadLabels() public {
        vm.expectRevert(bytes("label must match [a-z0-9][a-z0-9-]{0,31}"));
        script.tag("Loop-1");
        vm.expectRevert(bytes("label must match [a-z0-9][a-z0-9-]{0,31}"));
        script.tag("-loop");
        vm.expectRevert(bytes("label must be 1-32 bytes"));
        script.tag("");
    }

    /// The anvil defaults the environment in setUp() resolves to.
    function _config() internal returns (DeployLoop.Config memory c) {
        return _config("anvil");
    }

    function _config(string memory chainTag) internal returns (DeployLoop.Config memory c) {
        c.deploymentId = "loop-1";
        c.chainTag = chainTag;
        c.lender = makeAddr("lender");
        c.oracle = makeAddr("oracle");
        c.coolingSeconds = 120;
        c.judgingWindowEnd = 1_796_083_199;
    }
}
