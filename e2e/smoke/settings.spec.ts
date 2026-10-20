/**
 * The Settings page and the top-right quick settings (UX round 2). The profile lives in each browser context's
 * localStorage and recording mode in its sessionStorage, so these tests never touch the shared mock store.
 */
import { expect, test, type Page } from "@playwright/test";
import { COUNTRY, FOUNDER_NAME, expectPageHygiene, openDemoMenu, signInAsOfficer, watch } from "../support/app";

// apps/web/lib/sections.ts, "/settings": the side nav scrolls to these ids.
const SECTIONS = [
  ["settings-profile", "Profile"],
  ["settings-business", "Business"],
  ["settings-display", "Display"],
  ["settings-demo", "Demo"],
  ["settings-security", "Security"],
] as const;

const FULL_NAME = FOUNDER_NAME === "Mei" ? "Mei Tan" : "Rina";

/** The page has hydrated once the quick settings' button is there (it waits for the session, a client query). */
async function openSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await expect(page.getByTestId("demo-menu")).toBeVisible();
}

test("the Settings page has a section for each side-nav id, from what the app already knows", async ({ page }) => {
  const seen = watch(page);
  await openSettings(page);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  for (const [id, title] of SECTIONS) {
    await expect(page.locator(`section#${id}`).getByRole("heading", { level: 2, name: title })).toBeVisible();
  }

  const profile = page.locator("#settings-profile");
  await expect(profile.getByTestId("profile-name")).toHaveText(FULL_NAME);
  await expect(profile.getByRole("textbox", { name: "Name" })).toHaveValue(FULL_NAME);
  await expect(profile.getByText("Saved on this device only.")).toBeVisible();

  // The country is shown, never edited.
  const business = page.locator("#settings-business");
  await expect(business.getByText(COUNTRY.home, { exact: true })).toBeVisible();
  await expect(business.getByRole("textbox", { name: /Country/ })).toHaveCount(0);
  await expect(business).toContainText("It doesn't change your plan, who gets paid, or any limit.");

  // Display says what Hogee follows in one line; nothing there looks like it could be pressed.
  const display = page.locator("#settings-display");
  await expect(display).toContainText("Text size, motion and transparency follow your device settings.");
  await expect(display.getByRole("listitem")).toHaveCount(0);
  await expect(display.getByRole("switch")).toHaveCount(0);

  const demo = page.locator("#settings-demo");
  await expect(demo.getByTestId("mode-badge")).toHaveText("Sample data");
  await expect(demo.getByRole("radiogroup", { name: "Persona" })).toBeVisible();
  await expect(demo.getByRole("switch", { name: "Recording mode" })).toHaveAttribute("aria-checked", "false");
  await expect(demo.getByRole("switch", { name: "Recording mode" })).toHaveAccessibleDescription("Hides demo switches for a screen recording.");
  // Only the loan officer can reset the demo.
  await expect(demo.getByRole("button", { name: "Reset the demo" })).toHaveCount(0);

  // Security is read only.
  const security = page.locator("#settings-security");
  const passkey = security.getByTestId("security-passkey");
  await expect(passkey).toContainText("Passkey");
  // Said plainly: where the passkey is, not that something is missing.
  await expect(passkey).toContainText(/On this device|On your signing device|Not set up yet/);
  await expect(passkey).not.toContainText("Not on this device");
  await expect(security.getByRole("textbox")).toHaveCount(0);
  // To the Plan's safety limit, not its tax rules.
  await expect(security.getByRole("link", { name: "How Hogee keeps your money safe" })).toHaveAttribute("href", "/plan#plan-safety");

  // Every settings row has a neutral tile (no pocket colours), and the small targets are 44 px.
  const tiles = page.locator('main [data-slot="icon-tile"]');
  expect(await tiles.count()).toBeGreaterThan(10);
  for (const tone of await tiles.evaluateAll((els) => els.map((el) => el.getAttribute("data-tone")))) expect(["ink", "grey"]).toContain(tone);
  const swatch = await profile.getByTitle("Violet").boundingBox();
  expect(swatch?.width).toBeGreaterThanOrEqual(44);
  expect(swatch?.height).toBeGreaterThanOrEqual(44);

  await expectPageHygiene(page, "/settings");
  seen.assertClean();
});

