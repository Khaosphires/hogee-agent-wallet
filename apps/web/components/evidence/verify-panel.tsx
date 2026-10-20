"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CircleCheck, CircleMinus, CircleX, FlaskConical, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { VerifyCheck, VerifyResult } from "@hogee/verify-evidence";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Stat } from "@/components/ui/stat";
import type { Tone } from "@/components/ui/tones";
import { LoadingBlock } from "@/components/ledger/query-state";
import { apiCall } from "@/lib/api/client";
import { useSession } from "@/lib/api/use-session";
import { explorerOf } from "@/lib/explorer";
import { checkLabel } from "@/lib/verify-labels";
import { cn } from "@/lib/utils";
import { AnchorSection } from "./anchor-section";
import { packStatus, recordedLabel, type CheckResult, type PackCounts, type PackTone } from "./proof-model";
import { verifyServedPack } from "./served-pack";

/** Fetches every bundle file from the local API (no network beyond localhost) and runs the offline verifier. */
function loadAndVerify(runId: string, files: readonly string[]) {
  return verifyServedPack(files, async (path) => (await apiCall("getEvidenceFile", { params: { runId, path } })) as Blob);
}

/** The browser's own check of a pack (one shared query per run): the panel and the tests table read the same result. */
export function useVerify(runId: string, files: readonly string[]) {
  const mode = useSession().data?.mode;
  const result = useQuery({ queryKey: ["verifyBundle", runId, files.length], queryFn: () => loadAndVerify(runId, files), staleTime: Number.POSITIVE_INFINITY });
  const check: CheckResult = result.data ? (result.data.ok ? "verified" : "failed") : result.error ? "unreadable" : "checking";
  return { result, mode, check };
}

const STATUS_LOOK: Record<PackTone, { icon: typeof ShieldCheck; tone: Tone; surface: string }> = {
  verified: { icon: ShieldCheck, tone: "paid", surface: "bg-tint-paid" },
  sample: { icon: FlaskConical, tone: "grey", surface: "bg-fill" },
  failed: { icon: ShieldAlert, tone: "blocked", surface: "bg-tint-blocked" },
  checking: { icon: ShieldQuestion, tone: "ink", surface: "bg-fill" },
};

/** What the result means (G0-DECISIONS §14): offline VERIFIED is internal consistency; chain truth is the anchor. */
function Meaning({ result }: { result: VerifyResult }) {
  const where = explorerOf(result.anchor?.chainId) ? "Sepolia Etherscan" : "the node it came from";
  return (
    <p className="max-w-[68ch] text-footnote text-pretty text-ink-2" data-testid="verify-meaning">
      Internally consistent: the files, signatures and payments all agree. That alone doesn&apos;t prove the blockchain holds the same records; to
      check, compare the details below with {where}. (Developers:{" "}
      <code className="rounded-sm bg-fill px-1 font-mono text-[0.78125rem] text-ink">make verify</code> with an RPC node.)
    </p>
  );
}

function CheckRow({ check, quiet }: { check: VerifyCheck; quiet: boolean }) {
  const { label, explain } = checkLabel(check.name);
  const leading = check.ok ? (
    <IconTile icon={CircleCheck} tone="paid" size="sm" variant="tinted" label="passed" />
  ) : (
    <IconTile icon={quiet ? CircleMinus : CircleX} tone={quiet ? "grey" : "blocked"} size="sm" variant="tinted" label="failed" />
  );
  return (
    <ListRow
      data-check={check.name}
      data-ok={check.ok}
      leading={leading}
      title={label}
      subtitle={
        <>
          {explain}
          {!check.ok && check.detail ? <span className={cn("mt-0.5 block font-mono text-[0.71875rem] break-words", quiet ? "text-ink-3" : "text-blocked")}>{check.detail}</span> : null}
        </>
      }
    />
  );
}

function Checks({ result, quiet }: { result: VerifyResult; quiet: boolean }) {
  return (
    <GroupedList header="Checks" data-testid="verify-checks" data-ok={result.ok}>
      {result.checks.map((c) => (
        <CheckRow key={c.name} check={c} quiet={quiet} />
      ))}
    </GroupedList>
  );
}

