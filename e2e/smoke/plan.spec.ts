import type { Locator, Page } from "@playwright/test";
import { addVirtualAuthenticator } from "../passkey/virtual-authenticator";
import { COUNTRY, DEMO_COUNTRY, expectPageHygiene, signInAsOfficer, watch } from "../support/app";
import { expect, test } from "../support/enrolment";

/** Opens the sign sheet's "Show details" fold when the sheet has one (ux-sign's showSignDetails after the merge). */
async function openSignDetails(dialog: Locator): Promise<void> {
  const details = dialog.getByTestId("sign-details");
  if ((await details.count()) > 0 && !(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.getByText("Show details", { exact: true }).click();
}

/** The country preview is a reviewer's tool, folded at the bottom of the plan (UX-PLAN D30). */
async function openCountryReview(page: Page): Promise<Locator> {
  const review = page.getByTestId("country-review");
  if (!(await review.evaluate((el) => (el as HTMLDetailsElement).open))) await review.locator("summary").click();
  return review.getByRole("radiogroup", { name: "Country" });
}

/** What each switch country's plan shows: its first rule names the country, and only Singapore has an approval step (SFA). */
const SHOWS = {
  Singapore: { rule: /ACRA|Singapore|SGD/, approvalSteps: 1 },
  Malaysia: { rule: /SSM|Malaysia|MYR/, approvalSteps: 0 },
} as const;

/** The plan page's sections, in order (apps/web/lib/sections.ts "/plan"): the side nav scrolls to these ids. */
const SECTIONS = ["plan-summary", "plan-safety", "plan-releases", "plan-pockets", "plan-rules", "plan-signature"];

/** "Sign the plan" for a draft, "View what you signed" for the signed plan: the one button that opens the sign sheet. */
const sheetButton = (page: Page) => page.getByRole("button", { name: /^(Sign the plan|View what you signed)$/ });

test("the plan reads at a glance: six sections, pockets, the safety limit, short rules, and the fixed safety rules", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1, name: "Your plan" })).toBeVisible();
  await expect(page.locator("section[id^=plan-]")).toHaveCount(SECTIONS.length);
  expect(await page.locator("section[id^=plan-]").evaluateAll((els) => els.map((el) => el.id))).toEqual(SECTIONS);
  await expect(page.getByTestId("plan-total").locator("[data-minor]")).toHaveAttribute("data-minor", /^\d+$/);
  await expect(page.getByRole("list", { name: "Budget split" }).getByRole("listitem").first()).toBeVisible();
  await expect(page.getByText("Drafted by AI, made into rules by code")).toBeVisible();
  await expect(page.getByRole("heading", { name: "The most the AI could pay without you" })).toBeVisible();
  await expect(page.getByText(/Blast radius|fully compromised|Prompt fingerprint|judging window|Rules and where they come from/)).toHaveCount(0);
  // Mei doesn't meet the country switch: it is folded for reviewers.
  await expect(page.getByRole("radiogroup", { name: "Country" })).toBeHidden();
  await expect(page.getByText("A guide, not professional advice", { exact: false })).toBeVisible();
  await expect(page.getByTestId("blast-radius").locator("[data-minor]")).toHaveAttribute("data-minor", /^\d+$/);
  const supplier = page.getByTestId("plan-line-SUPPLIER");
  await expect(supplier).toBeVisible();
  await expect(supplier.getByTestId("pocket-limit")).toContainText("Paid in steps");
  // Each rule is one short row; where it comes from is one press away, never a heading.
  const rules = page.getByTestId("plan-rule");
  await expect(rules.first()).toBeVisible();
  for (const rule of await rules.all()) await expect(rule.getByTestId("rule-source")).toHaveCount(1);
  await expect(rules.first().getByTestId("rule-source")).toBeHidden();
  await rules.first().locator("summary").click();
  await expect(rules.first().getByTestId("rule-source").locator("[data-slot=badge]").first()).toBeVisible();
  // The fixed safety rules: a count at a glance, every check one press away.
  const checks = page.getByTestId("safety-checks");
  await expect(checks).toContainText(/(\d+) of \1 pass/);
  await page.getByTestId("safety-checks-list").locator("summary").click();
  await expect(page.getByRole("list", { name: "Constitution checks" }).getByRole("listitem").first()).toBeVisible();
  await expect(page.getByTestId("release-step").first()).toBeVisible();
  await expect(page.getByTestId("intent-card")).toContainText("AI-drafted");
  await expectPageHygiene(page, "/plan");
  seen.assertClean();
});

