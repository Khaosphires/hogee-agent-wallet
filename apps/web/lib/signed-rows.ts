/**
 * "What you read is what you sign" (project.md §13.1 principle 5, T27): every row of the signing panel is decoded in
 * the browser from the EIP-712 message fields themselves, never from text the server wrote. The server's own
 * description is shown separately and marked as not signed.
 */
import { LINE_KEYS, groupDigits, type DisplayEffect, type TypedData, type WebOrderPreimage } from "@hogee/core";
import { LOOSEN_KINDS } from "@hogee/api-mock/eip712";
import { zonedDate, zonedDateTime } from "../components/sign/seal-time";
import { bu, lineLabel } from "./format";
import { LOOSEN_FIELD_USE, loosenKindOf, type LoosenFieldUse, type LoosenKindName } from "./loosen-fields";

export interface SignedRow {
  readonly label: string;
  readonly value: string;
  readonly effect: DisplayEffect;
  /** A hash or address: shown in full, in monospace. */
  readonly mono?: boolean;
  /** The message fields this row shows (signed-rows.test.ts checks every struct field is shown by some row). */
  readonly fields: readonly string[];
  /** A short form shown above "Show details" (who is paid, the account's last digits); the row itself stays in the details. */
  readonly brief?: { readonly label: string; readonly value: string };
}

const ZERO32 = `0x${"0".repeat(64)}`;

/** A right-padded UTF-8 bytes32 tag (lineId, payee, orderId) as text, or the hex when it isn't printable text. */
export function tagText(hex: string): string {
  if (!/^0x[0-9a-f]{64}$/i.test(hex)) return hex;
  const bytes = (hex.slice(2).match(/../g) ?? []).map((b) => Number.parseInt(b, 16));
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  if (end === 0 || bytes.slice(0, end).includes(0)) return hex;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes.slice(0, end)));
    return /^[\x20-\x7e]+$/.test(text) ? text : hex;
  } catch {
    return hex;
  }
}

const pocket = (hex: string): string => {
  const t = tagText(hex);
  return (LINE_KEYS as readonly string[]).includes(t) ? `${lineLabel(t)} pocket` : `pocket ${t}`;
};

const KIND_NAME = Object.fromEntries(Object.entries(LOOSEN_KINDS).map(([name, n]) => [String(n), name])) as Record<string, keyof typeof LOOSEN_KINDS>;

/** The one change a LoosenRequest makes, or undefined for a kind the UI can't describe (the dialog refuses it). */
export function loosenChange(m: Record<string, string | boolean>, currency?: string): string | undefined {
  const s = (k: string) => String(m[k] ?? "");
  const date = (k: string) => zonedDate(Number(s(k)), currency);
  switch (KIND_NAME[s("kind")]) {
    case "LOOSEN_RAISE_PER_TX_CAP":
      return `Raise the most-per-payment limit of the ${pocket(s("target"))} to ${bu(s("newValue"))}`;
    case "LOOSEN_RAISE_WINDOW_CAP":
      return `Raise the weekly limit of the ${pocket(s("target"))} to ${bu(s("newValue"))}`;
    case "LOOSEN_ADD_PAYEE":
      return `Let Hogee's AI pay ${tagText(s("target"))} from the ${pocket(s("aux"))}`;
    case "LOOSEN_EXTEND_AGENT_EXPIRY":
      return `Let Hogee's AI keep paying until ${date("newValue")}`;
    case "LOOSEN_EXTEND_LINE_EXPIRY":
      return `Keep the ${pocket(s("target"))} open until ${date("newValue")}`;
    case "LOOSEN_MOVE_POCKETS":
      return `Move ${bu(s("newValue"))} from the ${pocket(s("target"))} to the ${pocket(s("aux"))}`;
    case "LOOSEN_UNPAUSE":
      return s("target") === ZERO32 ? "Restart all payments" : `Restart payments from the ${pocket(s("target"))}`;
    case "LOOSEN_WITHDRAW_RESERVE":
      return `Take ${bu(s("newValue"))} out of the tax money and pay it to ${tagText(s("target"))}`;
    default:
      return undefined;
  }
}

/** The row label for each field a change kind uses (the "Change" sentence says the same in words). */
const LOOSEN_ROW_LABEL: { readonly [K in LoosenKindName]: { readonly target?: string; readonly aux?: string; readonly newValue?: string } } = {
  LOOSEN_RAISE_PER_TX_CAP: { target: "Pocket", newValue: "New most per payment" },
  LOOSEN_RAISE_WINDOW_CAP: { target: "Pocket", newValue: "New weekly limit" },
  LOOSEN_ADD_PAYEE: { target: "Who can be paid", aux: "Paid from", newValue: "Bank account (check code)" },
  LOOSEN_EXTEND_AGENT_EXPIRY: { newValue: "The AI can pay until" },
  LOOSEN_EXTEND_LINE_EXPIRY: { target: "Pocket", newValue: "Open until" },
  LOOSEN_MOVE_POCKETS: { target: "Moved from", aux: "Moved to", newValue: "Amount" },
  LOOSEN_UNPAUSE: { target: "Restarts" },
  LOOSEN_WITHDRAW_RESERVE: { target: "Paid to", newValue: "Amount" },
};

