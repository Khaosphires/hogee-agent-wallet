import { useId, type ReactNode } from "react";
import { Card, CardContent, CardStub } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import type { Tone } from "@/components/ui/tones";

type Icon = LucideIcon;

/**
 * Every chat card's head (ux2: one anatomy for all cards): a coloured icon tile, the title, one short line, and at
 * most one pill or action on the right (under 440 px it drops under the title, so a phone keeps the title's width).
 * The tile's colour means something: the supplier pocket's own colour for supplier things, ink for Hogee's plan,
 * waiting for Mei's turn, seal once she signed, paid for money in or done.
 */
export function CardHead({
  icon,
  tone,
  title,
  titleId,
  subtitle,
  badge,
  className,
}: {
  readonly icon: Icon;
  readonly tone: Tone;
  readonly title: ReactNode;
  /** The id the card's region is labelled by (the h3 carries it). */
  readonly titleId?: string;
  readonly subtitle?: ReactNode;
  readonly badge?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="card-header"
      className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 px-4 sm:px-5 min-[440px]:has-data-[slot=card-action]:grid-cols-[auto_minmax(0,1fr)_auto]", className)}
    >
      <IconTile icon={icon} tone={tone} className="row-span-2" />
      <div data-slot="card-title" className="min-h-[30px] self-center pt-px text-title text-balance">
        <h3 id={titleId}>{title}</h3>
      </div>
      {badge ? (
        <div data-slot="card-action" className="col-start-2 row-start-3 mt-1.5 justify-self-start min-[440px]:col-start-3 min-[440px]:row-span-2 min-[440px]:row-start-1 min-[440px]:mt-0.5 min-[440px]:justify-self-end">
          {badge}
        </div>
      ) : null}
      {subtitle ? (
        <div data-slot="card-description" className="col-start-2 row-start-2 text-[0.8125rem] leading-[1.1875rem] text-pretty text-ink-2">
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The anatomy every chat card shares (apps/web/DESIGN.md §7, ux2), built on v-design's `ui/card`: the head (icon tile,
 * title, a 13 px line, at most one pill), the body (18 px between groups), and for a money card the perforated stub
 * (`CardStub`). Only the card waiting on the founder is `lifted`; never two at once.
 *
 * The card is a labelled region (its title), so a screen reader's landmark list names every card in the thread.
 */
export function CardShell({
  testId,
  icon,
  tone,
  title,
  subtitle,
  badge,
  stub,
  lifted = false,
  children,
  className,
  ...rest
}: {
  readonly testId: string;
  readonly icon: Icon;
  readonly tone: Tone;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly badge?: ReactNode;
  /** The stub's content (a money card); the stub itself is drawn here. */
  readonly stub?: ReactNode;
  readonly lifted?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
} & Record<`data-${string}`, string | number | boolean | undefined>) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} data-testid={testId} lifted={lifted} className={cn("min-w-0 text-ui", className)} {...rest}>
      <CardHead icon={icon} tone={tone} title={title} titleId={titleId} subtitle={subtitle} badge={badge} />
      {children ? <CardContent className="grid min-w-0 gap-[18px]">{children}</CardContent> : null}
      {stub ? <CardStub className="mt-1">{stub}</CardStub> : null}
    </Card>
  );
}
