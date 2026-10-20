/**
 * Facts the plan view reads from a compiled plan's rules. Everything comes from the rule ids and pack pointers the
 * compiler wrote (core compiler/rule-ids.ts), never from rule text and never from a lookup in the web app.
 */
import {
  ADS_PURPOSE_OWN_SITE,
  CONSTITUTION_RULE_COPY,
  E_INVOICING_SCHEME,
  EntityType,
  IMPORT_TAX_NAME,
  INDIRECT_TAX_NAME,
  LINE_PURPOSES,
  MEI_LINES,
  ProductApproval,
  ProductCategory,
  RULE_ID_PATTERNS,
  Registration,
  RuleIds,
  SellChannel,
  money,
  parseMinor,
  planHash,
  type CfoReport,
  type ConstitutionCode,
  type LineKey,
  type PlanDraft,
  type PlanLine,
  type PlanManifest,
  type PlanRecord,
  type PlanRule,
  type PlanStage,
} from "@hogee/core";
import { salesFigure } from "../components/cfo/cfo-model";
import { usedPct } from "../components/ledger/pocket-math";
import { bu } from "./format";

export interface ApprovalStep {
  readonly agency: Exclude<ProductApproval, "NONE">;
  /** Facility-currency minor units, as the compiler multiplied it out (rule id `approval.<agency>.fee.<minor>`). */
  readonly feeMinor: bigint;
  /** The pack leaf the fee came from: productApprovals.<category>. */
  readonly category: ProductCategory;
  readonly rule: PlanRule;
}

const APPROVAL_POINTER = /^\/productApprovals\/([a-z_]+)\/[a-z]+$/;

/**
 * The product approval the plan needs before the first sale (Mei: SFA, free), from the compiler's one
 * `approval.<agency>.fee.<minor>` rule and its pack pointer. undefined when the plan needs none (`approval.none`), has
 * no approval rule (a preview or an example plan), or anything is malformed: the step is then not shown, and the
 * rule list below still shows every rule as compiled.
 */
export function approvalStepOf(rules: readonly PlanRule[]): ApprovalStep | undefined {
  const matches = rules.flatMap((rule) => {
    const m = RULE_ID_PATTERNS.approval.exec(rule.ruleId);
    return m ? [{ rule, m }] : [];
  });
  const only = matches.length === 1 ? matches[0] : undefined;
  if (!only) return undefined;
  const [, none, code, fee] = only.m;
  if (none !== undefined || code === undefined || fee === undefined) return undefined;
  const agency = ProductApproval.safeParse(code.toUpperCase());
  const category = ProductCategory.safeParse(APPROVAL_POINTER.exec(only.rule.sourceRef)?.[1]);
  if (!agency.success || agency.data === "NONE" || !category.success) return undefined;
  return { agency: agency.data, feeMinor: BigInt(fee), category: category.data, rule: only.rule };
}

export interface PackDepth {
  /** Rules taken from the country pack (sourceRef is a JSON Pointer into it). */
  readonly packRules: number;
  /** Of those, the ones whose source a person verified (`verifiedOn`). */
  readonly verified: number;
}

/** How much of the shown country's pack a person has verified, counted over the rules this plan uses. */
export function packDepth(rules: readonly PlanRule[]): PackDepth {
  const pack = rules.filter((r) => r.sourceRef.startsWith("/"));
  return { packRules: pack.length, verified: pack.filter((r) => r.source?.verifiedOn !== undefined).length };
}

// ---- display maps (UX-PLAN D19): plain words for text that is part of the signed plan --------------------------------

/**
 * A pocket's purpose in plain words, keyed by lineKey AND the exact compiled text it replaces. The compiled purpose is
 * inside the signed plan (it is hashed into planHash), so it is never edited at the source: the page shows this plain
 * version only while the compiled text is exactly the one it was written for, and the compiled text otherwise.
 */
function demoPurpose(key: LineKey): string {
  return MEI_LINES.find((l) => l.lineKey === key)?.purpose ?? LINE_PURPOSES[key];
}

