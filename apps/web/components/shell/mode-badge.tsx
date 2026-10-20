"use client";

import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/use-session";
import { useRecording } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { badgeDeployment, deploymentTitle, modeLabel } from "./mode-deployment";

/** In REPLAY: the one bundle the server replays (it lists only that run), read once; nothing is fetched otherwise. */
function useReplayedManifest(replay: boolean) {
  const runs = useApiQuery("listEvidenceRuns", undefined, { poll: false, enabled: replay });
  const runId = replay && runs.data?.length === 1 ? runs.data[0]?.runId : undefined;
  return useApiQuery("getEvidenceRun", runId ? { params: { runId } } : undefined, { poll: false, enabled: Boolean(runId) }).data?.manifest;
}

/**
 * The data label (UX-PLAN D12): "Sample data", "Sepolia test network" or "Recording (offline)", an outline pill in
 * the quick settings and on Settings › Demo. The mode always comes from GET /api/session, never from a frontend flag (ROLE-P2 A.3 rule 2). The
 * blockchain and app version are hover text only (K15), and recording mode drops even that; the label itself always
 * shows. In replay the app version is the replayed bundle's own (./mode-deployment.ts), not the mock session's.
 */
export function ModeBadge({ className }: { className?: string }) {
  const { data: session } = useSession();
  const recording = useRecording();
  const manifest = useReplayedManifest(session?.mode === "replay");

  if (!session) {
    return <Skeleton aria-hidden className={cn("h-6 w-24", className)} />;
  }
  const deployment = badgeDeployment(session, manifest);

  return (
    <Pill
      tone="outline"
      icon={<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", session.mode === "live" ? "bg-paid" : "bg-ink-4")} />}
      data-testid="mode-badge"
      data-mode={session.mode}
      data-deployment={deployment?.deploymentId}
      title={recording ? undefined : deploymentTitle(deployment)}
      className={className}
    >
      {modeLabel(session.mode, session.chainId)}
    </Pill>
  );
}
