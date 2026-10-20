/**
 * The FISCO BCOS mirror pack (`hogee.fisco-mirror/2`): evidence/fisco/fm-<16hex>/, written by the replay
 * (scripts/redteam/src/fisco/) after it re-ran the final-2 Sepolia run on a local 5-node FISCO BCOS 3.17.1 chain, and
 * read by verifyFiscoPack (./index.ts). Browser-safe: zod and pure helpers only.
 *
 * Version 2 adds the regulator: the chain runs with auth checks on and the regulator as its committee governor (it
 * also runs node4, the observer). Its governance steps (G), the chain's own refusals (F1 frozen, M1 method banned),
 * the probe-only calls (C), each mined tx's native receipt, and node4's copy of the ledger (ledger.json).
 *
 * Every file is a strict schema (an unknown key fails the pack) except what a node served verbatim: the tx object,
 * receipt, log and native receipt of txs/<hash>.json are kept loose and hashed as served (FISCO may add fields).
 * Money is integer minor units as digit strings (100 minor = 1 BU); chain quantities stay as served (0x-hex).
 * No RPC URL, node id or key appears in any file.
 */
import { z } from "zod";
import { Address, hashObject, Hex32, HexBytes, Id, IsoDateTime, NonNegInt, PasskeyAssertion, PlanManifest, ShortId, SignatureSubmitBody, TypedData } from "@hogee/core";
import { SignatureEntry } from "../bundle";
import { SYSTEM, SYSTEM_NAMES, isSystemName } from "./system";

export const FISCO_FORMAT = "hogee.fisco-mirror/2" as const;
/** The FISCO BCOS 3.x Web3 RPC chain id (genesis default). */
export const FISCO_CHAIN_ID = 20_200;
export const SEPOLIA_CHAIN_ID = 11_155_111;

/**
 * The run the mirror replays. The checker pins final-2 on Sepolia (FINAL_2); verifyFiscoPack takes another identity
 * only through its options (the CLI never sets it), so the test suite can mirror a synthetic source bundle.
 * The source deploy's broadcast is pinned here too (repo path and keccak256 of its exact bytes): the bundle holds the
 * contract addresses only, so this pin is the one external anchor of the source creation code and constructor values.
 */
export interface SourceIdentity {
  readonly runId: string;
  readonly chainId: number;
  readonly chainTag: string;
  readonly deploymentId: string;
  /** The tracked DeployFinal broadcast of the source deploy (repo-relative). */
  readonly broadcastFile: string;
  /** keccak256 of that file's exact bytes. */
  readonly broadcastKeccak: string;
}
export const FINAL_2: SourceIdentity = {
  runId: "ev-74756ea61a72ae7c",
  chainId: SEPOLIA_CHAIN_ID,
  chainTag: "sepolia",
  deploymentId: "final-2",
  broadcastFile: "contracts/broadcast/DeployFinal.s.sol/11155111/run-1792385076465.json",
  broadcastKeccak: "0xd729b12a79cd978406e1fa52cc6e85a5b65a3b3b92104431c730efb1fef0f52a",
};
export const FISCO_CHAIN_TAG = "fisco";
/** Under evidence/: `latestBundle` and the API store must never take a pack for a bundle. */
export const FISCO_PACKS_DIR = "fisco";
export const PACK_DIR_RE = /^fm-[0-9a-f]{16}$/;

/** The four deploy-tx contracts plus TreasuryGovernance, which Treasury's constructor creates (no tx of its own). */
export const DEPLOYED = ["PlanRegistry", "Treasury", "MilestoneEscrow", "SalesOracle"] as const;
export const CODE_NAMES = [...DEPLOYED.slice(0, 2), "TreasuryGovernance", ...DEPLOYED.slice(2)] as const;
export type DeployedName = (typeof DEPLOYED)[number];
export type CodeName = (typeof CODE_NAMES)[number];
/** What a step may call: a Hogee deployment contract or a FISCO system contract (./system.ts). */
export const TARGETS = [...DEPLOYED, ...SYSTEM_NAMES] as const;
export type TargetName = (typeof TARGETS)[number];
/** A step target's address on the mirror: a deployment.json contract, or the system contract's fixed address. */
export const targetAddressOf = (deployment: Pick<DeploymentFile, "contracts">, name: TargetName): string =>
  isSystemName(name) ? SYSTEM[name] : deployment.contracts[name].address;

