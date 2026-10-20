/**
 * Runs one catalogue step on the mirror and records it (steps.json row + txs/<hash>.json):
 *   eth_call probe at the current block → sign locally (legacy, chain 20200, gas price 0, explicit gas) →
 *   eth_sendRawTransaction of those exact bytes → wait for the Web3 receipt → the native receipt → outcome
 *     mined          receipt status 0x1 (native status 0)
 *     mined-reverted receipt status 0x0 (a contract revert, or the chain's own refusal: a frozen account, a banned
 *                    method; FISCO mines it with explicit gas and the nonce advances; native status says which)
 *     rpc-refused    the send answered a JSON-RPC error and no receipt exists (the nonce must not move)
 *     probe-only     (C steps) the eth_call alone, recorded with the exact call and block; nothing is signed or sent.
 * Steps given reads record them before and after. Fail closed:
 *   - the calldata must decode as the catalogue's function of the catalogue's target (a Hogee contract, or an
 *     allow-listed FISCO system call, system.ts), sent by the catalogue's role (the regulator sends the G/V steps);
 *   - only a JSON-RPC error answered to eth_sendRawTransaction itself is an rpc-refused outcome; a failed pre-send
 *     guard (FiscoRpc throws GuardError) stops the run;
 *   - a receipt status other than 0x1/0x0 stops the run (late receipts after a refused send included);
 *   - every mined tx's native receipt (node0 native RPC, retried until served) must name the same tx and block, with
 *     status 0 exactly when the Web3 status is 0x1;
 *   - node-supplied text (probe errors, refusal messages, read values) is cleaned of control characters;
 *   - a refusal whose probe SUCCEEDS is never sent (it would have changed state), nor one whose probe fails with
 *     another error than the step's expected one (its own expectedError, else the catalogue's): a refusal is sent only
 *     to record the chain refusing it for the stated reason; a probe-only step whose probe fails,
 *     or a G/V step whose probe fails or whose `checkProbe` refuses the return value, stops the run unsent;
 *   - an expected-ok step that is not mined, or an expected refusal that is, stops the run;
 *   - a node that answers another hash than keccak256(raw) stops the run.
 */
import { decodeRevertData, HOGEE_ABIS, shortErrorReason } from "@hogee/chain";
import { decodeFunctionData, keccak256, type Abi, type Hex, type LocalAccount } from "viem";
import type { CatalogueEntry, ChainRefusal } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import { Step, TxFile, type DeployedName, type FiscoBlock, type NativeReceipt, type Role } from "../../../../tools/verify-evidence/src/fisco/pack";
import { decodeSystemCall, isSystemName, RPC_REFUSAL_CODE, SYSTEM } from "../../../../tools/verify-evidence/src/fisco/system";
import type { NativeRpc } from "./native-rpc";
import { JsonRpcError, nodeText, type FiscoRpc } from "./rpc";
import { signLegacy } from "./sign";

export class StepError extends Error {
  override readonly name = "StepError";
}

export interface ReadSpec {
  readonly label: string;
  /** A short string (≤ 200 chars): the value at the current block. */
  read(): Promise<string>;
}

export interface StepCall {
  readonly entry: CatalogueEntry;
  readonly data: Hex;
  readonly gas: bigint;
  /** Recorded before and after (any step that has them). */
  readonly reads?: readonly ReadSpec[];
  readonly links?: Step["links"];
  /** Overrides the catalogue's expectedError (T28a: derived from the signed expiry and the block time). */
  readonly expectedError?: string;
  /**
   * G/V steps: the probe must succeed, and this sees its return data before anything is signed; throwing stops the
   * run with nothing sent (a governance call that would return non-zero must never reach the chain).
   */
  readonly checkProbe?: (ret: Hex) => void;
}

export type SenderRole = Exclude<Role, "deployer" | "observer">;

