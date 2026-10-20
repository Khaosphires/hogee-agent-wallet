/**
 * Plan compiler (project.md §4 stage 2, D6): PlanIntent (the LLM's bounded choices) + country pack + facility
 * → PlanDraft {manifest, deterministic baseline, diff, blastRadiusMinor, constitutionReport}.
 *
 * Every amount, cap, payee, stage and the reserve come from code (this folder), the country pack and the
 * facility's payee registry. The intent contributes only: country, residency, entity, category, channel,
 * origin, the budget ceiling (capped by the facility), the horizon, line emphasis and ads pacing mode.
 * Pure and deterministic: same input → same draft, byte for byte (no clock, no randomness).
 */
import { CountryPack, type CountryPack as CountryPackT } from "../schemas/country-pack";
import type { CountryCode } from "../schemas/enums";
import { PlanDraft, PlanIntent, type PlanManifest, type PlanRule } from "../schemas/plan";
import { SCHEMA_VERSION, ZERO_HEX32, type Address, type CurrencyCode, type Hex32, type Id, type UnixSeconds } from "../schemas/primitives";
import { LandedCost } from "../schemas/supplier";
import { formatBu, minBig, parseMinor } from "../money/index";
import { hashObject } from "../hash/index";
import { checkConstitution, constitutionViolations } from "../constitution/check";
import { hasCommittedPlan } from "../constitution/replan";
import type { CommittedPlan, ConstitutionFacility } from "../constitution/types";
import { blastRadius } from "./blast-radius";
import { deriveCompliance, sourceOf, type ComplianceProfile } from "./compliance";
import { BASELINE_ADS_PACING, BASELINE_AIGC_MODEL, COMPILER_VERSION, MIN_BUDGET_MINOR, PACING_JITTER_SLOTS, WINDOW_SECONDS } from "./constants";
import { jsonDiff } from "./diff";
import { CompileError } from "./errors";
import { agentExpiry, buildLines, buildStages, licensingLineMinor, splitBudget } from "./lines";
import { replanForm, type ManifestBase } from "./replan-form";
import { RuleIds } from "./rule-ids";

const DAY = 86_400n;

export interface CompileFacility extends ConstitutionFacility {
  readonly facilityId: Id;
  readonly countryCode: CountryCode;
  readonly currency: CurrencyCode;
}

export interface CompileIds {
  readonly draftId: Id;
  readonly planId: Hex32;
  /** The agent session key this plan authorises. */
  readonly agentAddress: Address;
  /** Default 1, or the committed version + 1 for a replan. */
  readonly version?: number;
  /** Default ZERO_HEX32 (version 1), or the committed planHash for a replan. */
  readonly prevPlanHash?: Hex32;
}

export interface CompileInput {
  /** The only LLM output (validated here). */
  readonly intent: PlanIntent;
  readonly countryPack: CountryPackT;
  readonly facility: CompileFacility;
  /** Landed cost of the selected quote, if one is chosen (adds rules; never changes amounts). */
  readonly landedCost?: LandedCost;
  /** Commit time, unix seconds. */
  readonly now: UnixSeconds | bigint;
  readonly ids: CompileIds;
  /** AI-generated-content label (NFRA 二十一): planner model + prompt hash. */
  readonly aigc: { readonly model: string; readonly promptHash: Hex32 };
  /**
   * Replan (G0-AUDIT v-1): the plan on-chain that this draft replaces, with its runtime values and, per line, its
   * current payees as the chain counts them (listed, or bound to the line by a signed approval since). The draft is
   * numbered as the next CAS step (same planId, version + 1, prevPlanHash = its planHash), compiled in the
   * tighten-only form (replan-form.ts: the on-chain state plus only what the new intent changes) and its report
   * includes code 14 against it. A draft whose only failure is REPLAN_LOOSENS (the intent asks to loosen) is
   * returned, not thrown: the founder cannot sign it alone, so route it with routeReplan into lender-co-signed
   * LOOSEN_* exceptions.
   */
  readonly current?: CommittedPlan;
  /**
   * Replan only: the intent `current` was compiled from (the committed plan's draft). The difference between it and
   * `intent`, both compiled now, is what the replan changes. Absent or unusable: `intent` counts as unchanged.
   */
  readonly currentIntent?: PlanIntent;
}

