import { expect, test, type Page } from "@playwright/test";
import { expectPageHygiene, watch } from "../support/app";
import { CFO_DISCLAIMER, getJson, type CfoReport } from "../support/journey";

/**
 * Wallet (/dashboard; UX2 P1 decisions 1 and 6, ux-money D8 and D13 before it, UX round 3 on the shared frame): one
 * scrolling page, no tabs, a section for every id in apps/web/lib/sections.ts in order. Four numbers with one source
 * each (Ready to spend from the wallet, the rest from the report), sample sales labelled "Sample" where they sit beside
 * real records, the pockets as the wallet counts them (PocketRow), every number section rendering its card, old ?tab=
 * links landing on their section, Receipts, and none of the old proof dashboard (no "Reconciler drift", no "0 human
 * signatures": those live under Proof → Wallet details). No request is ever shown by its stored title.
 */

interface Balances {
  fundedMinor: string;
  releasedMinor: string;
  escrowMinor: string;
  pockets: { lineKey: string; spent: string; available: string }[];
}

/** The page's sections in order (apps/web/lib/sections.ts "/dashboard"; the ids are fixed by P1). */
const WALLET_SECTIONS = [
  { id: "wallet-overview", label: "Overview" },
  { id: "wallet-activity", label: "Activity" },
  { id: "wallet-spending", label: "Spending" },
  { id: "wallet-sales", label: "Sales" },
  { id: "wallet-profit", label: "Profit" },
  { id: "wallet-forecast", label: "Forecast" },
  { id: "wallet-tax", label: "Tax money" },
  { id: "wallet-receipts", label: "Receipts" },
] as const;

/** Old links: each CFO view's ?tab= lands on its section (the overview is the top of the page). */
const OLD_TABS = [
  { view: "spending", section: "wallet-spending" },
  { view: "sales", section: "wallet-sales" },
  { view: "pnl", section: "wallet-profit" },
  { view: "forecast", section: "wallet-forecast" },
  { view: "reserve", section: "wallet-tax" },
] as const;

/** The report slice this spec reads beyond support/journey.ts's CfoReport. */
type MoneyReport = CfoReport & { readonly pnl: { readonly netMinor: string }; readonly forecast: { readonly sampleDays: number } };

const big = (xs: string[]) => xs.reduce((a, x) => a + BigInt(x), 0n);

/**
 * Ready to spend as core walletFigures computes it from GET /api/balances (the wallet rail's source): every pocket's
 * available BU, capped by the released budget and the funding less what already left (spent + sent to escrow).
 */
function readyToSpend(b: Balances): string {
  const outflow = big(b.pockets.map((p) => p.spent)) + BigInt(b.escrowMinor);
  const room = (ceiling: string) => (BigInt(ceiling) > outflow ? BigInt(ceiling) - outflow : 0n);
  return [big(b.pockets.map((p) => p.available)), room(b.releasedMinor), room(b.fundedMinor)].reduce((m, x) => (x < m ? x : m)).toString();
}

const tiles = (page: Page) => page.getByTestId("money-tiles");
const tileMinor = (page: Page, key: string) => tiles(page).getByTestId(`cfo-tile-${key}`).locator("[data-minor]").first();

