/**
 * A complete, valid FISCO mirror pack built with INDEPENDENT code (viem accounts, @hogee/chain EIP-712 and ABIs, noble
 * P-256 through the bundle fixture's passkeyAssert), mirroring the source bundle of ./source.ts on a simulated FISCO
 * chain (id 20200, legacy txs, gasPrice 0, one tx per block, second timestamps, per-tx log indexes, a native
 * receipt per mined tx, and the regulator's node4 copy of every block for ledger.json). Synthetic
 * forge artifacts carry an immutable slot per constructor value, so code identity has real immutables to explain.
 * Test keys are fixed and only ever sign this fixture.
 */
import { encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseTransaction, toHex, type Abi, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { p256 } from "@noble/curves/p256";
import { hashObject, type PlanManifest } from "@hogee/core";
import { hashLines, hashStages, hogeeDomain, hogeeTypes, iMilestoneEscrowAbi, iTreasuryAbi, manifestToLines, manifestToStages, toBytes32Tag } from "@hogee/chain";
import { ADDR, KEYS, logOf, type Log } from "../fixture";
import { fiscoLogsBloom } from "../../src/fisco/bloom";
import type { SourceIdentity } from "../../src/fisco/pack";
import { SOURCE, type Source } from "./source";

const key = (byte: string): PrivateKeyAccount => privateKeyToAccount(`0x${byte.repeat(32)}` as Hex);
export const FKEYS = { deployer: key("66"), oracle: key("77"), lender: KEYS.lender, agent: KEYS.agent, relayer: KEYS.relayer, regulator: key("88") };
export const ZERO_ADDR = `0x${"0".repeat(40)}` as Hex;
export const ZERO32 = `0x${"0".repeat(64)}` as Hex;
export const F_P256 = "57".repeat(32);
const F_PUB = p256.getPublicKey(F_P256, false);
export const FQX = toHex(F_PUB.slice(1, 33));
export const FQY = toHex(F_PUB.slice(33, 65));
export const lower = (a: string): Hex => a.toLowerCase() as Hex;
export const tag = (s: string): Hex => toBytes32Tag(s);
export const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export const FADDR = {
  PlanRegistry: lower(getContractAddress({ from: FKEYS.deployer.address, nonce: 0n })),
  Treasury: lower(getContractAddress({ from: FKEYS.deployer.address, nonce: 1n })),
  MilestoneEscrow: lower(getContractAddress({ from: FKEYS.deployer.address, nonce: 2n })),
  SalesOracle: lower(getContractAddress({ from: FKEYS.deployer.address, nonce: 3n })),
};
export const F_GOV = lower(getContractAddress({ from: FADDR.Treasury, nonce: 1n }));
export const S_GOV = lower(getContractAddress({ from: ADDR.Treasury, nonce: 1n }));
export const PARAMS = { cooling: 120n, loosen: 120n, judging: 2_000_000_000n, payees: [tag("spx-logistics"), tag("shopee-fees")], payouts: [keccak256(toHex("p1")), keccak256(toHex("p2"))] };

// ---- synthetic artifacts ----------------------------------------------------------------------------------------

type Slot = "deploymentId" | "chainTag" | "domain" | "fiscoMs" | "lender" | "registry" | "treasury" | "oracle" | "cooling" | "escrow" | "salesOracle" | "observer" | "loosen" | "governance" | "self" | "judging";
const DOMAIN_SLOTS: readonly Slot[] = ["deploymentId", "chainTag", "domain", "fiscoMs"];
const TREASURY_SLOTS: readonly Slot[] = [...DOMAIN_SLOTS, "registry", "lender", "oracle", "cooling", "escrow", "salesOracle", "observer", "loosen"];
export const LAYOUT = {
  PlanRegistry: [...DOMAIN_SLOTS, "lender", "treasury", "judging"],
  Treasury: [...TREASURY_SLOTS, "governance"],
  TreasuryGovernance: [...TREASURY_SLOTS, "self"],
  MilestoneEscrow: [...DOMAIN_SLOTS, "treasury", "registry", "lender"],
  SalesOracle: ["treasury", "oracle"],
} as const satisfies Record<string, readonly Slot[]>;
export type CodeName = keyof typeof LAYOUT;
export const CODE_NAMES = Object.keys(LAYOUT) as CodeName[];

const PREFIX = "6080604052";
const FILLER = "5f5f5f7f";
const cborTail = (name: string): string => `a2646970667358221220${keccak256(toHex(`meta:${name}`)).slice(2)}64736f6c6343000825${"0033"}`;
/** Byte offset of slot i in the runtime code. */
const slotAt = (i: number): number => PREFIX.length / 2 + i * (FILLER.length / 2 + 32) + FILLER.length / 2;

/**
 * As solc lays it out: the creation code carries the runtime code (immutables zero) after its init code, and
 * Treasury's carries TreasuryGovernance's whole creation code (its constructor runs `new TreasuryGovernance`).
 */
export function artifactOf(name: CodeName): { bytecode: Hex; deployedBytecode: Hex; immutableReferences: Record<string, { start: number; length: 32 }[]> } {
  const slots = LAYOUT[name];
  const body = slots.map(() => `${FILLER}${"00".repeat(32)}`).join("");
  const deployed = `0x${PREFIX}${body}${cborTail(name)}` as Hex;
  const immutableReferences = Object.fromEntries(slots.map((_, i) => [String(1000 + i), [{ start: slotAt(i), length: 32 as const }]]));
  const child = name === "Treasury" ? artifactOf("TreasuryGovernance").bytecode.slice(2) : "";
  return { bytecode: `0x60806040${keccak256(toHex(`init:${name}`)).slice(2)}${child}${deployed.slice(2)}` as Hex, deployedBytecode: deployed, immutableReferences };
}

/** The runtime code with each slot filled from `values`. */
export function runtimeOf(name: CodeName, values: (slot: Slot) => Hex): string {
  let code = artifactOf(name).deployedBytecode.slice(2);
  LAYOUT[name].forEach((slot, i) => {
    const word = values(slot).slice(2).padStart(64, "0");
    const at = slotAt(i) * 2;
    code = code.slice(0, at) + word + code.slice(at + 64);
  });
  return `0x${code}`;
}

const EIP712_DOMAIN = keccak256(toHex("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)"));
export const domainSeparatorOf = (address: Hex, chainTag: string, deploymentId: string): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [EIP712_DOMAIN, keccak256(toHex("Hogee")), keccak256(toHex("1")), address, hogeeDomain({ verifyingContract: address, chainTag: tag(chainTag), deploymentId: tag(deploymentId) }).salt]));

