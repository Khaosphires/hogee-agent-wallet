import { money } from "@hogee/core";
import { IconTile } from "@/components/ui/icon-tile";
import type { ApprovalStep } from "@/lib/plan-rules";
import { RuleSource } from "./rule-list";
import { ShowDetails } from "./show-details";

const words = (v: string): string => v.replace(/_/g, " ");

/** Product kinds in plain words (the rule's own text and source stay in its fold). */
const CATEGORY_WORDS: Readonly<Record<string, string>> = { drinkware_food_contact: "cups and bottles that touch food or drink" };

/** "SFA registration or approval (free)": agency and fee from the compiled rule, the fee in the facility currency via core. */
export function approvalStepLabel(step: ApprovalStep, currency: string): string {
  const fee = step.feeMinor === 0n ? "free" : money(step.feeMinor, currency);
  return `${words(step.agency)} registration or approval (${fee})`;
}

/**
 * The product approval the country pack requires before the first sale (Mei: SFA, free), as the one to-do among the
 * rules: tinted waiting, since only Mei can do it. Everything shown comes from the compiled
 * `approval.<agency>.fee.<minor>` rule and the pack leaf it points at; its words and source fold under "Source".
 */
export function ApprovalStepCard({ step, currency, country }: { step: ApprovalStep; currency: string; country: string }) {
  return (
    <div className="grid gap-2" data-testid="approval-step" data-rule-id={step.rule.ruleId}>
      <p className="px-4 text-footnote font-medium text-ink-2">Before your first sale</p>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 rounded-group bg-waiting-wash px-4 pt-3 pb-1 shadow-[0_0_0_1px_oklch(0.455_0.1_80/0.18)]">
        <IconTile tone="waiting" variant="solid" size="lg" className="mt-0.5 w-auto min-w-10 px-1.5 text-caption">
          {step.agency.split("_")[0]}
        </IconTile>
        <div className="grid min-w-0 gap-0.5">
          <p className="text-callout font-medium text-pretty text-ink" data-testid="approval-step-label" data-fee-minor={step.feeMinor.toString()}>
            {approvalStepLabel(step, currency)}
          </p>
          <p className="text-footnote text-ink-2">
            {country}&apos;s rules need this for {CATEGORY_WORDS[step.category] ?? words(step.category)}.
          </p>
          <ShowDetails label="Source" testId="rule-details">
            <p className="text-footnote text-ink-2">{step.rule.text}</p>
            <RuleSource rule={step.rule} />
          </ShowDetails>
        </div>
      </div>
    </div>
  );
}
