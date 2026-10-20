/**
 * What the Proof page says about a FISCO BCOS mirror pack (REG-BRIEF fisco-proof), as pure functions. The rule is the
 * proof pack's (proof-model.ts): never fake a pass. "N of N checks passed in this browser" shows only when every check
 * this browser ran passed; anything else is a red "Not verified" with its count. The pack's own claims (its steps,
 * blocks, nodes) are read leniently so a failing pack can still be shown, always under that red verdict; a step's
 * title and who sent it come from Hogee's own catalogue and labels, never from text in the pack, and the chain's own
 * words only when they are FISCO's known text for that status. An Etherscan link exists only for an anchor this
 * browser's check accepted on a pack that passed, rebuilt from the pinned explorer (lib/explorer.ts).
 */
import { z } from "zod";
import type { BundleFiles } from "@hogee/verify-evidence";
import { catalogueEntry } from "@hogee/verify-evidence/fisco";
import { txUrl } from "../../lib/explorer";

// ---- the verdict ------------------------------------------------------------------------------------------------

export type FiscoState = "checking" | "verified" | "failed" | "unreadable";
export type FiscoTone = "checking" | "verified" | "failed";

export interface FiscoCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface FiscoVerdict {
  readonly tone: FiscoTone;
  readonly title: string;
  readonly line: string | null;
  /** "x of y checks passed": a real failure's count (a pass says it in its title). */
  readonly count: string | null;
}

const passedOf = (checks: readonly FiscoCheck[]): number => checks.filter((c) => c.ok).length;

/** A check the verifier skipped because an earlier one failed ("not run: …"): failed, but it compared nothing. */
export const isNotRun = (check: FiscoCheck): boolean => !check.ok && (check.detail ?? "").startsWith("not run");

/** The section's headline. A pass needs at least one check and every check passed, whatever `state` claims. */
export function fiscoVerdict(state: FiscoState, checks: readonly FiscoCheck[] | null): FiscoVerdict {
  if (state === "checking") return { tone: "checking", title: "Checking the mirror in your browser", line: null, count: null };
  if (state === "unreadable" || !checks) {
    return { tone: "failed", title: "Not verified", line: "The mirror pack could not be read, so nothing in it is proven.", count: null };
  }
  const passed = passedOf(checks);
  if (state === "verified" && checks.length > 0 && passed === checks.length) {
    return { tone: "verified", title: `${checks.length} of ${checks.length} checks passed in this browser`, line: null, count: null };
  }
  return {
    tone: "failed",
    title: "Not verified",
    line: "At least one check failed, so this mirror proves nothing yet.",
    count: `${passed} of ${checks.length} checks passed`,
  };
}

/**
 * A check's detail as the page may show it: control, line-separator, bidi and invisible characters (soft hyphen,
 * Arabic letter mark, zero-width, word joiner and invisible operators, BOM; pack-controlled text can reach a detail)
 * become "?", as `make verify-fisco` escapes them, so a pack can't hide or reorder what a line says.
 */
export const safeDetail = (detail: string, max = 300): string =>
  detail.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "?").slice(0, max);

/** The pack folder the API served must be the packId pack.json commits to (`make verify-fisco`'s folder check). */
export function folderCheck(listedPackId: string, packId: string | null): FiscoCheck {
  const name = "pack folder";
  if (packId === null) return { name, ok: false, detail: "no packId to compare (pack.json did not load)" };
  return packId === listedPackId ? { name, ok: true, detail: `named after its packId ${packId}` } : { name, ok: false, detail: `served as ${listedPackId}, but its packId is ${packId}` };
}

// ---- the pack's own claims, read leniently ----------------------------------------------------------------------

