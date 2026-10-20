import { CircleCheck, CircleX } from "lucide-react";
import { CONSTITUTION_COPY, type PlanDraft } from "@hogee/core";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DETAIL_ONLY_RULES, safetyRuleText } from "@/lib/plan-rules";
import { ShowDetails } from "./show-details";

const show = (v: unknown): string => (v === null || v === undefined ? "—" : typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v));

/** What the AI changed against the rules-only plan: nothing (one line), or every change as a row. */
export function PlanDiff({ diff }: { diff: PlanDraft["diff"] }) {
  if (diff.length === 0) {
    return (
      <span className="text-ui text-ink-2" data-testid="plan-diff-empty">
        Nothing
      </span>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>What</TableHead>
          <TableHead>Rules-only plan</TableHead>
          <TableHead>This plan</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {diff.map((d) => (
          <TableRow key={d.path} data-testid="plan-diff-row">
            <TableCell className="font-mono text-[0.78125rem]">{d.path}</TableCell>
            <TableCell className="font-mono text-[0.78125rem] text-ink-3 line-through decoration-ink-4">{show(d.baseline)}</TableCell>
            <TableCell className="font-mono text-[0.78125rem] text-ink">{show(d.proposed)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Check({ c }: { c: PlanDraft["constitutionReport"][number] }) {
  return (
    <li className="flex items-start gap-2.5 text-footnote text-ink" data-ok={c.ok} data-code={c.code}>
      {c.ok ? <CircleCheck aria-hidden className="mt-px size-4 shrink-0 text-paid" /> : <CircleX aria-hidden className="mt-px size-4 shrink-0 text-blocked" />}
      <span>
        <span className="sr-only">{c.ok ? "Passes: " : "Fails: "}</span>
        {c.ok ? safetyRuleText(c.code) : CONSTITUTION_COPY[c.code]}
      </span>
    </li>
  );
}

/**
 * The §8.3 fixed safety rules, checked again on the blockchain when the plan is saved, in plain words. A failing check
 * always shows; every check (passing ones too) is one tap away under "See all", the review-period check last (D30).
 */
export function ConstitutionReport({ report }: { report: PlanDraft["constitutionReport"] }) {
  const failing = report.filter((c) => !c.ok);
  const ordered = [...report.filter((c) => !DETAIL_ONLY_RULES.has(c.code)), ...report.filter((c) => DETAIL_ONLY_RULES.has(c.code))];
  return (
    <div className="grid gap-1">
      {failing.length > 0 ? (
        <ul className="grid gap-2 py-2" aria-label="Failing checks" data-testid="failing-checks">
          {failing.map((c) => (
            <Check key={c.code} c={c} />
          ))}
        </ul>
      ) : null}
      <ShowDetails label={`See all ${report.length} safety checks`} testId="safety-checks-list">
        <ul className="grid gap-2 sm:grid-cols-2 sm:gap-x-5" aria-label="Constitution checks">
          {ordered.map((c) => (
            <Check key={c.code} c={c} />
          ))}
        </ul>
      </ShowDetails>
    </div>
  );
}
