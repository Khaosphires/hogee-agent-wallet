/**
 * The chat-first journey from the e2e's side (VISION-DECISIONS §4; plan §1): the demo's fixed numbers, the documented
 * test ids of each card and who builds it, and the steps that journey/journey.spec.ts and the demo video share.
 *
 * Test ids (agreed with each owner on 19 Oct; docs/decisions/int-e2e-author.md lists them with their owner):
 *   v-chat-ui    card-needs, card-sign, card-next, card-enquiry; next-action[data-action-type]; sign-open; sign-review;
 *                sign-status[data-state=idle|submitted|confirmed|failed|superseded]; copy-enquiry; enquiry-subject; enquiry-body;
 *                chat-opener; chat-announcer; the composer "Message to Hogee"/"Send"
 *   ux-chat      next-step[data-step][data-stage] (the Next step bar from 1100 px; its button next-step-action);
 *                action-event (a pressed button, as a past-tense line); card-moved (an older copy of a card);
 *                intent-card ("What I heard")
 *   v-search     card-search[data-status][data-stage][data-provider]; card-candidates; candidate[data-rank]
 *                [data-supplier-id][data-origin]; excluded-summary; pick-submit; the "Pick #<rank> …" checkboxes
 *   v-terms      card-terms; [data-preset][data-available]; terms-submit; terms-error[data-code]; schedule-row
 *                [data-trigger][data-auto|data-released]; card-order[data-order-id]; cooling-countdown
 *   v-cfo        card-cfo[data-view]; cfo-tile-<key> [data-minor]; cfo-insight[data-kind]; cfo-disclaimer;
 *                cfo-data-label; agent-action; the /dashboard tabs
 */
import { expect, type Locator, type Page, type Response } from "@playwright/test";
import { officerPost } from "./app";
import type { Click } from "./enrolment";

/**
 * The demo order (P1, 19 Oct, after integration: a 4,000 BU order used all of Mei's stage-1 money once escrowed): a
 * web supplier at 2,500 BU, preset 30/70, so a 750 BU deposit the agent pays and a 1,750 BU balance (1 BU = 100 minor).
 */
export const DEMO_ORDER = {
  // A first batch: the search is priced for 1,000 units; Mei orders 600 at about 4.2 BU each, in line with the listings.
  quantity: 600,
  totalBu: "2500",
  totalMinor: "250000",
  preset: "P30_70",
  depositMinor: "75000",
  balanceMinor: "175000",
} as const;

/** The simulated payout account typed into the terms form (MOCK_ONLY channel; 6–20 digits, a company payee). */
export const DEMO_PAYOUT = { bank: "DBS Bank", accountNumber: "100200300400" } as const;

/** What the loan officer funds after the plan is signed (runbook §8 step 5; capped at the plan total). */
export const FACILITY_FUNDING_MINOR = "1000000";

/**
 * The recorded sample's pages that must never become candidates (data/suppliers/search/recorded): Veltrix carries an
 * instruction aimed at the AI and Marrowind one asking for the founder's ID and phone (T33). Both trip AI_INJECTION.
 */
export const INJECTED_SUPPLIER_IDS = ["supplier-w6yrjswhernrr", "supplier-w5nwa6flp3s5t"] as const;

/** The listing domains a candidate's host link may point at (checks LISTING_DOMAINS). */
export const LISTING_DOMAINS = ["alibaba.com", "made-in-china.com", "globalsources.com", "1688.com"] as const;

/** The disclaimer every CFO view carries (core CfoReport.disclaimer, a schema literal). */
export const CFO_DISCLAIMER = "Estimates from your own records. Not financial advice.";

/** The /dashboard tabs (CFO_VIEWS order) and their names (ux-money: the pnl view is "Profit", the reserve view "Tax money"). */
export const CFO_TABS = [
  { view: "overview", name: "Overview" },
  { view: "spending", name: "Spending" },
  { view: "sales", name: "Sales" },
  { view: "pnl", name: "Profit" },
  { view: "forecast", name: "Forecast" },
  { view: "reserve", name: "Tax money" },
] as const;

/**
 * The overview tiles and the GET /api/cfo field each one shows (ux-money: four tiles, Ready to spend · Paid out · Sales ·
 * Kept for tax; profit lives on the Profit tab). cash shows walletFigures over GET /api/balances, equal to the report's
 * cashAvailableMinor in the mock.
 */
