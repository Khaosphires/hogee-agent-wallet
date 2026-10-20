"use client";

/**
 * Small pieces the Wallet page and the chat's money card share: tiles (each with its exact [data-minor] or data-value,
 * and a "Sample" tag on figures built on sample sales), notes, what Hogee's AI changed (cobalt: what the wallet did
 * alone, with its receipt), the disclaimer and the data label (DESIGN.md §7, §8; UX-PLAN D8, D13).
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Info, TrendingDown } from "lucide-react";
import { z } from "zod";
import { CFO_DISCLAIMER, type CfoAgentAction, type CfoInsight } from "@hogee/core";
import { Money } from "@/components/ledger/money";
import { TxHash } from "@/components/ledger/hash";
import { Pill } from "@/components/ui/pill";
import { useSession } from "@/lib/api/use-session";
import { localDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { agentActionText, dataLabel, isSample, SAMPLE_SENTENCE, type CfoTile, type PocketLine } from "./cfo-model";

const noSubscribe = () => () => undefined;

/**
 * The session as read on the client only (the server HTML never carries it, so hydration matches): sample labels
 * render after mount.
 */
function useClientSession() {
  const session = useSession().data;
  const onClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  return onClient ? session : undefined;
}

/** True when the report's sales are a sample (mock and replay mode, or a local chain's demo history). */
export function useSampleSales(): boolean {
  return isSample(useClientSession());
}

/** The mock-only switch's state (GET /api/demo/sample-business), read under a key of its own: only `on` and `scenario` matter here. */
const SampleBusinessState = z.object({ on: z.boolean(), scenario: z.string().nullable() });
const SAMPLE_BUSINESS_KEY = ["wallet", "sampleBusiness"] as const;

async function readSampleBusiness(signal: AbortSignal): Promise<z.infer<typeof SampleBusinessState>> {
  const res = await fetch("/api/demo/sample-business", { credentials: "same-origin", cache: "no-store", signal });
  if (!res.ok) throw new Error(`sample business state unavailable (${res.status})`);
  return SampleBusinessState.parse(await res.json());
}

export interface SampleScope {
  /** Everything on the page is sample (the Sample business): one page-level label, no tag on any figure. */
  readonly page: boolean;
  /** Sample sales sit beside real records (mock fresh or default, replay, a local chain): a "Sample" tag on each figure built on sales. */
  readonly figures: boolean;
}

/**
 * Where the word "Sample" goes (UX round 3, Steve #14; P1's "always labelled" rule): one page-level label when the page
 * is all sample, per-figure tags only where real and sample figures sit side by side. The Sample business is known
 * from the mock's own switch (mock mode only); until that answer is in, no figure is tagged, so the tags never flash.
 */
export function useSampleScope(): SampleScope {
  const session = useClientSession();
  const sample = isSample(session);
  const mock = session?.mode === "mock";
  const state = useQuery({ queryKey: SAMPLE_BUSINESS_KEY, queryFn: ({ signal }) => readSampleBusiness(signal), enabled: mock, staleTime: 60_000, retry: false });
  const page = mock && state.data?.on === true && state.data.scenario === "lived";
  const known = !mock || state.isSuccess || state.isError;
  return { page, figures: sample && known && !page };
}

function TileValue({ tile, hero }: { tile: CfoTile; hero: boolean }) {
  if (tile.value === null) {
    return (
      <span className="text-ink-3" aria-label="Loading">
        …
      </span>
    );
  }
  if (tile.unit === "count") return <span data-value={tile.value}>{tile.value}</span>;
  if (tile.unit === "days") return <span data-value={tile.value}>{tile.value} days</span>;
  if (tile.unit === "pct") return <span data-value={tile.value}>{(Number(tile.value) / 100).toFixed(1)}%</span>;
  return <Money minor={tile.value} figure={hero ? "hero" : "inline"} />;
}

/** The "Sample" tag: a figure built on sample sales is never shown as real (UX-PLAN D13). */
export function SampleTag() {
  return (
    <Pill tone="outline" icon={null} data-testid="cfo-sample-tag" className="h-5 px-1.5 text-[0.6875rem]">
      Sample
    </Pill>
  );
}

/**
 * Figures: label above, value below. On the page (`lead`) the first tile is the view's one hero figure (Ready to spend,
 * the same number as the chat's wallet), and spans the row on a phone.
 */
