"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { CountryCode } from "@hogee/core";
import { PageHead, PageSection } from "@/components/ui/page-section";
import { CfoDataLabel } from "@/components/cfo/cfo-parts";
import { ErrorBlock, LoadingBlock } from "@/components/ledger/query-state";
import { PayoutRail } from "@/components/ledger/payout-rail";
import { SignDialog } from "@/components/sign/sign-dialog";
import { useApiQuery } from "@/lib/api/hooks";
import { useBalances, useCfoReport, useCurrentPlan } from "@/lib/api/queries";
import { getChatSessionId } from "@/lib/chat-session";
import { threadFacts, type JourneyMessage } from "@/lib/journey-client";
import { missingPackFacts } from "@/lib/live-errors";
import { approvalStepOf, foundOf, planShown, salesSoFar, settledAnswer, signStateOf, type QueryAnswer, type SignState } from "@/lib/plan-rules";
import { ApprovalStepCard } from "./approval-step";
import { COUNTRY_LABEL, CountryReview } from "./country-review";
import { PackIncomplete } from "./pack-incomplete";
import { PlanEmpty, PlanForOfficer } from "./plan-empty";
import { PlanSignature } from "./plan-signature";
import { PlanSummary, StatePill } from "./plan-summary";
import { PocketGrid } from "./pocket-grid";
import { ReleaseTimeline } from "./release-timeline";
import { PlanRules, VerifiedDepth } from "./rule-list";
import { SafetyLimit } from "./safety-limit";
import { ShowDetails } from "./show-details";
import { usePlanSampleScope } from "./use-sample-scope";

const noop = () => () => {};

/**
 * A query's last settled answer, kept through background refetches (lib/plan-rules settledAnswer): a data-less query
 * (a 404 before anything is signed) goes back to pending on every poll, and the page must not flicker with it.
 */
function useSettled<T, E extends { readonly status: number }>(q: { readonly isPending: boolean; readonly data?: T; readonly error: E | null }): QueryAnswer<T, E> {
  const now: QueryAnswer<T, E> = { isPending: q.isPending, data: q.data, error: q.error };
  const [last, setLast] = useState<QueryAnswer<T, E>>();
  if (!now.isPending && (last === undefined || last.isPending || last.data !== now.data || last.error !== now.error)) setLast(now);
  return settledAnswer(last, now);
}

function usePlanDraft(sessionId: string | undefined) {
  return useApiQuery("draftPlan", sessionId ? { body: { sessionId } } : undefined, { poll: false, enabled: Boolean(sessionId) });
}

/** Has this chat drafted a plan yet? (a plan card in its thread; 404 = no chat yet). Another failure: trust the draft. */
function useThreadDraft(sessionId: string | undefined): "loading" | "found" | "missing" {
  const history = useSettled(useApiQuery("getChat", sessionId ? { params: { sessionId } } : undefined, { poll: false, enabled: Boolean(sessionId) }));
  const found = foundOf(history);
  if (found === "loading" || found === "missing") return found;
  if (found === "failed") return "found";
  return threadFacts((history.data ?? []) as unknown as JourneyMessage[]).latestDraftId !== null ? "found" : "missing";
}

/**
 * The plan's one sign sheet, held here so it stays open across the page's own change from draft to signed. "Sign the
 * plan" (a draft) and "View what you signed" (signed) both open it; the sheet and what it signs are unchanged.
 */
function usePlanSheet(draftId: string | undefined) {
  const [sheet, setSheet] = useState<{ session: number; open: boolean; title?: string }>({ session: 0, open: false });
  const open = (title?: string) => setSheet((s) => ({ session: s.session + 1, open: true, title }));
  const node =
    draftId && sheet.session > 0 ? (
      <SignDialog
        key={sheet.session}
        request={{ kind: "PlanApproval", refId: draftId }}
        title={sheet.title}
        open={sheet.open}
        onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))}
      />
    ) : null;
  return { open, node };
}

/**
 * The page (bento, the user's choice for every page): one 12-column grid of cards (app/bento.css) in the side nav's
 * order, Summary · Safety limit · Releases · Pockets · Rules · Signature, each cell a PageSection. The frame is the
 * shell's (ShellFrame): no width or centring here. The first cell is the page head and the summary: always there (the
 * title and the side nav's "Summary"), whatever the queries are doing; beside the title, the plan's state and the
 * "Sample data" label (the Wallet's own, so the two can't drift) once there is a plan. Spans by content width:
 *   1920 (bx): Summary 6 + Safety 3 + Releases 3 / Pockets 12 (six across) / Rules 8 + Signature 4
 *   1440 (bl): Summary 8 + Safety 4 / Releases 12 (a compact horizontal timeline) / Pockets 12 / Rules 8 + Signature 4
 *   1280 (bm): Summary 12 / Safety 6 + Releases 6 / Pockets 12 / Rules 12 / Signature 12; a phone: one column.
 * Only Summary and Safety limit stretch to their row (their heights match); every other card keeps its own height,
 * so no short card is pulled into an empty block beside a tall one.
 */
function PlanPage({ state, labelled = false, summary, children }: { state?: SignState; labelled?: boolean; summary: ReactNode; children?: ReactNode }) {
  return (
    <div className="bento bento-grid w-full min-w-0 gap-y-10 sm:gap-y-12">
      <PageSection id="plan-summary" title="Summary" hideTitle className="bm-12 bl-8 bx-6 grid-rows-[auto_1fr] content-stretch gap-4">
        <PageHead
          title="Your plan"
          aside={
            labelled || state ? (
              <span className="flex flex-wrap items-center gap-2">
                {labelled ? <CfoDataLabel /> : null}
                {state ? <StatePill state={state} /> : null}
              </span>
            ) : undefined
          }
        />
        {summary}
      </PageSection>
      {children}
    </div>
  );
}

