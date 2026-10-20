/**
 * Transactions and receipts, offline. The rows' DB labels do not choose what is checked (run-6 row-labelled view):
 *   "transactions": EVERY row that names a tx carries its raw signed bytes; they hash to the tx hash, the recovered
 *     sender is the row's signer, the nonce is the row's, the call goes to a deployment contract, and every payment row
 *     equals its calldata (calls.ts). A CANCELLED row proves its cancellation with the tx it names as its nonce's
 *     consumer: in the bundle (raw bytes and receipt), mined, with the row's signer and nonce.
 *   "receipts": every row that names a tx has its receipt (a proven CANCELLED row is the only exception); each receipt
 *     belongs to a row's tx (hash, from, to) or is a CANCELLED row's consumer; its status matches the row's state (a
 *     mined tx must be labelled mined), its block is in blocks.json, its logs are in order, from deployment contracts,
 *     decode as Hogee events and match its logsBloom; a successful payment tx carries exactly its row's event.
 * The bloom is recomputed from the same logs, so it only ties a log to the bundle's own receipt: chain truth comes from
 * the anchor (anchor.ts), compared with the chain by a person or by `--rpc`.
 * The decoded events (in chain order) feed the plan, signature and replay checks.
 */
import { decodeEventLog, keccak256, type Hex } from "viem";
import { hogeeEventsAbi } from "./abi";
import type { ChainActionEntry, ContractName, ParsedBundle, PaymentEntry, RawReceipt } from "./bundle";
import { bindPaymentCall, bindPaymentEvents, decodeCall, type DecodedCall } from "./calls";
import { parseSignedTx, type ParsedTx } from "./crypto";
import { hexToBytesOrNull, Problems, quantity, sameHex, type VerifyCheck } from "./util";

export interface ChainEvent {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly contract: ContractName;
  readonly txHash: string;
  readonly blockNumber: bigint;
  /** The tx's index in its block (orders a reverted call, which has no log, among the events). */
  readonly txIndex: number;
  readonly logIndex: number;
  readonly timestamp: bigint | null;
  /** Recovered sender of the tx that emitted it (null when the tx bytes are not in the bundle). */
  readonly sender: string | null;
}

/** A row's tx as the bundle proves it: signed bytes, the Hogee call they make, and the receipt with its events. */
export interface ChainTx {
  readonly hash: string;
  readonly tx: ParsedTx | null;
  readonly contract: ContractName | null;
  readonly call: DecodedCall | null;
  readonly receipt: RawReceipt | null;
  /** Decoded events of the receipt (empty when it reverted or is absent). */
  readonly events: readonly ChainEvent[];
}

type Row = { readonly kind: "payment"; readonly entry: PaymentEntry } | { readonly kind: "action"; readonly entry: ChainActionEntry };

const SUCCESS_PAYMENT_STATES = new Set(["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"]);
const SUCCESS_ACTION_STATES = new Set(["INCLUDED", "FINALIZED"]);

const rowTx = (r: Row): string | null => (r.kind === "payment" ? (r.entry.payment.txHash ?? null) : r.entry.txHash);
const rowId = (r: Row): string => (r.kind === "payment" ? r.entry.payment.paymentId : r.entry.actionId);
const rowState = (r: Row): string => (r.kind === "payment" ? r.entry.payment.state : r.entry.state);
const rowBlock = (r: Row): number | null => (r.kind === "payment" ? (r.entry.payment.block ?? null) : r.entry.block);
const isSuccess = (r: Row): boolean => (r.kind === "payment" ? SUCCESS_PAYMENT_STATES : SUCCESS_ACTION_STATES).has(rowState(r));

/**
 * Every row of the bundle that names a tx, by lowercase tx hash. A payment adopted from a chain action's tx (e.g. an
 * executed reserve withdrawal) shares its hash with that action; two payments (or two actions) naming one tx would
 * count one transfer twice and are a problem.
 */
function rowsByTx(b: ParsedBundle, p: Problems): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  const rows: Row[] = [...b.payments.map((entry) => ({ kind: "payment" as const, entry })), ...b.chainActions.map((entry) => ({ kind: "action" as const, entry }))];
  for (const r of rows) {
    const tx = rowTx(r)?.toLowerCase();
    if (!tx) continue;
    const list = out.get(tx) ?? [];
    const twin = list.find((x) => x.kind === r.kind);
    if (twin) p.add(`${rowId(r)} and ${rowId(twin)} name the same tx ${tx}`);
    else out.set(tx, [...list, r]);
  }
  return out;
}

