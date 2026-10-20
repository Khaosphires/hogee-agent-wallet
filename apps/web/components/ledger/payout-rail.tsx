import { payoutRailLabel } from "@/lib/payout-rail";
import { cn } from "@/lib/utils";

/** How the facility's payees are paid, when the UI rule names a rail (lib/payout-rail.ts). The dashed edge marks it simulated. */
export function PayoutRail({ currency, className }: { currency: string | undefined; className?: string }) {
  const label = payoutRailLabel(currency);
  if (!label) return null;
  return (
    <span
      data-slot="badge"
      data-testid="payout-rail"
      className={cn("inline-flex h-6 w-fit shrink-0 items-center rounded-full border border-dashed border-line-2 px-2.5 text-meta whitespace-nowrap text-ink-2", className)}
    >
      {label}
    </span>
  );
}
