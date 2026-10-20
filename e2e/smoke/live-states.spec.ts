/**
 * States the live API produces that the mock doesn't (P1's live notes, 18 Oct), faked at the network layer:
 * a country pack missing facts (409 COMPILE_FAILED, PACK_FACT_MISSING), chat down (502), a shortlist that failed
 * closed, a chat turn the API refuses (4xx), an inspection upload with no milestone waiting (404), and an inspection
 * report over the upload limit (the API's 10 MiB cap less room for the multipart overhead).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { COUNTRY, expectPageHygiene } from "../support/app";

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The founder's first chat message, typed (the gallery's signed plan opens /chat on the welcome-back home, UX round 3). */
async function sendFirstMessage(page: Page): Promise<void> {
  await page.getByLabel("Message to Hogee").fill("I want to sell custom insulated tumblers on Shopee Singapore, budget S$10,000");
  await page.getByRole("button", { name: "Send" }).click();
}

const packGap = (facts: string[]) => ({
  error: {
    code: "COMPILE_FAILED",
    message: "The country pack is missing facts this plan needs, so nothing was compiled or assumed",
    details: { reason: "PACK_FACT_MISSING", missingFacts: facts },
  },
});

test("a country pack missing facts shows them instead of a plan", async ({ page }) => {
  await page.route("**/api/plans/draft", (route) => json(route, 409, packGap(["indirectTax.rate", "customs.deMinimisMinor"])));
  await page.goto("/plan");
  const gap = page.getByTestId("pack-incomplete");
  await expect(gap).toContainText("This country's rules are incomplete");
  await expect(gap.getByRole("list", { name: "Missing facts" }).getByRole("listitem")).toHaveText(["indirectTax.rate", "customs.deMinimisMinor"]);
  await expect(page.getByRole("button", { name: /^(Sign the plan|View what you signed)$/ })).toHaveCount(0);
  await expectPageHygiene(page, "/plan (pack incomplete)");
});

test("the country switch names the country whose pack is incomplete", async ({ page }) => {
  await page.route("**/api/plans/preview-country", (route) => json(route, 409, packGap(["productApprovals.drinkware_food_contact"])));
  await page.goto("/plan");
  await expect(page.getByTestId("blast-radius")).toBeVisible();
  // The country preview is folded for reviewers at the bottom of the plan (UX-PLAN D30).
  await page.getByTestId("country-review").locator("summary").click();
  await page.getByRole("radiogroup", { name: "Country" }).getByRole("radio", { name: COUNTRY.other }).click();
  await expect(page.getByTestId("pack-incomplete")).toContainText(`${COUNTRY.other}'s rules are incomplete`);
  await expect(page.getByTestId("pack-incomplete")).toContainText("productApprovals.drinkware_food_contact");
});

test("chat down (502) says the assistant is unavailable, and Try again recovers", async ({ page }) => {
  let failed = false;
  await page.route("**/api/chat", (route) => {
    if (failed || route.request().method() !== "POST") return route.continue();
    failed = true;
    return json(route, 502, { error: { code: "UPSTREAM", message: "Privacy redaction is unavailable, so nothing was stored or sent. Try again shortly." } });
  });
  await page.goto("/chat");
  await sendFirstMessage(page);
  const down = page.getByTestId("chat-unavailable");
  await expect(down).toContainText("The assistant is unavailable right now");
  await expect(down).toContainText("Privacy redaction is unavailable");
  await down.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-testid=chat-message][data-role=assistant]").first()).toBeVisible({ timeout: 20_000 });
  await expect(down).toHaveCount(0);
});

test("a chat turn the API refuses (4xx) shows the server's message, not 'unavailable'", async ({ page }) => {
  await page.route("**/api/chat", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return json(route, 422, { error: { code: "VALIDATION", message: "The message is longer than 4,000 characters" } });
  });
  await page.goto("/chat");
  await sendFirstMessage(page);
  const refused = page.getByTestId("chat-error");
  await expect(refused).toContainText("Check the input");
  await expect(refused).toContainText("The message is longer than 4,000 characters");
  await expect(refused.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByTestId("chat-unavailable")).toHaveCount(0);
});

test("a shortlist that failed closed shows the server's reason and can be started again", async ({ page }) => {
  const failureReason = "A supplier check could not run, so no supplier was ranked.";
  await page.addInitScript(() => window.localStorage.setItem("hogee.shortlist.requestId", "sl-failed-test"));
  await page.route("**/api/suppliers/shortlist/sl-failed-test", (route) =>
    json(route, 200, { requestId: "sl-failed-test", status: "FAILED", failureReason, candidates: [], excluded: [], rankStabilityPct: null, shortlistHash: null, weightsVersion: "w-test" }),
  );
  await page.goto("/suppliers");
  const failed = page.getByTestId("shortlist-failed");
  await expect(failed).toContainText("The supplier search stopped safely");
  await expect(failed.getByTestId("shortlist-failure-reason")).toHaveText(failureReason);
  await failed.getByRole("button", { name: "Search again" }).click();
  await expect(page.getByLabel("Units to order")).toBeVisible();
  await expectPageHygiene(page, "/suppliers (failed shortlist)");
});

async function openEscrow(page: Page) {
  await page.goto("/suppliers");
  await page.getByLabel("Units to order").fill("400");
  await page.getByRole("button", { name: "Find suppliers" }).click();
  const escrow = page.getByTestId("escrow-card");
  await expect(escrow).toBeVisible({ timeout: 20_000 });
  return escrow;
}

test("an inspection report too big for the upload cap is stopped before upload", async ({ page }) => {
  const escrow = await openEscrow(page);
  const input = escrow.getByLabel("Inspection report");
  // Exactly what the API will take, PDF, JPEG or PNG.
  await expect(input).toHaveAttribute("accept", "application/pdf,image/jpeg,image/png");
  // Exactly 10 MiB: the file alone fits the API's cap, but its multipart body would not.
  await input.setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(10 * 1024 * 1024) });
  await expect(escrow.getByTestId("upload-too-big")).toContainText("This file is too big (over 9.9 MB)");
  await expect(escrow.getByRole("button", { name: "Upload report" })).toBeDisabled();
});

test("an upload with no milestone waiting explains why and shows the server's message", async ({ page }) => {
  const message = "No escrow milestone of that order is waiting for inspection evidence (or its release is already being signed)";
  await page.route("**/api/escrow/*/inspection", (route) => json(route, 404, { error: { code: "NOT_FOUND", message } }));
  const escrow = await openEscrow(page);
  await escrow.getByLabel("Inspection report").setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
  await escrow.getByRole("button", { name: "Upload report" }).click();
  const error = escrow.getByTestId("upload-error");
  await expect(error).toContainText(message);
  await expect(error).toContainText("already made");
  await expect(error).not.toContainText("frozen");
});
