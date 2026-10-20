// Offline evidence verifier (project.md §16). Zero runtime network, synchronous, browser-safe: the evidence explorer
// (P2) runs it in the page, `make verify` through src/cli.ts. Every check below recomputes from the bundle's JSON and
// raw receipts; nothing is taken as true because the exporter wrote it:
//   bundle files, file hashes        — layout, strict schemas, keccak256 of every file vs hashes.json
//   transactions, receipts           — every row tx: raw signed bytes → hash, sender, nonce, call = row; its receipt
//                                      (CANCELLED: the same-signer, same-nonce consumer), status, logs, bloom
//   plan hashes, country pack        — planHash / countryPackHash = keccak256(JCS), version chain
//   plan approvals                   — PlanApproval ↔ manifest ↔ commitPlan calldata ↔ PlanCommitted in that tx
//   event sources                    — every event sits in the receipt of the signed call that emits it, = calldata
//   EIP-712 digests                  — canonical types, deployment domain (salt), digest from the message
//   founder signatures (ECDSA, P-256) — against the key in the lender-signed registerFounderKey calldata
//   event replay                     — Spent / MilestoneFunded / … against the plan rules, as Treasury checks them;
//                                      reverted agent calls must be refused by those rules
//   rationale commitments            — keccak256(JCS(preimage) [‖ salt]) = row and on-chain rationaleHash
//   trace hash chains, LLM call log, evidence rows, SUMMARY.md (regenerated, byte-equal)
// What this proves is internal consistency. hashes.json is an unkeyed index, so chain truth comes from the anchor
// (`anchor` in the result): a judge compares it with the block explorer, or `verifyOnline` / `--rpc` with a node.
import { anchorOf, type BundleAnchor } from "./anchor";
import { checkLlmCalls, checkRows, checkTraces } from "./audit";
import { BUNDLE_FILES } from "./bundle";
import { checkChain } from "./chain";
import { checkEventSources } from "./events";
import { loadBundle, type BundleFiles } from "./load";
import { checkPlans } from "./plans";
import { checkRationales } from "./rationales";
import { checkReplay } from "./replay";
import { checkSignatures } from "./signatures";
import { checkSummary } from "./summary";
import { fileText, type VerifyCheck } from "./util";

export type { BundleFiles } from "./load";
export type { VerifyCheck } from "./util";
export { MAX_BUNDLE_FILES, MAX_FILE_BYTES, hashesFileOf } from "./load";
export * from "./bundle";
export { HOGEE_TYPEHASHES, HOGEE_TYPES, VERIFYING_CONTRACT, domainSalt, typeString } from "./eip712";
export { hogeeCallsAbi, hogeeEventsAbi } from "./abi";
export { linesHash, stagesHash } from "./plans";
export { logsBloom } from "./chain";
export { commitmentOf } from "./rationales";
export { anchorLines, anchorOf, type BundleAnchor } from "./anchor";
export { anchorTxs, summaryMarkdown, summarySourceOf, type SummarySource } from "./summary";
export { ONLINE_CHECK, receiptConsensus, verifyOnline, type OnlineOptions } from "./online";

export type VerifyResult = {
  readonly ok: boolean;
  readonly checks: readonly VerifyCheck[];
  /** What to compare with the chain (null when the bundle does not load). `ok` means internally consistent only. */
  readonly anchor: BundleAnchor | null;
};

/** Verifies an evidence bundle offline. `ok` only when every check passes (any mismatch fails it). */
export function verifyBundle(files: BundleFiles): VerifyResult {
  const loaded = loadBundle(files);
  const checks: VerifyCheck[] = [...loaded.checks];
  const b = loaded.bundle;
  if (!b) {
    checks.push({ name: "cryptographic verification", ok: false, detail: "not run: the bundle's files are missing or invalid" });
    return { ok: false, checks, anchor: null };
  }
  try {
    const chain = checkChain(b);
    checks.push(...chain.checks);
    checks.push(...checkPlans(b, chain.events));
    checks.push(checkEventSources(b, chain.txs, chain.events));
    checks.push(...checkSignatures(b, chain));
    checks.push(checkReplay(b, chain));
    checks.push(checkRationales(b, chain.events));
    checks.push(checkTraces(b), checkLlmCalls(b), checkRows(b, chain));
    const summary = files[BUNDLE_FILES.summary];
    checks.push(checkSummary(b, summary === undefined ? null : fileText(summary)));
  } catch (error: unknown) {
    // A verifier bug must never read as "verified".
    checks.push({ name: "verifier error", ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : "unknown error" });
  }
  return { ok: checks.every((c) => c.ok), checks, anchor: anchorOf(b) };
}
