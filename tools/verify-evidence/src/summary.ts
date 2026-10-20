/**
 * SUMMARY.md: the bundle's human-readable index, generated from the bundle's own files (§16). It lives here so the
 * exporter (packages/api evidence/summary.ts) and the verifier share one generator: "SUMMARY.md" regenerates it from
 * the parsed files and requires byte equality (run-6 v-6: it was only checked for existence). It states what VERIFIED
 * means and lists the anchor a judge compares with the chain.
 */
import type { BundleManifest, EvidenceRow } from "@hogee/core";
import { explorerOf, type ChainActionEntry, type ContractName, type ContractsFile, type PaymentEntry, type ParsedBundle } from "./bundle";
import { Problems, type VerifyCheck } from "./util";

export interface SummarySource {
  readonly manifest: Pick<BundleManifest, "runId" | "gitCommit">;
  readonly contracts: ContractsFile;
  readonly rows: readonly EvidenceRow[];
  readonly payments: readonly PaymentEntry[];
  readonly chainActions: readonly ChainActionEntry[];
  readonly counts: { readonly plans: number; readonly signatures: number; readonly traces: number; readonly llmCalls: number; readonly rationales: number; readonly receipts: number };
  readonly countryPackIncluded: boolean;
}

export const CONTRACT_NAMES: readonly ContractName[] = ["PlanRegistry", "Treasury", "MilestoneEscrow", "SalesOracle"];
const MINED_OK = new Set(["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"]);

const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The txs the bundle shows mined, with the rows that name them and their status; sorted by hash. */
export function anchorTxs(payments: readonly PaymentEntry[], actions: readonly ChainActionEntry[]): { hash: string; rows: string[]; status: string }[] {
  const out = new Map<string, { hash: string; rows: string[]; status: string }>();
  const add = (hash: string, row: string, status: string) => {
    const h = hash.toLowerCase();
    const t = out.get(h) ?? { hash: h, rows: [], status };
    t.rows.push(row);
    out.set(h, t);
  };
  const statusOf = (state: string) => (state === "REVERTED" ? "reverted" : MINED_OK.has(state) ? "success" : state);
  for (const e of payments) {
    const p = e.payment;
    if (p.txHash && p.state !== "CANCELLED") add(p.txHash, p.paymentId, statusOf(p.state));
    if (e.nonceConsumedBy) add(e.nonceConsumedBy.txHash, `consumed ${p.paymentId}'s nonce`, "mined");
  }
  for (const a of actions) if (a.txHash) add(a.txHash, a.actionId, statusOf(a.state));
  return [...out.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1));
}