/**
 * Who sends (or signs) on the mirror. "founder" is never a sender: its passkey signatures are relayed. "observer" is
 * Treasury's veto key (the zero address on final-2), not node4; "regulator" is the chain's committee governor and
 * genesis auth admin, who also runs node4.
 */
export const ROLES = ["deployer", "lender", "oracle", "agent", "relayer", "observer", "regulator"] as const;
export type Role = (typeof ROLES)[number];
export const AUTHS = ["passkey", "ecdsa-lender", "ecdsa-agent", "none"] as const;
export type Auth = (typeof AUTHS)[number];

export const PACK_FILES = {
  pack: "pack.json",
  chain: "chain.json",
  deployment: "deployment.json",
  steps: "steps.json",
  artifacts: "artifacts.json",
  plan: "plan.json",
  t28: "t28.json",
  sepoliaBroadcast: "sepolia-broadcast.json",
  codeMeta: "code/meta.json",
  sepoliaCodeMeta: "code-sepolia/meta.json",
  /** node4's (the regulator's observer node) copy of blocks 0..headAtEnd, compared with node0's. */
  ledger: "ledger.json",
  hashes: "hashes.json",
} as const;

export const TXS_DIR = "txs/";
export const txPath = (hash: string): string => `${TXS_DIR}${hash.toLowerCase()}.json`;
export const TX_PATH_RE = /^txs\/(0x[0-9a-f]{64})\.json$/;
export const codePath = (name: CodeName, sepolia = false): string => `${sepolia ? "code-sepolia" : "code"}/${name}.hex`;
const CODE_PATH_RE = new RegExp(`^(code|code-sepolia)/(${CODE_NAMES.join("|")})\\.hex$`);
export const codePathOf = (path: string): { readonly sepolia: boolean; readonly name: CodeName } | null => {
  const m = CODE_PATH_RE.exec(path);
  return m ? { sepolia: m[1] === "code-sepolia", name: m[2] as CodeName } : null;
};

/** Every path a pack may hold: the fixed files, one code file per contract and chain, and txs/<hash>.json. */
export const isPackPath = (path: string): boolean =>
  (Object.values(PACK_FILES) as string[]).includes(path) || TX_PATH_RE.test(path) || codePathOf(path) !== null;

/** Size caps, checked before parsing (the explorer may run this in a browser tab). */
export const MAX_PACK_FILES = 400;
export const MAX_PACK_FILE_BYTES = 4 * 1024 * 1024;
/** A deployed contract is at most 24,576 bytes (EIP-170): its hex file is at most 2 + 2 × that + a newline. */
export const MAX_CODE_FILE_BYTES = 2 + 2 * 24_576 + 1;

const Digits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const Quantity = z.string().regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/, "JSON-RPC quantity");
const AnyHex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const AnyAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const AnyHexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
/** An address field a node may serve empty for "none" (a creation's `to`, a call's `contractAddress`). */
const ServedAddress = z.union([AnyAddress, z.literal(""), z.literal("0x")]).nullable();
const Label = z.string().min(1).max(120);
/** One key per name, all with the same schema (for z.strictObject). */
const byName = <K extends string, T>(names: readonly K[], schema: T): Record<K, T> => Object.fromEntries(names.map((n) => [n, schema])) as unknown as Record<K, T>;
const Value = z.string().min(1).max(200);
const Keccak = Hex32;