/** "Show details": 44 px, folded; open from the start in a replay, where the recorded demo shows the anchor. */
export function ShowDetails({ open, children, testId }: { open?: boolean; children: ReactNode; testId?: string }) {
  return (
    <details className="group/details grid" open={open} data-testid={testId}>
      <summary className="inline-flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 text-subhead font-medium text-ink-2 outline-none select-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 transition-[rotate] duration-(--dur-state) ease-settle group-open/details:rotate-90" />
        Show details
      </summary>
      <div className="mt-2 grid gap-4">{children}</div>
    </details>
  );
}

/**
 * The proof pack's result, checked by this browser: the status (never a faked pass: proof-model packStatus), the
 * pack's figures, the checks, then the blockchain link and versions behind "Show details". "Recorded on" names the
 * chain of the anchor this check verified, from the pack's export time (`createdAt`) and its manifest's deployment
 * count (proof-model recordedLabel).
 */
export function VerifyPanel({
  runId,
  files,
  counts,
  createdAt,
  deploymentCount,
  versions,
}: {
  runId: string;
  files: readonly string[];
  counts: PackCounts;
  createdAt: string | undefined;
  deploymentCount: number;
  versions?: ReactNode;
}) {
  const { result, mode, check } = useVerify(runId, files);
  const data = result.data;
  const status = packStatus(check, { runId, mode }, recordedLabel(data, deploymentCount, createdAt));
  const look = STATUS_LOOK[status.tone];
  const passed = data?.checks.filter((c) => c.ok).length ?? 0;
  const quiet = status.tone === "sample";

  return (
    <section data-testid="verify-panel" data-tone={status.tone} aria-labelledby="verify-title" className="grid gap-5">
      <div className={cn("flex items-start gap-3.5 rounded-card p-4 sm:p-5", look.surface)}>
        <IconTile icon={look.icon} tone={look.tone} size="lg" />
        <div className="grid min-w-0 gap-0.5">
          <h3 id="verify-title" className="text-title-3 text-ink">
            {status.title}
          </h3>
          {status.line ? (
            <p className="text-subhead text-pretty text-ink-2" data-testid={quiet ? "verify-practice-note" : "verify-recorded"}>
              {status.line}
            </p>
          ) : null}
          {data && status.showCount ? (
            <p className="text-footnote font-medium text-ink tabular-nums" data-testid="verify-count">
              {passed} of {data.checks.length} checks passed
            </p>
          ) : null}
        </div>
      </div>

      {/* A sample's rows are scripted, so its figures prove nothing: they show only for a pack that checked, or failed for real. */}
      {status.tone === "verified" || status.tone === "failed" ? (
        <div className="grid grid-cols-3 gap-x-4 gap-y-5 rounded-card bg-raised p-4 shadow-card sm:p-5">
          <Stat label="Tests passed" value={counts.passed} unit={`of ${counts.total}`} size="sm" data-testid="evidence-pass" />
          <Stat label="Receipts" value={counts.receipts} size="sm" />
          <Stat label="AI said no" value={counts.refusals} size="sm" />
        </div>
      ) : null}

      {result.isPending ? <LoadingBlock rows={3} label="Checking the proof pack" /> : null}
      {result.error ? <p className="text-footnote text-ink-2">The proof pack could not be read: {result.error.message}</p> : null}
      {data && status.tone === "verified" ? <Meaning result={data} /> : null}
      {/* A real failure lists its checks in the open; otherwise they sit behind "Show details" with the anchor. */}
      {data && status.tone === "failed" ? <Checks result={data} quiet={false} /> : null}

      {data ? (
        <ShowDetails open={mode === "replay"} testId="verify-details">
          {status.tone !== "failed" ? <Checks result={data} quiet={quiet} /> : null}
          <AnchorSection anchor={data.anchor} verified={data.ok} />
          {versions}
        </ShowDetails>
      ) : null}
    </section>
  );
}