const HASH = /^0x[0-9a-fA-F]{64}$/;
const STEP_ID = /^[A-Z][0-9]{1,2}[a-z]?$/;
const Int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const StepLite = z.looseObject({
  seq: Int,
  id: z.string().regex(STEP_ID),
  signerRole: z.string().max(20),
  expected: z.enum(["ok", "refused"]),
  outcome: z.looseObject({ kind: z.string().max(20), txHash: z.string().regex(HASH).optional() }),
  call: z.looseObject({ block: Int }).optional(),
});
const StepsLite = z.looseObject({ steps: z.array(StepLite).max(64) });
const TxLite = z.looseObject({
  receipt: z.looseObject({ blockNumber: z.string().regex(/^0x[0-9a-fA-F]{1,13}$/) }).nullable().optional(),
  native: z.looseObject({ status: z.number().int().min(0).max(255), output: z.string().max(4096), blockNumber: Int }).nullable().optional(),
  tx: z.looseObject({ input: z.string().max(65_536).optional() }).nullable().optional(),
});
const ChainLite = z.looseObject({ nodeCount: Int, sealerCount: Int, observerCount: Int });
const PackLite = z.looseObject({ packId: z.string().max(40), sourceBundle: z.looseObject({ runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) }) });
const CreatedLite = z.looseObject({ createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/) });

/** A file's JSON when it is strict UTF-8 JSON, else undefined (the verifier says why). */
function jsonOf(files: BundleFiles, path: string): unknown {
  const raw = files[path];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return undefined;
  }
}

/** pack.json's packId and the run id of the Sepolia bundle it mirrors (null when unreadable). */
export function packIdentityOf(files: BundleFiles): { readonly packId: string; readonly sourceRunId: string } | null {
  const p = PackLite.safeParse(jsonOf(files, "pack.json"));
  return p.success ? { packId: p.data.packId, sourceRunId: p.data.sourceBundle.runId } : null;
}

/**
 * When the pack was replayed (pack.json createdAt), only from a pack this browser verified: the API's listing, or an
 * unverified pack.json, vouches for nothing.
 */
export function verifiedCreatedAt(files: BundleFiles, proven: boolean): string | null {
  if (!proven) return null;
  const p = CreatedLite.safeParse(jsonOf(files, "pack.json"));
  return p.success ? p.data.createdAt : null;
}

export type StepOutcome = "done" | "probe" | "frozen" | "banned" | "contract" | "not-mined";

export interface StepView {
  readonly seq: number;
  readonly id: string;
  /** From Hogee's catalogue, never the pack's own text. */
  readonly title: string;
  readonly who: string;
  readonly outcome: StepOutcome;
  readonly block: number | null;
  /** The FISCO native status (0 ok, 16 contract refusal, 18 method banned, 22 account frozen). */
  readonly status: number | null;
  /** The chain's own refusal text (Error(string) in the native output), printable ASCII only. */
  readonly says: string | null;
  /** The call data as served (lowercase), to compare the three stops. */
  readonly input: string | null;
}

/** Who sent a step, in plain words (the pack's ROLES). */
const WHO: Readonly<Record<string, string>> = {
  regulator: "The regulator",
  agent: "The AI agent",
  lender: "The loan officer",
  relayer: "Hogee's relayer (for the founder)",
  oracle: "The sales feed",
  deployer: "The deployer",
  observer: "The observer key",
};

/** The text of an Error(string) revert (selector 0x08c379a0), when it is short printable ASCII; else null. */
export function errorStringOf(output: string): string | null {
  const hex = output.toLowerCase();
  if (!/^0x08c379a0([0-9a-f]{2})*$/.test(hex) || hex.length < 10 + 128) return null;
  const body = hex.slice(10);
  const offset = Number.parseInt(body.slice(0, 64), 16);
  if (offset !== 32) return null;
  const length = Number.parseInt(body.slice(64, 128), 16);
  if (!Number.isSafeInteger(length) || length < 1 || length > 120 || body.length < 128 + length * 2) return null;
  let text = "";
  for (let i = 0; i < length; i += 1) {
    const code = Number.parseInt(body.slice(128 + i * 2, 130 + i * 2), 16);
    if (code < 0x20 || code > 0x7e) return null;
    text += String.fromCharCode(code);
  }
  return text;
}

function outcomeOf(kind: string, status: number | null): StepOutcome {
  if (kind === "probe-only") return "probe";
  if (kind === "rpc-refused") return "not-mined";
  if (status === 22) return "frozen";
  if (status === 18) return "banned";
  if (kind === "mined-reverted" || (status !== null && status !== 0)) return "contract";
  return "done";
}

