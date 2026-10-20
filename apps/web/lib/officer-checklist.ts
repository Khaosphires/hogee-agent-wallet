/**
 * The loan officer's "Set up Mei" checklist (UX-PLAN D10, Steve O1–O2, first-timer moment 15): four steps, each
 * Done, Your turn, Waiting for Mei (or Saving), or Not yet, worked out from what the console can already read. No
 * new API: the session's mode, the pending founder key, the current plan, the balances, the activity record (trace
 * summaries, live and mock wordings both), and what this browser saw happen in this visit.
 *
 * It only DESCRIBES: every action stays behind the officer persona and the server's checks. When it can't tell, it
 * never claims "Done": a step without evidence stays the officer's turn (opening a loan twice is refused by the API).
 */
import { ENROLMENT_CODE_TTL_SECONDS, formatBu, parseMinor, type ApiMode, type PendingFounderKey, type PlanStatus } from "@hogee/core";

export type StepKey = "open" | "code" | "passkey" | "fund";
/** "skipped": only in the Sample business (mock), for the passkey steps a demo browser can't do for Mei; never "done". */
export type StepState = "done" | "yours" | "waiting" | "saving" | "later" | "skipped";

export interface ChecklistStep {
  readonly key: StepKey;
  readonly n: 1 | 2 | 3 | 4;
  readonly title: string;
  readonly state: StepState;
  /** One plain sentence: what happened, or what to do now. */
  readonly note: string;
}

/** The pill on each step: Done, Your turn, Waiting for Mei, Saving, Not yet, Skipped. */
export function stepStateLabel(state: StepState, founder: string): string {
  return { done: "Done", yours: "Your turn", waiting: `Waiting for ${founder}`, saving: "Saving", later: "Not yet", skipped: "Skipped" }[state];
}

/** The trace fields the checklist reads. */
export interface TraceLike {
  readonly actor: string;
  readonly summary: string;
  readonly ts: string;
}

export interface ChecklistInput {
  readonly mode: ApiMode;
  /** The founder's first name ("Mei", "Rina"). */
  readonly founder: string;
  /** undefined while loading or unreadable; null when no key waits for review. */
  readonly pendingKey: PendingFounderKey | null | undefined;
  /** undefined while loading; null when there is no plan yet (GET /api/plans/current answered 404). */
  readonly plan: { readonly status: PlanStatus; readonly totalMinor: string } | null | undefined;
  readonly fundedMinor: string | undefined;
  /** The activity record's newest events (may be a window): undefined while loading. */
  readonly traces: readonly TraceLike[] | undefined;
  /** What this browser saw in this visit. */
  readonly seen: {
    readonly opened?: boolean;
    /** The API refused a second open: the loan is already open. */
    readonly alreadyOpen?: boolean;
    /** Expiry (ms) of the code made here, while it is shown. */
    readonly codeExpiresAtMs?: number;
    readonly approved?: boolean;
  };
  readonly nowMs: number;
  /**
   * The mock's Sample business is on (GET /api/demo/sample-business, scenario "lived"). Mei's passkey is deliberately
   * not enrolled there (a key this browser can't hold would lock signing), so steps 2 and 3 read as skipped, never done.
   * Ignored outside mock mode; undefined (not known) is off.
   */
  readonly sampleBusiness?: boolean;
}

// Officer trace summaries, live (packages/api) and mock (packages/api-mock) wordings.
const OPENED = /\bopened the facility\b/i;
const CODE_ISSUED = /\bissued a one-time passkey enrolment code\b/i;
const KEY_APPROVED = /\b(approved the founder's reviewed passkey|registered the founder's passkey)\b/i;
const KEY_REJECTED = /\brejected the founder's pending passkey\b/i;

const byOfficer = (traces: readonly TraceLike[] | undefined, pattern: RegExp): TraceLike[] =>
  (traces ?? []).filter((t) => t.actor === "officer" && pattern.test(t.summary));

const newestMs = (events: readonly TraceLike[]): number | undefined => {
  const times = events.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : undefined;
};

/** A code is still open for Mei: made here and not expired, or made (per the record) within its 15 minutes and not since spent or cancelled. */
function codeIsOpen(input: ChecklistInput): boolean {
  const { seen, nowMs, traces } = input;
  if (seen.codeExpiresAtMs !== undefined) return seen.codeExpiresAtMs > nowMs;
  const issued = newestMs(byOfficer(traces, CODE_ISSUED));
  if (issued === undefined || issued + ENROLMENT_CODE_TTL_SECONDS * 1000 <= nowMs) return false;
  const rejected = newestMs(byOfficer(traces, KEY_REJECTED));
  return rejected === undefined || rejected < issued;
}

const signed = (status: PlanStatus | undefined): boolean => status === "COMMITTED";

function openStep(opened: boolean): ChecklistStep {
  return opened
    ? { key: "open", n: 1, title: "Open the loan", state: "done", note: "The loan is open." }
    : { key: "open", n: 1, title: "Open the loan", state: "yours", note: "Set the loan limit and the minimum kept for tax." };
}

