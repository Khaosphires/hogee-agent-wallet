"use client";

/**
 * /dashboard as **Wallet** (UX2 P1 decisions 1, 6, 8; UX round 3 on the shared frame and the bento grid, app/bento.css):
 * one scrolling page, no tabs, a PageSection for every id in lib/sections.ts in that order, so the side nav can list,
 * jump to and mark each one. The page frame is the shell's (ShellFrame): this root adds no width or centring, only the
 * bento grid, one column on a phone, about 2 across at 1280, 3 at 1440, 4 at 1920. The spans fill each row in the
 * side nav's order (no dense packing, so no later section sits above an earlier one), and a short card keeps its own
 * height at the top of its cell (a PageSection is content-start) rather than stretching into a white block.
 *
 *   tier            row 1 (Overview)          then
 *   bm (1280)       hero 6 · pockets 6        Activity 6 · Spending 6 / Sales 6 · Profit 6 / Forecast 6 · Tax 6 / Receipts 12
 *                   noticed 12
 *   bl (1440)       hero 4 · pockets 5 ·      Activity 4 · Spending 4 · Sales 4 / Profit 7 · Forecast 5 / Tax 4 · Receipts 8
 *                   noticed 3
 *   bx (1920)       hero 5 · pockets 4 ·      Activity 3 · Spending 3 · Sales 3 · Profit 3 / Forecast 3 · Tax 3 · Receipts 6
 *                   noticed 3
 *
 *   1. PageHead: "Wallet", one line about the data (the Sample business: one page-level label; otherwise the sentence
 *      that says the sales are a sample, D13), and the data label on the right.
 *   2. Overview: the dark wallet card (Ready to spend from the wallet itself, useReadyToSpend: the same number as the
 *      chat's wallet rail; what opens next from the plan; Paid out, Sales, Kept for tax from the report), the pockets,
 *      anything waiting for her signature, the notes.
 *   3. Activity: payments, sales and what Hogee's AI did by itself, newest first, repeats folded.
 *   4. Spending · Sales · Profit · Forecast · Tax money: one card each, on the same report fields and rules as before.
 *   5. Receipts, then anything waiting for her signature and "Need a higher limit?" (folded).
 *   6. The disclaimer, once, small, at the end.
 *
 * While a section loads it holds about its final height, so a jump into the page lands on the right section (first-timer
 * #28). Old links (`?tab=<view>`, the chat card's "See all your numbers") land on their section once the figures are in.
 * A failed refresh keeps the last figures on screen with a quiet note; the red error only when there were none
 * (lib/api/query-policy.ts). Nothing here pays or changes anything except through the sign dialog.
 */
import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, CalendarClock, CloudOff, Landmark, PenLine, ShoppingBag, TrendingUp } from "lucide-react";
import { CFO_DISCLAIMER, type CfoReport } from "@hogee/core";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { PageHead, PageSection } from "@/components/ui/page-section";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshNote } from "@/components/ledger/query-state";
import { PayoutRail } from "@/components/ledger/payout-rail";
import { ChangeRequests, useWaitingForSignature } from "@/components/dashboard/change-requests";
import { groupWaiting, waitingBanner } from "@/components/dashboard/waiting-model";
import { queryView, type QueryView } from "@/lib/api/query-policy";
import { useBalances, useCfoReport, useCurrentPlan, useDisplayCurrency, usePayments } from "@/lib/api/queries";
import { useReadyToSpend } from "@/lib/money";
import { cn } from "@/lib/utils";
import { landingSection, SAMPLE_SENTENCE } from "./cfo-model";
import { CfoDataLabel, useSampleSales, useSampleScope } from "./cfo-parts";
import { ForecastSection, ProfitSection, TaxSection } from "./cfo-panels-more";
import { SalesSection, SpendingSection } from "./cfo-panels";
import { MoneyReceipts } from "./money-receipts";
import { WalletActivity } from "./wallet-activity";
import { SectionPreview } from "./wallet-metric";
import { readyLine } from "./ready-line";
import { OverviewNotes, PocketList, WalletHero, WalletOpening } from "./wallet-overview";

