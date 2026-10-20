/**
 * The mirror's step catalogue: the final-2 run replayed on FISCO BCOS, plus the refusals. One entry per step id, in
 * replay order. The replay (scripts/redteam/src/fisco/) sends exactly these calls with these signers; the checker
 * (./index.ts) holds every steps.json row to its entry, and derives each refusal's error OFFLINE from the entry's
 * rule (never from what the node said, which FISCO may not even return).
 *
 * Amounts are minor units (100 minor = 1 BU) from the final-2 plan and rows (evidence/ev-74756ea61a72ae7c).
 * "founder" signatures are passkey (P-256) assertions the relayer submits; the relayer gains no authority.
 * Denials stay below 3 per key in a window (Treasury circuit breaker): D7 on LOGISTICS, D9 on no line, D17 on
 * PLATFORM_FEES.
 *
 * Version 2 (37 entries) adds the regulator's chain-level powers through FISCO governance (system.ts), all FISCO-only
 * (no `sepolia` field, so parity skips them): G0 registers the agent's account before its first tx (trap 1: a freeze
 * of an unregistered account freezes nothing and still reports success), G1/G2 freeze and unfreeze it, and V1/V2 (the
 * regulator sending getAccountStatus as a tx) prove in the next block that the new status is in force (a status change
 * applies from the NEXT block); G3 makes the regulator Treasury's ContractAuth admin, G4–G6 ban Treasury.spend for the
 * agent and lift the ban (immediate). F1 and M1 send SPEND (R17's exact calldata, built once) and the CHAIN refuses
 * them; C1–C3 are eth_call probes that are never sent. Then S16/R17 pause and refuse the same SPEND at contract level:
 * three independent stops on one calldata.
 */
import type { Auth, Role, TargetName } from "./pack";
import { tagToBytes32 } from "../util";

/** The Hogee custom errors a catalogue refusal can derive (IHogeeErrors). */
export type HogeeError = "CapExceeded" | "MilestoneLocked" | "NotOwner" | "InvalidSignature" | "SignatureExpired" | "Paused";
/** A refusal by the FISCO chain itself, before Hogee's contract runs (native status 22 / 18, system.ts). */
export type ChainRefusal = "AccountFrozen" | "PermissionDenied";
export type RefusalError = HogeeError | ChainRefusal;
export const CHAIN_REFUSALS: readonly ChainRefusal[] = ["AccountFrozen", "PermissionDenied"];
export const isChainRefusal = (e: string | undefined): e is ChainRefusal => (CHAIN_REFUSALS as readonly string[]).includes(e ?? "");

/**
 * How a refusal is explained offline (the checker re-derives the error from the pack):
 *   per-tx-cap        spend.amountMinor > the line's perTxCapMinor in the committed plan       → CapExceeded
 *   agent-releases    releaseMilestone sent by the plan's agent (T5, first guard)              → MilestoneLocked
 *   agent-signs-owner an owner struct (PlanApproval) whose ECDSA signature recovers to the agent → NotOwner
 *   raise-needs-owner tighten kind 1/2 with newValue above the line's current cap (T6)         → NotOwner
 *   paused            a spend after the TreasuryPaused of S16, by the agent                     → Paused
 *   foreign-domain    a founder signature over another deployment's domain (T28): the passkey
 *                     signature does not verify under the FISCO escrow's digest                → InvalidSignature,
 *                     or SignatureExpired first when the block time is past the signed expiry (the envelope check
 *                     precedes the signature check: HogeeDomain._useEnvelope)
 *   account-frozen    the agent's account was frozen by the last account-status G step before it (output 0, a
 *                     strictly earlier block, after G0's registration), a V step between them read 1 on chain, and
 *                     no G step undid it                                                             → AccountFrozen
 *   method-banned     Treasury.spend was closed for the agent by the regulator as Treasury's admin (G3 read, then
 *                     G4 blacklist type and G5 close, each output 0, earlier blocks), not reopened  → PermissionDenied
 */
export type RuleCode = "per-tx-cap" | "agent-releases" | "agent-signs-owner" | "raise-needs-owner" | "paused" | "foreign-domain" | "account-frozen" | "method-banned";