export interface Side {
  readonly chainTag: string;
  readonly addr: Readonly<Record<CodeName, Hex>>;
  readonly lender: Hex;
  readonly oracle: Hex;
  /** The shared constructor values (default PARAMS): a forgery test swaps one on both chains. */
  readonly params?: typeof PARAMS;
}

export const slotValues = (side: Side, name: CodeName) => (slot: Slot): Hex => {
  const word = (n: bigint) => toHex(n, { size: 32 });
  const p = side.params ?? PARAMS;
  switch (slot) {
    case "deploymentId": return tag(SOURCE.deploymentId);
    case "chainTag": return tag(side.chainTag);
    case "domain": return domainSeparatorOf(side.addr[name], side.chainTag, SOURCE.deploymentId);
    case "fiscoMs": return word(0n);
    case "lender": return side.lender;
    case "registry": return side.addr.PlanRegistry;
    case "treasury": return side.addr.Treasury;
    case "oracle": return side.oracle;
    case "cooling": return word(p.cooling);
    case "escrow": return side.addr.MilestoneEscrow;
    case "salesOracle": return side.addr.SalesOracle;
    case "observer": return ZERO_ADDR;
    case "loosen": return word(p.loosen);
    case "governance": return side.addr.TreasuryGovernance;
    case "self": return side.addr.TreasuryGovernance;
    case "judging": return word(p.judging);
  }
};

export const FSIDE: Side = { chainTag: "fisco", addr: { ...FADDR, TreasuryGovernance: F_GOV }, lender: lower(FKEYS.lender.address), oracle: lower(FKEYS.oracle.address) };
export const SSIDE: Side = { chainTag: SOURCE.chainTag, addr: { ...(Object.fromEntries(Object.entries(ADDR).map(([k, v]) => [k, lower(v)])) as Record<keyof typeof ADDR, Hex>), TreasuryGovernance: S_GOV }, lender: lower(KEYS.lender.address), oracle: lower(FKEYS.oracle.address) };