const PLAIN_PURPOSE: readonly { readonly lineKey: LineKey; readonly source: string; readonly plain: string }[] = [
  { lineKey: "SUPPLIER", source: LINE_PURPOSES.SUPPLIER, plain: "Goods from your supplier, paid in steps and held until delivery" },
  // The demo plans (core demo/mei.ts, rina.ts) name the product in the supplier pocket.
  { lineKey: "SUPPLIER", source: demoPurpose("SUPPLIER"), plain: "Insulated tumblers from your supplier, paid in steps and held until delivery" },
  { lineKey: "PACKAGING", source: LINE_PURPOSES.PACKAGING, plain: "Printed packaging for your product" },
  { lineKey: "LOGISTICS", source: LINE_PURPOSES.LOGISTICS, plain: "Shipping to you, and delivery to your customers" },
  { lineKey: "ADS", source: LINE_PURPOSES.ADS, plain: "Ads on the marketplace, a little each day" },
  { lineKey: "ADS", source: ADS_PURPOSE_OWN_SITE, plain: "Online ads for your shop's website, a little each day" },
  { lineKey: "PLATFORM_FEES", source: LINE_PURPOSES.PLATFORM_FEES, plain: "The marketplace's fees on each sale" },
  { lineKey: "LICENSING", source: LINE_PURPOSES.LICENSING, plain: "Fees for the product approvals you must have" },
  { lineKey: "CONTINGENCY", source: LINE_PURPOSES.CONTINGENCY, plain: "Surprise costs, paid only to people you approve" },
];

/** The words a pocket's purpose shows with: the plain version for a known compiled text, else the compiled text itself. */
export function pocketPurpose(line: { readonly lineKey: LineKey; readonly purpose: string }): string {
  return PLAIN_PURPOSE.find((p) => p.lineKey === line.lineKey && p.source === line.purpose)?.plain ?? line.purpose;
}

/** Hogee's fixed safety rules in plain words (the check runs on the code, never on these words). */
export const PLAIN_SAFETY_RULE: { readonly [C in ConstitutionCode]: string } = {
  LINES_EXCEED_FACILITY_CAP: "Your pockets add up to no more than your loan",
  AGENT_EXPIRY_TOO_LATE: "The AI can pay for 90 days at most",
  AGENT_EXPIRY_TOO_EARLY: "The AI can pay until the end of the review period",
  PER_TX_CAP_OVER_25PCT: "No single payment is more than 25% of its pocket",
  WINDOW_CAP_OVER_50PCT: "No pocket pays out more than 50% of itself in any 7 days",
  LINE_VALIDITY_TOO_LONG: "Every pocket stays open for 90 days at most",
  RESERVE_BELOW_FLOOR: "The tax money kept is at least your loan's minimum",
  STAGE1_OVER_40PCT: "The first budget release is at most 40% of the total",
  PLAN_ADDS_PAYEE: "The plan adds no one new to pay",
  SUPPLIER_LINE_NOT_ESCROW: "The supplier is paid only in steps, held until delivery",
  PAYEE_CAP_OVER_SCHEDULE: "No one can get more than their agreed payments",
  TOTALS_MISMATCH: "The pockets add up to the plan total",
  MALFORMED_PLAN: "The plan is complete",
  REPLAN_LOOSENS: "A new version of your plan can only make the rules stricter",
};

/** Checks folded under "Show details" when they pass (UX-PLAN D30: the review-period check). A failing one always shows. */
export const DETAIL_ONLY_RULES: ReadonlySet<ConstitutionCode> = new Set<ConstitutionCode>(["AGENT_EXPIRY_TOO_EARLY"]);

/** Every code has a plain line and a core line, so a new code never shows blank. */
export const safetyRuleText = (code: ConstitutionCode): string => PLAIN_SAFETY_RULE[code] ?? CONSTITUTION_RULE_COPY[code];

// ---- the plan page at a glance (UX round 2): short labels from ids and numbers, never from rule text ----------------

/** A pocket's payout limit as one short chip, and the same limit as a sentence for screen readers and the details. */
export interface PocketLimit {
  readonly chip: string;
  /** The chip in parts that never break inside ("≤ 375 BU each", "750 BU a week"); the chip joins them with " · ". */
  readonly parts: readonly string[];
  readonly full: string;
}

