/**
 * ledger.json: the regulator's own copy of the ledger. node4 (the regulator's observer node; Web3 on 127.0.0.1:8546,
 * read through the read-only LedgerRpc) must serve blocks 0..head and every receipt exactly as node0 does. Captured
 * after the last step and the final reads, when nothing more is sent. Fail closed:
 *   - node4 is waited for (with a timeout) until it reaches node0's head; a node4 past that head means the chain moved;
 *   - every block and receipt is read from BOTH nodes and normalised the same way (LedgerFile, pack.ts); any difference
 *     stops the capture (the message names the block, never the content). Blocks are asked for with full tx objects;
 *     a node that lists hashes only gets each object from ITS OWN eth_getTransactionByHash (node4's from node4, never
 *     node0), which must carry that hash; its content is then compared with node0's like the rest of the block;
 *   - each receipt must name its block, hash and position; a CREATE must name its contract address;
 *   - node0's head is read again at the end: it must not have moved (number and hash), and node4 must sit on it;
 *   - the observer proposal (the regulator's createSetConsensusWeightProposal(node4Id, 0, true, 1000) to 0x…10001 at
 *     chain-up) must be in the ledger exactly once, mined with status 1, sent by the regulator; chain.json keeps
 *     keccak256 of the node id string only (no raw node id in any file).
 * ledger.json keeps node4's own normalised blocks (its answers, not node0's), and node0Keccak = hashObject(node0's
 * separately normalised blocks) = keccak256(JCS(them)). Equal on a healthy chain (any difference stops the capture),
 * but each from its own node: offline, the checker can then say the pack's txs sit in node4's served copy and that
 * node0's digest of the same blocks was recorded here.
 */
import { hashObject } from "@hogee/core";
import { decodeFunctionData, keccak256, stringToHex, type Abi, type Hex } from "viem";
import { LedgerFile, servedAddressOf, type ChainFile, type LedgerBlock, type LedgerTx } from "../../../../tools/verify-evidence/src/fisco/pack";
import { COMMITTEE_MANAGER_ABI, OBSERVER_PROPOSAL, SYSTEM } from "../../../../tools/verify-evidence/src/fisco/system";
import { nodeText, type LedgerRpc, type Rpc } from "./rpc";

export class LedgerError extends Error {
  override readonly name = "LedgerError";
}

export interface LedgerWait {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface CapturedLedger {
  readonly ledger: LedgerFile;
  readonly observerNode: ChainFile["observerNode"];
  /** The raw node id from the proposal calldata: only for the pack's secret scan (it must appear in no file). */
  readonly observerNodeId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DATA_RE = /^0x([0-9a-fA-F]{2})*$/;

function int(v: unknown, what: string): number {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(v)) throw new LedgerError(`${what} is not a quantity`);
  const n = Number(BigInt(v));
  if (!Number.isSafeInteger(n)) throw new LedgerError(`${what} is out of range`);
  return n;
}

function hash(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !HASH_RE.test(v)) throw new LedgerError(`${what} is not a 32-byte hash`);
  return v.toLowerCase() as Hex;
}

function address(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw new LedgerError(`${what} is not an address`);
  return v.toLowerCase() as Hex;
}

function logOf(l: unknown, what: string): LedgerTx["receipt"]["logs"][number] {
  if (!isRecord(l) || !Array.isArray(l.topics) || typeof l.data !== "string" || !DATA_RE.test(l.data)) throw new LedgerError(`${what}: a log is malformed`);
  // Only emitter, topics and data: FISCO serves a log's transactionIndex as hex of the text "0x0" (never compared).
  return { address: address(l.address, `${what} log address`), topics: l.topics.map((t, i) => hash(t, `${what} topic ${i}`)), data: l.data.toLowerCase() };
}

