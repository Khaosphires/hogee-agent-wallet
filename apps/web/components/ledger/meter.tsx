import { cn } from "@/lib/utils";

/**
 * A single ratio against a limit (dataviz: meter): an 8 px rounded bar on an ink-fill track that is the limit. The fill is ink-2 and turns
 * saffron from 70% and crimson from 90%, and the label always states the numbers, so the state is never colour alone.
 */
export function Meter({ pct, label, className }: { pct: number; label: string; className?: string }) {
  const tone = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "accent";
  const fill = { accent: "bg-ink", warning: "bg-waiting-dot", danger: "bg-blocked" }[tone];
  return (
    <div className={cn("space-y-1.5", className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        data-tone={tone}
        className="h-2 w-full overflow-hidden rounded-full bg-fill-strong"
      >
        {/* Width, not scale: a scaled bar squashes its round end. It is set once per render and never animated. */}
        <div className={cn("h-full rounded-full", fill)} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 2 : 0, pct))}%` }} />
      </div>
      <p className="text-caption text-ink-2">{label}</p>
    </div>
  );
}
