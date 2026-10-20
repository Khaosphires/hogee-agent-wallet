"use client";

import type { ReactNode } from "react";
import { User } from "lucide-react";
import type { MilestoneTrigger } from "@hogee/core";
import { Pill } from "@/components/ui/pill";
import { Money } from "@/components/ledger/money";
import { conditionText, payerText, scheduleRowName } from "./order-copy";

/** One schedule row as both cards show it: who pays (automatically, or Mei), the condition, the amount. */
export interface ScheduleLine {
  readonly idx: number;
  readonly trigger: MilestoneTrigger;
  readonly label: string;
  readonly amountMinor: string;
  readonly autoRelease: boolean;
  /** Set once the order exists (the order card): mirrored from the chain. */
  readonly released?: boolean;
}

/** Who pays a payment (DESIGN.md §7): automatically (cobalt, bot) or Mei (waiting, user). */
export function PayerPill({ autoRelease }: { autoRelease: boolean }) {
  return autoRelease ? (
    <Pill tone="agent">{payerText(true)}</Pill>
  ) : (
    <Pill tone="waiting" icon={<User aria-hidden />}>
      {payerText(false)}
    </Pill>
  );
}

/**
 * The payments in order: "Deposit (payment 1 of 2)" and its amount, then who pays and when. The order card passes
 * `children` to show each payment's state instead (paid, or what it waits for). The names are display only
 * (lib/order-phase milestoneName); the signed rows keep core's labels and `idx`.
 */
export function ScheduleList({ rows, currency, children }: { rows: readonly ScheduleLine[]; currency?: string; children?: (row: ScheduleLine) => ReactNode }) {
  return (
    <ol className="grid divide-y divide-line" aria-label="Payment schedule">
      {rows.map((r, i) => (
        <li
          key={r.idx}
          data-testid="schedule-row"
          data-trigger={r.trigger}
          data-auto={String(r.autoRelease)}
          data-released={r.released === undefined ? undefined : String(r.released)}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
        >
          <span className="text-ui font-medium text-ink">{scheduleRowName(i, rows)}</span>
          <Money minor={r.amountMinor} currency={currency} className="text-right text-ui font-medium" />
          <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[0.8125rem] text-ink-2">
            {children ? (
              children(r)
            ) : (
              <>
                <PayerPill autoRelease={r.autoRelease} />
                <span>{conditionText(r.autoRelease)}</span>
              </>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