/** One field's value, read the way the contract reads it for this kind (loosen-fields.ts). */
function loosenValue(use: LoosenFieldUse, raw: string, currency: string | undefined): { value: string; mono?: boolean } {
  switch (use) {
    case "pocket":
      return { value: `your ${pocket(raw)}` };
    case "pocketOrAll":
      return { value: raw === ZERO32 ? "Every payment, from every pocket" : `Payments from your ${pocket(raw)}` };
    case "payee":
      return { value: tagText(raw), mono: tagText(raw).startsWith("0x") };
    case "amount":
      return { value: bu(raw) };
    case "date":
      return { value: zonedDateTime(Number(raw), currency) ?? raw };
    case "accountCode":
      return { value: `0x${BigInt(raw).toString(16).padStart(64, "0")}`, mono: true };
    case "zero":
      return { value: raw };
  }
}

/** A row per field the change kind uses; the unused ones are checked to be zero instead (typed-data.ts). */
function loosenFieldRows(m: Record<string, string | boolean>, currency: string | undefined): SignedRow[] {
  const kind = loosenKindOf(m);
  if (!kind) return [];
  const use = LOOSEN_FIELD_USE[kind];
  return (["target", "aux", "newValue"] as const).flatMap((field) => {
    const label = LOOSEN_ROW_LABEL[kind][field];
    if (use[field] === "zero" || !label) return [];
    const { value, mono } = loosenValue(use[field], String(m[field] ?? ""), currency);
    return [{ label, value, effect: "neutral" as const, mono, fields: [field] }];
  });
}

/**
 * A payment's name in an order of `count` (UX-PLAN D18, 1-based everywhere): "Deposit (payment 1 of 2)", "Balance
 * (payment 2 of 2)"; three-part deals add "Second payment"; a one-part order is the "Full payment". A first payment that
 * isn't automatic is the "First payment", not a deposit (the order card's milestoneName says the same).
 */
export function paymentName(i: number, count: number, firstIsAutomatic = true): string {
  if (count === 1) return "Full payment";
  const first = firstIsAutomatic ? "Deposit" : "First payment";
  const name = i === 0 ? first : i === count - 1 ? "Balance" : i === 1 ? "Second payment" : `Payment ${i + 1}`;
  return `${name} (payment ${i + 1} of ${count})`;
}

const WEB_PAYS = { auto: "paid automatically after the safety wait", held: "paid only when you approve it, after a delivery check" } as const;
const CATALOG_PAYS = { auto: "paid automatically once the money is set aside", held: "paid only after a delivery check and your signature" } as const;

/** Payments as typed-data.ts verified them against scheduleHash and totalMinor (never the server's text). */
function milestoneRows(schedule: WebOrderPreimage["schedule"], pays: { readonly auto: string; readonly held: string }): SignedRow[] {
  return schedule.map<SignedRow>((x, i) => ({
    label: paymentName(i, schedule.length, schedule[0]?.autoRelease ?? true),
    value: `${bu(x.amountMinor.toString())}, ${x.autoRelease ? pays.auto : pays.held}`,
    effect: x.autoRelease ? "loosen" : "neutral",
    fields: ["scheduleHash", "totalMinor"],
  }));
}

/**
 * A web supplier's payout account and payments, as typed-data.ts verified them against payoutAccountHash and
 * scheduleHash: written here from the verified values, never copied from the server's text. The bank name is not signed.
 */
function webOrderRows(o: WebOrderPreimage): SignedRow[] {
  return [
    { label: "Paid to (name on the account)", value: o.holderName, effect: "loosen", fields: ["payoutAccountHash"], brief: { label: "Paid to", value: o.holderName } },
    { label: "Account number", value: groupDigits(o.accountNumber), effect: "loosen", mono: true, fields: ["payoutAccountHash"], brief: { label: "Their bank account", value: `ending ${o.accountNumber.slice(-4)}` } },
    ...milestoneRows(o.schedule, WEB_PAYS),
  ];
}

/**
 * Rows for the typed data's primary struct, decoded from its message. Assumes the struct was checked (typed-data.ts);
 * `webOrder` is that check's verified account and schedule of a web supplier's SupplierApproval, `schedule` its
 * verified schedule of a catalog supplier's. `currency` picks the time zone of dates (SGD → SGT).
 */
