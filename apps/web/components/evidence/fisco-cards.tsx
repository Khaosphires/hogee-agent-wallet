"use client";

import type { LucideIcon } from "lucide-react";
import { Ban, CircleCheck, CircleMinus, CirclePause, CircleX, Clock4, Landmark, OctagonX, ScanSearch, Server, Snowflake, Stamp } from "lucide-react";
import { FISCO_CHAIN_ID } from "@hogee/verify-evidence/fisco";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import type { Tone } from "@/components/ui/tones";
import { ExplorerLink } from "@/components/ledger/hash";
import { chainLabel } from "@/lib/explorer";
import { bu, lineLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fiscoCheckRow, type FiscoCheckState } from "./fisco-labels";
import { STOPPED_BY, stoppedSpend, type AnchorView, type FiscoCheck, type NodesView, type StepOutcome, type StepView, type StopKey, type StopView } from "./fisco-model";

/** The card every block of the section sits on (DESIGN.md §12: a solid sheet on the canvas). */
const CARD = "rounded-card bg-raised p-4 shadow-card sm:p-5";

const STOP_ICON: Record<StopKey, LucideIcon> = { frozen: Snowflake, banned: Ban, paused: CirclePause };

/**
 * One stop: what stopped the spend and who refused it, the step and its block, and the refusal's own words. In tone only
 * when the browser's check passed; otherwise grey, under the section's red verdict.
 */
function StopCard({ stop, n, proven }: { stop: StopView; n: number; proven: boolean }) {
  const tone: Tone = proven && stop.present ? "blocked" : "grey";
  return (
    <li data-testid="fisco-stop" data-step={stop.stepId} data-present={stop.present} className={cn(CARD, "flex flex-col gap-3")}>
      <div className="flex items-start justify-between gap-3">
        <IconTile icon={STOP_ICON[stop.key]} tone={tone} size="lg" />
        <span className="text-right font-mono text-[0.75rem] leading-5 text-ink-3 tabular-nums">
          <span className="sr-only">Stop {n}: </span>
          {stop.stepId}
          {stop.block !== null ? ` · block ${stop.block.toLocaleString("en-US")}` : ""}
        </span>
      </div>
      <div className="grid gap-1.5">
        <h4 className="text-headline text-ink">{stop.title}</h4>
        {stop.present ? (
          <Pill tone={proven ? "blocked" : "neutral"} icon={<OctagonX aria-hidden />}>
            {STOPPED_BY[stop.by]}
          </Pill>
        ) : (
          <Pill tone="outline">Not in this pack</Pill>
        )}
      </div>
      <p className="max-w-[48ch] text-footnote text-pretty text-ink-2">{stop.note}</p>
      {stop.present && stop.reason ? (
        <p className="mt-auto rounded-lg bg-fill px-3 py-2 font-mono text-[0.75rem] break-words text-ink-2" data-testid="fisco-stop-reason">
          {stop.reason}
          {stop.status !== null ? <span className="text-ink-3"> · status {stop.status}</span> : null}
        </p>
      ) : null}
    </li>
  );
}

export function StopsBlock({ stops, sameCall, proven }: { stops: readonly StopView[]; sameCall: boolean; proven: boolean }) {
  const spend = stoppedSpend();
  return (
    <section aria-labelledby="fisco-stops-title" className="grid gap-3" data-testid="fisco-stops" data-same-call={sameCall}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 px-1">
        <div className="grid min-w-0 gap-0.5">
          <h3 id="fisco-stops-title" className="text-headline text-ink">
            Three stops on the same spend
          </h3>
          <p className="max-w-[68ch] text-footnote text-pretty text-ink-2">
            The AI agent tried one payment three times{proven && sameCall ? ", byte for byte the same call" : ""}. Each time something different stopped it.
          </p>
        </div>
        {spend ? (
          <p className="inline-flex items-center gap-2 rounded-lg bg-fill px-3 py-1.5 text-footnote text-ink-2" data-testid="fisco-spend">
            <span className="font-mono text-[0.75rem] text-ink">spend()</span>
            <span aria-hidden className="text-ink-4">·</span>
            <span className="font-medium text-ink tabular-nums">{bu(spend.amountMinor)}</span>
            <span>from {lineLabel(spend.line)}</span>
          </p>
        ) : null}
      </div>
      <ol className="grid gap-3 md:grid-cols-3">
        {stops.map((stop, i) => (
          <StopCard key={stop.key} stop={stop} n={i + 1} proven={proven} />
        ))}
      </ol>
    </section>
  );
}

const LEDGER_LOOK = {
  matches: { icon: CircleCheck, className: "text-paid", text: "Its copy of the ledger matched a validator's, block for block, when this pack was recorded." },
  differs: { icon: CircleX, className: "text-blocked", text: "Its copy of the ledger does not match the validators'." },
  unproven: { icon: CircleMinus, className: "text-ink-3", text: "Its copy matched, but another check failed, so this proves nothing yet." },
  unchecked: { icon: CircleMinus, className: "text-ink-3", text: "The regulator's copy of the ledger wasn't compared here, so nothing is said about it." },
} as const;

