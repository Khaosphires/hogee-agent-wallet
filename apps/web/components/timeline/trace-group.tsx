"use client";

import { ArrowRight, Bot, CircleCheck, OctagonAlert, UserRound } from "lucide-react";
import type { TraceEvent } from "@hogee/core";
import { Pill, type PillTone } from "@/components/ui/pill";
import { HexValue, TxHash } from "@/components/ledger/hash";
import { PayoutRail } from "@/components/ledger/payout-rail";
import { isoDateTime } from "@/lib/format";
import { plainSummary, reasonCopy } from "@/lib/reason-labels";

const ACTOR_LABEL: Record<TraceEvent["actor"], string> = {
  planner: "Hogee's AI",
  reader: "Page reader (AI, sealed off)",
  policy: "Rule checker",
  txbuilder: "Payment builder",
  executor: "Payment sender",
  worker: "Background helper",
  founder: "Founder",
  officer: "Loan officer",
  oracle: "Sales checker",
  reconciler: "Record checker",
};

/** People act with a user mark; everything else is the agent's machinery (cobalt is only for what the wallet does). */
const PEOPLE: ReadonlySet<TraceEvent["actor"]> = new Set(["founder", "officer"]);
const WALLET: ReadonlySet<TraceEvent["actor"]> = new Set(["executor", "txbuilder"]);

function ActorTag({ actor }: { actor: TraceEvent["actor"] }) {
  const icon = PEOPLE.has(actor) ? <UserRound aria-hidden className="size-3.5" /> : <Bot aria-hidden className="size-3.5" />;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[0.8125rem] font-medium ${WALLET.has(actor) ? "text-agent" : "text-ink"}`}>
      {icon}
      {ACTOR_LABEL[actor]}
    </span>
  );
}

const VERDICT: Record<NonNullable<TraceEvent["verdict"]>, { tone: PillTone; label: string }> = {
  AUTO: { tone: "agent", label: "Within plan" },
  NEEDS_FOUNDER: { tone: "waiting", label: "Needs the founder" },
  NEEDS_OFFICER: { tone: "neutral", label: "Needs the loan officer" },
  DENY: { tone: "blocked", label: "Refused" },
};

/** Plain-English reason for a reason code (lib/reason-labels.ts); the code itself is never shown. */
function Reason({ code, kind }: { code: string; kind: TraceEvent["kind"] }) {
  const copy = reasonCopy(code, kind);
  return (
    <p className="text-[0.8125rem]">
      <span className="font-medium text-ink">{copy.title}.</span>
      {copy.detail ? <span className="text-ink-2"> {copy.detail}</span> : null}
    </p>
  );
}

/** trace → plan version → invoice → tx → payout → outcome, merged from the refs of one trace's events. */
function ChainSummary({ events, currency }: { events: TraceEvent[]; currency?: string }) {
  const refs = Object.assign({}, ...events.map((e) => e.refs)) as TraceEvent["refs"];
  const denial = events.find((e) => e.kind === "DENIAL" || e.verdict === "DENY");
  const steps: React.ReactNode[] = [];
  if (refs.planVersion) steps.push(<span key="plan">Plan v{refs.planVersion}</span>);
  if (refs.decisionId) steps.push(<span key="decision">Decision <HexValue value={refs.decisionId} /></span>);
  if (refs.invoiceHash) steps.push(<span key="invoice">Invoice <HexValue value={refs.invoiceHash} /></span>);
  if (refs.txHash) steps.push(<span key="tx">Tx <TxHash hash={refs.txHash} /></span>);
  if (refs.payoutId) {
    steps.push(
      <span key="payout" className="inline-flex flex-wrap items-center gap-1.5">
        Payout {refs.payoutId} <PayoutRail currency={currency} />
      </span>,
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[0.8125rem] text-ink-2" data-testid="trace-chain">
      {steps.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 ? <ArrowRight aria-hidden className="size-3.5 text-ink-4" /> : null}
          {s}
        </span>
      ))}
      {denial ? (
        <span className="inline-flex items-center gap-2">
          {steps.length > 0 ? <ArrowRight aria-hidden className="size-3.5 text-ink-4" /> : null}
          <Pill tone="blocked">Refused</Pill>
        </span>
      ) : refs.payoutId || refs.txHash ? (
        <span className="inline-flex items-center gap-1 font-medium text-paid">
          <CircleCheck aria-hidden className="size-4" />
          <span className="sr-only">Completed</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * One trace (one agent decision or human action) as a ledger entry: the chain it produced on top, then its events on a
 * hairline spine, newest-first groups. Times read in UTC; the hash-chain link of every event stays visible.
 */
export function TraceGroup({ events, currency }: { events: TraceEvent[]; currency?: string }) {
  const first = events[0];
  if (!first) return null;
  // An agent row names what allowed it (DESIGN.md: every cobalt row names its seal): the signed plan version.
  const planVersion = events.find((e) => e.refs.planVersion)?.refs.planVersion;
  return (
    <li className="grid gap-4 rounded-card bg-raised p-4 shadow-card sm:p-5 bm-6 bx-4" data-testid="trace-group">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <ChainSummary events={events} currency={currency} />
        <span className="font-mono text-meta text-ink-3">record {first.traceId}</span>
      </div>
      <ol className="grid gap-4 border-l border-line-2 pl-4">
        {events.map((e) => (
          <li key={`${e.traceId}:${e.seq}:${e.hash}`} className="relative grid gap-1" data-testid="trace-event" data-kind={e.kind}>
            <span
              aria-hidden
              className={`absolute top-[7px] -left-[20.5px] size-2 rounded-full ring-2 ring-surface ${e.verdict === "DENY" || e.kind === "DENIAL" ? "bg-blocked" : PEOPLE.has(e.actor) ? "bg-ink" : WALLET.has(e.actor) ? "bg-agent" : "bg-ink-4"}`}
            />
            <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <ActorTag actor={e.actor} />
              <span className="text-meta text-ink-3">{e.kind.replace(/_/g, " ").toLowerCase()}</span>
              {e.verdict ? (
                <Pill
                  tone={VERDICT[e.verdict].tone}
                  icon={e.verdict === "NEEDS_OFFICER" ? <UserRound aria-hidden className="size-[13px]" /> : e.verdict === "DENY" ? <OctagonAlert aria-hidden className="size-[13px]" /> : undefined}
                >
                  {e.verdict === "AUTO" && planVersion ? `Within plan v${planVersion}` : VERDICT[e.verdict].label}
                </Pill>
              ) : null}
              <time dateTime={e.ts} className="text-meta text-ink-3 sm:ml-auto">
                {isoDateTime(e.ts)}
              </time>
            </p>
            <p className="text-ui text-ink">{plainSummary(e.summary)}</p>
            {e.reasonCode ? <Reason code={e.reasonCode} kind={e.kind} /> : null}
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink-3">
              {e.refs.decisionId ? <span>decision <HexValue value={e.refs.decisionId} /></span> : null}
              {e.refs.txHash ? <span>receipt <TxHash hash={e.refs.txHash} /></span> : null}
              {e.refs.paymentId ? <span>payment {e.refs.paymentId}</span> : null}
              {e.refs.exceptionId ? <span>request {e.refs.exceptionId}</span> : null}
              <span title="Linked records: each one locks in the one before it, so none can be secretly changed">event <HexValue value={e.hash} /></span>
            </p>
          </li>
        ))}
      </ol>
    </li>
  );
}
