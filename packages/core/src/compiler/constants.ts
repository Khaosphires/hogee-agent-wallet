/**
 * Every number the plan compiler uses (D6: amounts, caps, payees and the reserve come from code + the
 * country pack + these constants; the LLM only picks bounded options in PlanIntent).
 *
 * LINE SPLIT TABLE (weights in basis points of the budget; `lineEmphasis` picks the column, missing = med):
 *
 * | line          | low  | med  | high |
 * |---------------|------|------|------|
 * | SUPPLIER      | 4000 | 4500 | 5000 |
 * | PACKAGING     | 1000 | 1500 | 2000 |
 * | LOGISTICS     |  600 |  800 | 1000 |
 * | ADS           |  800 | 1200 | 1600 |
 * | PLATFORM_FEES |  500 |  500 |  500 |   (not discretionary: emphasis ignored)
 * | LICENSING     |    - |    - |    - |   (sized from the pack's product-approval fee, never by emphasis)
 * | CONTINGENCY   | 1000 | 1500 | 2000 |
 *
 * All-med sums to 10,000 (the baseline), and so does Rina's {SUPPLIER: high, CONTINGENCY: low}, which gives
 * exactly the §26.2 lines. Other mixes are normalised: each non-contingency line gets
 * floor(budget × w / Σw) rounded DOWN to whole BU, and CONTINGENCY takes the remainder, so lines always sum to
 * the budget exactly. A LICENSING line (when an approval fee applies) is carved out of CONTINGENCY.
 */
import type { CountryCode, EntityType, LineEmphasis, LineKey, ProductApproval } from "../schemas/enums";
import { MAX_HORIZON_SECONDS, PER_TX_CAP_MAX_BPS, STAGE1_MAX_BPS, WINDOW_CAP_MAX_BPS } from "../constitution/check";

export const COMPILER_VERSION = "1.0.0";

/** Lines in manifest order (= LINE_KEYS order). LICENSING appears only when an approval fee applies. */
export const LINE_ORDER = ["SUPPLIER", "PACKAGING", "LOGISTICS", "ADS", "PLATFORM_FEES", "LICENSING", "CONTINGENCY"] as const satisfies readonly LineKey[];

export type SplitLine = Exclude<LineKey, "LICENSING">;
export const LINE_SPLIT_WEIGHTS_BPS: { readonly [K in SplitLine]: { readonly [E in LineEmphasis]: number } } = {
  SUPPLIER: { low: 4000, med: 4500, high: 5000 },
  PACKAGING: { low: 1000, med: 1500, high: 2000 },
  LOGISTICS: { low: 600, med: 800, high: 1000 },
  ADS: { low: 800, med: 1200, high: 1600 },
  PLATFORM_FEES: { low: 500, med: 500, high: 500 },
  CONTINGENCY: { low: 1000, med: 1500, high: 2000 },
};
/** Emphasis assumed for a line the intent does not mention. */
export const DEFAULT_EMPHASIS: LineEmphasis = "med";
/** The line that absorbs split rounding and funds the LICENSING line. */
export const REMAINDER_LINE: SplitLine = "CONTINGENCY";
/** Line amounts are whole budget units (100 minor); rounding goes to CONTINGENCY. */
export const LINE_GRANULARITY_MINOR = 100n;
/** Smallest budget the compiler accepts (100 BU): below it the ads line cannot be paced. */
export const MIN_BUDGET_MINOR = 10_000n;

/** Caps are set AT the constitution maxima and rounded DOWN: perTx = 25%, window = 50% of the line. */
export const PER_TX_CAP_BPS = PER_TX_CAP_MAX_BPS;
export const WINDOW_CAP_BPS = WINDOW_CAP_MAX_BPS;
/** Rolling-window length for every line: 7 days. */
export const WINDOW_SECONDS = 604_800n;

/** Stage 1 (released at commitPlan) = 40% of the total, rounded down; stage 2 = the rest. */
export const STAGE1_RELEASE_BPS = STAGE1_MAX_BPS;
/** Stage 2 gate: sales ≥ 20% of the total by half the horizon (Rina: 200,000 by day 30). */
export const STAGE2_SALES_TARGET_BPS = 2_000n;
export const STAGE2_DEADLINE_HORIZON_DIVISOR = 2n;
export const STAGE_IDS = ["stage-1", "stage-2"] as const;

/**
 * ADS pacing. A pacing spend is one slot per day, so a 7-day rolling window can hold 7 slots, plus 1 more
 * when the loop's tick jitter puts two slots 23h59m apart at the window edge. Pacing is therefore sized for
 * 8 slots: standard = floor(windowCap / 8), so pacing × windowSeconds / 86,400 ≤ windowCap always holds with a
 * slot to spare (Rina: 60,000 / 8 = 7,500/day). Conservative = half of standard. Also ≤ perTxCap.
 */
export const PACING_PERIOD_SECONDS = 86_400n;
export const PACING_JITTER_SLOTS = 1n;
export const CONSERVATIVE_PACING_DIVISOR = 2n;

/** Agent key lifetime: the horizon, but later than the judging window by this margin, and ≤ now + 90 days. */
export const AGENT_EXPIRY_MARGIN_SECONDS = 86_400n;
export const MAX_AGENT_LIFETIME_SECONDS = MAX_HORIZON_SECONDS;

