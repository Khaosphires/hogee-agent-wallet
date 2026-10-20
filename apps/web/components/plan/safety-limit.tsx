import { CalendarClock, ShieldCheck } from "lucide-react";
import type { PlanDraft } from "@hogee/core";
import { Card } from "@/components/ui/card";
import { IconTile } from "@/components/ui/icon-tile";
import { Progress, ProgressRing } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { bu, pctOf, shortHash, unixDate } from "@/lib/format";
import { ConstitutionReport } from "./plan-checks";
import { ShowDetails } from "./show-details";

/**
 * The one number that answers "is my money safe?": the most the AI could pay with no one signing, as a share of the
 * budget, how long the AI may pay at all, and the fixed safety checks the blockchain runs again on saving. Tinted
 * cobalt, the colour of what the wallet does alone (the review keeps this card as it is; its parts are the ui ones).
 */
export function SafetyLimit({ shown }: { shown: PlanDraft }) {
  const m = shown.manifest;
  const share = pctOf(shown.blastRadiusMinor, m.totalMinor);
  const report = shown.constitutionReport;
  const passed = report.filter((c) => c.ok).length;
  const allPass = report.length > 0 && passed === report.length;
  return (
    <Card className="h-full gap-5 bg-agent-wash px-5 py-5 shadow-[0_0_0_1px_oklch(0.48_0.15_262/0.14),0_1px_2px_oklch(0.235_0.028_262/0.05)] sm:px-6 sm:py-6">
      <Stat
        data-testid="blast-radius"
        leading={<IconTile icon={ShieldCheck} tone="agent" size="sm" />}
        label={
          <span role="heading" aria-level={3} className="font-semibold text-agent">
            The most the AI could pay without you
          </span>
        }
        minor={shown.blastRadiusMinor}
        size="lg"
        note="Even if someone took over the AI, it could never pay out more."
      />

      <div className="grid gap-1.5">
        <Progress value={share} tone="agent" className="bg-[oklch(0.48_0.15_262/0.14)]" aria-label={`${Math.round(share)}% of your ${bu(m.totalMinor)} budget`} />
        <p className="flex justify-between gap-3 text-footnote text-ink-2">
          <span>{Math.round(share)}% of your budget</span>
          <span className="tabular-nums">{bu(m.totalMinor)}</span>
        </p>
      </div>

      <dl className="grid gap-3 rounded-lg bg-surface/80 p-3.5 shadow-[0_0_0_1px_oklch(0.48_0.15_262/0.1)] min-[420px]:grid-cols-2">
        <div className="flex items-center gap-3">
          <IconTile icon={CalendarClock} tone="agent" variant="tinted" />
          <div className="min-w-0">
            <dt className="text-footnote text-ink-3">The AI can pay until</dt>
            <dd className="text-subhead font-semibold text-ink">{unixDate(m.agent.expiresAt)}</dd>
          </div>
        </div>
        <div className="flex items-center gap-3" data-testid="safety-checks" data-passed={passed} data-total={report.length}>
          <ProgressRing value={report.length === 0 ? 0 : (passed / report.length) * 100} tone={allPass ? "paid" : "blocked"} size={30} stroke={4} label={`${passed} of ${report.length} safety checks pass`} />
          <div className="min-w-0">
            <dt className="text-footnote text-ink-3">Fixed safety checks</dt>
            <dd className={allPass ? "text-subhead font-semibold text-ink" : "text-subhead font-semibold text-blocked"}>
              {passed} of {report.length} pass
            </dd>
          </div>
        </div>
      </dl>

      {/* The folds close the card: when its row is taller (a bento row beside the summary), the room goes above them. */}
      <div className="mt-auto -mb-1 grid gap-0">
        <ConstitutionReport report={report} />
        <ShowDetails label="The AI's paying key">
          <p>
            <span className="font-mono text-[0.78125rem] text-ink">{shortHash(m.agent.address)}</span>
          </p>
        </ShowDetails>
      </div>
    </Card>
  );
}
