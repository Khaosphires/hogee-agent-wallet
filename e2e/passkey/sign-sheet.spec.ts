/**
 * The plain sign sheet keeps every check (UX-PLAN D16, guardrail G1): the browser recomputes the digest on every open
 * and says so above the button, the summary is written from the signed data, every signed row is one click away under
 * "Show details", and a request whose digest doesn't match its typed data turns the summary red and disables the button.
 * Runs on the default scenario's plan draft (/plan: its plan is signed, so "View what you signed" opens the same sheet;
 * a draft's "Sign the plan" does); nothing is signed, so no passkey is needed.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectPageHygiene } from "../support/app";
import { showSignDetails } from "../support/enrolment";

const DIGEST = /^0x[0-9a-f]{64}$/;

/** A passkey id this browser remembers, so the sheet shows "Sign with passkey" (nothing is signed with it here). */
async function rememberPasskey(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("hogee.passkey.credentialId", "ZmFrZS1jcmVkZW50aWFsLWlk"));
}

/** The one button that opens the plan's sign sheet: "Sign the plan" for a draft, "View what you signed" once signed. */
const sheetButton = (page: Page) => page.getByRole("button", { name: /^(Sign the plan|View what you signed)$/ });

async function openPlanSheet(page: Page) {
  await page.goto("/plan");
  await sheetButton(page).click();
  return page.getByRole("dialog");
}

test("the sheet: a plain summary and the browser's check above the button, every signed row under Show details", async ({ page }) => {
  await rememberPasskey(page);
  const dialog = await openPlanSheet(page);
  const check = dialog.getByTestId("digest-check");
  await expect(check).toHaveAttribute("data-ok", "true");
  await expect(check).toContainText("Checked by this browser");
  await expect(dialog.getByTestId("sign-summary")).toHaveAttribute("data-ok", "true");
  await expect(dialog.getByTestId("sign-summary")).toContainText(/Your plan has a budget of [\d,]+ BU\./);
  const sign = dialog.getByRole("button", { name: "Sign with passkey", exact: true });
  await expect(sign).toBeEnabled();
  // The check line sits above the button, outside the folded details.
  const checkBox = await check.boundingBox();
  const signBox = await sign.boundingBox();
  expect(checkBox && signBox && checkBox.y + checkBox.height <= signBox.y, "the check line is above the sign button").toBe(true);
  // Folded, not removed: the rows and the code the passkey signs are in the details.
  await expect(dialog.getByRole("list", { name: "What you sign" })).toBeHidden();
  await expect(dialog.getByTestId("sign-digest")).toHaveText(DIGEST);
  await showSignDetails(dialog);
  const rows = dialog.getByRole("list", { name: "What you sign" });
  await expect(rows.locator("[data-effect=loosen]").first()).toBeVisible();
  await expect(rows).toContainText("Total budget");
  await expect(rows).toContainText("Whole plan (check code)");
  await expect(dialog.getByTestId("sign-digest")).toBeVisible();
  await expect(dialog.getByTestId("server-description")).toContainText("not part of what you sign");
  await expectPageHygiene(page, "/plan (sign sheet, details open)");
});

test("a digest that doesn't match the typed data: red summary, Don't sign, and a disabled button", async ({ page }) => {
  await rememberPasskey(page);
  // A request the server got wrong (or a hostile one): its digest is not what the typed data hashes to.
  await page.route("**/api/signatures/request", async (route: Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { digest: string; displayModel: { digest: string } };
    const forged = `0x${"ab".repeat(32)}`;
    await route.fulfill({ response: res, json: { ...body, digest: forged, displayModel: { ...body.displayModel, digest: forged } } });
  });
  const dialog = await openPlanSheet(page);
  await expect(dialog.getByTestId("digest-check")).toHaveAttribute("data-ok", "false");
  await expect(dialog.getByTestId("digest-check")).toContainText("Don't sign:");
  const summary = dialog.getByTestId("sign-summary");
  await expect(summary).toHaveAttribute("data-ok", "false");
  await expect(summary).toContainText("Don't sign this");
  await expect(summary).not.toContainText("budget of");
  await expect(dialog.getByRole("button", { name: "Sign with passkey", exact: true })).toBeDisabled();
  // No signed rows are shown for a request that failed the check.
  await showSignDetailsIfRows(page);
});

/** With a failed check the details hold only the code and the reason: no "What you sign" list to open. */
async function showSignDetailsIfRows(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("sign-details").getByText("Show details", { exact: true }).click();
  await expect(dialog.getByRole("list", { name: "What you sign" })).toHaveCount(0);
  await expect(dialog.getByTestId("sign-digest")).toBeVisible();
}

test("the check runs again on every open: a good request after a forged one passes", async ({ page }) => {
  await rememberPasskey(page);
  let forge = true;
  await page.route("**/api/signatures/request", async (route: Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { digest: string; displayModel: { digest: string } };
    if (!forge) return route.fulfill({ response: res });
    const forged = `0x${"cd".repeat(32)}`;
    return route.fulfill({ response: res, json: { ...body, digest: forged, displayModel: { ...body.displayModel, digest: forged } } });
  });
  const dialog = await openPlanSheet(page);
  await expect(dialog.getByTestId("digest-check")).toHaveAttribute("data-ok", "false");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  forge = false;
  await sheetButton(page).click();
  await expect(dialog.getByTestId("digest-check")).toHaveAttribute("data-ok", "true");
  await expect(dialog.getByRole("button", { name: "Sign with passkey", exact: true })).toBeEnabled();
});