export function contractOf(b: ParsedBundle, address: string): ContractName | null {
  for (const [name, c] of Object.entries(b.contracts.contracts)) if (c && sameHex(c.address, address)) return name as ContractName;
  return null;
}

/** 2048-bit bloom of the logs' addresses and topics (yellow paper M3:2048). */
export function logsBloom(logs: readonly { address: string; topics: readonly string[] }[]): Hex {
  const bloom = new Uint8Array(256);
  const add = (h: string) => {
    const hash = hexToBytesOrNull(keccak256(h as Hex)) as Uint8Array;
    for (const i of [0, 2, 4]) {
      const bit = (((hash[i] as number) << 8) | (hash[i + 1] as number)) & 2047;
      bloom[255 - (bit >> 3)] = (bloom[255 - (bit >> 3)] as number) | (1 << (bit & 7));
    }
  };
  for (const log of logs) {
    add(log.address.toLowerCase());
    for (const t of log.topics) add(t.toLowerCase());
  }
  let hex = "0x";
  for (const x of bloom) hex += x.toString(16).padStart(2, "0");
  return hex as Hex;
}

/** The raw signed bytes of a row's tx: hash, signer, nonce, chain, destination. */
function parseRowTx(b: ParsedBundle, r: Row, txHash: string, p: Problems): ParsedTx | null {
  const raw = r.entry.rawSignedTx;
  if (!raw) {
    p.add(`${rowId(r)}: names tx ${txHash} without its raw signed bytes`);
    return null;
  }
  const tx = parseSignedTx(raw as Hex);
  if (typeof tx === "string") {
    p.add(`${rowId(r)}: ${tx}`);
    return null;
  }
  if (tx.hash !== txHash) p.add(`${rowId(r)}: keccak256(raw tx) is ${tx.hash}, not ${txHash}`);
  if (!sameHex(tx.from, r.entry.signerAddress)) p.add(`${rowId(r)}: the tx is signed by ${tx.from}, not the row's signer`);
  if (r.entry.nonce !== null && BigInt(r.entry.nonce) !== BigInt(tx.nonce)) p.add(`${rowId(r)}: the tx has nonce ${tx.nonce}, not the row's ${r.entry.nonce}`);
  if (tx.chainId !== null && tx.chainId !== b.contracts.chainId) p.add(`${rowId(r)}: the tx is for chain ${tx.chainId}`);
  if (!tx.to || !contractOf(b, tx.to)) p.add(`${rowId(r)}: the tx does not call a deployment contract`);
  return tx;
}

/** A CANCELLED row's proof: the consumer's bytes, its signer and nonce are the row's (its receipt is checked below). */
function checkConsumer(b: ParsedBundle, e: PaymentEntry, own: ParsedTx | null, p: Problems, consumers: Map<string, ParsedTx>): void {
  const id = e.payment.paymentId;
  const c = e.nonceConsumedBy;
  if (e.payment.state !== "CANCELLED") {
    if (c) p.add(`${id}: only a CANCELLED row names a nonce consumer`);
    return;
  }
  if (!c?.rawSignedTx) return p.add(`${id} is CANCELLED without the signed tx that consumed its nonce`);
  const tx = parseSignedTx(c.rawSignedTx as Hex);
  if (typeof tx === "string") return p.add(`${id}: its nonce consumer: ${tx}`);
  if (tx.hash !== c.txHash.toLowerCase()) p.add(`${id}: keccak256(consumer raw tx) is ${tx.hash}, not ${c.txHash}`);
  if (sameHex(tx.hash, e.payment.txHash)) p.add(`${id}: names its own tx as the consumer of its nonce`);
  if (!sameHex(tx.from, e.signerAddress)) p.add(`${id}: its nonce consumer is signed by ${tx.from}, not the row's signer`);
  if (own && tx.nonce !== own.nonce) p.add(`${id}: its nonce consumer has nonce ${tx.nonce}, not the row's ${own.nonce}`);
  if (tx.chainId !== null && tx.chainId !== b.contracts.chainId) p.add(`${id}: its nonce consumer is for chain ${tx.chainId}`);
  consumers.set(tx.hash, tx);
}