/** The four steps, in order. */
export function officerChecklist(input: ChecklistInput): readonly ChecklistStep[] {
  const { founder, pendingKey, plan, seen } = input;
  const funded = parseMinor(input.fundedMinor ?? "0");
  const keyPending = Boolean(pendingKey);
  const approved = Boolean(seen.approved) || byOfficer(input.traces, KEY_APPROVED).length > 0;
  const codeOpen = !keyPending && !approved && codeIsOpen(input);
  // The mock and a replay always serve an open loan (the seed opens it); live needs evidence.
  const opened =
    input.mode !== "live" ||
    Boolean(seen.opened || seen.alreadyOpen) ||
    byOfficer(input.traces, OPENED).length > 0 ||
    byOfficer(input.traces, CODE_ISSUED).length > 0 ||
    keyPending ||
    approved ||
    Boolean(plan) ||
    funded > 0n;

  const code: ChecklistStep = approved
    ? { key: "code", n: 2, title: `Give ${founder} a set-up code`, state: "done", note: `${founder} used your code to create a passkey.` }
    : keyPending
      ? { key: "code", n: 2, title: `Give ${founder} a set-up code`, state: "done", note: `${founder} used your code. Check their passkey next.` }
      : !opened
        ? { key: "code", n: 2, title: `Give ${founder} a set-up code`, state: "later", note: "After you open the loan." }
        : codeOpen
          ? { key: "code", n: 2, title: `Give ${founder} a set-up code`, state: "waiting", note: `${founder} types the code when they create their passkey. It works for 15 minutes.` }
          : { key: "code", n: 2, title: `Give ${founder} a set-up code`, state: "yours", note: `Make a one-time code and give it to ${founder} yourself, in person or by phone.` };

  const passkeyTitle = `Approve ${founder}'s passkey`;
  const passkey: ChecklistStep = approved
    ? { key: "passkey", n: 3, title: passkeyTitle, state: "done", note: `${founder}'s passkey is approved. They can sign now.` }
    : keyPending
      ? { key: "passkey", n: 3, title: passkeyTitle, state: "yours", note: `${founder}'s passkey is waiting for you. Check that its ID matches theirs, then approve it.` }
      : codeOpen
        ? { key: "passkey", n: 3, title: passkeyTitle, state: "waiting", note: `Waiting for ${founder} to create their passkey with your code.` }
        : { key: "passkey", n: 3, title: passkeyTitle, state: "later", note: `After ${founder} has a set-up code.` };

  // The Sample business: no key waiting, none approved, no code out: the passkey steps are skipped, said plainly.
  if (input.mode === "mock" && input.sampleBusiness === true && !keyPending && !approved && !codeOpen) {
    const note = `Skipped in the sample business: a passkey made on this browser signs for ${founder}.`;
    return [openStep(opened), { ...code, state: "skipped", note }, { ...passkey, state: "skipped", note }, fundStep(input, funded)];
  }
  return [openStep(opened), code, passkey, fundStep(input, funded)];
}

function fundStep(input: ChecklistInput, funded: bigint): ChecklistStep {
  const { founder, plan } = input;
  const base = { key: "fund", n: 4, title: "Add money" } as const;
  if (plan === undefined) return { ...base, state: "later", note: "Checking the plan…" };
  if (plan && signed(plan.status)) {
    const total = parseMinor(plan.totalMinor);
    if (total > 0n && funded >= total) return { ...base, state: "done", note: `Added ${formatBu(input.fundedMinor ?? "0")} of ${formatBu(plan.totalMinor)}.` };
    return funded > 0n
      ? { ...base, state: "yours", note: `Added so far: ${formatBu(input.fundedMinor ?? "0")} of ${formatBu(plan.totalMinor)}. Add the rest.` }
      : { ...base, state: "yours", note: `${founder}'s plan is signed. Add the money, up to ${formatBu(plan.totalMinor)}.` };
  }
  if (plan?.status === "SUBMITTED") return { ...base, state: "saving", note: `${founder} signed the plan. It's being saved.` };
  if (plan?.status === "PENDING_SIGNATURE" || plan?.status === "REVERTED") return { ...base, state: "waiting", note: `${founder} signs the plan first. Then you add the money.` };
  return { ...base, state: "later", note: `After ${founder} signs the plan.` };
}

/** The one step that is the officer's to do now (the first "Your turn"), if any. */
export const currentStep = (steps: readonly ChecklistStep[]): ChecklistStep | undefined => steps.find((s) => s.state === "yours");

/** True when every step is done. */
export const allDone = (steps: readonly ChecklistStep[]): boolean => steps.every((s) => s.state === "done");

/** True when nothing is left to do: every step done, or skipped in the Sample business. The console then folds the list. */
export const setupComplete = (steps: readonly ChecklistStep[]): boolean => steps.every((s) => s.state === "done" || s.state === "skipped");