// ---- pack.json --------------------------------------------------------------------------------------------------

export const PackFile = z.strictObject({
  format: z.literal(FISCO_FORMAT),
  /** packIdOf(the other fields): fm-<first 16 hex of keccak256(JCS(them))>. */
  packId: z.string().regex(PACK_DIR_RE),
  createdAt: IsoDateTime,
  gitCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  /** The Sepolia bundle the mirror replays, pinned file by file (keccak256 of each file's exact bytes). */
  sourceBundle: z.strictObject({
    runId: Id,
    files: z.record(z.string().min(1).max(300), Keccak),
  }),
});
export type PackFile = z.infer<typeof PackFile>;

// ---- chain.json -------------------------------------------------------------------------------------------------

export const ChainFile = z.strictObject({
  /** web3_clientVersion as served. */
  clientVersion: z.string().min(1).max(200),
  chainId: z.literal(FISCO_CHAIN_ID),
  nodeCount: z.number().int().min(1).max(16),
  sealerCount: z.number().int().min(1).max(16),
  observerCount: z.number().int().min(0).max(16),
  consensus: z.string().min(1).max(40),
  genesis: z.strictObject({
    /** [features] of config.genesis, e.g. feature_evm_cancun: 1. */
    features: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.number().int().min(0).max(1)),
    txGasLimit: Digits.optional(),
  }),
  evm: z.strictObject({ timestampUnit: z.literal("seconds"), p256At0x100: z.boolean() }),
  txType: z.literal("legacy"),
  gasPrice: z.literal("0x0"),
  headAtStart: NonNegInt,
  headAtEnd: NonNegInt,
  /** node0's block hash at headAtEnd. */
  headHashAtEnd: Hex32,
  /** config.genesis [executor]: is_auth_check and auth_admin_account (the regulator). */
  auth: z.strictObject({ check: z.literal(true), admin: Address }),
  /**
   * node4 joined as an observer through the regulator's createSetConsensusWeightProposal(node4Id, 0, true, 1000) at
   * chain-up (not a replay step). Only keccak256 of the node id is kept (no raw node id in any file).
   */
  observerNode: z.strictObject({ index: z.literal(4), proposalTx: Hex32, proposalBlock: NonNegInt, weight: z.literal(0), nodeIdKeccak: Hex32 }),
});
export type ChainFile = z.infer<typeof ChainFile>;

// ---- deployment.json --------------------------------------------------------------------------------------------

const DeployedContract = z.strictObject({ address: Address, deployTx: Hex32.nullable() });

/** DeployFinal's BEGIN/END DEPLOYMENT JSON (packages/chain DeploymentManifest), as printed (checksummed addresses). */
export const DeployManifest = z.strictObject({
  chainId: z.number().int().positive(),
  deploymentId: ShortId,
  chainTag: ShortId,
  contracts: z.strictObject(byName(DEPLOYED, z.strictObject({ address: AnyAddress }))),
  blockNumber: NonNegInt,
  deployedAt: IsoDateTime,
});
export type DeployManifest = z.infer<typeof DeployManifest>;