/** The ux2-nav shell's jump: smooth scroll plus a brief highlight (a no-op where the shell doesn't listen yet). */
const JUMP_EVENT = "hogee:jump-to-section";

/** The Sample business's line under the title (the chat's welcome says the same). */
const SAMPLE_BUSINESS_LINE = "A sample business, three weeks in.";

/**
 * An old `?tab=<view>` link lands on its section once, after everything above it has loaded (the figures, the pockets
 * and the activity: before that they are skeletons and the target would move). Overview, or nothing, stays at the top.
 */
function useLandOnSection(ready: boolean) {
  const params = useSearchParams();
  const target = landingSection(params.get("tab"));
  const landed = useRef(false);
  useEffect(() => {
    if (!ready || !target || landed.current) return;
    landed.current = true;
    const frame = requestAnimationFrame(() => {
      document.getElementById(target)?.scrollIntoView({ block: "start" });
      window.dispatchEvent(new CustomEvent(JUMP_EVENT, { detail: { id: target } }));
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, target]);
}

/**
 * The one line under the title: the Sample business, or the sentence that says the sales are a sample (never hidden
 * while there are sample sales on the page; nothing to say before the first sale).
 */
function HeadLine({ page, sales }: { page: boolean; sales: number }) {
  const sample = useSampleSales();
  if (!sample || (!page && sales === 0)) return null;
  return <span data-testid="cfo-sample-note">{page ? SAMPLE_BUSINESS_LINE : SAMPLE_SENTENCE}</span>;
}

/** "2 requests wait for your signature": one row in the Overview that takes her to them (they live with Receipts). */
function WaitingRow() {
  const waiting = useWaitingForSignature();
  if (waiting.length === 0) return null;
  const kinds = groupWaiting(waiting).latest.length;
  return (
    <GroupedList aria-label="Waiting for you">
      <ListRow
        data-testid="overview-waiting"
        className="bg-tint-waiting"
        href="#waiting-signature"
        leading={<IconTile icon={PenLine} tone="waiting" />}
        title={<span className="font-medium text-waiting">{waitingBanner(kinds)}</span>}
      />
    </GroupedList>
  );
}

/** A number section's body: the report's own state, then the section; before a plan, what it will show. */
function ReportBody({ report, preview, children }: { report: QueryView<CfoReport>; preview: React.ReactNode | null; children: (r: CfoReport) => React.ReactNode }) {
  if (preview) return <>{preview}</>;
  // About the card's own height, so the page doesn't grow under a jump while the report loads.
  if (report.kind === "loading") return <Skeleton className="h-[40rem] w-full rounded-xl @3xl:h-[26rem]" aria-label="Reading your records" />;
  // The one red error sits under the wallet card; each section says so quietly instead of repeating it.
  if (report.kind === "error") {
    return (
      <SectionPreview icon={CloudOff} tone="grey" testId="section-not-loaded">
        Couldn&apos;t load these figures. Nothing was paid or changed; Hogee tries again by itself.
      </SectionPreview>
    );
  }
  return <>{children(report.data)}</>;
}

export function CfoPage() {
  // A failed refresh keeps the last figures on screen (a quiet note); the red error only when there are none.
  const report = queryView(useCfoReport());
  const ready = useReadyToSpend();
  const balances = queryView(useBalances());
  const plan = useCurrentPlan().data;
  const scope = useSampleScope();
  const planCurrency = useDisplayCurrency();
  const currency = report.kind === "data" ? report.data.currency : planCurrency;
  const b = balances.kind === "data" ? balances.data : null;
  const noPlan = b !== null && b.pockets.length === 0;
  const supplierPaid = report.kind === "data" ? report.data.pnl.supplierCostMinor : null;
  const salesCount = report.kind === "data" ? report.data.sales.count : 0;
  // "Sample" tags only on figures that are sample sales beside real records, never on an empty 0 (first-timer #17).
  const tagged = scope.figures && salesCount > 0;
  // The same payments query Activity and Receipts read (one cache): the page lands once the rows above are in.
  const paymentsIn = !usePayments().isPending;
  useLandOnSection(report.kind !== "loading" && balances.kind !== "loading" && paymentsIn);

  return (
    <div className="bento bento-grid w-full min-w-0 gap-y-10 sm:gap-y-12">
      <div className="grid gap-2">
        <PageHead title="Wallet" line={<HeadLine page={scope.page} sales={salesCount} />} aside={<CfoDataLabel />} />
        {report.kind === "data" ? <RefreshNote error={report.refreshFailed} what="figures" /> : null}
        {ready.kind === "data" ? <RefreshNote error={ready.refreshFailed} what="wallet" /> : null}
      </div>

      <PageSection id="wallet-overview" title="Overview" hideTitle>
        <div className="bento-grid">
          {/* The card, anything waiting for her and the notes stack in one column at their own heights, so together
              they match the pocket list beside them: no card stretched with an empty middle. */}
          <div className="flex flex-col content-start gap-5 bm-6 bl-5 bx-5">
            <WalletHero report={report} ready={ready} line={readyLine(plan, b, noPlan)} tagged={tagged} />
            <WaitingRow />
            {report.kind === "data" && !noPlan ? <OverviewNotes report={report.data} /> : null}
          </div>
          <div className="grid content-start bm-6 bl-7 bx-7">
            {noPlan ? <WalletOpening /> : <PocketList balances={b} supplierPaidMinor={supplierPaid} />}
          </div>
        </div>
      </PageSection>

      <PageSection id="wallet-activity" title="Activity" className="bm-6 bl-4 bx-3">
        <WalletActivity report={report} currency={currency} tagged={tagged} />
      </PageSection>

      <PageSection id="wallet-spending" title="Spending" className="@container bm-6 bl-4 bx-3">
        <ReportBody report={report} preview={noPlan ? <SectionPreview icon={ArrowUpRight} tone="ink">What you pay, and from which pocket.</SectionPreview> : null}>
          {(r) => <SpendingSection report={r} />}
        </ReportBody>
      </PageSection>
      <PageSection id="wallet-sales" title="Sales" className="@container bm-6 bl-4 bx-3">
        <ReportBody report={report} preview={noPlan ? <SectionPreview icon={ShoppingBag} tone="paid">Your sales, day by day, as they come in.</SectionPreview> : null}>
          {(r) => <SalesSection report={r} />}
        </ReportBody>
      </PageSection>
      <PageSection id="wallet-profit" title="Profit" className="@container bm-6 bl-7 bx-3">
        <ReportBody report={report} preview={noPlan ? <SectionPreview icon={TrendingUp} tone="paid">Sales less costs, from your first sale.</SectionPreview> : null}>
          {(r) => <ProfitSection report={r} />}
        </ReportBody>
      </PageSection>
      <PageSection id="wallet-forecast" title="Forecast" className="@container bm-6 bl-5 bx-3">
        <ReportBody report={report} preview={noPlan ? <SectionPreview icon={CalendarClock} tone="ink">After 3 days of records, a guess at what comes next.</SectionPreview> : null}>
          {(r) => <ForecastSection report={r} />}
        </ReportBody>
      </PageSection>
      <PageSection id="wallet-tax" title="Tax money" className="@container bm-6 bl-4 bx-3">
        <ReportBody report={report} preview={noPlan ? <SectionPreview icon={Landmark} tone="ink">A share of each sale, kept for tax by itself.</SectionPreview> : null}>
          {(r) => <TaxSection report={r} />}
        </ReportBody>
      </PageSection>

      <PageSection id="wallet-receipts" title="Receipts" aside={<PayoutRail currency={currency} />} className="bm-12 bl-8 bx-6">
        <MoneyReceipts currency={currency} />
        <ChangeRequests canAsk={!noPlan} />
      </PageSection>

      <p data-testid="cfo-disclaimer" className="-mt-4 px-1 text-caption text-ink-3">
        {CFO_DISCLAIMER}
      </p>
    </div>
  );
}