const DAY_SECONDS = 86_400n;

/** "a week" for a 7-day window, else "every N days" (the window is part of the signed line; it is never assumed). */
function windowWords(windowSeconds: string): { readonly short: string; readonly long: string } {
  const seconds = BigInt(windowSeconds);
  const days = seconds / DAY_SECONDS;
  if (seconds % DAY_SECONDS !== 0n || days < 1n) return { short: `per ${windowSeconds} s`, long: `per ${windowSeconds} seconds` };
  if (days === 7n) return { short: "a week", long: "per week" };
  if (days === 1n) return { short: "a day", long: "per day" };
  return { short: `per ${days} days`, long: `per ${days} days` };
}

/** "≤ 375 BU each · 750 BU a week", "≤ 75 BU a day" (paced ads) or "Paid in steps" (the supplier). */
export function pocketLimit(line: Pick<PlanLine, "escrowOnly" | "pacing" | "perTxCapMinor" | "windowCapMinor" | "windowSeconds">): PocketLimit {
  const of = (parts: readonly string[], full: string): PocketLimit => ({ chip: parts.join(" · "), parts, full });
  if (line.escrowOnly) return of(["Paid in steps"], "Paid in steps, held until delivery");
  if (line.pacing) return of([`≤ ${bu(line.pacing.amountMinor)} a day`], `At most ${bu(line.pacing.amountMinor)} a day`);
  const w = windowWords(line.windowSeconds);
  return of([`≤ ${bu(line.perTxCapMinor)} each`, `${bu(line.windowCapMinor)} ${w.short}`], `At most ${bu(line.perTxCapMinor)} per payment, ${bu(line.windowCapMinor)} ${w.long}`);
}

/** The budget's releases as one line: "4,000 BU when you sign · 6,000 BU in 1 later release". */
export function releaseLine(stages: readonly Pick<PlanStage, "releaseMinor">[], totalMinor: string, signed: boolean): string {
  const first = stages[0];
  if (!first) return "";
  const when = signed ? "at signing" : "when you sign";
  const rest = stages.slice(1);
  if (rest.length === 0) return `${bu(first.releaseMinor)} ${when}`;
  const later = parseMinor(totalMinor) - parseMinor(first.releaseMinor);
  return `${bu(first.releaseMinor)} ${when} · ${bu(later.toString())} in ${rest.length} later release${rest.length === 1 ? "" : "s"}`;
}

/**
 * Where a release is: its money is in the wallet ("released"), it is signed but the loan officer hasn't added the money
 * yet ("awaiting-funds": never "Released" while the wallet is empty), it comes with the signature ("at-signing"), or it
 * waits on its gate ("waiting").
 */
export type ReleaseStatus = "released" | "awaiting-funds" | "at-signing" | "waiting";

export interface ReleaseStep {
  readonly stageId: string;
  readonly releaseMinor: string;
  readonly status: ReleaseStatus;
  /** The gate, in words and numbers; null for the first release (it comes with the signature). */
  readonly gate: null | {
    readonly metric: "salesMinor" | "orders";
    readonly target: string;
    readonly deadline: string;
    /** Sales so far against a sales target, 0–100; undefined without the sales figure or for an orders target. */
    readonly progressPct?: number;
    readonly soFarMinor?: string;
  };
}

/**
 * The releases as steps. They open in order, as the loan officer's stage card reads them: a release whose share the
 * chain's released total covers is "released" once the funding covers it too, and "awaiting-funds" until then; the first
 * one otherwise comes with the signature; a later one waits on its gate. Sales progress shows only for a sales gate, from
 * `salesMinor`: the CFO report's sales (salesSoFar), the same figure the Wallet shows.
 */