export interface RunnerOptions {
  readonly receiptTimeoutMs: number;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  receiptTimeoutMs: 90_000,
  pollMs: 250,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface StepResult {
  readonly step: Step;
  /** null for a probe-only step (nothing sent). */
  readonly tx: TxFile | null;
}

const MAX_VALUE = 200;
const MAX_MESSAGE = 500;
const clip = (s: string, n: number): string => (s.length === 0 ? "-" : s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Node-supplied text as a pack field: control characters replaced, clipped. */
const fieldText = (s: string, n: number): string => clip(nodeText(s), n);

/** The chain's own eth_call refusals by JSON-RPC code (the code is authoritative, the Error(string) text informative). */
const CHAIN_REFUSAL_OF_CODE: ReadonlyMap<number, ChainRefusal> = new Map([
  [RPC_REFUSAL_CODE.accountFrozen, "AccountFrozen"],
  [RPC_REFUSAL_CODE.permissionDenied, "PermissionDenied"],
]);

/**
 * The probe's error: the chain's refusal (JSON-RPC code 22 AccountFrozen, 18 PermissionDenied), else the decoded Hogee
 * error name when the node returns revert data, else the node's message.
 */
export function probeErrorOf(error: unknown): string {
  if (error instanceof JsonRpcError) {
    const chain = CHAIN_REFUSAL_OF_CODE.get(error.code);
    if (chain) return chain;
    const data = typeof error.data === "string" ? (error.data as Hex) : null;
    const decoded = data ? decodeRevertData(data) : null;
    if (decoded) return decoded.name;
    return fieldText(`rpc ${error.code}: ${error.message}`, MAX_MESSAGE);
  }
  return fieldText(shortErrorReason(error, MAX_MESSAGE), MAX_MESSAGE);
}

/** mined / mined-reverted from a receipt's status; any other status stops the run. */
function minedOutcome(receipt: Record<string, unknown>, hash: Hex): Step["outcome"] {
  if (receipt.status === "0x1") return { kind: "mined", txHash: hash };
  if (receipt.status === "0x0") return { kind: "mined-reverted", txHash: hash };
  throw new StepError(`receipt ${hash}: status ${nodeText(String(receipt.status), 20)}`);
}

function quantityToNumber(q: unknown, field: string): number {
  if (typeof q !== "string" || !/^0x[0-9a-fA-F]+$/.test(q)) throw new StepError(`${field} is not a quantity`);
  return Number(BigInt(q));
}

interface Probe {
  readonly result: Step["probe"];
  readonly ret: Hex | null;
}

export class StepRunner {
  private seq = 0;
  readonly steps: Step[] = [];
  readonly txs = new Map<string, TxFile>();

  constructor(
    private readonly rpc: FiscoRpc,
    private readonly native: NativeRpc,
    private readonly contracts: Readonly<Record<DeployedName, Hex>>,
    private readonly signers: Readonly<Record<SenderRole, LocalAccount>>,
    private readonly opts: RunnerOptions = DEFAULT_RUNNER_OPTIONS,
  ) {}

  private senderOf(role: Role): LocalAccount {
    if (role === "deployer" || role === "observer") throw new StepError(`the ${role} never sends a replay step`);
    return this.signers[role];
  }

  /** The target address once the calldata decodes as the entry's function (system calls: only the allow-list). */
  private checkCall(c: StepCall): Hex {
    const { entry } = c;
    if (c.gas <= 0n) throw new StepError(`${entry.id}: explicit gas required`);
    if (isSystemName(entry.contract)) {
      const call = decodeSystemCall(entry.contract, c.data);
      if (!call) throw new StepError(`${entry.id}: the calldata is not an allow-listed ${entry.contract} call`);
      if (call.name !== entry.function) throw new StepError(`${entry.id}: the calldata calls ${call.name}, the catalogue says ${entry.function}`);
      return SYSTEM[entry.contract];
    }
    let fn: string;
    try {
      fn = decodeFunctionData({ abi: HOGEE_ABIS[entry.contract] as Abi, data: c.data }).functionName;
    } catch {
      throw new StepError(`${entry.id}: the calldata does not decode for ${entry.contract}`);
    }
    if (fn !== entry.function) throw new StepError(`${entry.id}: the calldata calls ${fn}, the catalogue says ${entry.function}`);
    return this.contracts[entry.contract];
  }

  private async readAll(reads: readonly ReadSpec[]): Promise<string[]> {
    const out: string[] = [];
    for (const r of reads) out.push(fieldText(await r.read(), MAX_VALUE));
    return out;
  }

  private async probe(from: Hex, to: Hex, data: Hex, gas: bigint): Promise<Probe> {
    try {
      const ret = await this.rpc.call({ from, to, data, gas });
      return { result: { ok: true }, ret };
    } catch (error: unknown) {
      return { result: { ok: false, error: probeErrorOf(error) }, ret: null };
    }
  }

  private async waitReceipt(hash: Hex): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.opts.receiptTimeoutMs;
    for (;;) {
      const r = await this.rpc.receipt(hash);
      if (r) return r;
      if (Date.now() > deadline) throw new StepError(`no receipt for ${hash} within ${this.opts.receiptTimeoutMs} ms`);
      await this.opts.sleep(this.opts.pollMs);
    }
  }

  /** The block of a receipt, as the pack keeps it (tx hashes only). */
  async blockOf(receipt: Record<string, unknown>): Promise<FiscoBlock> {
    const n = quantityToNumber(receipt.blockNumber, "receipt.blockNumber");
    const b = await this.rpc.block(n);
    if (!b) throw new StepError(`block ${n} is not served`);
    const txs = Array.isArray(b.transactions) ? b.transactions.map((t) => (typeof t === "string" ? t : (t as { hash?: string }).hash)) : [];
    if (txs.some((t) => typeof t !== "string")) throw new StepError(`block ${n}: transactions are not hashes`);
    return { number: String(b.number), hash: String(b.hash), parentHash: String(b.parentHash), timestamp: String(b.timestamp), transactions: txs as string[] };
  }

  /**
   * The native receipt of a mined tx, once node0's native RPC serves it, checked against its Web3 receipt: the same tx
   * and block, and native status 0 exactly when the Web3 status is 0x1. Kept as served.
   */
  async nativeReceipt(hash: Hex, receipt: Record<string, unknown>): Promise<NativeReceipt> {
    const n = await this.native.receiptWhenServed(hash, { timeoutMs: this.opts.receiptTimeoutMs, pollMs: this.opts.pollMs, sleep: this.opts.sleep });
    if (n.blockNumber !== quantityToNumber(receipt.blockNumber, "receipt.blockNumber")) throw new StepError(`native receipt ${hash}: block ${n.blockNumber}, the Web3 receipt says ${nodeText(String(receipt.blockNumber), 20)}`);
    if ((n.status === 0) !== (receipt.status === "0x1")) throw new StepError(`native receipt ${hash}: status ${n.status} with Web3 status ${nodeText(String(receipt.status), 20)}`);
    return n as NativeReceipt;
  }

  /**
   * Sends exactly `raw`; returns the outcome and (when mined) the receipt. Only a JSON-RPC error answered to the send
   * itself can make an rpc-refused outcome: the pre-send guards throw GuardError, which stops the run.
   */
  private async send(raw: Hex, hash: Hex): Promise<{ outcome: Step["outcome"]; receipt: Record<string, unknown> | null }> {
    let served: unknown;
    try {
      served = await this.rpc.sendRawTransaction(raw);
    } catch (error: unknown) {
      if (!(error instanceof JsonRpcError)) throw error;
      await this.opts.sleep(this.opts.pollMs);
      const late = await this.rpc.receipt(hash);
      if (!late) return { outcome: { kind: "rpc-refused", txHash: hash, rpcError: { code: error.code, message: fieldText(error.message, MAX_MESSAGE) } }, receipt: null };
      return { outcome: minedOutcome(late, hash), receipt: late };
    }
    if (typeof served !== "string" || served.toLowerCase() !== hash) throw new StepError(`the node answered tx hash ${nodeText(String(served), 80)}, not keccak256(raw) ${hash}`);
    const receipt = await this.waitReceipt(hash);
    return { outcome: minedOutcome(receipt, hash), receipt };
  }

  /** The steps.json row common to every outcome. */
  private row(c: StepCall, rest: Pick<Step, "probe" | "outcome" | "reads" | "nonce"> & { call?: Step["call"] }): Step {
    const { entry } = c;
    const refusal = entry.expected === "refused";
    const expectedError = c.expectedError ?? entry.expectedError;
    this.seq += 1;
    const step: Step = {
      seq: this.seq,
      id: entry.id,
      title: entry.title,
      contract: entry.contract,
      function: entry.function,
      signerRole: entry.signerRole,
      auth: entry.auth,
      ...(entry.amountMinor ? { amountMinor: entry.amountMinor } : {}),
      expected: entry.expected,
      ...(refusal && expectedError ? { expectedError } : {}),
      probe: rest.probe,
      ...(rest.call ? { call: rest.call } : {}),
      outcome: rest.outcome,
      reads: rest.reads,
      nonce: rest.nonce,
      links: c.links ?? {},
    };
    // Schema-checked now, not only when the pack is written: a malformed record must not cost the whole run.
    return Step.parse(step);
  }

  /** C steps: the eth_call only, at a head that did not move around it; nothing is signed or sent. */
  private async probeOnly(c: StepCall, to: Hex, from: Hex): Promise<StepResult> {
    const reads = c.reads ?? [];
    const before = await this.readAll(reads);
    const nonceBefore = await this.rpc.nonceOf(from);
    const block = await this.rpc.blockNumber();
    const probe = await this.probe(from, to, c.data, c.gas);
    if (!probe.result.ok) throw new StepError(`${c.entry.id}: the probe-only call failed (${probe.result.error ?? "error"}); stopping`);
    if ((await this.rpc.blockNumber()) !== block) throw new StepError(`${c.entry.id}: the head moved during the probe; its block is not known`);
    const after = await this.readAll(reads);
    const nonceAfter = await this.rpc.nonceOf(from);
    if (nonceAfter !== nonceBefore) throw new StepError(`${c.entry.id}: the sender's nonce moved during a probe-only step`);
    const step = this.row(c, {
      probe: probe.result,
      call: { from, to: to.toLowerCase() as Hex, data: c.data.toLowerCase(), block },
      outcome: { kind: "probe-only" },
      reads: reads.map((r, i) => ({ label: r.label, before: before[i] as string, after: after[i] as string })),
      nonce: { before: nonceBefore, after: nonceAfter },
    });
    this.steps.push(step);
    return { step, tx: null };
  }

  async run(c: StepCall): Promise<StepResult> {
    const { entry } = c;
    const to = this.checkCall(c);
    const sender = this.senderOf(entry.signerRole);
    const from = sender.address.toLowerCase() as Hex;
    if (entry.probeOnly) return this.probeOnly(c, to, from);
    const refusal = entry.expected === "refused";
    const reads = c.reads ?? [];
    const before = await this.readAll(reads);
    const nonceBefore = await this.rpc.nonceOf(from);
    const probe = await this.probe(from, to, c.data, c.gas);
    if (refusal && probe.result.ok) throw new StepError(`${entry.id}: the probe of an expected refusal succeeded; not sent`);
    const expectedError = c.expectedError ?? entry.expectedError;
    if (refusal && (!expectedError || probe.result.error !== expectedError)) {
      throw new StepError(`${entry.id}: the probe of an expected refusal failed with ${probe.result.error ?? "nothing"}, not ${expectedError ?? "(no expected error)"}; not sent`);
    }
    if (c.checkProbe) {
      if (!probe.ret) throw new StepError(`${entry.id}: the governance call's probe failed (${probe.result.error ?? "error"}); not sent`);
      c.checkProbe(probe.ret);
    }
    // An expected success whose probe fails is still sent: the probe runs at the latest block, whose timestamp on FISCO
    // (no empty blocks) can lag the wall clock by minutes, so a time-gated call (cooling, auto-release) may fail there
    // and pass when mined. The receipt decides; steps.json keeps the probe error, and the checker fails an expected
    // success that did not mine with status 0x1. (G/V steps are not time-gated: their probe must pass, above.)
    const signed = await signLegacy(sender, { to, data: c.data, nonce: nonceBefore, gas: c.gas });
    const { outcome, receipt } = await this.send(signed.raw, signed.hash);
    const native = receipt ? await this.nativeReceipt(signed.hash, receipt) : null;
    const after = await this.readAll(reads);
    const nonceAfter = await this.rpc.nonceOf(from);
    const tx: TxFile = TxFile.parse({
      hash: signed.hash,
      rawSignedTx: signed.raw.toLowerCase(),
      rawSource: "sent",
      tx: receipt ? ((await this.rpc.tx(signed.hash)) as TxFile["tx"]) : null,
      receipt: receipt as TxFile["receipt"],
      block: receipt ? await this.blockOf(receipt) : null,
      native,
    });
    const step = this.row(c, {
      probe: probe.result,
      outcome,
      reads: reads.map((r, i) => ({ label: r.label, before: before[i] as string, after: after[i] as string })),
      nonce: { before: nonceBefore, after: nonceAfter },
    });
    this.steps.push(step);
    this.txs.set(signed.hash, tx);
    if (!refusal && outcome.kind !== "mined") throw new StepError(`${entry.id}: expected ok, got ${outcome.kind}${probe.result.error ? ` (probe: ${probe.result.error})` : ""}`);
    if (refusal && outcome.kind === "mined") throw new StepError(`${entry.id}: an expected refusal was mined successfully`);
    if (outcome.kind === "rpc-refused" && nonceAfter !== nonceBefore) throw new StepError(`${entry.id}: refused at the RPC but the nonce moved`);
    if (tx.tx && String(tx.tx.hash).toLowerCase() !== signed.hash) throw new StepError(`${entry.id}: the served tx has another hash`);
    return { step, tx };
  }

  /** P0 / P1: reads at the current block. */
  async snapshot(reads: readonly ReadSpec[]): Promise<{ block: number; reads: { label: string; value: string }[] }> {
    const block = await this.rpc.blockNumber();
    const values = await this.readAll(reads);
    return { block, reads: reads.map((r, i) => ({ label: r.label, value: values[i] as string })) };
  }
}

/** keccak256 of calldata (recordDenied's proposalHash). */
export const proposalHashOf = (data: Hex): Hex => keccak256(data);