export const DeploymentFile = z.strictObject({
  chainTag: z.literal(FISCO_CHAIN_TAG),
  /** The source deployment id (final-2): the mirror keeps it, so every signed struct's deploymentId is the same. */
  deploymentId: ShortId,
  fiscoMs: z.literal(false),
  contracts: z.strictObject({
    PlanRegistry: DeployedContract,
    Treasury: DeployedContract,
    /** Created by Treasury's constructor: deployTx is null (its creation is inside Treasury's deploy tx). */
    TreasuryGovernance: DeployedContract,
    MilestoneEscrow: DeployedContract,
    SalesOracle: DeployedContract,
  }),
  /** The addresses each role signs with on the mirror (observer: the zero address when none, as on final-2). */
  roles: z.strictObject(byName(ROLES, Address)),
  founderKey: z.strictObject({ qx: Hex32, qy: Hex32, ownerEOA: Address }),
  params: z.strictObject({
    coolingSeconds: Digits,
    loosenTimelockSeconds: Digits,
    judgingWindowEnd: Digits,
    platformPayeeIds: z.array(Hex32).max(32),
    platformPayoutHashes: z.array(Hex32).max(32),
  }),
  sepolia: z.strictObject({
    contracts: z.strictObject(byName(CODE_NAMES, Address)),
    /** Repo path of the final-2 DeployFinal broadcast, copied verbatim to sepolia-broadcast.json (= FINAL_2's). */
    broadcastFile: z.string().regex(/^contracts\/broadcast\/DeployFinal\.s\.sol\/[0-9]{1,12}\/run-[0-9]{1,20}\.json$/),
    broadcastKeccak: Keccak,
  }),
  manifestJson: DeployManifest,
});
export type DeploymentFile = z.infer<typeof DeploymentFile>;

// ---- steps.json -------------------------------------------------------------------------------------------------

/** probe-only: an eth_call the replay made and never sent (C steps); no tx, the nonce unchanged. */
export const OutcomeKind = z.enum(["mined", "mined-reverted", "rpc-refused", "probe-only"]);
export type OutcomeKind = z.infer<typeof OutcomeKind>;

export const RpcError = z.strictObject({ code: z.number().int(), message: z.string().max(500) });

export const StateRead = z.strictObject({ label: Label, before: Value, after: Value });

export const Step = z.strictObject({
  seq: z.number().int().min(1).max(999),
  /** A catalogue id (catalogue.ts): S1, R7, D7, T28a, … */
  id: z.string().regex(/^[A-Z][0-9]{1,2}[a-z]?$/),
  title: z.string().min(1).max(200),
  contract: z.enum(TARGETS),
  function: z.string().regex(/^[a-zA-Z]{1,40}$/),
  signerRole: z.enum(ROLES),
  auth: z.enum(AUTHS),
  amountMinor: Digits.optional(),
  expected: z.enum(["ok", "refused"]),
  /** The error the offline rule derives for a refusal: a Hogee custom error, or a chain refusal (catalogue.ts). */
  expectedError: z.string().regex(/^[A-Z][A-Za-z]{1,40}$/).optional(),
  /** eth_call at the current block before sending; `error` = the decoded error name or the node's message. */
  probe: z.strictObject({ ok: z.boolean(), error: z.string().min(1).max(500).optional() }),
  /** Probe-only steps (and only they): the eth_call exactly as made, at block `block`. */
  call: z.strictObject({ from: Address, to: Address, data: HexBytes, block: NonNegInt }).optional(),
  outcome: z.strictObject({
    kind: OutcomeKind,
    txHash: Hex32.optional(),
    rpcError: RpcError.optional(),
  }),
  /** State reads around a refusal (milestone state, isNonceUsed, line spent, paused, balances); empty otherwise. */
  reads: z.array(StateRead).max(32),
  /** The sender's account nonce before and after the send. */
  nonce: z.strictObject({ before: NonNegInt, after: NonNegInt }),
  links: z.strictObject({
    /** D-steps: the refusal step whose calldata the proposalHash commits to. */
    recordsDenialOf: z.string().regex(/^[A-Z][0-9]{1,2}[a-z]?$/).optional(),
    /** Parity steps: the final-2 Sepolia tx this step mirrors. */
    sepoliaTx: Hex32.optional(),
  }),
});
export type Step = z.infer<typeof Step>;

/** P0 / P1 (no tx): what the replay read before the first and after the last step. */
export const Snapshot = z.strictObject({ block: NonNegInt, reads: z.array(z.strictObject({ label: Label, value: Value })).max(64) });

export const StepsFile = z.strictObject({
  format: z.literal(FISCO_FORMAT),
  preflight: Snapshot,
  steps: z.array(Step).min(1).max(64),
  final: Snapshot,
});
export type StepsFile = z.infer<typeof StepsFile>;

