/**
 * planWebOrder (VISION-DECISIONS §9): the SupplierApproval of a web supplier's confirmed terms, recomputed from the
 * immutable supplier_terms row at prepare AND at finalize, with the CURRENT state: the candidate (still an orderable
 * candidate of its READY search), the currency, the payout account (channel fixed to MOCK_ONLY, its canonical JSON and
 * keccak hash as stored), the holder match, sanctions on the holder and the seller, core termsToSchedule under the
 * current SUPPLIER limits, the quoteHash (kind WEB_TERMS), and one order per web supplier. Anything that differs from
 * the row refuses the signature (CONFLICT, or the TERMS_* reason); nothing in the request but the refId is used.
 */
import { WEB_PAYOUT_CHANNEL, formatBu, jcs, payoutAccountHash, webMilestoneRows, webPayoutRows, webQuoteHash, type MilestoneInput } from "@hogee/core";
import { lineKeyToLineId } from "../../chain-lib";
import type { ApiDeps, Scope } from "../../context";
import { fail } from "../../http/problem";
import { requireServerCountry } from "../compile";
import { requireFacility } from "../facility";
import { one, pool } from "../sql";
import { requireUnbound } from "../supplier-terms";
import { webCandidateOf } from "../terms-candidate";
import { accountFormatOk, screenTermsNames, supplierLimits, termsCurrency, termsFailure, webSchedule } from "../terms-checks";
import { holderMatchesSeller } from "../terms-names";
import { row, type DisplayRow } from "./kinds";

const SUPPLIER_RE = /^supplier-([a-z0-9]{1,20})$/;

export interface WebOrderPlan {
  readonly termsId: string;
  readonly orderId: string;
  readonly supplierId: string;
  /** The card's wording-checked seller name, or "(name hidden)". */
  readonly displayName: string;
  readonly listingHost: string;
  readonly chosenIndex: number;
  readonly shortlistHash: string;
  readonly schedule: readonly bigint[];
  readonly autoRelease: readonly boolean[];
  readonly milestones: readonly MilestoneInput[];
  readonly lineId: `0x${string}`;
  readonly account: { channel: string; accountNumber: string; holderName: string };
  readonly payoutAccountHash: string;
  readonly bankName: string;
  readonly quantity: number;
  readonly quoteHash: string;
}

interface WebTermsRow {
  id: string;
  shortlist_id: string;
  supplier_id: string;
  chosen_index: number;
  currency: string;
  quote_total_minor: string;
  quantity: number;
  terms_json: MilestoneInput[];
  schedule_json: { amountMinor?: unknown; autoRelease?: unknown }[];
  payout_account_ref: string;
  payout_account_hash: string;
  bank_name: string;
  payee_type: string;
  quote_hash: string;
  status: "CONFIRMED" | "SUPERSEDED" | "USED";
}

const changed = (what: string) => fail("CONFLICT", `${what} changed since the terms were confirmed; confirm the terms again`);

/** The stored payout account, only in its canonical MOCK_ONLY form (a row edited into anything else is refused). */
function storedAccount(r: WebTermsRow): WebOrderPlan["account"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.payout_account_ref);
  } catch {
    throw changed("The payout account");
  }
  const a = parsed as { channel?: unknown; accountNumber?: unknown; holderName?: unknown };
  if (a.channel !== WEB_PAYOUT_CHANNEL || typeof a.accountNumber !== "string" || typeof a.holderName !== "string") throw changed("The payout account");
  const account = { channel: WEB_PAYOUT_CHANNEL, accountNumber: a.accountNumber, holderName: a.holderName };
  if (jcs(account) !== r.payout_account_ref || payoutAccountHash(account).toLowerCase() !== r.payout_account_hash.toLowerCase()) throw changed("The payout account");
  return account;
}