/** Constructor arguments as DeployFinal passes them. */
export function creationInput(name: keyof typeof FADDR, side: Side): Hex {
  const a = side.addr;
  const p = side.params ?? PARAMS;
  const args: Hex =
    name === "PlanRegistry"
      ? encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bool" }, { type: "uint64" }], [side.lender, a.Treasury, tag(SOURCE.deploymentId), tag(side.chainTag), false, p.judging])
      : name === "Treasury"
        ? encodeAbiParameters(
            [{ type: "address" }, { type: "address" }, { type: "uint64" }, { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint64" }] }, { type: "bytes32[]" }, { type: "bytes32[]" }],
            [a.PlanRegistry, side.oracle, p.cooling, [a.MilestoneEscrow, a.SalesOracle, ZERO_ADDR, p.loosen], p.payees, p.payouts],
          )
        : encodeAbiParameters([{ type: "address" }], [a.Treasury]);
  return `${artifactOf(name).bytecode}${args.slice(2)}` as Hex;
}

// ---- the simulated FISCO chain ----------------------------------------------------------------------------------

export interface TxFileJson {
  hash: Hex;
  rawSignedTx: Hex;
  rawSource: "sent" | "rebuilt";
  tx: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
  block: Record<string, unknown> | null;
  native: Record<string, unknown> | null;
}

/** ledger.json's block shape (pack.ts LedgerBlock), built as node4 would serve it. */
export interface LedgerBlockJson {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  txs: Record<string, unknown>[];
}

/** One 32-byte return word (a system call's native output). */
export const word = (n: bigint): Hex => encodeAbiParameters([{ type: "int256" }], [n]);
/** The Error(string) bytes FISCO puts in a refused tx's native output. */
export const errorString = (msg: string): Hex => `0x08c379a0${encodeAbiParameters([{ type: "string" }], [msg]).slice(2)}` as Hex;

export interface SendOptions {
  status?: "0x1" | "0x0";
  rawSource?: "sent" | "rebuilt";
  refused?: boolean;
  /** The native receipt's status and output (default: 0 / "0x" for a success, 16 / "0x" for a revert). */
  native?: { status: number; output: Hex };
}

export class FiscoChain {
  block = 0;
  time = 1_792_500_000n;
  readonly txs = new Map<string, TxFileJson>();
  /** Blocks 0..head as node4 holds them (block 0: genesis, no txs). */
  readonly ledger: LedgerBlockJson[] = [{ number: 0, hash: keccak256(toHex("fisco-genesis")), parentHash: `0x${"0".repeat(64)}`, timestamp: 1_792_500_000, txs: [] }];
  private readonly nonces = new Map<string, number>();
  private lastHash = keccak256(toHex("fisco-genesis"));

  nonceOf(a: PrivateKeyAccount): number {
    return this.nonces.get(a.address) ?? 0;
  }

  async send(from: PrivateKeyAccount, to: Hex | null, data: Hex, logs: readonly Log[], o: SendOptions = {}): Promise<TxFileJson> {
    const nonce = this.nonceOf(from);
    const raw = await from.signTransaction({ type: "legacy", chainId: 20_200, nonce, ...(to ? { to } : {}), data, gas: 15_000_000n, gasPrice: 0n, value: 0n });
    const hash = keccak256(raw);
    if (o.refused) {
      const file = { hash, rawSignedTx: raw, rawSource: "sent" as const, tx: null, receipt: null, block: null, native: null };
      this.txs.set(hash, file);
      return file;
    }
    this.nonces.set(from.address, nonce + 1);
    this.block += 1;
    this.time += 7n;
    const n = toHex(this.block);
    const blockHash = keccak256(toHex(`fisco-block-${this.block}`));
    const status = o.status ?? "0x1";
    const rawLogs = status === "0x1" ? logs.map((l, i) => ({ ...l, address: lower(l.address), blockNumber: n, blockHash, transactionHash: hash, transactionIndex: "0x0", logIndex: toHex(i), removed: false })) : [];
    const created = to === null ? lower(getContractAddress({ from: from.address, nonce: BigInt(nonce) })) : null;
    const receipt = {
      blockHash, blockNumber: n, contractAddress: created, cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x0", from: lower(from.address), gasUsed: "0x5208", logs: rawLogs,
      logsBloom: fiscoLogsBloom(rawLogs), status, to: to ? lower(to) : null, transactionHash: hash, transactionIndex: "0x0", type: "0x0",
    };
    const tx = { hash, from: lower(from.address), to: to ? lower(to) : null, input: data, nonce: toHex(nonce), blockHash, blockNumber: n, chainId: "0x4ee8", gas: toHex(15_000_000n), gasPrice: "0x0", type: "0x0", value: "0x0" };
    const block = { number: n, hash: blockHash, parentHash: this.lastHash, timestamp: toHex(this.time), transactions: [hash] };
    const nat = o.native ?? { status: status === "0x1" ? 0 : 16, output: "0x" as Hex };
    const native = {
      transactionHash: hash, hash: keccak256(toHex(`native-${hash}`)), blockNumber: this.block, status: nat.status, output: nat.output, from: lower(from.address), to: to ? lower(to) : "",
      gasUsed: "21000", contractAddress: created ?? "", logEntries: rawLogs.map((l) => ({ address: l.address.slice(2), topics: l.topics, data: l.data })), message: "", input: data, version: 0,
    };
    const ledgerTx = {
      hash, from: lower(from.address), to: to ? lower(to) : null, nonce, inputKeccak: keccak256(data),
      receipt: { transactionIndex: 0, status: status === "0x1" ? 1 : 0, gasUsed: "21000", ...(created ? { contractAddress: created } : {}), logs: rawLogs.map((l) => ({ address: l.address, topics: l.topics.map(lower), data: lower(l.data) })) },
    };
    this.ledger.push({ number: this.block, hash: blockHash, parentHash: this.lastHash, timestamp: Number(this.time), txs: [ledgerTx] });
    this.lastHash = blockHash;
    const file = { hash, rawSignedTx: raw, rawSource: o.rawSource ?? "sent", tx, receipt, block, native };
    this.txs.set(hash, file);
    return file;
  }
}

// ---- steps ------------------------------------------------------------------------------------------------------

export interface StepJson {
  seq: number;
  id: string;
  title: string;
  contract: string;
  function: string;
  signerRole: string;
  auth: string;
  amountMinor?: string;
  expected: "ok" | "refused";
  expectedError?: string;
  probe: { ok: boolean; error?: string };
  outcome: { kind: string; txHash?: string; rpcError?: { code: number; message: string } };
  reads: { label: string; before: string; after: string }[];
  nonce: { before: number; after: number };
  links: { recordsDenialOf?: string; sepoliaTx?: string };
  call?: { from: string; to: string; data: string; block: number };
}

export const fLog = (abi: unknown, address: string, name: string, args: Record<string, unknown>): Log => logOf(abi as Abi, address, name, args);
export const tLog = (name: string, args: Record<string, unknown>) => fLog(iTreasuryAbi, FADDR.Treasury, name, args);
export const eLog = (name: string, args: Record<string, unknown>) => fLog(iMilestoneEscrowAbi, FADDR.MilestoneEscrow, name, args);
export const domainOf = (contract: keyof typeof FADDR, side: "fisco" | "source" = "fisco") =>
  side === "fisco"
    ? hogeeDomain({ verifyingContract: FADDR[contract], chainTag: tag("fisco"), deploymentId: tag(SOURCE.deploymentId) })
    : hogeeDomain({ verifyingContract: ADDR[contract], chainTag: tag(SOURCE.chainTag), deploymentId: tag(SOURCE.deploymentId) });
export const callOf = (abi: unknown, functionName: string, args: readonly unknown[]): Hex => encodeFunctionData({ abi: abi as Abi, functionName, args } as never);
export const EXPIRY = 1_999_999_000n;

type SourceRow = { kind: string; txHash: string; rawSignedTx: string };
export const sourceRows = (s: Source) => {
  const actions = JSON.parse(s.files["chain-actions.json"] as string) as SourceRow[];
  const payments = (JSON.parse(s.files["payments.json"] as string) as { payment: { kind: string; txHash: string }; milestoneIdx: number | null; rawSignedTx: string }[]).map((p) => ({ kind: p.payment.kind, idx: p.milestoneIdx, txHash: p.payment.txHash, rawSignedTx: p.rawSignedTx }));
  const action = (kind: string, nth = 0) => actions.filter((a) => a.kind === kind)[nth] as SourceRow;
  const payment = (kind: string, idx: number) => payments.find((p) => p.kind === kind && p.idx === idx) as SourceRow;
  return { action, payment };
};
export const dataOf = (raw: string): Hex => parseTransaction(raw as Hex).data as Hex;

export function planApprovalOf(m: PlanManifest, nonce: bigint) {
  return {
    planId: m.planId as Hex, version: m.version, prevPlanHash: m.prevPlanHash as Hex, planHash: hashObject(m) as Hex, countryPackHash: m.countryPackHash as Hex,
    linesHash: hashLines(manifestToLines(m)), stagesHash: hashStages(manifestToStages(m)), totalMinor: BigInt(m.totalMinor), reserveBps: m.reserveBps,
    agent: m.agent.address as Hex, agentExpiry: BigInt(m.agent.expiresAt), deploymentId: tag(SOURCE.deploymentId), nonce, expiry: EXPIRY,
  };
}

export interface PackFixture {
  readonly files: Record<string, string>;
  readonly source: Source;
  /** The identity the checker pins for this fixture (FINAL_2's counterpart): the source run and its broadcast file. */
  readonly identity: SourceIdentity;
  readonly dir: string;
  /** Tx hash of each step id. */
  readonly stepTx: Readonly<Record<string, Hex>>;
}

export const lowerMessage = (m: Record<string, unknown>): Record<string, string | boolean> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "boolean" ? v : typeof v === "string" ? v.toLowerCase() : String(v)]));
export const typedData = (kind: keyof typeof hogeeTypes, domain: { verifyingContract: string; salt: Hex }, message: Record<string, unknown>) => ({
  domain: { name: "Hogee", version: "1", verifyingContract: lower(domain.verifyingContract), salt: domain.salt },
  types: { [kind]: hogeeTypes[kind].map((t) => ({ ...t })) },
  primaryType: kind,
  message: lowerMessage(message),
});

