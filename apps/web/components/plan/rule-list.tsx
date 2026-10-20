import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRight,
  BadgeCheck,
  Briefcase,
  ChevronRight,
  FileText,
  FileWarning,
  Flag,
  Landmark,
  Megaphone,
  Percent,
  PiggyBank,
  ScrollText,
  ShieldCheck,
  Ship,
  ShoppingBag,
} from "lucide-react";
import type { PlanManifest, PlanRule } from "@hogee/core";
import { Badge } from "@/components/ui/badge";
import { GroupedList } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { isoDateTime } from "@/lib/format";
import { packDepth, ruleOrigin, ruleRow, verifiedDepthText, type RuleOrigin, type RuleTopic } from "@/lib/plan-rules";
import { sourceLink } from "@/lib/safe-links";

/** What a rule is about, as a glyph. */
export const RULE_ICON: { readonly [T in RuleTopic]: LucideIcon } = {
  registration: Landmark,
  entity: Briefcase,
  tax: Percent,
  invoice: FileText,
  duty: Ship,
  approval: BadgeCheck,
  reserve: PiggyBank,
  marketplace: ShoppingBag,
  ads: Megaphone,
  release: Flag,
  safety: ShieldCheck,
  other: ScrollText,
};

/** A rule's tile: tinted and neutral (rules are text you read, pockets are money you see); safety rules wear green. */
function RuleTile({ topic }: { topic: RuleTopic }) {
  return <IconTile icon={RULE_ICON[topic] ?? ScrollText} tone={topic === "safety" ? "paid" : "grey"} variant="tinted" size="sm" />;
}

const TIER_LABEL = { tier1: "Official government page", tier2: "Official, not government", tier3: "Other source" } as const;
const ORIGIN_LABEL: { readonly [O in RuleOrigin]: string } = { country: "Country rules", code: "Hogee's code", safety: "Hogee's fixed safety rules" };

/**
 * The source of a pack leaf: an https URL opens in a new tab with no opener and no referrer; any other URL
 * (javascript:, data:, http:, unparsable) is shown as text only, and a placeholder (example.invalid) not at all.
 */
function SourceUrl({ url }: { url: string }) {
  const link = sourceLink(url);
  if (link.kind === "link") {
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className="relative inline-flex items-center gap-1 rounded-sm text-meta font-medium text-ink underline decoration-line-2 underline-offset-[3px] outline-none hover:decoration-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']"
      >
        Source <ArrowUpRight aria-hidden className="size-3 text-ink-3" />
      </a>
    );
  }
  if (link.kind === "text") {
    return (
      <span className="max-w-xs truncate text-meta text-ink-3" title="Not a safe web address, so it isn't a link" data-testid="rule-source-text">
        Source: {link.text}
      </span>
    );
  }
  return null;
}

const BADGES = "[&_[data-slot=badge]]:h-5 [&_[data-slot=badge]]:rounded-sm [&_[data-slot=badge]]:px-[7px] [&_[data-slot=badge]]:text-[0.71875rem]";

/**
 * Where a rule comes from, in one row of small chips: who made it, the source's kind, when it was checked online, the
 * link, the exact place in the country data, the source's tier and a person's check. It always sits inside a fold
 * (the rule's row or "Source"), so it is one tap away and never a heading. Nothing is dropped.
 */
