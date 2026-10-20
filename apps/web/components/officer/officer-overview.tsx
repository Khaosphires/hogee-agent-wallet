"use client";

import Link from "next/link";
import { Bot, Factory, Fingerprint, Landmark, LockOpen } from "lucide-react";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { PageSection } from "@/components/ui/page-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { slotTone, type Tone } from "@/components/ui/tones";
import { LINE_SLOT } from "@/components/ledger/line-slots";
import { Money } from "@/components/ledger/money";
import { useBalances, useCfoReport, useCurrentPlan, usePayments, useTraces } from "@/lib/api/queries";
import { walletSummary } from "@/lib/journey-client";
import { bu } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { ago, aiCanPayNow, feedOf, type FeedKind } from "./officer-model";

/**
 * The loan officer's four figures (review #9; P1): the loan, what is released, what escrow still holds for suppliers,
 * and the most the AI could pay on its own right now (cobalt: what the wallet does alone). One source per figure:
 * the committed plan, GET /api/balances, and the CFO report's supplier cost for the held part (lib/journey-client
 * walletSummary, as the chat's wallet rail splits escrow).
 */
export function OfficerStats({ founder }: { founder: string }) {
  const plan = useCurrentPlan();
  const balances = useBalances();
  const report = useCfoReport();
  const nowMs = useNow();
  const b = balances.data;
  const total = plan.data?.status === "COMMITTED" ? plan.data.manifest.totalMinor : undefined;
  const figures = walletSummary(total, b, report.data?.pnl.supplierCostMinor ?? null);
  if (!b) {
    return (
      <div className="grid grid-cols-2 gap-4 rounded-card bg-raised p-5 shadow-card md:grid-cols-4" aria-busy="true" aria-label="Loading the figures">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }
  const funded = BigInt(b.fundedMinor);
  return (
    <section aria-label="The loan at a glance" data-testid="officer-stats" className="grid grid-cols-2 gap-x-6 gap-y-6 rounded-card bg-raised p-5 shadow-card sm:p-6 md:grid-cols-4">
      <Stat
        label="Loan"
        leading={<IconTile icon={Landmark} tone="ink" size="sm" variant="tinted" />}
        minor={total ?? b.fundedMinor}
        note={total === undefined ? "Added so far" : funded >= BigInt(total) ? "All of it added" : `${bu(b.fundedMinor)} added`}
      />
      <Stat
        label="Released"
        leading={<IconTile icon={LockOpen} tone="paid" size="sm" variant="tinted" />}
        minor={b.releasedMinor}
        note={total ? `of ${bu(total)}` : "Opens in parts"}
      />
      <Stat
        label="Held for suppliers"
        leading={<IconTile icon={Factory} tone={slotTone(LINE_SLOT.SUPPLIER)} size="sm" variant="tinted" />}
        minor={figures?.escrowHeldMinor ?? b.escrowMinor}
        note={figures?.escrowHeldMinor ? "Paid out after delivery checks" : "Sent to the held box"}
      />
      <Stat
        label="AI could pay now"
        leading={<IconTile icon={Bot} tone="agent" size="sm" variant="tinted" />}
        minor={aiCanPayNow(b, Math.floor(nowMs / 1000))}
        note={b.paused ? "Payments are stopped" : `At most, inside ${founder}'s signed limits`}
        data-testid="officer-ai-can-pay"
      />
    </section>
  );
}

const FEED_LOOK: Record<FeedKind, { icon: typeof Bot; tone: Tone; subtitle?: string }> = {
  agent: { icon: Bot, tone: "agent", subtitle: "Inside the signed plan" },
  signed: { icon: Fingerprint, tone: "seal" },
  officer: { icon: Landmark, tone: "ink" },
};

/** The newest few things: the AI's own payments, the founder's signatures and the officer's actions (templates only). */
export function WhatHappened({ founder }: { founder: string }) {
  const payments = usePayments();
  const traces = useTraces("300");
  const nowMs = useNow();
  if (!payments.data && !traces.data) return null;
  const feed = feedOf({ payments: payments.data, traces: traces.data, founder, limit: 6 });
  if (feed.length === 0) return null;
  return (
    <div data-testid="officer-feed" className="grid">
      <PageSection
        id="officer-feed"
        title="What happened"
        aside={
          <Link href="/timeline" className="relative inline-flex h-7 items-center rounded-md text-footnote font-medium text-ink-2 outline-none after:absolute after:-inset-2 after:content-[''] hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50">
            See all
          </Link>
        }
      >
        <GroupedList aria-label="What happened">
          {feed.map((item) => {
            const look = FEED_LOOK[item.kind];
            const when = ago(item.at, nowMs);
            const subtitle = look.subtitle ? `${look.subtitle} · ${when}` : when;
            return (
              <ListRow
                key={item.key}
                data-kind={item.kind}
                leading={<IconTile icon={look.icon} tone={look.tone} />}
                title={item.title}
                subtitle={subtitle}
                value={item.amountMinor ? <Money minor={item.amountMinor} /> : undefined}
              />
            );
          })}
        </GroupedList>
      </PageSection>
    </div>
  );
}
