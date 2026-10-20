import type { ReactNode } from "react";
import { OctagonAlert } from "lucide-react";
import { errorCopy } from "@hogee/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiClientError } from "@/lib/api/client";

const WIDTHS = ["72%", "90%", "54%", "82%", "64%", "88%"] as const;

/**
 * Loading (DESIGN.md §9, §12): sunk-2 lines with the skeleton's slow light sweep (still under reduced motion), plus one
 * status line that says what is happening ("Reading pages, 14 so far").
 */
export function LoadingBlock({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="grid gap-2.5 py-1" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-2.5" style={{ width: WIDTHS[i % WIDTHS.length] }} />
      ))}
      <p className="pt-1 text-[0.78125rem] text-ink-3" aria-hidden>
        {label}…
      </p>
    </div>
  );
}

/** An API error in plain English (errors/copy.ts), with the server's message as detail. */
export function ErrorBlock({ error, what }: { error: ApiClientError | null; what: string }) {
  if (!error) return null;
  const copy = errorCopy(error.code);
  return (
    <Alert variant="destructive">
      <OctagonAlert />
      <AlertTitle>
        Couldn&apos;t load {what}: {copy.title}
      </AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * A refresh failed while the last data is still on screen (fix-cfo-load): one quiet line, never the red error, which
 * is for a page with no data at all. Nothing to show while the last refresh succeeded.
 */
export function RefreshNote({ error, what }: { error: ApiClientError | null; what: string }) {
  if (!error) return null;
  return (
    <p role="status" className="text-meta text-pretty text-ink-3" data-testid="refresh-note">
      Couldn&apos;t refresh just now. Showing the last {what}; it retries by itself.
    </p>
  );
}

/**
 * Empty (DESIGN.md §9, §12): an icon on a 40 px tinted tile, a 17 px title, one sentence, one action.
 *
 *   <EmptyState icon={<Search />} title="No suppliers yet" action={<Button variant="secondary">Find suppliers</Button>}>
 *     Tell Hogee what you want to make and how many.
 *   </EmptyState>
 */
export function EmptyState({ icon, title, children, action, testId }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="grid justify-items-start gap-1" data-testid={testId}>
      <span aria-hidden className="mb-2 grid size-10 place-items-center rounded-[10px] bg-tint-ink text-ink-2 [&_svg]:size-5">
        {icon}
      </span>
      <p className="text-title">{title}</p>
      <p className="max-w-[60ch] text-footnote text-pretty text-ink-2">{children}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
