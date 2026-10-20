"use client";

import type { ReactNode } from "react";
import { Check, CheckCheck, ChevronRight, Minus } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import { Pill, type PillTone } from "@/components/ui/pill";
import { useBalances, useCurrentPlan, useTraces } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import { officerChecklist, setupComplete, stepStateLabel, type ChecklistStep, type StepState } from "@/lib/officer-checklist";
import { PERSONA_NAME, founderPersonaOf } from "@/lib/persona";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { AddMoneyBody, OpenLoanBody, alreadyOpen, useAddMoney, useOpenLoan } from "./facility-card";
import { CodeStepBody, PasskeyStepBody, Receipt, useFounderEnrolment } from "./founder-enrolment";
import { useSampleBusiness } from "./use-sample-business";

const PILL_TONE: Record<StepState, PillTone> = { done: "paid", yours: "waiting", waiting: "neutral", saving: "neutral", later: "outline", skipped: "outline" };

/** The step's mark: a paid tile when done, the waiting tile for your turn, grey (tinted) for later and skipped. */
function StepMarker({ step }: { step: ChecklistStep }) {
  if (step.state === "done") return <IconTile icon={Check} tone="paid" />;
  if (step.state === "skipped") return <IconTile icon={Minus} tone="grey" variant="tinted" />;
  return (
    <IconTile tone={step.state === "yours" ? "waiting" : "grey"} variant={step.state === "yours" ? "solid" : "tinted"} className="text-[0.8125rem] tabular-nums">
      {step.n}
    </IconTile>
  );
}

function StepRow({ step, founder, noteTestId, children }: { step: ChecklistStep; founder: string; noteTestId?: string; children?: ReactNode }) {
  const quiet = step.state === "later" || step.state === "skipped";
  return (
    <li
      data-testid="checklist-step"
      data-step={step.key}
      data-state={step.state}
      aria-current={step.state === "yours" ? "step" : undefined}
      className="group/step grid grid-cols-[30px_minmax(0,1fr)] gap-x-3 pl-4"
    >
      <span className="pt-3">
        <StepMarker step={step} />
      </span>
      <div className="grid min-w-0 gap-2.5 py-3 pr-4 shadow-[inset_0_-1px_0_var(--separator)] group-last/step:shadow-none">
        <div className="flex min-h-[30px] flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className={cn("text-callout font-medium text-pretty", quiet ? "text-ink-3" : "text-ink")}>
            <span className="sr-only">Step {step.n}: </span>
            {step.title}
          </p>
          <Pill tone={PILL_TONE[step.state]} data-testid="checklist-state">
            {stepStateLabel(step.state, founder)}
          </Pill>
        </div>
        <p className={cn("-mt-1.5 text-footnote text-pretty", quiet ? "text-ink-3" : "text-ink-2")} data-testid={noteTestId}>
          {step.note}
        </p>
        {children}
      </div>
    </li>
  );
}

/** Everything the "Set up Mei" checklist reads and does: the console works out where it goes from `complete`. */
export function useOfficerChecklist() {
  const { data: session } = useSession();
  const founderPersona = session ? founderPersonaOf(session) : undefined;
  const founder = founderPersona ? PERSONA_NAME[founderPersona] : "the founder";
  const enrolment = useFounderEnrolment();
  const open = useOpenLoan();
  const fund = useAddMoney();
  const plan = useCurrentPlan();
  const balances = useBalances();
  const traces = useTraces("300");
  const sampleBusiness = useSampleBusiness();
  const nowMs = useNow();

  const steps = officerChecklist({
    mode: session?.mode ?? "live",
    founder,
    pendingKey: enrolment.pending.error ? undefined : enrolment.pendingKey,
    plan: plan.data ? { status: plan.data.status, totalMinor: plan.data.manifest.totalMinor } : plan.error?.code === "NOT_FOUND" ? null : undefined,
    fundedMinor: balances.data?.fundedMinor,
    traces: traces.data,
    seen: {
      opened: Boolean(open.data),
      alreadyOpen: alreadyOpen(open.error),
      codeExpiresAtMs: enrolment.generate.data && enrolment.pendingKey === null ? Date.parse(enrolment.generate.data.expiresAt) : undefined,
      approved: Boolean(enrolment.approve.data),
    },
    nowMs,
    sampleBusiness,
  });
  return { founder, enrolment, open, fund, steps, complete: setupComplete(steps) };
}

