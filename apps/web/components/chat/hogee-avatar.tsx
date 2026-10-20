import { Seal } from "@/components/ledger/seal";
import { cn } from "@/lib/utils";

/** Hogee's avatar beside its replies: the brand's ink chop "H" (cinnabar is only ever a signature). */
export function HogeeAvatar({ className }: { readonly className?: string }) {
  return <Seal tone="ink" letter="H" className={cn("size-7 rounded-[8px] text-[0.8125rem] font-semibold", className)} />;
}
