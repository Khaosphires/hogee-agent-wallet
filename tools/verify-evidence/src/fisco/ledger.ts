/**
 * Check "regulator ledger": the pack's txs sit in node4's (the regulator's observer node's) served copy of the ledger.
 *   - chain.json counts the mirror's 5 nodes: 4 sealers and 1 observer (node4); the UI shows these as fact;
 *   - ledger.json's blocks 0..head (node4's own answers, normalised) are contiguous, each parent link from block 2 on is
 *     the previous block's hash (FISCO's Web3 layer serves block 0 under another hash than the genesis hash block 1
 *     names), and its head is chain.json's headAtEnd / headHashAtEnd;
 *   - keccak256(JCS(those blocks)) equals node0Keccak, node0's digest of its own normalised copy of the same blocks,
 *     recorded by the replay at capture (the replay stops on any difference between the two nodes); offline, node0
 *     is not re-read: this proves the digest node0's copy had then, not node0's copy itself;
 *   - every mined pack tx (deploys and steps) sits in node4's copy at its block hash, block number, timestamp and
 *     index, with the same from, to, nonce, keccak256(input) and receipt consensus (online.ts receiptConsensus:
 *     status, gas, created address, logs);
 *   - every other tx is explained: only chain.json observerNode.proposalTx, the regulator's
 *     createSetConsensusWeightProposal (nonce 0, to CommitteeManager, status 1, the proposal log alone, in
 *     observerNode.proposalBlock), mined at chain-up: before the first deploy and at most headAtStart; G0 is the
 *     regulator's next tx (nonce 1);
 *   - no agent tx sits before G0's registration.
 * What it does not show: that node4's blocks are the sealers' consensus (FISCO header hashes are not recomputed); it
 * shows that the regulator's own node served exactly the chain this pack describes.
 */
import { keccak256, type Hex } from "viem";
import { hashObject } from "@hogee/core";
import { receiptConsensus } from "../online";
import { Problems, quantity, sameHex, type VerifyCheck } from "../util";
import type { Ctx, MirrorTx } from "./context";
import { blockOf } from "./govern";
import { DEPLOYED, servedAddressOf, type FiscoReceipt, type LedgerBlock, type LedgerTx } from "./pack";
import { PROPOSAL_LOG, SYSTEM } from "./system";

export const LEDGER_CHECK = "regulator ledger";

/** The mirror's topology (FISCO-BRIEF): node0-3 sealers, node4 the regulator's observer. */
export const MIRROR_NODES = { nodeCount: 5, sealerCount: 4, observerCount: 1 } as const;

/** The receipt fields both copies share, normalised to the ledger's form, for receiptConsensus. */
function consensusOfServed(r: FiscoReceipt): string {
  const created = servedAddressOf(r.contractAddress);
  return receiptConsensus({
    transactionIndex: Number(quantity(r.transactionIndex) ?? -1n),
    status: r.status === "0x1" ? 1 : 0,
    gasUsed: String(quantity(r.gasUsed) ?? ""),
    contractAddress: created,
    logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
  });
}

const consensusOfLedger = (t: LedgerTx): string =>
  receiptConsensus({ transactionIndex: t.receipt.transactionIndex, status: t.receipt.status, gasUsed: t.receipt.gasUsed, contractAddress: t.receipt.contractAddress ?? null, logs: t.receipt.logs });

function checkChain(ctx: Ctx, blocks: readonly LedgerBlock[], p: Problems): void {
  const { head, node0Keccak } = ctx.pack.ledger;
  const chain = ctx.pack.chain;
  const { nodeCount, sealerCount, observerCount } = chain;
  if (nodeCount !== MIRROR_NODES.nodeCount || sealerCount !== MIRROR_NODES.sealerCount || observerCount !== MIRROR_NODES.observerCount) {
    p.add(`chain.json counts ${nodeCount} nodes (${sealerCount} sealers, ${observerCount} observers), not the mirror's 5 nodes (4 sealers, 1 observer)`);
  }
  blocks.forEach((b, i) => {
    if (b.number !== i) p.add(`ledger block ${i} is numbered ${b.number} (blocks must run 0..head without gaps)`);
    const prev = blocks[i - 1];
    // Block 1's parent is the chain's own genesis hash, which FISCO's Web3 layer does not serve as block 0's hash.
    if (prev && i > 1 && !sameHex(b.parentHash, prev.hash)) p.add(`ledger block ${b.number}: parentHash is not block ${prev.number}'s hash`);
    if (prev && b.timestamp < prev.timestamp) p.add(`ledger block ${b.number}: time goes back`);
  });
  const last = blocks.at(-1);
  if (!last || last.number !== head.number || !sameHex(last.hash, head.hash)) p.add("ledger head is not its last block");
  if (head.number !== chain.headAtEnd || !sameHex(head.hash, chain.headHashAtEnd)) p.add(`ledger head ${head.number} is not chain.json's head at the end (${chain.headAtEnd})`);
  if (hashObject(blocks) !== node0Keccak.toLowerCase()) p.add("node4's blocks differ from node0's (keccak256(JCS(blocks)) is not node0Keccak)");
}

interface Located {
  readonly block: LedgerBlock;
  readonly index: number;
  readonly tx: LedgerTx;
}