interface Ctx {
  readonly pack: CountryPackT;
  readonly packHash: Hex32;
  readonly input: CompileInput;
  readonly now: bigint;
  /** A replan: the on-chain plan and the prior intent compiled now (replan-form.ts). */
  readonly replan?: { readonly current: CommittedPlan; readonly prior: ManifestBase };
}

function isoDate(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);
}

function planRules(m: Omit<PlanManifest, "rules">, profile: ComplianceProfile, ctx: Ctx, askedBudget: bigint): PlanRule[] {
  const rules: PlanRule[] = [];
  const total = parseMinor(m.totalMinor);
  if (askedBudget > total) {
    rules.push({ ruleId: RuleIds.budgetCapped, text: `Budget capped at the facility limit of ${formatBu(total)} (asked for ${formatBu(askedBudget)}).`, sourceRef: "compiler:budget-cap" });
  }
  const ads = m.lines.find((l) => l.lineKey === "ADS");
  if (ads?.pacing) {
    const slots = WINDOW_SECONDS / DAY + PACING_JITTER_SLOTS;
    rules.push({
      ruleId: RuleIds.adsPacing,
      text: `Ads paced at ${formatBu(ads.pacing.amountMinor)}/day: ${slots} daily slots fit the ${formatBu(ads.windowCapMinor)} cap of each 7-day window, one slot spare for timing.`,
      sourceRef: "compiler:ads-pacing",
    });
  }
  const [s1, s2] = m.stages;
  if (s1 && s2?.gate) {
    rules.push({
      ruleId: RuleIds.stageGate,
      text: `Stage 1 releases ${formatBu(s1.releaseMinor)} at signing; stage 2 (${formatBu(s2.releaseMinor)}) needs sales of ${formatBu(s2.gate.target)} by ${isoDate(BigInt(s2.gate.deadline))} and the loan officer's signature.`,
      sourceRef: "compiler:stage-gate",
    });
  }
  const licensing = m.lines.find((l) => l.lineKey === "LICENSING");
  if (licensing) {
    rules.push({ ruleId: RuleIds.licensingLine, text: `LICENSING line of ${formatBu(licensing.amountMinor)} covers the ${profile.productApproval} fee, taken from contingency.`, sourceRef: "compiler:licensing-line" });
  }
  const lc = ctx.input.landedCost;
  if (lc) {
    rules.push({
      ruleId: RuleIds.landedCost,
      text: `Landed cost of the selected quote: CIF ${formatBu(lc.cifMinor)} + duty ${formatBu(lc.dutyMinor)} + import tax ${formatBu(lc.sstMinor)} + fees ${formatBu(lc.feesMinor)} = ${formatBu(lc.totalMinor)} (FX ${lc.fx.value}).`,
      sourceRef: "compiler:landed-cost",
      source: sourceOf(lc.fx),
    });
    const supplier = m.lines.find((l) => l.lineKey === "SUPPLIER");
    if (supplier && parseMinor(lc.cifMinor) > parseMinor(supplier.amountMinor)) {
      rules.push({ ruleId: RuleIds.landedCostShort, text: `The quote's CIF ${formatBu(lc.cifMinor)} exceeds the SUPPLIER line ${formatBu(supplier.amountMinor)}: order less or replan.`, sourceRef: "compiler:landed-cost" });
    }
  }
  rules.push(
    { ruleId: RuleIds.constitutionCaps, text: "Every line: at most 25% per payment and 50% per 7-day window.", sourceRef: "constitution:PER_TX_CAP_OVER_25PCT" },
    { ruleId: RuleIds.constitutionEscrow, text: "The supplier is paid only through escrow milestones; the balance needs your signature and inspection evidence.", sourceRef: "constitution:SUPPLIER_LINE_NOT_ESCROW" },
    { ruleId: RuleIds.constitutionStage1, text: "At most 40% of the budget is released before the stage gate.", sourceRef: "constitution:STAGE1_OVER_40PCT" },
    { ruleId: RuleIds.constitutionPayees, text: "The plan adds no payees: only registered platform accounts and suppliers you approve can be paid.", sourceRef: "constitution:PLAN_ADDS_PAYEE" },
  );
  return rules;
}