export const CFO_OVERVIEW_TILES = {
  cash: "cashAvailableMinor",
  spent: "spentMinor",
  revenue: "revenueMinor",
  reserve: "reserveMinor",
} as const;

// ---- the slices of the API answers the e2e reads (core schemas, VISION-DECISIONS §3) -------------------------------

export interface CandidateCard {
  readonly supplierId: string;
  readonly origin: "catalog" | "web";
  readonly displayName: string;
  readonly rank: number | null;
  readonly unverified: boolean;
  readonly canOrder: boolean;
  readonly priceFlag: boolean;
  readonly listingHost: string | null;
}

export interface SupplierSearch {
  readonly searchId: string;
  readonly status: "PENDING" | "READY" | "FAILED";
  readonly provider: "tavily" | "recorded";
  readonly omitted: readonly { reason: string; count: number }[];
  readonly excludedByGate: readonly { gate: string; count: number }[];
  readonly candidates: readonly CandidateCard[];
  readonly quantity: number;
}

export interface ScheduleRow {
  readonly trigger: string;
  readonly amountMinor: string;
  readonly autoRelease: boolean;
  readonly released: boolean;
  readonly txHash: string | null;
}

export interface OrderTerms {
  readonly termsId: string;
  readonly status: "CONFIRMED" | "SUPERSEDED" | "USED";
  readonly supplierId: string;
  readonly totalMinor: string;
  readonly schedule: readonly ScheduleRow[];
  readonly orderId: string | null;
  readonly coolingEndsAt: string | null;
}

export interface CfoReport {
  readonly overview: Readonly<Record<(typeof CFO_OVERVIEW_TILES)[keyof typeof CFO_OVERVIEW_TILES], string>>;
  readonly pnl: { readonly supplierCostMinor: string };
  readonly disclaimer: string;
}

// ---- locators ------------------------------------------------------------------------------------------------------

/** The newest card of a chat-first part (data-needs → card-needs): older ones stay in the thread above it. */
export const card = (page: Page, part: string): Locator => page.getByTestId(`card-${part}`).last();

/**
 * A schedule row of a trigger whose release state is `released`: the order card puts data-released on the row or on
 * an element inside it (v-terms), so both match.
 */
export const scheduleRow = (trigger: string, released: boolean): string =>
  `[data-testid=schedule-row][data-trigger="${trigger}"]:is([data-released="${released}"], :has([data-released="${released}"]))`;

/** A button of the newest next-step card, by the ChatAction it sends (labels may change; the action type does not). */
export const nextAction = (page: Page, actionType: string): Locator =>
  card(page, "next").locator(`[data-testid=next-action][data-action-type="${actionType}"]`);

export const assistantMessages = (page: Page): Locator => page.locator("[data-testid=chat-message][data-role=assistant]");

/** The Next step bar above the composer (UX-PLAN §3): data-step is the step's key, data-stage the journey stage. */
export const nextStepBar = (page: Page): Locator => page.getByTestId("next-step");

/** Presses the Next step bar's one button (it sends the same action, or opens the same sign dialog, as the cards). */
export const nextStepButton = (page: Page): Locator => nextStepBar(page).getByTestId("next-step-action");

// ---- steps ---------------------------------------------------------------------------------------------------------

/** Types a message into the composer and sends it (the founder's free text goes to classifySkill). */
export async function say(page: Page, text: string, click: Click = (target) => target.click()): Promise<void> {
  await page.getByLabel("Message to Hogee").fill(text);
  await click(page.getByRole("button", { name: "Send" }));
}

/** The intake: the opener, then the first option of each of the three clarifying questions (CHAT_SCRIPTS.SG). */
export async function answerIntake(page: Page, click: Click = (target) => target.click()): Promise<void> {
  await click(page.getByRole("button", { name: /^I want to sell custom insulated tumblers/ }));
  for (let i = 0; i < 3; i += 1) {
    const question = page.getByTestId("question").nth(i);
    await expect(question).toBeVisible();
    await click(question.getByRole("button").first());
    await expect(question.getByRole("button").first()).toBeDisabled();
  }
}

/**
 * Opens the SignHost dialog with `opener`, checks the browser-side digest, enrols a passkey first when `enrol` is given
 * (the fresh mock seeds no usable key: the officer's one-time code goes into the dialog, as live), signs and closes.
 */
