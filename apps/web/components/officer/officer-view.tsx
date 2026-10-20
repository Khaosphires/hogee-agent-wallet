"use client";

import { ChevronRight, KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHead } from "@/components/ui/page-section";
import { useSession } from "@/lib/api/use-session";
import { PERSONA_NAME, founderPersonaOf } from "@/lib/persona";
import { useRecording } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { DemoControls } from "./demo-controls";
import { NeedsDecision, QueueHistory, WaitingChanges, useQueue } from "./exception-queue";
import { OfficerChecklist, useOfficerChecklist } from "./officer-checklist";
import { OfficerStats, WhatHappened } from "./officer-overview";
import { StageGateCard } from "./stage-gate-card";
import { useSampleScope } from "./use-sample-business";

/** Demo tools, folded at the bottom of the side column; gone while recording (UX-PLAN D10, D14; K13, O8). */
function DemoTools() {
  const recording = useRecording();
  if (recording) return null;
  return (
    <details className="group/demo rounded-group bg-raised shadow-card" data-testid="demo-tools">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-group px-4 text-callout font-medium text-ink outline-none select-none hover:bg-fill focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 text-ink-3 transition-[rotate] duration-(--dur-state) ease-settle group-open/demo:rotate-90" />
        Demo tools
      </summary>
      <div className="px-4 pb-4">
        <DemoControls />
      </div>
    </details>
  );
}

/** The console proper (officer persona only): its hooks run only here, never for a founder. */
function Console() {
  const queue = useQueue();
  const checklist = useOfficerChecklist();
  const { founder, complete } = checklist;
  const deciding = queue.exceptions.error !== null || queue.by("needs-decision").length > 0;
  return (
    // Bento (P1: layout A): the figures across the top; the work while there is some (set-up, decisions) side by side;
    // then the releases and the folded extras beside what happened. One column on a phone. Cells keep their own height,
    // so a short card never stretches into an empty block beside a tall one.
    <div
      data-testid="officer-console"
      data-queue-loaded={queue.exceptions.data ? "true" : "false"}
      className="bento bento-grid items-start gap-y-6"
    >
      <OfficerStats founder={founder} />
      {complete ? null : (
        <div className={cn("grid", deciding ? "bm-12 bl-7 bx-6" : "bm-12")}>
          <OfficerChecklist c={checklist} />
        </div>
      )}
      {deciding ? (
        <div className={cn("grid", complete ? "bm-12" : "bm-12 bl-5 bx-6")}>
          <NeedsDecision queue={queue} />
        </div>
      ) : null}
      {/* The releases and the folded extras; at 1920 they sit side by side inside this cell. */}
      <div className="bento-grid gap-y-6 bm-7 bl-7 bx-8">
        <div className="grid bx-6">
          <StageGateCard queue={queue} founder={founder} />
        </div>
        {/* At 1920 this stack sits beside the releases: it starts where their card starts, under the heading's line. */}
        <div className="grid content-start gap-4 bx-6 @min-[92rem]/bento:pt-10">
          <WaitingChanges queue={queue} />
          {complete ? <OfficerChecklist c={checklist} /> : null}
          <QueueHistory queue={queue} />
          <DemoTools />
        </div>
      </div>
      <div className="grid bm-5 bl-5 bx-4">
        <WhatHappened founder={founder} />
      </div>
    </div>
  );
}

/**
 * The loan officer's console (UX-PLAN D10; ux3 review #9): the large title, four figures, then two columns from
 * 1280 px: the work on the left (set-up until it is done, decisions only when there are some, budget releases with the
 * sales goal, changes in their wait), and on the right what happened, past requests and the demo tools.
 */
export function OfficerView() {
  const session = useSession();
  const scope = useSampleScope();
  const isOfficer = session.data?.persona === "officer";
  const founderPersona = session.data ? founderPersonaOf(session.data) : undefined;
  const founder = founderPersona ? PERSONA_NAME[founderPersona] : "the founder";
  // One page-level label when the page is all sample (the Sample business); elsewhere per-figure tags (useSampleScope).
  const line = scope.page ? `${founder}'s loan · Sample` : `Fund ${founder}'s loan, approve their passkey, and decide what their plan doesn't allow by itself.`;
  return (
    <>
      <PageHead title="Loan officer" line={line} />
      {session.data && !isOfficer ? (
        <Alert>
          <KeyRound />
          <AlertTitle>Switch to the loan officer</AlertTitle>
          <AlertDescription>
            <p>Open the menu at the top right and choose Loan officer under View as. To act as the loan officer, you need the officer access code.</p>
          </AlertDescription>
        </Alert>
      ) : isOfficer ? (
        <Console />
      ) : null}
    </>
  );
}