function checkStatus(r: Row, receipt: RawReceipt, p: Problems): void {
  const state = rowState(r);
  const success = isSuccess(r);
  const reverted = state === "REVERTED";
  if (success && receipt.status !== "0x1") p.add(`${rowId(r)} is ${state} but its receipt reverted`);
  if (reverted && receipt.status !== "0x0") p.add(`${rowId(r)} is REVERTED but its receipt succeeded`);
  if (!success && !reverted) p.add(`${rowId(r)} is ${state} but its tx was mined (a mined tx must be labelled mined)`);
  const block = rowBlock(r);
  if (block !== null && BigInt(block) !== quantity(receipt.blockNumber)) p.add(`${rowId(r)}: block ${block} is not the receipt's block`);
}

function decodeLogs(b: ParsedBundle, receipt: RawReceipt, sender: string | null, timestamp: bigint | null, p: Problems, out: ChainEvent[]): void {
  let last = -1;
  for (const log of receipt.logs) {
    const where = `${receipt.transactionHash} log ${log.logIndex}`;
    const index = Number(quantity(log.logIndex) ?? -1n);
    if (index <= last) p.add(`${where} is out of order or repeated`);
    last = Math.max(last, index);
    if (!sameHex(log.transactionHash, receipt.transactionHash) || !sameHex(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber || log.removed === true) {
      p.add(`${where} does not belong to its receipt`);
    }
    const contract = contractOf(b, log.address);
    if (!contract) {
      p.add(`${where} comes from ${log.address}, not a deployment contract`);
      continue;
    }
    try {
      const ev = decodeEventLog({ abi: hogeeEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
      out.push({ name: ev.eventName, args: ev.args as Record<string, unknown>, contract, txHash: receipt.transactionHash.toLowerCase(), blockNumber: quantity(receipt.blockNumber) ?? 0n, txIndex: Number(quantity(receipt.transactionIndex) ?? 0n), logIndex: index, timestamp, sender });
    } catch {
      p.add(`${where} is not a Hogee event`);
    }
  }
  if (receipt.status === "0x0" && receipt.logs.length > 0) p.add(`${receipt.transactionHash} reverted but has logs`);
  if (logsBloom(receipt.logs).toLowerCase() !== receipt.logsBloom.toLowerCase()) p.add(`${receipt.transactionHash}: logsBloom is not the bloom of its logs`);
}

/** Chain order: block, then tx index, then log index. */
export const chainOrder = (x: ChainEvent, y: ChainEvent): number =>
  x.blockNumber !== y.blockNumber ? (x.blockNumber < y.blockNumber ? -1 : 1) : x.txIndex !== y.txIndex ? x.txIndex - y.txIndex : x.logIndex - y.logIndex;

export interface ChainView {
  readonly checks: VerifyCheck[];
  /** Decoded events of every row-owned receipt, in chain order (block, log index). */
  readonly events: readonly ChainEvent[];
  /** Recovered senders by lowercase tx hash. */
  readonly senders: ReadonlyMap<string, string>;
  /** Every row tx by lowercase hash, with its call and receipt. */
  readonly txs: ReadonlyMap<string, ChainTx>;
  /** Block times by block number (decimal string). */
  readonly times: ReadonlyMap<string, bigint>;
}

const isCancelled = (r: Row): boolean => r.kind === "payment" && r.entry.payment.state === "CANCELLED";

export function checkChain(b: ParsedBundle): ChainView {
  const txp = new Problems("transactions");
  const rec = new Problems("receipts");
  const byTx = rowsByTx(b, txp);
  const blocks = new Map(b.blocks.map((x) => [quantity(x.number)?.toString() ?? "", x]));
  const parsed = new Map<string, ParsedTx>();
  const consumers = new Map<string, ParsedTx>();
  for (const [hash, owners] of byTx) {
    for (const r of owners) {
      const tx = parseRowTx(b, r, hash, txp);
      if (tx && !parsed.has(hash)) parsed.set(hash, tx);
      if (r.kind === "payment") checkConsumer(b, r.entry, tx, txp, consumers);
      if (tx && r.kind === "payment") bindPaymentCall(r.entry, decodeCall(tx, tx.to ? contractOf(b, tx.to) : null), txp);
      if (!b.receipts.has(hash) && !isCancelled(r)) rec.add(`${rowId(r)} is ${rowState(r)} and names tx ${hash}, but its receipt is not in the bundle (a row that names a tx must show it mined)`);
    }
  }
  for (const e of b.payments) {
    if (e.payment.txHash) continue;
    if (e.nonceConsumedBy) txp.add(`${e.payment.paymentId}: names a nonce consumer but no tx`);
    if (e.payment.state === "CANCELLED") txp.add(`${e.payment.paymentId} is CANCELLED but names no tx`);
  }
  for (const hash of consumers.keys()) if (!b.receipts.has(hash)) rec.add(`the tx ${hash} that consumed a CANCELLED row's nonce has no receipt in the bundle`);

  const senders = new Map<string, string>();
  const events: ChainEvent[] = [];
  const txs = new Map<string, ChainTx>();
  for (const [hash, receipt] of b.receipts) {
    const owners = byTx.get(hash) ?? [];
    const consumer = consumers.get(hash);
    if (owners.length === 0 && !consumer) {
      rec.add(`receipt ${hash} belongs to no payment or chain action`);
      continue;
    }
    for (const r of owners) checkStatus(r, receipt, rec);
    const tx = parsed.get(hash) ?? consumer ?? null;
    if (tx) {
      senders.set(hash, tx.from);
      if (!sameHex(receipt.from, tx.from) || !sameHex(receipt.to, tx.to)) rec.add(`${hash}: the receipt's from/to are not the signed tx's`);
    }
    const block = blocks.get(quantity(receipt.blockNumber)?.toString() ?? "-");
    if (!block || !sameHex(block.hash, receipt.blockHash)) rec.add(`${hash}: block ${receipt.blockNumber} is not in blocks.json with the receipt's block hash`);
    if (owners.length === 0) {
      // Only a CANCELLED row's consumer: it may be any tx of the signer, but one that touched this deployment is an effect no row explains.
      if (receipt.logs.some((l) => contractOf(b, l.address))) rec.add(`${hash} consumed a CANCELLED row's nonce and has deployment logs, but no row owns it`);
      if (logsBloom(receipt.logs).toLowerCase() !== receipt.logsBloom.toLowerCase()) rec.add(`${hash}: logsBloom is not the bloom of its logs`);
      continue;
    }
    const mine: ChainEvent[] = [];
    decodeLogs(b, receipt, tx?.from ?? null, block ? quantity(block.timestamp) : null, rec, mine);
    if (receipt.status === "0x1") for (const r of owners) if (r.kind === "payment" && isSuccess(r)) bindPaymentEvents(r.entry, mine, rec);
    events.push(...mine);
    const contract = tx?.to ? contractOf(b, tx.to) : null;
    txs.set(hash, { hash, tx, contract, call: tx ? decodeCall(tx, contract) : null, receipt, events: mine });
  }
  for (const [hash, tx] of parsed) {
    if (txs.has(hash)) continue;
    const contract = tx.to ? contractOf(b, tx.to) : null;
    txs.set(hash, { hash, tx, contract, call: decodeCall(tx, contract), receipt: null, events: [] });
  }
  events.sort(chainOrder);
  for (let i = 1; i < events.length; i += 1) {
    const [a, c] = [events[i - 1] as ChainEvent, events[i] as ChainEvent];
    if (a.blockNumber === c.blockNumber && a.logIndex === c.logIndex) rec.add(`two logs at block ${c.blockNumber} index ${c.logIndex}`);
  }
  const cancelled = consumers.size > 0 ? `; ${consumers.size} CANCELLED row(s) proven by a mined tx with the same signer and nonce` : "";
  const times = new Map(b.blocks.map((x) => [quantity(x.number)?.toString() ?? "", quantity(x.timestamp) ?? 0n]));
  return {
    times,
    checks: [txp.result(`${parsed.size} signed transactions bind to their rows${cancelled}`), rec.result(`${b.receipts.size} receipts, ${events.length} events decoded; every row tx is accounted for`)],
    events,
    senders,
    txs,
  };
}
