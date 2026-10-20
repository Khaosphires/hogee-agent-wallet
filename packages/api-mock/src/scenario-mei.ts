/**
 * Mei's scenario (SG, the main demo; SG-DECISIONS) for every file P3 has no fixtures/scenario-mei/<file> for: Rina's
 * loaded scenario (Rina's fixtures, else the core examples) re-issued for Mei. Mei mirrors Rina's numbers exactly in
 * minor units (core demo/mei.ts), so the status gallery, balances and schedules stay; what changes:
 *   - ids: each of Rina's ids (RINA_IDS, Rina's session, `founder:rina`, ids like `draft-rina-mock`) becomes Mei's,
 *     in values, in free text and in map keys (the escrow order);
 *   - facility SGD; plan SG with Mei's rules (country-rules.ts: the compiler's texts, incl. the SFA step), intent
 *     sg_sole_prop; MYR supplier offers quoted in SGD; a DuitNow payout account becomes PayNow;
 *   - landed costs carry SG import GST: 9% of CIF + duty (the MY rows carried 10% SST);
 *   - payouts read "Sample payout (PayNow)" (SG-DECISIONS rail: MockRail, never a real SG payout; "Sample" is the app's one word);
 *   - the chat history is Mei's scripted conversation (chat-script.ts).
 * mockHash / mockAddress values derived here are mock labels, as everywhere in the mock.
 */
import {
  MEI_FACILITY,
  MEI_IDS,
  MEI_PLAN_INTENT,
  MEI_SESSION_ID,
  RINA_IDS,
  RINA_SESSION_ID,
  hashObject,
  mulDivFloor,
  payoutAccountHash,
  type Facility,
  type Payment,
  type PlanDraft,
  type PlanIntent,
  type PlanManifest,
  type PlanRecord,
  type Session,
  type Shortlist,
  type SupplierWithEvidence,
  type TraceEvent,
} from "@hogee/core";
import { cannedTranscript } from "./chat-script";
import { COUNTRY_RULES, MEI_PLAN_RULES } from "./country-rules";
import { mockHash } from "./mock-hash";
import { PROFILES } from "./profile";
import type { Scenario } from "./seed";

const SG = PROFILES.SG;
/** SG import GST (SG-DECISIONS, GST Act s 18): 9% on CIF + duty, in basis points. */
const SG_IMPORT_GST_BPS = 900n;

