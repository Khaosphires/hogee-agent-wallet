/**
 * The Sepolia timestamp of a FISCO mirror pack (check "Sepolia timestamp"): one public Sepolia tx, sent by the
 * hogee-deployer to itself with value 0, whose input is the plain ASCII anchor text naming the pack and the
 * keccak256 of its exact hashes.json bytes. hashes.json lists every other pack file with its keccak256, so the text
 * commits to the whole pack; Etherscan's "View input as UTF-8" shows the text as is.
 *
 * The tx is kept OUTSIDE the pack (the pack's hashes are what it commits to), in a sidecar
 * evidence/fisco/anchors/<packId>.sepolia.json: {format, packId, text, txHash, rawSignedTx, receipt (as served),
 * block {number, hash, parentHash, timestamp}, capturedAt}. Browser-safe and synchronous (no node: imports; the
 * node-side reader is ./anchor-file.ts, the opt-in online confirmation ./anchor-online.ts).
 *
 * What a pass means: the sidecar's signed tx is the hogee-deployer's, on chain 11155111, to itself, value 0, and
 * carries exactly the text recomputed from THIS pack; its receipt (status 1) and block agree with each other. What
 * it does not mean: offline, the receipt and block are only as stated by the sidecar (no header or trie proof). The
 * raw tx of a real anchor is public, so anyone holding it (no key needed) can rewrite those fields and still pass.
 * That the tx is in Sepolia's canonical chain at that block and time is confirmed only online (--anchor-rpc) or on
 * Etherscan.
 */
import { keccak256, parseTransaction, type Hex } from "viem";
import { z } from "zod";
import { Hex32, HexBytes, IsoDateTime } from "@hogee/core";
import { RawReceipt } from "../bundle";
import { parseSignedTx } from "../crypto";
import type { BundleFiles } from "../load";
import { bytesToHex, fileBytes, fileText, parseJson, Problems, quantity, sameHex, utf8Bytes, type VerifyCheck } from "../util";
import { loadPack } from "./load";
import { FISCO_CHAIN_ID, PACK_DIR_RE, PACK_FILES, SEPOLIA_CHAIN_ID, type ParsedPack } from "./pack";

/** The hogee-deployer: final-2's deployer on Sepolia, the only account whose anchor tx the checker accepts. */
export const ANCHOR_SIGNER = "0x46405e378F5AC837b8E18a96105e3ff3CCB22251";
export const ANCHOR_CHAIN_ID = SEPOLIA_CHAIN_ID;
export const ANCHOR_FORMAT = "hogee.fisco-anchor/1" as const;
export const ANCHOR_CHECK = "Sepolia timestamp";
/** The sidecar cap, checked before parsing (the Proof page runs this in a browser tab). */
export const MAX_ANCHOR_BYTES = 64 * 1024;
/** The sidecars' folder, next to the packs: evidence/fisco/anchors/. */
export const ANCHORS_DIR = "anchors";
export const anchorFileOf = (packId: string): string => `${packId}.sepolia.json`;
export const ETHERSCAN_TX_URL = "https://sepolia.etherscan.io/tx/";
/** The tx types `cast mktx` may produce (it makes EIP-1559 on Sepolia); blob and set-code txs are refused. */
const TX_TYPES = new Set(["legacy", "eip2930", "eip1559"]);

const TEXT_PREFIX = "hogee-fisco-anchor v1";
/** The whole text, nothing else: lowercase hex, decimal head, single spaces, ASCII only. */
export const ANCHOR_TEXT_RE = /^hogee-fisco-anchor v1 pack=fm-[0-9a-f]{16} hashes=0x[0-9a-f]{64} chain=20200 head=(0|[1-9][0-9]{0,15}) head-hash=0x[0-9a-f]{64}$/;

/** The parts of a loaded pack the text names. */
export interface AnchorSource {
  readonly pack: Pick<ParsedPack["pack"], "packId">;
  readonly chain: Pick<ParsedPack["chain"], "headAtEnd" | "headHashAtEnd">;
}

/**
 * `hogee-fisco-anchor v1 pack=<packId> hashes=<keccak256(exact hashes.json bytes)> chain=20200 head=<headAtEnd>
 * head-hash=<headHashAtEnd>`. Throws when hashes.json is missing or the result is not the strict ASCII form.
 */
