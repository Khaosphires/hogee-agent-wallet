// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, console2} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PlanApproval, Line, LoosenRequest, SupplierApproval, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {HogeeTypes} from "../src/interfaces/HogeeTypes.sol";
import {IHogeeErrors, IHogeeEvents} from "../src/interfaces/IHogeeBase.sol";
import {RinaFixture} from "./utils/RinaFixture.sol";

/// EIP-712 layout for the frozen interface (G0). The golden constants below are ALSO asserted with viem in
/// packages/chain/test/eip712.test.ts: if both pass, Solidity and TypeScript agree byte for byte.
/// To regenerate after a deliberate struct change: `forge test --match-test test_printGoldenValues -vv`.
/// G0-REVIEW (M15): ShortId fixture ids and payoutAccountHash; linesHash/stagesHash are the Rina manifest goldens
/// (vitest derives the same values with manifestToLines/manifestToStages).
contract HogeeTypesTest is Test, RinaFixture {
    bytes32 internal constant GOLDEN_SALT = 0xad2cf874712553c65a450322ecd5a8d900f5996d2fa7624cb6e05668b21a793c;
    bytes32 internal constant GOLDEN_DOMAIN_REGISTRY =
        0x365a0a5b776039b83db0c0ef7371264aecf3c2a039679bdfba84e78376ce60dd;
    bytes32 internal constant GOLDEN_DOMAIN_TREASURY =
        0xab00f13d53fa343cd9e9cd41cd2edc10c79ae022a2114b63c54f5f1aa675e583;
    bytes32 internal constant GOLDEN_DOMAIN_ESCROW = 0x37c2c93b67aaa67013d81d04c22d146a6e03de68ba34a59d61301c3b43191f98;
    bytes32 internal constant GOLDEN_LINES_HASH = 0xf107f98a529a7babf40d18450be14ad9a7d9be6c882bb6611b43de466b217b7f;
    bytes32 internal constant GOLDEN_STAGES_HASH = 0x229235b75cedf075cfab4a7f865757c64ccd87de48f1f98feb38b64bb024acc5;
    // G0-REVIEW (M7): keccak256 of SUPPLIER_A_ACCOUNT_JCS.
    bytes32 internal constant GOLDEN_PAYOUT_ACCOUNT_HASH =
        0x142ad066e84bde38bc37aadb3976a708f96b660bb1bed323a05cbf7c42191ccc;
    bytes32 internal constant GOLDEN_SCHEDULE_HASH = 0xfea3a9bb8d64835cd5740fcb968598cea369fe43fe8b3bd67efcf2cda1b83e69;

    bytes32 internal constant GOLDEN_PLAN_APPROVAL_DIGEST =
        0xc74fa2a0af3ae20fb8f15e3a27954f26f64cc22779f5ba03ada026b801a41cb3;
    bytes32 internal constant GOLDEN_SUPPLIER_APPROVAL_DIGEST =
        0xf3c90db36bafd47db3d31119da579aebcd43c8724d1e69bc9a7b431927094875;
    bytes32 internal constant GOLDEN_MILESTONE_RELEASE_DIGEST =
        0x2a322e076faa2d58edc0e1cf5cae4cd369c9bcd555622e3462ba87014c448dff;
    bytes32 internal constant GOLDEN_LOOSEN_REQUEST_DIGEST =
        0x4d69b63a7f2af0bf050fb4d70b0ef6841628ed5929da7cd3d8da768f85412413;
    bytes32 internal constant GOLDEN_STAGE_RELEASE_DIGEST =
        0x70334df2c0429d708921a10829d15a261f37cbba1cea1efeab9b329271743ea2;
    bytes32 internal constant GOLDEN_OWNER_SPEND_DIGEST =
        0x43948dc926605ec391b015c6e558d28808062904fcaf8380563a41cc687b1d1a;

    bytes32 internal constant GOLDEN_LOOSEN_ID = 0x7bee358064686cb5a144cfaf3c85196442266401c9ccd433cb17a84b7e72afc5;
    bytes32 internal constant GOLDEN_INTENT_ID = 0x5c14ef8802a3b69ac9f5ad728717d9d3adf7c6f729e79f35f4eb7bf751ee9bfd;
    bytes32 internal constant GOLDEN_MILESTONE_SETTLEMENT_ID =
        0x04e6c326322fd125ad3a52cff712548a8afbb63c23e9d5917dba83e213ed9888;

    // ---- typehashes ----

    function test_TypehashesEqualKeccakOfTypeStrings() public pure {
        assertEq(HogeeTypes.EIP712_DOMAIN_TYPEHASH, keccak256(bytes(HogeeTypes.EIP712_DOMAIN_TYPE)));
        assertEq(HogeeTypes.PLAN_APPROVAL_TYPEHASH, keccak256(bytes(HogeeTypes.PLAN_APPROVAL_TYPE)));
        assertEq(HogeeTypes.SUPPLIER_APPROVAL_TYPEHASH, keccak256(bytes(HogeeTypes.SUPPLIER_APPROVAL_TYPE)));
        assertEq(HogeeTypes.MILESTONE_RELEASE_TYPEHASH, keccak256(bytes(HogeeTypes.MILESTONE_RELEASE_TYPE)));
        assertEq(HogeeTypes.LOOSEN_REQUEST_TYPEHASH, keccak256(bytes(HogeeTypes.LOOSEN_REQUEST_TYPE)));
        assertEq(HogeeTypes.STAGE_RELEASE_TYPEHASH, keccak256(bytes(HogeeTypes.STAGE_RELEASE_TYPE)));
        assertEq(HogeeTypes.OWNER_SPEND_TYPEHASH, keccak256(bytes(HogeeTypes.OWNER_SPEND_TYPE)));
    }

    function test_DomainTypeHasNoChainId() public pure {
        assertEq(
            HogeeTypes.EIP712_DOMAIN_TYPE,
            "EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)"
        );
    }

    // ---- domain ----

    function test_GoldenDomainSeparators() public pure {
        assertEq(HogeeTypes.domainSalt(CHAIN_TAG, DEPLOYMENT_ID), GOLDEN_SALT);
        assertEq(HogeeTypes.domainSeparator(PLAN_REGISTRY, CHAIN_TAG, DEPLOYMENT_ID), GOLDEN_DOMAIN_REGISTRY);
        assertEq(HogeeTypes.domainSeparator(TREASURY, CHAIN_TAG, DEPLOYMENT_ID), GOLDEN_DOMAIN_TREASURY);
        assertEq(HogeeTypes.domainSeparator(ESCROW, CHAIN_TAG, DEPLOYMENT_ID), GOLDEN_DOMAIN_ESCROW);
    }

    function test_DomainSeparatorMatchesHandEncoding() public pure {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)"),
                keccak256("Hogee"),
                keccak256("1"),
                PLAN_REGISTRY,
                keccak256(abi.encode(CHAIN_TAG, DEPLOYMENT_ID))
            )
        );
        assertEq(HogeeTypes.domainSeparator(PLAN_REGISTRY, CHAIN_TAG, DEPLOYMENT_ID), expected);
    }

    /// T28: a signature for one chain or deployment never verifies on another.
    function testFuzz_DomainBindsChainTagAndDeployment(bytes32 chainTag, bytes32 deploymentId) public pure {
        vm.assume(chainTag != CHAIN_TAG || deploymentId != DEPLOYMENT_ID);
        assertTrue(HogeeTypes.domainSeparator(PLAN_REGISTRY, chainTag, deploymentId) != GOLDEN_DOMAIN_REGISTRY);
    }

    // ---- commitments ----

    /// G0-REVIEW (M15): the Rina PlanManifest lines/stages (§26.2) hash to the same values vitest derives from
    /// the manifest with manifestToLines / manifestToStages.
    function test_GoldenManifestLinesAndStagesHash() public pure {
        assertEq(HogeeTypes.hashLines(_lines()), GOLDEN_LINES_HASH);
        assertEq(HogeeTypes.hashStages(_stages()), GOLDEN_STAGES_HASH);
        assertEq(_planApproval().linesHash, GOLDEN_LINES_HASH);
        assertEq(_planApproval().stagesHash, GOLDEN_STAGES_HASH);
    }

    function test_GoldenPayoutAccountHashIsSigned() public pure {
        assertEq(keccak256(bytes(SUPPLIER_A_ACCOUNT_JCS)), GOLDEN_PAYOUT_ACCOUNT_HASH);
        SupplierApproval memory a = _supplierApproval();
        assertEq(a.payoutAccountHash, GOLDEN_PAYOUT_ACCOUNT_HASH);
        bytes32 baseline = HogeeTypes.hashSupplierApproval(a);
        a.payoutAccountHash = keccak256("attacker account"); // T1: a changed bank destination breaks the signature
        assertTrue(HogeeTypes.hashSupplierApproval(a) != baseline);
    }

    function test_RequiresLenderForEveryLoosenKind() public pure {
        for (uint8 k = HogeeKinds.LOOSEN_RAISE_PER_TX_CAP; k <= HogeeKinds.LOOSEN_WITHDRAW_RESERVE; k++) {
            assertTrue(HogeeKinds.requiresLender(k));
        }
        assertTrue(HogeeKinds.requiresLender(0));
        assertTrue(HogeeKinds.requiresLender(type(uint8).max));
    }

    /// G0-REVIEW: pins the signatures of the new and changed errors/events (selectors are part of the freeze).
    function test_ReviewErrorAndEventSignatures() public pure {
        assertEq(IHogeeErrors.FounderKeyAlreadySet.selector, bytes4(keccak256("FounderKeyAlreadySet()")));
        assertEq(IHogeeErrors.MissingDecision.selector, bytes4(keccak256("MissingDecision()")));
        assertEq(IHogeeErrors.SettlementClosed.selector, bytes4(keccak256("SettlementClosed()")));
        assertEq(IHogeeErrors.EscrowOnly.selector, bytes4(keccak256("EscrowOnly()")));
        assertEq(
            IHogeeEvents.OwnerSpent.selector, keccak256("OwnerSpent(bytes32,bytes32,bytes32,uint128,bytes32,uint32)")
        );
        assertEq(IHogeeEvents.ReserveWithdrawn.selector, keccak256("ReserveWithdrawn(bytes32,bytes32,uint128)"));
        assertEq(
            IHogeeEvents.Spent.selector,
            keccak256("Spent(bytes32,bytes32,bytes32,uint128,bytes32,bytes32,bytes32,uint32)")
        );
        assertEq(
            IHogeeEvents.PlanCommitted.selector,
            keccak256(
                "PlanCommitted(bytes32,uint32,bytes32,bytes32,bytes32,uint128,address,uint64,uint128,bytes32,bytes32,uint16)"
            )
        );
        assertEq(
            IHogeeEvents.PayeeBound.selector,
            keccak256("PayeeBound(bytes32,bytes32,bytes32,uint64,uint128,bytes32,bytes32,bytes32)")
        );
    }

    function test_GoldenCommitments() public pure {
        assertEq(HogeeTypes.hashLines(_lines()), GOLDEN_LINES_HASH);
        assertEq(HogeeTypes.hashStages(_stages()), GOLDEN_STAGES_HASH);
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        assertEq(HogeeTypes.scheduleHash(schedule, autoRelease), GOLDEN_SCHEDULE_HASH);
        assertEq(HogeeTypes.hashLoosenRequest(_loosenRequest()), GOLDEN_LOOSEN_ID);
        assertEq(HogeeTypes.intentId(PLAN_ID, "ADS", "shopee-ads", bytes32(uint256(1)), 10_000), GOLDEN_INTENT_ID);
        assertEq(HogeeTypes.milestoneSettlementId(ORDER_A, 2), GOLDEN_MILESTONE_SETTLEMENT_ID);
    }

    /// Changing any line field changes linesHash, so the founder signature covers the commitPlan calldata (T27).
    function test_LinesHashCoversCalldata() public pure {
        Line[] memory lines = _lines();
        bytes32 baseline = HogeeTypes.hashLines(lines);
        assertEq(_planApproval().linesHash, baseline);

        bytes32[] memory swapped = new bytes32[](1);
        swapped[0] = "attacker";
        lines[3].payeeIds = swapped;
        assertTrue(HogeeTypes.hashLines(lines) != baseline);

        lines = _lines();
        lines[0].escrowOnly = false;
        assertTrue(HogeeTypes.hashLines(lines) != baseline);
    }

    // ---- digests ----

    function test_GoldenPlanApprovalDigest() public pure {
        bytes32 domain = HogeeTypes.domainSeparator(PLAN_REGISTRY, CHAIN_TAG, DEPLOYMENT_ID);
        assertEq(HogeeTypes.digest(domain, HogeeTypes.hashPlanApproval(_planApproval())), GOLDEN_PLAN_APPROVAL_DIGEST);
    }

    /// abi.encode(TYPEHASH, struct) must equal the field-by-field EIP-712 encodeData.
    function test_PlanApprovalStructHashMatchesFieldEncoding() public pure {
        PlanApproval memory a = _planApproval();
        bytes memory head = abi.encode(
            HogeeTypes.PLAN_APPROVAL_TYPEHASH, a.planId, a.version, a.prevPlanHash, a.planHash, a.countryPackHash
        );
        bytes memory mid = abi.encode(a.linesHash, a.stagesHash, a.totalMinor, a.reserveBps, a.agent);
        bytes memory tail = abi.encode(a.agentExpiry, a.deploymentId, a.nonce, a.expiry);
        assertEq(HogeeTypes.hashPlanApproval(a), keccak256(bytes.concat(head, mid, tail)));
    }

    function test_GoldenOtherDigests() public pure {
        bytes32 t = HogeeTypes.domainSeparator(TREASURY, CHAIN_TAG, DEPLOYMENT_ID);
        bytes32 e = HogeeTypes.domainSeparator(ESCROW, CHAIN_TAG, DEPLOYMENT_ID);
        assertEq(
            HogeeTypes.digest(t, HogeeTypes.hashSupplierApproval(_supplierApproval())), GOLDEN_SUPPLIER_APPROVAL_DIGEST
        );
        assertEq(
            HogeeTypes.digest(e, HogeeTypes.hashMilestoneRelease(_milestoneRelease())), GOLDEN_MILESTONE_RELEASE_DIGEST
        );
        assertEq(HogeeTypes.digest(t, HogeeTypes.hashLoosenRequest(_loosenRequest())), GOLDEN_LOOSEN_REQUEST_DIGEST);
        assertEq(HogeeTypes.digest(t, HogeeTypes.hashStageRelease(_stageRelease())), GOLDEN_STAGE_RELEASE_DIGEST);
        assertEq(HogeeTypes.digest(t, HogeeTypes.hashOwnerSpend(_ownerSpend())), GOLDEN_OWNER_SPEND_DIGEST);
    }

    function test_LoosenRequestAuxIsSigned() public pure {
        LoosenRequest memory r = _loosenRequest();
        bytes32 baseline = HogeeTypes.hashLoosenRequest(r);
        r.aux = "PACKAGING";
        assertTrue(HogeeTypes.hashLoosenRequest(r) != baseline);
        assertEq(_loosenRequest().kind, HogeeKinds.LOOSEN_MOVE_POCKETS);
    }

    /// The golden digest is what a founder's EOA (MetaMask signTypedData_v4) signs; ECDSA recovers it.
    function test_EcdsaSignatureOverGoldenDigestRecovers() public {
        (address founder, uint256 pk) = makeAddrAndKey("founder");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, GOLDEN_PLAN_APPROVAL_DIGEST);
        assertEq(ECDSA.recover(GOLDEN_PLAN_APPROVAL_DIGEST, abi.encodePacked(r, s, v)), founder);
    }

    // ---- regeneration helper ----

    function test_printGoldenValues() public pure {
        bytes32 reg = HogeeTypes.domainSeparator(PLAN_REGISTRY, CHAIN_TAG, DEPLOYMENT_ID);
        bytes32 t = HogeeTypes.domainSeparator(TREASURY, CHAIN_TAG, DEPLOYMENT_ID);
        bytes32 e = HogeeTypes.domainSeparator(ESCROW, CHAIN_TAG, DEPLOYMENT_ID);
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        console2.log("salt, domains (registry, treasury, escrow):");
        console2.logBytes32(HogeeTypes.domainSalt(CHAIN_TAG, DEPLOYMENT_ID));
        console2.logBytes32(reg);
        console2.logBytes32(t);
        console2.logBytes32(e);
        console2.log("linesHash, stagesHash, scheduleHash, payoutAccountHash:");
        console2.logBytes32(HogeeTypes.hashLines(_lines()));
        console2.logBytes32(HogeeTypes.hashStages(_stages()));
        console2.logBytes32(HogeeTypes.scheduleHash(schedule, autoRelease));
        console2.logBytes32(keccak256(bytes(SUPPLIER_A_ACCOUNT_JCS)));
        console2.log("digests: plan, supplier, milestone, loosen, stage, ownerSpend:");
        console2.logBytes32(HogeeTypes.digest(reg, HogeeTypes.hashPlanApproval(_planApproval())));
        console2.logBytes32(HogeeTypes.digest(t, HogeeTypes.hashSupplierApproval(_supplierApproval())));
        console2.logBytes32(HogeeTypes.digest(e, HogeeTypes.hashMilestoneRelease(_milestoneRelease())));
        console2.logBytes32(HogeeTypes.digest(t, HogeeTypes.hashLoosenRequest(_loosenRequest())));
        console2.logBytes32(HogeeTypes.digest(t, HogeeTypes.hashStageRelease(_stageRelease())));
        console2.logBytes32(HogeeTypes.digest(t, HogeeTypes.hashOwnerSpend(_ownerSpend())));
        console2.log("loosenId, intentId, milestoneSettlementId:");
        console2.logBytes32(HogeeTypes.hashLoosenRequest(_loosenRequest()));
        console2.logBytes32(HogeeTypes.intentId(PLAN_ID, "ADS", "shopee-ads", bytes32(uint256(1)), 10_000));
        console2.logBytes32(HogeeTypes.milestoneSettlementId(ORDER_A, 2));
    }
}
