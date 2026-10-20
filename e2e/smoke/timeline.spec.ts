import { expect, test } from "@playwright/test";
import { expectPageHygiene, watch } from "../support/app";

test("every timeline row links to a hash or a decision id", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/timeline");
  const events = page.getByTestId("trace-event");
  await expect(events.first()).toBeVisible();
  for (const row of (await events.all()).slice(0, 40)) {
    // Each event carries at least its own hash-chain link (monospace hex), and tx/decision refs when it has them.
    await expect(row.locator("[title^='0x'], [data-testid=tx-hash]").first()).toBeVisible();
  }
  await expectPageHygiene(page, "/timeline");
  seen.assertClean();
});

test("a red-team attack from Proof's first page shows the refusal and the forced revert in plain English", async ({ page }) => {
  await page.goto("/evidence");
  // "Try an attack" leads Proof → Checks (friction log #34), and is gone while recording.
  await expect(page.getByTestId("proof-tabs").getByRole("link", { name: "Checks" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("combobox", { name: "Attack" }).click();
  await page.getByRole("option", { name: /Bank details changed/ }).click();
  await page.getByRole("button", { name: "Run attack" }).click();
  const result = page.getByTestId("attack-result");
  await expect(result).toContainText("Wall 1, the AI said no");
  await expect(result).toContainText("Not approved to be paid");
  // The figure counts what the activity record holds.
  await expect(page.getByTestId("attacks-stopped")).toContainText("Stopped so far");
  await page.getByTestId("proof-tabs").getByRole("link", { name: "Activity record" }).click();
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Refusals" }).click();
  await expect(page.getByTestId("trace-group").first()).toContainText(/Refused|refus/i);
});

test("recording mode hides the attack panel, never the record", async ({ page }) => {
  await page.goto("/evidence?recording=1");
  await expect(page.getByTestId("verify-panel")).toBeVisible();
  await expect(page.getByTestId("red-team")).toHaveCount(0);
  await page.goto("/timeline?recording=1");
  await expect(page.getByTestId("trace-event").first()).toBeVisible();
});
