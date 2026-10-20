/**
 * The mirror view and the three checks that build it:
 *   "step catalogue": steps.json is exactly the catalogue, in order (seq 1..n), each row's contract, function, signer
 *     role, auth, expectation, amount and links as catalogue.ts says; a probe-only row (and only it) has its eth_call;
 *   "transactions" (check 2): every step and deploy tx is in txs/; keccak256(raw) = its hash; legacy (type 0) with
 *     EIP-155 chain id 20200; the recovered sender is the step role's address (deployment.json roles); a step tx calls
 *     its contract and its calldata decodes to the step's function; a deploy creates the address CREATE gives
 *     (TreasuryGovernance: Treasury's first CREATE); per-signer nonces run without gaps (an RPC-refused tx consumes
 *     none); the served tx object agrees with the raw bytes (hash, from, to, input, nonce, value, gas, chainId, each
 *     when served); no tx file is left unexplained; a system call (G/V steps) decodes with the system ABI and is on the
 *     allow-list (system.ts); a probe-only step has no tx, keeps its nonce, and its eth_call is the step's call from
 *     its role to its contract;
 *   "receipts and blocks" (check 3): status ↔ outcome; every mined tx has its native receipt, of the same tx and block,
 *     whose status is 0 for a success, 22 for an account-frozen refusal, 18 for a method-banned one and 16 for any
 *     other revert; a reverted tx has no logs; logs come from deployment contracts and decode as Hogee events, except
 *     the CommitteeManager proposal log, allowed on G3 only (a system call carries no other log); the bloom is recomputed when served non-zero (else reported as not served); the
 *     receipt's block is the served block, which lists the tx; block numbers and timestamps (seconds, < 1e12) never go
 *     back, and txs mined in one block sit there in seq order (rising transactionIndex). FISCO header hashes are not
 *     recomputed.
 */
import { decodeEventLog, getContractAddress, parseTransaction, type Hex } from "viem";
import { hogeeEventsAbi } from "../abi";
import { decodeCall } from "../calls";
import { fiscoLogsBloom } from "./bloom";
import { parseSignedTx } from "../crypto";
import { hexToBytesOrNull, Problems, quantity, sameHex, type VerifyCheck } from "../util";
import { CATALOGUE, catalogueEntry, type CatalogueEntry } from "./catalogue";
import { isDeploymentAddress, type MirrorEvent, type MirrorStep, type MirrorTx, type MirrorView } from "./context";
import { probeCallName } from "./govern";
import { DEPLOYED, FISCO_CHAIN_ID, servedAddressOf, stepLabel, targetAddressOf, type DeployedName, type FiscoReceipt, type ParsedPack, type Step, type TxFile } from "./pack";
import { CALL_CONTRACT } from "../abi";
import { decodeSystemCall, isSystemName, NATIVE_STATUS, PROPOSAL_LOG } from "./system";

export const CATALOGUE_CHECK = "step catalogue";
export const TXS_CHECK = "transactions";
export const RECEIPTS_CHECK = "receipts and blocks";

const MAX_SECONDS = 1_000_000_000_000n;
const isLegacy = (raw: string): boolean => (hexToBytesOrNull(raw)?.[0] ?? 0) >= 0xc0;

const isProposalLog = (log: FiscoReceipt["logs"][number]): boolean =>
  sameHex(log.address, PROPOSAL_LOG.address) && log.topics.length === 1 && sameHex(log.topics[0], PROPOSAL_LOG.topic0) && sameHex(log.data, PROPOSAL_LOG.data);

/** Which logs a receipt may carry: Hogee events (a deployment-contract tx), the proposal log (G3), or none. */
type LogRule = "hogee" | "proposal" | "none";

