/**
 * The audit trail:
 *   "trace hash chains": per traceId, seq runs 0..n in order, prevHash is the previous event's hash (zero first), and
 *     hash = keccak256(utf8(JCS(event without hash))) — so an edited, removed, reordered or repeated event breaks it;
 *     no eval event (`[eval …`) is decision evidence;
 *   "LLM call log": hashes only (the schema has no text fields), unique ids, every llmCallId a trace names is logged;
 *   "evidence rows": manifest.json lists exactly contracts.json's deployment and contracts (same addresses);
 *     each row's deployment, artifacts, receipt (status, block, contract), trace and decision exist
 *     and agree with the layer it claims; an agent_refusal row names the recordDenied tx that anchored its decision
 *     whenever the bundle has one, and a refusal's anchor is a recordDenied of that decision.
 */
import { hashObject, ZERO_HEX32, type EvidenceRow, type TraceEvent } from "@hogee/core";
import type { ParsedBundle } from "./bundle";
import { receiptPath, type ContractName } from "./bundle";
import { contractOf, type ChainView } from "./chain";
import { decisionIdToBytes32, Problems, quantity, sameHex, type VerifyCheck } from "./util";

const EVAL_PREFIX = "[eval ";

export function checkTraces(b: ParsedBundle): VerifyCheck {
  const p = new Problems("trace hash chains");
  const byTrace = new Map<string, TraceEvent[]>();
  for (const t of b.traces) {
    const list = byTrace.get(t.traceId) ?? [];
    list.push(t);
    byTrace.set(t.traceId, list);
  }
  for (const [traceId, list] of byTrace) {
    let prev: string = ZERO_HEX32;
    list.forEach((t, i) => {
      const where = `${traceId}#${t.seq}`;
      if (t.seq !== i) p.add(`${where}: expected seq ${i} (an event is missing, repeated or out of order)`);
      if (t.prevHash !== prev) p.add(`${where}: prevHash does not link to the previous event`);
      const { hash, ...body } = t;
      if (hashObject(body) !== hash) p.add(`${where}: hash is not keccak256(JCS(event))`);
      if (t.summary.startsWith(EVAL_PREFIX)) p.add(`${where}: an eval trace is not decision evidence`);
      prev = hash;
    });
  }
  return p.result(`${byTrace.size} traces, ${b.traces.length} events re-hashed`);
}

export function checkLlmCalls(b: ParsedBundle): VerifyCheck {
  const p = new Problems("LLM call log (hashed)");
  const ids = new Set<string>();
  for (const c of b.llmCalls) {
    if (ids.has(c.llmCallId)) p.add(`${c.llmCallId} is listed twice`);
    ids.add(c.llmCallId);
  }
  for (const t of b.traces) if (t.refs.llmCallId && !ids.has(t.refs.llmCallId)) p.add(`${t.traceId}#${t.seq} names ${t.refs.llmCallId}, which is not in the log`);
  return p.result(`${b.llmCalls.length} calls, prompts and responses as hashes only`);
}

function checkOnchainRow(b: ParsedBundle, row: EvidenceRow, where: string, p: Problems): void {
  const receipt = row.txHash ? b.receipts.get(row.txHash) : undefined;
  if (!receipt) return p.add(`${where}: no receipt for ${row.txHash ?? "its tx"}`);
  const reverted = receipt.status === "0x0";
  if ((row.layer === "onchain_success") === reverted) p.add(`${where}: the receipt ${reverted ? "reverted" : "succeeded"}, not ${row.layer}`);
  if (row.block !== undefined && BigInt(row.block) !== quantity(receipt.blockNumber)) p.add(`${where}: block is not the receipt's`);
  const named = row.contract.startsWith("0x") ? row.contract : b.contracts.contracts[row.contract as "Treasury"]?.address;
  if (!named || !sameHex(named, receipt.to) || !contractOf(b, named)) p.add(`${where}: contract ${row.contract || "(none)"} is not the receipt's deployment contract`);
  if (!row.artifacts.includes(receiptPath(receipt.transactionHash))) p.add(`${where}: its receipt is not among its artifacts`);
  const passed = row.layer === "onchain_success" ? row.expected === "success" : row.expected === "revert" && (!row.expectedError || row.revertReason === row.expectedError);
  if ((row.outcome === "pass") !== passed) p.add(`${where}: outcome ${row.outcome} does not follow from expected ${row.expected} and the receipt`);
}