/** What the card may say: "matches" only under a passing verdict; a mismatch is always said. */
const ledgerShown = (nodes: NodesView | null, proven: boolean): keyof typeof LEDGER_LOOK =>
  !nodes ? "unchecked" : nodes.ledger === "matches" && !proven ? "unproven" : nodes.ledger;

function NodeChip({ icon, tone, label }: { icon: LucideIcon; tone: Tone; label: string }) {
  return (
    <li className="grid justify-items-center gap-1.5 text-center">
      <IconTile icon={icon} tone={tone} variant="tinted" />
      <span className="text-caption text-balance text-ink-2">{label}</span>
    </li>
  );
}

/** The chain's nodes: the validators that seal blocks and the regulator's own observer node, and whether its ledger matches. */
export function NodesCard({ nodes, proven }: { nodes: NodesView | null; proven: boolean }) {
  const ledger = ledgerShown(nodes, proven);
  const look = LEDGER_LOOK[ledger];
  return (
    <section aria-labelledby="fisco-nodes-title" className={cn(CARD, "grid content-start gap-4")} data-testid="fisco-nodes" data-ledger={ledger}>
      <div className="grid gap-0.5">
        <h3 id="fisco-nodes-title" className="text-headline text-ink">
          The regulator keeps its own copy
        </h3>
        <p className="text-footnote text-ink-3">{chainLabel(FISCO_CHAIN_ID)}</p>
      </div>
      {nodes ? (
        <>
          <ul className="grid max-w-md grid-cols-5 items-start gap-2" aria-label={`${nodes.validators} validators and ${nodes.observers} regulator node`}>
            {Array.from({ length: nodes.validators }, (_, i) => (
              <NodeChip key={i} icon={Server} tone="grey" label={`Validator ${i + 1}`} />
            ))}
            {Array.from({ length: nodes.observers }, (_, i) => (
              <NodeChip key={`o${i}`} icon={Landmark} tone="ink" label="Regulator" />
            ))}
          </ul>
          <p className="max-w-[60ch] text-footnote text-pretty text-ink-2">
            {nodes.validators} validators seal the blocks. The regulator runs its own node, which only reads, and governs the chain: it can freeze an account or ban
            one method.
          </p>
          <p className={cn("flex items-start gap-2 text-footnote font-medium", look.className)} data-testid="fisco-ledger">
            <look.icon aria-hidden className="mt-px size-4 shrink-0" />
            {look.text}
          </p>
        </>
      ) : (
        <p className="text-footnote text-ink-3">The pack&apos;s chain file didn&apos;t load, so its nodes can&apos;t be shown.</p>
      )}
    </section>
  );
}

const ANCHOR_TEXT: Record<Exclude<AnchorView["state"], "anchored" | "checking">, { icon: LucideIcon; tone: Tone; title: string; line: string }> = {
  none: { icon: Clock4, tone: "grey", title: "Not timestamped yet", line: "This pack has no public timestamp yet. That isn't one of the checks, and they don't depend on it." },
  unproven: { icon: CircleMinus, tone: "grey", title: "Not counted", line: "The pack's timestamp checks, but another check failed, so no block or link is shown." },
  unavailable: { icon: CircleMinus, tone: "grey", title: "Can't be checked here yet", line: "This build has no timestamp check, so no link is shown." },
  failed: { icon: CircleX, tone: "blocked", title: "The timestamp doesn't check", line: "So no link is shown: it would prove nothing." },
};

/**
 * The public Sepolia timestamp: "Publicly timestamped" with a block, a UTC time and the pinned Etherscan page only when
 * the pack passed and so did its anchor. Offline, the block and time are the ones recorded with the pack (its sidecar),
 * so they are labelled that way: Etherscan is where they are confirmed.
 */
export function TimestampCard({ anchor }: { anchor: AnchorView }) {
  return (
    <section aria-labelledby="fisco-anchor-title" className={cn(CARD, "grid content-start gap-4")} data-testid="fisco-anchor" data-state={anchor.state}>
      <div className="grid gap-0.5">
        <h3 id="fisco-anchor-title" className="text-headline text-ink">
          Public timestamp
        </h3>
        <p className="text-footnote text-ink-3">On Sepolia, the public test network</p>
      </div>
      {anchor.state === "checking" ? (
        <div className="grid gap-2" aria-busy="true" aria-label="Checking the timestamp">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-2.5 w-56" />
        </div>
      ) : anchor.state === "anchored" ? (
        <div className="grid gap-3">
          <div className="flex items-center gap-3">
            <IconTile icon={Stamp} tone="paid" variant="tinted" />
            <p className="text-callout font-medium text-ink">Publicly timestamped</p>
          </div>
          <div className="grid gap-0.5">
            <span className="text-footnote text-ink-2">Sepolia block</span>
            <span className="text-title-1 text-ink tabular-nums" data-testid="fisco-anchor-block">
              {anchor.blockNumber?.toLocaleString("en-US")}
            </span>
            <span className="text-footnote text-ink-2 tabular-nums">{anchor.utc ?? "time unknown"}</span>
            <span className="text-caption text-ink-3" data-testid="fisco-anchor-recorded">
              As recorded with the pack; confirm on Etherscan.
            </span>
          </div>
          <p className="max-w-[56ch] text-footnote text-pretty text-ink-2">
            The transaction names this pack and the hash of its index file, so on Etherscan anyone can confirm the pack existed by then.
          </p>
          {anchor.href ? (
            <span data-testid="fisco-etherscan" data-explorer="sepolia-anchor">
              <ExplorerLink href={anchor.href} className="text-subhead font-medium">
                See it on Sepolia Etherscan
              </ExplorerLink>
            </span>
          ) : null}
        </div>
      ) : (
        <AnchorNote state={anchor.state} detail={anchor.detail} />
      )}
    </section>
  );
}