test("the four numbers: Ready to spend from the wallet, the rest from the report, sample sales labelled, pockets as the wallet counts them", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Wallet", exact: true })).toBeVisible();
  await expect(tiles(page).locator("[data-testid^=cfo-tile-]")).toHaveCount(4);

  // Other smoke specs share the mock store: read the API again on each try, so a payment landing between the two
  // reads can't fail the comparison.
  await expect(async () => {
    const balances = await getJson<Balances>(page, "/api/balances");
    await expect(tileMinor(page, "cash")).toHaveAttribute("data-minor", readyToSpend(balances), { timeout: 2_000 });
    // Each pocket row's value says what is left in it, from the same answer (the value is the row's last amount).
    for (const p of balances.pockets) {
      const row = page.getByTestId("wallet-pockets").locator(`[data-testid=pocket-row][data-line="${p.lineKey}"]`);
      await expect(row.locator("[data-minor]").last()).toHaveAttribute("data-minor", p.available, { timeout: 2_000 });
    }
  }).toPass({ timeout: 30_000 });
  await expect(async () => {
    const report = await getJson<CfoReport>(page, "/api/cfo");
    await expect(tileMinor(page, "spent")).toHaveAttribute("data-minor", report.overview.spentMinor, { timeout: 2_000 });
    await expect(tileMinor(page, "revenue")).toHaveAttribute("data-minor", report.overview.revenueMinor, { timeout: 2_000 });
    await expect(tileMinor(page, "reserve")).toHaveAttribute("data-minor", report.overview.reserveMinor, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // Mock sales are a sample beside the mock's own payments: said once at the top and on the figures built on them, never
  // on the money that moved.
  await expect(page.getByTestId("cfo-data-label")).toContainText("Sample data");
  await expect(page.getByTestId("cfo-sample-note")).toHaveText("These are sample sales for the demo, not real orders.");
  for (const key of ["revenue", "reserve"]) await expect(tiles(page).getByTestId(`cfo-tile-${key}`).getByTestId("cfo-sample-tag")).toHaveText("Sample");
  for (const key of ["cash", "spent"]) await expect(tiles(page).getByTestId(`cfo-tile-${key}`).getByTestId("cfo-sample-tag")).toHaveCount(0);

  // The old proof dashboard stays under Proof.
  await expect(page.locator("[data-testid^=stat-]")).toHaveCount(0);
  await expect(page.getByText("Reconciler drift")).toHaveCount(0);
  await expect(page.getByText("human signatures")).toHaveCount(0);

  // Activity: the latest rows, each with its amount and unit; a sale is money in.
  const activity = page.locator("#wallet-activity");
  await expect(activity.locator("[data-testid=activity-row], [data-testid=agent-action]").first()).toBeVisible();

  // Receipts: plain rows, the latest three first, each amount with its unit.
  const receipts = page.locator("#wallet-receipts");
  await expect(receipts.getByRole("heading", { name: "Receipts" })).toBeVisible();
  await expect(receipts.getByTestId("receipt-row").first()).toBeVisible();
  expect(await receipts.getByTestId("receipt-row").count()).toBeLessThanOrEqual(3);
  for (const text of await page.locator("[data-minor]").allTextContents()) expect(text).toMatch(/ BU/);

  // Waiting for her signature: titled by the request's kind (a template), one per kind, one filled button.
  const waiting = page.locator("[data-testid^=founder-]");
  if ((await waiting.count()) > 0) {
    const exceptions = await getJson<{ exceptionId: string; title: string }[]>(page, "/api/exceptions");
    for (const e of exceptions) await expect(page.getByText(e.title, { exact: true })).toHaveCount(0);
    await expect(page.locator('#waiting-signature [data-testid^=founder-] [data-slot=button][data-variant=default]')).toHaveCount(1);
  }

  // Asking for a higher limit is folded; a link to it opens the fold.
  await expect(page.getByRole("form", { name: "Ask for a change" })).toBeHidden();
  await page.goto("/dashboard#change-requests");
  await expect(page.getByRole("form", { name: "Ask for a change" })).toBeVisible();
  await expect(page.getByTestId("ask-higher-limit")).toContainText("You or your loan officer can cancel it during the wait.");
  await expectPageHygiene(page, "/dashboard");
  seen.assertClean();
});

test("one page of sections in the side nav's order, every number section renders, the disclaimer once, old ?tab= links land, charts ship a table", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Wallet", exact: true })).toBeVisible();
  await expect(page.locator("main section[id^=wallet-]")).toHaveCount(WALLET_SECTIONS.length);
  expect(await page.locator("main section[id^=wallet-]").evaluateAll((els) => els.map((el) => el.id))).toEqual(WALLET_SECTIONS.map((s) => s.id));
  for (const s of WALLET_SECTIONS) await expect(page.locator(`#${s.id}`).getByRole("heading", { level: 2, name: s.label, exact: true })).toBeAttached();
  await expect(page.getByRole("tab")).toHaveCount(0);

  // The disclaimer once, small, on the page; the report carries the same words.
  await expect(page.getByTestId("cfo-disclaimer")).toHaveCount(1);
  await expect(page.getByTestId("cfo-disclaimer")).toHaveText(CFO_DISCLAIMER);
  const report = await getJson<MoneyReport>(page, "/api/cfo");
  expect(report.disclaimer).toBe(CFO_DISCLAIMER);

  // Every number section renders its card.
  for (const id of ["wallet-spending-card", "wallet-sales-card", "wallet-profit-card", "wallet-tax-card"]) {
    await page.getByTestId(id).scrollIntoViewIfNeeded();
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId(report.forecast.sampleDays >= 3 ? "wallet-forecast-card" : "forecast-too-early")).toBeVisible();
  await expectPageHygiene(page, "/dashboard (all sections)");

  // Every chart ships its table, one press away.
  const spending = page.locator("#wallet-spending");
  await expect(spending.getByRole("table")).toBeHidden();
  await spending.getByText("Show figures").click();
  await expect(spending.getByRole("table")).toBeVisible();

  // Profit: a profit or a loss, named as such; a loss says why and is never drawn as a profit.
  const hero = page.getByTestId("cfo-net-hero");
  await expect(hero.locator("[data-minor]")).toHaveAttribute("data-minor", report.pnl.netMinor);
  if (report.pnl.netMinor.startsWith("-")) {
    await expect(hero).toHaveAttribute("data-loss", "true");
    await expect(page.getByTestId("cfo-loss-reason")).toBeVisible();
    await expect(page.locator("#wallet-profit [data-loss=true]").first()).toBeVisible();
  } else {
    await expect(page.getByTestId("cfo-loss-reason")).toHaveCount(0);
  }

  // Old links: each ?tab= view lands on its section once the figures are in; overview and anything else stay on top.
  for (const t of OLD_TABS) {
    await page.goto(`/dashboard?tab=${t.view}`);
    await expect(page.locator(`#${t.section}`)).toBeInViewport({ ratio: 0.2 });
    await expect(page.getByRole("heading", { level: 1, name: "Wallet", exact: true })).not.toBeInViewport();
  }
  for (const view of ["overview", "bogus"]) {
    await page.goto(`/dashboard?tab=${view}`);
    await expect(tileMinor(page, "spent")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Wallet", exact: true })).toBeInViewport();
  }
  seen.assertClean();
});

test("on a phone the page is one column: the wallet card first, then the pockets, and nothing scrolls sideways", async ({ page }) => {
  const seen = watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await expect(tileMinor(page, "cash")).toBeVisible();
  const card = await tiles(page).boundingBox();
  const pockets = await page.getByTestId("wallet-pockets").boundingBox();
  expect(card && pockets && pockets.y > card.y + card.height - 1).toBe(true);
  await page.goto("/dashboard?tab=reserve");
  await expect(page.locator("#wallet-tax")).toBeInViewport({ ratio: 0.2 });
  await expectPageHygiene(page, "/dashboard at 390 px");
  seen.assertClean();
});
