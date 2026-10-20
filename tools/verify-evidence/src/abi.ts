/**
 * The events and calls the verifier decodes, written from contracts/src/interfaces/IHogeeBase.sol and IHogee.sol
 * (packages/api's evidence tests assert they equal @hogee/chain's generated ABI, names and indexed flags included).
 */
import { parseAbi } from "viem";

export const hogeeEventsAbi = parseAbi([
  "event FacilityOpened(address indexed lender, uint128 capMinor, uint16 reserveFloorBps)",
  "event FounderKeyRegistered(address indexed ownerEOA, bytes32 qx, bytes32 qy)",
  "event PlanCommitted(bytes32 indexed planId, uint32 indexed version, bytes32 planHash, bytes32 prevPlanHash, bytes32 countryPackHash, uint128 totalMinor, address agent, uint64 agentExpiry, uint128 releasedMinor, bytes32 linesHash, bytes32 stagesHash, uint16 reserveBps)",
  "event Funded(uint128 amountMinor, uint128 fundedTotalMinor)",
  "event PayeeBound(bytes32 indexed payeeId, bytes32 indexed lineId, bytes32 indexed orderId, uint64 coolingUntil, uint128 lifetimeCapMinor, bytes32 supplierId, bytes32 scheduleHash, bytes32 payoutAccountHash)",
  "event Spent(bytes32 indexed spendId, bytes32 indexed lineId, bytes32 indexed payeeId, uint128 amountMinor, bytes32 invoiceHash, bytes32 decisionId, bytes32 rationaleHash, uint32 planVersion)",
  "event OwnerSpent(bytes32 indexed spendId, bytes32 indexed lineId, bytes32 indexed payeeId, uint128 amountMinor, bytes32 invoiceHash, uint32 planVersion)",
  "event RevenueRecorded(bytes32 indexed saleIdHash, uint128 amountMinor, uint128 revenueTotalMinor)",
  "event MilestoneFunded(bytes32 indexed orderId, uint8 indexed idx, uint128 amountMinor, uint128 fundedTotalMinor, bytes32 decisionId, bytes32 rationaleHash)",
  "event MilestoneReleased(bytes32 indexed orderId, uint8 indexed idx, bytes32 indexed payeeId, uint128 amountMinor, bytes32 evidenceHash, bytes32 settlementId)",
  "event SaleRecorded(bytes32 indexed saleIdHash, uint128 amountBucket)",
  "event ReserveSkimmed(bytes32 indexed saleIdHash, uint128 amountMinor, uint128 reserveTotalMinor)",
  "event ReserveWithdrawn(bytes32 indexed settlementId, bytes32 indexed taxPayeeId, uint128 amountMinor)",
  "event Tightened(uint8 indexed kind, bytes32 indexed target, address indexed by, uint256 oldValue, uint256 newValue, bytes32 decisionId)",
  "event LoosenQueued(bytes32 indexed loosenId, uint8 indexed kind, bytes32 target, bytes32 aux, uint256 newValue, uint64 executableAt, uint64 expiresAt)",
  "event LoosenExecuted(bytes32 indexed loosenId, uint8 indexed kind)",
  "event LoosenCancelled(bytes32 indexed loosenId, address indexed by)",
  "event StageReleased(bytes32 indexed stageId, uint128 amountMinor, uint128 releasedTotalMinor)",
  "event Denied(bytes32 indexed decisionId, bytes32 indexed lineId, bytes32 indexed reasonCode, bytes32 proposalHash, uint8 lineDenials)",
  "event TreasuryPaused(bytes32 indexed lineId, address indexed by)",
  "event Unpaused(bytes32 indexed lineId, address indexed by)",
  "event CircuitTripped(bytes32 indexed lineId, uint8 denials)",
  "event SettlementConfirmed(bytes32 indexed settlementId, bytes32 payoutRefHash)",
  "event SettlementFailed(bytes32 indexed settlementId, bytes32 code)",
]);

