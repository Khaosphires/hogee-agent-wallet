"use client";

import Link from "next/link";
import { Seal } from "@/components/ledger/seal";
import { useSession } from "@/lib/api/use-session";
import { cn } from "@/lib/utils";
import { homeFor } from "./routes";

/** The brand: an ink chop "H" (cinnabar is only ever a signature) and the name, linking to the persona's home. */
export function BrandLink({ className, onClick }: { className?: string; onClick?: () => void }) {
  const { data: session } = useSession();
  const home = session ? homeFor(session.persona) : "/";

  return (
    <Link
      href={home}
      aria-label="Hogee, home"
      onClick={onClick}
      className={cn(
        "flex min-h-10 shrink-0 items-center gap-2.5 rounded-md pr-1 text-[0.9375rem] font-semibold tracking-[-0.02em] text-ink outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      <Seal tone="ink" letter="H" className="size-[22px] rounded-[6px]" />
      Hogee
    </Link>
  );
}