export function summaryMarkdown(s: SummarySource): string {
  const c = s.contracts;
  const txs = anchorTxs(s.payments, s.chainActions);
  // Links are built from the explorer pinned for the chain, never from the bundle's URLs (run-6 re-check M5).
  const explorer = explorerOf(c.chainId);
  const link = (hash: string) => (explorer ? `[\`${hash}\`](${explorer}/tx/${hash})` : `\`${hash}\``);
  const verification = (x: { address: string; verified: boolean }) => {
    if (!explorer) return "no explorer for this chain";
    const url = `${explorer}/address/${x.address.toLowerCase()}#code`;
    return x.verified ? url : `not verified (${url})`;
  };
  const lines = [
    `# Evidence bundle ${s.manifest.runId}`,
    "",
    "Generated from this bundle's own files (tools/verify-evidence summary.ts). Do not edit: `make verify` regenerates this",
    "file and fails on any difference, and `hashes.json` lists the keccak256 of every file.",
    "",
    "## What VERIFIED means",
    "",
    "`make verify` (no network) recomputes every file hash, EIP-712 digest, founder signature and rationale commitment, binds",
    "every row to its signed transaction and every event to the calldata that produced it, and replays the event log",
    "against the signed plan. VERIFIED means the bundle is internally consistent. It does not by itself prove that the",
    "chain holds these transactions: `hashes.json` is an unkeyed index that anyone can regenerate. Chain truth comes from",
    "comparing the anchor below with the block explorer (Sepolia Etherscan), or from `HOGEE_VERIFY_RPC=<url> make verify`.",
    "",
    `- Facility: \`${c.facilityId}\``,
    `- Deployment: \`${c.deploymentId}\` on chain ${c.chainId} (\`${c.chainTag}\`)`,
    `- Code: \`${s.manifest.gitCommit}\``,
    `- Exported: ${c.exportedAt}`,
    "",
    "## Anchor: compare with the chain",
    "",
    "| Contract | Address | Verification |",
    "|---|---|---|",
    ...CONTRACT_NAMES.flatMap((name) => {
      const x = c.contracts[name];
      return x ? [`| ${name} | \`${x.address}\` | ${verification(x)} |`] : [];
    }),
    "",
    `Each of these ${txs.length} transactions must exist on chain ${c.chainId} with the status shown (the newest block's number and hash are printed by \`make verify\`):`,
    "",
    ...(txs.length === 0 ? ["No transaction."] : ["| Tx | Row | Status |", "|---|---|---|", ...txs.map((t) => `| ${link(t.hash)} | ${cell(t.rows.join(", "))} | ${t.status} |`)]),
    "",
    "## Evidence rows",
    "",
    "Rows come only from database facts: an attack is recognised by its on-chain revert or its recorded policy refusal, so an",
    "attack that succeeded on chain produces no row here (the red-team runner's report is the place for those).",
    "",
    s.rows.length === 0 ? "No row maps to a scripted task or attack yet." : "| Task | Layer | Outcome | Title | Tx |",
    ...(s.rows.length === 0 ? [] : ["|---|---|---|---|---|", ...s.rows.map((r) => `| ${r.taskId} | ${r.layer} | ${r.outcome} | ${cell(r.title)} | ${r.txHash ? `\`${r.txHash}\`` : "—"} |`)]),
    "",
    "## Contents",
    "",
    `- ${s.counts.plans} plan versions, ${s.counts.signatures} signature requests, ${s.payments.length} payments, ${s.chainActions.length} chain actions`,
    `- ${s.counts.receipts} raw receipts (\`receipts/\`), ${s.counts.traces} trace events, ${s.counts.llmCalls} LLM calls (hashes only)`,
    `- ${s.counts.rationales} rationale preimages (every decision ships its own)`,
    `- Country pack: ${s.countryPackIncluded ? "included with its hash" : "NOT included (the pack the plans commit to was not available)"}`,
    `- Eval traces left out (measurements, not decisions): ${c.excludedEvalTraces}`,
    "",
    "Revert reasons are the worker's decoding of each failed tx; a receipt carries no revert data, so the verifier checks the",
    "status, and replays each reverted agent call to confirm the plan rules refuse it.",
    "",
  ];
  return lines.join("\n");
}

/** The summary source of a parsed bundle (what the exporter passed, recomputed from the files). */
export function summarySourceOf(b: ParsedBundle): SummarySource {
  return {
    manifest: b.manifest,
    contracts: b.contracts,
    rows: b.rows,
    payments: b.payments,
    chainActions: b.chainActions,
    counts: { plans: b.plans.length, signatures: b.signatures.length, traces: b.traces.length, llmCalls: b.llmCalls.length, rationales: b.rationales.length, receipts: b.receipts.size },
    countryPackIncluded: b.countryPack !== null,
  };
}

export function checkSummary(b: ParsedBundle, text: string | null): VerifyCheck {
  const p = new Problems("SUMMARY.md (regenerated)");
  if (text !== summaryMarkdown(summarySourceOf(b))) p.add("SUMMARY.md is not the summary this bundle's files generate (it was edited or written by another generator)");
  return p.result("byte-equal to the summary regenerated from the files");
}
