import { Check, Fingerprint, Hourglass, Lock } from "lucide-react";
import type { Balances, PlanDraft } from "@hogee/core";
import { Card } from "@/components/ui/card";
import { IconTile, type IconTileProps } from "@/components/ui/icon-tile";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { SampleTag } from "@/components/cfo/cfo-parts";
import { Money } from "@/components/ledger/money";
import { bu, unixDate } from "@/lib/format";
import { releaseSteps, type ReleaseStatus, type ReleaseStep } from "@/lib/plan-rules";
import { cn } from "@/lib/utils";
import type { SampleScope } from "./use-sample-scope";

const NODE: { readonly [S in ReleaseStatus]: { readonly tile: Pick<IconTileProps, "icon" | "tone" | "variant">; readonly word: string } } = {
  released: { tile: { icon: Check, tone: "paid", variant: "solid" }, word: "Released" },
  "awaiting-funds": { tile: { icon: Hourglass, tone: "grey", variant: "tinted" }, word: "Signed · waiting for your loan officer" },
  "at-signing": { tile: { icon: Fingerprint, tone: "ink", variant: "solid" }, word: "When you sign" },
  waiting: { tile: { icon: Lock, tone: "grey", variant: "tinted" }, word: "Locked" },
};

/** What a later release needs, in one line. */
function needs(gate: NonNullable<ReleaseStep["gate"]>): string {
  const goal = gate.metric === "salesMinor" ? `${bu(gate.target)} in sales` : `${gate.target} orders`;
  return `Needs ${goal} by ${unixDate(gate.deadline)}, then your loan officer's OK`;
}

/**
 * Sales toward the goal: the CFO report's sales, the same figure and "Sample" tag as the Wallet. When the sales are a
 * sample beside Mei's own plan, the tag and one line say they don't unlock money (the loan officer's check reads the
 * wallet's recorded sales, never the sample); in the Sample business the page's own label covers it.
 */
function SalesProgress({ gate, sample }: { gate: NonNullable<ReleaseStep["gate"]>; sample: SampleScope }) {
  if (gate.progressPct === undefined || gate.soFarMinor === undefined) return null;
  return (
    <div className="mt-2 grid max-w-64 gap-1.5" data-testid="release-sales">
      <Progress value={gate.progressPct} tone="paid" className="h-1.5" aria-label={`Sales so far: ${bu(gate.soFarMinor)} of ${bu(gate.target)}`} />
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-ink-2">
        <span>
          <Money minor={gate.soFarMinor} /> of <Money minor={gate.target} /> sold
        </span>
        {sample.figures ? <SampleTag /> : null}
      </p>
      {sample.figures ? <p className="text-footnote text-pretty text-ink-3">Sample sales don&apos;t unlock money.</p> : null}
    </div>
  );
}

function Step({ step, index, last, signed, sample }: { step: ReleaseStep; index: number; last: boolean; signed: boolean; sample: SampleScope }) {
  const node = NODE[step.status];
  // Signed, while the wallet's released total catches up (it covers the first release on commit).
  const word = step.status === "at-signing" && signed ? "With your signature" : node.word;
  return (
    <li className="relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3.5 pb-6 last:pb-0 sm:grid-cols-1 sm:gap-y-3 sm:pr-4 sm:pb-0" data-testid="release-step" data-status={step.status}>
      {/* The connector: down to the next step on a phone, across to it from 640 px; green once this one is in. */}
      {!last ? (
        <span
          aria-hidden
          className={cn(
            "absolute top-11 bottom-1 left-[19px] w-0.5 rounded-full sm:top-[19px] sm:right-1 sm:bottom-auto sm:left-[52px] sm:h-0.5 sm:w-auto",
            step.status === "released" ? "bg-paid" : "bg-fill-strong",
          )}
        />
      ) : null}
      <IconTile {...node.tile} size="lg" className="relative z-10" />
      <div className="grid min-w-0 content-start gap-1">
        <Stat label={`Release ${index + 1}`} minor={step.releaseMinor} size="sm" />
        <p className={cn("text-footnote font-medium text-pretty", step.status === "released" ? "text-paid" : "text-ink")}>{word}</p>
        {step.gate && step.status !== "released" ? (
          <>
            <p className="text-footnote text-pretty text-ink-2">{needs(step.gate)}</p>
            {signed ? <SalesProgress gate={step.gate} sample={sample} /> : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The budget's releases as a 2–3 step timeline (UX round 2): what each one unlocks, when, and what it needs. A release
 * reads "Released" once its money is in the wallet (released and funded), "Signed · waiting for your loan officer" while
 * the chain has released it but the wallet is still empty; sales progress toward a sales goal is the Wallet's figure
 * (the CFO report's sales, lib/plan-rules salesSoFar).
 */
export function ReleaseTimeline({
  shown,
  wallet,
  salesMinor,
  signed,
  sample,
}: {
  shown: PlanDraft;
  wallet: Pick<Balances, "releasedMinor" | "fundedMinor"> | undefined;
  salesMinor: string | undefined;
  signed: boolean;
  sample: SampleScope;
}) {
  const steps = releaseSteps(shown.manifest.stages, wallet, salesMinor);
  const total = steps.reduce((sum, s) => sum + BigInt(s.releaseMinor), 0n);
  const released = steps.filter((s) => s.status === "released").reduce((sum, s) => sum + BigInt(s.releaseMinor), 0n);
  const releasedPct = total === 0n ? 0 : Number((released * 1000n) / total) / 10;
  return (
    // Its own width decides the layout (bento): the steps above the total in a narrow cell; the steps and the total side
    // by side across a whole row (1440), so a wide card stays short instead of an empty-looking banner.
    <Card className="@container px-5 py-5 sm:px-6 sm:py-6">
      <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)] @3xl:items-center @3xl:gap-x-10">
        <ol aria-label="Budget releases" className={cn("grid", steps.length > 1 && "sm:grid-cols-[repeat(var(--n),minmax(0,1fr))]")} style={{ ["--n" as string]: steps.length }}>
          {steps.map((s, i) => (
            <Step key={s.stageId} step={s} index={i} last={i === steps.length - 1} signed={signed} sample={sample} />
          ))}
        </ol>
        <div className="grid gap-2 pt-4 shadow-[inset_0_1px_0_var(--separator)] @3xl:self-stretch @3xl:content-center @3xl:pt-0 @3xl:pl-8 @3xl:shadow-[inset_1px_0_0_var(--separator)]" data-testid="release-bar">
          <Progress value={releasedPct} tone="paid" aria-label={`${bu(released.toString())} of ${bu(total.toString())} released`} />
          <p className="flex flex-wrap justify-between gap-x-4 text-footnote text-ink-2">
            <span>{released > 0n ? `${bu(released.toString())} released` : "Nothing released yet"}</span>
            <span>{bu((total - released).toString())} still to come</span>
          </p>
        </div>
      </div>
    </Card>
  );
}