interface Base {
  readonly base: ManifestBase;
  readonly profile: ComplianceProfile;
  readonly asked: bigint;
}

/** The manifest of `intent` compiled at ctx.now from the pack, the facility and its registry (no rules yet). */
function buildBase(intent: PlanIntent, aigc: CompileInput["aigc"], ctx: Ctx): Base {
  const { facility, ids } = ctx.input;
  const asked = parseMinor(intent.budgetCeilingMinor, "budgetCeilingMinor");
  const total = minBig(asked, parseMinor(facility.capMinor, "facility capMinor"));
  if (total < MIN_BUDGET_MINOR) throw new CompileError("BUDGET_TOO_SMALL", `budget ${formatBu(total)} is below the minimum ${formatBu(MIN_BUDGET_MINOR)}`);
  const profile = deriveCompliance(intent, ctx.pack, facility.reserveFloorBps);
  const amounts = splitBudget(total, intent.lineEmphasis, licensingLineMinor(profile.approvalFeeMinor));
  const validUntil = ctx.now + BigInt(intent.horizonDays) * DAY;
  const base: ManifestBase = {
    schemaVersion: SCHEMA_VERSION,
    planId: ids.planId,
    version: ids.version ?? 1,
    prevPlanHash: ids.prevPlanHash ?? ZERO_HEX32,
    facilityId: facility.facilityId,
    countryCode: intent.countryCode,
    countryPackVersion: ctx.pack.version,
    countryPackHash: ctx.packHash,
    displayCurrency: facility.currency,
    totalMinor: total.toString(),
    reserveBps: profile.reserveBps,
    agent: { address: ids.agentAddress, expiresAt: agentExpiry(ctx.now, intent.horizonDays, parseMinor(facility.judgingWindowEnd)).toString() },
    stages: buildStages(total, ctx.now, intent.horizonDays),
    lines: buildLines({ amounts, intent, registry: facility.payees, validUntil }),
    aigc: { model: aigc.model, promptHash: aigc.promptHash },
    compilerVersion: COMPILER_VERSION,
  };
  return { base, profile, asked };
}

function replanRule(current: CommittedPlan): PlanRule {
  return {
    ruleId: RuleIds.replan,
    text: `Replan of version ${current.version}: pocket amounts, caps, pacing, expiries, the stage gate, the reserve and the payees stay as they are on-chain unless this intent changes them; a change that loosens them needs the loan officer's co-signature.`,
    sourceRef: "compiler:replan",
  };
}

function buildManifest(intent: PlanIntent, aigc: CompileInput["aigc"], ctx: Ctx): PlanManifest {
  const { base: fresh, profile, asked } = buildBase(intent, aigc, ctx);
  const r = ctx.replan;
  const base = r ? replanForm(fresh, r.prior, r.current, { now: ctx.now, judgingWindowEnd: parseMinor(ctx.input.facility.judgingWindowEnd) }) : fresh;
  return { ...base, rules: [...profile.rules, ...planRules(base, profile, ctx, asked), ...(r ? [replanRule(r.current)] : [])] };
}

/**
 * The prior intent compiled now (the replan's reference). Unknown, invalid, for another country or no longer
 * compilable: the new intent itself, so nothing counts as changed.
 */
function priorBase(intent: PlanIntent, ctx: Ctx): ManifestBase {
  const prior = ctx.input.currentIntent === undefined ? null : PlanIntent.safeParse(ctx.input.currentIntent);
  if (prior?.success && prior.data.countryCode === intent.countryCode) {
    try {
      return buildBase(prior.data, ctx.input.aigc, ctx).base;
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
    }
  }
  return buildBase(intent, ctx.input.aigc, ctx).base;
}

