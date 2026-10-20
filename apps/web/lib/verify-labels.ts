/**
 * Plain-English labels for the offline verifier's checks (tools/verify-evidence; G0-DECISIONS §10, §14, §16, §18),
 * keyed by the check names it reports. The explorer shows the label and the explanation, with the verifier's own name
 * beside them so a row can be matched with `make verify` output. verify-labels.test.ts fails when the verifier gains
 * a check this map doesn't name.
 */
export interface CheckLabel {
  /** What passing means, as a short statement. */
  readonly label: string;
  /** One or two sentences: what the check recomputes and what it catches. */
  readonly explain: string;
}

export const CHECK_LABELS: Readonly<Record<string, CheckLabel>> = {
  "bundle files": {
    label: "Every file is present and well formed",
    explain:
      "Each required file is there and matches its strict format, nothing unexpected is added, and every explorer link is the exact page on the explorer pinned for this chain.",
  },
  "file hashes": {
    label: "No file changed since export",
    explain: "Each file's keccak256 matches hashes.json. That index has no key, so it catches damage, not a careful forger: the checks below do.",
  },
  "cryptographic verification": {
    label: "Cryptographic checks",
    explain: "Skipped when the bundle's files are missing or invalid, because every other check reads them.",
  },
  transactions: {
    label: "Signed transactions match the records",
    explain: "Each recorded transaction's raw signed bytes are decoded: the hash, the sender, the nonce and the call must equal what the record says.",
  },
  receipts: {
    label: "Receipts match the transactions",
    explain: "Every recorded transaction has its receipt, and each receipt's status, block and events agree with the record, down to the log bloom.",
  },
  "plan hashes": {
    label: "Plan check codes redone",
    explain: "Each plan's hash is recomputed from its JSON, and every version points at the one before it.",
  },
  "country pack": {
    label: "Country rules check code redone",
    explain: "The country pack's hash is recomputed from its JSON and equals the hash every plan committed to.",
  },
  "plan approvals": {
    label: "Plan approvals match the chain",
    explain: "The founder's signed approval, the plan, the commitPlan call and the PlanCommitted event in that same transaction all agree.",
  },
  "event sources (calldata ↔ events)": {
    label: "Every event comes from the call that made it",
    explain: "Each on-chain event sits in the receipt of the signed call that emits it, comes from the right contract, and repeats that call's data exactly once.",
  },
  "EIP-712 digests": {
    label: "Signature codes redone",
    explain: "Each approval's digest is rebuilt from its message with the canonical types and this deployment's signing domain.",
  },
  "founder signatures (ECDSA, P-256)": {
    label: "Founder signatures are valid",
    explain: "Each passkey or backup-wallet signature verifies against the founder key the loan officer registered on-chain.",
  },
  "event replay (caps, payees, duplicates)": {
    label: "Payments replayed against the plan",
    explain:
      "Every payment event is replayed against the plan's caps, bound payees and duplicate rules, as the Treasury contract checks them. A reverted agent call must be one those rules refuse.",
  },
  "rationale commitments": {
    label: "AI decision notes weren't changed",
    explain: "Each decision's stored reasoning hashes to the commitment in its record and the one the chain recorded.",
  },
  "trace hash chains": {
    label: "Audit trail is unbroken",
    explain: "Each trace's events are hash-chained, so an edited, removed, reordered or repeated event breaks the chain.",
  },
  "LLM call log (hashed)": {
    label: "AI call log is complete",
    explain: "The AI calls are logged as hashes of the redacted prompt and answer, never the text, and every call a trace names is in the log.",
  },
  "evidence rows": {
    label: "Results table matches the facts",
    explain: "Each row's receipt, contract, trace and decision exist and agree with the outcome the row claims.",
  },
  "SUMMARY.md (regenerated)": {
    label: "Summary rebuilt exactly",
    explain: "SUMMARY.md is rebuilt from the other files and must be identical, so the readable summary can't claim more than the data.",
  },
  "chain anchor (online, --rpc)": {
    label: "Matches the live blockchain",
    explain:
      "Only with an RPC node (make verify with --rpc): every receipt and block is fetched again and compared byte for byte. The contract addresses still need comparing with the announced deployment.",
  },
  "bundle files on disk": {
    label: "Every file on disk was readable",
    explain: "Command line only: a file the verifier refused to read, such as a link, makes the bundle unverified.",
  },
  "verifier error": {
    label: "The checker finished",
    explain: "The verifier itself failed on this bundle, so it counts as not verified.",
  },
};

/** The label for a check name; an unknown name is shown as the verifier reports it. */
export function checkLabel(name: string): CheckLabel {
  return Object.hasOwn(CHECK_LABELS, name) ? (CHECK_LABELS[name] as CheckLabel) : { label: name, explain: "" };
}
