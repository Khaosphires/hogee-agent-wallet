/**
 * Clarifying questions are TEMPLATES (§7.1 "LLM only chooses and orders templates"): the Planner picks up to three
 * IntentSlots; code writes the question text and the options (frozen chat `data-question` part, @hogee/core). No model
 * text reaches the founder, so a question can never carry a hallucinated number or an injected instruction.
 */
import {
  DataQuestion,
  ENTITY_TYPES_BY_COUNTRY,
  PRODUCT_CATEGORIES,
  formatBu,
  type CountryCode,
  type EntityType,
  type IntentSlot,
  type PlanIntent,
  type ProductCategory,
} from "@hogee/core";

type Option = { readonly value: string; readonly label: string };

const ENTITY_LABEL: { readonly [E in EntityType]: string } = {
  sole_prop: "Sole proprietorship",
  partnership: "Partnership",
  sdn_bhd: "Private limited company (Sdn Bhd)",
  perorangan: "Individual business (perorangan)",
  pt_perorangan: "Individual company (PT Perorangan)",
  cv: "Limited partnership (CV)",
  pt: "Limited company (PT)",
  sg_sole_prop: "Sole proprietorship",
  sg_partnership: "Partnership",
  pte_ltd: "Private limited company (Pte Ltd)",
};

/**
 * Every country's name, so an assumed country (ID included) is shown by name. Only SG and MY are OFFERED: Indonesia
 * stays valid in PlanIntent but leaves the country choice (SG-DECISIONS, 18 Oct).
 */
const COUNTRY_LABEL: { readonly [C in CountryCode]: string } = { SG: "Singapore", MY: "Malaysia", ID: "Indonesia" };
const OFFERED_COUNTRIES = ["SG", "MY"] as const satisfies readonly CountryCode[];

const CATEGORY_LABEL: { readonly [C in ProductCategory]: string } = {
  drinkware_food_contact: "Drinkware or food-contact items",
  cosmetics: "Cosmetics",
  electrical: "Electrical goods",
  apparel: "Clothing",
  food: "Food",
  other: "Something else",
};

interface Template {
  readonly text: string;
  readonly options: (country: CountryCode) => readonly Option[];
}

const none = (): readonly Option[] => [];

export const QUESTION_TEMPLATES: { readonly [S in IntentSlot]: Template } = {
  countryCode: { text: "Which country will you register the business and sell in?", options: () => OFFERED_COUNTRIES.map((c) => ({ value: c, label: COUNTRY_LABEL[c] })) },
  residency: {
    text: "Are you a citizen, a permanent resident or a foreigner in that country?",
    options: () => [
      { value: "citizen", label: "Citizen" },
      { value: "pr", label: "Permanent resident" },
      { value: "foreigner", label: "Foreigner" },
    ],
  },
  entityType: { text: "How do you want to register the business?", options: (cc) => ENTITY_TYPES_BY_COUNTRY[cc].map((e) => ({ value: e, label: ENTITY_LABEL[e] })) },
  productCategory: { text: "What kind of product will you sell?", options: () => PRODUCT_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })) },
  sellChannel: {
    text: "Where will you sell?",
    options: () => [
      { value: "shopee", label: "Shopee" },
      { value: "tiktok_shop", label: "TikTok Shop" },
      { value: "lazada", label: "Lazada" },
      { value: "own_site", label: "My own website" },
    ],
  },
  buyFrom: {
    text: "Which country will you buy your stock from?",
    options: () => [
      { value: "CN", label: "China" },
      { value: "SG", label: "Singapore" },
      { value: "MY", label: "Malaysia" },
      { value: "ID", label: "Indonesia" },
    ],
  },
  budgetCeilingMinor: { text: "What's the most this plan should spend? Write the amount and the currency, like S$10,000.", options: none },
  horizonDays: {
    text: "Over how many days should this plan run?",
    options: () => [
      { value: "30", label: "30 days" },
      { value: "60", label: "60 days" },
      { value: "90", label: "90 days" },
    ],
  },
  adsPacing: {
    text: "How fast should Hogee spend on ads?",
    options: () => [
      { value: "conservative", label: "Slowly (less each day)" },
      { value: "standard", label: "Normal" },
    ],
  },
};

/** Build the frozen `data-question` parts for the chosen slots (unique, at most 3, in the Planner's order). */
export function questionsFor(slots: readonly IntentSlot[], country: CountryCode, decisionId: string): DataQuestion[] {
  return [...new Set(slots)].slice(0, 3).map((slot) => {
    const t = QUESTION_TEMPLATES[slot];
    return DataQuestion.parse({ questionId: `${decisionId}:${slot}`, slot, text: t.text, options: [...t.options(country)] });
  });
}

/**
 * PlanIntent.assumptions with the model's free text replaced by a template built from the intent's own value for
 * that slot (the frozen schema keeps `{slot, text}`; the UI may show `text`, so it must never be model prose).
 */
export function templatedAssumptions(intent: PlanIntent): PlanIntent["assumptions"] {
  const seen = new Set<IntentSlot>();
  return intent.assumptions.flatMap(({ slot }) => {
    if (seen.has(slot)) return [];
    seen.add(slot);
    const raw = intent[slot];
    const label =
      slot === "budgetCeilingMinor"
        ? formatBu(intent.budgetCeilingMinor)
        : slot === "countryCode"
          ? COUNTRY_LABEL[intent.countryCode]
          : (QUESTION_TEMPLATES[slot].options(intent.countryCode).find((o) => o.value === String(raw))?.label ?? String(raw));
    return [{ slot, text: `I assumed: ${label}` }];
  });
}
