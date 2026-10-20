/**
 * Mock SupplierEvidence rows for the demo catalog (core SupplierFile `{supplier, evidence[]}`; docs/decisions/w2-core.md).
 * Each row is one sentence of the supplier's raw listing text: `value` is that sentence and `snippetHash` is core's
 * snippetHash of it, so a reader can find and re-hash it. Every row is demo data: sourceType "mock", an example.invalid
 * source URL on the listing, taint untrusted/public (supplier-written text). Tiers are SIMULATED like the record's
 * (P1, 18 Oct): a fact shown on the listing page or a platform metric is tier2, a report is its certificate's tier, the
 * price is the fobUnit tier, and every fact of the sanctions-screening test row is tier3.
 * No trust_verification row: there is no registry lookup or customs record behind any demo supplier, so trust stays the
 * scorer's registry-check and platform-metric points and that criterion is never counted as covered.
 */
import { lineOf, snippetHash } from "./text.mjs";

const TAINT = { trust: "untrusted", sensitivity: "public" };

/** The criteria a certificate backs: a food-contact test report is quality and compliance evidence. */
function certCriteria(type) {
  if (/food contact/i.test(type)) return ["quality_evidence", "compliance"];
  if (/quality management/i.test(type)) return ["quality_evidence"];
  return ["compliance"];
}

/**
 * The evidence rows for one demo supplier, built from its listing `lines` (record.mjs offerLines) and its compact spec
 * `s` (priceTier, factTier, certificates). Ids are `ev-<supplierId>-<fact>`, unique across the catalog.
 */
export function demoEvidence(supplierId, url, lines, s) {
  const row = (fact, criterion, tier, lineKey, anchor) => {
    const sentence = lineOf(lines, lineKey);
    return {
      evidenceId: `ev-${supplierId}-${fact}`,
      supplierId,
      criterion,
      tier,
      sourceType: "mock",
      sourceUrl: `${url}#${anchor ?? lineKey}`,
      snippetHash: snippetHash(sentence),
      value: sentence,
      taint: TAINT,
    };
  };
  const factTier = s.factTier ?? "tier2";
  return [
    row("price", "landed_cost", s.priceTier, "price"),
    row("lead-time", "lead_time", factTier, "lead"),
    row("terms", "terms", factTier, "payment"),
    row("response-rate", "communication", factTier, "response-rate"),
    ...s.certificates.flatMap((c, i) =>
      certCriteria(c.type).map((criterion) =>
        row(`cert-${i + 1}-${criterion === "compliance" ? "compliance" : "quality"}`, criterion, c.tier, `cert-${i}`, `cert-${i + 1}`),
      ),
    ),
  ];
}

/** The listing sentence for the platform's response-rate metric (the communication evidence). */
export function responseRateLine(responseRate) {
  return { key: "response-rate", text: `Platform response rate (demo metric): ${Math.round(responseRate * 100)}%.` };
}