export async function signInDialog(
  page: Page,
  opener: Locator,
  options: { enrol?: (dialog: Locator) => Promise<void>; click?: Click; beforeSign?: (dialog: Locator) => Promise<void> } = {},
): Promise<void> {
  const click = options.click ?? ((target: Locator) => target.click());
  await click(opener);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("digest-check")).toHaveAttribute("data-ok", "true");
  await expect(dialog.getByTestId("sign-digest")).toHaveText(/^0x[0-9a-f]{64}$/);
  if (options.enrol) await options.enrol(dialog);
  if (options.beforeSign) await options.beforeSign(dialog);
  await click(dialog.getByRole("button", { name: "Sign with passkey", exact: true }));
  await expect(dialog.getByTestId("sign-done")).toBeVisible();
  // Escape is harmless if SignHost already closed the dialog itself after the submit.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/**
 * Fills the terms form (v-terms card): the demo's first-batch quantity, the demo total, the candidate's name as the account
 * holder (v-terms: a verbatim seller name passes the holder check), the simulated bank account, a company payee.
 */
export async function fillTermsForm(form: Locator, _search: SupplierSearch, holder: string): Promise<void> {
  await form.getByLabel("How many units", { exact: true }).fill(String(DEMO_ORDER.quantity));
  await form.getByLabel("Total price (BU)", { exact: true }).fill(DEMO_ORDER.totalBu);
  await form.getByLabel("Name on the account", { exact: true }).fill(holder);
  await form.getByLabel("Bank", { exact: true }).fill(DEMO_PAYOUT.bank);
  await form.getByLabel("Account number", { exact: true }).fill(DEMO_PAYOUT.accountNumber);
  const company = form.getByRole("radio", { name: "Company account", exact: true });
  await company.click();
  await expect(company).toBeChecked();
}

/** The loan officer funds the facility from Node (runbook §8 step 5): live needs it before the agent pays a deposit. */
export async function fundFacility(amountMinor: string = FACILITY_FUNDING_MINOR): Promise<void> {
  await officerPost("/api/facility/fund", { amountMinor });
}

/** Fails unless the server is the fresh scenario after a reset: no plan, nothing funded, no pockets (v-contract). */
export async function expectFreshMock(page: Page): Promise<void> {
  const session = (await (await page.request.get("/api/session")).json()) as { mode?: string };
  expect(session.mode, "the journey runs on the mock").toBe("mock");
  const plan = await page.request.get("/api/plans/current");
  expect(plan.status(), "a committed plan after reset: start the server with MOCK_SCENARIO=fresh (pnpm --filter @hogee/e2e journey)").toBe(404);
  const balances = (await (await page.request.get("/api/balances")).json()) as { fundedMinor: string; pockets: unknown[] };
  expect(balances.fundedMinor, "the fresh scenario funds nothing").toBe("0");
  expect(balances.pockets, "the fresh scenario has no pockets").toEqual([]);
}

/**
 * Keeps the newest READY body of GET /api/suppliers/search/:id (the search card polls it, and the candidates card
 * renders exactly that body; v-search). Install before the search starts.
 */
export function watchSearch(page: Page): { readonly ready: () => SupplierSearch | undefined } {
  let ready: SupplierSearch | undefined;
  page.on("response", async (response: Response) => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() !== "GET" || !/^\/api\/suppliers\/search\/[^/]+$/.test(path) || !response.ok()) return;
    const body = (await response.json().catch(() => undefined)) as SupplierSearch | undefined;
    if (body?.status === "READY") ready = body;
  });
  return { ready: () => ready };
}

/** The candidate the journey orders from: the best-ranked web candidate that can be ordered and has no price flag. */
export function orderableCandidate(search: SupplierSearch): CandidateCard {
  const ranked = [...search.candidates].filter((c) => c.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const pick = ranked.find((c) => c.origin === "web" && c.canOrder && !c.priceFlag && c.displayName !== "(name hidden)");
  if (!pick) throw new Error(`no orderable web candidate in search ${search.searchId}`);
  return pick;
}

/** GET a JSON route in the page's own context (its cookies), failing on anything but 2xx. */
export async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path);
  expect(res.ok(), `GET ${path} answered ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