/** Every step the pack records, in order, with its block and the chain's answer. */
export function stepViews(files: BundleFiles): StepView[] {
  const steps = StepsLite.safeParse(jsonOf(files, "steps.json"));
  if (!steps.success) return [];
  return [...steps.data.steps]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const hash = s.outcome.txHash?.toLowerCase();
      const tx = hash ? TxLite.safeParse(jsonOf(files, `txs/${hash}.json`)) : null;
      const t = tx?.success ? tx.data : null;
      const status = t?.native?.status ?? null;
      const web3Block = t?.receipt ? Number.parseInt(t.receipt.blockNumber, 16) : null;
      return {
        seq: s.seq,
        id: s.id,
        title: catalogueEntry(s.id)?.title ?? `Step ${s.id}`,
        who: WHO[s.signerRole] ?? "Someone else",
        outcome: outcomeOf(s.outcome.kind, status),
        block: s.call?.block ?? web3Block ?? t?.native?.blockNumber ?? null,
        status,
        says: t?.native ? errorStringOf(t.native.output) : null,
        input: typeof t?.tx?.input === "string" ? t.tx.input.toLowerCase() : null,
      };
    });
}

// ---- the three stops --------------------------------------------------------------------------------------------

export type StopKey = "frozen" | "banned" | "paused";

export interface StopDef {
  readonly key: StopKey;
  readonly stepId: "F1" | "M1" | "R17";
  readonly title: string;
  /** What refused it. */
  readonly by: "chain" | "contract";
  readonly note: string;
}

/** The same 100 BU spend, stopped three ways (catalogue F1, M1, R17; REG-FACTS: account freeze, method ban, pause). */
export const THREE_STOPS: readonly StopDef[] = [
  { key: "frozen", stepId: "F1", title: "The regulator froze the agent's account", by: "chain", note: "FISCO BCOS refused it before Hogee's contract ran." },
  { key: "banned", stepId: "M1", title: "The regulator banned spend() for the agent", by: "chain", note: "Only that one method: the agent's other calls were still allowed." },
  { key: "paused", stepId: "R17", title: "The loan officer paused the wallet", by: "contract", note: "The chain took the call, and Hogee's contract refused it." },
];

export const STOPPED_BY: Readonly<Record<StopDef["by"], string>> = { chain: "Refused by the chain", contract: "Refused by Hogee's contract" };

/** The refusal each stop must show: the chain's own status for a chain stop, a contract revert for the pause. */
const STOP_OUTCOME: Readonly<Record<StopKey, StepOutcome>> = { frozen: "frozen", banned: "banned", paused: "contract" };

export interface StopView extends StopDef {
  /** The pack records this step, refused the way the stop says. */
  readonly present: boolean;
  readonly block: number | null;
  readonly status: number | null;
  /** FISCO's known words for the status (F1, M1), else the error name from Hogee's catalogue (R17, or other words). */
  readonly reason: string | null;
}

/**
 * FISCO BCOS's own refusal text by native status (REG-FACTS: 22 account frozen, 18 method banned). A stop card repeats
 * the chain's words only when they are exactly these; anything else, the pack's own text included, is never shown.
 */
const CHAIN_WORDS: ReadonlyMap<number, string> = new Map([
  [22, "Account's status is abnormal"],
  [18, "Call permission denied"],
]);

const chainWordsOf = (step: StepView): string | null => (step.status !== null && step.says !== null && CHAIN_WORDS.get(step.status) === step.says ? step.says : null);

/** The spend all three stops refused, from Hogee's catalogue (R17's entry, which F1 and M1 copy byte for byte). */
export function stoppedSpend(): { readonly amountMinor: string; readonly line: string } | null {
  const r17 = catalogueEntry("R17");
  return r17?.amountMinor && r17.line ? { amountMinor: r17.amountMinor, line: r17.line } : null;
}

