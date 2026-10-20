/**
 * Plain-English labels for the FISCO mirror's checks (@hogee/verify-evidence fisco FISCO_CHECKS, the CLI's folder check
 * and fisco-anchor's Sepolia timestamp), keyed by the names the verifier reports, so a row can be matched with
 * `make verify-fisco` output. fisco-labels.test.ts fails when the verifier gains a check this map doesn't name.
 * An explanation claims no more than the check proves in a browser (no forge build, the FISCO chain's blocks as served,
 * the Sepolia time as recorded); each row also shows the checker's own detail, pass or fail, so its caveats travel with it.
 */
import type { CheckLabel } from "@/lib/verify-labels";
import { isNotRun, safeDetail, type FiscoCheck } from "./fisco-model";

export const FISCO_CHECK_LABELS: Readonly<Record<string, CheckLabel>> = {
  "pack files": {
    label: "Every file is present and well formed",
    explain: "Each file matches its strict format and its keccak256 in hashes.json, and nothing unexpected is added.",
  },
  "step catalogue": {
    label: "Every step is the one planned",
    explain: "Each step matches Hogee's list: who sends it, to which contract, and whether it should go through or be refused.",
  },
  transactions: {
    label: "Signed transactions match the steps",
    explain: "Each raw signed transaction is decoded: its hash, sender, nonce and call must equal what the step says.",
  },
  "receipts and blocks": {
    label: "Receipts and blocks match",
    explain: "Each receipt agrees with its transaction and with its block as the chain served it, down to the chain's own status code.",
  },
  "deploy inputs": {
    label: "Deployed with the same inputs as Sepolia",
    explain: "The contracts on FISCO BCOS were created from the pack's build artifacts with the same constructor values as the Sepolia ones.",
  },
  "code identity": {
    label: "Contract code matches Sepolia's",
    explain: "Matches the Sepolia code outside per-deployment values (build artifacts taken from the pack; run make verify-fisco to rebuild them).",
  },
  plan: {
    label: "The same signed plan",
    explain: "The plan committed on FISCO BCOS is the one the founder signed for Sepolia.",
  },
  signatures: {
    label: "Signatures are valid",
    explain: "Every passkey and wallet signature verifies against the keys registered on the mirror.",
  },
  "mirror parity": {
    label: "The same calls as on Sepolia",
    explain: "Each copied step sends the same data as the Sepolia transaction it mirrors.",
  },
  refusals: {
    label: "Every refusal is explained",
    explain: "Each refused step is explained offline from the rules: a limit, a pause, a frozen account or a banned method.",
  },
  "recorded denials": {
    label: "Refusals were recorded on the chain",
    explain: "Each refusal the agent recorded points at the exact call that was refused.",
  },
  "T28 cross-chain replay": {
    label: "A Sepolia signature can't be used here",
    explain: "Sepolia's own release, sent again on FISCO BCOS, is refused: a signature is bound to its chain.",
  },
  "final state": {
    label: "The final balances add up",
    explain: "After the last step, the wallet holds what the plan says it should.",
  },
  "regulator ledger": {
    label: "The regulator's copy of the ledger matches",
    explain: "Every step of this pack sits in the copy of the ledger the regulator's own node served, and a validator's digest of the same blocks was recorded with it.",
  },
  "regulator powers": {
    label: "The regulator's steps are in order",
    explain: "Each freeze, ban and lift was signed by the regulator, took effect before the refusal it explains, and was undone after.",
  },
  "pack folder": {
    label: "The pack is the one listed",
    explain: "The pack the app served is named after the pack's own id.",
  },
  "Sepolia timestamp": {
    label: "Timestamped on Sepolia",
    explain: "A Sepolia transaction from Hogee's deployer, recorded with the pack, names this pack and the hash of its index file. Its block and time are as recorded; Etherscan confirms them.",
  },
};

/** The label for a check name; an unknown name is shown as the verifier wrote it. */
export function fiscoCheckLabel(name: string): CheckLabel {
  return Object.hasOwn(FISCO_CHECK_LABELS, name) ? (FISCO_CHECK_LABELS[name] as CheckLabel) : { label: name, explain: "" };
}

export type FiscoCheckState = "passed" | "failed" | "not-run";

/**
 * A row's detail cap (safeDetail's default 300 stays for everything else): the anchor ok-line runs to about 440
 * characters, and its "as stated by the sidecar … only --anchor-rpc or Etherscan confirms them" caveat comes last.
 */
export const MAX_ROW_DETAIL = 600;

export interface FiscoCheckRow extends CheckLabel {
  readonly state: FiscoCheckState;
  /** The checker's own detail (escaped and capped by safeDetail), on a passing row too: it carries the check's caveats. */
  readonly detail: string | null;
}

/** One row of the checks list: the plain label, whether it passed, failed or was skipped ("not run: …"), and its detail. */
export function fiscoCheckRow(check: FiscoCheck): FiscoCheckRow {
  const state: FiscoCheckState = check.ok ? "passed" : isNotRun(check) ? "not-run" : "failed";
  return { ...fiscoCheckLabel(check.name), state, detail: check.detail ? safeDetail(check.detail, MAX_ROW_DETAIL) : null };
}