// ---- txs/<hash>.json --------------------------------------------------------------------------------------------

export const FiscoLog = z.looseObject({
  address: AnyAddress,
  topics: z.array(AnyHex32).max(4),
  data: AnyHexData,
  blockNumber: Quantity.optional(),
  blockHash: AnyHex32.optional(),
  transactionHash: AnyHex32.optional(),
  logIndex: Quantity.optional(),
  removed: z.boolean().optional(),
});

/**
 * eth_getTransactionReceipt as the FISCO Web3 RPC serves it (loose: extra fields kept and hashed). logsBloom may be
 * absent or zero-filled: the checker recomputes it only when it is served non-zero.
 */
export const FiscoReceipt = z.looseObject({
  transactionHash: AnyHex32,
  transactionIndex: Quantity,
  blockHash: AnyHex32,
  blockNumber: Quantity,
  from: AnyAddress,
  to: ServedAddress,
  status: z.enum(["0x1", "0x0"]),
  logs: z.array(FiscoLog),
  logsBloom: z.string().regex(/^0x([0-9a-fA-F]{512})?$/).nullable().optional(),
  gasUsed: Quantity,
  contractAddress: ServedAddress.optional(),
});
export type FiscoReceipt = z.infer<typeof FiscoReceipt>;

/** A served address, or null for an empty or zero one. */
export const servedAddressOf = (a: string | null | undefined): string | null => (!a || a === "0x" || /^0x0{40}$/.test(a) ? null : a.toLowerCase());

export const FiscoBlock = z.strictObject({
  number: Quantity,
  hash: AnyHex32,
  parentHash: AnyHex32,
  timestamp: Quantity,
  /** The block's tx hashes, in order. */
  transactions: z.array(AnyHex32).max(10_000),
});
export type FiscoBlock = z.infer<typeof FiscoBlock>;

/**
 * getTransactionReceipt on the FISCO native RPC (group0), as served (loose): the only place the chain's own status
 * shows (22 AccountFrozen, 18 PermissionDenied, 16 revert; system.ts NATIVE_STATUS) and a system call's return value.
 */
export const NativeReceipt = z.looseObject({
  transactionHash: AnyHex32,
  blockNumber: NonNegInt,
  status: z.number().int().min(0).max(255),
  output: AnyHexData,
});
export type NativeReceipt = z.infer<typeof NativeReceipt>;

export const TxFile = z.strictObject({
  hash: Hex32,
  rawSignedTx: HexBytes,
  /** sent: the exact bytes eth_sendRawTransaction got; rebuilt: re-serialised from eth_getTransactionByHash (deploy txs). */
  rawSource: z.enum(["sent", "rebuilt"]),
  /** eth_getTransactionByHash as served; null for an rpc-refused tx (never mined). */
  tx: z.looseObject({ hash: AnyHex32 }).nullable(),
  receipt: FiscoReceipt.nullable(),
  block: FiscoBlock.nullable(),
  /** The native receipt of a mined tx; null only for an rpc-refused tx. */
  native: NativeReceipt.nullable(),
});
export type TxFile = z.infer<typeof TxFile>;

// ---- code/ and code-sepolia/ ------------------------------------------------------------------------------------

export const CodeMeta = z.strictObject({
  chainId: z.number().int().positive(),
  blockNumber: NonNegInt,
  blockHash: Hex32,
  capturedAt: IsoDateTime,
  addresses: z.strictObject(byName(CODE_NAMES, Address)),
});
export type CodeMeta = z.infer<typeof CodeMeta>;

/** A code/<Name>.hex file: eth_getCode as lowercase 0x-hex, one optional trailing newline. */
export const CODE_FILE_RE = /^0x([0-9a-f]{2})+\n?$/;

// ---- artifacts.json ---------------------------------------------------------------------------------------------

