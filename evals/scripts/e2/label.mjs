// E2 labeller: the 8 fields a careful human derives from a prompt's facts (stated, or its hidden slot's true value),
// LABELING.md §3 and the country pack JSON. Written from those two sources only. It never imports @hogee/core or calls
// the compiler: E2 measures the compiler and the planner, so the labels must not come from either
// (compiler-check.ts runs the compiler separately and reports where the two disagree).
// Fails closed: a fact the pack does not carry, or a situation LABELING leaves out, throws instead of guessing.
import { leaf, PACKS, REGISTRATION_ORDER } from './world.mjs';

/** LABELING §3.5 D5: ATIGA (Form D) is not in the enum, so prompts never buy from another ASEAN country. */
const ASEAN = new Set(['BN', 'KH', 'ID', 'LA', 'MY', 'MM', 'PH', 'SG', 'TH', 'VN']);

/** LABELING §3.7 D7 and P1 Q2: the reserve policy before the pack floor. */
const RESERVE_POLICY_BPS = { MY: 500, SG: 500 };

/**
 * LABELING §3.6, MY column, for categories the MY pack has no leaf for. Only `NONE` rows can be labelled without a
 * pack leaf (no fee). NPRA, ST_SIRIM and KKM_FOOD need a fee the pack lacks, so those categories are not labelled.
 */
const MY_TABLE_APPROVAL = { apparel: 'NONE', other: 'NONE' };

/** The pack's registration record for `code`, or a PACK_FACT_MISSING error. */
function registration(pack, code) {
  const found = pack.registrations.find((r) => r.code === code);
  if (!found) throw new Error(`PACK_FACT_MISSING:registrations.${code}`);
  return found;
}

/** LABELING §3.1. SG: the preferred type must list the founder's residency in the pack's `entities[].eligibility`. */
export function entityType(country, t) {
  if (country === 'MY') {
    if (t.residency === 'foreigner' || t.limitedLiability) return 'sdn_bhd';
    return t.partner ? 'partnership' : 'sole_prop';
  }
  if (country === 'SG') {
    const preferred = t.limitedLiability ? 'pte_ltd' : t.partner ? 'sg_partnership' : 'sg_sole_prop';
    const eligible = (type) => {
      const entity = PACKS.SG.entities.find((e) => e.type === type);
      if (!entity) throw new Error(`PACK_FACT_MISSING:entities.${type}`);
      return leaf(entity.eligibility, `entities.${type}.eligibility`).includes(t.residency);
    };
    if (eligible(preferred)) return preferred;
    if (eligible('pte_ltd')) return 'pte_ltd';
    throw new Error(`no SG entity in the pack admits residency ${t.residency}`);
  }
  throw new Error(`no E2 entity rule for ${country}`);
}

/** LABELING §3.3. Launch scale (§2.1): no stated first-year turnover means below every threshold. */
function indirectTaxRegistered(country, t) {
  if (t.expectedTurnoverMinor === undefined) return false;
  const threshold = BigInt(leaf(PACKS[country].indirectTax?.registrationThreshold, 'indirectTax.registrationThreshold'));
  const turnover = BigInt(t.expectedTurnoverMinor);
  if (country === 'MY') return Boolean(t.manufactures) && turnover > threshold; // a reseller of imported goods: false
  if (country === 'SG') return turnover > threshold; // GST: taxable turnover above SGD 1M
  throw new Error(`no indirect-tax rule for ${country}`);
}

/** LABELING §3.4. SG: InvoiceNow follows GST registration (SG-DESIGN §3); the SG pack has no eInvoicing section. */
function eInvoicing(country, t, gstRegistered) {
  if (country === 'SG') return gstRegistered;
  if (country !== 'MY') throw new Error(`no e-invoicing rule for ${country}`);
  if (t.expectedTurnoverMinor === undefined) return false;
  return BigInt(t.expectedTurnoverMinor) >= BigInt(leaf(PACKS.MY.eInvoicing?.threshold, 'eInvoicing.threshold'));
}

/** LABELING §3.5. Form E only where the pack lists a CN certificate; SG lists none, so CN goods into SG are MFN. */
export function dutyRoute(country, t) {
  if (t.buyFrom === country) return 'EXEMPT';
  if (ASEAN.has(t.buyFrom)) throw new Error(`LABELING D5: ${country} prompts never buy from ASEAN (${t.buyFrom})`);
  if (t.buyFrom !== 'CN') return 'MFN';
  const formE = PACKS[country].imports.ftaCertificates.find((c) => c.route === 'FORM_E' && c.partnerCountry === 'CN');
  if (!formE) return 'MFN';
  // The MY pack models the Form E rate for the demo tumbler line only (my-pack decision 2), so it says nothing about
  // whether ACFTA covers other goods: those prompts would need a fact the pack lacks.
  if (country === 'MY' && t.productCategory !== 'drinkware_food_contact') throw new Error(`MY pack does not model ACFTA cover for ${t.productCategory}`);
  leaf(formE.dutyRateBps, 'imports.ftaCertificates.FORM_E.dutyRateBps');
  return 'FORM_E';
}