function decodeEvents(receipt: FiscoReceipt, seq: number, stepId: string, ctx: { pack: ParsedPack }, p: Problems, rule: LogRule = "hogee"): MirrorEvent[] {
  const out: MirrorEvent[] = [];
  let last = -1;
  for (const log of receipt.logs) {
    const where = `${receipt.transactionHash.slice(0, 12)}… log ${log.logIndex ?? "?"}`;
    if ((log.transactionHash && !sameHex(log.transactionHash, receipt.transactionHash)) || (log.blockHash && !sameHex(log.blockHash, receipt.blockHash)) || (log.blockNumber && log.blockNumber !== receipt.blockNumber) || log.removed === true) {
      p.add(`${where} does not belong to its receipt`);
    }
    const index = log.logIndex === undefined ? null : quantity(log.logIndex);
    if (index !== null) {
      if (Number(index) <= last) p.add(`${where} is out of order or repeated`);
      last = Number(index);
    }
    if (rule !== "hogee") {
      if (rule === "none" || !isProposalLog(log)) p.add(`${where}: a system call carries ${rule === "none" ? "no logs" : "only the CommitteeManager proposal log"}`);
      continue;
    }
    if (!isDeploymentAddress(ctx, log.address)) {
      p.add(`${where} comes from ${log.address}, not a deployment contract`);
      continue;
    }
    try {
      const ev = decodeEventLog({ abi: hogeeEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
      out.push({ name: ev.eventName, args: ev.args as Record<string, unknown>, address: log.address.toLowerCase(), seq, stepId });
    } catch {
      p.add(`${where} is not a Hogee event`);
    }
  }
  return out;
}

const ZERO_BLOOM = /^0x0*$/;

/** Receipt, block and log rules of one tx. Returns the decoded events (none when not mined). */
interface Expect {
  readonly mined: boolean;
  readonly success: boolean;
  /** The native status a mined tx must show (system.ts NATIVE_STATUS). */
  readonly native: number;
  readonly logs: LogRule;
}

/** The native status a mined step must show: 0 for a success, else by its catalogue rule (22, 18) or 16. */
const nativeWant = (entry: CatalogueEntry | null, success: boolean): number =>
  success ? NATIVE_STATUS.ok : entry?.rule === "account-frozen" ? NATIVE_STATUS.accountFrozen : entry?.rule === "method-banned" ? NATIVE_STATUS.permissionDenied : NATIVE_STATUS.revert;

/** The native receipt is the same tx, in the same block, with the status the outcome implies. */
function checkNative(f: TxFile, want: number, label: string, p: Problems): void {
  const n = f.native;
  const r = f.receipt;
  if (!n) return p.add(`${label}: mined, but its native receipt is missing`);
  if (!sameHex(n.transactionHash, f.hash)) p.add(`${label}: the native receipt is another tx's`);
  if (r && BigInt(n.blockNumber) !== quantity(r.blockNumber)) p.add(`${label}: the native receipt's block ${n.blockNumber} is not the Web3 receipt's`);
  if (n.status !== want) p.add(`${label}: native status ${n.status}, the outcome implies ${want}`);
}

function checkReceipt(ctx: { pack: ParsedPack }, f: TxFile, from: string | null, to: string | null, e: Expect, label: string, seq: number, stepId: string, p: Problems, bloom: { served: number; absent: number }): MirrorEvent[] {
  const { mined, success } = e;
  const r = f.receipt;
  if (!mined) {
    if (r || f.block || f.tx || f.native) p.add(`${label}: refused at the RPC, yet a receipt, block, served tx or native receipt is present`);
    return [];
  }
  if (!r || !f.block) {
    p.add(`${label}: mined, but its receipt or block is missing`);
    return [];
  }
  if (r.transactionHash.toLowerCase() !== f.hash) p.add(`${label}: the receipt is another tx's`);
  if (r.status !== (success ? "0x1" : "0x0")) p.add(`${label}: receipt status ${r.status} contradicts the outcome`);
  if (from && !sameHex(r.from, from)) p.add(`${label}: the receipt's from is not the signer`);
  const servedTo = servedAddressOf(r.to);
  if ((to === null) !== (servedTo === null) || (to && servedTo && !sameHex(servedTo, to))) p.add(`${label}: the receipt's to is not the signed tx's`);
  if (r.status === "0x0" && r.logs.length > 0) p.add(`${label}: reverted but has logs`);
  checkNative(f, e.native, label, p);
  const events = decodeEvents(r, seq, stepId, ctx, p, e.logs);
  // Recomputed when served non-zero, or served zero for a receipt without logs (then zero IS its bloom); an absent or
  // zero-filled bloom on a receipt with logs is reported as not served.
  const bloomServed = typeof r.logsBloom === "string" && r.logsBloom.length === 514 && (!ZERO_BLOOM.test(r.logsBloom) || r.logs.length === 0);
  if (bloomServed) {
    bloom.served += 1;
    if (fiscoLogsBloom(r.logs) !== (r.logsBloom as string).toLowerCase()) p.add(`${label}: logsBloom is not FISCO's bloom of its logs`);
  } else bloom.absent += 1;
  const b = f.block;
  if (b.number !== r.blockNumber || !sameHex(b.hash, r.blockHash)) p.add(`${label}: the receipt's block is not the served block`);
  const at = b.transactions.findIndex((h) => sameHex(h, f.hash));
  if (at < 0 || BigInt(at) !== quantity(r.transactionIndex)) p.add(`${label}: its block does not list it at its transactionIndex`);
  if ((quantity(b.timestamp) ?? MAX_SECONDS) >= MAX_SECONDS) p.add(`${label}: block timestamp ${b.timestamp} is not in seconds`);
  return events;
}

/**
 * Fields of the served tx object (eth_getTransactionByHash) that differ from the raw signed bytes. Each is compared
 * only when served: hash, from, to (null for a creation), input, nonce, value, gas, chainId.
 */
function servedMismatches(served: Record<string, unknown>, raw: string, tx: Exclude<MirrorTx["parsed"], null>): string[] {
  const t = parseTransaction(raw as Hex);
  const hexes: [string, string | null][] = [["hash", tx.hash], ["from", tx.from], ["to", tx.to], ["input", tx.data]];
  const quantities: [string, bigint][] = [["nonce", BigInt(tx.nonce)], ["value", t.value ?? 0n], ["gas", t.gas ?? 0n], ["chainId", BigInt(tx.chainId ?? -1)]];
  const bad = hexes.filter(([k, want]) => served[k] !== undefined && (want === null ? served[k] !== null : !(typeof served[k] === "string" && sameHex(served[k] as string, want))));
  const badQ = quantities.filter(([k, want]) => served[k] !== undefined && !(typeof served[k] === "string" && quantity(served[k] as string) === want));
  return [...bad, ...badQ].map(([k]) => k);
}

/** The raw tx of a step or deploy: hash, type, chain, signer. */
function parseTx(f: TxFile | undefined, hash: string, signer: string | null, label: string, p: Problems): MirrorTx["parsed"] {
  if (!f) {
    p.add(`${label}: txs/${hash}.json is missing`);
    return null;
  }
  const tx = parseSignedTx(f.rawSignedTx as Hex);
  if (typeof tx === "string") {
    p.add(`${label}: ${tx}`);
    return null;
  }
  if (tx.hash !== hash) p.add(`${label}: keccak256(raw tx) is ${tx.hash}, not ${hash}`);
  if (!isLegacy(f.rawSignedTx)) p.add(`${label}: not a legacy (type 0) transaction`);
  if (tx.chainId !== FISCO_CHAIN_ID) p.add(`${label}: signed for chain ${tx.chainId ?? "(none, pre-EIP-155)"}, not ${FISCO_CHAIN_ID}`);
  if (signer && !sameHex(tx.from, signer)) p.add(`${label}: signed by ${tx.from}, not its role's address`);
  const served = f.tx as Record<string, unknown> | null;
  const mismatched = served ? servedMismatches(served, f.rawSignedTx, tx) : [];
  if (mismatched.length > 0) p.add(`${label}: the served tx object disagrees with the raw bytes (${mismatched.join(", ")})`);
  return tx;
}

function nonceRun(ctx: { pack: ParsedPack }, view: { deploys: Map<DeployedName, MirrorTx>; steps: MirrorStep[] }, p: Problems): void {
  const next = new Map<string, number>();
  const use = (from: string, nonce: number, consumes: boolean, label: string) => {
    const want = next.get(from.toLowerCase());
    if (want !== undefined && nonce !== want) p.add(`${label}: nonce ${nonce}, expected ${want} (per-signer nonces must run without gaps)`);
    next.set(from.toLowerCase(), consumes ? nonce + 1 : nonce);
  };
  for (const name of DEPLOYED) {
    const t = view.deploys.get(name);
    if (t?.parsed) use(t.parsed.from, t.parsed.nonce, true, `deploy ${name}`);
  }
  for (const s of view.steps) {
    const t = s.tx?.parsed;
    if (s.step.outcome.kind === "probe-only") {
      const want = next.get(ctx.pack.deployment.roles[s.step.signerRole].toLowerCase());
      if (want !== undefined && s.step.nonce.before !== want) p.add(`${stepLabel(s.step)}: probe-only at nonce ${s.step.nonce.before}, the sender's next nonce is ${want}`);
      continue;
    }
    if (!t) continue;
    const consumes = s.step.outcome.kind !== "rpc-refused";
    use(t.from, t.nonce, consumes, stepLabel(s.step));
    if (s.step.nonce.before !== t.nonce || s.step.nonce.after !== (consumes ? t.nonce + 1 : t.nonce)) p.add(`${stepLabel(s.step)}: nonce before/after ${s.step.nonce.before}/${s.step.nonce.after} disagrees with the tx (${t.nonce}, ${s.step.outcome.kind})`);
  }
}

function deployTxs(ctx: { pack: ParsedPack }, txp: Problems, rec: Problems, bloom: { served: number; absent: number }): Map<DeployedName, MirrorTx> {
  const d = ctx.pack.deployment;
  const out = new Map<DeployedName, MirrorTx>();
  for (const name of DEPLOYED) {
    const hash = d.contracts[name].deployTx;
    if (!hash) {
      txp.add(`deploy ${name}: no deployTx`);
      continue;
    }
    const f = ctx.pack.txs.get(hash);
    const parsed = parseTx(f, hash, d.roles.deployer, `deploy ${name}`, txp);
    if (parsed) {
      if (parsed.to !== null) txp.add(`deploy ${name}: not a contract creation`);
      if (!sameHex(getContractAddress({ from: parsed.from, nonce: BigInt(parsed.nonce) }), d.contracts[name].address)) txp.add(`deploy ${name}: CREATE(deployer, ${parsed.nonce}) is not ${d.contracts[name].address}`);
    }
    if (f?.rawSource === "rebuilt" && !f.tx) txp.add(`deploy ${name}: rebuilt from a served tx that is not in the pack`);
    const events = f ? checkReceipt(ctx, f, parsed?.from ?? null, null, { mined: true, success: true, native: NATIVE_STATUS.ok, logs: "hogee" }, `deploy ${name}`, 0, "deploy", rec, bloom) : [];
    if (f?.receipt && !sameHex(servedAddressOf(f.receipt.contractAddress) ?? d.contracts[name].address, d.contracts[name].address)) rec.add(`deploy ${name}: the receipt's contractAddress is not the deployment's`);
    out.set(name, { hash, file: f ?? null, parsed, call: null, blockNumber: f?.block ? quantity(f.block.number) : null, blockTime: f?.block ? quantity(f.block.timestamp) : null, events });
  }
  if (d.contracts.TreasuryGovernance.deployTx !== null) txp.add("TreasuryGovernance has a deploy tx (Treasury's constructor creates it)");
  if (!sameHex(getContractAddress({ from: d.contracts.Treasury.address as Hex, nonce: 1n }), d.contracts.TreasuryGovernance.address)) txp.add("TreasuryGovernance is not Treasury's first CREATE");
  return out;
}

/** A probe-only step: no tx, its nonce kept, its eth_call the step's call from its role to its contract. */
function probeOnly(ctx: { pack: ParsedPack }, s: Step, txp: Problems): null {
  const label = stepLabel(s);
  if (s.outcome.txHash || s.outcome.rpcError) txp.add(`${label}: probe-only, yet it names a tx or an RPC error`);
  if (s.nonce.before !== s.nonce.after) txp.add(`${label}: probe-only, yet the sender's nonce moved`);
  const c = s.call;
  if (!c) return (txp.add(`${label}: probe-only without its eth_call`), null);
  if (!sameHex(c.from, ctx.pack.deployment.roles[s.signerRole])) txp.add(`${label}: the eth_call is not from its role's address`);
  if (!sameHex(c.to, targetAddressOf(ctx.pack.deployment, s.contract))) txp.add(`${label}: the eth_call is not to ${s.contract}`);
  const name = probeCallName(c.data);
  if (name !== s.function || CALL_CONTRACT[name] !== s.contract) txp.add(`${label}: the eth_call is ${name ?? "no Hogee call"}, not ${s.contract}.${s.function}`);
  return null;
}

function stepTx(ctx: { pack: ParsedPack }, s: Step, txp: Problems, rec: Problems, bloom: { served: number; absent: number }): MirrorTx | null {
  const d = ctx.pack.deployment;
  const label = stepLabel(s);
  if (s.outcome.kind === "probe-only") return probeOnly(ctx, s, txp);
  const hash = s.outcome.txHash;
  if (!hash) {
    txp.add(`${label}: names no tx hash (the raw bytes of every send are kept)`);
    return null;
  }
  const f = ctx.pack.txs.get(hash);
  if (f && f.rawSource !== "sent") txp.add(`${label}: a step tx must keep the bytes it sent`);
  const parsed = parseTx(f, hash, d.roles[s.signerRole], label, txp);
  const contract = targetAddressOf(d, s.contract);
  if (parsed && !sameHex(parsed.to, contract)) txp.add(`${label}: sent to ${parsed.to ?? "(creation)"}, not ${s.contract}`);
  const system = isSystemName(s.contract);
  const call = !parsed ? null : system ? decodeSystemCall(s.contract as never, parsed.data) : decodeCall(parsed, s.contract as never);
  if (parsed && call?.name !== s.function) txp.add(`${label}: calldata is ${call ? call.name : `no allow-listed call of ${s.contract}`}, not ${s.function}`);
  const mined = s.outcome.kind !== "rpc-refused";
  const success = s.outcome.kind === "mined";
  const logs: LogRule = !system ? "hogee" : s.function === "createResetAdminProposal" ? "proposal" : "none";
  const events = f ? checkReceipt(ctx, f, parsed?.from ?? null, contract, { mined, success, native: nativeWant(catalogueEntry(s.id), success), logs }, label, s.seq, s.id, rec, bloom) : [];
  if (s.outcome.kind === "rpc-refused" && !s.outcome.rpcError) rec.add(`${label}: refused at the RPC without the node's error`);
  return { hash, file: f ?? null, parsed, call, blockNumber: mined && f?.block ? quantity(f.block.number) : null, blockTime: mined && f?.block ? quantity(f.block.timestamp) : null, events };
}

function blockOrder(ctx: { pack: ParsedPack }, view: { deploys: Map<DeployedName, MirrorTx>; steps: MirrorStep[] }, p: Problems): void {
  const blocks = new Map<string, { hash: string; parent: string; time: bigint }>();
  const order: { n: bigint; t: bigint; i: bigint | null; label: string }[] = [];
  const visit = (t: MirrorTx | null, label: string) => {
    const b = t?.file?.block;
    if (!b || t?.blockNumber === null || t?.blockNumber === undefined) return;
    const known = blocks.get(b.number);
    if (known && !sameHex(known.hash, b.hash)) p.add(`block ${b.number} is served with two hashes`);
    blocks.set(b.number, { hash: b.hash, parent: b.parentHash, time: t.blockTime ?? 0n });
    const index = t.file?.receipt ? quantity(t.file.receipt.transactionIndex) : null;
    order.push({ n: t.blockNumber, t: t.blockTime ?? 0n, i: index, label });
  };
  for (const name of DEPLOYED) visit(view.deploys.get(name) ?? null, `deploy ${name}`);
  const head = ctx.pack.chain;
  for (const s of view.steps) {
    visit(s.tx, stepLabel(s.step));
    const n = s.tx?.blockNumber;
    if (n !== null && n !== undefined && (n <= BigInt(head.headAtStart) || n > BigInt(head.headAtEnd))) p.add(`${stepLabel(s.step)}: block ${n} is outside chain.json headAtStart..headAtEnd`);
  }
  for (let i = 1; i < order.length; i += 1) {
    const [a, b] = [order[i - 1], order[i]] as [(typeof order)[number], (typeof order)[number]];
    if (b.n < a.n) p.add(`${b.label}: block ${b.n} is before the previous step's block ${a.n}`);
    // Two txs in one block: the later in seq order must sit at the higher transactionIndex.
    if (b.n === a.n && (a.i === null || b.i === null || b.i <= a.i)) p.add(`${b.label}: index ${String(b.i)} of block 0x${b.n.toString(16)} is not after ${a.label}'s index ${String(a.i)}`);
    if (b.t < a.t) p.add(`${b.label}: block time goes back`);
  }
  for (const [n, b] of blocks) {
    const prev = blocks.get(`0x${((quantity(n) ?? 0n) - 1n).toString(16)}`);
    if (prev && !sameHex(prev.hash, b.parent)) p.add(`block ${n}: parentHash is not block ${(quantity(n) ?? 0n) - 1n}'s hash`);
  }
}

function checkCatalogue(steps: readonly Step[], p: Problems): void {
  if (steps.length !== CATALOGUE.length) p.add(`${steps.length} steps, the catalogue has ${CATALOGUE.length}`);
  steps.forEach((s, i) => {
    const want = CATALOGUE[i];
    const label = stepLabel(s);
    if (s.seq !== i + 1) p.add(`${label}: seq is not ${i + 1}`);
    if (!want || want.id !== s.id) return p.add(`${label}: the catalogue's step ${i + 1} is ${want?.id ?? "(none)"}`);
    const fields: [string, unknown, unknown][] = [
      ["contract", s.contract, want.contract], ["function", s.function, want.function], ["signerRole", s.signerRole, want.signerRole], ["auth", s.auth, want.auth],
      ["expected", s.expected, want.expected], ["amountMinor", s.amountMinor, want.amountMinor], ["recordsDenialOf", s.links.recordsDenialOf, want.recordsDenialOf],
    ];
    for (const [k, got, exp] of fields) if (got !== exp) p.add(`${label}: ${k} is ${String(got)}, the catalogue says ${String(exp)}`);
    if ((s.expectedError === undefined) !== (want.expectedError === undefined)) p.add(`${label}: expectedError ${s.expectedError === undefined ? "missing" : "on a step expected to succeed"}`);
    if ((s.links.sepoliaTx === undefined) !== (want.sepolia === undefined)) p.add(`${label}: ${want.sepolia ? "names no" : "names a"} source tx`);
    const probe = want.probeOnly === true;
    if ((s.outcome.kind === "probe-only") !== probe || (s.call !== undefined) !== probe) p.add(`${label}: ${probe ? "must be a probe-only eth_call with its call record" : "is not a probe-only step, yet is recorded as one"}`);
  });
}

export interface ViewResult {
  readonly view: MirrorView;
  readonly checks: readonly VerifyCheck[];
}

export function buildView(ctx: { pack: ParsedPack }): ViewResult {
  const cat = new Problems(CATALOGUE_CHECK);
  const txp = new Problems(TXS_CHECK);
  const rec = new Problems(RECEIPTS_CHECK);
  const bloom = { served: 0, absent: 0 };
  checkCatalogue(ctx.pack.steps.steps, cat);
  const deploys = deployTxs(ctx, txp, rec, bloom);
  const steps: MirrorStep[] = ctx.pack.steps.steps.map((s) => ({ step: s, entry: catalogueEntry(s.id), tx: stepTx(ctx, s, txp, rec, bloom) }));
  const used = new Set<string>([...[...deploys.values()].map((t) => t.hash), ...steps.flatMap((s) => (s.tx ? [s.tx.hash] : []))]);
  for (const hash of ctx.pack.txs.keys()) if (!used.has(hash)) txp.add(`txs/${hash}.json belongs to no step or deploy`);
  if (used.size !== deploys.size + steps.filter((s) => s.tx).length) txp.add("two steps or deploys name the same tx");
  nonceRun(ctx, { deploys, steps }, txp);
  blockOrder(ctx, { deploys, steps }, rec);
  const events = steps.flatMap((s) => (s.tx ? [...s.tx.events] : []));
  const view: MirrorView = { steps, byId: new Map(steps.map((s) => [s.step.id, s])), deploys, events };
  const bloomNote = bloom.absent > 0 ? `; logsBloom not served on ${bloom.absent}` : "";
  return {
    view,
    checks: [
      cat.result(`${steps.length} steps in catalogue order`),
      txp.result(`${used.size} legacy txs, chain ${FISCO_CHAIN_ID}, signed by their roles, nonces without gaps`),
      rec.result(`${events.length} events decoded; bloom recomputed on ${bloom.served} receipts${bloomNote}; FISCO header hashes are not recomputed (block hash, parent links and inclusion are as served)`),
    ],
  };
}
