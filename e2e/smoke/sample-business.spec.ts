/**
 * The "Sample business" switch (UX round 2; docs/decisions/ux2-demo-data.md). dev:mock serves the sample business when
 * MOCK_SCENARIO is unset (apps/web scripts/dev-mock.test.mjs checks that default); this e2e server is pinned to the
 * status gallery for the other smoke specs (playwright.config.ts), so the first test puts the store where a plain
 * `dev:mock` starts, then the switch in the quick settings turns it off (a fresh start) and on again. The switch is the
 * loan officer's only, as Reset the demo (run-10 v-5): Mei sees it locked, and the tests become the officer first
 * (signInAsOfficer: the access code never enters the browser), then Mei again (View as) to look at Mei's chat. It rebuilds
 * the shared mock store, so it runs in its own project after after-reset ("sample-business").
 */
import { expect, test, type Page } from "@playwright/test";
import { expectPageHygiene, officerPost, openDemoMenu, signInAsOfficer, switchPersona, watch } from "../support/app";

const PATH = "/api/demo/sample-business";
const WELCOME = "This is a sample business, three weeks in";
const OFFICER_ONLY = "Only the loan officer can switch the demo data. Use View as → Loan officer.";

test.describe.configure({ mode: "serial" });

/** The switch in the quick settings panel (the settings agent mounts it there and on /settings). */
async function sampleSwitch(page: Page) {
  const row = (await openDemoMenu(page)).getByTestId("demo-data-toggle");
  await expect(row).toBeVisible();
  return { row, control: row.getByRole("switch", { name: "Sample business" }) };
}

async function state(page: Page): Promise<{ on: boolean; scenario: string | null; used: boolean }> {
  return (await page.request.get(PATH)).json();
}

/** Becomes the loan officer and opens the Settings page, where the switch works for them. */
async function asOfficer(page: Page): Promise<void> {
  await signInAsOfficer(page);
  await page.goto("/settings");
}

/** No hash on these pages links to a block explorer: the sample's hashes are made up (mock mode never links one). */
async function expectNoExplorerLinks(page: Page, label: string): Promise<void> {
  await expect(page.locator('a[href*="etherscan"], a[href*="/tx/0x"]'), `${label} links a made-up hash`).toHaveCount(0);
}

test("the sample business, as dev:mock starts: Mei three weeks in on chat, Wallet and Plan, labelled sample", async ({ page }) => {
  await officerPost(PATH, { on: true });
  const seen = watch(page);
  await page.goto("/chat");
  await expect(page.getByText(WELCOME)).toBeVisible();
  // The journey's Next step: the second order is paid its deposit and waits for the goods, then the delivery check.
  await expect(page.getByTestId("next-step-strip").first()).toHaveAttribute("data-step", "in-transit");
  await expect(page.getByTestId("goods-arrived").first()).toBeVisible();
  // Mei sees the sample business is on, locked: only the loan officer switches it (the server says 403 to Mei too).
  const { row, control } = await sampleSwitch(page);
  await expect(control).toHaveAttribute("aria-checked", "true");
  await expect(control).toBeDisabled();
  await expect(row).toContainText(OFFICER_ONLY);
  expect((await page.request.post(PATH, { data: { on: false } })).status(), "Mei cannot switch it").toBe(403);
  await page.keyboard.press("Escape");
  await expectNoExplorerLinks(page, "/chat");
  await expectPageHygiene(page, "/chat");

  await page.goto("/dashboard");
  await expect(page.getByText("Sample data").first()).toBeVisible();
  await expectNoExplorerLinks(page, "/dashboard");
  await expectPageHygiene(page, "/dashboard");

  await page.goto("/plan");
  await expect(page.locator("h1").first()).toBeVisible();
  await expectNoExplorerLinks(page, "/plan");
  await expectPageHygiene(page, "/plan");
  expect((await state(page)).used, "looking around is not using the demo").toBe(false);
  seen.assertClean();
});

test("the loan officer switches it off for a fresh start: Mei gets the first question, no plan", async ({ page }) => {
  await asOfficer(page);
  const { row, control } = await sampleSwitch(page);
  await expect(row).toContainText("Mei three weeks in. Off: start fresh.");
  await expect(control).toBeEnabled();
  // Nothing was done in this demo yet, so it switches at once (no confirm step) and lands on the officer's home.
  await control.click();
  await expect(page).toHaveURL(/\/officer$/);
  expect(await state(page)).toMatchObject({ on: false, scenario: "fresh", used: false });
  expect((await page.request.get("/api/plans/current")).status()).toBe(404);
  await expect((await sampleSwitch(page)).control).toHaveAttribute("aria-checked", "false");

  // Mei again (View as): Mei's chat starts at the first question.
  await switchPersona(page, "founder");
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("chat-opener")).toBeVisible();
  await expect(page.getByText(WELCOME)).toHaveCount(0);
});

test("switching it back restores the sample business, asking the officer first once the demo was used", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByTestId("chat-opener")).toBeVisible();
  await page.getByLabel("Message to Hogee").fill("Is my money safe?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(async () => (await state(page)).used).toBe(true);

  await asOfficer(page);
  const { control } = await sampleSwitch(page);
  await control.click();
  const confirm = page.getByTestId("demo-data-confirm");
  await expect(confirm).toBeVisible();
  // "Keep this demo" changes nothing.
  await confirm.getByRole("button", { name: "Keep this demo" }).click();
  await expect(confirm).toBeHidden();
  expect((await state(page)).on).toBe(false);

  await (await sampleSwitch(page)).control.click();
  await page.getByTestId("demo-data-confirm").getByRole("button", { name: "Show the sample" }).click();
  await expect(page).toHaveURL(/\/officer$/);
  await switchPersona(page, "founder");
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByText(WELCOME)).toBeVisible();
  await expect(page.getByTestId("next-step-strip").first()).toHaveAttribute("data-step", "in-transit");
  expect(await state(page)).toMatchObject({ on: true, scenario: "lived", used: false });
});
