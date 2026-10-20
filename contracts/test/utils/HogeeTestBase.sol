// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
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
} from "../../src/interfaces/IHogee.sol";
import {HogeeTypes} from "../../src/interfaces/HogeeTypes.sol";
import {PlanRegistry} from "../../src/PlanRegistry.sol";
import {Treasury} from "../../src/Treasury.sol";
import {SalesOracle} from "../../src/SalesOracle.sol";
import {MilestoneEscrow} from "../../src/MilestoneEscrow.sol";
import {RinaFixture} from "./RinaFixture.sol";
import {TreasuryHarness} from "./TreasuryHarness.sol";
import {TreasuryLinks} from "../../src/HogeeHooks.sol";

/// Deploys a loop-1 pair (PlanRegistry + Treasury) and provides signing helpers over the Rina fixture (§26.2).
/// The test agent replaces RinaFixture.AGENT so tests can sign with the agent key (NotOwner mapping, T2/T6).
abstract contract HogeeTestBase is Test, RinaFixture {
    uint64 internal constant COOLING = 120;
    /// §8.8 demo loosening timelock (120 s, labelled); production is 24 h.
    uint64 internal constant TIMELOCK = 120;
    /// 2026-11-30T23:59:59Z (packages/core JUDGING_WINDOW_END_ISO).
    uint64 internal constant JUDGING_END = 1_796_083_199;
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    bytes32 internal constant L_SUPPLIER = "SUPPLIER";
    bytes32 internal constant L_PACKAGING = "PACKAGING";
    bytes32 internal constant L_LOGISTICS = "LOGISTICS";
    bytes32 internal constant L_ADS = "ADS";
    bytes32 internal constant L_FEES = "PLATFORM_FEES";
    bytes32 internal constant L_CONTINGENCY = "CONTINGENCY";
    bytes32 internal constant P_LOGISTICS = "spx-logistics";
    bytes32 internal constant P_ADS = "shopee-ads";
    bytes32 internal constant P_FEES = "shopee-fees";
    /// Static platform payee for LOOSEN_WITHDRAW_RESERVE (the tax authority's fixed payout account).
    bytes32 internal constant P_TAX = "lhdn-tax";

    PlanRegistry internal registry;
    Treasury internal treasury;
    SalesOracle internal sales;
    MilestoneEscrow internal escrow;
    /// Set by every _deploy; setUp adopts them (other deployments made by a test leave the main set alone).
    SalesOracle internal lastSales;
    MilestoneEscrow internal lastEscrow;

    address internal lender = makeAddr("lender");
    address internal oracle = makeAddr("oracle");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");
    address internal observer = makeAddr("observer");
    address internal founder;
    uint256 internal founderPk;
    address internal agent;
    uint256 internal agentPk;
    uint256 internal lenderPk;

    uint256 private _decisionSeq;

    function setUp() public virtual {
        vm.warp(T0);
        (founder, founderPk) = makeAddrAndKey("founder");
        (agent, agentPk) = makeAddrAndKey("agent");
        (lender, lenderPk) = makeAddrAndKey("lender");
        (registry, treasury) = _deploy(DEPLOYMENT_ID, CHAIN_TAG, false);
        (sales, escrow) = (lastSales, lastEscrow);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Deployment
    // ---------------------------------------------------------------------------------------------------------

    function _deploy(bytes32 deploymentId_, bytes32 chainTag_, bool fiscoMs_)
        internal
        returns (PlanRegistry r, Treasury t)
    {
        uint256 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 1);
        address escrowAt = vm.computeCreateAddress(address(this), nonce + 2);
        address salesAt = vm.computeCreateAddress(address(this), nonce + 3);
        r = new PlanRegistry(lender, predicted, deploymentId_, chainTag_, fiscoMs_, JUDGING_END);
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        t = new Treasury(address(r), oracle, COOLING, _links(escrowAt, salesAt), ids, hashes);
        assertEq(address(t), predicted, "treasury address must match the registry link");
        lastEscrow = new MilestoneEscrow(address(t));
        assertEq(address(lastEscrow), escrowAt, "escrow address must match the treasury link");
        lastSales = new SalesOracle(address(t));
        assertEq(address(lastSales), salesAt, "sales oracle address must match the treasury link");
    }

    /// Treasury constructor links: escrow / sales oracle (0 = loop-1 shape), the observer and the demo timelock.
    function _links(address escrow_, address salesOracle_) internal view returns (TreasuryLinks memory) {
        return TreasuryLinks({
            escrow: escrow_, salesOracle: salesOracle_, observer: observer, loosenTimelockSeconds: TIMELOCK
        });
    }

    /// Same pair with the test-only TreasuryHarness (states loop-1 has no external path to); sets registry/treasury.
    function _deployHarness() internal returns (TreasuryHarness h) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        registry = new PlanRegistry(lender, predicted, DEPLOYMENT_ID, CHAIN_TAG, false, JUDGING_END);
        (bytes32[] memory ids, bytes32[] memory hashes) = _platformPayees();
        h = new TreasuryHarness(address(registry), oracle, COOLING, _links(address(0), address(0)), ids, hashes);
        assertEq(address(h), predicted, "treasury address must match the registry link");
        treasury = h;
    }

    function _platformPayees() internal pure returns (bytes32[] memory ids, bytes32[] memory hashes) {
        ids = new bytes32[](4);
        hashes = new bytes32[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (P_LOGISTICS, P_ADS, P_FEES, P_TAX);
        hashes[0] = keccak256('{"accountNumber":"5550001","channel":"MY_DUITNOW","holderName":"SPX Test"}');
        hashes[1] = keccak256('{"accountNumber":"5550002","channel":"MY_DUITNOW","holderName":"Ads Test"}');
        hashes[2] = keccak256('{"accountNumber":"5550003","channel":"MY_DUITNOW","holderName":"Fees Test"}');
        hashes[3] = keccak256('{"accountNumber":"5550004","channel":"MY_DUITNOW","holderName":"Tax Test"}');
    }

    // ---------------------------------------------------------------------------------------------------------
    // Rina flow
    // ---------------------------------------------------------------------------------------------------------

    function _openFacility() internal {
        vm.prank(lender);
        treasury.openFacility(1_000_000, 300);
    }

    function _registerFounder() internal {
        vm.prank(lender);
        registry.registerFounderKey(bytes32(0), bytes32(0), founder);
    }

    /// RinaFixture._planApproval() with the test agent.
    function _rinaApproval() internal view returns (PlanApproval memory a) {
        a = _planApproval();
        a.agent = agent;
    }

    function _commit(PlanApproval memory a, Line[] memory lines, Stage[] memory stages) internal {
        Sig memory sig = _signPlan(a);
        vm.prank(relayer);
        registry.commitPlan(a, lines, stages, sig);
    }

    /// Facility opened, founder key registered, Rina plan v1 committed, 1,000,000 funded (400,000 released).
    function _setUpRina() internal {
        _openFacility();
        _registerFounder();
        _commit(_rinaApproval(), _lines(), _stages());
        vm.prank(lender);
        treasury.fund(1_000_000);
    }

    /// Plan v2 from v1: same lines/stages unless replaced; nonce 100+version.
    function _approvalV2(Line[] memory lines, Stage[] memory stages) internal view returns (PlanApproval memory a) {
        a = _rinaApproval();
        a.version = 2;
        a.prevPlanHash = a.planHash;
        a.planHash = keccak256("hogee/test/plan-v2");
        a.linesHash = HogeeTypes.hashLines(lines);
        a.stagesHash = HogeeTypes.hashStages(stages);
        a.nonce = 102;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Signing
    // ---------------------------------------------------------------------------------------------------------

    function _planDigest(PlanApproval memory a) internal view returns (bytes32) {
        return HogeeTypes.digest(registry.domainSeparator(), HogeeTypes.hashPlanApproval(a));
    }

    function _supplierDigest(SupplierApproval memory a) internal view returns (bytes32) {
        return HogeeTypes.digest(treasury.domainSeparator(), HogeeTypes.hashSupplierApproval(a));
    }

    function _signPlan(PlanApproval memory a) internal view returns (Sig memory) {
        return _ecdsa(founderPk, _planDigest(a));
    }

    function _signSupplier(SupplierApproval memory a) internal view returns (Sig memory) {
        return _ecdsa(founderPk, _supplierDigest(a));
    }

    function _treasuryDigest(bytes32 structHash) internal view returns (bytes32) {
        return HogeeTypes.digest(treasury.domainSeparator(), structHash);
    }

    function _signStage(uint256 pk, StageRelease memory r) internal view returns (Sig memory) {
        return _ecdsa(pk, _treasuryDigest(HogeeTypes.hashStageRelease(r)));
    }

    function _signOwnerSpend(uint256 pk, OwnerSpend memory r) internal view returns (Sig memory) {
        return _ecdsa(pk, _treasuryDigest(HogeeTypes.hashOwnerSpend(r)));
    }

    function _signLoosen(uint256 pk, LoosenRequest memory r) internal view returns (Sig memory) {
        return _ecdsa(pk, _treasuryDigest(HogeeTypes.hashLoosenRequest(r)));
    }

    function _ecdsa(uint256 pk, bytes32 digest) internal pure returns (Sig memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return Sig({kind: HogeeKinds.SIG_ECDSA, data: abi.encodePacked(r, s, v)});
    }

    /// A WebAuthn assertion over `digest` (challenge = base64url of the raw 32 bytes), UP|UV set, low-s.
    /// `flat` = OZ's flat tuple; otherwise Solidity abi.encode(struct) with the leading offset word.
    function _webauthn(uint256 p256Pk, bytes32 digest, bytes1 flags, bool flat) internal pure returns (Sig memory) {
        bytes memory authData = abi.encodePacked(sha256("localhost"), flags, bytes4(0));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost:3000","crossOrigin":false}'
        );
        bytes32 h = sha256(abi.encodePacked(authData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(p256Pk, h);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        bytes memory data = abi.encode(r, s, uint256(23), uint256(1), authData, clientDataJSON);
        if (!flat) data = bytes.concat(bytes32(uint256(0x20)), data);
        return Sig({kind: HogeeKinds.SIG_WEBAUTHN, data: data});
    }

    // ---------------------------------------------------------------------------------------------------------
    // Supplier approval
    // ---------------------------------------------------------------------------------------------------------

    /// RinaFixture._supplierApproval() with a fresh expiry relative to now.
    function _supplier() internal view returns (SupplierApproval memory a) {
        a = _supplierApproval();
        a.expiry = uint64(block.timestamp) + DAY;
    }

    function _bindSupplier(SupplierApproval memory a) internal {
        (uint128[] memory schedule, bool[] memory autoRelease) = _schedule();
        treasury.bindPayee(a, schedule, autoRelease, _signSupplier(a));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Escrow (supplier A, §26.2)
    // ---------------------------------------------------------------------------------------------------------

    /// Rina + supplier A bound (SupplierApproval signed by the founder) and its cooling period over.
    function _setUpSupplierA() internal {
        _setUpRina();
        _bindSupplier(_supplier());
        vm.warp(block.timestamp + COOLING);
    }

    function _fund(uint8 idx, uint128 amount) internal {
        bytes32 d = _nextDecision();
        vm.prank(agent);
        escrow.fundMilestone(ORDER_A, idx, amount, d, keccak256(abi.encode(d)));
    }

    /// Supplier A's balance (idx 2): needs stage 2, so sales 200,000, the lender's release, sample and deposit.
    function _fundBalanceA() internal {
        _fund(0, 30_000);
        _fund(1, 120_000);
        _releaseStage2();
        _fund(2, 280_000);
    }

    /// RinaFixture._milestoneRelease() with a fresh expiry relative to now.
    function _release2() internal view returns (MilestoneRelease memory r) {
        r = _milestoneRelease();
        r.expiry = uint64(block.timestamp) + DAY;
    }

    function _signRelease(uint256 pk, MilestoneRelease memory r) internal view returns (Sig memory) {
        return _ecdsa(pk, HogeeTypes.digest(escrow.domainSeparator(), HogeeTypes.hashMilestoneRelease(r)));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Sales and stages
    // ---------------------------------------------------------------------------------------------------------

    function _recordSale(uint256 n, uint128 amountMinor) internal {
        vm.prank(oracle);
        sales.recordSale(keccak256(abi.encode("hogee/test/sale", n)), amountMinor);
    }

    /// RinaFixture._stageRelease() with a fresh expiry relative to now.
    function _stage2() internal view returns (StageRelease memory r) {
        r = _stageRelease();
        r.expiry = uint64(block.timestamp) + DAY;
    }

    /// Records the stage-2 gate (200,000 of sales) and the lender releases stage 2 (600,000).
    function _releaseStage2() internal {
        _recordSale(9001, 200_000);
        StageRelease memory r = _stage2();
        treasury.releaseStage(r, _signStage(lenderPk, r));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Loosening (founder + lender co-signed, then the timelock)
    // ---------------------------------------------------------------------------------------------------------

    function _loosen(uint8 kind, bytes32 target, bytes32 aux, uint256 newValue, uint256 nonce)
        internal
        view
        returns (LoosenRequest memory)
    {
        return LoosenRequest(kind, target, aux, newValue, DEPLOYMENT_ID, nonce, uint64(block.timestamp) + DAY);
    }

    function _queue(LoosenRequest memory r) internal returns (bytes32 loosenId) {
        Sig memory f = _signLoosen(founderPk, r);
        Sig memory l = _signLoosen(lenderPk, r);
        vm.prank(relayer);
        loosenId = treasury.queueLoosen(r, f, l);
    }

    /// Queues `r`, waits out the timelock and executes it (anyone may execute).
    function _queueAndExecute(LoosenRequest memory r) internal returns (bytes32 loosenId) {
        loosenId = _queue(r);
        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(stranger);
        treasury.executeLoosen(loosenId);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Agent calls
    // ---------------------------------------------------------------------------------------------------------

    function _nextDecision() internal returns (bytes32) {
        return bytes32(++_decisionSeq);
    }

    function _spend(bytes32 lineId, bytes32 payeeId, uint128 amount, bytes32 invoiceHash) internal returns (bytes32) {
        bytes32 d = _nextDecision();
        uint32 version = registry.planVersion(); // read before the prank: the prank applies to the next call
        vm.prank(agent);
        return treasury.spend(lineId, payeeId, amount, invoiceHash, version, d, keccak256(abi.encode(d)));
    }

    function _spendAds(uint64 slot, uint128 amount) internal returns (bytes32) {
        return _spend(L_ADS, P_ADS, amount, bytes32(uint256(slot)));
    }

    function _invoice(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("hogee/test/invoice", n));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Plan builders
    // ---------------------------------------------------------------------------------------------------------

    function _copyLines() internal pure returns (Line[] memory) {
        return _lines();
    }

    function _lineIndex(Line[] memory lines, bytes32 id) internal pure returns (uint256) {
        for (uint256 i; i < lines.length; ++i) {
            if (lines[i].lineId == id) return i;
        }
        revert("line not found");
    }

    function _approvalFor(Line[] memory lines, Stage[] memory stages) internal view returns (PlanApproval memory a) {
        a = _rinaApproval();
        a.linesHash = HogeeTypes.hashLines(lines);
        a.stagesHash = HogeeTypes.hashStages(stages);
    }
}
