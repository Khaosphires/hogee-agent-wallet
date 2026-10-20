/**
 * One builder per NEEDS_GROUP. Each item takes its facts from the compiled draft (lines, rules, reserve) or the country
 * pack (fees, rates, durations), and its sourceRef from the rule or pack leaf that states them. A pack fact that is
 * missing gives a TODO item with detail and sourceRef null (accounts), never a guessed value.
 *
 * Details are built from code labels and numbers; the only pack text quoted is a marketplace fee name, and when quoting
 * would pass 300 characters the detail drops the names, never cutting a sentence.
 */
import { pct, type ComplianceProfile } from "../compiler/compliance";
import { RuleIds } from "../compiler/rule-ids";
import { formatBu, maxBig } from "../money/index";
import type { CountryPack } from "../schemas/country-pack";
import { LINE_KEYS, REGISTRATIONS, type LineKey } from "../schemas/enums";
import type { PlanDraft, PlanLine, PlanRule } from "../schemas/plan";
import { NeedsError } from "./errors";
import {
  APPROVAL_TITLE,
  CATEGORY_LABEL,
  CHANNEL_NAME,
  COUNTERPARTY_LINES,
  COUNTERPARTY_TITLE,
  COUNTRY_LABEL,
  LINE_NAME,
  LINE_TITLE,
  PAYOUT_RAIL_BY_COUNTRY,
  PLAIN_PURPOSE,
  RAIL_NAME,
  REGISTRATION_TITLE,
  SELLER_ACCOUNT_TITLE,
  SIMULATED_PAYOUT_RAILS,
  TAX_OFFICE_NAME,
} from "./labels";
import type { NeedsItem } from "./types";

/**
 * The sourceRef of a budget line's amount: the compiler's line split (compiler/constants.ts LINE_SPLIT_WEIGHTS_BPS). No
 * draft rule states it, so it is the one compiler ref a checklist adds; LICENSING cites the draft's licensing rule.
 */
export const NEEDS_LINE_SPLIT_REF = "compiler:line-split";

const DETAIL_MAX = 300;

/** Basis points as a plain percentage for Mei: 500 → "5%", 216 → "2.16%". */
const plainPct = (bps: number | bigint | string): string => `${Number(bps) / 100}%`;
const DAY_SECONDS = 86_400n;

export interface NeedsContext {
  readonly draft: PlanDraft;
  readonly pack: CountryPack;
  /** deriveCompliance(draft.intent, pack, floor): the registrations and the approval the draft's rules must carry. */
  readonly profile: ComplianceProfile;
  /** The facility floor from the options (validated 0..10000). */
  readonly floorBps: number;
}

/** The draft rule with this id (fail closed: a checklist never states what the draft does not carry). */
function draftRule(ctx: NeedsContext, ruleId: string): PlanRule {
  const rule = ctx.draft.manifest.rules.find((r) => r.ruleId === ruleId);
  if (!rule) throw new NeedsError("DRAFT_MISMATCH", `the draft has no rule ${ruleId}, which its pack requires`);
  return rule;
}

/** A sourceRef the draft's rules carry (constitution or compiler rule). */
function draftRef(ctx: NeedsContext, sourceRef: string): string {
  if (!ctx.draft.manifest.rules.some((r) => r.sourceRef === sourceRef)) throw new NeedsError("DRAFT_MISMATCH", `the draft has no rule citing ${sourceRef}`);
  return sourceRef;
}

/** The first candidate within the detail limit (candidates go from fullest to shortest). */
function fitDetail(candidates: readonly string[]): string {
  const fit = candidates.find((c) => c.length <= DETAIL_MAX);
  if (fit === undefined) throw new NeedsError("LIMITS", "no detail fits 300 characters");
  return fit;
}

const sentence = (text: string): string => (text.endsWith(".") ? text : `${text}.`);
const days = (n: number): string => (n === 0 ? "same day" : `${n} day${n === 1 ? "" : "s"}`);
const lineOf = (ctx: NeedsContext, key: LineKey): PlanLine | undefined => ctx.draft.manifest.lines.find((l) => l.lineKey === key);

function item(fields: Omit<NeedsItem, "itemId"> & { readonly key: string }): NeedsItem {
  const { key, ...rest } = fields;
  return { itemId: `needs-${rest.group.toLowerCase()}-${key}`, ...rest };
}

