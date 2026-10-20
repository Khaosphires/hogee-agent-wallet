import type { AdsPacing, PlanIntent, ProductCategory, Residency } from "@hogee/core";
import { Tag } from "@/components/ui/pill";
import { bu } from "@/lib/format";
import { CHANNEL_WORDS, ENTITY_WORDS } from "@/lib/plan-rules";

const COUNTRY: Readonly<Record<string, string>> = { SG: "Singapore", MY: "Malaysia", ID: "Indonesia", CN: "China", VN: "Vietnam", IN: "India", TH: "Thailand" };
const RESIDENCY: { readonly [R in Residency]: string } = { citizen: "Citizen", pr: "Permanent resident", foreigner: "Foreigner" };
const CATEGORY: { readonly [C in ProductCategory]: string } = {
  drinkware_food_contact: "Cups or bottles (touch food or drink)",
  cosmetics: "Cosmetics",
  electrical: "Electrical goods",
  apparel: "Clothes",
  food: "Food",
  other: "Other goods",
};
const PACING: { readonly [P in AdsPacing]: string } = { conservative: "Slowly", standard: "Steadily" };

/**
 * What the AI understood from the founder's answers (the only AI output that reaches the plan's code), in names. It
 * sits in the Signature section's fold: the AI never sets the rules, who gets paid, or amounts.
 */
export function IntentSummary({ intent }: { intent: PlanIntent }) {
  const rows: [string, string][] = [
    ["Country", COUNTRY[intent.countryCode] ?? intent.countryCode],
    ["You are a", RESIDENCY[intent.residency]],
    ["Business type", ENTITY_WORDS[intent.entityType]],
    ["Product", CATEGORY[intent.productCategory]],
    ["Sells on", CHANNEL_WORDS[intent.sellChannel]],
    ["Buys from", COUNTRY[intent.buyFrom] ?? intent.buyFrom],
    ["Top budget", bu(intent.budgetCeilingMinor)],
    ["Plan length", `${intent.horizonDays} days`],
    ["Ads speed", PACING[intent.adsPacing]],
  ];
  return (
    <div className="grid gap-3" data-testid="intent-card">
      <p className="flex flex-wrap items-center gap-2 text-footnote text-ink-2">
        <Tag>AI-drafted</Tag> What the AI understood. It never sets the rules, who gets paid, or amounts.
      </p>
      <dl className="grid gap-x-6 gap-y-2.5 text-footnote min-[480px]:grid-cols-2 lg:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-px">
            <dt className="text-meta text-ink-3">{k}</dt>
            <dd className="font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {intent.assumptions.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-meta font-medium text-ink-3">Things the AI assumed</p>
          <ul className="list-disc space-y-0.5 pl-5 text-footnote text-ink-2 marker:text-ink-4">
            {intent.assumptions.map((a) => (
              <li key={`${a.slot}:${a.text}`}>{a.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
