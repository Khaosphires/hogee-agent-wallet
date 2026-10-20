/**
 * Supplier shortlist (§11): hard gates → weighted score (frozen §11 weights) → evidence coverage (bps) →
 * rank stability (Dirichlet(α = weights) draws, seeded, integer-only) → RankedSupplier[] + Shortlist.
 * Deterministic: same input and seed → same shortlist and shortlistHash. No LLM output enters here; the
 * listing text is only scanned for flags.
 *
 * shortlistHash = hashObject({requestId, weightsVersion, candidates, excluded}) — what the founder chose from.
 * rankStabilityPct and status are display fields and are not hashed.
 */
import { SUPPLIER_CRITERIA, SUPPLIER_CRITERION_WEIGHTS, type ProductCategory, type SupplierCriterion } from "../schemas/enums";
import type { Hex32, Id } from "../schemas/primitives";
import type { RankedSupplier, RedFlag, Shortlist, ShortlistSpec } from "../schemas/supplier";
import { hashObject, keccak256Utf8, payoutAccountHash } from "../hash/index";
import { minBig, parseMinor } from "../money/index";
import { redFlagsFromText } from "../taint/imperative";
import {
  evaluateGates,
  evidenceCoverageBps,
  failedRegistryChecks,
  scoreCriteria,
  type CriterionResult,
  type GateResult,
  type RegistryIdKind,
  type ScorerCandidate,
} from "./criteria";
import { dirichletDraw, mulberry32 } from "./prng";

export const WEIGHTS_VERSION = "w1";
export const RANK_STABILITY_DRAWS = 1000;

const LABEL: { readonly [K in SupplierCriterion]: string } = {
  landed_cost: "landed cost",
  quality_evidence: "quality evidence",
  trust_verification: "trust and verification",
  lead_time: "lead time",
  compliance: "compliance",
  terms: "terms",
  communication: "communication",
};
const W = SUPPLIER_CRITERION_WEIGHTS;

interface Scored {
  readonly c: ScorerCandidate;
  readonly criteria: readonly CriterionResult[];
  readonly gates: readonly GateResult[];
  /** Σ weight × scoreBps (weights sum to 100, so totalBps / 100 = score in bps). */
  readonly weighted: number;
}

const pts = (bps: number): number => bps / 100;
const fmt = (bps: number): string => (bps / 100).toFixed(2).replace(/\.00$/, "");

function byRank(a: Scored, b: Scored): number {
  if (b.weighted !== a.weighted) return b.weighted - a.weighted;
  const la = parseMinor(a.c.landedCost.totalMinor);
  const lb = parseMinor(b.c.landedCost.totalMinor);
  if (la !== lb) return la < lb ? -1 : 1;
  return a.c.supplier.supplierId < b.c.supplier.supplierId ? -1 : 1;
}

/** Share of Dirichlet weight draws in which the current #1 stays #1 (integer %). */
export function rankStability(ranked: readonly Scored[], seed: number, draws = RANK_STABILITY_DRAWS): number {
  if (ranked.length < 2) return 100;
  const next = mulberry32(seed);
  const alphas = SUPPLIER_CRITERIA.map((k) => W[k]);
  let holds = 0;
  for (let d = 0; d < draws; d += 1) {
    const w = dirichletDraw(alphas, next);
    const totals = ranked.map((s) => s.criteria.reduce((sum, cr, i) => sum + (w[i] ?? 0) * cr.scoreBps, 0));
    const best = Math.max(...totals);
    if (totals.indexOf(best) === 0) holds += 1;
  }
  return Math.floor((holds * 100) / draws);
}

function gap(a: Scored, b: Scored, k: SupplierCriterion): number {
  const i = SUPPLIER_CRITERIA.indexOf(k);
  return (a.criteria[i]?.scoreBps ?? 0) - (b.criteria[i]?.scoreBps ?? 0);
}

function whyNotNext(me: Scored, next: Scored | undefined): string | null {
  if (!next) return null;
  const k = [...SUPPLIER_CRITERIA].sort((x, y) => gap(me, next, y) * W[y] - gap(me, next, x) * W[x])[0] ?? "landed_cost";
  const i = SUPPLIER_CRITERIA.indexOf(k);
  return `${next.c.supplier.displayName} scores ${fmt((me.weighted - next.weighted) / 100)} points lower; biggest gap: ${LABEL[k]} (${fmt(me.criteria[i]?.scoreBps ?? 0)} vs ${fmt(next.criteria[i]?.scoreBps ?? 0)}).`;
}

/** The smallest single-criterion improvement that would lift `challenger` above `leader`. */
function whatWouldChange(challenger: Scored, leader: Scored, verb: string): string {
  const deficit = leader.weighted - challenger.weighted; // in weight × bps
  const options = SUPPLIER_CRITERIA.map((k, i) => {
    const needBps = Math.floor(deficit / W[k]) + 1;
    const room = 10_000 - (challenger.criteria[i]?.scoreBps ?? 0);
    return { k, needBps, feasible: needBps <= room };
  }).filter((o) => o.feasible);
  const best = options.sort((a, b) => a.needBps - b.needBps)[0];
  if (!best) return `No single score change moves ${challenger.c.supplier.displayName} ${verb}; only new gate results or evidence would.`;
  return `${challenger.c.supplier.displayName} would move ${verb} if its ${LABEL[best.k]} score rose by ${fmt(best.needBps)} points.`;
}