export function threeStops(steps: readonly StepView[]): { readonly stops: readonly StopView[]; readonly sameCall: boolean } {
  const stops = THREE_STOPS.map((def) => {
    const step = steps.find((s) => s.id === def.stepId);
    const present = step !== undefined && step.outcome === STOP_OUTCOME[def.key];
    const reason = (step ? chainWordsOf(step) : null) ?? catalogueEntry(def.stepId)?.expectedError ?? null;
    return { ...def, present, block: step?.block ?? null, status: step?.status ?? null, reason: present ? reason : null };
  });
  const inputs = THREE_STOPS.map((d) => steps.find((s) => s.id === d.stepId)?.input ?? null);
  const first = inputs[0];
  return { stops, sameCall: typeof first === "string" && first.length > 10 && inputs.every((i) => i === first) };
}

// ---- the nodes --------------------------------------------------------------------------------------------------

export type LedgerState = "matches" | "differs" | "unchecked";

export interface NodesView {
  readonly validators: number;
  readonly observers: number;
  /** "regulator ledger" (the verifier's, never this file's): unchecked when there is no such check or it was not run. */
  readonly ledger: LedgerState;
}

export const LEDGER_CHECK = "regulator ledger";

export function nodesOf(files: BundleFiles, checks: readonly FiscoCheck[] | null): NodesView | null {
  const chain = ChainLite.safeParse(jsonOf(files, "chain.json"));
  if (!chain.success) return null;
  const check = checks?.find((c) => c.name === LEDGER_CHECK);
  return { validators: chain.data.sealerCount, observers: chain.data.observerCount, ledger: !check || isNotRun(check) ? "unchecked" : check.ok ? "matches" : "differs" };
}

// ---- the Sepolia timestamp --------------------------------------------------------------------------------------

/** What the anchor adapter (fisco-anchor-check.ts) reports. */
export interface AnchorCheck {
  /** False when this build's verifier has no anchor check. */
  readonly available: boolean;
  readonly ok: boolean;
  readonly anchored: boolean;
  readonly anchor: { readonly txHash: string; readonly blockNumber: number; readonly timestamp: number } | null;
  readonly detail: string;
}

/**
 * "anchored": the pack passed and so did its anchor (publicly timestamped); "unproven": the anchor checks but the pack
 * doesn't, so it is not counted; "none": no sidecar (not timestamped yet: neutral, never a check line).
 */
export type AnchorState = "checking" | "anchored" | "unproven" | "none" | "unavailable" | "failed";

export interface AnchorView {
  readonly state: AnchorState;
  readonly blockNumber: number | null;
  readonly utc: string | null;
  /** The pinned Sepolia Etherscan page of the anchor tx: only for an accepted anchor of a pack that passed. */
  readonly href: string | null;
  readonly detail: string | null;
}

const SEPOLIA = 11_155_111;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const two = (n: number): string => String(n).padStart(2, "0");

/** "20 Oct 2026, 07:41 UTC" from unix seconds; null for a time that is not one. */
export function utcLabel(seconds: number): string | null {
  const d = new Date(seconds * 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

const NONE: Omit<AnchorView, "state"> = { blockNumber: null, utc: null, href: null, detail: null };

/**
 * The timestamp card. `listedAnchored` is the API's word that a sidecar exists (it vouches for nothing else); `proven`
 * is the section's verdict: a block, a time and a link only when the pack passed and its anchor did too.
 */
export function anchorView(check: AnchorCheck | undefined, listedAnchored: boolean, proven: boolean): AnchorView {
  if (!check) return { state: "checking", ...NONE };
  if (!check.available) return { state: listedAnchored ? "unavailable" : "none", ...NONE };
  if (check.ok && check.anchored && check.anchor) {
    if (!proven) return { state: "unproven", ...NONE };
    const { txHash, blockNumber, timestamp } = check.anchor;
    return { state: "anchored", blockNumber, utc: utcLabel(timestamp), href: txUrl(SEPOLIA, txHash), detail: null };
  }
  if (check.ok && !check.anchored) return { state: "none", ...NONE };
  return { state: "failed", ...NONE, detail: safeDetail(check.detail, 200) };
}

/** What a passing verdict means. The Sepolia timestamp is named as its public part only once that check passed. */
export function meaningOf(timestamped: boolean): string {
  const local = "The same contracts, signed plan and calls ran on a FISCO BCOS chain with these outcomes. That chain runs on the recording computer, so its blocks are taken as it served them";
  return timestamped ? `${local}; the Sepolia timestamp is the public part.` : `${local}.`;
}