export const ImmutableRefs = z.record(z.string().regex(/^[0-9]{1,8}$/), z.array(z.strictObject({ start: NonNegInt, length: z.literal(32) })).max(64));
export type ImmutableRefs = z.infer<typeof ImmutableRefs>;

export const ArtifactEntry = z.strictObject({
  /** forge out/<Name>.sol/<Name>.json bytecode.object (creation code). */
  bytecode: HexBytes,
  /** deployedBytecode.object, immutables zero-filled. */
  deployedBytecode: HexBytes,
  /** deployedBytecode.immutableReferences: AST id → byte ranges in the runtime code. */
  immutableReferences: ImmutableRefs,
});
export type ArtifactEntry = z.infer<typeof ArtifactEntry>;

export const ArtifactsFile = z.strictObject({
  solc: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.+-]{1,60})?$/),
  evmVersion: z.literal("cancun"),
  optimizer: z.strictObject({ enabled: z.boolean(), runs: NonNegInt }),
  contracts: z.strictObject(byName(CODE_NAMES, ArtifactEntry)),
});
export type ArtifactsFile = z.infer<typeof ArtifactsFile>;

// ---- plan.json --------------------------------------------------------------------------------------------------

export const PlanFile = z.strictObject({
  manifest: PlanManifest,
  planHash: Hex32,
  /** The final-2 v1 planHash (plans.json of the source bundle). */
  sepoliaPlanHash: Hex32,
  /** RFC 6901 pointers where the manifest differs from final-2's: expected empty on FISCO (same agent key). */
  diffFromSepolia: z.array(z.string().regex(/^(\/[^/]{0,80}){1,8}$/)).max(64),
  approval: z.strictObject({ typedData: TypedData, digest: Hex32, submission: SignatureSubmitBody }),
});
export type PlanFile = z.infer<typeof PlanFile>;

// ---- t28.json ---------------------------------------------------------------------------------------------------

export const T28File = z.strictObject({
  /** Verbatim: the final-2 MilestoneRelease entry of the source bundle's signatures.json. */
  sepoliaSignature: SignatureEntry,
  /** The final-2 releaseMilestone tx whose calldata T28a replays byte for byte. */
  sepoliaTx: z.strictObject({ hash: Hex32, raw: HexBytes }),
  /** A fresh MilestoneRelease signed by the mirror's founder under the SEPOLIA domain (salt sepolia/final-2). */
  t28b: z.strictObject({ typedData: TypedData, digest: Hex32, assertion: PasskeyAssertion }),
});
export type T28File = z.infer<typeof T28File>;

// ---- sepolia-broadcast.json -------------------------------------------------------------------------------------

/** The final-2 DeployFinal broadcast (verbatim copy of the tracked file): only what the checker reads is typed. */
export const SepoliaBroadcast = z.looseObject({
  chain: z.number().int().positive(),
  transactions: z
    .array(
      z.looseObject({
        transactionType: z.string(),
        contractName: z.string().nullable(),
        contractAddress: AnyAddress.nullable(),
        hash: AnyHex32,
        transaction: z.looseObject({ input: AnyHexData }),
        additionalContracts: z.array(z.looseObject({ contractName: z.string().optional(), address: AnyAddress, initCode: AnyHexData })).optional(),
      }),
    )
    .min(1)
    .max(32),
});
export type SepoliaBroadcast = z.infer<typeof SepoliaBroadcast>;

// ---- ledger.json ------------------------------------------------------------------------------------------------

/** A log as the ledger keeps it: emitter, topics and data (lowercase). */
export const LedgerLog = z.strictObject({ address: Address, topics: z.array(Hex32).max(4), data: z.string().regex(/^0x([0-9a-f]{2})*$/) });

