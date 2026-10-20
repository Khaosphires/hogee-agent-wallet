// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DeployLoop} from "../script/DeployLoop.s.sol";
import {DeployFinal} from "../script/DeployFinal.s.sol";
import {VerifyFinal} from "../script/VerifyFinal.s.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {SalesOracle} from "../src/SalesOracle.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";

contract DeployFinalHarness is DeployFinal {
    function deployWith(FinalConfig memory f) external returns (Deployed memory) {
        return _deployFinal(f);
    }

    function check(FinalConfig memory f) external view {
        _checkFinalConfig(f);
    }

    function timelock(bool isSet, uint256 raw) external view returns (uint64) {
        return _loosenTimelock(isSet, raw);
    }

    function manifest(FinalConfig memory f, Deployed memory d) external view returns (string memory) {
        return _finalManifest(f, 7, d);
    }

    function requireDeployer(address deployer) external view {
        _requireDeployer(deployer);
    }
}

/// VerifyFinal's checks on a set deployed here (the FISCO mirror deploy, then its read-back).
contract FiscoVerifyHarness is VerifyFinal {
    function verify(Expected memory e) external view {
        _verify(e);
    }
}

/// DeployFinal deploys and links the final-1 set (PlanRegistry, Treasury, MilestoneEscrow, SalesOracle) with the same
/// input hardening as DeployLoop (inherited) plus its own inputs (loosening timelock, observer). Driven with explicit
/// configs: the process environment is shared by parallel tests (DeployLoopTest sets DEPLOYMENT_ID=loop-1).
contract DeployFinalTest is Test {
    uint256 internal constant SEPOLIA = 11_155_111;
    uint256 internal constant FISCO_CHAIN = 20_200;
    uint256 internal constant SECONDS_NOW = 1_792_108_800; // 2026-10-16T00:00:00Z
    address internal constant ANVIL_ACCOUNT_6 = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;

    DeployFinalHarness internal script;

    function setUp() public {
        script = new DeployFinalHarness();
    }

    function test_Deploy_LinksTheFourContracts() public {
        DeployFinal.Deployed memory d = script.deployWith(_final());
        PlanRegistry r = d.registry;
        Treasury t = d.treasury;
        assertEq(r.treasury(), address(t));
        assertEq(t.registry(), address(r));
        assertEq(t.escrow(), address(d.escrow));
        assertEq(t.salesOracle(), address(d.sales));
        assertEq(d.escrow.treasury(), address(t));
        assertEq(d.sales.treasury(), address(t));
        assertEq(d.sales.oracle(), makeAddr("oracle"));
        assertEq(t.observer(), makeAddr("observer"));
        assertEq(t.loosenTimelockSeconds(), 120);
        assertGt(t.governance().code.length, 0);
        assertEq(r.deploymentId(), bytes32("final-1"));
        assertEq(d.escrow.deploymentId(), bytes32("final-1"));
        assertEq(d.escrow.domainSeparator(), HogeeTypes.domainSeparator(address(d.escrow), bytes32("anvil"), "final-1"));
    }

    /// Audit run-3: the escrow and sales-oracle links are precomputed from deployer nonces n+2 and n+3, so off Anvil the
    /// broadcaster must not be an Anvil default account (public key). The test broadcaster is forge's default sender.
    function test_Deploy_OffAnvilWithAPrivateBroadcaster() public {
        vm.chainId(SEPOLIA);
        DeployFinal.Deployed memory d = script.deployWith(_final("sepolia"));
        assertEq(d.treasury.escrow(), address(d.escrow));
    }

    /// The FISCO mirror: FISCO BCOS 3.x with feature_evm_timestamp=1 has a seconds clock, so the set deploys with a
    /// fisco tag and FISCO_MS=false, and VerifyFinal reads it back with the FISCO values.
    function test_Deploy_FiscoOnASecondsClock() public {
        vm.chainId(FISCO_CHAIN);
        vm.warp(SECONDS_NOW);
        DeployFinal.FinalConfig memory f = _final("fisco");
        f.base.deploymentId = "final-2";
        script.check(f);
        DeployFinal.Deployed memory d = script.deployWith(f);
        PlanRegistry r = d.registry;
        Treasury t = d.treasury;
        assertFalse(r.fiscoMs());
        assertFalse(t.fiscoMs());
        assertFalse(d.escrow.fiscoMs());
        assertEq(r.chainTag(), bytes32("fisco"));
        assertEq(t.chainTag(), bytes32("fisco"));
        assertEq(d.escrow.chainTag(), bytes32("fisco"));
        assertEq(d.escrow.deploymentId(), bytes32("final-2"));
        assertEq(r.treasury(), address(t));
        assertEq(t.registry(), address(r));
        assertEq(t.escrow(), address(d.escrow));
        assertEq(t.salesOracle(), address(d.sales));
        assertEq(d.escrow.treasury(), address(t));
        assertEq(d.sales.treasury(), address(t));
        assertEq(d.escrow.domainSeparator(), HogeeTypes.domainSeparator(address(d.escrow), bytes32("fisco"), "final-2"));
        assertEq(vm.parseJsonString(script.manifest(f, d), ".deployedAt"), "2026-10-16T00:00:00Z");

        FiscoVerifyHarness verifier = new FiscoVerifyHarness();
        VerifyFinal.Expected memory e = _expectedFor(d, f);
        verifier.verify(e);
        e.fiscoMs = true;
        vm.expectRevert(bytes("fisco ms mismatch"));
        verifier.verify(e);
    }

    /// FISCO_MS=true (a millisecond clock) still deploys, and the manifest's deployedAt is in UTC seconds.
    function test_Manifest_DeployedAtUnderFiscoMs() public {
        vm.chainId(FISCO_CHAIN);
        vm.warp(SECONDS_NOW * 1000);
        DeployFinal.FinalConfig memory f = _final("fisco");
        f.base.fiscoMs = true;
        script.check(f);
        DeployFinal.Deployed memory d = script.deployWith(f);
        assertTrue(d.escrow.fiscoMs());
        assertEq(vm.parseJsonString(script.manifest(f, d), ".deployedAt"), "2026-10-16T00:00:00Z");
        VerifyFinal.Expected memory e = _expectedFor(d, f);
        FiscoVerifyHarness verifier = new FiscoVerifyHarness();
        verifier.verify(e);
        e.fiscoMs = false;
        vm.expectRevert(bytes("fisco ms mismatch"));
        verifier.verify(e);
    }

    function test_Revert_RequireDeployer_anvilDefaultAccountOffAnvil() public {
        vm.chainId(SEPOLIA);
        vm.expectRevert(bytes("the broadcaster must not be an Anvil default account off Anvil"));
        script.requireDeployer(ANVIL_ACCOUNT_6);
    }

    function test_CheckFinalConfig_AcceptsTheAnvilConfig() public {
        script.check(_final());
    }

    /// The loop-1 set is deployed once, from the pre-1.8 commit; final-1 must never take its label.
    function test_Revert_CheckFinalConfig_loopDeploymentId() public {
        DeployFinal.FinalConfig memory f = _final();
        f.base.deploymentId = "loop-1";
        vm.expectRevert(bytes("DEPLOYMENT_ID loop-1 belongs to the loop set"));
        script.check(f);
    }

    function test_Revert_CheckFinalConfig_zeroTimelock() public {
        DeployFinal.FinalConfig memory f = _final();
        f.loosenTimelockSeconds = 0;
        vm.expectRevert(bytes("LOOSEN_TIMELOCK_SECONDS must be 1 s to 30 days"));
        script.check(f);
    }

    function test_Revert_CheckFinalConfig_timelockOver30Days() public {
        DeployFinal.FinalConfig memory f = _final();
        f.loosenTimelockSeconds = 30 days + 1;
        vm.expectRevert(bytes("LOOSEN_TIMELOCK_SECONDS must be 1 s to 30 days"));
        script.check(f);
    }

    /// Audit run-3: off Anvil the loosening timelock is at least the labelled-demo 120 s (production: 24 h). Anvil
    /// keeps the contract's 1 s minimum for short local runs.
    function test_Revert_CheckFinalConfig_timelockUnder120sOffAnvil() public {
        vm.chainId(SEPOLIA);
        DeployFinal.FinalConfig memory f = _final("sepolia");
        f.observer = address(0);
        f.loosenTimelockSeconds = 119;
        vm.expectRevert(bytes("LOOSEN_TIMELOCK_SECONDS must be >= 120 s off Anvil (production: 24 h)"));
        script.check(f);
        f.loosenTimelockSeconds = 1;
        vm.expectRevert(bytes("LOOSEN_TIMELOCK_SECONDS must be >= 120 s off Anvil (production: 24 h)"));
        script.check(f);
        f.loosenTimelockSeconds = 120;
        script.check(f);
        f.loosenTimelockSeconds = 24 hours;
        script.check(f);
    }

    /// The cooling floor is DeployLoop's, inherited.
    function test_Revert_CheckFinalConfig_coolingUnder120sOffAnvil() public {
        vm.chainId(SEPOLIA);
        DeployFinal.FinalConfig memory f = _final("sepolia");
        f.observer = address(0);
        f.base.coolingSeconds = 119;
        vm.expectRevert(bytes("COOLING_SECONDS must be >= 120 s off Anvil (production: 24 h)"));
        script.check(f);
    }

    function test_CheckFinalConfig_ShortTimelockAndCoolingAllowedOnAnvil() public {
        DeployFinal.FinalConfig memory f = _final();
        f.loosenTimelockSeconds = 1;
        f.base.coolingSeconds = 1;
        script.check(f);
    }

    /// The 120 s demo timelock is a default on Anvil only.
    function test_Timelock_DefaultsTo120OnAnvilOnly() public {
        assertEq(script.timelock(false, 0), 120);
        assertEq(script.timelock(true, 86_400), 86_400);
        vm.chainId(SEPOLIA);
        assertEq(script.timelock(true, 120), 120);
        vm.expectRevert(bytes("LOOSEN_TIMELOCK_SECONDS must be set explicitly off Anvil"));
        script.timelock(false, 0);
    }

    function test_Revert_Timelock_aboveUint64() public {
        vm.expectRevert();
        script.timelock(true, uint256(type(uint64).max) + 1);
    }

    /// An observer whose key is public could veto every loosening.
    function test_Revert_CheckFinalConfig_observerIsAnAnvilAccountOffAnvil() public {
        vm.chainId(SEPOLIA);
        DeployFinal.FinalConfig memory f = _final("sepolia");
        f.observer = ANVIL_ACCOUNT_6;
        vm.expectRevert(bytes("OBSERVER_ADDRESS must not be an Anvil default account off Anvil"));
        script.check(f);
    }

    /// Audit run-3: the observer's veto must sit on its own key, never the lender's or the oracle's.
    function test_Revert_CheckFinalConfig_observerIsLender() public {
        DeployFinal.FinalConfig memory f = _final();
        f.observer = f.base.lender;
        vm.expectRevert(bytes("OBSERVER_ADDRESS must differ from LENDER_ADDRESS and ORACLE_ADDRESS"));
        script.check(f);
    }

    function test_Revert_CheckFinalConfig_observerIsOracle() public {
        DeployFinal.FinalConfig memory f = _final();
        f.observer = f.base.oracle;
        vm.expectRevert(bytes("OBSERVER_ADDRESS must differ from LENDER_ADDRESS and ORACLE_ADDRESS"));
        script.check(f);
    }

    function test_CheckFinalConfig_NoObserverOnSepolia() public {
        vm.chainId(SEPOLIA);
        DeployFinal.FinalConfig memory f = _final("sepolia");
        f.observer = address(0);
        script.check(f);
    }

    /// DeployLoop's checks are inherited unchanged (here: CHAIN_TAG must name the chain).
    function test_Revert_CheckFinalConfig_inheritsTheLoopChecks() public {
        vm.expectRevert(bytes("CHAIN_TAG must be anvil on chain 31337"));
        script.check(_final("sepolia"));
    }

    function test_Manifest_ListsTheFourContracts() public {
        DeployFinal.FinalConfig memory f = _final();
        DeployFinal.Deployed memory d = script.deployWith(f);
        string memory json = script.manifest(f, d);
        assertEq(vm.parseJsonAddress(json, ".contracts.PlanRegistry.address"), address(d.registry));
        assertEq(vm.parseJsonAddress(json, ".contracts.Treasury.address"), address(d.treasury));
        assertEq(vm.parseJsonAddress(json, ".contracts.MilestoneEscrow.address"), address(d.escrow));
        assertEq(vm.parseJsonAddress(json, ".contracts.SalesOracle.address"), address(d.sales));
        assertEq(vm.parseJsonString(json, ".deploymentId"), "final-1");
        assertEq(vm.parseJsonString(json, ".chainTag"), "anvil");
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonUint(json, ".blockNumber"), 7);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    /// VerifyFinal's expected values for a set deployed with f, on the current chain.
    function _expectedFor(DeployFinal.Deployed memory d, DeployFinal.FinalConfig memory f)
        internal
        view
        returns (VerifyFinal.Expected memory e)
    {
        e.registry = address(d.registry);
        e.treasury = address(d.treasury);
        e.governance = d.treasury.governance();
        e.escrow = address(d.escrow);
        e.salesOracle = address(d.sales);
        e.observer = f.observer;
        e.loosenTimelockSeconds = f.loosenTimelockSeconds;
        e.lender = f.base.lender;
        e.oracle = f.base.oracle;
        e.coolingSeconds = f.base.coolingSeconds;
        e.chainId = block.chainid;
        e.deploymentId = bytes32(bytes(f.base.deploymentId));
        e.chainTag = bytes32(bytes(f.base.chainTag));
        e.fiscoMs = f.base.fiscoMs;
    }

    function _final() internal returns (DeployFinal.FinalConfig memory) {
        return _final("anvil");
    }

    function _final(string memory chainTag) internal returns (DeployFinal.FinalConfig memory f) {
        DeployLoop.Config memory c;
        c.deploymentId = "final-1";
        c.chainTag = chainTag;
        c.lender = makeAddr("lender");
        c.oracle = makeAddr("oracle");
        c.coolingSeconds = 120;
        c.judgingWindowEnd = 1_796_083_199;
        c.platformPayeeLabels = new string[](1);
        c.platformPayeeIds = new bytes32[](1);
        c.platformPayoutHashes = new bytes32[](1);
        (c.platformPayeeLabels[0], c.platformPayeeIds[0], c.platformPayoutHashes[0]) =
        ("lhdn-tax", "lhdn-tax", keccak256("tax-account"));
        f.base = c;
        f.observer = makeAddr("observer");
        f.loosenTimelockSeconds = 120;
    }
}
