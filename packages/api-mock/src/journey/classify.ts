/**
 * The mock's stand-in for agent classifySkill (VISION-DECISIONS §7): deterministic regexes over the founder's text,
 * returning the same SkillCall shape with the same code bounds (ranks within the list, a CFO view only for cfo). It
 * never sees web text either. A money verb ("pay", "transfer", "release") is out_of_scope unless the message only states
 * a split ("pay 30% deposit, 70% on delivery"): "now", an account number or no split at all keeps it out_of_scope.
 */
import type { CfoView, SkillCall } from "@hogee/core";

const RANK = /#\s*([1-8])\b/g;
const TERMS = /\b(went with|go(?:ing)? with|chose|picked|agreed|deposit|upfront|on delivery|balance|actually)\b|\d{1,3}\s*%|\b\d{1,3}\s*\/\s*\d{1,3}\b/i;
const MONEY = /\b(pay|paying|transfer|wire|send|release|refund|withdraw|move)\b/i;
const SPLIT = /\d{1,3}\s*%|\b\d{1,3}\s*\/\s*\d{1,3}\b/;
const URGENT = /\bnow\b|\btoday\b|\baccount\b|\d{6,}/i;
const CFO: readonly [RegExp, CfoView][] = [
  [/\bhow\s+(are|is)\s+(we|it|things|the business)\s+(doing|going)\b|\boverview\b/i, "overview"],
  [/\bforecast|runway|stage\s*(2|two)\b/i, "forecast"],
  [/\b(tax|reserve)\b/i, "reserve"],
  [/\bprofit|loss|p\s*&\s*l|pnl\b/i, "pnl"],
  [/\bsales|sold|revenue|orders? came\b/i, "sales"],
  [/\bspen[dt]|spending|costs?\b/i, "spending"],
];
const PICK = /\b(pick|like|choose|shortlist|enquire)\b/i;
const FIND = /\b(find|search|look for|other)\b.*\bsuppliers?\b|\bsuppliers?\b/i;
const STATUS = /\b(status|where are we|what('s| is) next|cooling|deposit (go|gone|out)|order)\b/i;
const PLAN = /\b(plan|budget|needs?)\b/i;
const HELP = /\b(help|what can you do|how does this work|hello|hi|hey)\b/i;

const call = (skill: SkillCall["skill"], candidateRanks: number[] | null = null, cfoView: CfoView | null = null): SkillCall => ({ skill, candidateRanks, cfoView });

function ranksIn(text: string, candidateCount: number): number[] | null {
  const ranks = [...new Set([...text.matchAll(RANK)].map((m) => Number(m[1])).filter((r) => r >= 1 && r <= candidateCount))];
  return ranks.length > 0 ? ranks : null;
}

export function classifyByRules(text: string, candidateCount: number): SkillCall {
  if (MONEY.test(text) && (URGENT.test(text) || !SPLIT.test(text))) return call("out_of_scope");
  if (TERMS.test(text)) return call("report_terms", ranksIn(text, candidateCount)?.slice(0, 1) ?? null);
  const cfo = CFO.find(([re]) => re.test(text));
  if (cfo) return call("cfo", null, cfo[1]);
  if (PICK.test(text) && ranksIn(text, candidateCount)) return call("pick_suppliers", ranksIn(text, candidateCount));
  if (FIND.test(text)) return call("find_suppliers");
  if (STATUS.test(text)) return call("status");
  if (PLAN.test(text)) return call("plan");
  if (HELP.test(text)) return call("help");
  return call("out_of_scope");
}