/** One tx of a block (full tx object) with its receipt, in the ledger's shape. */
function ledgerTx(tx: unknown, receipt: Record<string, unknown> | null, block: { number: number; hash: Hex }, index: number): LedgerTx {
  if (!isRecord(tx)) throw new LedgerError(`block ${block.number}: tx ${index} is not a tx object`);
  const h = hash(tx.hash, `block ${block.number} tx ${index} hash`);
  const what = `block ${block.number} tx ${h}`;
  if (!receipt) throw new LedgerError(`${what}: no receipt`);
  if (hash(receipt.transactionHash, `${what} receipt`) !== h || hash(receipt.blockHash, `${what} receipt block`) !== block.hash || int(receipt.blockNumber, `${what} receipt block number`) !== block.number) {
    throw new LedgerError(`${what}: the receipt names another tx or block`);
  }
  const position = int(receipt.transactionIndex, `${what} transactionIndex`);
  if (position !== index) throw new LedgerError(`${what}: receipt index ${position}, block position ${index}`);
  const status = receipt.status === "0x1" ? 1 : receipt.status === "0x0" ? 0 : null;
  if (status === null) throw new LedgerError(`${what}: receipt status ${nodeText(String(receipt.status), 20)}`);
  const to = servedAddressOf(typeof tx.to === "string" ? tx.to : null);
  const created = to === null ? servedAddressOf(typeof receipt.contractAddress === "string" ? receipt.contractAddress : null) : null;
  if (to === null && !created) throw new LedgerError(`${what}: a contract creation without a contract address`);
  const input = typeof tx.input === "string" ? tx.input : tx.data;
  if (typeof input !== "string" || !DATA_RE.test(input)) throw new LedgerError(`${what}: no input`);
  if (!Array.isArray(receipt.logs)) throw new LedgerError(`${what}: no logs array`);
  return {
    hash: h,
    from: address(tx.from, `${what} from`),
    to: to === null ? null : address(to, `${what} to`),
    nonce: int(tx.nonce, `${what} nonce`),
    inputKeccak: keccak256(input as Hex),
    receipt: {
      transactionIndex: position,
      status,
      gasUsed: BigInt(int(receipt.gasUsed, `${what} gasUsed`)).toString(),
      ...(created ? { contractAddress: address(created, `${what} contractAddress`) } : {}),
      logs: receipt.logs.map((l) => logOf(l, what)),
    },
  };
}

/**
 * Block `n` from one node, with every receipt, in the ledger's shape; also the raw tx inputs (for the proposal). A node
 * that lists only tx hashes (not the full objects asked for) gets each object from its own eth_getTransactionByHash,
 * which must carry that same hash: node4's copy is node4's answers only.
 */
async function readBlock(rpc: Rpc, n: number, who: string): Promise<{ block: LedgerBlock; inputs: Map<string, string> }> {
  const b = await rpc.blockWithTxs(n);
  if (!isRecord(b)) throw new LedgerError(`${who} does not serve block ${n}`);
  if (int(b.number, `${who} block ${n} number`) !== n) throw new LedgerError(`${who} served another block for ${n}`);
  const head = { number: n, hash: hash(b.hash, `${who} block ${n} hash`) };
  const served = Array.isArray(b.transactions) ? b.transactions : null;
  if (!served) throw new LedgerError(`${who} block ${n}: no transactions list`);
  const txs: LedgerTx[] = [];
  const inputs = new Map<string, string>();
  for (const [i, listed] of served.entries()) {
    const h = hash(isRecord(listed) ? listed.hash : listed, `${who} block ${n} tx ${i}`);
    const t = isRecord(listed) ? listed : await rpc.tx(h);
    if (!isRecord(t) || typeof t.hash !== "string" || t.hash.toLowerCase() !== h) throw new LedgerError(`${who} block ${n}: tx ${i} is not served as a tx object with its hash`);
    txs.push(ledgerTx(t, await rpc.receipt(h), head, i));
    inputs.set(h, String(t.input ?? t.data));
  }
  return { block: { number: n, hash: head.hash, parentHash: hash(b.parentHash, `${who} block ${n} parentHash`), timestamp: int(b.timestamp, `${who} block ${n} timestamp`), txs }, inputs };
}

async function waitFor(node4: Rpc, head: number, w: LedgerWait): Promise<void> {
  const deadline = Date.now() + w.timeoutMs;
  for (;;) {
    const at = await node4.blockNumber();
    if (at === head) return;
    if (at > head) throw new LedgerError(`node4 is at block ${at}, past node0's head ${head}: the chain moved`);
    if (Date.now() > deadline) throw new LedgerError(`node4 did not reach block ${head} within ${w.timeoutMs} ms (at ${at})`);
    await w.sleep(w.pollMs);
  }
}

