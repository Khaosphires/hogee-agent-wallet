"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { PROOF_TABS, isActiveRoute } from "./routes";

/**
 * The Proof area's one shared header (UX-PLAN D9): "Checks" (/evidence) and "Activity record" (/timeline), each its
 * own route. Links, not ARIA tabs, since each is a page; they look like the underline tabs (DESIGN.md §8, 44 px).
 */
export function ProofTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Proof" data-testid="proof-tabs" className="flex w-full max-w-full items-end gap-0.5 overflow-x-auto shadow-[inset_0_-1px_0_var(--line)] [scrollbar-width:none]">
      {PROOF_TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={isActiveRoute(pathname, tab.href) ? "page" : undefined}
          className={cn(
            "relative inline-flex h-11 shrink-0 items-center px-3 text-ui font-medium whitespace-nowrap text-ink-2 outline-none",
            "transition-[color,scale] duration-(--dur-state) ease-settle hover:text-ink aria-[current=page]:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
            "active:scale-(--press) active:text-ink active:duration-(--dur-press)",
            "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:origin-center after:scale-x-0 after:rounded-full after:bg-ink after:transition-transform after:duration-(--dur-state) after:ease-settle after:content-['']",
            "aria-[current=page]:after:scale-x-100",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
