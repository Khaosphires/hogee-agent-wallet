"use client";

import { useState, type ReactNode } from "react";
import { FileCheck, GitCompareArrows, OctagonAlert, Sparkles, UserRound } from "lucide-react";
import type { PlanDraft, PlanRecord } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconTile } from "@/components/ui/icon-tile";
import { Tag } from "@/components/ui/pill";
import { TxHash } from "@/components/ledger/hash";
import { LoadingBlock } from "@/components/ledger/query-state";
import { Seal, SealCode } from "@/components/ledger/seal";
import { useSealMoment } from "@/components/sign/seal-stub";
import { shortHash } from "@/lib/format";
import type { SignState } from "@/lib/plan-rules";
import { IntentSummary } from "./intent-summary";
import { PlanDiff } from "./plan-checks";
import { ShowDetails } from "./show-details";

/** How the plan's record status reads (committed → saved). */
const STATUS_WORD: Readonly<Record<string, string>> = { COMMITTED: "saved", SUBMITTED: "saving", REVERTED: "rejected", PENDING_SIGNATURE: "waiting for your signature" };

/**
 * Opens the same sign sheet as "Sign the plan" for a plan that is already signed, as a clearly secondary action, so
 * nobody reads it as a call to sign again (a known problem in the handoff). The sheet and what it signs are unchanged.
 */
function ViewSigned({ onView }: { onView: () => void }) {
  return (
    <Button variant="secondary" onClick={onView} data-testid="view-signed">
      <FileCheck /> View what you signed
    </Button>
  );
}

/** The signed record: the chop, version and stamp, and the receipt one tap away. */
function Signed({ record, label }: { record: PlanRecord; label: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-1">
      <Seal txHash={record.txHash} className="mt-0.5" />
      <div className="grid min-w-0 gap-0.5" data-testid="plan-signed">
        <p className="text-headline text-ink" data-seal-line="signer">
          {label}
        </p>
        <p className="text-footnote text-ink-2" data-seal-line="tx">
          <SealCode txHash={record.txHash} label="Stamp" /> · plan version {record.manifest.version} {STATUS_WORD[record.status] ?? record.status.toLowerCase()}
        </p>
        <p className="text-footnote text-pretty text-ink-2">Your wallet pays only from these pockets, up to their limits.</p>
        {record.txHash ? (
          <ShowDetails label="Receipt">
            <TxHash hash={record.txHash} />
          </ShowDetails>
        ) : null}
      </div>
    </div>
  );
}

/** Before a signature: where the seal will go. */
function NotSigned({ title, line }: { title: string; line: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4">
      <span aria-hidden className="size-10 rotate-[-4deg] rounded-md border-2 border-dashed border-line-2" />
      <div className="grid min-w-0 gap-0.5">
        <p className="text-headline text-ink">{title}</p>
        <p className="text-footnote text-pretty text-ink-2">{line}</p>
      </div>
    </div>
  );
}

function Top({ state, onView }: { state: SignState; onView: () => void }) {
  switch (state.kind) {
    case "signed":
      return (
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <Signed record={state.record} label="Signed by you" />
          <ViewSigned onView={onView} />
        </div>
      );
    case "draft":
      return state.lastSigned ? (
        <div className="grid gap-4">
          <NotSigned title="This version isn't signed yet" line="Sign it at the top. Until then, the plan you signed before stays in force." />
          <Signed record={state.lastSigned} label="Last signed" />
        </div>
      ) : (
        <NotSigned title="Not signed yet" line="Your seal and receipt show here once you sign." />
      );
    case "preview":
      return <NotSigned title="Preview only; nothing is signed" line="Switch back to your own country to see your signature." />;
    case "checking":
      return <LoadingBlock rows={2} label="Checking your signature" />;
    case "unknown":
      return (
        <p className="flex items-start gap-2 text-footnote text-ink-2" role="status" data-testid="signature-unknown">
          <OctagonAlert aria-hidden className="mt-px size-4 shrink-0 text-blocked" />
          Couldn&apos;t check your signature just now. It retries by itself; nothing was signed or changed.
        </p>
      );
  }
}

/** A row of the AI group: a glyph, a title, something on the right, and an optional fold beneath. */
function AiRow({ icon, title, end, children }: { icon: ReactNode; title: ReactNode; end?: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative grid gap-0 px-4 py-2.5 before:absolute before:top-0 before:right-0 before:left-[3.5rem] before:h-px before:bg-separator first:before:hidden sm:px-5 sm:before:left-[3.75rem]">
      <div className="grid min-h-9 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3">
        {icon}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-callout text-ink">{title}</span>
          {end}
        </div>
      </div>
      {children ? <div className="min-w-0 pl-10">{children}</div> : null}
    </li>
  );
}

/**
 * The signature (UX round 2): the seal, version, stamp and receipt once signed, with "View what you signed" as a
 * secondary action; where the seal will go before. Under it, the AI disclosure (required, "AI-drafted"), what the AI
 * changed against the rules-only plan, and what it understood from Mei's answers.
 */
export function PlanSignature({ state, onView, shown, country }: { state: SignState; onView: () => void; shown: PlanDraft; country: string }) {
  const m = shown.manifest;
  // The stamp plays only when this page sees the plan go from a draft to signed (never on load).
  const [sawDraft, setSawDraft] = useState(false);
  if (state.kind === "draft" && !sawDraft) setSawDraft(true);
  const sealing = useSealMoment(sawDraft && state.kind === "signed");
  const tile = (icon: typeof Sparkles, dark = false) => <IconTile icon={icon} size="sm" tone={dark ? "ink" : "grey"} variant={dark ? "solid" : "tinted"} />;
  return (
    <Card className="gap-0 py-0 sm:py-0" data-sealing={sealing || undefined}>
      <div className="px-4 py-5 sm:px-5">
        <Top state={state} onView={onView} />
      </div>
      <ul className="shadow-[inset_0_1px_0_var(--separator)]" aria-label="How the AI was used">
        <AiRow
          icon={tile(Sparkles, true)}
          title="Drafted by AI, made into rules by code"
          end={<Tag>{state.kind === "signed" ? "AI-drafted" : "AI-drafted · check before you sign"}</Tag>}
        >
          <ShowDetails>
            <p>
              The AI only picked from fixed choices. Every rule, limit and person who can be paid was worked out by code, from {country}&apos;s
              rules and Hogee&apos;s fixed safety rules.
            </p>
            <p>
              The AI: <span className="font-mono text-[0.78125rem] text-ink">{m.aigc.model}</span>
            </p>
            <p>
              Check code of the AI&apos;s instructions: <span className="font-mono text-[0.78125rem] text-ink">{shortHash(m.aigc.promptHash)}</span>
            </p>
          </ShowDetails>
        </AiRow>
        <AiRow icon={tile(GitCompareArrows)} title="What the AI changed" end={shown.diff.length === 0 ? <PlanDiff diff={shown.diff} /> : <span className="text-callout font-medium text-ink">{shown.diff.length} changes</span>}>
          {shown.diff.length > 0 ? <PlanDiff diff={shown.diff} /> : null}
        </AiRow>
        <AiRow icon={tile(UserRound)} title="Your answers">
          <ShowDetails label="What the AI understood">
            <IntentSummary intent={shown.intent} />
          </ShowDetails>
        </AiRow>
      </ul>
    </Card>
  );
}