/** REGISTRATION: each registration the compliance profile requires, then the product approval unless it is NONE. */
export function registrationItems(ctx: NeedsContext): NeedsItem[] {
  const { profile, draft, pack } = ctx;
  const regs = [...profile.registrations].sort((a, b) => REGISTRATIONS.indexOf(a.code) - REGISTRATIONS.indexOf(b.code));
  const items = regs.map((reg) =>
    item({
      key: reg.code.toLowerCase(),
      group: "REGISTRATION",
      title: REGISTRATION_TITLE[reg.code],
      detail: reg.feeMinor > 0n ? "A government fee. You pay it yourself, before the loan money arrives. It doesn't come from this budget." : "No government fee.",
      amountMinor: reg.feeMinor.toString(),
      lineKey: null,
      sourceRef: draftRule(ctx, RuleIds.registration(reg.code, reg.feeMinor)).sourceRef,
      status: "TODO",
    }),
  );
  const approval = profile.productApproval;
  if (approval === "NONE") return items;
  const category = draft.intent.productCategory;
  const entry = pack.productApprovals?.[category];
  if (!entry) throw new NeedsError("DRAFT_MISMATCH", `the pack has no product approval entry for ${category}`);
  const fee = profile.approvalFeeMinor;
  if (fee > 0n && !lineOf(ctx, "LICENSING")) throw new NeedsError("DRAFT_MISMATCH", "an approval fee with no LICENSING line");
  const feeText = fee > 0n ? "The fee comes from your Licence fees pocket." : "No fee.";
  return [
    ...items,
    item({
      key: `approval-${approval.toLowerCase()}`,
      group: "REGISTRATION",
      title: APPROVAL_TITLE[approval],
      detail: `For ${CATEGORY_LABEL[category].toLowerCase()}. ${feeText} Typical time: ${days(entry.time.value)}.`,
      amountMinor: fee.toString(),
      lineKey: null,
      sourceRef: draftRule(ctx, RuleIds.approval(approval, fee)).sourceRef,
      status: "TODO",
    }),
  ];
}

function windowText(windowSeconds: string): string {
  const s = BigInt(windowSeconds);
  return s > 0n && s % DAY_SECONDS === 0n ? days(Number(s / DAY_SECONDS)) : `${s} seconds`;
}

/** BUDGET_LINE: one per manifest line, in LINE_KEYS order, with its amount, caps and (ADS) daily pacing. */
export function budgetLineItems(ctx: NeedsContext): NeedsItem[] {
  const lines = [...ctx.draft.manifest.lines].sort((a, b) => LINE_KEYS.indexOf(a.lineKey) - LINE_KEYS.indexOf(b.lineKey));
  return lines.map((line) => {
    const caps = `At most ${formatBu(line.perTxCapMinor)} per payment, and ${formatBu(line.windowCapMinor)} every ${windowText(line.windowSeconds)}.`;
    const pacing = line.pacing ? ` At most ${formatBu(line.pacing.amountMinor)} a day.` : "";
    const purpose = PLAIN_PURPOSE[line.purpose] ?? line.purpose;
    return item({
      key: line.lineKey.toLowerCase(),
      group: "BUDGET_LINE",
      title: LINE_TITLE[line.lineKey],
      detail: fitDetail([`${sentence(purpose)} ${caps}${pacing}`, sentence(purpose)]),
      amountMinor: line.amountMinor,
      lineKey: line.lineKey,
      sourceRef: line.lineKey === "LICENSING" ? draftRef(ctx, "compiler:licensing-line") : NEEDS_LINE_SPLIT_REF,
      status: "IN_PLAN",
    });
  });
}

/**
 * SUPPLIER: a counterparty to find for each SUPPLIER / PACKAGING / LOGISTICS line with no payee in the plan. A line that
 * already names a payee (a platform account such as the marketplace's logistics partner) needs nobody found.
 */
export function counterpartyItems(ctx: NeedsContext): NeedsItem[] {
  const category = CATEGORY_LABEL[ctx.draft.intent.productCategory];
  return COUNTERPARTY_LINES.flatMap((key) => {
    const line = lineOf(ctx, key);
    if (!line || line.payeeIds.length > 0) return [];
    const escrow = key === "SUPPLIER";
    const detail = escrow
      ? `${category}. Paid in steps from your supplier pocket. The last payment needs your passkey and a delivery check report.`
      : `Your plan doesn't name anyone to pay yet. When you choose someone, your loan officer must approve them before your ${LINE_NAME[key]} pocket can pay them.`;
    return [
      item({
        key: key.toLowerCase(),
        group: "SUPPLIER",
        title: COUNTERPARTY_TITLE[key],
        detail,
        amountMinor: null,
        lineKey: key,
        sourceRef: draftRef(ctx, escrow ? "constitution:SUPPLIER_LINE_NOT_ESCROW" : "constitution:PLAN_ADDS_PAYEE"),
        status: "TODO",
      }),
    ];
  });
}