/** One mined pack tx against node4's copy. */
function checkPackTx(t: MirrorTx, at: Located | undefined, label: string, p: Problems): void {
  const f = t.file;
  const r = f?.receipt;
  const parsed = t.parsed;
  if (!f || !r || !f.block || !parsed) return;
  if (!at) return p.add(`${label}: not in node4's ledger`);
  const { block, index, tx } = at;
  if (BigInt(block.number) !== quantity(r.blockNumber) || !sameHex(block.hash, r.blockHash) || BigInt(block.timestamp) !== quantity(f.block.timestamp)) p.add(`${label}: node4 holds it in another block`);
  if (BigInt(index) !== quantity(r.transactionIndex)) p.add(`${label}: node4 holds it at index ${index}, not ${String(quantity(r.transactionIndex))}`);
  const same = sameHex(tx.from, parsed.from) && (tx.to === null ? parsed.to === null : sameHex(tx.to, parsed.to)) && tx.nonce === parsed.nonce && sameHex(tx.inputKeccak, keccak256(parsed.data as Hex));
  if (!same) p.add(`${label}: node4's tx differs (from, to, nonce or input)`);
  if (consensusOfLedger(tx) !== consensusOfServed(r)) p.add(`${label}: node4's receipt differs (status, index, gas, created address or logs)`);
}

/** The one tx the pack does not hold: the observer proposal at chain-up. */
function checkProposal(ctx: Ctx, at: Located, p: Problems): void {
  const o = ctx.pack.chain.observerNode;
  const { tx, block } = at;
  const logs = tx.receipt.logs;
  const okLog = logs.length === 1 && sameHex(logs[0]?.address, PROPOSAL_LOG.address) && logs[0]?.topics.length === 1 && sameHex(logs[0]?.topics[0], PROPOSAL_LOG.topic0) && sameHex(logs[0]?.data, PROPOSAL_LOG.data);
  const ok = sameHex(tx.from, ctx.pack.deployment.roles.regulator) && sameHex(tx.to, SYSTEM.CommitteeManager) && tx.nonce === 0 && tx.receipt.status === 1 && block.number === o.proposalBlock && okLog;
  if (!ok) p.add("the observer proposal is not the regulator's first tx to CommitteeManager, mined in observerNode.proposalBlock with the proposal log");
}

/**
 * The observer proposal belongs to chain-up: mined before the first deploy and at most headAtStart, and the
 * regulator's next tx (nonce 1) is G0, so no regulator tx can sit between them.
 */
function checkChainUp(ctx: Ctx, p: Problems): void {
  const at = BigInt(ctx.pack.chain.observerNode.proposalBlock);
  const headAtStart = ctx.pack.chain.headAtStart;
  if (at > BigInt(headAtStart)) p.add(`the observer proposal (block ${at}) is after headAtStart ${headAtStart}`);
  const deployBlocks = DEPLOYED.flatMap((n) => {
    const b = ctx.view.deploys.get(n)?.blockNumber;
    return b === null || b === undefined ? [] : [b];
  });
  const firstDeploy = deployBlocks.length > 0 ? deployBlocks.reduce((a, b) => (b < a ? b : a)) : null;
  if (firstDeploy === null) p.add("no mined deploy to date the observer proposal against");
  else if (at >= firstDeploy) p.add(`the observer proposal (block ${at}) is not before the first deploy (block ${firstDeploy})`);
  const g0 = ctx.view.byId.get("G0")?.tx?.parsed;
  if (!g0) p.add("no G0 tx to bind the regulator's nonces");
  else if (g0.nonce !== 1) p.add(`G0 is the regulator's nonce ${g0.nonce}, not 1 (its nonce 0 is the observer proposal)`);
}

export function checkLedger(ctx: Ctx): VerifyCheck {
  const p = new Problems(LEDGER_CHECK);
  const blocks = ctx.pack.ledger.blocks;
  checkChain(ctx, blocks, p);
  const where = new Map<string, Located>();
  for (const block of blocks) {
    block.txs.forEach((tx, index) => {
      if (where.has(tx.hash)) p.add(`ledger tx ${tx.hash.slice(0, 12)}… appears twice`);
      where.set(tx.hash, { block, index, tx });
    });
  }
  const mined: [MirrorTx, string][] = [
    ...DEPLOYED.flatMap((n) => {
      const t = ctx.view.deploys.get(n);
      return t ? [[t, `deploy ${n}`] as [MirrorTx, string]] : [];
    }),
    ...ctx.view.steps.flatMap((s) => (s.tx && s.tx.blockNumber !== null ? [[s.tx, `#${s.step.seq} ${s.step.id}`] as [MirrorTx, string]] : [])),
  ];
  const ours = new Set(mined.map(([t]) => t.hash.toLowerCase()));
  for (const [t, label] of mined) checkPackTx(t, where.get(t.hash.toLowerCase()), label, p);
  const proposal = ctx.pack.chain.observerNode.proposalTx.toLowerCase();
  for (const [hash, at] of where) {
    if (ours.has(hash)) continue;
    if (hash === proposal) checkProposal(ctx, at, p);
    else p.add(`ledger block ${at.block.number}: tx ${hash.slice(0, 12)}… is in no step and is not the observer proposal`);
  }
  if (!where.has(proposal)) p.add("the observer proposal tx is not in node4's ledger");
  checkChainUp(ctx, p);
  const g0 = blockOf(ctx.view.byId.get("G0"));
  const agent = ctx.pack.deployment.roles.agent;
  const early = g0 === null ? [] : [...where.values()].filter((l) => sameHex(l.tx.from, agent) && BigInt(l.block.number) <= g0);
  if (g0 === null) p.add("no mined G0 to date the agent's registration");
  for (const l of early) p.add(`ledger block ${l.block.number}: an agent tx before G0's registration`);
  return p.result(
    `the pack's ${mined.length} txs sit in node4's served copy of blocks 0..${ctx.pack.ledger.head.number}, the observer proposal (chain-up) its only other tx; node0's digest of the same blocks was recorded at capture`,
  );
}
