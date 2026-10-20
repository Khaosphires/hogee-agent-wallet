/**
 * The demo countries a world (or scripts/dev-live) runs (SG-DECISIONS): Malaysia is Rina's facility, Singapore is
 * Mei's. Everything country-specific a world needs comes from here, so no caller relies on the API's default
 * HOGEE_COUNTRY: the red-team main world states "MY" and the SG world states "SG".
 *
 * Payees are the API's demo registry per country (catalog/payees.ts DEMO_PAYEES_BY_COUNTRY): Rina's MY_DUITNOW
 * accounts, Mei's SG_PAYNOW accounts (paid out by the worker's MockRail as a simulated PayNow payout).
 */
import { MEI_IDS, MEI_PLAN_INTENT, RINA_IDS, examplePlanIntent, type Persona, type PlanIntent } from "@hogee/core";
import { ALL_DEMO_PAYEES, DEMO_PAYEES_BY_COUNTRY, type DemoPayeeCountry, type OnboardedPayee } from "./api-internals";

export type DemoCountryCode = DemoPayeeCountry;

export interface DemoCountry {
  readonly countryCode: DemoCountryCode;
  readonly currency: "MYR" | "SGD";
  /** The demo facility and founder (Sepolia and dev-live; Anvil worlds use their own ids). */
  readonly facilityId: string;
  readonly founderId: string;
  readonly founderName: string;
  /** The founder persona the API accepts for this HOGEE_COUNTRY. */
  readonly persona: Extract<Persona, `founder:${string}`>;
  /** The static platform payees and onboarded vendors (their TEST payout accounts). */
  readonly payees: readonly OnboardedPayee[];
  /** The plan intent the scripted planner proposes, and the founder's opening chat message. */
  readonly planIntent: PlanIntent;
  readonly chatMessage: string;
}

export const DEMO_COUNTRIES: Readonly<Record<DemoCountryCode, DemoCountry>> = Object.freeze({
  MY: Object.freeze({
    countryCode: "MY",
    currency: "MYR",
    facilityId: RINA_IDS.facilityId,
    founderId: RINA_IDS.founderId,
    founderName: "Rina",
    persona: "founder:rina",
    payees: DEMO_PAYEES_BY_COUNTRY.MY,
    planIntent: examplePlanIntent,
    chatMessage: "Malaysian citizen. Custom insulated tumblers (food contact) on Shopee, from China, budget RM10,000.",
  }),
  SG: Object.freeze({
    countryCode: "SG",
    currency: "SGD",
    facilityId: MEI_IDS.facilityId,
    founderId: MEI_IDS.founderId,
    founderName: "Mei",
    persona: "founder:mei",
    payees: DEMO_PAYEES_BY_COUNTRY.SG,
    planIntent: MEI_PLAN_INTENT,
    chatMessage: "Singapore citizen. Custom insulated tumblers (food contact) on Shopee Singapore, from China, budget S$10,000.",
  }),
});

/** The country's settings; anything but MY or SG is refused (ID has no demo payees). */
export function demoCountry(code: string): DemoCountry {
  if (code !== "MY" && code !== "SG") throw new RangeError("the demo country must be MY or SG");
  return DEMO_COUNTRIES[code];
}

/**
 * Both countries' payees, MY first (the API's list): what a final-1 shared by Rina and Mei fixes in Treasury
 * (SG-DECISIONS: Mei's platform payout hashes go into final-1 alongside Rina's). Passed to the deploy explicitly.
 */
export { ALL_DEMO_PAYEES };
