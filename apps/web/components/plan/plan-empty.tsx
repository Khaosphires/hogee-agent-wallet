import Link from "next/link";
import { ArrowRight, Fingerprint, Landmark, ListChecks, MessageCircle } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { cn } from "@/lib/utils";

const STEPS = [
  { icon: MessageCircle, tone: "ink" as const, title: "Tell Hogee what you sell", line: "A few short questions in Chat." },
  { icon: ListChecks, tone: "grey" as const, title: "Check your plan here", line: "Pockets, limits and releases, set by fixed rules." },
  { icon: Fingerprint, tone: "grey" as const, title: "Sign it with your passkey", line: "Nothing is paid before you sign." },
];

/**
 * Before the chat has drafted Mei's plan (first-time-user review #5; the user: "when there is no example data, there
 * are still numbers"): no figures at all, what happens next in three steps, and the way to Chat.
 */
export function PlanEmpty() {
  return (
    <Card className="gap-5 px-5 py-6 sm:px-7 sm:py-7" data-testid="plan-empty">
      <div className="grid gap-1">
        <p className="text-title-3 text-ink">No plan yet</p>
        <p className="text-subhead text-pretty text-ink-2">Tell Hogee what you sell in Chat, and your plan shows here.</p>
      </div>
      <GroupedList aria-label="How your plan is made" inset={false}>
        {STEPS.map((s, i) => (
          <ListRow
            key={s.title}
            leading={<IconTile icon={s.icon} tone={s.tone} variant={i === 0 ? "solid" : "tinted"} />}
            title={
              <>
                <span className="sr-only">Step {i + 1}: </span>
                {s.title}
              </>
            }
            subtitle={s.line}
            value={<span aria-hidden className="text-footnote font-semibold text-ink-4">{i + 1}</span>}
          />
        ))}
      </GroupedList>
      <Link href="/chat" className={cn(buttonVariants({ size: "lg" }), "w-fit rounded-full")} data-testid="plan-empty-chat">
        Start in Chat
        <ArrowRight aria-hidden />
      </Link>
    </Card>
  );
}

/**
 * The loan officer opened Mei's plan page: drafting and signing are hers alone (POST /api/plans/draft is founder-only),
 * so instead of the API's refusal the page says where the officer's view of her plan lives.
 */
export function PlanForOfficer() {
  return (
    <Card className="gap-4 px-5 py-6 sm:px-7" data-testid="plan-officer">
      <div className="flex items-start gap-3.5">
        <IconTile icon={Landmark} tone="ink" size="lg" />
        <div className="grid min-w-0 gap-1">
          <p className="text-headline text-ink">This page is the founder&apos;s</p>
          <p className="text-subhead text-pretty text-ink-2">She drafts and signs her plan here. Her signed plan, its releases and what waits on you are on your loan officer page.</p>
        </div>
      </div>
      <Link href="/officer" className={cn(buttonVariants({ variant: "secondary" }), "w-fit")} data-testid="plan-officer-link">
        Open the loan officer page
        <ArrowRight aria-hidden />
      </Link>
    </Card>
  );
}
