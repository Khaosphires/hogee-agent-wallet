"use client";

import { useState } from "react";
import { FileSearch, WifiOff } from "lucide-react";
import type { EvidenceBundle } from "@hogee/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { PageSection } from "@/components/ui/page-section";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExplorerLink } from "@/components/ledger/hash";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ledger/query-state";
import { useApiQuery } from "@/lib/api/hooks";
import { useLinksToExplorer } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import { addressUrl, chainLabel, explorerOf } from "@/lib/explorer";
import { dayMonth, shortHash } from "@/lib/format";
import { EvidenceTable } from "./evidence-table";
import { packCounts, packStatus } from "./proof-model";
import { VerifyPanel, useVerify } from "./verify-panel";

/** The app versions the pack was recorded against, behind "Show details". Never follows the manifest's own links. */
function Versions({ manifest }: { manifest: EvidenceBundle["manifest"] }) {
  const linkable = useLinksToExplorer();
  return (
    <section aria-labelledby="versions-heading" className="grid gap-3 rounded-group bg-raised p-4 text-footnote shadow-card">
      <h3 id="versions-heading" className="text-[0.8125rem] font-semibold text-ink">
        App versions on the blockchain
      </h3>
      {Object.entries(manifest.deployments).map(([id, d]) => (
        <div key={id} className="grid gap-1.5">
          <p className="font-medium text-ink">
            {id} <span className="font-normal text-ink-3">· {chainLabel(d.chainId)}</span>
          </p>
          {/* The manifest's verifiedUrl is never followed: each code page is rebuilt from the chain's pinned explorer. */}
          <ul className="grid gap-1 text-meta">
            {Object.entries(d.contracts).map(([name, c]) => (
              <li key={name} className="flex flex-wrap items-center gap-2">
                <span className="w-28 text-ink-3">{name}</span>
                <ExplorerLink href={linkable ? addressUrl(d.chainId, c.address) : null} title={c.address} className="font-mono">
                  {shortHash(c.address, 8, 6)}
                </ExplorerLink>
              </li>
            ))}
          </ul>
          {!linkable ? (
            <p className="text-meta text-ink-3">Sample data: not linked to a public website.</p>
          ) : !explorerOf(d.chainId) ? (
            <p className="text-meta text-ink-3">A test blockchain on this computer has no public website.</p>
          ) : null}
        </div>
      ))}
      <dl className="grid grid-cols-2 gap-1 border-t border-separator pt-3 text-meta text-ink-3">
        {Object.entries(manifest.toolVersions).map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd className="font-mono break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Proof → Checks: the proof pack (one picker when there are several), its check, then its tests and attacks. */
export function EvidenceView() {
  const session = useSession();
  const runs = useApiQuery("listEvidenceRuns", undefined, { poll: false });
  const [picked, setPicked] = useState<string>();
  const runId = picked ?? runs.data?.[0]?.runId;
  const bundle = useApiQuery("getEvidenceRun", runId ? { params: { runId } } : undefined, { poll: false, enabled: Boolean(runId) });

  if (runs.isPending) return <div className="grid bm-5 bl-5 bx-4"><LoadingBlock rows={4} label="Loading proof packs" /></div>;
  if (runs.error) return <div className="grid bm-5 bl-5 bx-4"><ErrorBlock error={runs.error} what="proof packs" /></div>;
  if (runs.data.length === 0) {
    return (
      <div className="grid bm-5 bl-5 bx-4">
        <EmptyState icon={<FileSearch />} title="No proof yet">
          No proof pack has been recorded yet. Each test run makes one, with every receipt, decision and record.
        </EmptyState>
      </div>
    );
  }
  const b = bundle.data;
  const run = runs.data.find((r) => r.runId === runId);

  const picker =
    runs.data.length > 1 ? (
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor="run">Pack</Label>
        <Select value={runId} onValueChange={setPicked}>
          <SelectTrigger id="run" className="w-full max-w-full sm:w-auto" data-testid="pack-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {runs.data.map((r) => (
              <SelectItem key={r.runId} value={r.runId}>
                {r.runId} · {r.rowCount} rows · {dayMonth(r.createdAt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null;

  return (
    <>
      {session.data?.mode === "replay" ? (
        <Alert className="bm-12">
          <WifiOff />
          <AlertTitle>Playing back a recording</AlertTitle>
          <AlertDescription>
            <p>Everything here comes from a recording on this computer. No internet, wallet or keys are needed.</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <PageSection id="proof-pack" title="Proof pack" line="Checked by your browser, offline: the maths, every signature, every payment against the plan." aside={picker} className="bm-5 bl-5 bx-4">
        {bundle.isPending ? <LoadingBlock rows={6} label="Loading the proof pack" /> : null}
        <ErrorBlock error={bundle.error} what="the proof pack" />
        {b && runId ? (
          <VerifyPanel
            key={runId}
            runId={runId}
            files={b.files}
            counts={packCounts(b.rows)}
            createdAt={run?.createdAt}
            deploymentCount={Object.keys(b.manifest.deployments).length}
            versions={<Versions manifest={b.manifest} />}
          />
        ) : null}
      </PageSection>

      {b && runId ? <Tests runId={runId} bundle={b} /> : null}
    </>
  );
}

/** The pack's tests and attacks; the mock's sample pack's rows are scripted, so they read "Sample", never "Pass". */
function Tests({ runId, bundle: b }: { runId: string; bundle: EvidenceBundle }) {
  const { mode, check } = useVerify(runId, b.files);
  const sample = packStatus(check, { runId, mode }, null).tone === "sample";
  return (
    <PageSection id="proof-tests" title="Tests and attacks" line="Every action, done or refused, with its receipt, its decision and its record." className="bm-12 bl-12 bx-4">
      <div className="rounded-card bg-raised p-4 shadow-card sm:p-5">
        <EvidenceTable runId={runId} rows={b.rows} sample={sample} />
      </div>
    </PageSection>
  );
}