function sellerItem(ctx: NeedsContext): NeedsItem {
  const { pack } = ctx;
  const channel = ctx.draft.intent.sellChannel;
  const markets = pack.marketplaces ?? [];
  const i = markets.findIndex((m) => m.channel === channel);
  const fees = markets[i]?.fees ?? [];
  const where = `Sell on ${CHANNEL_NAME[channel]} in ${COUNTRY_LABEL[pack.countryCode]}.`;
  const found = fees.length > 0;
  return item({
    key: `seller-${channel}`,
    group: "ACCOUNT",
    title: SELLER_ACCOUNT_TITLE[channel],
    detail: found
      ? fitDetail([
          `${where} Fees on each sale: ${fees.map((f) => `${f.name} ${pct(f.rateBps.value)}`).join(", ")}.`,
          `${where} Fees on each sale: ${fees.map((f) => pct(f.rateBps.value)).join(", ")}.`,
        ])
      : null,
    amountMinor: null,
    lineKey: null,
    sourceRef: found ? `/marketplaces/${i}/fees/0/rateBps` : null,
    status: "TODO",
  });
}

function payoutItem(ctx: NeedsContext): NeedsItem {
  const railId = PAYOUT_RAIL_BY_COUNTRY[ctx.pack.countryCode];
  const rails = ctx.pack.paymentRails ?? [];
  const i = railId === null ? -1 : rails.findIndex((r) => r.id === railId);
  const rail = rails[i];
  const name = railId === null ? null : (RAIL_NAME[railId] ?? railId);
  const simulated = railId !== null && SIMULATED_PAYOUT_RAILS.has(railId) ? " (practice payments in this demo)" : "";
  const conditions = rail?.feeCondition ? " Some conditions apply; see the source." : "";
  return item({
    key: `payout-${railId === null ? "channel" : railId.toLowerCase()}`,
    group: "ACCOUNT",
    title: name === null ? "How people get paid" : `${name} for paying people`,
    detail: rail ? `People you pay get the money by ${name}${simulated}. Fee: ${plainPct(rail.feeBps.value)} of each payment.${conditions}` : null,
    amountMinor: null,
    lineKey: null,
    sourceRef: rail ? `/paymentRails/${i}/feeBps` : null,
    status: rail ? "IN_PLAN" : "TODO",
  });
}

/** ACCOUNT: the sell channel's seller account, then the rail payees are paid on. */
export function accountItems(ctx: NeedsContext): NeedsItem[] {
  return [sellerItem(ctx), payoutItem(ctx)];
}

/** The checklist's reserve rate: max(the plan's reserve, the pack floor, the facility floor). */
export function reserveRateBps(ctx: NeedsContext): number {
  const { manifest } = ctx.draft;
  return Number(maxBig(BigInt(manifest.reserveBps), BigInt(ctx.pack.reserveFloorBps.value), BigInt(ctx.floorBps)));
}

/** TAX_RESERVE: the reserve rate and where withdrawals may go. TODO when a floor is above the plan's reserve. */
export function taxReserveItem(ctx: NeedsContext): NeedsItem {
  const plan = ctx.draft.manifest.reserveBps;
  const rate = reserveRateBps(ctx);
  const office = TAX_OFFICE_NAME[ctx.pack.countryCode];
  const why = `Taken from every sale. It's the highest of: your plan (${plainPct(plan)}), the country's minimum (${plainPct(ctx.pack.reserveFloorBps.value)}) and your loan's minimum (${plainPct(ctx.floorBps)}).`;
  const raise = rate > plan ? " Raise your plan's tax share to this before you sign." : "";
  return item({
    key: "reserve",
    group: "TAX_RESERVE",
    title: `Kept for tax: ${plainPct(rate)} of each sale`,
    detail: fitDetail([`${why}${raise}${office === null ? "" : ` This money can only go to ${office}, to pay your tax.`}`, `${why}${raise}`]),
    amountMinor: null,
    lineKey: null,
    sourceRef: draftRule(ctx, RuleIds.reserve).sourceRef,
    status: rate > plan ? "TODO" : "IN_PLAN",
  });
}
