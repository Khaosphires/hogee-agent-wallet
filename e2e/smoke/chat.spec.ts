import { expect, test } from "@playwright/test";
import { expectPageHygiene, watch } from "../support/app";

test("the canned planner conversation plays end to end", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/chat");
  // The status gallery's plan is signed, so /chat opens on the welcome-back home (UX round 3), without the first-run
  // starter chip: the founder's first message is typed, as she would.
  await expect(page.getByTestId("chat-opener")).toHaveAttribute("data-home", "welcome-back");
  await page.getByLabel("Message to Hogee").fill("I want to sell custom insulated tumblers on Shopee Singapore, budget S$10,000");
  await page.getByRole("button", { name: "Send" }).click();

  // Three clarifying questions, each answered with a chip.
  for (let i = 0; i < 3; i += 1) {
    const question = page.getByTestId("question").nth(i);
    await expect(question).toBeVisible();
    await question.getByRole("button").first().click();
    await expect(question.getByRole("button").first()).toBeDisabled();
  }

  // "What I heard" + the plan link (no needs card in the canned script, so the link shows).
  await expect(page.getByTestId("intent-card")).toBeVisible();
  await expect(page.getByTestId("plan-draft-ready")).toBeVisible();
  const assistant = page.locator("[data-testid=chat-message][data-role=assistant]");
  await expect(assistant.first()).toContainText("AI-drafted");
  expect(await assistant.count()).toBeGreaterThanOrEqual(4);

  // Next turn: the shortlist and a red-flag callout.
  await page.getByLabel("Message to Hogee").fill("Find me suppliers");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("shortlist-ready")).toBeVisible();
  await expect(page.getByTestId("red-flag")).toContainText("Red flag");
  await expectPageHygiene(page, "/chat");

  await page.getByRole("link", { name: "See every rule" }).click();
  await expect(page).toHaveURL(/\/plan$/);
  seen.assertClean();
});
