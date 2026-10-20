/**
 * Which demo the mock serves (SG-DECISIONS): Singapore (Mei) is the main demo, Malaysia (Rina) the second one.
 * HOGEE_COUNTRY selects it, the same variable as the live API's. Unset, the mock serves SG: it has no country-pack
 * dependency, so it can default to SG before the API does (Q3). ID has no scenario here (it is a preview only), and any
 * other value fails closed: every request answers 502 rather than serve another country's founder under the wrong flag.
 */
import {
  MEI_IDS,
  MEI_SESSION_ID,
  RINA_IDS,
  RINA_SESSION_ID,
  type CurrencyCode,
  type Facility,
  type Persona,
} from "@hogee/core";

export const MOCK_COUNTRIES = ["SG", "MY"] as const;
export type MockCountry = (typeof MOCK_COUNTRIES)[number];
export const DEFAULT_MOCK_COUNTRY: MockCountry = "SG";

/** The ids a scenario uses; Mei's mirror Rina's field for field (core demo/mei.ts). */
export type DemoIds = typeof RINA_IDS;

export interface DemoProfile {
  readonly country: MockCountry;
  readonly currency: CurrencyCode;
  readonly founderPersona: Extract<Persona, `founder:${string}`>;
  readonly founderName: string;
  readonly ids: DemoIds;
  readonly sessionId: string;
  /** Folder under HOGEE_FIXTURES_DIR that may hold P3's fixtures for this founder. */
  readonly scenarioFolder: string;
  /** Escrow order ids are `<orderPrefix><x>-NNN` for supplier-<x> (both: order-a-001, as the live API names them per facility). */
  readonly orderPrefix: string;
  /** How a payee payout reads (SG-DECISIONS rail: SG payees are paid by the worker's MockRail, never a real payout). */
  readonly payout: {
    /** nextId prefix of a payout the mock creates (MY keeps the existing "disb"). */
    readonly idPrefix: string;
    readonly settledSummary: string;
    /** Appended to a seeded trace that names a payout; empty when the seeded text already fits. */
    readonly traceNote: string;
  };
}

export const PROFILES: { readonly [C in MockCountry]: DemoProfile } = {
  SG: {
    country: "SG",
    currency: "SGD",
    founderPersona: "founder:mei",
    founderName: "Mei",
    ids: MEI_IDS,
    sessionId: MEI_SESSION_ID,
    scenarioFolder: "scenario-mei",
    orderPrefix: "order-",
    payout: {
      idPrefix: "simulated-paynow",
      // The app's one word for "not real" (UX round 3): what the Activity record shows as is.
      settledSummary: "Sample payout (PayNow) succeeded: no real bank transfer; settlement confirmed on-chain",
      traceNote: " Payout: sample payout (PayNow), no real bank transfer.",
    },
  },
  MY: {
    country: "MY",
    currency: "MYR",
    founderPersona: "founder:rina",
    founderName: "Rina",
    ids: RINA_IDS,
    sessionId: RINA_SESSION_ID,
    scenarioFolder: "scenario-rina",
    orderPrefix: "order-",
    payout: {
      idPrefix: "disb",
      settledSummary: "Test-mode payout succeeded; settlement confirmed on-chain",
      traceNote: "",
    },
  },
};

const isMockCountry = (value: string): value is MockCountry => (MOCK_COUNTRIES as readonly string[]).includes(value);

/** HOGEE_COUNTRY → the demo to serve. Throws (fail closed) on anything but SG or MY. */
export function parseMockCountry(raw: string | undefined): MockCountry {
  const value = raw?.trim() || DEFAULT_MOCK_COUNTRY;
  if (!isMockCountry(value)) {
    throw new Error(`HOGEE_COUNTRY must be SG or MY for the mock (SG: Mei, MY: Rina; ID is a preview only), got "${value}"`);
  }
  return value;
}

/**
 * The reserve's tax payee for this facility (iras-tax for Mei's, lhdn-tax for Rina's). Throws for a facility no
 * profile knows: the reserve never goes to a payee guessed for another country.
 */
export function taxPayeeIdOf(facility: Pick<Facility, "facilityId" | "currency">): string {
  const profile = Object.values(PROFILES).find((p) => p.ids.facilityId === facility.facilityId && p.currency === facility.currency);
  if (!profile) throw new Error(`api-mock: no tax payee for facility ${facility.facilityId} (${facility.currency})`);
  return profile.ids.taxPayeeId;
}
