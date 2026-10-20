/**
 * The demo payee registry (§8.3 "static platform registry", §5 trust boundary 3), one set per demo country: the
 * founder's Shopee platform accounts, the tax payee for reserve withdrawals and one onboarded vendor (the packaging
 * printer, added only by a founder + lender ADD_PAYEE). TEST accounts only: Rina's (MY) on DuitNow, Mei's (SG) on
 * PayNow, which the worker's MockRail simulates (SG-DECISIONS: never a real SG payout). The final-1 deploy fixes every
 * platform payee of BOTH countries in Treasury (PLATFORM_PAYEE_IDS / PLATFORM_PAYOUT_HASHES from
 * `platformPayeeDeployArgs`); a facility only ever seeds and checks its own country's set (`demoPayeesFor`), and the
 * API refuses to open one whose on-chain hashes differ, so a payout can never go to an account nobody signed.
 */
import { MEI_IDS, payoutAccountHash, RINA_IDS, type CountryCode, type Hex32 } from "@hogee/core";
import type { OnboardedPayee } from "../context";

/** The countries with a demo payee set. ID has none: it is refused, never given another country's payees. */
export type DemoPayeeCountry = "MY" | "SG";

/** The payout rail every payee of a country's set uses (SG-DECISIONS: SG_PAYNOW mirrors MY_DUITNOW). */
export const PAYOUT_CHANNEL_BY_COUNTRY: Readonly<Record<DemoPayeeCountry, string>> = { MY: "MY_DUITNOW", SG: "SG_PAYNOW" };

const MY_PAYEES: readonly OnboardedPayee[] = [
  {
    payeeId: RINA_IDS.adsPayeeId,
    displayName: "Shopee Ads (test)",
    source: "platform",
    lineKey: "ADS",
    channels: ["shopee"],
    account: { channel: "MY_DUITNOW", accountNumber: "1000000001", holderName: "Shopee Ads Test" },
  },
  {
    payeeId: RINA_IDS.platformFeesPayeeId,
    displayName: "Shopee fees (test)",
    source: "platform",
    lineKey: "PLATFORM_FEES",
    channels: ["shopee"],
    account: { channel: "MY_DUITNOW", accountNumber: "1000000002", holderName: "Shopee Fees Test" },
  },
  {
    payeeId: RINA_IDS.logisticsPayeeId,
    displayName: "SPX Logistics (test)",
    source: "platform",
    lineKey: "LOGISTICS",
    channels: ["shopee"],
    account: { channel: "MY_DUITNOW", accountNumber: "1000000003", holderName: "SPX Test" },
  },
  {
    payeeId: RINA_IDS.taxPayeeId,
    displayName: "LHDN tax payment (test)",
    source: "platform",
    account: { channel: "MY_DUITNOW", accountNumber: "1000000004", holderName: "LHDN Test" },
  },
  {
    payeeId: RINA_IDS.packagingPayeeId,
    displayName: "KL packaging printer (test)",
    source: "vendor",
    lineKey: "PACKAGING",
    account: { channel: "MY_DUITNOW", accountNumber: "1000000005", holderName: "Printer KL Sdn Bhd" },
  },
];

/**
 * Mei's set mirrors Rina's line for line (SG-DECISIONS "Mei's ids and caps"); `iras-tax` mirrors `lhdn-tax`. PayNow pays to a
 * proxy, so each account is a PayNow UEN. They are synthetic: entity type "ZZ" is not an ACRA type, so no real entity
 * can hold one. SG payouts run on the simulated rail (never a real PayNow transfer).
 */
const SG_PAYEES: readonly OnboardedPayee[] = [
  {
    payeeId: MEI_IDS.adsPayeeId,
    displayName: "Shopee Ads Singapore (test)",
    source: "platform",
    lineKey: "ADS",
    channels: ["shopee"],
    account: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0001A", holderName: "Shopee Ads SG Test" },
  },
  {
    payeeId: MEI_IDS.platformFeesPayeeId,
    displayName: "Shopee fees Singapore (test)",
    source: "platform",
    lineKey: "PLATFORM_FEES",
    channels: ["shopee"],
    account: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0002B", holderName: "Shopee Fees SG Test" },
  },
  {
    payeeId: MEI_IDS.logisticsPayeeId,
    displayName: "SPX Logistics Singapore (test)",
    source: "platform",
    lineKey: "LOGISTICS",
    channels: ["shopee"],
    account: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0003C", holderName: "SPX SG Test" },
  },
  {
    payeeId: MEI_IDS.taxPayeeId,
    displayName: "IRAS tax payment (test)",
    source: "platform",
    account: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0004D", holderName: "IRAS Test" },
  },
  {
    payeeId: MEI_IDS.packagingPayeeId,
    displayName: "Singapore packaging printer (test)",
    source: "vendor",
    lineKey: "PACKAGING",
    account: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0005E", holderName: "Printer SG Pte Ltd" },
  },
];

