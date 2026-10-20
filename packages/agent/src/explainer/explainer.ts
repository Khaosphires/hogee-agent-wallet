/**
 * Explainer (project.md §7.1, §7.2 step 6): TEMPLATED, never free LLM text, for anything that states a number.
 * Every number comes from the compiled plan (PlanDraft / PlanManifest) or from the evaluated proposal and its policy
 * decision, formatted by code (core `formatBu`). Each sentence names its template id; a decision explanation also
 * returns its rationale JSON and the salted commitment rationaleHash = keccak256(utf8(JCS(rationale)) ‖ salt).
 * Wording follows §14.4 (budget units, "BU"; never the banned product words).
 */
import { formatBu, type LineKey, type PlanDraft, type PlanManifest, type PolicyDecision, type PolicyProposal } from "@hogee/core";
import { rationaleCommitment, type RandomBytes, type RationaleCommitment } from "../hash";

export const LINE_LABEL: { readonly [K in LineKey]: string } = {
  SUPPLIER: "Supplier",
  PACKAGING: "Packaging",
  LOGISTICS: "Logistics",
  ADS: "Ads",
  PLATFORM_FEES: "Platform fees",
  LICENSING: "Licensing",
  CONTINGENCY: "Contingency",
};

/**
 * The plain pocket names the founder reads (UX-PLAN §5: the same names in every map). LINE_LABEL above stays for the
 * decision texts, which are committed in a rationale hash.
 */
export const POCKET_NAME: { readonly [K in LineKey]: string } = {
  SUPPLIER: "Supplier",
  PACKAGING: "Packaging",
  LOGISTICS: "Delivery",
  ADS: "Ads",
  PLATFORM_FEES: "Marketplace fees",
  LICENSING: "Licence fees",
  CONTINGENCY: "Safety buffer",
};

export interface TemplatedSentence {
  readonly templateId: string;
  readonly text: string;
}

export interface PlanExplanation {
  readonly sentences: readonly TemplatedSentence[];
  readonly text: string;
}

const DAY = 86_400;
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Only code-shaped strings (UPPER_SNAKE flags, contract error names) are ever printed. */
const code = (s: string): string => (CODE_RE.test(s) ? s : "UNKNOWN");
const codes = (xs: readonly string[]): string => [...new Set(xs.filter((x) => CODE_RE.test(x)))].join(", ") || "UNKNOWN";
const pct = (bps: number): string => `${bps / 100}%`;
const days = (seconds: string): string => String(Number(seconds) / DAY);
/** "2 Nov 2026" (UTC calendar day of the gate's deadline). */
const dayMonthYear = (unixSeconds: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Number(unixSeconds) * 1000));

function lineSentences(m: PlanManifest): TemplatedSentence[] {
  return m.lines.flatMap((l): TemplatedSentence[] => {
    const out: TemplatedSentence[] = [
      {
        templateId: "plan.line",
        text: `${POCKET_NAME[l.lineKey]}: ${formatBu(l.amountMinor)}. At most ${formatBu(l.perTxCapMinor)} per payment and ${formatBu(l.windowCapMinor)} per ${days(l.windowSeconds)} days.${l.escrowOnly ? " Paid in steps, held until delivery." : ""}`,
      },
    ];
    if (l.pacing) out.push({ templateId: "plan.pacing", text: `${POCKET_NAME[l.lineKey]}: at most ${formatBu(l.pacing.amountMinor)} per day.` });
    return out;
  });
}

function stageSentence(m: PlanManifest): TemplatedSentence[] {
  const [first, second] = m.stages;
  if (!first) return [];
  if (!second?.gate) return [{ templateId: "plan.stage.single", text: `You get ${formatBu(first.releaseMinor)} when you sign.` }];
  const metric = second.gate.metric === "salesMinor" ? `your sales reach ${formatBu(second.gate.target)}` : `you reach ${second.gate.target} orders`;
  return [
    {
      templateId: "plan.stage.gated",
      text: `You get ${formatBu(first.releaseMinor)} when you sign. You get the next ${formatBu(second.releaseMinor)} if ${metric} by ${dayMonthYear(second.gate.deadline)} and your loan officer agrees.`,
    },
  ];
}

/** Templated summary of a compiled plan draft. */
export function explainPlanDraft(draft: PlanDraft): PlanExplanation {
  const m = draft.manifest;
  const sentences: TemplatedSentence[] = [
    { templateId: "plan.total", text: `Here's your plan: ${formatBu(m.totalMinor)} in ${m.lines.length} pockets. ${pct(m.reserveBps)} of each sale is kept for tax.` },
    ...lineSentences(m),
    ...stageSentence(m),
    { templateId: "plan.payees", text: "Your wallet can only pay the marketplace's own accounts and suppliers you approve. The plan doesn't add anyone else." },
    { templateId: "plan.blast", text: `Even if someone took over the AI, the most it could pay out under these rules is ${formatBu(draft.blastRadiusMinor)}.` },
  ];
  return { sentences, text: sentences.map((s) => s.text).join(" ") };
}

// ---- decisions ---------------------------------------------------------------------------------------------

export interface DecisionInput {
  readonly proposal: PolicyProposal;
  readonly decision: PolicyDecision;
  /** The committed plan the decision was evaluated against. */
  readonly plan: PlanManifest;
  /** UUIDv7 decision id (bytes32 on-chain). */
  readonly decisionId: string;
}