export function releaseSteps(
  stages: readonly PlanStage[],
  wallet: { readonly releasedMinor: string; readonly fundedMinor: string } | undefined,
  salesMinor?: string,
): readonly ReleaseStep[] {
  const released = wallet ? parseMinor(wallet.releasedMinor) : 0n;
  const funded = wallet ? parseMinor(wallet.fundedMinor) : 0n;
  let upTo = 0n;
  return stages.map((s) => {
    upTo += parseMinor(s.releaseMinor);
    const isReleased = wallet !== undefined && released > 0n && released >= upTo;
    const status: ReleaseStatus = isReleased ? (funded >= upTo ? "released" : "awaiting-funds") : s.gate === null ? "at-signing" : "waiting";
    if (s.gate === null) return { stageId: s.stageId, releaseMinor: s.releaseMinor, status, gate: null };
    const { metric, target, deadline } = s.gate;
    const sales = metric === "salesMinor" && salesMinor !== undefined ? parseMinor(salesMinor) : undefined;
    const goal = parseMinor(target);
    const progressPct = sales === undefined ? undefined : goal === 0n ? 100 : Number((sales >= goal ? goal : sales) * 1000n / goal) / 10;
    return {
      stageId: s.stageId,
      releaseMinor: s.releaseMinor,
      status,
      gate: { metric, target, deadline, ...(sales === undefined ? {} : { progressPct, soFarMinor: sales.toString() }) },
    };
  });
}

/**
 * Sales so far, as the Wallet shows them: the CFO report's own total (core: the same figure as the next release's
 * soFarMinor and the overview's sales). undefined until the report loads. Stand-in for ux3-wallet's
 * components/cfo/cfo-model.ts `salesFigure(report).soFarMinor` until both land together.
 */
export function salesSoFar(report: Pick<CfoReport, "sales"> | undefined): string | undefined {
  return report ? salesFigure(report).soFarMinor : undefined;
}

// ---- pockets as the Wallet reads them (UX round 3) ----------------------------------------------------------------------

export interface PocketFigures {
  readonly allocatedMinor: string;
  /** pocket.available: what the pocket can still pay (the Wallet's "left"). */
  readonly leftMinor: string;
  /** Paid out of the pocket; for the escrow pocket, what escrow paid the supplier. null while unknown. */
  readonly paidMinor: string | null;
  /** Held in escrow for the supplier and not paid yet; "0" for any other pocket. null while unknown. */
  readonly setAsideMinor: string | null;
  /** How much has gone out (paid or set aside), 0–100: the ring fills as money goes out, as on every page. */
  readonly usedPct: number;
}

/**
 * One pocket's figures, the same sources as the Wallet and the chat's wallet (core walletFigures): what is left is the
 * chain's `available`; a normal pocket's paid is its `spent`; the escrow pocket's paid is what escrow paid the supplier
 * (the CFO report's pnl.supplierCostMinor, on top of its own spent) and its set aside is the rest of the escrow. When
 * that paid-out part is unknown or larger than the escrow ever held, paid and set aside are null: nothing is shown
 * rather than a wrong number. Stand-in for ux3-wallet's components/cfo/cfo-model.ts `pocketLine` until both land.
 */
export function pocketFigures(
  pocket: { readonly allocated: string; readonly spent: string; readonly available: string },
  escrow: { readonly escrowOnly: boolean; readonly escrowMinor: string; readonly supplierPaidMinor: string | null },
): PocketFigures {
  const spent = parseMinor(pocket.spent);
  const base = { allocatedMinor: pocket.allocated, leftMinor: pocket.available, usedPct: usedPct(pocket.allocated, pocket.available) };
  if (!escrow.escrowOnly) return { ...base, paidMinor: spent.toString(), setAsideMinor: "0" };
  const committed = parseMinor(escrow.escrowMinor);
  const paidOut = escrow.supplierPaidMinor === null ? null : parseMinor(escrow.supplierPaidMinor);
  if (paidOut === null || paidOut > committed) return { ...base, paidMinor: null, setAsideMinor: null };
  return { ...base, paidMinor: (spent + paidOut).toString(), setAsideMinor: (committed - paidOut).toString() };
}

/** Where a rule comes from: the country's rules (a pack pointer), Hogee's code, or Hogee's fixed safety rules. */
export type RuleOrigin = "country" | "code" | "safety";