function validateInputs(input: CompileInput): { intent: PlanIntent; pack: CountryPackT; now: bigint } {
  const intent = PlanIntent.safeParse(input.intent);
  if (!intent.success) throw new CompileError("INVALID_INPUT", `intent: ${intent.error.message}`);
  const pack = CountryPack.safeParse(input.countryPack);
  if (!pack.success) throw new CompileError("INVALID_INPUT", `country pack: ${pack.error.message}`);
  if (input.landedCost && !LandedCost.safeParse(input.landedCost).success) throw new CompileError("INVALID_INPUT", "landedCost is malformed");
  const { facility } = input;
  if (!Number.isInteger(facility.reserveFloorBps) || facility.reserveFloorBps < 0 || facility.reserveFloorBps > 10_000) {
    throw new CompileError("INVALID_INPUT", "facility reserveFloorBps must be an integer 0..10000");
  }
  if (intent.data.countryCode !== pack.data.countryCode || facility.countryCode !== pack.data.countryCode) {
    throw new CompileError("COUNTRY_MISMATCH", `intent ${intent.data.countryCode}, facility ${facility.countryCode}, pack ${pack.data.countryCode}`);
  }
  if (facility.currency !== pack.data.currency) throw new CompileError("CURRENCY_MISMATCH", `facility ${facility.currency}, pack ${pack.data.currency}`);
  const now = typeof input.now === "bigint" ? input.now : parseMinor(input.now, "now");
  return { intent: intent.data, pack: pack.data, now };
}

/**
 * A replan's ids: the next CAS step after `current` (StalePlan → INVALID_INPUT). Without `current` the draft is a
 * first plan (version 1, prevPlanHash 0): a later version needs the plan it replaces, or code 14 could not be checked.
 */
function sequencedIds(ids: CompileIds, current: CommittedPlan | undefined): CompileIds {
  if (!hasCommittedPlan(current)) {
    const first = (ids.version === undefined || ids.version === 1) && (ids.prevPlanHash === undefined || ids.prevPlanHash === ZERO_HEX32);
    if (!first) throw new CompileError("INVALID_INPUT", "a replan (version > 1 or a prevPlanHash) needs `current`, the committed plan it replaces");
    return ids;
  }
  const version = current.version + 1;
  const stale =
    ids.planId !== current.planId ||
    (ids.version !== undefined && ids.version !== version) ||
    (ids.prevPlanHash !== undefined && ids.prevPlanHash !== current.planHash);
  if (stale) throw new CompileError("INVALID_INPUT", `StalePlan: a replan must be version ${version} of plan ${current.planId} with prevPlanHash ${current.planHash}`);
  return { ...ids, version, prevPlanHash: current.planHash };
}

/** Compile an intent into a signed-plan draft (see module doc). Throws CompileError. */
export function compilePlan(raw: CompileInput): PlanDraft {
  const { intent, pack, now } = validateInputs(raw);
  const input: CompileInput = { ...raw, ids: sequencedIds(raw.ids, raw.current) };
  const plain: Ctx = { pack, packHash: hashObject(pack), input, now };
  const ctx: Ctx = hasCommittedPlan(input.current) ? { ...plain, replan: { current: input.current, prior: priorBase(intent, plain) } } : plain;
  const manifest = buildManifest(intent, input.aigc, ctx);
  const baseline = buildManifest({ ...intent, lineEmphasis: {}, adsPacing: BASELINE_ADS_PACING }, { model: BASELINE_AIGC_MODEL, promptHash: ZERO_HEX32 }, ctx);
  const report = checkConstitution(manifest, input.facility, now, input.current ?? null);
  const baselineReport = checkConstitution(baseline, input.facility, now);
  // REPLAN_LOOSENS alone does not throw: the draft is valid, only not signable by the founder alone (routeReplan).
  const violations = [...new Set([...constitutionViolations(report), ...constitutionViolations(baselineReport)])];
  if (violations.some((c) => c !== "REPLAN_LOOSENS")) {
    throw new CompileError("COMPILE_FAILED", `compiled plan violates the constitution: ${violations.join(", ")}`, violations);
  }
  const draft = {
    draftId: input.ids.draftId,
    intent,
    manifest,
    baseline,
    diff: jsonDiff(baseline, manifest, ["/aigc"]),
    blastRadiusMinor: blastRadius(manifest, input.facility.payees, now).totalMinor,
    constitutionReport: report,
  };
  const parsed = PlanDraft.safeParse(draft);
  if (!parsed.success) throw new CompileError("COMPILE_FAILED", `draft failed the frozen schema: ${parsed.error.message}`);
  return parsed.data;
}

/** planHash = keccak256(utf8(JCS(manifest))) (PlanApproval.planHash). */
export function planHash(manifest: PlanManifest): Hex32 {
  return hashObject(manifest);
}