/** The successful recordDenied txs by the decision (bytes32) their calldata anchors. */
function deniedTxs(chain: ChainView): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of chain.txs.values()) {
    if (t.call?.name === "recordDenied" && t.receipt?.status === "0x1") out.set(String(t.call.args[1]).toLowerCase(), t.hash);
  }
  return out;
}

function checkRefusal(chain: ChainView, denied: ReadonlyMap<string, string>, row: EvidenceRow, where: string, p: Problems): void {
  const decision = row.decisionId ? decisionIdToBytes32(row.decisionId) : null;
  const anchor = decision ? denied.get(decision) : undefined;
  if (anchor && !sameHex(row.txHash, anchor)) p.add(`${where}: its decision was anchored by recordDenied ${anchor}, which the row does not name`);
  if (!row.txHash) return;
  const call = chain.txs.get(row.txHash.toLowerCase())?.call;
  if (call?.name !== "recordDenied") p.add(`${where}: its anchoring tx is not a recordDenied call`);
  else if (!decision || !sameHex(String(call.args[1]), decision)) p.add(`${where}: its recordDenied anchors another decision`);
}

export function checkRows(b: ParsedBundle, chain: ChainView): VerifyCheck {
  const p = new Problems("evidence rows");
  const deployment = b.manifest.deployments[b.contracts.deploymentId];
  if (!deployment || deployment.chainId !== b.contracts.chainId) p.add(`manifest.json has no deployment ${b.contracts.deploymentId} on chain ${b.contracts.chainId}`);
  // The exporter writes exactly this deployment. Another entry is bound by nothing here, yet a reader could take it for
  // where the pack was recorded (audit run-10 v-3), so it fails the pack.
  if (Object.keys(b.manifest.deployments).some((id) => id !== b.contracts.deploymentId)) p.add(`manifest.json lists a deployment other than ${b.contracts.deploymentId}`);
  for (const [name, c] of Object.entries(b.contracts.contracts)) {
    if (c && !sameHex(deployment?.contracts[name]?.address, c.address)) p.add(`manifest.json and contracts.json disagree on ${name}`);
  }
  // And back: the exporter writes contracts.json's own set. A name contracts.json lacks is bound by nothing, yet the
  // Proof page lists and links it (run-10 skills re-check H-1). Own keys only: "constructor" passes the name schema.
  for (const name of Object.keys(deployment?.contracts ?? {})) {
    if (!Object.hasOwn(b.contracts.contracts, name) || !b.contracts.contracts[name as ContractName]) p.add(`manifest.json lists ${name} in ${b.contracts.deploymentId}, which contracts.json does not name`);
  }
  if (b.manifest.runId !== b.contracts.runId) p.add("manifest.json and contracts.json name another run");
  const traceIds = new Set(b.traces.map((t) => t.traceId));
  const denied = deniedTxs(chain);
  const decisions = new Set(b.payments.flatMap((x) => (x.payment.decisionId ? [x.payment.decisionId] : [])).concat(b.rationales.flatMap((r) => (r.decisionId ? [r.decisionId] : []))));
  b.rows.forEach((row, i) => {
    const where = `row ${i} ${row.taskId}`;
    if (row.deploymentId !== b.contracts.deploymentId || row.chainId !== b.contracts.chainId) p.add(`${where}: another deployment or chain`);
    for (const a of row.artifacts) if (!b.paths.has(a)) p.add(`${where}: artifact ${a} is not in the bundle`);
    if (row.layer === "onchain_success" || row.layer === "onchain_revert") checkOnchainRow(b, row, where, p);
    if (row.traceId && !traceIds.has(row.traceId)) p.add(`${where}: trace ${row.traceId} is not in traces.json`);
    if (row.decisionId && !decisions.has(row.decisionId)) p.add(`${where}: decision ${row.decisionId} is not in the bundle`);
    if (row.layer !== "onchain_success" && row.layer !== "onchain_revert" && row.txHash) {
      const anchor = b.receipts.get(row.txHash);
      if (!anchor || anchor.status !== "0x1") p.add(`${where}: its anchoring tx ${row.txHash} has no successful receipt`);
      else if (!row.artifacts.includes(receiptPath(anchor.transactionHash))) p.add(`${where}: its anchoring receipt is not among its artifacts`);
    }
    if (row.layer === "agent_refusal") {
      checkRefusal(chain, denied, row, where, p);
      const refused = b.traces.some((t) => t.traceId === row.traceId && ((t.verdict !== undefined && t.verdict !== "AUTO") || t.kind === "DENIAL"));
      if (!refused) p.add(`${where}: its trace records no refusal`);
    }
  });
  return p.result(`${b.rows.length} rows agree with receipts and traces`);
}