/** Labels of the regulator's state reads (eth_call before and after a G step) and what each reads. */
export const GOV_READS = {
  /** AccountManager.getAccountStatus(agent): "0" normal, "1" frozen. */
  accountStatus: "accountStatus",
  /** ContractAuth.getAdmin(Treasury): a lowercase address. */
  treasuryAdmin: "treasuryAdmin",
  /** ContractAuth.checkMethodAuth(Treasury, spend.selector, agent): "true" / "false". */
  spendAllowed: "spendAllowed",
} as const;
export type GovRead = (typeof GOV_READS)[keyof typeof GOV_READS];

/**
 * A symbolic system-call argument: a role or Treasury resolves to its deployment.json address, spend.selector to
 * Treasury.spend's selector (system.ts SPEND_SELECTOR); a number is the literal value.
 */
export type GovArg = "agent" | "regulator" | "Treasury" | "spend.selector" | number;

/**
 * What a G or V step sends, the return value it must give (its eth_call before sending, then the native receipt's
 * output), and what its state read must show.
 */
export interface Governance {
  /** The call's arguments in ABI order (system.ts). */
  readonly args: readonly GovArg[];
  /** The return word: an exact value, or (G3) any proposal id above 0, checked through the getAdmin read instead. */
  readonly output: number | "proposal-id";
  /**
   * Its state read (eth_call at the head before sending and after the receipt); before/after are literal values, or a
   * role name ("deployer", "regulator") for an address. None on G1/G2: at their own block the chain still shows the
   * old status, so V1/V2 carry the read.
   */
  readonly read?: { readonly label: GovRead; readonly before?: string; readonly after: string };
}

/**
 * The final-2 Sepolia tx a step mirrors (check 8), looked up in the source bundle:
 *   calldata — byte-identical calldata;
 *   envelope — the same signed struct and arguments except deploymentId domain, nonce, expiry and the signature;
 *   order    — the same orderId, milestone idx and amount (a fresh decision id and rationale on the mirror).
 */
export interface SepoliaMirror {
  readonly source: "action" | "payment";
  /** A chain-actions.json kind (`Treasury.openFacility`) or a payments.json kind (`FUND_MILESTONE`). */
  readonly kind: string;
  /** The n-th matching row in bundle order (confirmSettlement appears twice). */
  readonly nth?: number;
  /** For payments: the milestone index. */
  readonly milestoneIdx?: number;
  readonly compare: "calldata" | "envelope" | "order";
}

export interface CatalogueEntry {
  readonly id: string;
  readonly title: string;
  readonly contract: TargetName;
  readonly function: string;
  /** The tx sender (also the ECDSA signer for ecdsa-agent; the lender signs ecdsa-lender structs the relayer sends). */
  readonly signerRole: Role;
  readonly auth: Auth;
  readonly expected: "ok" | "refused";
  /** The error the rule derives in the normal case (foreign-domain: see expectedErrorsFor). */
  readonly expectedError?: RefusalError;
  readonly rule?: RuleCode;
  readonly amountMinor?: string;
  /** Line and payee keys of a spend / recordDenied / tighten (ShortId or line key; null = no line, bytes32(0)). */
  readonly line?: string | null;
  readonly payee?: string;
  /** D-steps: the refusal whose calldata keccak256 is the proposalHash. */
  readonly recordsDenialOf?: string;
  readonly sepolia?: SepoliaMirror;
  /** Wall-clock wait before sending (FISCO makes no empty blocks): S6 waits out the 120 s payee cooling. */
  readonly waitBeforeSeconds?: number;
  /** G steps: the regulator's system call. */
  readonly governance?: Governance;
  /** C steps: an eth_call only (outcome probe-only, Step.call set), never sent. */
  readonly probeOnly?: true;
  /** SPEND steps: calldata byte-identical to this step's (R17, the refusal at contract level). */
  readonly sameCalldataAs?: "R17";
}