/** Every state-changing call of the four contracts (selectors decide which contract function a signed tx made). */
export const hogeeCallsAbi = parseAbi([
  "struct PlanApproval { bytes32 planId; uint32 version; bytes32 prevPlanHash; bytes32 planHash; bytes32 countryPackHash; bytes32 linesHash; bytes32 stagesHash; uint128 totalMinor; uint16 reserveBps; address agent; uint64 agentExpiry; bytes32 deploymentId; uint256 nonce; uint64 expiry; }",
  "struct Line { bytes32 lineId; uint128 amountMinor; uint128 perTxCapMinor; uint128 windowCapMinor; uint32 windowSeconds; uint64 validUntil; uint128 pacingMinor; bool escrowOnly; bytes32[] payeeIds; }",
  "struct Stage { bytes32 stageId; uint128 releaseMinor; uint8 metric; uint128 target; uint64 deadline; }",
  "struct Sig { uint8 kind; bytes data; }",
  "struct SupplierApproval { bytes32 orderId; bytes32 supplierId; bytes32 payee; bytes32 payoutAccountHash; bytes32 lineId; bytes32 scheduleHash; uint128 totalMinor; bytes32 quoteHash; bytes32 shortlistHash; uint8 chosenIndex; bool inspectionRequired; bytes32 deploymentId; uint256 nonce; uint64 expiry; }",
  "struct OwnerSpend { bytes32 lineId; bytes32 payeeId; uint128 amountMinor; bytes32 invoiceHash; bytes32 deploymentId; uint256 nonce; uint64 expiry; }",
  "struct LoosenRequest { uint8 kind; bytes32 target; bytes32 aux; uint256 newValue; bytes32 deploymentId; uint256 nonce; uint64 expiry; }",
  "struct StageRelease { bytes32 stageId; uint128 amountMinor; bytes32 deploymentId; uint256 nonce; uint64 expiry; }",
  "struct MilestoneRelease { bytes32 orderId; uint8 idx; uint128 amountMinor; bytes32 evidenceHash; bytes32 deploymentId; uint256 nonce; uint64 expiry; }",
  // PlanRegistry
  "function commitPlan(PlanApproval approval, Line[] lines, Stage[] stages, Sig founder)",
  "function registerFounderKey(bytes32 qx, bytes32 qy, address ownerEOA)",
  // Treasury
  "function spend(bytes32 lineId, bytes32 payeeId, uint128 amountMinor, bytes32 invoiceHash, uint32 planVersion, bytes32 decisionId, bytes32 rationaleHash) returns (bytes32 spendId)",
  "function bindPayee(SupplierApproval a, uint128[] schedule, bool[] autoRelease, Sig founder)",
  "function cancelLoosen(bytes32 loosenId)",
  "function confirmSettlement(bytes32 settlementId, bytes32 payoutRefHash)",
  "function executeLoosen(bytes32 loosenId)",
  "function failSettlement(bytes32 settlementId, bytes32 code)",
  "function fund(uint128 amountMinor)",
  "function openFacility(uint128 capMinor, uint16 reserveFloorBps)",
  "function ownerSpend(OwnerSpend req, Sig founder) returns (bytes32 spendId)",
  "function pause()",
  "function queueLoosen(LoosenRequest req, Sig founder, Sig lender) returns (bytes32 loosenId)",
  "function recordDenied(bytes32 lineId, bytes32 decisionId, bytes32 reasonCode, bytes32 proposalHash)",
  "function releaseStage(StageRelease req, Sig lender)",
  "function tighten(uint8 kind, bytes32 target, uint256 newValue, bytes32 decisionId)",
  // MilestoneEscrow
  "function fundMilestone(bytes32 orderId, uint8 idx, uint128 amountMinor, bytes32 decisionId, bytes32 rationaleHash)",
  "function releaseMilestone(MilestoneRelease release, Sig founder)",
  // SalesOracle
  "function recordSale(bytes32 saleIdHash, uint128 amountBucket)",
]);

/** The contract each call belongs to (a selector sent to another deployment contract is not that call). */
export const CALL_CONTRACT: Readonly<Record<string, "PlanRegistry" | "Treasury" | "MilestoneEscrow" | "SalesOracle">> = {
  commitPlan: "PlanRegistry",
  registerFounderKey: "PlanRegistry",
  spend: "Treasury",
  bindPayee: "Treasury",
  cancelLoosen: "Treasury",
  confirmSettlement: "Treasury",
  executeLoosen: "Treasury",
  failSettlement: "Treasury",
  fund: "Treasury",
  openFacility: "Treasury",
  ownerSpend: "Treasury",
  pause: "Treasury",
  queueLoosen: "Treasury",
  recordDenied: "Treasury",
  releaseStage: "Treasury",
  tighten: "Treasury",
  fundMilestone: "MilestoneEscrow",
  releaseMilestone: "MilestoneEscrow",
  recordSale: "SalesOracle",
};

/** abi.encode(WebAuthn.WebAuthnAuth): the Sig.data of a passkey signature (kind 1). */
export const webAuthnAuthParams = [
  {
    type: "tuple",
    components: [
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
      { name: "challengeIndex", type: "uint256" },
      { name: "typeIndex", type: "uint256" },
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "string" },
    ],
  },
] as const;
