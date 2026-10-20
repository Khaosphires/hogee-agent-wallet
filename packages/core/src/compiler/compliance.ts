/**
 * Compliance profile of a plan, derived from the intent + the country pack exactly as
 * evals/datasets/e2/LABELING.md describes, plus the plan rules that carry it (see rule-ids.ts).
 *
 * Inputs the intent cannot express are fixed by LABELING's shared assumptions (§2): launch scale (turnover below
 * every registration threshold), online only (no physical premises → never PBT_LICENCE), one product, no halal
 * request. Registrations are a precondition of the facility (paid before funding), so their fees appear as
 * rules, not lines; a product-approval fee gets a LICENSING line.
 *
 * Every fact the profile needs comes from the pack: each required registration's fee, the thresholds launch scale is
 * compared with, the category's product approval, the duty route and, for imported goods, the import tax rate. A
 * missing one is never counted as 0, "launch scale" or "no approval": the compile fails closed with
 * PackFactMissingError naming every missing leaf (pack-facts/index.ts).
 */
import type { CountryPack, CountryPackRegistration } from "../schemas/country-pack";
import {
  ENTITY_TYPES_BY_COUNTRY,
  type CountryCode,
  type DutyRoute,
  type EntityType,
  type ProductApproval,
  type Registration,
} from "../schemas/enums";
import type { PlanIntent, PlanRule } from "../schemas/plan";
import type { SourceMeta, Sourced } from "../schemas/primitives";
import { maxBig, parseMinor } from "../money/index";
import { dutyRouteOf, formECertificate } from "../landed-cost/index";
import { PackLeaf, packFactMissingMessage } from "../pack-facts/index";
import {
  DEFAULT_PRODUCT_COUNT,
  E_INVOICING_FOLLOWS_INDIRECT_TAX,
  E_INVOICING_SCHEME,
  FOREIGNER_ENTITY,
  IMPORT_TAX_NAME,
  INDIRECT_TAX_NAME,
  PRODUCT_APPROVAL_PRIORITY,
  reservePolicyBps,
} from "./constants";
import { CompileError, PackFactMissingError } from "./errors";
import { RULE_ID_MAX_LENGTH, RuleIds } from "./rule-ids";

export interface RegistrationItem {
  readonly code: Registration;
  readonly feeMinor: bigint;
}

export interface ComplianceProfile {
  readonly entityType: EntityType;
  /** The intent's entity when the compiler had to replace it, else null. */
  readonly entityOverriddenFrom: EntityType | null;
  readonly registrations: readonly RegistrationItem[];
  readonly indirectTaxRegistered: boolean;
  readonly eInvoicing: boolean;
  readonly dutyRoute: DutyRoute;
  readonly productApproval: ProductApproval;
  readonly approvalFeeMinor: bigint;
  readonly reserveBps: number;
  readonly licenceCostMinor: bigint;
  readonly rules: readonly PlanRule[];
}

const ENTITY_LABEL: { readonly [E in EntityType]: string } = {
  sole_prop: "sole proprietorship",
  partnership: "partnership",
  sdn_bhd: "Sdn Bhd (private limited company)",
  perorangan: "perorangan (individual business)",
  pt_perorangan: "PT Perorangan (one-person company)",
  cv: "CV (limited partnership)",
  pt: "PT (limited company)",
  sg_sole_prop: "sole proprietorship",
  sg_partnership: "partnership",
  pte_ltd: "Pte Ltd (private limited company)",
};

const REGISTRATION_LABEL: { readonly [R in Registration]: string } = {
  SSM_SOLE_PROP: "SSM business registration",
  SSM_SDN_BHD: "SSM incorporation",
  LHDN_TIN: "LHDN tax identification number",
  SST: "SST registration",
  MYINVOIS: "MyInvois e-invoicing",
  PBT_LICENCE: "local council premises licence",
  NIB_OSS: "NIB business number (OSS)",
  NPWP_NIK: "NPWP tax number (NIK)",
  PKP: "PKP VAT registration",
  ACRA_BUSINESS: "ACRA business registration",
  ACRA_PTE_LTD: "ACRA incorporation",
  IRAS_GST: "IRAS GST registration",
};