test("profile edits are saved on this device and survive a reload; a bad email or phone is refused inline", async ({ page }) => {
  await openSettings(page);
  const profile = page.locator("#settings-profile");
  const name = profile.getByRole("textbox", { name: "Name" });
  const email = profile.getByRole("textbox", { name: "Email" });
  const phone = profile.getByRole("textbox", { name: "Phone" });

  await name.fill(`${FOUNDER_NAME} Lin`);
  await name.press("Tab");
  await expect(profile.getByRole("status")).toHaveText("Saved on this device.");
  await expect(profile.getByTestId("profile-name")).toHaveText(`${FOUNDER_NAME} Lin`);

  // Errors show once the field is left, and clear as soon as it is fixed.
  await email.fill("mei@");
  await expect(email).not.toHaveAttribute("aria-invalid", "true");
  await email.press("Tab");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAccessibleDescription("Enter an email like name@example.com.");
  await email.fill("mei@example.com");
  await expect(email).not.toHaveAttribute("aria-invalid", "true");

  if (COUNTRY.home === "Singapore") {
    await phone.fill("1234 5678");
    await phone.press("Tab");
    await expect(phone).toHaveAccessibleDescription(/start with 3, 6, 8 or 9/);
    await phone.fill("+65 9123 4567");
    await phone.press("Tab");
    await expect(phone).not.toHaveAttribute("aria-invalid", "true");
  }

  await profile.getByTitle("Violet").click();
  const business = page.locator("#settings-business");
  const businessName = business.getByRole("textbox", { name: "Business name" });
  await businessName.fill("Little Cup Co");
  await businessName.press("Enter");
  await expect(business.getByRole("status")).toHaveText("Saved on this device.");

  await page.reload();
  await expect(page.getByTestId("demo-menu")).toBeVisible();
  await expect(name).toHaveValue(`${FOUNDER_NAME} Lin`);
  await expect(email).toHaveValue("mei@example.com");
  await expect(profile.getByRole("radio", { name: "Violet" })).toBeChecked();
  await expect(businessName).toHaveValue("Little Cup Co");
  if (COUNTRY.home === "Singapore") await expect(phone).toHaveValue("+65 9123 4567");
  // The quick settings' button follows the profile.
  await expect(page.getByTestId("demo-menu")).toHaveAccessibleName(`Quick settings: ${FOUNDER_NAME}`);

  // And back to the demo details.
  await business.getByRole("button", { name: "Go back to the demo details" }).click();
  await expect(name).toHaveValue(FULL_NAME);
  await expect(businessName).toHaveValue("");
  await expect(business.getByRole("button", { name: "Go back to the demo details" })).toHaveCount(0);
});

test("quick settings open from the top-right button and hold every toggle", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/chat");
  await expect(page.getByTestId("demo-menu")).toHaveAccessibleName(`Quick settings: ${FOUNDER_NAME}`);
  const panel = await openDemoMenu(page);
  await expect(panel.getByTestId("mode-badge")).toHaveText("Sample data");
  await expect(panel.getByRole("radiogroup", { name: "Persona" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "For reviewers: Proof" })).toHaveAttribute("href", "/evidence");
  const recording = panel.getByRole("switch", { name: "Recording mode" });
  await expect(recording).toHaveAttribute("aria-checked", "false");

  // Recording mode from the switch: on at once (the note, no hover detail on the data label), then off again.
  await recording.click();
  await expect(recording).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByTestId("recording-note")).toBeVisible();
  await expect(panel.getByTestId("mode-badge")).not.toHaveAttribute("title", /.+/);
  await recording.click();
  await expect(recording).toHaveAttribute("aria-checked", "false");
  await expect(panel.getByTestId("recording-note")).toHaveCount(0);

  // All settings goes to the page and closes the popover.
  await panel.getByRole("link", { name: "All settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(panel).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expectPageHygiene(page, "/settings after quick settings");
  seen.assertClean();
});

test("the recording switch wins over a stale ?recording=1 and lasts for the tab", async ({ page }) => {
  await page.goto("/chat?recording=1");
  const panel = await openDemoMenu(page);
  const recording = panel.getByRole("switch", { name: "Recording mode" });
  await expect(recording).toHaveAttribute("aria-checked", "true");
  await recording.click();
  await expect(recording).toHaveAttribute("aria-checked", "false");
  // The flag left the address bar, so a reload keeps it off.
  await expect(page).not.toHaveURL(/recording=/);
  await page.reload();
  await expect(page.getByTestId("demo-menu")).toBeVisible();
  await expect((await openDemoMenu(page)).getByRole("switch", { name: "Recording mode" })).toHaveAttribute("aria-checked", "false");
});

test("the loan officer sees their own button, and the demo reset behind a confirmation", async ({ page }) => {
  await signInAsOfficer(page);
  await openSettings(page);
  await expect(page.getByTestId("demo-menu")).toHaveAccessibleName("Quick settings: Loan officer");
  await expect(page.getByTestId("demo-menu")).toHaveAttribute("data-persona", "officer");
  const demo = page.locator("#settings-demo");
  await demo.getByRole("button", { name: "Reset the demo" }).click();
  const dialog = page.getByRole("dialog", { name: "Reset the demo?" });
  await expect(dialog).toBeVisible();
  // Never confirmed here: the mock store is shared by every test.
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#settings-security").getByRole("link", { name: "How Hogee keeps your money safe" })).toHaveAttribute("href", "/evidence");
});
