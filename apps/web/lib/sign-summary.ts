/**
 * The sign sheet's plain summary (UX-PLAN D16, guardrail G1): two or three sentences per signature kind, written in the
 * browser from exactly what signedRows() decodes: the typed data's message and the account and schedule typed-data.ts
 * verified against its hashes. It never reads the server's title, description or rows. When the browser's check
 * fails there is no summary of what would be signed, only a "Don't sign" sentence (the sheet shows it in red).
 */
import { LINE_KEYS, type TypedData, type WebOrderPreimage } from "@hogee/core";
import { zonedDate } from "../components/sign/seal-time";
import { bu, lineLabel } from "./format";
import { loosenChange, tagText } from "./signed-rows";
import type { DigestCheck } from "./typed-data";

export interface SignSummary {
  /** False when the browser's check failed: the sentences then only say not to sign. */
  readonly ok: boolean;
  readonly sentences: readonly string[];
}

export const DONT_SIGN_SUMMARY: SignSummary = {
  ok: false,
  sentences: ["Don't sign this. This browser found that what your passkey would sign doesn't match what's shown here. Close it and try again later."],
};

const ZERO32 = `0x${"0".repeat(64)}`;
type Schedule = WebOrderPreimage["schedule"];
type Message = TypedData["message"];

/** 500 bps → "5%", 250 → "2.5%". */
const pct = (bps: string): string => `${Number(bps) / 100}%`;

const sum = (schedule: Schedule): string => schedule.reduce((a, x) => a + x.amountMinor, 0n).toString();

/** "your Supplier pocket", or "pocket X" for a tag that is no known pocket. */
function pocketName(hex: string): string {
  const t = tagText(hex);
  return (LINE_KEYS as readonly string[]).includes(t) ? `your ${lineLabel(t)} pocket` : `pocket ${t}`;
}

function planSummary(m: Message, currency: string | undefined): string[] {
  const s = (k: string) => String(m[k] ?? "");
  const replaces = s("prevPlanHash") !== ZERO32 && s("prevPlanHash") !== "";
  return [
    replaces ? `Version ${s("version")} of your plan, with a budget of ${bu(s("totalMinor"))}. It replaces your current plan.` : `Your plan has a budget of ${bu(s("totalMinor"))}.`,
    `${pct(s("reserveBps"))} of each sale is kept for tax.`,
    `Hogee's AI can pay only from your pockets, up to their limits, until ${zonedDate(Number(s("agentExpiry")), currency)}.`,
  ];
}

/** What waits for Mei: her passkey, plus the delivery check when the order asks for one (inspectionRequired, signed). */
const heldCondition = (inspection: boolean): string => (inspection ? "your delivery check and your passkey" : "your passkey");

/**
 * The order's payments in words. `afterWait` is true for a web supplier (its first payment waits out the safety wait);
 * a catalog supplier's automatic payment is described without a timing claim, as its signed row is.
 */
function scheduleSentences(payee: string, schedule: Schedule, inspection: boolean, afterWait: boolean): string[] {
  const autos = schedule.filter((x) => x.autoRelease);
  const held = schedule.filter((x) => !x.autoRelease);
  const when = afterWait ? " after the safety wait" : "";
  const sentences: string[] = [];
  if (autos.length === 0) sentences.push(`Nothing is paid to ${payee} automatically.`);
  else if (autos.length === 1 && schedule[0]?.autoRelease) sentences.push(`Your wallet may pay ${payee} the ${bu(sum(autos))} deposit automatically${when}.`);
  else sentences.push(`Your wallet may pay ${payee} ${bu(sum(autos))} automatically${when}, in ${autos.length} ${autos.length === 1 ? "payment" : "payments"}.`);
  if (held.length === 1) sentences.push(`The ${bu(sum(held))} ${autos.length > 0 ? "balance" : "payment"} waits for ${heldCondition(inspection)}.`);
  else if (held.length > 1) sentences.push(`The other ${held.length} payments (${bu(sum(held))} in all) each wait for ${heldCondition(inspection)}.`);
  return sentences;
}

function supplierSummary(m: Message, check: DigestCheck): string[] {
  const inspection = m.inspectionRequired === true;
  if (check.webOrder) return scheduleSentences(check.webOrder.holderName, check.webOrder.schedule, inspection, true);
  if (check.schedule) return [`You're approving an order of ${bu(String(m.totalMinor ?? ""))} from this supplier.`, ...scheduleSentences("this supplier", check.schedule, inspection, false)];
  return [`You're approving an order of ${bu(String(m.totalMinor ?? ""))}, paid from ${pocketName(String(m.lineId ?? ""))}. Every payment is under Show details.`];
}

function releaseSummary(m: Message): string[] {
  const s = (k: string) => String(m[k] ?? "");
  return [`You're paying ${bu(s("amountMinor"))} to the supplier: payment ${Number(s("idx")) + 1} of order ${tagText(s("orderId"))}.`, "Your delivery check report goes with it, as a check code."];
}

/** undefined for a change kind the UI can't describe (the check refuses those, so this never shows). */
function loosenSummary(m: Message, currency: string | undefined): string[] | undefined {
  const change = loosenChange(m, currency);
  if (!change) return undefined;
  return [
    `You're asking for this change: ${change.charAt(0).toLowerCase()}${change.slice(1)}.`,
    "It makes a rule less strict, so your loan officer must agree too. Then it waits a set time, and either of you can cancel it during the wait.",
  ];
}

/**
 * The plain summary of a checked request. `currency` picks the time zone of dates (SGD → SGT); `check` must be the
 * result of checkSignatureRequest for this same typed data.
 */
export function signSummary(td: TypedData, check: DigestCheck, currency?: string): SignSummary {
  if (!check.ok) return DONT_SIGN_SUMMARY;
  const m = td.message;
  const s = (k: string) => String(m[k] ?? "");
  switch (td.primaryType) {
    case "PlanApproval":
      return { ok: true, sentences: planSummary(m, currency) };
    case "SupplierApproval":
      return { ok: true, sentences: supplierSummary(m, check) };
    case "MilestoneRelease":
      return { ok: true, sentences: releaseSummary(m) };
    case "LoosenRequest": {
      const sentences = loosenSummary(m, currency);
      return sentences ? { ok: true, sentences } : DONT_SIGN_SUMMARY;
    }
    case "StageRelease":
      return { ok: true, sentences: [`You're approving ${bu(s("amountMinor"))} for budget part ${tagText(s("stageId"))}.`] };
    case "OwnerSpend":
      return { ok: true, sentences: [`You're paying ${bu(s("amountMinor"))} to ${tagText(s("payeeId"))} yourself, from ${pocketName(s("lineId"))}.`, "Its invoice goes with it, as a check code."] };
    default:
      return DONT_SIGN_SUMMARY;
  }
}

/** What the sheet's sign button may do now (the dialog renders exactly this). */
export interface SignGate {
  /** Pressing it signs: a request is loaded, the browser's check passed, nothing is signed or in flight yet. */
  readonly canSign: boolean;
  /** Greyed out: anything but a passing check, except while the passkey prompt it opened is up (it keeps its ink then). */
  readonly disabled: boolean;
}

/** G1: a failed or missing check always disables the button; no other input can enable it. */
export function signGate(i: { readonly hasRequest: boolean; readonly checkOk: boolean | undefined; readonly signed: boolean; readonly busy: "register" | "sign" | undefined }): SignGate {
  const canSign = i.hasRequest && i.checkOk === true && !i.signed && i.busy === undefined;
  return { canSign, disabled: !canSign && !(i.busy === "sign" && i.checkOk === true) };
}