/**
 * "Your plan" (UX round 2, made one app with the rest in round 3): one page in the six sections of lib/sections.ts —
 * Summary, Safety limit, Releases, Pockets, Rules, Signature — laid out as bento cards, each a PageSection with a label, a
 * number and at most one short line, the long text one tap away. Pockets and sales read exactly as the Wallet reads
 * them. Every fact and check of the earlier page is still here; the country preview stays a reviewers' fold at the end.
 */
export function PlanView() {
  const sessionId = useSyncExternalStore(noop, getChatSessionId, () => undefined);
  const draft = useSettled(usePlanDraft(sessionId));
  const balances = useBalances();
  const report = useCfoReport();
  const sample = usePlanSampleScope();
  const current = useSettled(useCurrentPlan());
  const threadDraft = useThreadDraft(sessionId);
  const [country, setCountry] = useState<CountryCode | undefined>();
  const [switchStartedAt, setSwitchStartedAt] = useState<number>();
  const base = draft.data;
  const target = country ?? base?.intent.countryCode;
  const wantsPreview = Boolean(base && target && target !== base.intent.countryCode);
  const preview = useApiQuery("previewCountry", base && target ? { body: { draftId: base.draftId, country: target } } : undefined, {
    poll: false,
    enabled: wantsPreview,
  });
  const sheet = usePlanSheet(base?.draftId);

  // Drafting is the founder's (POST /api/plans/draft is founder-only): the loan officer gets a pointer, never the refusal.
  if (draft.error?.code === "FORBIDDEN") {
    return <PlanPage summary={<PlanForOfficer />} />;
  }
  const shows = planShown({ current: foundOf(current), draft: draft.error?.status === 404 ? "missing" : "found", threadDraft });
  if (shows === "none") {
    return <PlanPage summary={<PlanEmpty />} />;
  }
  if (draft.isPending || shows === "loading") {
    return <PlanPage summary={<LoadingBlock rows={6} label="Working out your plan" />} />;
  }
  const draftGap = missingPackFacts(draft.error);
  if (draftGap || draft.error || !base) {
    return <PlanPage summary={draftGap ? <PackIncomplete facts={draftGap} /> : <ErrorBlock error={draft.error ?? null} what="the plan draft" />} />;
  }
  const previewGap = missingPackFacts(preview.error);
  const shown = wantsPreview ? preview.data : base;
  // Acceptance: the country switch completes in under 15 s. dataUpdatedAt is when the preview arrived.
  const switchMs =
    wantsPreview && preview.data && switchStartedAt !== undefined && preview.dataUpdatedAt >= switchStartedAt ? preview.dataUpdatedAt - switchStartedAt : undefined;
  const state = signStateOf(base, current, wantsPreview);
  const m = (shown ?? base).manifest;
  const countryName = COUNTRY_LABEL[m.countryCode];
  const approval = approvalStepOf(m.rules);
  const wallet = wantsPreview ? undefined : balances.data;

  const escrow = wallet ? { escrowMinor: wallet.escrowMinor, supplierPaidMinor: report.data?.pnl.supplierCostMinor ?? null } : undefined;

  return (
    <PlanPage state={state} labelled summary={shown ? <PlanSummary draft={shown} state={state} onSign={() => sheet.open()} /> : null}>
      {shown ? (
        <>
          <PageSection id="plan-safety" title="Safety limit" line="Your worst case, in one number." className="bento-cell bm-6 bl-4 bx-3">
            <SafetyLimit shown={shown} />
          </PageSection>
          <PageSection id="plan-releases" title="Releases" line="Your budget arrives in parts." className="bm-6 bl-12 bx-3">
            <ReleaseTimeline shown={shown} wallet={wallet} salesMinor={salesSoFar(report.data)} signed={state.kind === "signed"} sample={sample} />
          </PageSection>

          <PageSection id="plan-pockets" title="Pockets" line="Each pocket pays only for its job, up to its limit." aside={<PayoutRail currency={m.displayCurrency} />}>
            <PocketGrid lines={m.lines} pockets={wallet?.pockets} escrow={escrow} totalMinor={m.totalMinor} />
          </PageSection>

          <PageSection id="plan-rules" title="Rules" line="From public sources. A guide, not professional advice." className="bm-12 bl-8 bx-8">
            <ShowDetails testId="rules-details" className="-mt-2 px-1">
              <VerifiedDepth rules={m.rules} country={countryName} />
            </ShowDetails>
            <PlanRules
              manifest={m}
              country={countryName}
              approvalRuleId={approval?.rule.ruleId}
              approval={approval ? <ApprovalStepCard step={approval} currency={m.displayCurrency} country={countryName} /> : undefined}
            />
          </PageSection>

          <PageSection id="plan-signature" title="Signature" className="bm-12 bl-4 bx-4">
            <PlanSignature state={state} shown={shown} country={countryName} onView={() => sheet.open("The plan you signed")} />
          </PageSection>
        </>
      ) : null}
      <CountryReview
        home={base.intent.countryCode}
        target={target}
        onSwitch={(cc) => {
          setSwitchStartedAt(Date.now());
          setCountry(cc);
        }}
        previewing={wantsPreview}
        switchMs={switchMs}
        pending={preview.isPending}
        error={preview.error}
        gap={previewGap}
      />
      {sheet.node}
    </PlanPage>
  );
}
