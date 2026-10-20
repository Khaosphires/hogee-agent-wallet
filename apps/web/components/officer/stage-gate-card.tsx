"use client";

import { Lock, LockOpen } from "lucide-react";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { PageSection } from "@/components/ui/page-section";
import { Pill } from "@/components/ui/pill";
import { Progress } from "@/components/ui/progress";
import { Money } from "@/components/ledger/money";
import { useBalances, useCfoReport, useCurrentPlan } from "@/lib/api/queries";
import { bu, dayMonth, unixDate } from "@/lib/format";
import { goalPct, releaseRows, salesFigure, type ReleaseRow, type SalesFigure } from "./officer-model";
import { useSampleScope } from "./use-sample-business";
import type { Queue } from "./exception-queue";

/** Sales as the Wallet counts them, and whether to tag them "Sample" (the shared rule: officer-model salesFigure, useSampleScope). */
function useSales(): { figure: SalesFigure | undefined; tag: boolean } {
  const report = useCfoReport().data;
  const scope = useSampleScope();
  return { figure: report ? salesFigure(report) : undefined, tag: scope.figures };
}

function Goal({ row, founder, sales, requestOpen }: { row: ReleaseRow & { goal: NonNullable<ReleaseRow["goal"]> }; founder: string; sales: ReturnType<typeof useSales>; requestOpen: boolean }) {
  const figure = sales.figure;
  if (!figure) return <span>Sales goal: {bu(row.goal.targetMinor)} by {unixDate(row.goal.deadline)}</span>;
  const pct = goalPct(figure.soFarMinor, row.goal.targetMinor);
  const met = BigInt(figure.soFarMinor) >= BigInt(row.goal.targetMinor);
  return (
    <span className="grid gap-2 pt-1">
      <Progress value={pct} tone="paid" aria-label={`Sales ${bu(figure.soFarMinor)} of ${bu(row.goal.targetMinor)}`} className="h-2.5" />
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-ink-2 tabular-nums">
          {bu(figure.soFarMinor)} of {bu(row.goal.targetMinor)} in sales · by {unixDate(row.goal.deadline)}
        </span>
        {sales.tag ? (
          <Pill tone="neutral" icon={null} data-testid="sales-sample-tag">
            Sample
          </Pill>
        ) : null}
      </span>
      {met ? (
        requestOpen ? (
          <a href="#officer-decisions" className="inline-flex min-h-8 w-fit items-center rounded-md font-medium text-waiting underline decoration-current/30 underline-offset-[3px] outline-none hover:decoration-current focus-visible:ring-[3px] focus-visible:ring-ring/50">
            Goal reached. Approve it under Needs your decision.
          </a>
        ) : (
          <span className="font-medium text-paid">Goal reached. Waiting for {founder}&apos;s request to release it.</span>
        )
      ) : figure.projectedDate && figure.targetMinor === row.goal.targetMinor ? (
        <span>On pace for {dayMonth(figure.projectedDate)}. It opens only when you approve it.</span>
      ) : (
        <span>It opens only when you approve it.</span>
      )}
    </span>
  );
}

/**
 * Budget releases (§4 step 9; REWRITES B19): the plan's budget comes in parts, and each later part opens only when the
 * loan officer approves its request under Needs your decision. Nothing releases by itself here, and no button here
 * releases anything: the approval stays on the request itself.
 */
export function StageGateCard({ queue, founder }: { queue: Queue; founder: string }) {
  const plan = useCurrentPlan();
  const balances = useBalances();
  const sales = useSales();
  const stages = plan.data?.status === "COMMITTED" ? plan.data.manifest.stages : [];
  if (!balances.data || stages.length === 0) return null;
  const rows = releaseRows(stages, balances.data.releasedMinor);
  const requestOpen = queue.by("needs-decision").some((e) => e.kind === "RELEASE_STAGE");
  return (
    <div data-testid="stage-gate" className="grid">
      <PageSection id="officer-releases" title="Budget releases">
        <GroupedList aria-label="Budget releases">
          {rows.map((r) => {
            const met = r.goal !== undefined && sales.figure !== undefined && BigInt(sales.figure.soFarMinor) >= BigInt(r.goal.targetMinor);
            return (
              <ListRow
                key={r.stageId}
                data-testid="stage-row"
                data-released={r.released}
                data-met={met}
                leading={r.released ? <IconTile icon={LockOpen} tone="paid" /> : <IconTile icon={Lock} tone={met ? "waiting" : "grey"} variant={met ? "solid" : "tinted"} />}
                title={`Release ${r.n}`}
                value={<Money minor={r.releaseMinor} />}
                subtitle={
                  r.released ? (
                    r.goal ? "Released after you approved it." : "Released when the plan was signed."
                  ) : r.goal ? (
                    <Goal row={{ ...r, goal: r.goal }} founder={founder} sales={sales} requestOpen={requestOpen} />
                  ) : (
                    "Opens when you approve its request."
                  )
                }
              />
            );
          })}
        </GroupedList>
      </PageSection>
    </div>
  );
}