/** Provenance of a Sourced leaf without its value (PlanRule.source). */
export function sourceOf(leaf: Sourced<unknown>): SourceMeta {
  const { value: _value, ...meta } = leaf;
  return meta;
}

/** "MYR 3,000,000.00" from minor units of the pack currency. */
export function money(minor: bigint, currency: string): string {
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${whole}.${(minor % 100n).toString().padStart(2, "0")}`;
}

/** "5.00%" from basis points. */
export function pct(bps: number | bigint): string {
  const b = BigInt(bps);
  return `${(b / 100n).toString()}.${(b % 100n).toString().padStart(2, "0")}%`;
}

function rule(ruleId: string, text: string, sourceRef: string, source?: SourceMeta): PlanRule {
  if (ruleId.length > RULE_ID_MAX_LENGTH) throw new CompileError("FEE_TOO_LARGE", `rule id too long: ${ruleId}`);
  return source ? { ruleId, text, sourceRef, source } : { ruleId, text, sourceRef };
}

function resolveEntity(intent: PlanIntent, pack: CountryPack): { entity: EntityType; from: EntityType | null; rules: PlanRule[] } {
  const country = intent.countryCode;
  const entries = pack.entities ?? [];
  const eligible = (t: EntityType): boolean => {
    const e = entries.find((x) => x.type === t);
    if (e) return e.eligibility.value.includes(intent.residency);
    return intent.residency !== "foreigner" || t === FOREIGNER_ENTITY[country];
  };
  let entity = intent.entityType;
  if (!eligible(entity)) {
    const preferred = intent.residency === "foreigner" ? FOREIGNER_ENTITY[country] : undefined;
    const pick = [preferred, ...ENTITY_TYPES_BY_COUNTRY[country]].find((t): t is EntityType => t !== undefined && eligible(t));
    if (!pick) throw new CompileError("ENTITY_INELIGIBLE", `no ${country} entity type is open to a ${intent.residency}`);
    entity = pick;
  }
  const i = entries.findIndex((x) => x.type === entity);
  const entry = entries[i];
  const ref = entry ? `/entities/${i}/eligibility` : "compiler:entity";
  const rules = [rule(RuleIds.entity(entity), `Business type: ${ENTITY_LABEL[entity]}.`, ref, entry ? sourceOf(entry.eligibility) : undefined)];
  if (entity !== intent.entityType) {
    rules.push(
      rule(
        RuleIds.entityOverride,
        `The drafted ${ENTITY_LABEL[intent.entityType]} is not open to a ${intent.residency}; compiled as ${ENTITY_LABEL[entity]}.`,
        ref,
        entry ? sourceOf(entry.eligibility) : undefined,
      ),
    );
  }
  return { entity, from: entity === intent.entityType ? null : intent.entityType, rules };
}

/** A country the compiler has no rule for: refuse (never fall through to another country's rules). */
function unsupportedCountry(country: never): never {
  throw new CompileError("INVALID_INPUT", `no compliance rules for country ${String(country)}`);
}

/**
 * Registrations the founder pays before funding. SG mirrors MY: ACRA business-name registration (or incorporation for a
 * pte_ltd) always, GST only when registered, which launch scale is not (taxRules cites the pack's GST threshold). The
 * UEN ACRA assigns is the tax reference, so SG has no separate tax-id registration; InvoiceNow is not a registration.
 */
function requiredRegistrations(intent: PlanIntent, entity: EntityType, indirectTax: boolean, eInvoicing: boolean): Registration[] {
  const country = intent.countryCode;
  switch (country) {
    case "MY": {
      const codes: Registration[] = [entity === "sdn_bhd" ? "SSM_SDN_BHD" : "SSM_SOLE_PROP", "LHDN_TIN"];
      if (indirectTax) codes.push("SST");
      if (eInvoicing) codes.push("MYINVOIS");
      return codes;
    }
    case "ID": {
      const codes: Registration[] = ["NIB_OSS"];
      if (intent.residency === "citizen") codes.push("NPWP_NIK");
      if (indirectTax) codes.push("PKP");
      return codes;
    }
    case "SG": {
      const codes: Registration[] = [entity === "pte_ltd" ? "ACRA_PTE_LTD" : "ACRA_BUSINESS"];
      if (indirectTax) codes.push("IRAS_GST");
      return codes;
    }
    default:
      return unsupportedCountry(country);
  }
}

/** The leaf a missing registration needs: entity-scoped when the pack lists the code for other entity types only. */
function registrationLeaf(code: Registration, entity: EntityType, regs: readonly CountryPackRegistration[]): string {
  return PackLeaf.registrationCost(code, regs.some((r) => r.code === code) ? entity : undefined);
}

function registrationRules(
  codes: readonly Registration[],
  entity: EntityType,
  pack: CountryPack,
): { items: RegistrationItem[]; rules: PlanRule[]; missing: string[] } {
  const regs = pack.registrations ?? [];
  const items: RegistrationItem[] = [];
  const rules: PlanRule[] = [];
  const missing: string[] = [];
  for (const code of codes) {
    const i = regs.findIndex((r) => r.code === code && (r.entityTypes.length === 0 || r.entityTypes.includes(entity)));
    const reg = regs[i];
    if (!reg) {
      missing.push(registrationLeaf(code, entity, regs));
      continue;
    }
    const fee = parseMinor(reg.cost.value, `registration ${code} cost`);
    items.push({ code, feeMinor: fee });
    const text = `Register: ${REGISTRATION_LABEL[code]}, government fee ${money(fee, pack.currency)}; paid by the founder before funding.`;
    rules.push(rule(RuleIds.registration(code, fee), text, `/registrations/${i}/cost`, sourceOf(reg.cost)));
  }
  return { items, rules, missing };
}

/**
 * "Not registered at launch" compares launch-scale turnover with the pack's thresholds (LABELING §2.1, §3.3, §3.4).
 * E-invoicing: MY has its own turnover threshold; ID (e-Faktur) and SG (InvoiceNow) follow indirect-tax registration, so
 * for them the indirect-tax threshold is the one leaf (an SG pack carries no eInvoicing section at all).
 */
function taxRules(pack: CountryPack): { rules: PlanRule[]; missing: string[] } {
  const rules: PlanRule[] = [];
  const missing: string[] = [];
  const country: CountryCode = pack.countryCode;
  const tax = INDIRECT_TAX_NAME[country];
  const threshold = pack.indirectTax?.registrationThreshold;
  if (threshold) {
    rules.push(
      rule(
        RuleIds.indirectTax(false),
        `No ${tax} registration at launch: a reseller below ${money(parseMinor(threshold.value), pack.currency)} turnover.`,
        "/indirectTax/registrationThreshold",
        sourceOf(threshold),
      ),
    );
  } else {
    missing.push(PackLeaf.indirectTaxThreshold);
  }
  const einv = pack.eInvoicing?.threshold;
  if (einv) {
    rules.push(
      rule(
        RuleIds.eInvoicing(false),
        `E-invoicing not required below ${money(parseMinor(einv.value), pack.currency)} turnover.`,
        "/eInvoicing/threshold",
        sourceOf(einv),
      ),
    );
  } else if (!E_INVOICING_FOLLOWS_INDIRECT_TAX[country]) {
    missing.push(PackLeaf.eInvoicingThreshold);
  } else if (threshold) {
    const text = `E-invoicing (${E_INVOICING_SCHEME[country]}) not required: it is for ${tax}-registered businesses, and there is no ${tax} registration at launch.`;
    rules.push(rule(RuleIds.eInvoicing(false), text, "/indirectTax/registrationThreshold", sourceOf(threshold)));
  }
  return { rules, missing };
}

/** The MFN duty rule: cites the pack's per-category MFN rate when it carries one (SG), else the tariff source. */
function mfnRule(intent: PlanIntent, pack: CountryPack): PlanRule {
  const category = intent.productCategory;
  const mfn = pack.imports?.mfnDutyRateBps?.[category];
  if (mfn) {
    return rule(RuleIds.duty("MFN"), `Import from ${intent.buyFrom} at the MFN tariff rate: duty ${pct(mfn.value)} for ${category}.`, `/imports/mfnDutyRateBps/${category}`, sourceOf(mfn));
  }
  const src = pack.imports?.dutySources[0];
  const text = `Import from ${intent.buyFrom} at the MFN tariff rate (no FTA route modelled).`;
  return src ? rule(RuleIds.duty("MFN"), text, "/imports/dutySources/0", sourceOf(src)) : rule(RuleIds.duty("MFN"), text, "compiler:mfn");
}

/** Duty route rule, plus the import tax rule for imported goods. `route` is null when the pack cannot decide it. */
function dutyRules(intent: PlanIntent, pack: CountryPack): { route: DutyRoute | null; rules: PlanRule[]; missing: string[] } {
  const of = dutyRouteOf(intent.buyFrom, pack);
  const route = "route" in of ? of.route : null;
  const missing: string[] = "missing" in of ? [of.missing] : [];
  const rules: PlanRule[] = [];
  if (route === "EXEMPT") {
    rules.push(rule(RuleIds.duty(route), "Domestic supplier: no import duty or import tax.", "compiler:domestic-supplier"));
    return { route, rules, missing };
  }
  if (route === "FORM_E") {
    const certs = pack.imports?.ftaCertificates ?? [];
    const i = certs.findIndex((c) => c === formECertificate(pack, intent.buyFrom));
    const cert = certs[i];
    // The route is FORM_E only when the pack lists this certificate, so the else branch is unreachable.
    if (cert) {
      rules.push(rule(RuleIds.duty(route), `Import from ${intent.buyFrom} under Form E (ACFTA): duty ${pct(cert.dutyRateBps.value)}.`, `/imports/ftaCertificates/${i}/dutyRateBps`, sourceOf(cert.dutyRateBps)));
    } else {
      missing.push(PackLeaf.ftaCertificates);
    }
  } else if (route === "MFN") {
    rules.push(mfnRule(intent, pack));
  }
  // Imported goods (any route but EXEMPT, decided or not) pay import sales tax / VAT / GST at the pack's rate. EXEMPT is
  // the domestic route only: a duty-free import (SG) is MFN at a 0 rate and still pays import GST.
  const rate = pack.indirectTax?.rate;
  if (rate) rules.push(rule(RuleIds.importTax, `${IMPORT_TAX_NAME[pack.countryCode]} ${pct(rate.value)} on CIF + duty.`, "/indirectTax/rate", sourceOf(rate)));
  else missing.push(PackLeaf.indirectTaxRate);
  return { route, rules, missing };
}

/**
 * LABELING §3.6: the pack's agency for the category; ties broken by PRODUCT_APPROVAL_PRIORITY. "NONE" only when every
 * candidate is "NONE": an agency missing from the priority list is refused, never read as "no approval needed".
 */
export function pickProductApproval(candidates: readonly ProductApproval[]): ProductApproval {
  const unranked = candidates.filter((c) => c !== "NONE" && !(PRODUCT_APPROVAL_PRIORITY as readonly ProductApproval[]).includes(c));
  if (unranked.length > 0) throw new CompileError("INVALID_INPUT", `product approval ${unranked.join(", ")} has no priority rank`);
  const ranked = PRODUCT_APPROVAL_PRIORITY.find((p) => candidates.includes(p));
  return ranked ?? "NONE";
}

/** `approval` is null when the pack has no entry for the category (never read as "no approval needed"). */
function approvalRules(intent: PlanIntent, pack: CountryPack): { approval: ProductApproval | null; fee: bigint; rules: PlanRule[]; missing: string[] } {
  const entry = pack.productApprovals?.[intent.productCategory];
  if (!entry) return { approval: null, fee: 0n, rules: [], missing: [PackLeaf.productApproval(intent.productCategory)] };
  const approval = pickProductApproval([entry.agency.value]);
  const fee = approval !== "NONE" ? parseMinor(entry.cost.value, "approval cost") * DEFAULT_PRODUCT_COUNT : 0n;
  const ref = `/productApprovals/${intent.productCategory}/${approval === "NONE" ? "agency" : "cost"}`;
  const src = sourceOf(approval === "NONE" ? entry.agency : entry.cost);
  const text = approval === "NONE" ? `No product approval needed for ${intent.productCategory}.` : `Product approval: ${approval}, fee ${money(fee, pack.currency)} for 1 product.`;
  return { approval, fee, rules: [rule(RuleIds.approval(approval, fee), text, ref, src)], missing: [] };
}

function reserveRule(intent: PlanIntent, entity: EntityType, pack: CountryPack, facilityFloorBps: number): { bps: number; rule: PlanRule } {
  const policy = reservePolicyBps(intent.countryCode, entity);
  const bps = Number(maxBig(BigInt(policy), BigInt(pack.reserveFloorBps.value), BigInt(facilityFloorBps)));
  const text = `Sales reserve ${pct(bps)} of each sale (tax set-aside policy ${pct(policy)}; pack floor ${pct(pack.reserveFloorBps.value)}; facility floor ${pct(facilityFloorBps)}).`;
  return { bps, rule: rule(RuleIds.reserve, text, "/reserveFloorBps", sourceOf(pack.reserveFloorBps)) };
}

function marketplaceRules(intent: PlanIntent, pack: CountryPack): PlanRule[] {
  const markets = pack.marketplaces ?? [];
  const i = markets.findIndex((m) => m.channel === intent.sellChannel);
  const market = markets[i];
  if (!market || market.fees.length === 0) return [];
  const text = `${intent.sellChannel} fees: ${market.fees.map((f) => `${f.name} ${pct(f.rateBps.value)}`).join(", ")}.`;
  return [rule(RuleIds.marketplace(intent.sellChannel), text.slice(0, 500), `/marketplaces/${i}/fees/0/rateBps`, sourceOf(market.fees[0]!.rateBps))];
}

/**
 * The compliance profile and its rules (LABELING.md, field by field). Throws PackFactMissingError (COMPILE_FAILED)
 * listing every pack leaf the intent needs and the pack lacks.
 */
export function deriveCompliance(intent: PlanIntent, pack: CountryPack, facilityReserveFloorBps: number): ComplianceProfile {
  const entity = resolveEntity(intent, pack);
  // LABELING §2.1 launch scale: below every registration threshold, so neither applies at launch (taxRules cites them).
  const indirectTaxRegistered = false;
  const eInvoicing = false;
  const regs = registrationRules(requiredRegistrations(intent, entity.entity, indirectTaxRegistered, eInvoicing), entity.entity, pack);
  const tax = taxRules(pack);
  const duty = dutyRules(intent, pack);
  const approval = approvalRules(intent, pack);
  const missing = [...regs.missing, ...tax.missing, ...duty.missing, ...approval.missing];
  if (missing.length > 0 || duty.route === null || approval.approval === null) {
    const context = `${entity.entity}, ${intent.productCategory}, buying from ${intent.buyFrom}`;
    throw new PackFactMissingError(missing, packFactMissingMessage(missing, pack, context));
  }
  const reserve = reserveRule(intent, entity.entity, pack, facilityReserveFloorBps);
  const licence = regs.items.reduce((s, r) => s + r.feeMinor, 0n) + approval.fee;
  return {
    entityType: entity.entity,
    entityOverriddenFrom: entity.from,
    registrations: regs.items,
    indirectTaxRegistered,
    eInvoicing,
    dutyRoute: duty.route,
    productApproval: approval.approval,
    approvalFeeMinor: approval.fee,
    reserveBps: reserve.bps,
    licenceCostMinor: licence,
    rules: [...entity.rules, ...regs.rules, ...tax.rules, ...duty.rules, ...approval.rules, reserve.rule, ...marketplaceRules(intent, pack)],
  };
}
