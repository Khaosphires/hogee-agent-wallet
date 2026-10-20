import { addVirtualAuthenticator } from "../passkey/virtual-authenticator";
import { expectPageHygiene, watch } from "../support/app";
import { expect, test } from "../support/enrolment";
import type { Locator } from "@playwright/test";

/** Opens the sign sheet's "Show details" fold when the sheet has one (ux-sign's showSignDetails after the merge). */
async function openSignDetails(dialog: Locator): Promise<void> {
  const details = dialog.getByTestId("sign-details");
  if ((await details.count()) > 0 && !(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.getByText("Show details", { exact: true }).click();
}

test("a new shortlist ranks suppliers and shows blocked ones with their reason", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/suppliers");
  await page.getByLabel("Units to order").fill("400");
  await page.getByRole("button", { name: "Find suppliers" }).click();
  // PENDING → READY (the mock's scorer takes ~2.5 s).
  const first = page.locator("[data-testid^=supplier-]").first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  // UX round 3: a supplier with nothing matched yet says "no claims checked yet", never a failing-sounding "0% … proven".
  await expect(first.getByTestId("evidence-coverage")).toHaveText(/^(\d{1,3}% of claims proven|no claims checked yet)$/);
  await expect(first.getByRole("region", { name: "Must-pass checks" })).toBeVisible();
  await expect(first.getByRole("region", { name: "Delivered cost" }).locator("[data-minor]").first()).toContainText("BU");

  const excluded = page.getByRole("region", { name: "Excluded suppliers" });
  if ((await excluded.count()) > 0) {
    const blocked = excluded.locator("[data-testid^=excluded-]").first();
    await expect(blocked.getByText("Blocked")).toBeVisible();
    await expect(blocked.getByTestId("blocked-reason")).not.toBeEmpty();
    await expect(blocked.getByRole("button")).toHaveCount(0);
  }
  await expect(page.getByTestId("escrow-card")).toBeVisible();
  await expectPageHygiene(page, "/suppliers");
  seen.assertClean();
});

test("picking the top supplier signs the schedule with a passkey", async ({ page, enrolPasskey }) => {
  await addVirtualAuthenticator(page);
  await page.goto("/suppliers");
  await page.getByLabel("Units to order").fill("400");
  await page.getByRole("button", { name: "Find suppliers" }).click();
  await page.getByRole("button", { name: "Pick and sign the schedule" }).click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("digest-check")).toHaveAttribute("data-ok", "true");
  await openSignDetails(dialog);
  // "Payee binding" is "Who can be paid" in ux-sign's plain rows (A5.17).
  await expect(dialog.getByRole("list", { name: "What you sign" })).toContainText(/Payee binding|Who can be paid/);
  await enrolPasskey(dialog);
  await dialog.getByRole("button", { name: "Sign with passkey", exact: true }).click();
  await expect(dialog.getByTestId("sign-done")).toBeVisible();
});
