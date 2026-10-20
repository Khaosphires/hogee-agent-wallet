/**
 * The evidence bundle layout (project.md §16): evidence/<run-id>/ written by the exporter (packages/api evidence/),
 * read by this verifier, the evidence explorer (P2) and replay mode. manifest.json and evidence.json are the frozen
 * core schemas; every other file is defined here, strictly (an unknown key fails the bundle).
 *
 * Money and chain-mirrored times are digit strings; raw receipts and blocks are kept exactly as the RPC returned them
 * (hex quantities), so the receipt bytes in the bundle are the bytes the node served.
 */
import { z } from "zod";
import {
  Address,
  BlockNumber,
  BundleManifest,
  ChainActionState,
  ChainId,
  CountryCode,
  DecisionId,
  DeploymentId,
  EvidenceRows,
  Hex32,
  HexBytes,
  HttpUrl,
  Id,
  IsoDateTime,
  NonNegInt,
  Payment,
  PlanManifest,
  PlanStatus,
  PlanVersion,
  ShortId,
  SignatureKind,
  SignatureSubmitBody,
  SignMethod,
  TraceEvent,
  TypedData,
  Uint8,
} from "@hogee/core";

export const BUNDLE_FORMAT = "hogee.evidence/1" as const;

export const BUNDLE_FILES = {
  manifest: "manifest.json",
  evidence: "evidence.json",
  contracts: "contracts.json",
  plans: "plans.json",
  signatures: "signatures.json",
  payments: "payments.json",
  chainActions: "chain-actions.json",
  rationales: "rationales.json",
  traces: "traces.json",
  llmCalls: "llm-calls.json",
  blocks: "blocks.json",
  hashes: "hashes.json",
  summary: "SUMMARY.md",
} as const;

/** Optional: absent when the country pack the plans commit to was not available at export. */
export const COUNTRY_PACK_FILE = "country-pack.json";
/** One raw receipt per transaction: receipts/<txHash>.json. */
export const RECEIPTS_DIR = "receipts/";
export const receiptPath = (txHash: string): string => `${RECEIPTS_DIR}${txHash.toLowerCase()}.json`;
export const RECEIPT_PATH_RE = /^receipts\/(0x[0-9a-f]{64})\.json$/;

const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Quantity = z.string().regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/, "JSON-RPC quantity");
const AnyHex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const AnyAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const AnyHexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);

/**
 * The block explorer a chain's links may use, pinned by chain id (run-6 re-check M5): the bundle never chooses the site
 * a judge is sent to compare the anchor with. Sepolia → Etherscan; every other chain has none.
 */
export const PINNED_EXPLORERS: Readonly<Record<number, string>> = { 11_155_111: "https://sepolia.etherscan.io" };
export const explorerOf = (chainId: number): string | null => PINNED_EXPLORERS[chainId] ?? null;
/** A link on `base`: under `${base}/`, so a lookalike host such as `${base}.example` never passes. */
export const onExplorer = (url: string, base: string | null): boolean => base !== null && url.startsWith(`${base}/`);
/** The frozen manifest needs a verifiedUrl even with no explorer: then only this local placeholder, never a remote site. */
export const LOCAL_URL_BASE = "http://localhost";
/** The one link a row's tx may have on `base` (run-7 re-check L2): its own tx page, lowercase as the exporter writes it. */
export const txUrlOf = (base: string, txHash: string): string => `${base}/tx/${txHash.toLowerCase()}`;
/** The one link a contract may have on `base` (run-7 re-check L2): its own code page, lowercase as the exporter writes it. */
export const codeUrlOf = (base: string, address: string): string => `${base}/address/${address.toLowerCase()}#code`;
/** A link equals the expected one; hex in an explorer path is case-insensitive, and every pinned base is lowercase. */
const sameUrl = (url: string, expected: string): boolean => url.toLowerCase() === expected;

const ContractEntry = z.strictObject({
  address: Address,
  /** On the chain's pinned explorer (explorerOf), or null (no explorer for this chain). */
  verifiedUrl: HttpUrl.nullable(),
  /** false on a local chain (no explorer) or before Etherscan/Sourcify verification. */
  verified: z.boolean(),
});

export const ContractsFile = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  runId: Id,
  facilityId: Id,
  exportedAt: IsoDateTime,
  deploymentId: DeploymentId,
  chainId: ChainId,
  /** EIP-712 domain salt input: keccak256(abi.encode(bytes32 chainTag, bytes32 deploymentId)). */
  chainTag: ShortId,
  /** Explorer base for tx links: exactly explorerOf(chainId) (Sepolia: https://sepolia.etherscan.io), else null. */
  explorer: HttpUrl.nullable(),
  contracts: z.strictObject({
    PlanRegistry: ContractEntry,
    Treasury: ContractEntry,
    MilestoneEscrow: ContractEntry.optional(),
    SalesOracle: ContractEntry.optional(),
  }),
  /** Eval traces (`[eval …`) are measurements, never decisions: left out and counted here. */
  excludedEvalTraces: NonNegInt,
});
export type ContractsFile = z.infer<typeof ContractsFile>;
export type ContractName = keyof ContractsFile["contracts"];

