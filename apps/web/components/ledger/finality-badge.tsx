import type { PaymentState } from "@hogee/core";
import { Clock } from "lucide-react";
import { Pill, type PillTone } from "@/components/ui/pill";

type Tone = "pending" | "safe" | "finalized" | "failed";

/** Payment state → finality badge (project.md §12.3: the badge moves at `safe`, settlement uses `finalized`). */
const STATE_BADGE: Record<PaymentState, { label: string; tone: Tone }> = {
  PROPOSED: { label: "Planned", tone: "pending" },
  POLICY_OK: { label: "Checked", tone: "pending" },
  SIGNED: { label: "Signed", tone: "pending" },
  BROADCAST: { label: "Sending", tone: "pending" },
  INCLUDED: { label: "Confirmed", tone: "safe" },
  FINALIZED: { label: "Final", tone: "finalized" },
  SETTLEMENT_REQUESTED: { label: "Final · bank transfer sent", tone: "finalized" },
  SETTLEMENT_FAILED: { label: "Bank transfer failed", tone: "failed" },
  SETTLED: { label: "Final · paid out", tone: "finalized" },
  POLICY_DENIED: { label: "Blocked by your rules", tone: "failed" },
  REVERTED: { label: "Rejected by the blockchain", tone: "failed" },
  DROPPED: { label: "Not sent", tone: "pending" },
  CANCELLED: { label: "Cancelled", tone: "failed" },
};

// Paid means money landed: both finality steps after inclusion; pending is neutral with a clock; refused is blocked.
const PILL: Record<Tone, PillTone> = { pending: "neutral", safe: "paid", finalized: "paid", failed: "blocked" };

export function FinalityBadge({ state, className }: { state: PaymentState; className?: string }) {
  const { label, tone } = STATE_BADGE[state];
  return (
    <Pill
      tone={PILL[tone]}
      icon={tone === "pending" ? <Clock aria-hidden className="size-[13px]" /> : undefined}
      data-state={state}
      data-tone={tone}
      className={className}
    >
      {label}
    </Pill>
  );
}