test("a signed plan reads as signed: its seal, and a quiet way to see what was signed, never a call to sign again", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByTestId("plan-state")).toHaveAttribute("data-state", "signed");
  await expect(page.getByTestId("plan-state")).toContainText("Signed");
  await expect(page.getByRole("button", { name: "Sign the plan" })).toHaveCount(0);
  const signature = page.locator("section#plan-signature");
  await expect(signature.getByTestId("plan-signed")).toContainText("Stamp");
  const view = signature.getByRole("button", { name: "View what you signed" });
  await expect(view).toBeVisible();
  await view.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("digest-check")).toHaveAttribute("data-ok", "true");
  await expect(dialog).toContainText("The plan you signed");
});

/** No committed plan yet (live and the fresh mock answer 404). */
const nothingSigned = (page: Page) =>
  page.route("**/api/plans/current", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "No plan has been committed yet" } }) }),
  );

/** This chat's thread: with the chat's plan card once Mei has answered, or none (a new chat: 404). */
const thread = (page: Page, drafted: boolean) =>
  page.route("**/api/chat/*", (route) =>
    route.request().method() !== "GET"
      ? route.continue()
      : drafted
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "msg-plan", role: "assistant", parts: [{ type: "data-plan-draft", data: { draftId: "draft-from-chat" } }] }]) })
        : route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "No chat with this session id yet" } }) }),
  );

test("before the chat has drafted a plan, the page shows no figures: an empty state and the way to Chat", async ({ page }) => {
  await nothingSigned(page);
  await thread(page, false);
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1, name: "Your plan" })).toBeVisible();
  await expect(page.getByTestId("plan-empty")).toContainText("No plan yet");
  await expect(page.getByTestId("plan-total")).toHaveCount(0);
  await expect(sheetButton(page)).toHaveCount(0);
  await expect(page.getByTestId("plan-empty-chat")).toHaveAttribute("href", "/chat");
});

test("a draft keeps the one obvious action: Sign the plan, at the top", async ({ page }) => {
  // Nothing signed yet, and the chat has drafted the plan: the page is a draft waiting on Mei.
  await nothingSigned(page);
  await thread(page, true);
  await page.goto("/plan");
  await expect(page.getByTestId("plan-state")).toHaveAttribute("data-state", "draft");
  const sign = page.locator("section#plan-summary").getByRole("button", { name: "Sign the plan" });
  await expect(sign).toBeVisible();
  await expect(sheetButton(page)).toHaveCount(1);
  await expect(page.locator("section#plan-signature")).toContainText("Not signed yet");
  await sign.click();
  await expect(page.getByRole("dialog").getByTestId("digest-check")).toHaveAttribute("data-ok", "true");
});