export function RuleSource({ rule }: { rule: PlanRule }) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${BADGES}`} data-testid="rule-source">
      <Badge variant="secondary">{ORIGIN_LABEL[ruleOrigin(rule)]}</Badge>
      {rule.source ? (
        <>
          <Badge variant="outline">{rule.source.sourceType === "live" ? "Live source" : "Sample source"}</Badge>
          <Badge variant="outline" data-testid="rule-date">
            Checked online {isoDateTime(rule.source.retrievedAt)}
          </Badge>
          <Badge variant="outline" data-testid="rule-tier">
            {TIER_LABEL[rule.source.evidence]}
          </Badge>
          {rule.source.verifiedOn ? <Badge variant="outline">Checked by a person {rule.source.verifiedOn}</Badge> : null}
        </>
      ) : rule.sourceRef.startsWith("/") ? (
        <Badge variant="outline" className="gap-1 text-waiting">
          <FileWarning aria-hidden /> No source yet
        </Badge>
      ) : null}
      <Badge variant="outline" className="h-auto min-h-5 max-w-full font-mono break-all whitespace-normal" title="Where the rule comes from">
        {rule.sourceRef}
      </Badge>
      {rule.source ? <SourceUrl url={rule.source.sourceUrl} /> : null}
    </div>
  );
}

/**
 * One rule as one short row (iOS Settings style): a glyph, a short title and its value from the rule id and the plan's
 * numbers (lib/plan-rules ruleRow). Pressing it opens the words as compiled into the plan and where they come from.
 */
function RuleItem({ rule, manifest }: { rule: PlanRule; manifest: PlanManifest }) {
  const row = ruleRow(rule, manifest);
  return (
    <li
      data-testid="plan-rule"
      data-rule-id={rule.ruleId}
      // A container: the title and its value sit side by side only when the row (not the window) has room.
      className="@container relative before:absolute before:top-0 before:right-0 before:left-[3.25rem] before:h-px before:bg-separator first:before:hidden"
    >
      <details className="group/rule">
        <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[inherit] px-4 py-2 outline-none transition-[background-color] duration-(--dur-state) ease-settle select-none hover:bg-fill focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset active:bg-fill-strong active:duration-0 [&::-webkit-details-marker]:hidden">
          <RuleTile topic={row.topic} />
          <span className="grid min-w-0 gap-0.5 py-0.5 @sm:flex @sm:items-baseline @sm:justify-between @sm:gap-3">
            <span className={row.plain ? "text-callout text-ink" : "text-footnote text-ink"} data-slot="rule-title">
              {row.title}
            </span>
            {row.value ? (
              <span className="text-footnote text-ink-2 tabular-nums @sm:shrink-0 @sm:text-right" data-slot="rule-value">
                {row.value}
              </span>
            ) : null}
          </span>
          <ChevronRight aria-hidden className="size-4 text-ink-4 transition-transform duration-(--dur-state) ease-settle group-open/rule:rotate-90" />
        </summary>
        <div className="grid gap-2 pr-4 pb-3.5 pl-[3.25rem]">
          {row.plain ? <p className="text-footnote break-words text-pretty text-ink-2">{rule.text}</p> : null}
          <RuleSource rule={rule} />
        </div>
      </details>
    </li>
  );
}

/** A group of rules: a grouped inset list with a short header and its count; each row opens its words and source. */
export function RuleGroup({ label, rules, manifest }: { label: string; rules: readonly PlanRule[]; manifest: PlanManifest }) {
  if (rules.length === 0) return null;
  return (
    <GroupedList header={`${label} · ${rules.length}`} data-testid="rule-group">
      {rules.map((rule) => (
        <RuleItem key={rule.ruleId} rule={rule} manifest={manifest} />
      ))}
    </GroupedList>
  );
}

/**
 * A person's review of the country's rules this plan uses, in one plain sentence (lib/plan-rules verifiedDepthText). It
 * sits in the Rules section's "Show details", with the numbers.
 */
export function VerifiedDepth({ rules, country }: { rules: readonly PlanRule[]; country: string }) {
  const depth = packDepth(rules);
  return (
    <p className="text-footnote text-pretty text-ink-2" data-testid="verified-depth" data-verified={depth.verified} data-pack-rules={depth.packRules}>
      {verifiedDepthText(depth, country)}
    </p>
  );
}

/**
 * Every rule of the plan by where it comes from: the country's (with the product approval needed before the first
 * sale on top, when there is one), then what Hogee's code worked out and its fixed safety rules. The approval's own
 * rule shows once, as the step.
 */
export function PlanRules({
  manifest,
  country,
  approval,
  approvalRuleId,
}: {
  manifest: PlanManifest;
  country: string;
  approval?: ReactNode;
  /** The rule the approval step already shows. */
  approvalRuleId?: string;
}) {
  const rules = manifest.rules;
  if (rules.length === 0) return <p className="text-footnote text-ink-2">This plan has no rules yet.</p>;
  const by = (o: RuleOrigin) => rules.filter((r) => ruleOrigin(r) === o);
  return (
    // Two columns when the Rules card has room for them (its own width, not the window's: a bento cell).
    <div className="@container">
      <div className="grid items-start gap-x-5 gap-y-6 @2xl:grid-cols-2">
        <div className="grid min-w-0 gap-6">
          {approval}
          <RuleGroup label={`${country}'s rules`} rules={by("country").filter((r) => r.ruleId !== approvalRuleId)} manifest={manifest} />
        </div>
        <div className="grid min-w-0 gap-6">
          <RuleGroup label="Worked out by Hogee" rules={by("code")} manifest={manifest} />
          <RuleGroup label="Fixed safety rules" rules={by("safety")} manifest={manifest} />
        </div>
      </div>
    </div>
  );
}