export const PlanEntry = z.strictObject({
  planRowId: Id,
  version: PlanVersion,
  status: PlanStatus,
  planHash: Hex32,
  prevPlanHash: Hex32,
  countryPackHash: Hex32,
  txHash: Hex32.nullable(),
  manifest: PlanManifest,
});
export const PlansFile = z.array(PlanEntry);
export type PlanEntry = z.infer<typeof PlanEntry>;

export const SignatureEntry = z.strictObject({
  requestId: Id,
  kind: SignatureKind,
  refId: z.string().min(1).max(128),
  method: SignMethod,
  typedData: TypedData,
  digest: Hex32,
  status: z.enum(["PENDING", "SUBMITTED", "REJECTED", "EXPIRED"]),
  /** The §26.6 submit body as stored; null when nothing was submitted. */
  submission: SignatureSubmitBody.nullable(),
  chainActionId: Id.nullable(),
});
export const SignaturesFile = z.array(SignatureEntry);
export type SignatureEntry = z.infer<typeof SignatureEntry>;

/** A signed row: the worker's raw signed bytes (public once broadcast) and its signer. */
const Signed = {
  signerAddress: Address.nullable(),
  nonce: Digits.nullable(),
  rawSignedTx: HexBytes.nullable(),
};

/**
 * CANCELLED only (payments.nonce_consumed_by_tx_hash): the tx that consumed the row's nonce, with its raw signed bytes
 * as the node serves them; its receipt is in receipts/. The verifier accepts a CANCELLED row without its own receipt
 * only when this mined tx has the row's signer and nonce.
 */
export const NonceConsumer = z.strictObject({ txHash: Hex32, rawSignedTx: HexBytes.nullable() });

export const PaymentEntry = z.strictObject({
  payment: Payment,
  orderId: z.string().min(1).max(128).nullable(),
  milestoneIdx: Uint8.nullable(),
  nonceConsumedBy: NonceConsumer.nullable(),
  ...Signed,
});
export const PaymentsFile = z.array(PaymentEntry);
export type PaymentEntry = z.infer<typeof PaymentEntry>;

export const ChainActionEntry = z.strictObject({
  actionId: Id,
  /** `<Contract>.<function>`, e.g. PlanRegistry.commitPlan. */
  kind: z.string().regex(/^[A-Za-z]+\.[A-Za-z]+$/),
  refId: z.string().min(1).max(128).nullable(),
  state: ChainActionState,
  txHash: Hex32.nullable(),
  block: BlockNumber.nullable(),
  revertReason: z.string().min(1).max(200).nullable(),
  createdAt: IsoDateTime,
  ...Signed,
});
export const ChainActionsFile = z.array(ChainActionEntry);
export type ChainActionEntry = z.infer<typeof ChainActionEntry>;

/**
 * rationaleHash = keccak256(utf8(JCS(rationale))) today (salt null); the §7.2 salted form
 * keccak256(utf8(JCS(rationale)) ‖ salt) is accepted when a salt is present. `unavailable` still parses so the
 * verifier can name it, but it always fails "rationale commitments" (no deployment predates task 1.16), and the
 * exporter never writes it.
 */
export const RationaleEntry = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    rationaleHash: Hex32,
    decisionId: DecisionId.nullable(),
    rationale: z.json(),
    salt: Hex32.nullable(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    rationaleHash: Hex32,
    decisionId: DecisionId.nullable(),
    reason: z.literal("pre-1.16 row"),
  }),
]);
export const RationalesFile = z.array(RationaleEntry);
export type RationaleEntry = z.infer<typeof RationaleEntry>;

export const TracesFile = z.array(TraceEvent);

/** The hashed LLM call log (§12.1 llm_calls): hashes of redacted prompts and responses, never the text. */
export const LlmCallEntry = z.strictObject({
  llmCallId: Id,
  traceId: Id.nullable(),
  role: z.enum(["planner", "reader", "explainer", "judge", "classifier"]),
  provider: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  params: z.json(),
  promptHash: Hex32,
  responseHash: Hex32.nullable(),
  redactionReport: z.json(),
  latencyMs: NonNegInt.nullable(),
  tokens: z.strictObject({ input: NonNegInt, output: NonNegInt }).nullable(),
  createdAt: IsoDateTime,
});
export const LlmCallsFile = z.array(LlmCallEntry);

export const CountryPackFile = z.strictObject({
  countryCode: CountryCode,
  countryPackHash: Hex32,
  pack: z.json(),
});
export type CountryPackFile = z.infer<typeof CountryPackFile>;