/** The observer proposal in the ledger: exactly one, by the regulator, status 1, the catalogue's arguments. */
function observerOf(blocks: readonly LedgerBlock[], inputs: ReadonlyMap<string, string>, regulator: Hex): CapturedLedger["observerNode"] & { nodeId: string } {
  const found = blocks.flatMap((b) =>
    b.txs.flatMap((t) => {
      if (t.to !== SYSTEM.CommitteeManager) return [];
      try {
        const d = decodeFunctionData({ abi: COMMITTEE_MANAGER_ABI as Abi, data: inputs.get(t.hash) as Hex });
        return d.functionName === OBSERVER_PROPOSAL.function ? [{ block: b.number, tx: t, args: (d.args ?? []) as readonly unknown[] }] : [];
      } catch {
        return [];
      }
    }),
  );
  const p = found[0];
  if (found.length !== 1 || !p) throw new LedgerError(`the ledger holds ${found.length} observer proposals, not 1`);
  const [nodeId, weight, addFlag, interval] = p.args;
  if (p.tx.from !== regulator.toLowerCase() || p.tx.receipt.status !== 1) throw new LedgerError("the observer proposal was not mined for the regulator");
  if (typeof nodeId !== "string" || nodeId.length === 0 || Number(weight) !== OBSERVER_PROPOSAL.weight || addFlag !== OBSERVER_PROPOSAL.addFlag || interval !== OBSERVER_PROPOSAL.blockNumberInterval) {
    throw new LedgerError("the observer proposal does not add a weight-0 observer with interval 1000");
  }
  return { index: 4, proposalTx: p.tx.hash, proposalBlock: p.block, weight: 0, nodeIdKeccak: keccak256(stringToHex(nodeId)), nodeId };
}

/** ledger.json from both nodes' own normalised blocks: node4's are kept, node0's are only digested (node0Keccak). */
export function ledgerFileOf(node0Blocks: readonly LedgerBlock[], node4Blocks: readonly LedgerBlock[], head: { readonly number: number; readonly hash: string }): LedgerFile {
  return LedgerFile.parse({ node: "node4-observer", head: { number: head.number, hash: head.hash }, blocks: node4Blocks, node0Keccak: hashObject(node0Blocks) });
}

/**
 * Captures blocks 0..head.number from node0 and node4 and compares them; `regulator` is the genesis auth admin (the
 * observer proposal's sender).
 */
export async function captureLedger(node0: Rpc, node4: LedgerRpc, head: { readonly number: number; readonly hash: string }, regulator: Hex, w: LedgerWait): Promise<CapturedLedger> {
  await waitFor(node4, head.number, w);
  const blocks0: LedgerBlock[] = [];
  const blocks4: LedgerBlock[] = [];
  const inputs = new Map<string, string>();
  for (let n = 0; n <= head.number; n += 1) {
    const [a, b] = [await readBlock(node0, n, "node0"), await readBlock(node4, n, "node4")];
    if (JSON.stringify(a.block) !== JSON.stringify(b.block)) throw new LedgerError(`block ${n}: node4's copy differs from node0's`);
    // FISCO's Web3 layer serves the genesis block under another hash than the chain's own genesis hash (native
    // getBlockHashByNumber 0), which block 1's parentHash names: the parent links are checked from block 2 on.
    if (n > 1 && b.block.parentHash !== (blocks4[n - 1] as LedgerBlock).hash) throw new LedgerError(`block ${n}: its parent is not block ${n - 1}`);
    blocks0.push(a.block);
    blocks4.push(b.block);
    for (const [k, v] of b.inputs) inputs.set(k, v);
  }
  const last = blocks4.at(-1) as LedgerBlock;
  if (last.hash !== head.hash.toLowerCase()) throw new LedgerError(`block ${head.number}: node0 now serves another hash than the head the run ended on`);
  const [now0, now4] = [await node0.blockNumber(), await node4.blockNumber()];
  if (now0 !== head.number || now4 !== head.number) throw new LedgerError(`the head moved during the capture (node0 ${now0}, node4 ${now4}, expected ${head.number})`);
  const { nodeId, ...observerNode } = observerOf(blocks4, inputs, regulator);
  return { ledger: ledgerFileOf(blocks0, blocks4, { number: head.number, hash: last.hash }), observerNode, observerNodeId: nodeId };
}
