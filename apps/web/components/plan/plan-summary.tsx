"use client";

import { Fingerprint } from "lucide-react";
import type { PlanDraft } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { Stat } from "@/components/ui/stat";
import { Seal } from "@/components/ledger/seal";
import { bpsPct, unixDate } from "@/lib/format";
import { releaseLine, type SignState } from "@/lib/plan-rules";
import { PocketDonut } from "./pocket-donut";

/** Draft / Signed (with the seal) / Preview: what the plan on the page is, in one pill. */
export function StatePill({ state }: { state: SignState }) {
  switch (state.kind) {
    case "signed":
      return (
        <span className="inline-flex items-center gap-2.5" data-testid="plan-state" data-state="signed">
          <Seal txHash={state.record.txHash} size={20} />
          <Pill tone="signed">Signed · version {state.record.manifest.version}</Pill>
        </span>
      );
    case "draft":
      return (
        <Pill tone="waiting" data-testid="plan-state" data-state="draft">
          Draft · waiting on you
        </Pill>
      );
    case "preview":
      return (
        <Pill tone="outline" data-testid="plan-state" data-state="preview">
          Preview only · nothing is signed
        </Pill>
      );
    case "checking":
      return (
        <Pill tone="neutral" icon={null} data-testid="plan-state" data-state="checking">
          Checking your signature…
        </Pill>
      );
    case "unknown":
      return (
        <Pill tone="outline" data-testid="plan-state" data-state="unknown">
          Signature not checked
        </Pill>
      );
  }
}

/**
 * The plan in ten seconds (UX round 2): the total as the one big number (the page's one counting figure, `<Stat tick>`),
 * the split as a ring, how the budget arrives, and, while it waits on Mei, the one primary action. A signed plan shows no button here: its signature has its own
 * section at the bottom.
 */
export function PlanSummary({ draft, state, onSign }: { draft: PlanDraft; state: SignState; onSign: () => void }) {
  const m = draft.manifest;
  const waiting = state.kind === "draft";
  return (
    // The card's own width decides its layout (bento: a full row at 1280, beside Safety limit from 1440): the total and
    // the ring side by side when there is room, else one above the other, spread over the card's height. The ring's
    // column has a set width: its legend is a size container, so it can't size an auto column.
    <Card lifted={waiting} className="@container gap-0 p-0 sm:p-0">
      <div className="grid flex-1 content-between gap-x-10 gap-y-7 p-5 sm:p-7 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] @4xl:content-center @4xl:items-center">
        <div className="grid min-w-0 content-start gap-5">
          <div className="grid gap-1.5">
            <Stat data-testid="plan-total" label={`Total budget · loan in ${m.displayCurrency}`} minor={m.totalMinor} size="hero" tick />
            <p className="text-subhead text-ink-2" data-testid="plan-release-line">
              {releaseLine(m.stages, m.totalMinor, state.kind !== "draft")}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4 pt-4 shadow-[inset_0_1px_0_var(--separator)] sm:max-w-md">
            <Stat label="Pockets" value={m.lines.length} size="sm" />
            <Stat label="Releases" value={m.stages.length} size="sm" />
            <Stat label="Kept for tax" value={bpsPct(m.reserveBps)} size="sm" />
          </div>
        </div>
        <PocketDonut items={m.lines.map((l) => ({ lineKey: l.lineKey, minor: l.amountMinor }))} totalMinor={m.totalMinor} />
      </div>
      {waiting ? (
        <div className="stub flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4 sm:px-7">
          <Button onClick={onSign} data-testid="sign-plan">
            <Fingerprint /> Sign the plan
          </Button>
          <p className="min-w-0 flex-[1_1_260px] text-footnote text-pretty text-ink-2">
            Your wallet pays only from these {m.lines.length} pockets, up to their limits, until {unixDate(m.agent.expiresAt)}.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
