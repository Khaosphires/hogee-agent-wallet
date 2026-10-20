import * as React from "react";
import { Bot, Check, Clock, Info, OctagonAlert, Pause } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * State pills (DESIGN.md §3, §9). Each state has one tone and a default mark (a dot or an icon) so it never relies on
 * colour alone:
 *
 * | tone      | means                               | mark      |
 * |-----------|-------------------------------------|-----------|
 * | waiting   | only Mei can act ("Waiting on you") | dot       |
 * | signed    | Mei signed (the seal is elsewhere)  | check     |
 * | paid      | money landed                        | check     |
 * | agent     | the wallet acts alone ("Agent pays")| bot       |
 * | cooling   | an agent payment in its cooling time| clock     |
 * | blocked   | refused, say why next to it         | octagon   |
 * | neutral   | stopped, inactive                   | pause     |
 * | outline   | a caveat ("Unverified", "Demo data")| none      |
 *
 * Pass `icon` to swap the mark, or `icon={null}` for none (outline and neutral labels only).
 *
 * Capsules (ux2, DESIGN.md §12): 24 px, 12 px semibold, the tone's tint as fill. Signed and neutral sit on the ink fill.
 */
export type PillTone = "waiting" | "signed" | "paid" | "agent" | "cooling" | "blocked" | "neutral" | "outline";

const TONE: Record<PillTone, string> = {
  waiting: "bg-waiting-wash text-waiting",
  signed: "bg-fill-strong text-ink",
  paid: "bg-paid-wash text-paid",
  agent: "bg-agent-wash text-agent",
  cooling: "bg-agent-wash text-agent",
  blocked: "bg-blocked-wash text-blocked",
  neutral: "bg-fill text-ink-2",
  outline: "font-medium text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)]",
};

const ICON = "size-[13px] shrink-0";

function WaitingDot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-waiting-dot shadow-[0_0_0_1px_oklch(0.6_0.12_80/0.35)]" />;
}

const DEFAULT_MARK: Record<PillTone, React.ReactNode> = {
  waiting: <WaitingDot />,
  signed: <Check aria-hidden className={ICON} />,
  paid: <Check aria-hidden className={ICON} />,
  agent: <Bot aria-hidden className={ICON} />,
  cooling: <Clock aria-hidden className={ICON} />,
  blocked: <OctagonAlert aria-hidden className={ICON} />,
  neutral: <Pause aria-hidden className={ICON} />,
  outline: null,
};

type PillProps = React.ComponentProps<"span"> & {
  tone: PillTone;
  /** Replaces the tone's default mark; null shows none. */
  icon?: React.ReactNode;
};

function Pill({ tone, icon, className, children, ...props }: PillProps) {
  const mark = icon === undefined ? DEFAULT_MARK[tone] : icon;
  return (
    <span
      data-slot="pill"
      data-tone={tone}
      className={cn(
        "inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 text-meta font-semibold whitespace-nowrap [&>svg]:size-[13px] [&>svg]:shrink-0",
        TONE[tone],
        className,
      )}
      {...props}
    >
      {mark}
      {children}
    </span>
  );
}

/** The outline "Unverified web supplier" pill with its info mark. */
function UnverifiedPill({ children = "Unverified web supplier", ...props }: Omit<PillProps, "tone">) {
  return (
    <Pill tone="outline" icon={<Info aria-hidden className={ICON} />} {...props}>
      {children}
    </Pill>
  );
}

/** A 20 px tag: "AI-drafted", "+300", "v2". Text, never a state. */
function Tag({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="tag"
      className={cn("inline-flex h-5 w-fit shrink-0 items-center rounded-sm bg-fill-strong px-[7px] text-[0.71875rem] font-medium tracking-[0.01em] whitespace-nowrap text-ink-2", className)}
      {...props}
    />
  );
}

export { Pill, Tag, UnverifiedPill };
export type { PillProps };
