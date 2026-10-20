/**
 * The rows of a web SupplierApproval that the signing panel re-verifies (run-9 hardening; VISION-DECISIONS §9). The live
 * API (signing/web-order.ts) and the mock (features/orders.ts) build them with these functions; the browser
 * (apps/web lib/typed-data.ts) reads them back with readWebOrderRows, recomputes payoutAccountHash and scheduleHash from
 * them and shows them as signed rows only when both match the message. One field per row, so a free-text holder or bank
 * name never shares a value with the account digits. The bank name is shown but not signed (MOCK_ONLY routing ignores it).
 * A catalog SupplierApproval's milestone rows (catalogMilestoneRows / readCatalogScheduleRows) are re-verified the same
 * way against scheduleHash and totalMinor; its account stays a fingerprint.
 */
import { formatBu } from "../money/index";
import { MILESTONE_LABELS, type MilestoneTrigger } from "./constants";

export interface WebOrderRow {
  readonly label: string;
  readonly value: string;
  readonly effect: "neutral" | "tighten" | "loosen";
}

/** The fixed payout channel of every web supplier ("simulated payout"): part of the payoutAccountHash preimage. */
export const WEB_PAYOUT_CHANNEL = "MOCK_ONLY";

export const WEB_ORDER_ROW_LABELS = Object.freeze({
  holder: "Account holder",
  account: "Account number (simulated payout)",
  bank: "Bank",
});

const AUTO_TEXT = "paid by the agent by itself after the cooling period";
const HELD_TEXT = "paid only when you release it with inspection evidence";
const WEB_TEXT: MilestoneText = { auto: AUTO_TEXT, held: HELD_TEXT };

/** Who pays a milestone, as its row says it after the amount ("<amount> BU, <text>"). */
interface MilestoneText {
  readonly auto: string;
  readonly held: string;
}

/**
 * A catalog SupplierApproval's milestone wording and names: the live API's catalogRows (api signing/supplier-approval.ts)
 * writes exactly these; the mock builds them with catalogMilestoneRows. The browser reads them back with
 * readCatalogScheduleRows and checks them against the signed scheduleHash and totalMinor (re-check review LOW 2).
 */
export const CATALOG_MILESTONE_TEXT: MilestoneText = Object.freeze({ auto: "paid by the agent when funded", held: "released only with your signature and inspection evidence" });
export const CATALOG_MILESTONE_NAMES = Object.freeze(["Sample", "Deposit", "Balance", "Holdback"] as const);
const MILESTONE_LABEL_RE = /^Milestone (\d{1,2}): /;
const BU_TEXT_RE = /^(\d{1,3}(?:,\d{3})*)(?:\.(\d{2}))? BU$/;
const MAX_MILESTONES = 8;

/** "100200300400" → "1002 0030 0400": the whole number, so a swapped account with the same last digits looks different. */
export const groupDigits = (digits: string): string => digits.replace(/(\d{4})(?=\d)/g, "$1 ");

/** Holder, whole account number and bank, each in its own row. */
export function webPayoutRows(p: { readonly holderName: string; readonly accountNumber: string; readonly bankName: string }): WebOrderRow[] {
  return [
    { label: WEB_ORDER_ROW_LABELS.holder, value: p.holderName, effect: "loosen" },
    { label: WEB_ORDER_ROW_LABELS.account, value: groupDigits(p.accountNumber), effect: "loosen" },
    { label: WEB_ORDER_ROW_LABELS.bank, value: p.bankName, effect: "neutral" },
  ];
}

const milestoneValue = (amountMinor: bigint, autoRelease: boolean, text: MilestoneText = WEB_TEXT): string =>
  `${formatBu(amountMinor)}, ${autoRelease ? text.auto : text.held}`;

