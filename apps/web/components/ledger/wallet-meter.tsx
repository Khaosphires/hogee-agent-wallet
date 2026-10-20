import type { ReactNode } from "react";
import { OctagonAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { moneyParts } from "./money-parts";
import { walletSegments, type WalletParts } from "./wallet-meter-math";

const SEGMENT = {
  paid: "bg-ink-2",
  agent: "hatch-agent",
  waiting: "hatch-wait",
} as const;

/**
 * One signed line in "What the agent can spend" (DESIGN.md §6): the name, "paid / limit", a 6 px meter whose track
 * is the limit, and an optional note. Rounded segments sit 3 px apart on an ink-fill track: paid (ink-2), agent pays
 * next (cobalt hatch), waits for you (saffron hatch, 45°). Past the limit the meter fills and a blocked line says by how much.
 *
 *   <WalletMeter name="Supplier" limitMinor="500000" paidMinor="120000" agentMinor="0" waitingMinor="280000"
 *     note="2,800 waits for your release" />
 *   <WalletMeterLegend />   // once, under the list
 */
export function WalletMeter({ name, note, className, ...parts }: WalletParts & { name: string; note?: ReactNode; className?: string }) {
  const s = walletSegments(parts);
  const over = s.overMinor !== "0" ? moneyParts(s.overMinor).figure : null;
  const paid = moneyParts(parts.paidMinor).figure;
  const limit = moneyParts(parts.limitMinor).figure;
  const segments = (["paid", "agent", "waiting"] as const)
    .map((k) => ({ k, pct: k === "paid" ? s.paidPct : k === "agent" ? s.agentPct : s.waitingPct }))
    .filter((x) => x.pct > 0);
  return (
    <div data-slot="wallet-meter" className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-[0.8125rem]", className)}>
      <span className="truncate font-medium text-ink">{name}</span>
      <span className="text-ink-2 tabular-nums">
        <b className="font-medium text-ink">{paid}</b> / {limit}
      </span>
      <span
        role="meter"
        aria-label={`${name}: ${paid} of ${limit} BU paid`}
        aria-valuenow={Math.round(s.usedPct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="col-span-2 flex h-2 gap-[3px] overflow-hidden rounded-full bg-fill-strong"
      >
        {segments.map(({ k, pct }) => (
          <span key={k} data-part={k} className={cn("h-full min-w-1 rounded-full", SEGMENT[k])} style={{ flexBasis: `${pct}%` }} />
        ))}
      </span>
      {over ? (
        <span className="col-span-2 inline-flex items-center gap-1.5 text-[0.78125rem] font-medium text-blocked">
          <OctagonAlert aria-hidden className="size-3.5 shrink-0" />
          {over} BU over what you signed
        </span>
      ) : null}
      {note ? <span className="col-span-2 text-[0.78125rem] text-ink-2">{note}</span> : null}
    </div>
  );
}

/** The key under the meters: Paid, Waits for you, Paid automatically next. */
export function WalletMeterLegend({ className }: { className?: string }) {
  const item = (cls: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <i aria-hidden className={cn("inline-block h-1.5 w-3 rounded-[2px]", cls)} />
      {label}
    </span>
  );
  return (
    <p className={cn("flex flex-wrap gap-x-3.5 gap-y-1.5 text-meta text-ink-2", className)}>
      {item(SEGMENT.paid, "Paid")}
      {item(SEGMENT.waiting, "Waits for you")}
      {item(SEGMENT.agent, "Paid automatically next")}
    </p>
  );
}