export interface DecisionRationale {
  readonly schema: "hogee.rationale.v1";
  readonly decisionId: string;
  readonly actor: "policy";
  readonly kind: PolicyProposal["kind"];
  readonly verdict: PolicyDecision["verdict"];
  readonly reasonCode: string;
  readonly mirrorsRevert: boolean;
  readonly planId: string;
  readonly planVersion: number;
  readonly facts: Readonly<Record<string, string | number | readonly string[]>>;
  readonly templateId: string;
  readonly text: string;
}

export interface DecisionExplanation extends RationaleCommitment<DecisionRationale> {
  readonly text: string;
}

type Facts = Readonly<Record<string, string | number | readonly string[]>>;
type SpendProposal = Extract<PolicyProposal, { kind: "SPEND" }>;

function spendFacts(p: SpendProposal, perTxCapMinor: string | undefined): Facts {
  return {
    lineKey: p.lineKey.value,
    payeeId: p.payeeId.value,
    amountMinor: p.amountMinor.value,
    intentId: p.intentId,
    invoiceHash: p.invoiceHash,
    ...(perTxCapMinor === undefined ? {} : { perTxCapMinor }),
    ...("invoiceId" in p.basis ? { flags: p.basis.flags } : {}),
  };
}

function spendText(p: SpendProposal, d: PolicyDecision, m: PlanManifest): TemplatedSentence {
  const amount = formatBu(p.amountMinor.value);
  const payee = p.payeeId.value;
  // The tax reserve is not a plan line: Treasury.spend reverts ReserveLocked for it (task 1.8).
  if (p.lineKey.value === "RESERVE") {
    return { templateId: "decision.spend.reserve", text: `Blocked ${amount} to ${payee}: the tax reserve is locked; only a withdrawal the lender co-signs can move it.` };
  }
  const line = m.lines.find((l) => l.lineKey === p.lineKey.value);
  const label = LINE_LABEL[p.lineKey.value];
  if (d.verdict === "AUTO" && line) {
    return { templateId: "decision.spend.auto", text: `Paid ${amount} to ${payee} from ${label}: within the ${formatBu(line.perTxCapMinor)} per-payment cap of plan v${m.version}.` };
  }
  if (d.reasonCode === "CapExceeded" && line) {
    return { templateId: "decision.spend.cap", text: `Blocked ${amount} to ${payee}: it is over the ${label} limit of ${formatBu(line.perTxCapMinor)} per payment.` };
  }
  if (d.reasonCode === "FLAGGED_INVOICE" && "invoiceId" in p.basis) {
    return { templateId: "decision.spend.flagged", text: `Held ${amount} for ${payee}: the invoice was flagged (${codes(p.basis.flags)}), so the loan officer decides.` };
  }
  if (d.reasonCode === "PayeeNotBound") return { templateId: "decision.spend.payee", text: `Blocked: ${payee} is not an approved payee of ${label}.` };
  if (d.reasonCode === "TAINTED_PAYEE") return { templateId: "decision.spend.tainted", text: "Blocked: the payee came from an unverified document." };
  return genericText(d);
}

function genericText(d: PolicyDecision): TemplatedSentence {
  switch (d.verdict) {
    case "DENY":
      return { templateId: "decision.deny", text: `Blocked by rule ${code(d.reasonCode)}.` };
    case "NEEDS_FOUNDER":
      return { templateId: "decision.founder", text: `Waiting for your signature (${code(d.reasonCode)}).` };
    case "NEEDS_OFFICER":
      return { templateId: "decision.officer", text: `Waiting for the loan officer (${code(d.reasonCode)}).` };
    case "AUTO":
      return { templateId: "decision.auto", text: `Allowed by the signed plan (${code(d.reasonCode)}).` };
  }
}

/** Templated one-line "why" for a policy decision, with its rationale JSON and salted hash. */
export function explainDecision(input: DecisionInput, randomBytes?: RandomBytes): DecisionExplanation {
  const { proposal: p, decision: d, plan: m } = input;
  let facts: Facts = {};
  let sentence: TemplatedSentence = genericText(d);
  if (p.kind === "SPEND") {
    facts = spendFacts(p, m.lines.find((l) => l.lineKey === p.lineKey.value)?.perTxCapMinor);
    sentence = spendText(p, d, m);
  } else if (p.kind === "FUND_MILESTONE") {
    facts = { orderId: p.orderId.value, idx: p.idx, amountMinor: p.amountMinor.value };
    if (d.verdict === "AUTO") {
      sentence = { templateId: "decision.milestone.auto", text: `Funded milestone ${p.idx} of ${p.orderId.value}: ${formatBu(p.amountMinor.value)} from the signed schedule.` };
    }
  }
  const rationale: DecisionRationale = {
    schema: "hogee.rationale.v1",
    decisionId: input.decisionId,
    actor: "policy",
    kind: p.kind,
    verdict: d.verdict,
    reasonCode: d.reasonCode,
    mirrorsRevert: d.mirrorsRevert,
    planId: m.planId,
    planVersion: m.version,
    facts,
    templateId: sentence.templateId,
    text: sentence.text,
  };
  return { ...rationaleCommitment(rationale, randomBytes), text: sentence.text };
}