export function anchorTextOf(source: AnchorSource, files: BundleFiles): string {
  const hashes = files[PACK_FILES.hashes];
  if (hashes === undefined) throw new Error(`${PACK_FILES.hashes} is missing`);
  const text = `${TEXT_PREFIX} pack=${source.pack.packId} hashes=${keccak256(fileBytes(hashes))} chain=${FISCO_CHAIN_ID} head=${source.chain.headAtEnd} head-hash=${source.chain.headHashAtEnd.toLowerCase()}`;
  if (!ANCHOR_TEXT_RE.test(text)) throw new Error("the anchor text is not in its strict form");
  return text;
}

/** The tx input: the text's ASCII bytes as lowercase 0x-hex. */
export const anchorCalldataOf = (text: string): Hex => bytesToHex(utf8Bytes(text));

const AnyHex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Quantity = z.string().regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/, "JSON-RPC quantity");

/** eth_getBlockByNumber's header fields the anchor keeps, as served. */
export const AnchorBlock = z.strictObject({ number: Quantity, hash: AnyHex32, parentHash: AnyHex32, timestamp: Quantity });

export const AnchorSidecar = z.strictObject({
  format: z.literal(ANCHOR_FORMAT),
  packId: z.string().regex(PACK_DIR_RE),
  text: z.string().regex(ANCHOR_TEXT_RE),
  /** keccak256(rawSignedTx). */
  txHash: Hex32,
  /** The exact bytes `cast mktx` signed and `cast publish` sent. */
  rawSignedTx: HexBytes,
  /** eth_getTransactionReceipt as served (provider extras kept). */
  receipt: RawReceipt,
  block: AnchorBlock,
  capturedAt: IsoDateTime,
});
export type AnchorSidecar = z.infer<typeof AnchorSidecar>;