function notes(s: Scored, pick: (bps: number) => boolean, word: string): RankedSupplier["pros"] {
  return s.criteria
    .filter((cr) => pick(cr.scoreBps))
    .sort((a, b) => W[b.criterion] * b.scoreBps - W[a.criterion] * a.scoreBps)
    .slice(0, 2)
    .map((cr) => ({ text: `${word} ${LABEL[cr.criterion]}: ${fmt(cr.scoreBps)}/100`, evidenceIds: cr.evidenceIds }));
}

const REGISTRY_ID_LABEL: { readonly [K in RegistryIdKind]: string } = { uscc: "USCC", ssm: "SSM number", uen: "UEN", lei: "LEI" };

/**
 * Red flags, in order: imperative listing text, failed registry checks, unverified (tier 3) quality or compliance
 * evidence. A failed registry check (packages/checks validateUSCC / validateSSM / validateUEN, bound to this supplier
 * and the exact id) is shown, not only scored as zero registry trust (SG-DESIGN §3, P1 22:55). The text never repeats
 * the id: it is supplier-written listing data.
 */
function redFlags(c: ScorerCandidate): RedFlag[] {
  const sid = c.supplier.supplierId;
  const fromText = redFlagsFromText(c.listingText, `listing:${sid}`);
  const registry = failedRegistryChecks(c).map((kind) => ({
    text: `Registry check failed: the listed ${REGISTRY_ID_LABEL[kind]} is not valid (format or checksum), so it earns no registry trust`,
    source: `registry:${kind}:${sid}`,
  }));
  const unverified = c.evidence
    .filter((e) => e.tier === "tier3" && (e.criterion === "quality_evidence" || e.criterion === "compliance"))
    .map((e) => ({ text: `Unverified evidence ${e.evidenceId} (tier 3): earns no score`, source: e.sourceUrl }));
  return [...fromText, ...registry, ...unverified];
}

function toRanked(s: Scored, rank: number, ranked: readonly Scored[]): RankedSupplier {
  const prev = ranked[rank - 2];
  const next = ranked[rank];
  const sup = s.c.supplier;
  return {
    supplierId: sup.supplierId,
    displayName: sup.displayName,
    rank,
    score: pts(Math.floor(s.weighted / 100)),
    criteria: s.criteria.map((cr) => ({ criterion: cr.criterion, weight: W[cr.criterion], score: pts(cr.scoreBps), evidenceIds: cr.evidenceIds })),
    landedCost: s.c.landedCost,
    payoutAccountHash: payoutAccountHash(sup.xenditTest),
    evidenceCoverageBps: evidenceCoverageBps(s.c, W),
    gates: s.gates.map((g) => ({ gate: g.gate, passed: g.passed, evidenceIds: g.evidenceIds })),
    redFlags: redFlags(s.c),
    pros: notes(s, (b) => b >= 8000, "Strong"),
    cons: notes(s, (b) => b < 5000, "Weak"),
    whyNotNext: whyNotNext(s, next),
    whatWouldChange: prev
      ? whatWouldChange(s, prev, `above ${prev.c.supplier.displayName}`)
      : next
        ? whatWouldChange(next, s, "to #1")
        : "No other supplier passed the hard gates.",
  };
}

export interface ShortlistInput {
  readonly requestId: Id;
  readonly spec: ShortlistSpec;
  readonly candidates: readonly ScorerCandidate[];
  /** PRNG seed for rank stability; default = first 4 bytes of keccak256(requestId). */
  readonly seed?: number;
  readonly draws?: number;
}

export function defaultSeed(requestId: string): number {
  return Number.parseInt(keccak256Utf8(requestId).slice(2, 10), 16);
}

export function shortlistHashOf(s: Pick<Shortlist, "requestId" | "weightsVersion" | "candidates" | "excluded">): Hex32 {
  return hashObject({ requestId: s.requestId, weightsVersion: s.weightsVersion, candidates: s.candidates, excluded: s.excluded });
}

/** Gates → scores → ranking → stability → Shortlist (status READY). */
export function buildShortlist(input: ShortlistInput): Shortlist {
  const category: ProductCategory = input.spec.productCategory;
  const gated = input.candidates.map((c) => ({ c, gates: evaluateGates(c, category, input.spec.quantity, input.spec.budgetMinor) }));
  const passing = gated.filter((g) => g.gates.every((x) => x.passed));
  const excluded = gated
    .filter((g) => !g.gates.every((x) => x.passed))
    .map((g) => ({ supplierId: g.c.supplier.supplierId, gate: g.gates.find((x) => !x.passed)!.gate }))
    .sort((a, b) => (a.supplierId < b.supplierId ? -1 : 1));
  const cheapest = passing.length > 0 ? minBig(...passing.map((g) => parseMinor(g.c.landedCost.totalMinor))) : 0n;
  const scored: Scored[] = passing.map(({ c, gates }) => {
    const criteria = scoreCriteria(c, category, cheapest);
    return { c, gates, criteria, weighted: criteria.reduce((s, cr) => s + W[cr.criterion] * cr.scoreBps, 0) };
  });
  const ranked = [...scored].sort(byRank);
  const candidates = ranked.map((s, i) => toRanked(s, i + 1, ranked));
  const base = { requestId: input.requestId, weightsVersion: WEIGHTS_VERSION, candidates, excluded };
  return {
    ...base,
    status: "READY",
    rankStabilityPct: rankStability(ranked, input.seed ?? defaultSeed(input.requestId), input.draws),
    shortlistHash: shortlistHashOf(base),
    failureReason: null,
  };
}