export function signedRows(td: TypedData, webOrder?: WebOrderPreimage, schedule?: WebOrderPreimage["schedule"], currency?: string): SignedRow[] {
  const m = td.message;
  const s = (k: string) => String(m[k] ?? "");
  const code = (label: string, key: string): SignedRow => ({ label: `${label} (check code)`, value: s(key), effect: "neutral", mono: true, fields: [key] });
  const when = (key: string) => zonedDateTime(Number(s(key)), currency) ?? s(key);
  let rows: SignedRow[];
  switch (td.primaryType) {
    case "PlanApproval":
      rows = [
        { label: "Plan", value: `Version ${s("version")}`, effect: "neutral", fields: ["version"] },
        { label: "Plan ID", value: tagText(s("planId")), effect: "neutral", mono: tagText(s("planId")).startsWith("0x"), fields: ["planId"] },
        { label: "Total budget", value: `${bu(s("totalMinor"))}. Hogee's AI may spend it, but only inside each pocket's limits.`, effect: "loosen", fields: ["totalMinor"] },
        { label: "Kept for tax", value: `${Number(s("reserveBps")) / 100}% of every sale`, effect: "tighten", fields: ["reserveBps"] },
        { label: "The AI's paying key", value: s("agent"), effect: "loosen", mono: true, fields: ["agent"] },
        { label: "The AI can pay until", value: when("agentExpiry"), effect: "loosen", fields: ["agentExpiry"] },
        code("Pockets and limits", "linesHash"),
        code("Budget releases", "stagesHash"),
        code("Country rules", "countryPackHash"),
        code("Whole plan", "planHash"),
        s("prevPlanHash") === ZERO32 ? { label: "Replaces", value: "Nothing: this is your first plan", effect: "neutral", fields: ["prevPlanHash"] } : code("Replaces plan", "prevPlanHash"),
      ];
      break;
    case "SupplierApproval":
      rows = [
        { label: "Supplier", value: `${tagText(s("supplierId"))} (#${Number(s("chosenIndex")) + 1} on your list)`, effect: "neutral", fields: ["supplierId", "chosenIndex"] },
        { label: "Who can be paid", value: `${tagText(s("payee"))} can be paid from your ${pocket(s("lineId"))}`, effect: "loosen", fields: ["payee", "lineId"] },
        { label: "Order total", value: bu(s("totalMinor")), effect: "loosen", fields: ["totalMinor"] },
        {
          label: "Delivery check",
          value: m.inspectionRequired === true ? "Needed before the balance is paid" : "Not needed",
          effect: m.inspectionRequired === true ? "tighten" : "neutral",
          fields: ["inspectionRequired"],
        },
        { label: "Order", value: tagText(s("orderId")), effect: "neutral", fields: ["orderId"] },
        ...(webOrder ? webOrderRows(webOrder) : schedule ? milestoneRows(schedule, CATALOG_PAYS) : []),
        code("Bank account", "payoutAccountHash"),
        code("Payment plan", "scheduleHash"),
        code("Price quote", "quoteHash"),
        code("Supplier list", "shortlistHash"),
      ];
      break;
    case "MilestoneRelease":
      rows = [
        {
          label: "Pay",
          value: `${bu(s("amountMinor"))} to the supplier (payment ${Number(s("idx")) + 1} of order ${tagText(s("orderId"))})`,
          effect: "loosen",
          fields: ["amountMinor", "idx", "orderId"],
        },
        code("Delivery check report", "evidenceHash"),
      ];
      break;
    case "LoosenRequest":
      rows = [{ label: "Change", value: loosenChange(m, currency) ?? `Unknown change (kind ${s("kind")})`, effect: "loosen", fields: ["kind"] }, ...loosenFieldRows(m, currency)];
      break;
    case "StageRelease":
      rows = [{ label: "Release", value: `${bu(s("amountMinor"))}, budget part ${tagText(s("stageId"))}`, effect: "loosen", fields: ["amountMinor", "stageId"] }];
      break;
    case "OwnerSpend":
      rows = [
        { label: "You pay", value: `${bu(s("amountMinor"))} to ${tagText(s("payeeId"))} from your ${pocket(s("lineId"))}`, effect: "loosen", fields: ["amountMinor", "payeeId", "lineId"] },
        code("Invoice", "invoiceHash"),
      ];
      break;
  }
  return [
    ...rows,
    { label: "App version", value: tagText(s("deploymentId")), effect: "neutral", fields: ["deploymentId"] },
    { label: "This approval expires", value: when("expiry"), effect: "neutral", fields: ["expiry"] },
    { label: "One-time number", value: s("nonce"), effect: "neutral", mono: true, fields: ["nonce"] },
  ];
}