/**
 * Reserve policy (LABELING §3.7 proposal, [DECIDE] pending P1). The plan uses
 * max(this, countryPack.reserveFloorBps, facility.reserveFloorBps).
 */
export const RESERVE_POLICY_BPS: {
  readonly [C in CountryCode]: { readonly default: number; readonly byEntity: Readonly<Partial<Record<EntityType, number>>> };
} = {
  MY: { default: 500, byEntity: {} },
  ID: { default: 500, byEntity: { perorangan: 50, pt_perorangan: 50 } },
  // SG-CORE: no SG LABELING yet; mirrors MY's 5% set-aside so Mei's plan matches Rina's (SG-DECISIONS) [DECIDE P1].
  SG: { default: 500, byEntity: {} },
};

export function reservePolicyBps(country: CountryCode, entity: EntityType): number {
  const policy = RESERVE_POLICY_BPS[country];
  return policy.byEntity[entity] ?? policy.default;
}

/** LABELING §3.1: foreigners cannot use a sole proprietorship / perorangan (SG-DECISIONS: SG → pte_ltd). */
export const FOREIGNER_ENTITY: { readonly [C in CountryCode]: EntityType } = { MY: "sdn_bhd", ID: "pt", SG: "pte_ltd" };

/**
 * LABELING §3.6 [DECIDE]: one approval per plan; when two apply, the first in this order wins.
 * The compiler takes the pack's agency for the category (one value), so this order only breaks ties.
 */
export const PRODUCT_APPROVAL_PRIORITY: readonly Exclude<ProductApproval, "NONE">[] = [
  "NPRA",
  "BPOM",
  "ST_SIRIM",
  "KKM_FOOD",
  "BPJPH_HALAL",
  "JAKIM_HALAL",
  // SG-CORE: appended (a pack names one agency per category, so the order only breaks ties; MY/ID ranks unchanged).
  "HSA",
  "CPSO_SAFETY_MARK",
  "SFA",
];

/**
 * LABELING §3.4: ID e-Faktur is for PKP-registered businesses only, so it follows indirect-tax registration (and its
 * threshold); MY MyInvois has its own turnover threshold (`eInvoicing.threshold`). SG-CORE: SG InvoiceNow follows GST
 * registration like e-Faktur follows PKP, and SG has no turnover-based e-invoicing rule, so an SG pack carries no
 * `eInvoicing` (CountryPack refuses one) and the compile needs the GST threshold instead.
 */
export const E_INVOICING_FOLLOWS_INDIRECT_TAX: { readonly [C in CountryCode]: boolean } = { MY: false, ID: true, SG: true };

/**
 * Names in rule text only (every fact in the rule still comes from the pack): the indirect-tax registration, the import
 * tax on CIF + duty, and the e-invoicing scheme. MY and ID read exactly as before SG was added.
 */
export const INDIRECT_TAX_NAME: { readonly [C in CountryCode]: string } = { MY: "SST", ID: "PKP", SG: "GST" };
export const IMPORT_TAX_NAME: { readonly [C in CountryCode]: string } = { MY: "Import sales tax", ID: "Import sales tax", SG: "Import GST" };
export const E_INVOICING_SCHEME: { readonly [C in CountryCode]: string } = { MY: "MyInvois", ID: "e-Faktur", SG: "InvoiceNow" };

/** Approval fees are per product; the intent has no product count, so 1 (LABELING §3.8 default). */
export const DEFAULT_PRODUCT_COUNT = 1n;

/**
 * LABELING §3.8 [DECIDE]: the MY sole-proprietorship fee is the business-name fee (RM60), not the own-name fee
 * (RM30), because marketplace shops need one. The pack's SSM_SOLE_PROP registration cost must carry it.
 */
export const SOLE_PROP_FEE_BASIS = "business_name" as const;

/** LABELING §3.5 [DECIDE]: ASEAN origins (ATIGA Form D not in the enum) compile as MFN. */
export const ASEAN_ORIGIN_DUTY_ROUTE = "MFN" as const;

/** LABELING §3.1 [DECIDE]: ID citizens with partners label `cv`; the compiler keeps the intent's entity. */
export const ID_PARTNERSHIP_ENTITY: EntityType = "cv";

/** The deterministic baseline: the intent with every LLM-chosen emphasis removed and standard pacing. */
export const BASELINE_ADS_PACING = "standard" as const;
export const BASELINE_AIGC_MODEL = "none:rules-baseline";

export const LINE_PURPOSES: { readonly [K in LineKey]: string } = {
  SUPPLIER: "Goods from the chosen supplier (escrow milestones only)",
  PACKAGING: "Custom printed packaging",
  LOGISTICS: "Inbound freight and last-mile delivery",
  ADS: "Marketplace ads, paced daily",
  PLATFORM_FEES: "Marketplace platform and transaction fees",
  LICENSING: "Mandatory product approval fees",
  CONTINGENCY: "Unplanned costs (owner-approved payees only)",
};
export const ADS_PURPOSE_OWN_SITE = "Online ads for the shop website, paced daily";
