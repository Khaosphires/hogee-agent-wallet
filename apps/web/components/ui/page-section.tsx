import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one page head and section frame every page uses (UX round 3, DESIGN.md §12): the large title, at most one short
 * line under it, and an optional control on the right; then sections with a 22 px heading. The side nav jumps to a
 * section by its `id` (lib/sections.ts), so every listed section is a PageSection.
 */
export function PageHead({ title, line, aside, className }: { title: ReactNode; line?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="grid min-w-0 gap-1">
        <h1 className="text-large-title text-ink">{title}</h1>
        {line ? <p className="max-w-[68ch] text-footnote text-pretty text-ink-2">{line}</p> : null}
      </div>
      {aside}
    </header>
  );
}

export function PageSection({
  id,
  title,
  line,
  aside,
  hideTitle = false,
  className,
  children,
}: {
  id: string;
  title: string;
  line?: ReactNode;
  aside?: ReactNode;
  /** The heading stays for assistive tech and the nav, but isn't drawn (e.g. a hero that names itself). */
  hideTitle?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("grid min-w-0 scroll-mt-20 content-start gap-3", className)}>
      <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-1", hideTitle && "sr-only")}>
        <div className="grid min-w-0 gap-0.5">
          <h2 id={`${id}-title`} className="text-title-2 text-ink">
            {title}
          </h2>
          {line ? <p className="text-footnote text-pretty text-ink-2">{line}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
