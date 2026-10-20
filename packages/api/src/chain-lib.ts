/**
 * The parts of @hogee/chain the API uses, imported by file. The API never signs (D19): it only builds typed data,
 * hashes, calldata (to simulate with eth_call) and decodes reverts.
 *
 * Why by file: apps/web bundles this package with Turbopack, and @hogee/chain's index pulls in deployments.ts, whose
 * `new URL('../deployments/', import.meta.url)` Turbopack treats as an asset it cannot resolve (a directory). None of
 * the modules below import deployments.ts at runtime (only `import type`), so the bundle stays clean. Deployment
 * manifests are parsed by ./deployment.ts instead.
 */
export {
  HOGEE_DOMAIN_NAME,
  HOGEE_DOMAIN_VERSION,
  VERIFYING_CONTRACT_OF,
  hashHogeeTypedData,
  hogeeDomain,
  hogeeTypedData,
  hogeeTypes,
  loosenId,
  toBytes32Tag,
  utf8Keccak,
  type HogeeDomain,
  type HogeeMessages,
  type HogeeStructName,
  type LoosenRequestMessage,
  type MilestoneReleaseMessage,
  type OwnerSpendMessage,
  type PlanApprovalMessage,
  type StageReleaseMessage,
  type SupplierApprovalMessage,
} from "../../chain/src/eip712";
export {
  hashLines,
  hashStages,
  intentId,
  manifestToLines,
  manifestToStages,
  milestoneSettlementId,
  scheduleHash,
  sequenceInvoiceHash,
  type OnchainLine,
  type OnchainStage,
} from "../../chain/src/hashes";
export { HOGEE_KINDS } from "../../chain/src/kinds";
export { decisionIdToBytes32, lineKeyToLineId, reasonCodeToBytes32, shortIdToBytes32, ZERO_BYTES32 } from "../../chain/src/values";
export {
  buildBindPayee,
  buildCommitPlan,
  buildOwnerSpend,
  buildQueueLoosen,
  buildReleaseMilestone,
  buildSpend,
  type HogeeCall,
  type OnchainSig,
} from "../../chain/src/tx-builder";
export { iMilestoneEscrowAbi, iPlanRegistryAbi, iSalesOracleAbi, iTreasuryAbi } from "../../chain/src/generated";
export { decodeRevertData, revertDataFromError, type DecodedRevert } from "../../chain/src/revert";
export { redactText, shortErrorReason } from "../../chain/src/errors";
export { chainConfigFromEnv, createHogeePublicClient, validateChainConfig, type ChainConfig, type HogeePublicClient } from "../../chain/src/clients";
