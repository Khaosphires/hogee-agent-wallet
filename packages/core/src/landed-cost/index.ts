/**
 * Landed cost (project.md §11): CIF = FOB×qty + freight + insurance; duty by `dutyRoute` on the pack's tax
 * base; import sales tax on (CIF + duty); plus fees. Output = `RankedSupplier.landedCost`.
 *
 * Units and rounding (D16):
 * - Inputs from the offer are offer-currency minor units; outputs are facility (display) currency minor units.
 *   Both currencies use 2-decimal minor units (MYR sen, CNY fen; IDR × 100 per §26.8), so the FX rate applies
 *   to minor units directly.
 * - FX is a `Sourced<number>` rate (1 offer unit = `fx.value` display units). It is read EXACTLY as a rational
 *   from its shortest decimal form (0.61 → 61/100); no float arithmetic touches money.
 * - All intermediate maths is bigint. Rates are integer basis points. Each output component is rounded ONCE,
 *   half up, at the final minor unit, in this order (customs-style: later steps use the rounded earlier ones):
 *     cifMinor  = round(  (FOB×qty + freight×qty) × (1 + insuranceBps/10⁴) × fx )
 *     dutyBase  = cifMinor if taxBase = CIF, else round( FOB×qty × fx )
 *     dutyMinor = round( dutyBase × dutyRateBps / 10⁴ )
 *     sstMinor  = round( (cifMinor + dutyMinor) × importTaxRateBps / 10⁴ )
 *     feesMinor = Σ fees (already display minor units)
 *     totalMinor = cifMinor + dutyMinor + sstMinor + feesMinor   (exact; components always add up)
 * - Insurance is a percentage of FOB + freight (DEFAULT_INSURANCE_BPS when the quote has none). Incoterm handling
 *   is out of scope: fixtures quote FOB, so `fobUnit` is treated as an FOB price.
 * - `sstMinor` (frozen field name) is the import tax of the pack's country: MY sales tax, ID VAT, SG import GST.
 * - EXEMPT is the DOMESTIC route only (no duty, no import tax). A duty-free import (SG: customs duty on a short list of
 *   goods only) is MFN at a 0 rate, so it still pays import GST on CIF + duty.
 */
import type { DutyRoute, ProductCategory } from "../schemas/enums";
import type { CountryPack } from "../schemas/country-pack";
import type { Iso2, Minor, Sourced } from "../schemas/primitives";
import type { LandedCost } from "../schemas/supplier";
import { BPS_DENOMINATOR, mulDivHalfUp, parseMinor, rationalOf, sumBig, toMinor } from "../money/index";
import { PackLeaf, packFactMissingMessage } from "../pack-facts/index";

/** Assumed marine insurance when a quote has none: 0.5% of FOB + freight (labelled assumption). */
export const DEFAULT_INSURANCE_BPS = 50;
/** Upper bound for an ad valorem duty rate (1000%); import tax rates are bounded by 10,000 bps. */
export const MAX_DUTY_RATE_BPS = 100_000;
/** ACFTA partner whose goods route through Form E (LABELING §3.5). */
export const FORM_E_PARTNER: Iso2 = "CN";

/** INVALID_INPUT also covers a country pack that lacks a fact the route needs (message `PACK_FACT_MISSING:<leaf>...`). */
export class LandedCostError extends Error {
  override readonly name = "LandedCostError";
  constructor(
    readonly code: "INVALID_INPUT" | "MFN_RATE_REQUIRED",
    message: string,
  ) {
    super(message);
  }
}

export interface LandedCostFee {
  readonly name: string;
  /** Display-currency minor units. */
  readonly amountMinor: Minor;
}

export interface LandedCostInput {
  /** Units ordered (positive integer). */
  readonly quantity: number | bigint;
  /** FOB price per unit, offer-currency minor units. */
  readonly fobUnitMinor: Minor;
  /** Freight per unit, offer-currency minor units. */
  readonly freightPerUnitMinor: Minor;
  /** Insurance as bps of FOB + freight. Default DEFAULT_INSURANCE_BPS. */
  readonly insuranceBps?: number;
  /** Offer currency → display currency rate (central bank: BNM for MYR, MAS for SGD), with provenance. */
  readonly fx: Sourced<number>;
  readonly dutyRoute: DutyRoute;
  /** Ad valorem duty for the route (EXEMPT forces 0). */
  readonly dutyRateBps: number;
  /** Country pack imports.taxBase. */
  readonly dutyBase: "CIF" | "FOB";
  /** Import tax rate on CIF + duty (MY sales tax, ID VAT, SG GST). EXEMPT (domestic purchase) forces 0. */
  readonly importTaxRateBps: number;
  readonly fees?: readonly LandedCostFee[];
}

