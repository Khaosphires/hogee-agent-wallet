import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An inset grouped list (iOS Settings; DESIGN.md §12): a white rounded group on the canvas, one row per item, hairline
 * separators that start where the text starts (past the icon tile), an optional short header above and a footnote
 * below. Use it instead of loose text blocks wherever a page lists things of one kind: pockets, payments, receipts,
 * settings, checks.
 *
 *   <GroupedList header="Pockets" footer="Your wallet pays only from these, up to their limits.">
 *     <ListRow leading={<IconTile icon={Package} tone="slot-1" />} title="Supplier" subtitle="Paid in steps"
 *       value={<Money minor="500000" />} href="#plan-pockets" />
 *   </GroupedList>
 *
 * Inside a card, pass `inset={false}`: the rows lose the group's own surface and sit flush with the card's padding.
 */
type GroupedListProps = Omit<React.ComponentProps<"section">, "title"> & {
  /** A short label above the group (13 px, ink-2, sentence case). */
  header?: React.ReactNode;
  /** Something on the header's right, e.g. a "See all" link. */
  headerAction?: React.ReactNode;
  /** One short line under the group (13 px, ink-3). */
  footer?: React.ReactNode;
  /** false: no surface of its own (inside a card). */
  inset?: boolean;
  /** Names the list for assistive tech when there is no visible header. */
  "aria-label"?: string;
};

function GroupedList({ header, headerAction, footer, inset = true, className, children, "aria-label": ariaLabel, ...props }: GroupedListProps) {
  const headerId = React.useId();
  return (
    <section data-slot="grouped-list" aria-labelledby={header ? headerId : undefined} aria-label={header ? undefined : ariaLabel} className={cn("grid gap-1.5", className)} {...props}>
      {header || headerAction ? (
        <div className="flex min-h-6 items-end justify-between gap-3 px-4">
          {header ? (
            <h3 id={headerId} className="text-footnote font-medium text-ink-2">
              {header}
            </h3>
          ) : (
            <span />
          )}
          {headerAction}
        </div>
      ) : null}
      <ul role="list" data-inset={inset || undefined} className={cn("grid overflow-hidden", inset ? "rounded-group bg-raised shadow-card" : "-mx-4 sm:-mx-5")}>
        {children}
      </ul>
      {footer ? <p className="px-4 text-footnote text-pretty text-ink-3">{footer}</p> : null}
    </section>
  );
}

type RowAction =
  | { href: string; onClick?: never; external?: boolean }
  | { onClick: React.MouseEventHandler<HTMLButtonElement>; href?: never; external?: never }
  | { href?: never; onClick?: never; external?: never };

type ListRowProps = Omit<React.ComponentProps<"li">, "title" | "onClick" | "value"> &
  RowAction & {
    /** An <IconTile>, an avatar, a seal: 30 px reads best. */
    leading?: React.ReactNode;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    /** The value on the right (a <Money>, a count, a state word): 15 px, tabular. */
    value?: React.ReactNode;
    /** Anything after the value, e.g. a <Pill>. */
    trailing?: React.ReactNode;
    /** The disclosure chevron. Defaults to true for a link or a button row. */
    chevron?: boolean;
    /** Marks the current item (the section in view, a chosen filter): a fill, a heavier title and aria-current. */
    selected?: boolean;
    disabled?: boolean;
  };

/** The interactive part (when there is one) carries the whole row's surface, hover and press. */
const ROW_SURFACE = [
  "group/row relative flex w-full min-w-0 items-stretch gap-3 pl-4 text-left outline-none",
  "transition-[background-color] duration-(--dur-state) ease-settle",
  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
].join(" ");
const ROW_INTERACTIVE = "cursor-pointer hover:bg-fill active:bg-fill-strong active:duration-0 aria-disabled:pointer-events-none aria-disabled:opacity-50";

function ListRow({
  leading,
  title,
  subtitle,
  value,
  trailing,
  chevron,
  selected = false,
  disabled = false,
  href,
  external = false,
  onClick,
  className,
  ...props
}: ListRowProps) {
  const interactive = href !== undefined || onClick !== undefined;
  const showChevron = chevron ?? interactive;

  const body = (
    <>
      {leading ? <span className="flex shrink-0 items-center py-2">{leading}</span> : null}
      {/* The separator is this column's bottom edge, so it starts where the text starts (inset past the tile). */}
      <span className="flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2.5 pr-4 shadow-[inset_0_-1px_0_var(--separator)] group-last/item:shadow-none">
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className={cn("line-clamp-2 text-callout text-pretty text-ink", selected && "font-semibold")}>{title}</span>
          {subtitle ? <span className="text-footnote text-pretty text-ink-3">{subtitle}</span> : null}
        </span>
        {value !== undefined && value !== null ? <span className="shrink-0 text-callout text-ink-2 tabular-nums">{value}</span> : null}
        {trailing}
        {showChevron ? (
          <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-4 transition-[translate] duration-(--dur-state) ease-settle group-hover/row:translate-x-0.5" />
        ) : null}
      </span>
    </>
  );

  let row: React.ReactNode;
  if (href !== undefined) {
    const linkProps = external ? { target: "_blank", rel: "noreferrer" } : {};
    row = (
      <Link href={href} aria-current={selected || undefined} aria-disabled={disabled || undefined} className={cn(ROW_SURFACE, ROW_INTERACTIVE)} {...linkProps}>
        {body}
      </Link>
    );
  } else if (onClick !== undefined) {
    row = (
      <button type="button" onClick={onClick} disabled={disabled} aria-current={selected || undefined} className={cn(ROW_SURFACE, ROW_INTERACTIVE, "disabled:pointer-events-none disabled:opacity-50")}>
        {body}
      </button>
    );
  } else {
    row = <div className={ROW_SURFACE}>{body}</div>;
  }

  return (
    <li data-slot="list-row" data-selected={selected || undefined} className={cn("group/item", selected && "bg-fill", className)} {...props}>
      {row}
    </li>
  );
}

export { GroupedList, ListRow };
export type { GroupedListProps, ListRowProps };
