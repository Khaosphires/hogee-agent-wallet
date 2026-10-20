"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { revertCopy, type EvidenceRow } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HexValue, TxHash } from "@/components/ledger/hash";
import { apiUrl } from "@/lib/api/client";
import { artifactPath } from "@/lib/safe-links";
import { cn } from "@/lib/utils";
import { LAYER_LABEL, taskName } from "./proof-model";

const EXPECTED_LABEL: Record<EvidenceRow["expected"], string> = { success: "Should go through", revert: "Should be refused", refused: "The AI should say no" };

/**
 * An artifact of a bundle row, linked to the run's files route only when it names a file inside the bundle
 * (lib/safe-links artifactPath: no empty, `.` or `..` segment); anything else is shown without a link. 44 px tall.
 */
function ArtifactLink({ runId, path }: { runId: string; path: string }) {
  const safe = artifactPath(path);
  if (!safe) {
    return (
      <span className="inline-flex min-h-11 items-center font-mono text-ink-3" title="Not a file path inside this bundle, so it is not linked" data-testid="evidence-artifact-unlinked">
        {path}
      </span>
    );
  }
  const name = safe.split("/").at(-1) ?? safe;
  return (
    <a
      href={apiUrl("getEvidenceFile", { params: { runId, path: safe } })}
      title={safe}
      className="inline-flex min-h-11 items-center rounded-sm font-mono text-ink underline decoration-line-2 underline-offset-[3px] outline-none hover:decoration-ink focus-visible:ring-[3px] focus-visible:ring-ring/50"
      target="_blank"
      rel="noopener noreferrer"
    >
      {name.length > 28 ? `${name.slice(0, 12)}…${name.slice(-12)}` : name}
    </a>
  );
}

/** What the row shows in plain words: what kind of result, and why a refusal happened. */
function rowNote(r: EvidenceRow): string {
  const reason = r.revertReason ? revertCopy(r.revertReason) : undefined;
  return reason ? `${LAYER_LABEL[r.layer]}: ${reason.title}` : LAYER_LABEL[r.layer];
}

/** Pass or Fail as the pack records it; a sample pack's outcome is scripted, so it says "Sample" (never a green pass). */
function Result({ r, sample }: { r: EvidenceRow; sample: boolean }) {
  if (sample) return <Pill tone="neutral" icon={null}>Sample</Pill>;
  return r.outcome === "pass" ? <Pill tone="paid">Pass</Pill> : <Pill tone="blocked">Fail</Pill>;
}

/**
 * The receipts and files of a row: its tx hash (rebuilt from its chain's pinned explorer, never the row's own
 * explorerUrl; a bundle row's hash is the only kind that may link in replay, lib/explorer.ts txLinkOf), its decision,
 * its record and its files.
 */
function Links({ runId, r }: { runId: string; r: EvidenceRow }) {
  return (
    <div className="grid gap-1 text-meta text-ink-2" data-testid="evidence-links">
      {r.txHash ? <TxHash hash={r.txHash} bundleChainId={r.chainId} /> : null}
      {r.decisionId ? (
        <p>
          decision <HexValue value={r.decisionId} />
        </p>
      ) : null}
      {r.traceId ? <p className="font-mono break-all">trace {r.traceId}</p> : null}
      {r.artifacts.length > 0 ? (
        <p className="flex flex-wrap gap-x-3">
          {r.artifacts.map((a) => (
            <ArtifactLink key={a} runId={runId} path={a} />
          ))}
        </p>
      ) : null}
    </div>
  );
}

const rowKey = (r: EvidenceRow): string => `${r.taskId}:${r.layer}:${r.txHash ?? r.traceId ?? ""}`;

/**
 * One row per scripted task and attack (§16, §19.1), named from a template (never the run's own title). Receipts and
 * files sit behind "Show details". A table from 640 px; on a phone one small card per row (friction log #40).
 */
export function EvidenceTable({ runId, rows, sample = false }: { runId: string; rows: readonly EvidenceRow[]; sample?: boolean }) {
  const [details, setDetails] = useState(false);
  const id = useId();
  return (
    <div className="grid gap-3">
      <Button
        type="button"
        variant="tinted"
        className="h-11 justify-self-start"
        aria-expanded={details}
        aria-controls={id}
        onClick={() => setDetails((d) => !d)}
        data-testid="evidence-details-toggle"
      >
        <ChevronDown aria-hidden className={cn("transition-[rotate] duration-(--dur-state) ease-settle", details && "rotate-180")} />
        {details ? "Hide details" : "Show details"}
      </Button>
      <div id={id} className="contents">
        <div className="hidden sm:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Task</TableHead>
                <TableHead>What it shows</TableHead>
                <TableHead>Result</TableHead>
                {details ? <TableHead>Receipts and files</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={rowKey(r)} data-testid="evidence-row" data-outcome={r.outcome}>
                  <TableCell className="align-top font-mono text-[0.78125rem] text-ink-3">{r.taskId}</TableCell>
                  <TableCell className="max-w-md align-top whitespace-normal">
                    <p className="font-medium text-ink">{taskName(r.taskId)}</p>
                    <p className="text-meta text-ink-3">
                      {rowNote(r)} · {EXPECTED_LABEL[r.expected]}
                    </p>
                  </TableCell>
                  <TableCell className="align-top">
                    <Result r={r} sample={sample} />
                  </TableCell>
                  {details ? (
                    <TableCell className="min-w-[220px] align-top whitespace-normal">
                      <Links runId={runId} r={r} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <ul className="grid gap-2 sm:hidden" aria-label="Tests and attacks">
          {rows.map((r) => (
            <li key={rowKey(r)} data-testid="evidence-card" data-outcome={r.outcome} className="grid gap-2 rounded-group bg-canvas p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="grid min-w-0 gap-0.5">
                  <p className="text-callout font-medium text-pretty text-ink">{taskName(r.taskId)}</p>
                  <p className="text-footnote text-ink-3">
                    <span className="font-mono">{r.taskId}</span> · {rowNote(r)}
                  </p>
                </div>
                <Result r={r} sample={sample} />
              </div>
              {details ? <Links runId={runId} r={r} /> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