export function CfoTiles({ tiles, compact = false, lead = false }: { tiles: readonly CfoTile[]; compact?: boolean; lead?: boolean }) {
  const sample = useSampleSales();
  return (
    <dl className={cn("grid gap-3", compact ? "grid-cols-2" : lead ? "grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]" : "grid-cols-2 md:grid-cols-3")}>
      {tiles.map((t, i) => {
        const hero = lead && i === 0;
        return (
          <div
            key={t.key}
            data-testid={`cfo-tile-${t.key}`}
            className={cn(
              "flex min-w-0 flex-col gap-1 rounded-lg",
              compact ? "bg-muted/60 px-3 py-2.5" : "bg-card px-4 py-3 shadow-card",
              lead && !hero && "max-sm:px-3",
              hero && "col-span-3 justify-between py-4 lg:col-span-1",
            )}
          >
            <dt className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {t.label}
              {t.sample && sample ? <SampleTag /> : null}
            </dt>
            <dd className={cn("font-medium tracking-tight [font-variant-numeric:proportional-nums]", compact ? "text-base" : hero ? "" : lead ? "text-base sm:text-xl" : "text-xl")}>
              <TileValue tile={t} hero={hero} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const SUGGESTION_TEXT = {
  REQUEST_MOVE: "Ask your loan officer to move money",
  REQUEST_STAGE_RELEASE: "Ask for the next budget release",
  TIGHTEN: "Is this spending planned? Ask for a higher limit",
} as const;

/** Notes: a warning gets the alert icon and word, never colour alone. */
export function CfoInsights({ insights }: { insights: readonly CfoInsight[] }) {
  if (insights.length === 0) return null;
  return (
    <ul className="grid gap-2" aria-label="What Hogee noticed">
      {insights.map((i) => (
        <li key={i.insightId} data-testid="cfo-insight" data-kind={i.kind} className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 rounded-lg bg-muted/60 px-3.5 py-3 text-sm">
          {i.severity === "warn" ? <CircleAlert aria-hidden className="mt-0.5 size-4 text-waiting" /> : <Info aria-hidden className="mt-0.5 size-4 text-muted-foreground" />}
          <p className="font-medium text-pretty">
            {i.severity === "warn" ? <span className="sr-only">Warning: </span> : null}
            {i.title}
          </p>
          <p className="col-start-2 text-pretty text-muted-foreground">{i.detail}</p>
          {i.suggestion?.href ? (
            <a href={i.suggestion.href} className="col-start-2 mt-1 w-fit text-sm font-medium underline-offset-4 hover:underline">
              {SUGGESTION_TEXT[i.suggestion.kind]}
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** What Hogee's AI changed by itself: only ever a stricter limit, each with the reason and its receipt. */
export function AgentActions({ actions, currency }: { actions: readonly CfoAgentAction[]; currency?: string }) {
  return (
    <section aria-labelledby="agent-actions-title" className="grid gap-2">
      <h3 id="agent-actions-title" className="text-sm font-semibold">
        What Hogee&apos;s AI changed by itself
      </h3>
      {actions.length === 0 ? (
        <p className="text-sm text-pretty text-muted-foreground">Nothing yet. The AI can only make limits stricter. Raising a limit needs your signature and your loan officer&apos;s.</p>
      ) : (
        <ul className="grid gap-2">
          {actions.map((a) => (
            <li key={`${a.at}-${a.action}-${a.lineKey ?? ""}`} data-testid="agent-action" className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 rounded-lg bg-agent-wash px-3.5 py-3 text-sm">
              <TrendingDown aria-hidden className="mt-0.5 size-4 text-agent" />
              <p className="font-medium text-agent">{agentActionText(a)}</p>
              <p className="col-start-2 text-muted-foreground">{a.reason}</p>
              <p className="col-start-2 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                <time dateTime={a.at}>{localDateTime(a.at, currency)}</time>
                {a.txHash ? <TxHash hash={a.txHash} /> : <span>Receipt not ready yet</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CfoDisclaimer({ className }: { className?: string }) {
  return (
    <p data-testid="cfo-disclaimer" className={cn("text-xs text-muted-foreground", className)}>
      {CFO_DISCLAIMER}
    </p>
  );
}

/** The page-level label: an outline pill naming sample or demo data (nothing on a public chain); rendered on the client only. */
export function CfoDataLabel() {
  const label = dataLabel(useClientSession());
  if (!label) return null;
  return (
    <Pill tone="outline" icon={null} data-testid="cfo-data-label">
      {label}
    </Pill>
  );
}

/**
 * A pocket's subtitle on every page (UX round 3; first-timer #24): "750 BU paid · 1,750 BU set aside · of 5,000 BU",
 * the zero parts left out ("of 1,000 BU" for an untouched pocket); "Paused" first when the pocket can't pay. Its value
 * ("2,500 BU left") and ring are PocketRow's. `line` comes from cfo-model pocketLine.
 */
export function PocketSubtitle({ line, paused = false }: { line: PocketLine; paused?: boolean }) {
  const parts: ReactNode[] = [];
  if (paused) parts.push(<span className="font-medium text-waiting">Paused</span>);
  if (line.paidMinor !== null && line.paidMinor !== "0") parts.push(<><Money minor={line.paidMinor} /> paid</>);
  if (line.setAsideMinor !== null && line.setAsideMinor !== "0") parts.push(<><Money minor={line.setAsideMinor} /> set aside</>);
  parts.push(<>of <Money minor={line.allocatedMinor} /></>);
  return (
    <span data-testid="pocket-subtitle">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? " · " : null}
          <span className="whitespace-nowrap">{p}</span>
        </span>
      ))}
    </span>
  );
}

/** "These are sample sales for the demo, not real orders." whenever the sales are a sample (never hidden). */
export function SampleSentence({ className }: { className?: string }) {
  if (!useSampleSales()) return null;
  return (
    <p data-testid="cfo-sample-note" className={cn("text-sm text-pretty text-ink-2", className)}>
      {SAMPLE_SENTENCE}
    </p>
  );
}