export const RawBlock = z.strictObject({ number: Quantity, hash: AnyHex32, parentHash: AnyHex32, timestamp: Quantity });
export const BlocksFile = z.array(RawBlock);
export type RawBlock = z.infer<typeof RawBlock>;

export const RawLog = z.looseObject({
  address: AnyAddress,
  topics: z.array(AnyHex32).max(4),
  data: AnyHexData,
  blockNumber: Quantity,
  blockHash: AnyHex32,
  transactionHash: AnyHex32,
  transactionIndex: Quantity,
  logIndex: Quantity,
  removed: z.boolean().optional(),
});
export type RawLog = z.infer<typeof RawLog>;

/** eth_getTransactionReceipt as served (extra provider fields are kept and hashed, not interpreted). */
export const RawReceipt = z.looseObject({
  transactionHash: AnyHex32,
  transactionIndex: Quantity,
  blockHash: AnyHex32,
  blockNumber: Quantity,
  from: AnyAddress,
  to: AnyAddress.nullable(),
  status: z.enum(["0x1", "0x0"]),
  logs: z.array(RawLog),
  logsBloom: z.string().regex(/^0x[0-9a-fA-F]{512}$/),
  gasUsed: Quantity,
  cumulativeGasUsed: Quantity,
  contractAddress: AnyAddress.nullable().optional(),
});
export type RawReceipt = z.infer<typeof RawReceipt>;

/** keccak256 of every other file's exact bytes ("stored hashes"). hashes.json and nothing else is not listed. */
export const HashesFile = z.strictObject({
  algorithm: z.literal("keccak256"),
  files: z.record(z.string().min(1).max(300), Hex32),
});

export { BundleManifest, EvidenceRows };

/** The parsed bundle the checks run on (only files that parsed; `receipts` keyed by lowercase tx hash). */
export interface ParsedBundle {
  readonly manifest: z.infer<typeof BundleManifest>;
  readonly rows: z.infer<typeof EvidenceRows>;
  readonly contracts: ContractsFile;
  readonly plans: readonly PlanEntry[];
  readonly signatures: readonly SignatureEntry[];
  readonly payments: readonly PaymentEntry[];
  readonly chainActions: readonly ChainActionEntry[];
  readonly rationales: readonly RationaleEntry[];
  readonly traces: readonly z.infer<typeof TraceEvent>[];
  readonly llmCalls: readonly z.infer<typeof LlmCallEntry>[];
  readonly blocks: readonly RawBlock[];
  readonly countryPack: CountryPackFile | null;
  readonly receipts: ReadonlyMap<string, RawReceipt>;
  readonly paths: ReadonlySet<string>;
}

/**
 * The pinned-explorer rules (run-6 re-check M5, exact paths since run-7 re-check L2), empty when they hold:
 * contracts.json names exactly the chain's pinned explorer; a contracts.json verifiedUrl is absent or exactly
 * `<base>/address/<that contract>#code`; a row explorerUrl is absent or exactly `<base>/tx/<that row's txHash>`; a
 * manifest verifiedUrl is exactly its contract's code page on its chain's pinned explorer (with no explorer, on
 * LOCAL_URL_BASE, a placeholder that is never shown as a link). So a tampered bundle cannot send the judge to another
 * real tx or contract on the pinned explorer either. A failing URL is never echoed (it may be a phishing link).
 */
export function explorerProblems(b: Pick<ParsedBundle, "contracts" | "manifest" | "rows">): string[] {
  const base = explorerOf(b.contracts.chainId);
  const pinned = base ?? `no explorer (none is pinned for chain ${b.contracts.chainId})`;
  const out: string[] = [];
  if (b.contracts.explorer !== base) out.push(`contracts.json names another explorer than the one pinned for chain ${b.contracts.chainId} (${pinned})`);
  for (const [name, c] of Object.entries(b.contracts.contracts)) {
    if (c && c.verifiedUrl !== null && (base === null || !sameUrl(c.verifiedUrl, codeUrlOf(base, c.address)))) out.push(`contracts.json: ${name}'s verifiedUrl is not its code page on ${pinned}`);
  }
  for (const [id, d] of Object.entries(b.manifest.deployments)) {
    const explorer = explorerOf(d.chainId);
    for (const [name, c] of Object.entries(d.contracts)) {
      const ok = explorer ? sameUrl(c.verifiedUrl, codeUrlOf(explorer, c.address)) : onExplorer(c.verifiedUrl, LOCAL_URL_BASE);
      if (!ok) out.push(`manifest.json: ${id} ${name}'s verifiedUrl is not its code page on ${explorer ?? LOCAL_URL_BASE}`);
    }
  }
  b.rows.forEach((r, i) => {
    if (r.explorerUrl === undefined) return;
    if (base === null || r.txHash === undefined || !sameUrl(r.explorerUrl, txUrlOf(base, r.txHash))) out.push(`evidence.json row ${i} ${r.taskId}: explorerUrl is not its tx page on ${pinned}`);
  });
  return out;
}