/** The terms row `termsId`, recomputed and checked as the header says. */
export async function planWebOrder(deps: ApiDeps, scope: Scope, termsId: string): Promise<WebOrderPlan> {
  const db = pool(deps.db);
  await requireServerCountry(deps, db, scope, await requireFacility(db, scope), "nothing was signed");
  const r = await one<WebTermsRow>(
    db,
    `select id, shortlist_id, supplier_id, chosen_index, currency, quote_total_minor::text as quote_total_minor, quantity, terms_json, schedule_json,
            payout_account_ref, payout_account_hash, bank_name, payee_type, quote_hash, status
       from supplier_terms where facility_id = $1 and id = $2`,
    [scope.facilityId, termsId],
  );
  if (!r) throw fail("NOT_FOUND", "No such supplier terms");
  if (r.status === "SUPERSEDED") throw termsFailure("TERMS_SUPERSEDED", "These terms were replaced by newer ones; sign the newest terms");
  if (r.status !== "CONFIRMED") throw termsFailure("TERMS_ALREADY_BOUND", "These terms are already approved; a web supplier gets one order");
  const suffix = SUPPLIER_RE.exec(r.supplier_id)?.[1];
  if (!suffix) throw changed("The supplier");
  const c = await webCandidateOf(deps, db, scope, r.shortlist_id, r.supplier_id);
  if (c.chosenIndex !== Number(r.chosen_index)) throw changed("The search result");
  const currency = await termsCurrency(deps, db, scope);
  if (currency !== r.currency) throw termsFailure("TERMS_CURRENCY", `These terms are in ${r.currency}, but the facility now works in ${currency}`);
  const account = storedAccount(r);
  if (r.payee_type !== "company") throw termsFailure("TERMS_PAYEE_PERSONAL", "Hogee pays suppliers only into a company account");
  if (!accountFormatOk(account.accountNumber)) throw termsFailure("TERMS_ACCOUNT_FORMAT", "The stored account number is not a usable bank account number");
  if (!holderMatchesSeller(account.holderName, c.sellerName)) throw termsFailure("TERMS_HOLDER_MISMATCH", "The account holder no longer matches the seller on the listing");
  await screenTermsNames(deps, [account.holderName, c.sellerName]);
  const total = BigInt(r.quote_total_minor);
  const s = webSchedule(total, r.terms_json, await supplierLimits(deps, scope));
  const stored = r.schedule_json.map((x) => [String(x.amountMinor), x.autoRelease] as const);
  const now = s.amounts.map((a, i) => [a.toString(), s.autoRelease[i]] as const);
  if (JSON.stringify(stored) !== JSON.stringify(now)) throw changed("The schedule");
  const quoteHash = webQuoteHash({
    termsId: r.id,
    supplierId: r.supplier_id,
    shortlistHash: c.shortlistHash,
    chosenIndex: c.chosenIndex,
    currency,
    totalMinor: r.quote_total_minor,
    milestones: r.terms_json,
    payeeType: r.payee_type,
    payoutAccountHash: r.payout_account_hash,
  });
  if (quoteHash.toLowerCase() !== r.quote_hash.toLowerCase()) throw changed("The confirmed terms");
  await requireUnbound(db, scope, r.supplier_id);
  return {
    termsId: r.id,
    orderId: `order-${suffix}-001`,
    supplierId: r.supplier_id,
    displayName: c.card.displayName,
    listingHost: c.listingHost,
    chosenIndex: c.chosenIndex,
    shortlistHash: c.shortlistHash,
    schedule: s.amounts,
    autoRelease: s.autoRelease,
    milestones: r.terms_json.map((m) => ({ bps: m.bps, trigger: m.trigger })),
    lineId: lineKeyToLineId("SUPPLIER"),
    account,
    payoutAccountHash: r.payout_account_hash.toLowerCase(),
    bankName: r.bank_name,
    quantity: Number(r.quantity),
    quoteHash,
  };
}

/**
 * What the founder reads before signing a web order (built from the plan, never from listing text). The holder, the
 * whole account number and the bank are separate rows, and the account and milestone rows use core's exact form, so
 * the browser recomputes payoutAccountHash and scheduleHash from them before it lets her sign (run-9).
 */
export function webOrderRows(o: WebOrderPlan): DisplayRow[] {
  const total = o.schedule.reduce((sum, x) => sum + x, 0n);
  const milestones = webMilestoneRows(o.schedule.map((amountMinor, i) => ({ trigger: o.milestones[i]?.trigger, amountMinor, autoRelease: o.autoRelease[i] === true })));
  return [
    row("Order", o.orderId),
    row("Supplier", `${o.displayName}, found by web search`),
    row("Found by web search, not verified", `Listing on ${o.listingHost}. Nobody has checked this seller's registration, certificates or address.`, "loosen"),
    ...webPayoutRows({ holderName: o.account.holderName, accountNumber: o.account.accountNumber, bankName: o.bankName }).map((r) => row(r.label, r.value, r.effect)),
    row("Order total", `${formatBu(total)} for ${o.quantity.toLocaleString("en")} units`),
    ...milestones.map((r) => row(r.label, r.value, r.effect)),
    row("Paid from", "The supplier pocket, through escrow only"),
    row("Cooling period", "Nothing is paid before it ends; the loan officer can pause every agent payment until then"),
  ];
}