export function ruleOrigin(rule: Pick<PlanRule, "sourceRef">): RuleOrigin {
  if (rule.sourceRef.startsWith("constitution:")) return "safety";
  if (rule.sourceRef.startsWith("compiler:")) return "code";
  return "country";
}

/** What a rule is about, for its icon. */
export type RuleTopic = "registration" | "entity" | "tax" | "invoice" | "duty" | "approval" | "reserve" | "marketplace" | "ads" | "release" | "safety" | "other";

/** A rule as one short row: a title and, where the plan holds it as data, a value. `plain` is false for a fallback. */
export interface RuleRow {
  readonly title: string;
  readonly value?: string;
  readonly topic: RuleTopic;
  readonly plain: boolean;
}

const REGISTRATION_WORDS: { readonly [R in Registration]: string } = {
  SSM_SOLE_PROP: "Register the business (SSM)",
  SSM_SDN_BHD: "Register the company (SSM)",
  LHDN_TIN: "Tax number (LHDN)",
  SST: "SST registration",
  MYINVOIS: "E-invoicing (MyInvois)",
  PBT_LICENCE: "Council premises licence",
  NIB_OSS: "Business number (NIB)",
  NPWP_NIK: "Tax number (NPWP)",
  PKP: "VAT registration (PKP)",
  ACRA_BUSINESS: "Register the business (ACRA)",
  ACRA_PTE_LTD: "Register the company (ACRA)",
  IRAS_GST: "GST registration (IRAS)",
};

/** Business types in plain words (also the plan's "Your answers"). */
export const ENTITY_WORDS: { readonly [E in EntityType]: string } = {
  sg_sole_prop: "Sole proprietor",
  sg_partnership: "Partnership",
  pte_ltd: "Private limited company",
  sole_prop: "Sole proprietor",
  partnership: "Partnership",
  sdn_bhd: "Private limited company",
  perorangan: "Sole trader",
  pt_perorangan: "One-person company",
  cv: "Partnership (CV)",
  pt: "Limited company",
};

/** Where the founder sells, in plain words. */
export const CHANNEL_WORDS: { readonly [S in SellChannel]: string } = { shopee: "Shopee", tiktok_shop: "TikTok Shop", lazada: "Lazada", own_site: "Your own website" };

const DUTY_WORDS: Readonly<Record<string, string>> = { mfn: "Standard rate", exempt: "None", form_e: "Agreement rate (Form E)" };

/** Hogee's fixed safety rules that the compiler also writes into the plan, by rule id (the constitution's own numbers). */
const SAFETY_ROWS: Readonly<Record<string, Omit<RuleRow, "topic" | "plain">>> = {
  "constitution.caps": { title: "Caps on every pocket", value: "25% a payment · 50% a week" },
  "constitution.supplier-escrow": { title: "Supplier paid in steps", value: "Rest after delivery" },
  "constitution.stage1": { title: "First release", value: "At most 40%" },
  "constitution.payees": { title: "No one new to pay" },
};

const fee = (minor: string, currency: string): string => (BigInt(minor) === 0n ? "Free" : money(BigInt(minor), currency));
const isEntity = (v: string): v is EntityType => (EntityType.options as readonly string[]).includes(v);
const isRegistration = (v: string): v is Registration => (Registration.options as readonly string[]).includes(v);
const isChannel = (v: string): v is SellChannel => (SellChannel.options as readonly string[]).includes(v);

type RowManifest = Pick<PlanManifest, "countryCode" | "displayCurrency" | "reserveBps" | "lines" | "stages">;