/** The sidecar strictly parsed, or why it can't be (size cap first). */
export function parseAnchorSidecar(sidecar: Uint8Array | string): { readonly sidecar: AnchorSidecar } | { readonly problem: string } {
  const bytes = fileBytes(sidecar);
  if (bytes.length > MAX_ANCHOR_BYTES) return { problem: `the sidecar is larger than ${MAX_ANCHOR_BYTES} bytes` };
  const text = fileText(bytes);
  const json = text === null ? undefined : parseJson(text);
  if (json === undefined) return { problem: "the sidecar is not UTF-8 JSON" };
  const parsed = AnchorSidecar.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { problem: `the sidecar does not match its schema at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
  }
  return { sidecar: parsed.data };
}

/** What a passing anchor shows (the Proof page renders these). */
export interface AnchorFacts {
  readonly packId: string;
  readonly text: string;
  readonly txHash: string;
  readonly signer: string;
  /** viem's name for the tx type: "eip1559", "legacy" or "eip2930". */
  readonly txType: string;
  /** The block number, hash and time are as stated by the sidecar: offline they are not proven (see above). */
  readonly blockNumber: number;
  readonly blockHash: string;
  /** The block's time, unix seconds. */
  readonly timestamp: number;
  readonly utc: string;
  readonly etherscanUrl: string;
}

export interface AnchorOptions {
  /** No sidecar is a failure (`--require-anchor`). Default: "not anchored" passes. */
  readonly required?: boolean;
  /** The test suite only (no flag or env var sets it): the signer to require instead of ANCHOR_SIGNER. */
  readonly signer?: string;
}

export interface AnchorResult extends VerifyCheck {
  /** A sidecar was given (whether or not it checks out). */
  readonly anchored: boolean;
  /** Non-null exactly when ok && anchored. */
  readonly anchor: AnchorFacts | null;
}

const failed = (detail: string): AnchorResult => ({ name: ANCHOR_CHECK, ok: false, detail, anchored: true, anchor: null });

/** The signed tx: who, where, what, worth what. Problems go to `p`; returns the tx type when it parses. */
function checkTx(s: AnchorSidecar, text: string, signer: string, p: Problems): string | null {
  if (keccak256(s.rawSignedTx as Hex) !== s.txHash) p.add("txHash is not keccak256(rawSignedTx)");
  const tx = parseSignedTx(s.rawSignedTx as Hex);
  if (typeof tx === "string") {
    p.add(tx);
    return null;
  }
  if (tx.chainId !== ANCHOR_CHAIN_ID) p.add(`the tx is for chain ${tx.chainId ?? "(none)"}, not Sepolia (${ANCHOR_CHAIN_ID})`);
  if (!sameHex(tx.from, signer)) p.add(`the tx is signed by ${tx.from}, not the hogee-deployer ${signer.toLowerCase()}`);
  if (tx.to === null || !sameHex(tx.to, tx.from)) p.add("the tx is not sent to its own signer");
  if (!sameHex(tx.data, anchorCalldataOf(text))) p.add("the tx input is not the anchor text recomputed from this pack");
  const full = parseTransaction(s.rawSignedTx as Hex);
  if ((full.value ?? 0n) !== 0n) p.add(`the tx moves value (${full.value} wei); an anchor moves none`);
  if (!TX_TYPES.has(full.type ?? "")) p.add(`the tx type ${full.type ?? "(none)"} is not accepted`);
  return full.type ?? null;
}

/** The receipt against the tx and the block. */
function checkReceipt(s: AnchorSidecar, signer: string, p: Problems): void {
  const r = s.receipt;
  if (r.status !== "0x1") p.add(`the receipt status is ${r.status}, not 0x1`);
  if (!sameHex(r.transactionHash, s.txHash)) p.add("the receipt is for another tx");
  if (!sameHex(r.from, signer) || !sameHex(r.to, signer)) p.add("the receipt's from/to is not the signer to itself");
  if (r.logs.length > 0) p.add("the receipt has logs (a plain self-send has none)");
  if (quantity(r.blockNumber) !== quantity(s.block.number)) p.add("the receipt's block number is not the block's");
  if (!sameHex(r.blockHash, s.block.hash)) p.add("the receipt's block hash is not the block's");
}

/**
 * Checks a sidecar against the pack's files (the pack is loaded here: schemas and hashes.json, so any edit to any
 * pack file fails). Never throws: every problem is a failing result. `sidecar` null = not anchored.
 */
export function checkSepoliaAnchor(files: BundleFiles, sidecar: Uint8Array | string | null, opts: AnchorOptions = {}): AnchorResult {
  if (sidecar === null) {
    const detail = "not anchored (no evidence/fisco/anchors/<packId>.sepolia.json)";
    return { name: ANCHOR_CHECK, ok: opts.required !== true, detail: opts.required ? `${detail}; an anchor is required` : detail, anchored: false, anchor: null };
  }
  try {
    const parsed = parseAnchorSidecar(sidecar);
    if ("problem" in parsed) return failed(parsed.problem);
    const s = parsed.sidecar;
    const loaded = loadPack(files);
    if (!loaded.pack) return failed("the pack does not load (see pack files), so its anchor text cannot be recomputed");
    const signer = opts.signer ?? ANCHOR_SIGNER;
    const text = anchorTextOf(loaded.pack, files);
    const p = new Problems(ANCHOR_CHECK);
    if (s.packId !== loaded.pack.pack.packId) p.add(`the sidecar is for ${s.packId}, not this pack ${loaded.pack.pack.packId}`);
    if (s.text !== text) p.add("the sidecar's text is not the one recomputed from this pack (pack id, hashes.json, head or head hash differ)");
    const txType = checkTx(s, text, signer, p);
    checkReceipt(s, signer, p);
    const blockNumber = Number(quantity(s.block.number));
    const timestamp = Number(quantity(s.block.timestamp));
    const date = new Date(timestamp * 1000);
    if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(timestamp) || Number.isNaN(date.getTime())) p.add("the block number or time is out of range");
    if (p.count > 0) return { ...p.result(""), anchored: true, anchor: null };
    const anchor: AnchorFacts = {
      packId: s.packId,
      text,
      txHash: s.txHash,
      signer: signer.toLowerCase(),
      txType: txType ?? "",
      blockNumber,
      blockHash: s.block.hash.toLowerCase(),
      timestamp,
      utc: date.toISOString(),
      etherscanUrl: `${ETHERSCAN_TX_URL}${s.txHash}`,
    };
    const detail = `tx ${anchor.txHash} by ${anchor.signer} names this pack and keccak256(hashes.json); Sepolia block ${blockNumber} at ${anchor.utc} as stated by the sidecar (anyone holding the public raw tx can rewrite them; only --anchor-rpc or Etherscan confirms them: ${anchor.etherscanUrl})`;
    return { name: ANCHOR_CHECK, ok: true, detail, anchored: true, anchor };
  } catch (error: unknown) {
    // A checker bug must never read as "anchored".
    return failed(`checker error: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
  }
}