const ORDER_MINOR = "250000";
/** SPEND: R17's spend, 100 BU on PLATFORM_FEES to shopee-sg-fees, sent by F1/M1 and probed by C1/C3. */
const SPEND = { contract: "Treasury", function: "spend", signerRole: "agent", auth: "none", amountMinor: "10000", line: "PLATFORM_FEES", payee: "shopee-sg-fees", sameCalldataAs: "R17" } as const;
const REGULATOR = { signerRole: "regulator", auth: "none", expected: "ok" } as const;
const ACCOUNT = { contract: "AccountManager", function: "setAccountStatus", ...REGULATOR } as const;
const CONFIRM = { contract: "AccountManager", function: "getAccountStatus", ...REGULATOR } as const;
const METHOD_AUTH = { contract: "ContractAuth", ...REGULATOR } as const;
const SPEND_FOR_AGENT: readonly GovArg[] = ["Treasury", "spend.selector", "agent"];
const MILESTONE_0 = "75000";
const MILESTONE_1 = "175000";

export const CATALOGUE: readonly CatalogueEntry[] = [
  { id: "G0", title: "The regulator registers the agent's account (before its first transaction)", ...ACCOUNT, governance: { args: ["agent", 0], output: 0 } },
  { id: "S1", title: "Open the facility (10,000 BU cap, 300 bps reserve floor)", contract: "Treasury", function: "openFacility", signerRole: "lender", auth: "none", expected: "ok", amountMinor: "1000000", sepolia: { source: "action", kind: "Treasury.openFacility", compare: "calldata" } },
  { id: "S2", title: "Register the founder's passkey (no owner EOA)", contract: "PlanRegistry", function: "registerFounderKey", signerRole: "lender", auth: "none", expected: "ok" },
  { id: "S3", title: "Commit plan v1, the final-2 manifest (stage 1 released)", contract: "PlanRegistry", function: "commitPlan", signerRole: "relayer", auth: "passkey", expected: "ok", amountMinor: "1000000", sepolia: { source: "action", kind: "PlanRegistry.commitPlan", compare: "envelope" } },
  { id: "S4", title: "Fund the facility, 10,000 BU", contract: "Treasury", function: "fund", signerRole: "lender", auth: "none", expected: "ok", amountMinor: "1000000", sepolia: { source: "action", kind: "Treasury.fund", compare: "calldata" } },
  { id: "S5", title: "Bind the supplier for the 2,500 BU order (final-2's SupplierApproval)", contract: "Treasury", function: "bindPayee", signerRole: "relayer", auth: "passkey", expected: "ok", amountMinor: ORDER_MINOR, sepolia: { source: "action", kind: "Treasury.bindPayee", compare: "envelope" } },
  { id: "S6", title: "Fund milestone 0, 750 BU (auto-release)", contract: "MilestoneEscrow", function: "fundMilestone", signerRole: "agent", auth: "none", expected: "ok", amountMinor: MILESTONE_0, waitBeforeSeconds: 125, sepolia: { source: "payment", kind: "FUND_MILESTONE", milestoneIdx: 0, compare: "order" } },
  { id: "R7", title: "Spend 300 BU on LOGISTICS (per-tx cap 200 BU)", contract: "Treasury", function: "spend", signerRole: "agent", auth: "none", expected: "refused", expectedError: "CapExceeded", rule: "per-tx-cap", amountMinor: "30000", line: "LOGISTICS", payee: "spx-sg-logistics" },
  { id: "D7", title: "Record the R7 denial on-chain", contract: "Treasury", function: "recordDenied", signerRole: "agent", auth: "none", expected: "ok", line: "LOGISTICS", recordsDenialOf: "R7" },
  { id: "R8", title: "The agent releases milestone 1 itself", contract: "MilestoneEscrow", function: "releaseMilestone", signerRole: "agent", auth: "none", expected: "refused", expectedError: "MilestoneLocked", rule: "agent-releases", amountMinor: MILESTONE_1 },
  { id: "R9a", title: "The agent signs plan v2 raising a cap", contract: "PlanRegistry", function: "commitPlan", signerRole: "agent", auth: "ecdsa-agent", expected: "refused", expectedError: "NotOwner", rule: "agent-signs-owner" },
  { id: "R9b", title: "The agent raises the LOGISTICS per-tx cap through tighten", contract: "Treasury", function: "tighten", signerRole: "agent", auth: "none", expected: "refused", expectedError: "NotOwner", rule: "raise-needs-owner", amountMinor: "30000", line: "LOGISTICS" },
  { id: "D9", title: "Record the R9a denial on-chain (no line)", contract: "Treasury", function: "recordDenied", signerRole: "agent", auth: "none", expected: "ok", line: null, recordsDenialOf: "R9a" },
  { id: "S10", title: "Fund milestone 1, 1,750 BU", contract: "MilestoneEscrow", function: "fundMilestone", signerRole: "agent", auth: "none", expected: "ok", amountMinor: MILESTONE_1, sepolia: { source: "payment", kind: "FUND_MILESTONE", milestoneIdx: 1, compare: "order" } },
  { id: "S11", title: "Record 2,000 BU of sales (stage 2 gate)", contract: "SalesOracle", function: "recordSale", signerRole: "oracle", auth: "none", expected: "ok", amountMinor: "200000" },
  { id: "S12", title: "Release stage 2, 6,000 BU (lender-signed, relayer sends)", contract: "Treasury", function: "releaseStage", signerRole: "relayer", auth: "ecdsa-lender", expected: "ok", amountMinor: "600000" },
  { id: "T28a", title: "Replay final-2's milestone-1 release calldata byte for byte", contract: "MilestoneEscrow", function: "releaseMilestone", signerRole: "relayer", auth: "passkey", expected: "refused", expectedError: "InvalidSignature", rule: "foreign-domain", amountMinor: MILESTONE_1, sepolia: { source: "payment", kind: "RELEASE_MILESTONE", milestoneIdx: 1, compare: "calldata" } },
  { id: "T28b", title: "A fresh milestone-1 release signed over the Sepolia domain", contract: "MilestoneEscrow", function: "releaseMilestone", signerRole: "relayer", auth: "passkey", expected: "refused", expectedError: "InvalidSignature", rule: "foreign-domain", amountMinor: MILESTONE_1 },
  { id: "S15", title: "Release milestone 1, 1,750 BU, under the FISCO domain (control)", contract: "MilestoneEscrow", function: "releaseMilestone", signerRole: "relayer", auth: "passkey", expected: "ok", amountMinor: MILESTONE_1, sepolia: { source: "payment", kind: "RELEASE_MILESTONE", milestoneIdx: 1, compare: "envelope" } },
  { id: "G1", title: "The regulator freezes the agent's account", ...ACCOUNT, governance: { args: ["agent", 1], output: 0 } },
  { id: "V1", title: "The regulator confirms on chain that the account is frozen", ...CONFIRM, governance: { args: ["agent"], output: 1, read: { label: "accountStatus", after: "1" } } },
  { id: "F1", title: "The agent spends 100 BU while frozen: refused by the chain", ...SPEND, expected: "refused", expectedError: "AccountFrozen", rule: "account-frozen" },
  { id: "G2", title: "The regulator unfreezes the agent's account", ...ACCOUNT, governance: { args: ["agent", 0], output: 0 } },
  { id: "V2", title: "The regulator confirms on chain that the account is normal again", ...CONFIRM, governance: { args: ["agent"], output: 0, read: { label: "accountStatus", after: "0" } } },
  { id: "C1", title: "The same spend, probed only: the chain would take it again", ...SPEND, expected: "ok", probeOnly: true },
  { id: "G3", title: "The regulator becomes Treasury's method-auth admin (committee proposal)", contract: "CommitteeManager", function: "createResetAdminProposal", ...REGULATOR, governance: { args: ["regulator", "Treasury", 1000], output: "proposal-id", read: { label: "treasuryAdmin", before: "deployer", after: "regulator" } } },
  { id: "G4", title: "The regulator sets Treasury.spend to blacklist mode", ...METHOD_AUTH, function: "setMethodAuthType", governance: { args: ["Treasury", "spend.selector", 2], output: 0, read: { label: "spendAllowed", before: "true", after: "true" } } },
  { id: "G5", title: "The regulator bans Treasury.spend for the agent", ...METHOD_AUTH, function: "closeMethodAuth", governance: { args: SPEND_FOR_AGENT, output: 0, read: { label: "spendAllowed", before: "true", after: "false" } } },
  { id: "M1", title: "The agent spends 100 BU while spend is banned: refused by the chain", ...SPEND, expected: "refused", expectedError: "PermissionDenied", rule: "method-banned" },
  { id: "C2", title: "The agent's other calls still pass: recordDenied, probed only", contract: "Treasury", function: "recordDenied", signerRole: "agent", auth: "none", expected: "ok", probeOnly: true, line: "PLATFORM_FEES" },
  { id: "G6", title: "The regulator lifts the ban on Treasury.spend", ...METHOD_AUTH, function: "openMethodAuth", governance: { args: SPEND_FOR_AGENT, output: 0, read: { label: "spendAllowed", before: "false", after: "true" } } },
  { id: "C3", title: "The same spend, probed only: allowed again", ...SPEND, expected: "ok", probeOnly: true },
  { id: "S16", title: "Pause the treasury (lender)", contract: "Treasury", function: "pause", signerRole: "lender", auth: "none", expected: "ok", sepolia: { source: "action", kind: "Treasury.pause", compare: "calldata" } },
  { id: "R17", title: "Spend 100 BU within caps while paused", contract: "Treasury", function: "spend", signerRole: "agent", auth: "none", expected: "refused", expectedError: "Paused", rule: "paused", amountMinor: "10000", line: "PLATFORM_FEES", payee: "shopee-sg-fees" },
  { id: "D17", title: "Record the R17 denial on-chain", contract: "Treasury", function: "recordDenied", signerRole: "agent", auth: "none", expected: "ok", line: "PLATFORM_FEES", recordsDenialOf: "R17" },
  { id: "S18a", title: "Confirm the milestone-0 settlement (as final-2)", contract: "Treasury", function: "confirmSettlement", signerRole: "oracle", auth: "none", expected: "ok", sepolia: { source: "action", kind: "Treasury.confirmSettlement", nth: 0, compare: "calldata" } },
  { id: "S18b", title: "Confirm the milestone-1 settlement (as final-2)", contract: "Treasury", function: "confirmSettlement", signerRole: "oracle", auth: "none", expected: "ok", sepolia: { source: "action", kind: "Treasury.confirmSettlement", nth: 1, compare: "calldata" } },
];

