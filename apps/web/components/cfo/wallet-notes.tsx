"use client";

/**
 * "What Hogee noticed" on the Wallet page (UX2 brief §2), in the ui grouped list: each note is one short row (an icon
 * tile and its title), and its detail and suggestion open behind a press (a <details> row, the list's own separator and
 * press states). A warning wears the alert glyph in the waiting tone and says "Warning" to a screen reader, so it never
 * relies on colour alone.
 */
import { ArrowLeftRight, ChevronRight, CircleAlert, Flame, Hourglass, Landmark, Target, type LucideIcon } from "lucide-react";
import type { CfoInsight } from "@hogee/core";
import { GroupedList } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import type { Tone } from "@/components/ui/tones";

const KIND_LOOK: Readonly<Record<CfoInsight["kind"], { icon: LucideIcon; tone: Tone }>> = {
  BURN_ALERT: { icon: Flame, tone: "waiting" },
  RUNWAY_SHORT: { icon: Hourglass, tone: "waiting" },
  STAGE2_ON_TRACK: { icon: Target, tone: "paid" },
  STAGE2_AT_RISK: { icon: Target, tone: "waiting" },
  RESERVE_STATUS: { icon: Landmark, tone: "ink" },
  MOVE_BUDGET: { icon: ArrowLeftRight, tone: "ink" },
};

const SUGGESTION_TEXT = {
  REQUEST_MOVE: "Ask your loan officer to move money",
  REQUEST_STAGE_RELEASE: "Ask for the next budget release",
  TIGHTEN: "Is this spending planned? Ask for a higher limit",
} as const;

/** The ui ListRow's surface for a row that opens in place (ui/grouped-list ROW_SURFACE + its press states). */
const SUMMARY =
  "group/row flex w-full min-w-0 cursor-pointer list-none items-stretch gap-3 pl-4 text-left outline-none transition-[background-color] duration-(--dur-state) ease-settle hover:bg-fill active:bg-fill-strong active:duration-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden";

function NoteRow({ note }: { note: CfoInsight }) {
  const warn = note.severity === "warn";
  const look = KIND_LOOK[note.kind];
  return (
    <li data-slot="list-row" data-testid="cfo-insight" data-kind={note.kind} className="group/item">
      <details className="group">
        <summary className={SUMMARY}>
          <span className="flex shrink-0 items-center py-2">
            <IconTile icon={warn ? CircleAlert : look.icon} tone={warn ? "waiting" : look.tone} />
          </span>
          <span className="flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2.5 pr-4 shadow-[inset_0_-1px_0_var(--separator)] group-last/item:shadow-none group-open:shadow-none">
            <span className="min-w-0 flex-1 text-callout text-pretty text-ink">
              {warn ? <span className="sr-only">Warning: </span> : null}
              {note.title}
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-4 transition-transform duration-(--dur-state) ease-settle group-open:rotate-90" />
          </span>
        </summary>
        <div className="grid gap-2 pr-4 pb-3.5 pl-[3.625rem] shadow-[inset_0_-1px_0_var(--separator)] group-last/item:shadow-none">
          <p className="text-footnote text-pretty text-ink-2">{note.detail}</p>
          {note.suggestion?.href ? (
            <a href={note.suggestion.href} className="w-fit text-footnote font-medium text-ink underline decoration-line-2 underline-offset-[3px] hover:decoration-ink">
              {SUGGESTION_TEXT[note.suggestion.kind]}
            </a>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** The notes as a grouped list; nothing at all when there are none (the caller says "all clear" if it wants to). */
export function NoteRows({ notes, label = "What Hogee noticed", header, className }: { notes: readonly CfoInsight[]; label?: string; header?: string; className?: string }) {
  if (notes.length === 0) return null;
  return (
    <GroupedList aria-label={label} header={header} className={className}>
      {notes.map((n) => (
        <NoteRow key={n.insightId} note={n} />
      ))}
    </GroupedList>
  );
}