test("the loan officer gets a pointer to their page, never the API's refusal", async ({ page }) => {
  await signInAsOfficer(page);
  await page.goto("/plan");
  await expect(page.getByTestId("plan-officer")).toBeVisible();
  await expect(page.getByTestId("plan-officer-link")).toHaveAttribute("href", "/officer");
  await expect(page.getByText(/Not allowed for this role|Couldn't load/)).toHaveCount(0);
});

test("while the signature check is slow, the page offers no button to sign", async ({ page }) => {
  await thread(page, true);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/plans/current", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/plan");
  await expect(page.getByTestId("plan-state")).toHaveAttribute("data-state", "checking");
  await expect(sheetButton(page)).toHaveCount(0);
  release();
  await expect(page.getByTestId("plan-state")).toHaveAttribute("data-state", "signed");
  await expect(sheetButton(page)).toHaveText("View what you signed");
});

test("Mei's plan shows the SFA step and Singapore's verified depth", async ({ page }) => {
  test.skip(DEMO_COUNTRY !== "SG", "Mei's Singapore plan only: HOGEE_COUNTRY=MY serves Rina, whose Malaysian plan has no SFA step or PayNow payout");
  await page.goto("/plan");
  const step = page.getByTestId("approval-step");
  await expect(step).toHaveAttribute("data-rule-id", "approval.sfa.fee.0");
  await expect(step.getByTestId("approval-step-label")).toHaveText("SFA registration or approval (free)");
  await expect(step).toContainText("cups and bottles that touch food or drink");
  // The exact place in the country data folds under the rule's Details.
  await step.getByTestId("rule-details").locator("summary").click();
  await expect(step.getByText("/productApprovals/drinkware_food_contact/cost")).toBeVisible();
  await expect(page.getByTestId("verified-depth")).toContainText("Singapore rules used here");
  await expect(page.getByTestId("payout-rail").first()).toHaveText("Sample payout (PayNow)");
});

test(`the ${COUNTRY.home} → ${COUNTRY.other} switch finishes in under 15 s`, async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByTestId("plan-line-SUPPLIER")).toBeVisible();
  const country = await openCountryReview(page);
  await expect(country.getByRole("radio")).toHaveText(["Singapore", "Malaysia"]);
  await expect(country.getByRole("radio", { name: COUNTRY.home })).toHaveAttribute("aria-checked", "true");
  const started = Date.now();
  await country.getByRole("radio", { name: COUNTRY.other }).click();
  await expect(page.getByTestId("country-preview")).toContainText("switched in");
  expect(Date.now() - started).toBeLessThan(15_000);
  await expect(page.getByTestId("plan-rule").first()).toContainText(SHOWS[COUNTRY.other].rule);
  await expect(page.getByTestId("verified-depth")).toContainText(COUNTRY.other);
  await expect(page.getByTestId("approval-step")).toHaveCount(SHOWS[COUNTRY.other].approvalSteps);
  // Preview only; nothing is signed: no sign or view button while another country shows.
  await expect(page.getByTestId("plan-state")).toHaveAttribute("data-state", "preview");
  await expect(sheetButton(page)).toHaveCount(0);
  await country.getByRole("radio", { name: COUNTRY.home }).click();
  await expect(page.getByTestId("country-preview")).toHaveCount(0);
  await expect(page.getByTestId("approval-step")).toHaveCount(SHOWS[COUNTRY.home].approvalSteps);
  if (SHOWS[COUNTRY.home].approvalSteps > 0) await expect(page.getByTestId("approval-step")).toBeVisible();
});

test("signing the plan: passkey, browser-checked digest, transaction", async ({ page, enrolPasskey }) => {
  await addVirtualAuthenticator(page);
  await page.goto("/plan");
  // The default scenario's plan is signed: "View what you signed" opens the same sheet, which can sign it again.
  await sheetButton(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("digest-check")).toHaveAttribute("data-ok", "true");
  await openSignDetails(dialog);
  await expect(dialog.getByTestId("sign-digest")).toHaveText(/^0x[0-9a-f]{64}$/);
  await expect(dialog.getByRole("list", { name: "What you sign" }).locator("[data-effect=loosen]").first()).toBeVisible();
  await enrolPasskey(dialog);
  await dialog.getByRole("button", { name: "Sign with passkey", exact: true }).click();
  await expect(dialog.getByTestId("sign-done")).toBeVisible();
  await expect(dialog.getByTestId("tx-hash")).toBeVisible();
});