export const STEP_IDS: readonly string[] = CATALOGUE.map((e) => e.id);
/** The regulator's steps (G and V), in order. */
export const GOV_STEP_IDS: readonly string[] = CATALOGUE.filter((e) => e.governance).map((e) => e.id);

const BY_ID = new Map(CATALOGUE.map((e) => [e.id, e]));

/** The catalogue entry of a step id, or null when the id is not in the catalogue. */
export const catalogueEntry = (id: string): CatalogueEntry | null => BY_ID.get(id) ?? null;

/** The recordDenied reasonCode of a refusal: the error name as a right-padded ASCII bytes32 (§26.3, chain values.ts). */
export const reasonCodeOf = (error: HogeeError): string => tagToBytes32(error);

/** recordDenied's lineId for a D-step: the line key as bytes32, or bytes32(0) for no line. */
export const denialLineIdOf = (entry: CatalogueEntry): string => (entry.line ? tagToBytes32(entry.line) : `0x${"0".repeat(64)}`);

/**
 * The errors a refusal may legitimately show. foreign-domain: SignatureExpired when the block time (seconds) is past
 * the signed expiry, else InvalidSignature; when the step was not mined, the time is only bounded by the mined blocks
 * around it, so both are allowed while the expiry lies inside that interval. Every other rule has one error.
 */
export function expectedErrorsFor(entry: CatalogueEntry, time: { readonly from: bigint; readonly to: bigint } | null, signedExpiry: bigint | null): readonly HogeeError[] {
  // Chain refusals are derived from the G steps (refusals.ts), never from Hogee's errors.
  if (!entry.expectedError || isChainRefusal(entry.expectedError)) return [];
  if (entry.rule !== "foreign-domain" || signedExpiry === null || time === null) return [entry.expectedError];
  if (time.from > signedExpiry) return ["SignatureExpired"];
  if (time.to <= signedExpiry) return ["InvalidSignature"];
  return ["SignatureExpired", "InvalidSignature"];
}

/**
 * steps.json `final.reads` labels the checker requires (P1, after the last step) and the values final-2's plan implies:
 * all 10,000 BU released (stage 1 at the commit + stage 2), 2,000 BU of revenue recorded, the treasury paused; and the
 * regulator's powers lifted: the agent's account normal (0) and Treasury.spend allowed for it.
 */
export const FINAL_READS = { releasedMinor: "1000000", revenueTotalMinor: "200000", paused: "true", agentAccountStatus: "0", spendAllowedForAgent: "true" } as const;