/** One row per milestone, in schedule order: its amount and who pays it. */
export function webMilestoneRows(schedule: readonly { readonly trigger?: MilestoneTrigger; readonly amountMinor: bigint | string; readonly autoRelease: boolean }[]): WebOrderRow[] {
  return schedule.map((m, i) => ({
    label: `Milestone ${i + 1}: ${m.trigger ? MILESTONE_LABELS[m.trigger] : "Payment"}`,
    value: milestoneValue(BigInt(m.amountMinor), m.autoRelease),
    effect: m.autoRelease ? "loosen" : "neutral",
  }));
}

/** A catalog order's milestones, one row each in schedule order: "Milestone N: <name>", its amount and who pays it. */
export function catalogMilestoneRows(schedule: readonly { readonly amountMinor: bigint | string; readonly autoRelease: boolean }[]): WebOrderRow[] {
  return schedule.map((m, i) => ({
    label: `Milestone ${i + 1}: ${CATALOG_MILESTONE_NAMES[i] ?? "Payment"}`,
    value: milestoneValue(BigInt(m.amountMinor), m.autoRelease, CATALOG_MILESTONE_TEXT),
    effect: m.autoRelease ? "loosen" : "neutral",
  }));
}

export interface WebOrderPreimage {
  readonly holderName: string;
  readonly accountNumber: string;
  readonly schedule: readonly { readonly amountMinor: bigint; readonly autoRelease: boolean }[];
}

/** "1,750.50 BU" → 175050n, only for formatBu's exact output. */
function buTextToMinor(text: string): bigint | undefined {
  const m = BU_TEXT_RE.exec(text);
  if (!m) return undefined;
  const minor = BigInt((m[1] as string).replace(/,/g, "")) * 100n + BigInt(m[2] ?? "0");
  return formatBu(minor) === text ? minor : undefined;
}

/** The value of the one row with this label, or undefined when there is none or more than one. */
function only(rows: readonly { label: string; value: string }[], label: string): string | undefined {
  const found = rows.filter((r) => r.label === label);
  return found.length === 1 ? found[0]?.value : undefined;
}

function milestonesOf(rows: readonly { label: string; value: string }[], text: MilestoneText): WebOrderPreimage["schedule"] | undefined {
  const ms = rows.filter((r) => MILESTONE_LABEL_RE.test(r.label));
  if (ms.length < 1 || ms.length > MAX_MILESTONES) return undefined;
  const out: { amountMinor: bigint; autoRelease: boolean }[] = [];
  for (const [i, r] of ms.entries()) {
    if (Number(MILESTONE_LABEL_RE.exec(r.label)?.[1]) !== i + 1) return undefined;
    const cut = r.value.indexOf(", ");
    const amountMinor = cut > 0 ? buTextToMinor(r.value.slice(0, cut)) : undefined;
    if (amountMinor === undefined) return undefined;
    const autoRelease = r.value === milestoneValue(amountMinor, true, text);
    if (!autoRelease && r.value !== milestoneValue(amountMinor, false, text)) return undefined;
    out.push({ amountMinor, autoRelease });
  }
  return out;
}

/** The account and schedule the rows show, or undefined unless every row is present once and in its exact built form. */
export function readWebOrderRows(rows: readonly { label: string; value: string }[]): WebOrderPreimage | undefined {
  const holderName = only(rows, WEB_ORDER_ROW_LABELS.holder);
  const grouped = only(rows, WEB_ORDER_ROW_LABELS.account);
  if (!holderName || !grouped) return undefined;
  const accountNumber = grouped.replace(/ /g, "");
  if (!/^\d{1,34}$/.test(accountNumber) || groupDigits(accountNumber) !== grouped) return undefined;
  const schedule = milestonesOf(rows, WEB_TEXT);
  return schedule ? { holderName, accountNumber, schedule } : undefined;
}

/** A catalog order's schedule as its milestone rows show it, or undefined unless every one is in its exact built form. */
export function readCatalogScheduleRows(rows: readonly { label: string; value: string }[]): WebOrderPreimage["schedule"] | undefined {
  return milestonesOf(rows, CATALOG_MILESTONE_TEXT);
}