function intInRange(v: number, min: number, max: number, label: string): bigint {
  if (!Number.isInteger(v) || v < min || v > max) throw new LandedCostError("INVALID_INPUT", `${label} must be an integer in [${min}, ${max}]`);
  return BigInt(v);
}

function quantityOf(q: number | bigint): bigint {
  if (typeof q === "bigint") {
    if (q <= 0n) throw new LandedCostError("INVALID_INPUT", "quantity must be positive");
    return q;
  }
  if (!Number.isSafeInteger(q) || q <= 0) throw new LandedCostError("INVALID_INPUT", "quantity must be a positive integer");
  return BigInt(q);
}

/** §11 landed cost in display-currency minor units (see module doc for the exact rounding order). */
export function computeLandedCost(input: LandedCostInput): LandedCost {
  const qty = quantityOf(input.quantity);
  const goods = parseMinor(input.fobUnitMinor, "fobUnitMinor") * qty;
  const freight = parseMinor(input.freightPerUnitMinor, "freightPerUnitMinor") * qty;
  const insurance = intInRange(input.insuranceBps ?? DEFAULT_INSURANCE_BPS, 0, 10_000, "insuranceBps");
  const domestic = input.dutyRoute === "EXEMPT";
  const dutyRate = domestic ? 0n : intInRange(input.dutyRateBps, 0, MAX_DUTY_RATE_BPS, "dutyRateBps");
  const taxRate = domestic ? 0n : intInRange(input.importTaxRateBps, 0, 10_000, "importTaxRateBps");
  const fx = rationalOf(input.fx.value, "fx");

  const cif = mulDivHalfUp(goods + freight, (BPS_DENOMINATOR + insurance) * fx.num, BPS_DENOMINATOR * fx.den);
  const dutyBase = input.dutyBase === "CIF" ? cif : mulDivHalfUp(goods, fx.num, fx.den);
  const duty = mulDivHalfUp(dutyBase, dutyRate, BPS_DENOMINATOR);
  const sst = mulDivHalfUp(cif + duty, taxRate, BPS_DENOMINATOR);
  const fees = sumBig((input.fees ?? []).map((f) => parseMinor(f.amountMinor, `fee ${f.name}`)));

  return {
    cifMinor: toMinor(cif),
    dutyMinor: toMinor(duty),
    sstMinor: toMinor(sst),
    feesMinor: toMinor(fees),
    totalMinor: toMinor(cif + duty + sst + fees),
    fx: { ...input.fx },
  };
}

/** A duty route, or the pack leaf that would decide it (the pack does not carry it). */
export type DutyRouteOf = { readonly route: DutyRoute } | { readonly missing: string };

/**
 * Duty route for goods bought from `buyFrom` into the pack's country (LABELING §3.5): domestic → EXEMPT; CN → FORM_E
 * when the pack lists a CN Form E certificate, MFN when its certificate list has none; any other origin (ASEAN
 * included: ATIGA Form D is not in the enum) → MFN. CN with no imports section cannot be decided: `missing`.
 */
export function dutyRouteOf(buyFrom: string, pack: Pick<CountryPack, "countryCode" | "imports">): DutyRouteOf {
  if (buyFrom === pack.countryCode) return { route: "EXEMPT" };
  if (buyFrom !== FORM_E_PARTNER) return { route: "MFN" };
  if (!pack.imports) return { missing: PackLeaf.ftaCertificates };
  return { route: formECertificate(pack, buyFrom) ? "FORM_E" : "MFN" };
}

/** dutyRouteOf, failing closed (INVALID_INPUT, PACK_FACT_MISSING:imports.ftaCertificates) when the pack cannot decide. */
export function resolveDutyRoute(buyFrom: string, pack: Pick<CountryPack, "countryCode" | "version" | "imports">): DutyRoute {
  const of = dutyRouteOf(buyFrom, pack);
  if ("missing" in of) throw new LandedCostError("INVALID_INPUT", packFactMissingMessage([of.missing], pack, `goods from ${buyFrom}`));
  return of.route;
}

/** The pack's Form E certificate for `partner`, if listed. */
export function formECertificate(pack: Pick<CountryPack, "imports">, partner: string) {
  return pack.imports?.ftaCertificates.find((c) => c.route === "FORM_E" && c.partnerCountry === partner);
}

