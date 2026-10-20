// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DeployLoop} from "../script/DeployLoop.s.sol";
import {DeployFinal} from "../script/DeployFinal.s.sol";
import {VerifyFinal} from "../script/VerifyFinal.s.sol";
import {DeployFinalHarness} from "./DeployFinal.t.sol";

contract VerifyFinalHarness is VerifyFinal {
    function verify(Expected memory e) external view {
        _verify(e);
    }
}

/// VerifyFinal (audit run-3): the read-only post-broadcast check of a final-1 deployment. DeployFinal's _checkLinks
/// runs only in the forge simulation; this reads the five deployed contracts back and asserts code and every link,
/// and (re-check L-2) everything else DeployFinal asserts or was given: chain id, lender, oracle, cooling, deployment
/// id and chain tag, plus the 120 s floors off Anvil.
/// setUp deploys one set and writes the environment with its values: every test starts from the same setUp state, so
/// the addresses (and the environment) are the same in each test. Forge runs suites in parallel in one process, so the
/// environment is shared: LENDER_ADDRESS, ORACLE_ADDRESS, COOLING_SECONDS and CHAIN_TAG values here equal DeployLoopTest's
/// (and its default cooling), and the deployment id is read from EXPECTED_DEPLOYMENT_ID, which no deploy script reads.
contract VerifyFinalTest is Test {
    uint256 internal constant SEPOLIA = 11_155_111;

    DeployFinalHarness internal deployer;
    VerifyFinalHarness internal verifier;
    DeployFinal.Deployed internal d;

    function setUp() public {
        deployer = new DeployFinalHarness();
        verifier = new VerifyFinalHarness();
        d = deployer.deployWith(_final());
        vm.setEnv("REGISTRY_ADDRESS", vm.toString(address(d.registry)));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(address(d.treasury)));
        vm.setEnv("GOVERNANCE_ADDRESS", vm.toString(d.treasury.governance()));
        vm.setEnv("ESCROW_ADDRESS", vm.toString(address(d.escrow)));
        vm.setEnv("SALES_ORACLE_ADDRESS", vm.toString(address(d.sales)));
        vm.setEnv("OBSERVER_ADDRESS", vm.toString(makeAddr("observer")));
        vm.setEnv("LOOSEN_TIMELOCK_SECONDS", "120");
        vm.setEnv("LENDER_ADDRESS", vm.toString(makeAddr("lender")));
        vm.setEnv("ORACLE_ADDRESS", vm.toString(makeAddr("oracle")));
        vm.setEnv("COOLING_SECONDS", "120");
        vm.setEnv("CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("EXPECTED_DEPLOYMENT_ID", "final-1");
        vm.setEnv("EXPECTED_CHAIN_TAG", "anvil");
    }

    /// Deploys locally (setUp) and runs the script as an operator would, from the environment.
    function test_Run_VerifiesALocalDeploymentFromTheEnvironment() public view {
        verifier.run();
    }

    function test_Verify_AcceptsTheDeployedSet() public {
        verifier.verify(_expected());
    }

    function test_Revert_Verify_noCodeAtAnAddress() public {
        VerifyFinal.Expected memory e = _expected();
        e.escrow = makeAddr("not-a-contract");
        vm.expectRevert(bytes("no code at ESCROW_ADDRESS"));
        verifier.verify(e);
    }

    /// A contract from another deployment is never accepted in place of this set's.
    function test_Revert_Verify_escrowOfAnotherDeployment() public {
        DeployFinal.Deployed memory other = deployer.deployWith(_final());
        VerifyFinal.Expected memory e = _expected();
        e.escrow = address(other.escrow);
        vm.expectRevert(bytes("treasury -> escrow link mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_governanceOfAnotherDeployment() public {
        DeployFinal.Deployed memory other = deployer.deployWith(_final());
        VerifyFinal.Expected memory e = _expected();
        e.governance = other.treasury.governance();
        vm.expectRevert(bytes("treasury -> governance link mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_registryOfAnotherDeployment() public {
        DeployFinal.Deployed memory other = deployer.deployWith(_final());
        VerifyFinal.Expected memory e = _expected();
        e.registry = address(other.registry);
        vm.expectRevert(bytes("registry <-> treasury link mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_salesOracleOfAnotherDeployment() public {
        DeployFinal.Deployed memory other = deployer.deployWith(_final());
        VerifyFinal.Expected memory e = _expected();
        e.salesOracle = address(other.sales);
        vm.expectRevert(bytes("treasury -> sales oracle link mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_wrongObserver() public {
        VerifyFinal.Expected memory e = _expected();
        e.observer = address(0);
        vm.expectRevert(bytes("observer mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_wrongTimelock() public {
        VerifyFinal.Expected memory e = _expected();
        e.loosenTimelockSeconds = 24 hours;
        vm.expectRevert(bytes("loosen timelock mismatch"));
        verifier.verify(e);
    }

    // ---- re-check L-2: everything DeployFinal asserts or was given ----

    /// The RPC points at another chain than the manifest's: refused before any other read.
    function test_Revert_Verify_wrongChainId() public {
        VerifyFinal.Expected memory e = _expected();
        e.chainId = SEPOLIA;
        e.escrow = makeAddr("not-a-contract");
        vm.expectRevert(bytes("chain id mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_wrongLender() public {
        VerifyFinal.Expected memory e = _expected();
        e.lender = makeAddr("someone-else");
        vm.expectRevert(bytes("lender mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_wrongOracle() public {
        VerifyFinal.Expected memory e = _expected();
        e.oracle = makeAddr("lender");
        vm.expectRevert(bytes("oracle mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_wrongCoolingSeconds() public {
        VerifyFinal.Expected memory e = _expected();
        e.coolingSeconds = 24 hours;
        vm.expectRevert(bytes("cooling seconds mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_wrongDeploymentId() public {
        VerifyFinal.Expected memory e = _expected();
        e.deploymentId = "final-2";
        vm.expectRevert(bytes("deployment id mismatch"));
        verifier.verify(e);
    }

    function test_Revert_Verify_wrongChainTag() public {
        VerifyFinal.Expected memory e = _expected();
        e.chainTag = "sepolia";
        vm.expectRevert(bytes("chain tag mismatch"));
        verifier.verify(e);
    }

    /// Off chain 31337 the labelled-demo floors apply (DeployFinal refuses less there): 120 s passes.
    function test_Verify_AcceptsTheFloorsOffAnvil() public {
        VerifyFinal.Expected memory e = _expected();
        vm.chainId(SEPOLIA);
        e.chainId = SEPOLIA;
        verifier.verify(e);
    }

    /// A set deployed with Anvil-only short values cannot pass for a chain other than 31337.
    function test_Revert_Verify_coolingBelowTheFloorOffAnvil() public {
        DeployFinal.FinalConfig memory f = _final();
        f.base.coolingSeconds = 119;
        VerifyFinal.Expected memory e = _expectedFor(deployer.deployWith(f), f);
        verifier.verify(e); // fine on Anvil
        vm.chainId(SEPOLIA);
        e.chainId = SEPOLIA;
        vm.expectRevert(bytes("cooling seconds must be >= 120 s off Anvil"));
        verifier.verify(e);
    }

    function test_Revert_Verify_timelockBelowTheFloorOffAnvil() public {
        DeployFinal.FinalConfig memory f = _final();
        f.loosenTimelockSeconds = 119;
        VerifyFinal.Expected memory e = _expectedFor(deployer.deployWith(f), f);
        verifier.verify(e); // fine on Anvil
        vm.chainId(SEPOLIA);
        e.chainId = SEPOLIA;
        vm.expectRevert(bytes("loosen timelock must be >= 120 s off Anvil"));
        verifier.verify(e);
    }

    // ---------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------

    function _expected() internal returns (VerifyFinal.Expected memory) {
        return _expectedFor(d, _final());
    }

    function _expectedFor(DeployFinal.Deployed memory set, DeployFinal.FinalConfig memory f)
        internal
        view
        returns (VerifyFinal.Expected memory e)
    {
        e.registry = address(set.registry);
        e.treasury = address(set.treasury);
        e.governance = set.treasury.governance();
        e.escrow = address(set.escrow);
        e.salesOracle = address(set.sales);
        e.observer = f.observer;
        e.loosenTimelockSeconds = f.loosenTimelockSeconds;
        e.lender = f.base.lender;
        e.oracle = f.base.oracle;
        e.coolingSeconds = f.base.coolingSeconds;
        e.chainId = block.chainid;
        e.deploymentId = bytes32(bytes(f.base.deploymentId));
        e.chainTag = bytes32(bytes(f.base.chainTag));
    }

    function _final() internal returns (DeployFinal.FinalConfig memory f) {
        DeployLoop.Config memory c;
        c.deploymentId = "final-1";
        c.chainTag = "anvil";
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