/** The plain row for an id the plan carries as data; undefined for anything else (shown as compiled instead). */
function plainRow(rule: PlanRule, m: RowManifest): Omit<RuleRow, "plain"> | undefined {
  const id = rule.ruleId;
  const reg = RULE_ID_PATTERNS.registration.exec(id);
  if (reg) {
    const code = reg[1]?.toUpperCase() ?? "";
    return isRegistration(code) && reg[2] ? { title: REGISTRATION_WORDS[code], value: fee(reg[2], m.displayCurrency), topic: "registration" } : undefined;
  }
  const entity = RULE_ID_PATTERNS.entity.exec(id);
  if (entity) return entity[1] && isEntity(entity[1]) ? { title: "Business type", value: ENTITY_WORDS[entity[1]], topic: "entity" } : undefined;
  const tax = RULE_ID_PATTERNS.indirectTax.exec(id);
  if (tax) return { title: `${INDIRECT_TAX_NAME[m.countryCode]} registration`, value: tax[1] === "registered" ? "Needed" : "Not needed yet", topic: "tax" };
  const inv = RULE_ID_PATTERNS.eInvoicing.exec(id);
  if (inv) return { title: `E-invoicing (${E_INVOICING_SCHEME[m.countryCode]})`, value: inv[1] === "required" ? "Needed" : "Not needed", topic: "invoice" };
  const duty = RULE_ID_PATTERNS.duty.exec(id);
  if (duty) return duty[1] && DUTY_WORDS[duty[1]] ? { title: "Import duty", value: DUTY_WORDS[duty[1]], topic: "duty" } : undefined;
  const approval = RULE_ID_PATTERNS.approval.exec(id);
  if (approval) {
    const [, none, code, minor] = approval;
    if (none !== undefined) return { title: "Product approval", value: "Not needed", topic: "approval" };
    return code && minor ? { title: `${code.toUpperCase()} approval`, value: fee(minor, m.displayCurrency), topic: "approval" } : undefined;
  }
  if (id === RuleIds.importTax) return { title: IMPORT_TAX_NAME[m.countryCode], value: "On goods, shipping, duty", topic: "tax" };
  if (id === RuleIds.reserve) return { title: "Kept for tax", value: `${(m.reserveBps / 100).toFixed(2)}% of each sale`, topic: "reserve" };
  if (id === RuleIds.adsPacing) {
    const pacing = m.lines.find((l) => l.lineKey === "ADS")?.pacing;
    return { title: "Ads pace", ...(pacing ? { value: `${bu(pacing.amountMinor)} a day` } : {}), topic: "ads" };
  }
  if (id === RuleIds.stageGate) {
    const gate = m.stages[1]?.gate;
    if (!gate) return undefined;
    return { title: "Next release", value: gate.metric === "salesMinor" ? `After ${bu(gate.target)} in sales` : `After ${gate.target} orders`, topic: "release" };
  }
  const market = /^marketplace\.([a-z_]+)\.fees$/.exec(id);
  if (market) return market[1] && isChannel(market[1]) ? { title: `${CHANNEL_WORDS[market[1]]} fees`, value: "Taken from each sale", topic: "marketplace" } : undefined;
  const safety = SAFETY_ROWS[id];
  if (safety && ruleOrigin(rule) === "safety") return { ...safety, topic: "safety" };
  return undefined;
}

/**
 * A compiled rule as one short row. The title and value come from the rule id and the plan's own numbers (never from
 * the rule text, which is part of the signed plan and always one tap away); an id this map doesn't know shows its
 * compiled text as the title, so nothing is ever hidden or guessed.
 */
export function ruleRow(rule: PlanRule, m: RowManifest): RuleRow {
  const row = plainRow(rule, m);
  if (row) return { ...row, plain: true };
  return { title: rule.text, topic: ruleOrigin(rule) === "safety" ? "safety" : "other", plain: false };
}

/**
 * A person's review of the country rules this plan uses, in one plain sentence (design review, "words that read as
 * failure"): what the rules are and what a person has done, never a score.
 */
export function verifiedDepthText({ packRules, verified }: PackDepth, country: string): string {
  if (packRules === 0) return `This plan uses no ${country} rules from our list.`;
  if (verified === 0) return `From public sources. A person hasn't reviewed these yet (0 of ${packRules} ${country} rules used here).`;
  if (verified === packRules) return `From public sources. A person has reviewed all ${packRules} ${country} rules used here.`;
  return `From public sources. A person has reviewed ${verified} of the ${packRules} ${country} rules used here.`;
}

// ---- what the page shows, steadily (UX round 3) -----------------------------------------------------------------------