export const DEMO_PAYEES_BY_COUNTRY: Readonly<Record<DemoPayeeCountry, readonly OnboardedPayee[]>> = { MY: MY_PAYEES, SG: SG_PAYEES };

/** Rina's (MY) set, as before Singapore: the loop harness, the red-team world and the MY test catalog use it. */
export const DEMO_PAYEES: readonly OnboardedPayee[] = MY_PAYEES;

/** Every demo payee of every country, MY first (so the MY ids keep their deploy order). */
export const ALL_DEMO_PAYEES: readonly OnboardedPayee[] = [...MY_PAYEES, ...SG_PAYEES];

const hasPayeeSet = (country: string): country is DemoPayeeCountry => Object.hasOwn(DEMO_PAYEES_BY_COUNTRY, country);

/** The payee set of a country; throws for a country without one (ID), never falling back to another country's. */
export function demoPayeesFor(country: CountryCode): readonly OnboardedPayee[] {
  if (!hasPayeeSet(country)) throw new Error(`No demo payees for ${String(country)}`);
  return DEMO_PAYEES_BY_COUNTRY[country];
}

/** The reserve's tax payee per country (lhdn-tax for MY, iras-tax for SG): WITHDRAW_RESERVE's only destination. */
const TAX_PAYEE_ID_BY_COUNTRY: Readonly<Record<DemoPayeeCountry, string>> = { MY: RINA_IDS.taxPayeeId, SG: MEI_IDS.taxPayeeId };

/**
 * The tax payee of `country`'s set (hardening run-8): final-1 registers both countries' platform payees, so the chain
 * alone would let a reserve go to the other country's tax payee or a line's platform payee. Throws for a country
 * without a set (ID), never falling back to another country's.
 */
export function taxPayeeFor(country: CountryCode): OnboardedPayee {
  if (!hasPayeeSet(country)) throw new Error(`No reserve tax payee for ${String(country)}`);
  const id = TAX_PAYEE_ID_BY_COUNTRY[country];
  const payee = DEMO_PAYEES_BY_COUNTRY[country].find((p) => p.payeeId === id && p.source === "platform" && p.lineKey === undefined);
  if (!payee) throw new Error(`The ${country} payee set has no static tax payee ${id}`);
  return payee;
}

/**
 * `payees` if every one pays out on `country`'s rail, else throws naming the first payee that does not (a catalog
 * that serves another country's payees, e.g. Rina's DuitNow accounts and LHDN to an SG facility, is refused).
 */
export function requireCountryPayees(country: CountryCode, payees: readonly OnboardedPayee[]): readonly OnboardedPayee[] {
  if (!hasPayeeSet(country)) throw new Error(`No demo payees for ${String(country)}`);
  const channel = PAYOUT_CHANNEL_BY_COUNTRY[country];
  const foreign = payees.find((p) => p.account.channel !== channel);
  if (foreign) throw new Error(`The payee ${foreign.payeeId} pays out on ${foreign.account.channel}, not ${country}'s ${channel}`);
  return payees;
}

export const payoutHashOf = (p: Pick<OnboardedPayee, "account">): Hex32 => payoutAccountHash(p.account);

/**
 * PLATFORM_PAYEE_IDS / PLATFORM_PAYOUT_HASHES for DeployFinal (static platform payees only). By default both
 * countries' platform payees (SG-DECISIONS: Mei's hashes go into the final-1 deploy alongside Rina's), MY first.
 */
export function platformPayeeDeployArgs(payees: readonly OnboardedPayee[] = ALL_DEMO_PAYEES): { ids: string; hashes: string } {
  const platform = payees.filter((p) => p.source === "platform");
  return { ids: platform.map((p) => p.payeeId).join(","), hashes: platform.map((p) => payoutHashOf(p)).join(",") };
}
