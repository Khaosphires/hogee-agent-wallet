/**
 * The demo payees' payout accounts, exactly as the live API's catalog holds them (packages/api src/catalog/payees.ts,
 * which @hogee/api does not export), so the mock signs the same payout hashes (payoutAccountHash) as the API.
 * test/payees.test.ts fails if the two differ. TEST accounts only: Rina's on DuitNow; Mei's on PayNow to synthetic UEN
 * proxies (entity type "ZZ" is not an ACRA type), which the worker's MockRail simulates (never a real SG payout).
 */
import { MEI_IDS, RINA_IDS, payoutAccountHash, type Hex32 } from "@hogee/core";
import type { MockCountry } from "./profile";

export interface PayoutAccount {
  readonly channel: string;
  readonly accountNumber: string;
  readonly holderName: string;
}

export const DEMO_PAYEE_ACCOUNTS: { readonly [C in MockCountry]: Readonly<Record<string, PayoutAccount>> } = {
  SG: {
    [MEI_IDS.adsPayeeId]: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0001A", holderName: "Shopee Ads SG Test" },
    [MEI_IDS.platformFeesPayeeId]: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0002B", holderName: "Shopee Fees SG Test" },
    [MEI_IDS.logisticsPayeeId]: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0003C", holderName: "SPX SG Test" },
    [MEI_IDS.taxPayeeId]: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0004D", holderName: "IRAS Test" },
    [MEI_IDS.packagingPayeeId]: { channel: "SG_PAYNOW", accountNumber: "S99ZZ0005E", holderName: "Printer SG Pte Ltd" },
  },
  MY: {
    [RINA_IDS.adsPayeeId]: { channel: "MY_DUITNOW", accountNumber: "1000000001", holderName: "Shopee Ads Test" },
    [RINA_IDS.platformFeesPayeeId]: { channel: "MY_DUITNOW", accountNumber: "1000000002", holderName: "Shopee Fees Test" },
    [RINA_IDS.logisticsPayeeId]: { channel: "MY_DUITNOW", accountNumber: "1000000003", holderName: "SPX Test" },
    [RINA_IDS.taxPayeeId]: { channel: "MY_DUITNOW", accountNumber: "1000000004", holderName: "LHDN Test" },
    [RINA_IDS.packagingPayeeId]: { channel: "MY_DUITNOW", accountNumber: "1000000005", holderName: "Printer KL Sdn Bhd" },
  },
};

/** The payout hash of one of this demo's onboarded payees, or undefined for any other id (never another demo's). */
export function demoPayoutHash(country: MockCountry, payeeId: string): Hex32 | undefined {
  const accounts = DEMO_PAYEE_ACCOUNTS[country];
  return Object.hasOwn(accounts, payeeId) ? payoutAccountHash(accounts[payeeId] as PayoutAccount) : undefined;
}