/** A block's tx and its receipt, normalised from Web3 eth_getBlockByNumber / eth_getTransactionReceipt. */
export const LedgerTx = z.strictObject({
  hash: Hex32,
  from: Address,
  /** null for a contract creation. */
  to: Address.nullable(),
  nonce: NonNegInt,
  /** keccak256 of the tx input bytes. */
  inputKeccak: Hex32,
  receipt: z.strictObject({
    transactionIndex: NonNegInt,
    status: z.union([z.literal(0), z.literal(1)]),
    gasUsed: Digits,
    /** Only for a contract creation. */
    contractAddress: Address.optional(),
    logs: z.array(LedgerLog).max(256),
  }),
});
export type LedgerTx = z.infer<typeof LedgerTx>;

export const LedgerBlock = z.strictObject({
  number: NonNegInt,
  hash: Hex32,
  parentHash: Hex32,
  /** Seconds. */
  timestamp: NonNegInt,
  txs: z.array(LedgerTx).max(10_000),
});
export type LedgerBlock = z.infer<typeof LedgerBlock>;

/**
 * Blocks 0..head as node4 (the regulator's observer, Web3 on 127.0.0.1:8546, read-only from our side) served them,
 * and node0Keccak = keccak256(JCS(node0's blocks in the same shape)): the regulator's ledger equals the sealers'.
 */
export const LedgerFile = z.strictObject({
  node: z.literal("node4-observer"),
  head: z.strictObject({ number: NonNegInt, hash: Hex32 }),
  blocks: z.array(LedgerBlock).min(1).max(100_000),
  node0Keccak: Hex32,
});
export type LedgerFile = z.infer<typeof LedgerFile>;

// ---- hashes.json ------------------------------------------------------------------------------------------------

export { HashesFile } from "../bundle";
export { hashesFileOf } from "../load";

/** The parsed pack the checks run on. */
export interface ParsedPack {
  readonly pack: PackFile;
  readonly chain: ChainFile;
  readonly deployment: DeploymentFile;
  readonly steps: StepsFile;
  readonly artifacts: ArtifactsFile;
  readonly plan: PlanFile;
  readonly t28: T28File;
  readonly sepoliaBroadcast: SepoliaBroadcast;
  readonly code: CodeMeta;
  readonly sepoliaCode: CodeMeta;
  readonly ledger: LedgerFile;
  /** Runtime code by contract, lowercase 0x-hex (no newline). */
  readonly codeHex: ReadonlyMap<CodeName, string>;
  readonly sepoliaCodeHex: ReadonlyMap<CodeName, string>;
  /** txs/<hash>.json by lowercase hash. */
  readonly txs: ReadonlyMap<string, TxFile>;
}

/** The schema of each fixed file (code files and txs are typed separately). */
export const FIXED_SCHEMAS = {
  [PACK_FILES.pack]: PackFile,
  [PACK_FILES.chain]: ChainFile,
  [PACK_FILES.deployment]: DeploymentFile,
  [PACK_FILES.steps]: StepsFile,
  [PACK_FILES.artifacts]: ArtifactsFile,
  [PACK_FILES.plan]: PlanFile,
  [PACK_FILES.t28]: T28File,
  [PACK_FILES.sepoliaBroadcast]: SepoliaBroadcast,
  [PACK_FILES.codeMeta]: CodeMeta,
  [PACK_FILES.sepoliaCodeMeta]: CodeMeta,
  [PACK_FILES.ledger]: LedgerFile,
} as const;

/** An id the checker prints for a step (seq and catalogue id). */
export const stepLabel = (s: Pick<Step, "seq" | "id">): string => `#${s.seq} ${s.id}`;

/** packId = "fm-" + the first 16 hex of keccak256(JCS(pack.json without packId)): the folder name, and stable. */
export function packIdOf(core: Omit<PackFile, "packId">): string {
  const { format, createdAt, gitCommit, sourceBundle } = core;
  return `fm-${hashObject({ format, createdAt, gitCommit, sourceBundle }).slice(2, 18)}`;
}