/** Rina's id → Mei's, for every RINA_IDS field that differs (the shared supplier, deployment and stages stay). */
const ID_PAIRS: readonly (readonly [string, string])[] = [
  ...(Object.keys(RINA_IDS) as (keyof typeof RINA_IDS)[]).flatMap((k) => {
    const rina = RINA_IDS[k];
    const mei = MEI_IDS[k];
    return typeof rina === "string" && typeof mei === "string" && rina !== mei ? [[rina, mei] as const] : [];
  }),
  [RINA_SESSION_ID, MEI_SESSION_ID],
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ID_RES = ID_PAIRS.map(([rina, mei]) => [new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(rina)}(?![A-Za-z0-9_-])`, "g"), mei] as const);
/** An identifier-like value (`draft-rina-mock`, `founder:rina`): its `rina` token becomes `mei`. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RINA_TOKEN = /(^|[-:_.])rina(?=$|[-:_.])/g;
const MOCK_URL = /^https:\/\/example\.invalid\//;

function remapUrl(url: string): string {
  // Only Rina's identity rate (MYR-MYR, value 1) is renamed; any other MYR rate stays and fails the label check.
  return url.replace(/\/my\//g, "/sg/").replace(/\/rina\//g, "/mei/").replace(/MYR-MYR/g, "SGD-SGD");
}

function remapString(value: string): string {
  if (MOCK_URL.test(value)) return remapUrl(value);
  let out = value;
  for (const [re, mei] of ID_RES) out = out.replace(re, mei);
  return IDENT.test(out) ? out.replace(RINA_TOKEN, "$1mei") : out;
}

/** Deep copy with every id, key and mock URL moved to Mei's; a Sourced leaf whose URL moved gets that URL's mock hash. */
export function remapIds<T>(value: T): T {
  if (typeof value === "string") return remapString(value) as T;
  if (Array.isArray(value)) return value.map((v) => remapIds(v)) as T;
  if (value === null || typeof value !== "object" || value instanceof Blob) return value;
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [remapString(k), remapIds(v)] as const);
  const out = Object.fromEntries(entries) as Record<string, unknown>;
  const before = (value as Record<string, unknown>).sourceUrl;
  if (typeof before === "string" && typeof out.snippetHash === "string" && out.sourceUrl !== before) {
    out.snippetHash = mockHash(`snippet:${String(out.sourceUrl)}`);
  }
  return out as T;
}

export function meiFacility(f: Facility): Facility {
  return { ...remapIds(f), currency: MEI_FACILITY.currency, capMinor: MEI_FACILITY.capMinor, reserveFloorBps: MEI_FACILITY.reserveFloorBps };
}

export const meiSession = (s: Session): Session => ({ ...remapIds(s), persona: SG.founderPersona });

function meiIntent(intent: PlanIntent): PlanIntent {
  const entityAssumption = MEI_PLAN_INTENT.assumptions.find((a) => a.slot === "entityType");
  return {
    ...remapIds(intent),
    countryCode: "SG",
    entityType: COUNTRY_RULES.SG.entityType,
    assumptions: intent.assumptions.map((a) => (a.slot === "entityType" && entityAssumption ? { ...entityAssumption } : remapIds(a))),
  };
}

function meiManifest(m: PlanManifest): PlanManifest {
  return {
    ...remapIds(m),
    planId: mockHash(`planId:mei:${m.planId}`),
    countryCode: "SG",
    countryPackVersion: COUNTRY_RULES.SG.countryPackVersion,
    countryPackHash: mockHash("countryPack:SG"),
    displayCurrency: SG.currency,
    rules: [...MEI_PLAN_RULES],
  };
}

export function meiPlanDraft(d: PlanDraft): PlanDraft {
  return { ...remapIds(d), intent: meiIntent(d.intent), manifest: meiManifest(d.manifest), baseline: meiManifest(d.baseline) };
}

export function meiPlanRecord(r: PlanRecord): PlanRecord {
  const manifest = meiManifest(r.manifest);
  return { ...r, manifest, planHash: hashObject(manifest), txHash: r.txHash === null ? null : mockHash(`tx:commitPlan:mei:${r.txHash}`) };
}

export function meiSupplier(s: SupplierWithEvidence): SupplierWithEvidence {
  const out = remapIds(s);
  return {
    ...out,
    offer: { ...out.offer, currency: out.offer.currency === "MYR" ? SG.currency : out.offer.currency },
    xenditTest: { ...out.xenditTest, channel: out.xenditTest.channel === "MY_DUITNOW" ? "SG_PAYNOW" : out.xenditTest.channel },
  };
}

/** Landed cost with SG import GST, and a payout fingerprint that follows a payout account this file moved to PayNow. */
export function meiShortlist(sl: Shortlist, rinaSuppliers: readonly SupplierWithEvidence[]): Shortlist {
  const out = remapIds(sl);
  return {
    ...out,
    shortlistHash: out.shortlistHash === null ? null : mockHash(`shortlist:mei:${out.requestId}`),
    candidates: out.candidates.map((c) => {
      const lc = c.landedCost;
      const taxBase = BigInt(lc.cifMinor) + BigInt(lc.dutyMinor);
      const gst = mulDivFloor(taxBase, SG_IMPORT_GST_BPS, 10_000n);
      const total = taxBase + gst + BigInt(lc.feesMinor);
      const rina = rinaSuppliers.find((s) => s.supplierId === c.supplierId);
      const realHash = rina !== undefined && payoutAccountHash(rina.xenditTest) === c.payoutAccountHash;
      return {
        ...c,
        payoutAccountHash: realHash && rina ? payoutAccountHash(meiSupplier(rina).xenditTest) : c.payoutAccountHash,
        landedCost: { ...lc, sstMinor: gst.toString(), totalMinor: total.toString() },
      };
    }),
  };
}

const meiPayoutId = (id: string): string =>
  id.startsWith(`${SG.payout.idPrefix}-`) ? id : `${SG.payout.idPrefix}-${id.replace(/^mock-payout-/, "")}`;

function meiPayment(p: Payment): Payment {
  const out = remapIds(p);
  return out.payout.payoutId ? { ...out, payout: { ...out.payout, payoutId: meiPayoutId(out.payout.payoutId) } } : out;
}

function meiTrace(t: TraceEvent): TraceEvent {
  const out = remapIds(t);
  if (!out.refs.payoutId) return out;
  return { ...out, refs: { ...out.refs, payoutId: meiPayoutId(out.refs.payoutId) }, summary: `${out.summary}${SG.payout.traceNote}`.slice(0, 500) };
}

/** Rina's scenario as Mei's (see the header). */
export function meiScenario(rina: Scenario): Scenario {
  const draft = meiPlanDraft(rina["plan-draft.json"]);
  const shortlist = meiShortlist(rina["shortlist.json"], rina["suppliers.json"]);
  return {
    "facility.json": meiFacility(rina["facility.json"]),
    "session.json": meiSession(rina["session.json"]),
    "chat.json": cannedTranscript("SG", { draft, shortlistRequestId: shortlist.requestId }, SG.sessionId),
    "plan-draft.json": draft,
    "plan-current.json": meiPlanRecord(rina["plan-current.json"]),
    "shortlist.json": shortlist,
    "suppliers.json": rina["suppliers.json"].map(meiSupplier),
    "balances.json": remapIds(rina["balances.json"]),
    "payments.json": rina["payments.json"].map(meiPayment),
    "traces.json": rina["traces.json"].map(meiTrace),
    "exceptions.json": remapIds(rina["exceptions.json"]),
    "autonomy.json": remapIds(rina["autonomy.json"]),
    "escrow.json": remapIds(rina["escrow.json"]),
  };
}

/** Text that is Malaysia's, never Singapore's: the SG scenario must contain none of it (checked at load). */
const MY_LABELS =
  /\b(?:Rina|Malaysian?|MYR|SSM|LHDN|MyInvois|SST|DuitNow|DUITNOW|Selangor|ringgit|Xendit)\b|\bRM ?\d|MY_DUITNOW|lhdn-|printer-kl|Test-mode payout|example\.invalid\/(?:my|rina)\//;

/** The first Malaysian label anywhere in `value` (string values, not keys), with its path; undefined when clean. */
export function findMyLabel(value: unknown, path = "$"): string | undefined {
  if (typeof value === "string") return MY_LABELS.test(value) ? `${path}: "${value.slice(0, 120)}"` : undefined;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = findMyLabel(v, `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const [k, v] of Object.entries(value)) {
    const hit = findMyLabel(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return undefined;
}