export type OfficerChecklistState = ReturnType<typeof useOfficerChecklist>;

function Steps({ c }: { c: OfficerChecklistState }) {
  const { founder, enrolment, open, fund, steps } = c;
  const [openStep, codeStep, passkeyStep, fundStep] = steps;
  return (
    // founder-enrolment: the e2e helpers and the demo recorder find steps 2 and 3 inside it (test ids are an API).
    <ol className="grid" data-testid="founder-enrolment">
      {openStep ? (
        <StepRow step={openStep} founder={founder}>
          {open.data ? <Receipt txHash={open.data.txHash} /> : openStep.state === "yours" || open.error ? <OpenLoanBody open={open} /> : null}
        </StepRow>
      ) : null}
      {codeStep ? (
        <StepRow step={codeStep} founder={founder}>
          <CodeStepBody e={enrolment} founder={founder} primary={codeStep.state === "yours"} show={codeStep.state === "yours" || codeStep.state === "waiting"} />
        </StepRow>
      ) : null}
      {passkeyStep ? (
        <StepRow step={passkeyStep} founder={founder} noteTestId={enrolment.pendingKey === null ? "no-pending-key" : undefined}>
          <PasskeyStepBody e={enrolment} founder={founder} />
        </StepRow>
      ) : null}
      {fundStep ? (
        <StepRow step={fundStep} founder={founder}>
          <AddMoneyBody fund={fund} showForm={fundStep.state === "yours"} />
        </StepRow>
      ) : null}
    </ol>
  );
}

/**
 * The loan officer's "Set up Mei" checklist (UX-PLAN D10; O1–O4, first-timer moment 15): open the loan, give the
 * founder a set-up code, approve the founder's passkey, add money. While something is left, the four steps show in a grouped list
 * (done = paid tile, your turn = the waiting tile and the one filled button, later in grey). Once nothing is left it
 * folds into one quiet row that opens to the same steps. Every action is the same API call as before, behind the
 * officer persona and the server's checks.
 */
export function OfficerChecklist({ c }: { c: OfficerChecklistState }) {
  const { founder, steps, complete } = c;
  const done = steps.filter((s) => s.state === "done").length;
  const skipped = steps.some((s) => s.state === "skipped");

  if (complete) {
    return (
      <details data-testid="officer-checklist" data-complete="true" className="group/setup rounded-group bg-raised shadow-card">
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-group px-4 py-2.5 outline-none select-none hover:bg-fill focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
          <IconTile icon={CheckCheck} tone="paid" />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-callout font-medium text-ink">Set up complete</span>
            <span className="text-footnote text-pretty text-ink-3">
              {skipped ? `Loan open and funded. The passkey steps are skipped in the sample business.` : `Loan open, ${founder}'s passkey approved, money added.`}
            </span>
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-4 transition-[rotate] duration-(--dur-state) ease-settle group-open/setup:rotate-90" />
        </summary>
        <div className="pb-1">
          <Steps c={c} />
        </div>
      </details>
    );
  }

  return (
    <section data-testid="officer-checklist" data-complete="false" aria-labelledby="officer-checklist-title" className="grid gap-1.5">
      <div className="flex items-end justify-between gap-3 px-1">
        <h2 id="officer-checklist-title" className="text-title-2 text-ink">
          Set up {founder}
        </h2>
        <span className="text-footnote text-ink-2 tabular-nums">{done} of 4 done</span>
      </div>
      <div className="mt-1.5 overflow-hidden rounded-group bg-raised shadow-card">
        <Steps c={c} />
      </div>
    </section>
  );
}
