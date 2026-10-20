/**
 * The Demo menu's persona switch with the real officer access code. This is the one smoke test that types the code, so
 * it runs without a trace: a retained trace records typed values, input values and request bodies (P1 review of #5,
 * point 12). Every other test signs the officer in with signInAsOfficer, which keeps the code out of the browser.
 */
import { expect, test } from "@playwright/test";
import { expectPersona, switchPersona, watch } from "../support/app";

test.use({ trace: "off" });

test("the persona switch swaps the nav and keeps shared pages", async ({ page }) => {
  const seen = watch(page);
  const nav = page.getByRole("navigation", { name: "Main" });

  await page.goto("/chat");
  await expect(nav.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Loan officer" })).toHaveCount(0);

  // A founder-only page sends the officer to their own home.
  await switchPersona(page, "officer");
  await expect(page).toHaveURL(/\/officer$/);
  await expect(nav.getByRole("link", { name: "Loan officer" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Chat", exact: true })).toHaveCount(0);

  // The signed persona cookie survives a reload.
  await nav.getByRole("link", { name: "Proof" }).click();
  await expect(page).toHaveURL(/\/evidence$/);
  await page.reload();
  await expectPersona(page, "officer");

  // Proof is shared by both personas (founders reach it from the Demo menu and the footer), so switching back stays on it.
  await switchPersona(page, "founder");
  await expect(nav.getByRole("link", { name: "Chat", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Proof" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/evidence$/);
  seen.assertClean();
});
