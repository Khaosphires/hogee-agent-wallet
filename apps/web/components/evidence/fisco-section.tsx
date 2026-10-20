"use client";

import { useQuery } from "@tanstack/react-query";
import { Network, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { FiscoPackSummary } from "@hogee/api-contract";
import { IconTile } from "@/components/ui/icon-tile";
import { PageSection } from "@/components/ui/page-section";
import type { Tone } from "@/components/ui/tones";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ledger/query-state";
import { apiCall } from "@/lib/api/client";
import { useApiQuery } from "@/lib/api/hooks";
import { dayMonth } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FiscoChecks, FiscoSteps, NodesCard, StopsBlock, TimestampCard } from "./fisco-cards";
import { anchorView, fiscoVerdict, meaningOf, nodesOf, stepViews, threeStops, verifiedCreatedAt, type FiscoState, type FiscoTone } from "./fisco-model";
import { verifyServedFisco, type FiscoSource } from "./served-fisco";
import { ShowDetails } from "./verify-panel";

/** The pack, its source Sepolia bundle and its anchor, from the local API only (no network beyond localhost). */
const apiSource = (packId: string): FiscoSource => ({
  packFile: async (path) => (await apiCall("getFiscoFile", { params: { packId, path } })) as Blob,
  bundleFiles: async (runId) => (await apiCall("getEvidenceRun", { params: { runId } })).files,
  bundleFile: async (runId, path) => (await apiCall("getEvidenceFile", { params: { runId, path } })) as Blob,
  anchor: async () => (await apiCall("getFiscoAnchor", { params: { packId } })) as Blob,
});

const VERDICT_LOOK: Record<FiscoTone, { icon: typeof ShieldCheck; tone: Tone; surface: string }> = {
  verified: { icon: ShieldCheck, tone: "paid", surface: "bg-tint-paid" },
  failed: { icon: ShieldAlert, tone: "blocked", surface: "bg-tint-blocked" },
  checking: { icon: ShieldQuestion, tone: "ink", surface: "bg-fill" },
};

/** One pack, checked in this browser: the verdict, the three stops, the nodes, the timestamp, then the checks and steps. */
function Mirror({ pack }: { pack: FiscoPackSummary }) {
  const check = useQuery({
    queryKey: ["verifyFisco", pack.packId, pack.files.length, pack.anchored],
    queryFn: () => verifyServedFisco(pack, apiSource(pack.packId)),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const data = check.data;
  const state: FiscoState = data ? (data.ok ? "verified" : "failed") : check.error ? "unreadable" : "checking";
  const verdict = fiscoVerdict(state, data?.checks ?? null);
  const look = VERDICT_LOOK[verdict.tone];
  const proven = verdict.tone === "verified";
  const steps = data ? stepViews(data.files) : [];
  const { stops, sameCall } = threeStops(steps);
  const timestamp = data ? anchorView(data.anchor, pack.anchored, proven) : null;
  // The replay date from the pack this browser verified, never from the listing.
  const replayed = data ? verifiedCreatedAt(data.files, proven) : null;

  return (
    <div className="grid gap-5" data-testid="fisco-mirror" data-tone={verdict.tone}>
      <div className={cn("flex items-start gap-3.5 rounded-card p-4 sm:p-5", look.surface)} data-testid="fisco-verdict" data-tone={verdict.tone}>
        <IconTile icon={look.icon} tone={look.tone} size="lg" />
        <div className="grid min-w-0 gap-0.5">
          <h3 className="text-title-3 text-ink">{verdict.title}</h3>
          <p className="text-subhead text-pretty text-ink-2">
            {verdict.line ?? (
              <>
                Mirror pack <span className="font-mono text-[0.8125rem]">{pack.packId}</span>
                {replayed ? <span data-testid="fisco-replayed"> · replayed {dayMonth(replayed)}</span> : null}
              </>
            )}
          </p>
          {verdict.count ? (
            <p className="text-footnote font-medium text-ink tabular-nums" data-testid="fisco-count">
              {verdict.count}
            </p>
          ) : null}
        </div>
      </div>

      {proven ? (
        <p className="max-w-[72ch] px-1 text-footnote text-pretty text-ink-2" data-testid="fisco-meaning">
          {meaningOf(timestamp?.state === "anchored")} (Developers: <code className="rounded-sm bg-fill px-1 font-mono text-[0.78125rem] text-ink">make verify-fisco</code>.)
        </p>
      ) : null}
      {check.isPending ? <LoadingBlock rows={4} label="Checking the mirror pack in your browser" /> : null}
      {check.error ? <p className="px-1 text-footnote text-ink-2">The mirror pack could not be read: {check.error.message}</p> : null}

      {data ? (
        <>
          {!proven ? (
            <p className="px-1 text-footnote text-pretty text-blocked" data-testid="fisco-reference-only">
              Shown for reference only: a check failed, so these steps prove nothing yet.
            </p>
          ) : null}
          <StopsBlock stops={stops} sameCall={sameCall} proven={proven} />
          <div className="grid items-start gap-3 md:grid-cols-2">
            <NodesCard nodes={nodesOf(data.files, data.checks)} proven={proven} />
            {timestamp ? <TimestampCard anchor={timestamp} /> : null}
          </div>
          {!proven ? <FiscoChecks checks={data.checks} ok={false} /> : null}
          <ShowDetails testId="fisco-details">
            {proven ? <FiscoChecks checks={data.checks} ok /> : null}
            <FiscoSteps steps={steps} />
          </ShowDetails>
        </>
      ) : null}
    </div>
  );
}

/**
 * Proof → Checks: the FISCO BCOS mirror (REG-BRIEF fisco-proof). The newest pack the API lists for this wallet is
 * fetched file by file and checked here, with the Sepolia bundle it mirrors, as `make verify-fisco` does. A server
 * with no mirror (or no such route: 404) shows a quiet empty state, never an error and never a pass.
 */
export function FiscoSection() {
  const packs = useApiQuery("listFiscoPacks", undefined, { poll: false });
  const newest = packs.data?.[0];
  return (
    <PageSection
      id="proof-fisco"
      title="FISCO BCOS mirror"
      line="The same run, replayed on a FISCO BCOS chain where a regulator has its own powers. Checked by your browser, offline."
      className="bm-12"
    >
      {packs.isPending ? (
        <LoadingBlock rows={3} label="Looking for a mirror pack" />
      ) : packs.error && packs.error.code !== "NOT_FOUND" ? (
        <div data-testid="fisco-error">
          <ErrorBlock error={packs.error} what="the FISCO mirror" />
        </div>
      ) : newest ? (
        <Mirror key={newest.packId} pack={newest} />
      ) : (
        <div className="rounded-card bg-raised p-4 shadow-card sm:p-5">
          <EmptyState icon={<Network />} title="No mirror to check" testId="fisco-none">
            This server has no FISCO BCOS mirror pack for this wallet. The proof pack above stands on its own.
          </EmptyState>
        </div>
      )}
    </PageSection>
  );
}