/** A query's answer as the page reads it. */
export interface QueryAnswer<T, E extends { readonly status: number } = { readonly status: number }> {
  readonly isPending: boolean;
  readonly data?: T;
  readonly error?: E | null;
}

/**
 * The last settled answer, kept through a background refetch. TanStack resets a query that has no data (GET
 * /api/plans/current is a 404 until something is signed, polled every 1.5 s) to "pending" on every fetch, so read raw,
 * each poll looked like the first load: the page flipped to "Checking your signature…" and back. A settled answer (data
 * or an error) stays until the next one arrives; only the very first load is "pending". Nothing is guessed: what shows
 * is always the server's last answer.
 */
export function settledAnswer<T, E extends { readonly status: number }>(last: QueryAnswer<T, E> | undefined, now: QueryAnswer<T, E>): QueryAnswer<T, E> {
  return now.isPending && last !== undefined && !last.isPending ? last : now;
}

/** A query as the page decides on it: still loading, found, a definite 404, or another failure. */
export type Found = "loading" | "found" | "missing" | "failed";

export function foundOf(q: QueryAnswer<unknown>): Found {
  if (q.data !== undefined) return "found";
  if (q.error) return q.error.status === 404 ? "missing" : "failed";
  return q.isPending ? "loading" : "missing";
}

/**
 * Whether the page has a plan to show (first-time-user review #5): the signed plan always shows; before anything is
 * signed, the draft shows only once the chat has drafted it (a plan card in this chat's thread), so Mei never meets a
 * finished plan before the founder has said what they sell. The live API answers a draft before the intake with 404, which is
 * "none" too. A failed signature check (not a 404) never hides a plan: the page then shows it without a sign button.
 * Until both answers are in, nothing is shown (never a plan that then turns into the empty state).
 */
export function planShown(i: { readonly current: Found; readonly draft: Found; readonly threadDraft: Exclude<Found, "failed"> }): "loading" | "none" | "plan" {
  if (i.current === "found" || i.current === "failed") return "plan";
  // The chat drafted it: the plan shows while the signature check still runs ("Checking your signature…", no button).
  if (i.threadDraft === "found" && i.draft !== "missing") return "plan";
  if (i.current === "loading" || i.threadDraft === "loading") return "loading";
  return "none";
}

/** True when the draft on the page is exactly the plan that was signed (same plan hash) and its signature is on record. */
export function isSignedDraft(draft: Pick<PlanDraft, "manifest">, committed: Pick<PlanRecord, "planHash" | "txHash"> | undefined): boolean {
  return committed !== undefined && committed.txHash !== null && planHash(draft.manifest) === committed.planHash;
}

/** What the plan on the page is: the signature check is still loading, a draft, the signed plan, or a preview. */
export type SignState =
  | { readonly kind: "checking" }
  | { readonly kind: "draft"; readonly lastSigned?: PlanRecord }
  | { readonly kind: "signed"; readonly record: PlanRecord }
  | { readonly kind: "preview"; readonly lastSigned?: PlanRecord }
  | { readonly kind: "unknown" };

/**
 * The page's state from the draft and the current-plan query. A 404 means nothing is signed yet; any other failure is
 * "unknown", so the page never offers to sign (or claims a signature) on a guess. A draft that differs from the signed
 * plan is a new draft to sign; the signed one stays on record as `lastSigned`.
 */
export function signStateOf(
  draft: Pick<PlanDraft, "manifest">,
  current: { readonly isPending: boolean; readonly data?: PlanRecord; readonly error?: { readonly status: number } | null },
  preview: boolean,
): SignState {
  const lastSigned = current.data?.txHash ? current.data : undefined;
  if (preview) return lastSigned ? { kind: "preview", lastSigned } : { kind: "preview" };
  if (current.isPending) return { kind: "checking" };
  if (current.data) {
    if (isSignedDraft(draft, current.data)) return { kind: "signed", record: current.data };
    return lastSigned ? { kind: "draft", lastSigned } : { kind: "draft" };
  }
  return current.error?.status === 404 ? { kind: "draft" } : { kind: "unknown" };
}