export interface PackLandedCostInput {
  readonly countryPack: CountryPack;
  /** Supplier country (ISO2). */
  readonly origin: string;
  readonly quantity: number | bigint;
  readonly fobUnitMinor: Minor;
  readonly freightPerUnitMinor: Minor;
  readonly fx: Sourced<number>;
  /**
   * The MFN duty rate (from the tariff finder in pack.imports.dutySources). When absent on an MFN route, the pack's
   * imports.mfnDutyRateBps.<productCategory> is used; with neither, MFN_RATE_REQUIRED (never 0).
   */
  readonly mfnDutyRateBps?: number;
  /** The goods' category: selects the pack's per-category MFN rate (SG). Optional; never changes a FORM_E/EXEMPT route. */
  readonly productCategory?: ProductCategory;
  readonly insuranceBps?: number;
  readonly fees?: readonly LandedCostFee[];
}

export interface PackLandedCost {
  /** Exactly the frozen `RankedSupplier.landedCost` shape. */
  readonly landedCost: LandedCost;
  readonly dutyRoute: DutyRoute;
  readonly dutyRateBps: number;
}

interface ImportFacts {
  readonly dutyBase: "CIF" | "FOB";
  readonly importTaxRateBps: number;
}

/** EXEMPT (domestic): computeLandedCost forces duty and import tax to 0, so neither value is read. */
const DOMESTIC_PURCHASE: ImportFacts = { dutyBase: "CIF", importTaxRateBps: 0 };

/** Duty base and import tax rate for an import route, from the pack only (fails closed, PACK_FACT_MISSING). */
function importFacts(pack: CountryPack, route: DutyRoute, origin: string): ImportFacts {
  if (route === "EXEMPT") return DOMESTIC_PURCHASE;
  const base = pack.imports?.taxBase;
  const rate = pack.indirectTax?.rate;
  if (!base || !rate) {
    const missing = [...(base ? [] : [PackLeaf.importsTaxBase]), ...(rate ? [] : [PackLeaf.indirectTaxRate])];
    throw new LandedCostError("INVALID_INPUT", packFactMissingMessage(missing, pack, `goods from ${origin}`));
  }
  return { dutyBase: base.value, importTaxRateBps: rate.value };
}

/**
 * MFN duty rate: the caller's (a tariff line it looked up), else the pack's sourced rate for the category, else
 * MFN_RATE_REQUIRED. With a category the error names the pack leaf that would decide it.
 */
function mfnDutyRate(input: PackLandedCostInput): number {
  if (input.mfnDutyRateBps !== undefined) return input.mfnDutyRateBps;
  const category = input.productCategory;
  if (category === undefined) throw new LandedCostError("MFN_RATE_REQUIRED", `no FTA route from ${input.origin}; pass the MFN duty rate`);
  const leaf = input.countryPack.imports?.mfnDutyRateBps?.[category];
  if (!leaf) {
    throw new LandedCostError("MFN_RATE_REQUIRED", packFactMissingMessage([PackLeaf.mfnDutyRate(category)], input.countryPack, `goods from ${input.origin}; or pass the MFN duty rate`));
  }
  return leaf.value;
}

/**
 * Landed cost with route, duty rate, tax base and import tax taken from the country pack. A fact the route needs and
 * the pack lacks (imports.ftaCertificates for CN, imports.taxBase, indirectTax.rate) is a LandedCostError
 * INVALID_INPUT whose message starts PACK_FACT_MISSING:<leaf>; it is never read as 0 or CIF. An MFN rate neither the
 * caller nor the pack (imports.mfnDutyRateBps.<category>) supplies is MFN_RATE_REQUIRED.
 */
export function landedCostFromPack(input: PackLandedCostInput): PackLandedCost {
  const pack = input.countryPack;
  const dutyRoute = resolveDutyRoute(input.origin, pack);
  const facts = importFacts(pack, dutyRoute, input.origin);
  let dutyRateBps = 0;
  if (dutyRoute === "FORM_E") {
    const cert = formECertificate(pack, input.origin);
    // Unreachable: the route is FORM_E only when the pack lists this certificate.
    if (!cert) throw new LandedCostError("INVALID_INPUT", packFactMissingMessage([PackLeaf.ftaCertificates], pack, `goods from ${input.origin}`));
    dutyRateBps = cert.dutyRateBps.value;
  }
  if (dutyRoute === "MFN") dutyRateBps = mfnDutyRate(input);
  const landedCost = computeLandedCost({
    quantity: input.quantity,
    fobUnitMinor: input.fobUnitMinor,
    freightPerUnitMinor: input.freightPerUnitMinor,
    fx: input.fx,
    dutyRoute,
    dutyRateBps,
    dutyBase: facts.dutyBase,
    importTaxRateBps: facts.importTaxRateBps,
    ...(input.insuranceBps !== undefined ? { insuranceBps: input.insuranceBps } : {}),
    ...(input.fees ? { fees: input.fees } : {}),
  });
  return { landedCost, dutyRoute, dutyRateBps };
}