function AnchorNote({ state, detail }: { state: keyof typeof ANCHOR_TEXT; detail: string | null }) {
  const t = ANCHOR_TEXT[state];
  return (
    <div className="flex items-start gap-3">
      <IconTile icon={t.icon} tone={t.tone} variant="tinted" />
      <div className="grid gap-0.5">
        <p className={cn("text-callout font-medium", state === "failed" ? "text-blocked" : "text-ink")}>{t.title}</p>
        <p className="max-w-[56ch] text-footnote text-pretty text-ink-2">{t.line}</p>
        {detail ? <p className="font-mono text-[0.71875rem] break-words text-blocked">{detail}</p> : null}
      </div>
    </div>
  );
}

/** How a row looks: a pass in tone, a failure red, a check the verifier skipped ("not run: …") said quietly. */
const CHECK_LOOK: Record<FiscoCheckState, { icon: LucideIcon; tone: Tone; label: string; detail: string }> = {
  passed: { icon: CircleCheck, tone: "paid", label: "passed", detail: "text-ink-3" },
  failed: { icon: CircleX, tone: "blocked", label: "failed", detail: "text-blocked" },
  "not-run": { icon: CircleMinus, tone: "grey", label: "not run", detail: "text-ink-3" },
};

/**
 * The checks this browser ran, in plain English, each with the verifier's own detail (as `make verify-fisco` prints
 * it): on a pass too, so what a check did not prove here (artifacts not rebuilt, blocks as served, the Sepolia time as
 * recorded) is said next to it.
 */
export function FiscoChecks({ checks, ok }: { checks: readonly FiscoCheck[]; ok: boolean }) {
  return (
    <GroupedList header="Checks" data-testid="fisco-checks" data-ok={ok}>
      {checks.map((c) => {
        const row = fiscoCheckRow(c);
        const look = CHECK_LOOK[row.state];
        return (
          <ListRow
            key={c.name}
            data-check={c.name}
            data-ok={c.ok}
            leading={<IconTile icon={look.icon} tone={look.tone} size="sm" variant="tinted" label={look.label} />}
            title={row.label}
            subtitle={
              <>
                {row.explain}
                {row.detail ? (
                  <span className={cn("mt-0.5 block font-mono text-[0.71875rem] break-words", look.detail)} data-testid="fisco-check-detail">
                    {row.detail}
                  </span>
                ) : null}
              </>
            }
          />
        );
      })}
    </GroupedList>
  );
}

const OUTCOME_LOOK: Record<StepOutcome, { icon: LucideIcon; tone: Tone; text: string }> = {
  done: { icon: CircleCheck, tone: "paid", text: "Went through" },
  probe: { icon: ScanSearch, tone: "grey", text: "Tried as a check only, never sent" },
  frozen: { icon: OctagonX, tone: "blocked", text: "Refused by the chain: account frozen" },
  banned: { icon: OctagonX, tone: "blocked", text: "Refused by the chain: method banned" },
  contract: { icon: OctagonX, tone: "blocked", text: "Refused by Hogee's contract" },
  "not-mined": { icon: CircleMinus, tone: "grey", text: "Refused before it reached a block" },
};

/** Every step of the run, in order: who sent it, its block, and what happened. */
export function FiscoSteps({ steps }: { steps: readonly StepView[] }) {
  return (
    <GroupedList header={`Every step (${steps.length})`} data-testid="fisco-steps">
      {steps.map((s) => {
        const look = OUTCOME_LOOK[s.outcome];
        return (
          <ListRow
            key={`${s.seq}-${s.id}`}
            data-step={s.id}
            leading={<IconTile icon={look.icon} tone={look.tone} size="sm" variant="tinted" />}
            title={
              <>
                <span className="font-mono text-[0.8125rem] text-ink-3">{s.id}</span> {s.title}
              </>
            }
            subtitle={`${s.who} · ${look.text}${s.block !== null ? ` · block ${s.block.toLocaleString("en-US")}` : ""}`}
          />
        );
      })}
    </GroupedList>
  );
}