/** LABELING §3.6: `{agency, costMinor}` for one product of the prompt's category. */
export function productApproval(country, t) {
  const node = PACKS[country].productApprovals?.[t.productCategory];
  if (node) {
    const agency = leaf(node.agency, `productApprovals.${t.productCategory}.agency`);
    const costMinor = leaf(node.cost, `productApprovals.${t.productCategory}.cost`);
    // SG approvals bind the importer (SFA registration, HSA notification, CPSO registered supplier); the pack says
    // nothing about a reseller who buys locally, so such prompts are not labelled.
    if (country === 'SG' && t.buyFrom === 'SG' && agency !== 'NONE') throw new Error(`SG domestic purchase of ${t.productCategory} has no pack rule`);
    return { agency, costMinor };
  }
  if (country === 'MY' && MY_TABLE_APPROVAL[t.productCategory]) return { agency: MY_TABLE_APPROVAL[t.productCategory], costMinor: '0' };
  throw new Error(`PACK_FACT_MISSING:productApprovals.${t.productCategory}`);
}

/** LABELING §3.2: the registration set, in frozen enum order. */
function registrations(country, entity, gst, eInv) {
  if (country === 'MY') {
    const codes = [entity === 'sdn_bhd' ? 'SSM_SDN_BHD' : 'SSM_SOLE_PROP', 'LHDN_TIN'];
    if (gst) codes.push('SST');
    if (eInv) codes.push('MYINVOIS');
    return codes; // PBT_LICENCE: every prompt sells online only (§2.2)
  }
  const codes = [entity === 'pte_ltd' ? 'ACRA_PTE_LTD' : 'ACRA_BUSINESS'];
  if (gst) codes.push('IRAS_GST');
  return codes;
}

/**
 * A registration's first-year fee for `entity`. The fee leaf must be scoped to the entity, with one documented
 * exception: MY.json scopes `LHDN_TIN` (cost 0) to individuals (my-pack decision 3), but LABELING §3.2 requires the TIN
 * for every MY entity and LHDN states no fee for a company's TIN either, so a Sdn Bhd's TIN also counts 0.
 */
function registrationFee(country, code, entity) {
  const record = registration(PACKS[country], code);
  const scoped = record.entityTypes.length === 0 || record.entityTypes.includes(entity);
  if (!scoped && !(country === 'MY' && code === 'LHDN_TIN')) throw new Error(`PACK_FACT_MISSING:registrations.${code}[${entity}].cost`);
  return BigInt(leaf(record.cost, `registrations.${code}.cost`));
}

/** LABELING §3.8: first-year government fees of the labelled registrations and approval, from pack leaves only. */
function licenceCostMinor(country, entity, codes, approval, productCount) {
  const registrationFees = codes.reduce((sum, code) => sum + registrationFee(country, code, entity), 0n);
  return String(registrationFees + BigInt(approval.costMinor) * BigInt(productCount));
}

/** The 8 E2 fields for a prompt's ground truth `t` in `country`. */
export function labelFields(country, t) {
  if (!PACKS[country]) throw new Error(`no pack for ${country}`);
  if (!Number.isInteger(t.productCount) || t.productCount < 1) throw new Error('productCount must be a positive integer');
  const entity = entityType(country, t);
  const gst = indirectTaxRegistered(country, t);
  const eInv = eInvoicing(country, t, gst);
  const approval = productApproval(country, t);
  const codes = registrations(country, entity, gst, eInv).sort((a, b) => REGISTRATION_ORDER.indexOf(a) - REGISTRATION_ORDER.indexOf(b));
  const floor = leaf(PACKS[country].reserveFloorBps, 'reserveFloorBps');
  return {
    entityType: entity,
    registrations: codes,
    indirectTaxRegistered: gst,
    eInvoicing: eInv,
    dutyRoute: dutyRoute(country, t),
    productApproval: approval.agency,
    reserveBps: Math.max(floor, RESERVE_POLICY_BPS[country]),
    licenceCostMinor: licenceCostMinor(country, entity, codes, approval, t.productCount),
  };
}
