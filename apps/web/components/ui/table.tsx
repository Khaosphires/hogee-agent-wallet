import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Ledger tables (DESIGN.md §9, §12): 12 px ink-3 headers, 44 px rows on hairline separators (ink at 10 %), tabular
 * numbers (right-align money cells with `text-right`), totals at 600 in <TableFooter>. A row highlights with the ink
 * fill on hover. Inside a card the first and last cells line up with the card's padding; on the canvas pass `grouped`
 * and the table becomes an inset grouped list: a white rounded group whose rows sit 16 px in from its edge.
 * Wide tables scroll inside their own container; `contain: inline-size` keeps a wide table from widening the grid or
 * flex column around it (no page-wide sideways scroll at 320 px).
 */
function Table({ className, grouped = false, ...props }: React.ComponentProps<"table"> & { grouped?: boolean }) {
  return (
    <div
      data-slot="table-container"
      data-grouped={grouped || undefined}
      className={cn(
        "relative w-full overflow-x-auto overscroll-x-contain [contain:inline-size]",
        grouped && "rounded-group bg-raised px-4 shadow-card",
      )}
    >
      <table data-slot="table" className={cn("w-full caption-bottom text-[0.84375rem] tabular-nums", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b [&_tr]:border-separator [&_tr]:hover:bg-transparent", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("border-t border-line-2 font-semibold [&>tr]:last:border-b-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-separator transition-colors duration-(--dur-state) hover:bg-fill data-[state=selected]:bg-fill-strong", className)}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn("h-9 px-3 text-left align-middle text-caption font-medium whitespace-nowrap text-ink-3 first:pl-0 last:pr-0 [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("h-11 px-3 py-2 align-middle whitespace-nowrap first:pl-0 last:pr-0 [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-4 text-caption text-ink-3", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
