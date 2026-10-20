/**
 * Flow 10 across both personas (project.md §4, §26.1): the founder asks for a cap raise and signs the LoosenRequest
 * with a passkey; the loan officer approves; the change waits out its waiting time, which only the founder or the
 * loan officer can cancel (UX-PLAN D21).
 */
import { addVirtualAuthenticator } from "../passkey/virtual-authenticator";
import { signInAsOfficer } from "../support/app";
import { expect, test } from "../support/enrolment";

test("a loosening needs the founder's passkey, the officer's approval and the waiting time", async ({ page, enrolPasskey }, testInfo) => {
  test.skip(testInfo.project.name !== "1280x720", "mutates the shared mock store");
  await addVirtualAuthenticator(page);
  await page.goto("/dashboard#change-requests");
  const ask = page.getByRole("form", { name: "Ask for a change" });
  await ask.getByLabel("Pocket").selectOption("ADS");
  await ask.getByLabel(/^(Cap|Limit)$/).selectOption("perTx");
  const amount = `${1000 + Math.floor(Math.random() * 1000)}`;
  await ask.getByLabel(/^New (cap|limit) \(BU\)$/).fill(amount);
  await ask.getByLabel("Why").fill("Peak season ads");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/exceptions") && r.request().method() === "POST");
  await ask.getByRole("button", { name: "Ask" }).click();
  const exceptionId = ((await (await created).json()) as { exceptionId: string }).exceptionId;

  const row = page.getByTestId(`founder-${exceptionId}`);
  await row.getByRole("button", { name: "Review and sign" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("digest-check")).toHaveAttribute("data-ok", "true");
  // UX-PLAN D16 (ux-sign): the signed rows may sit folded under "Show details"; open it when it is there.
  const whatYouSign = dialog.getByRole("list", { name: "What you sign" });
  const details = dialog.locator("[data-testid=sign-details] summary");
  if ((await details.count()) > 0 && !(await whatYouSign.isVisible())) await details.first().click();
  await expect(whatYouSign.locator("[data-effect=loosen]").first()).toContainText("Raise");
  await enrolPasskey(dialog);
  await dialog.getByRole("button", { name: "Sign with passkey", exact: true }).click();
  await expect(dialog.getByTestId("sign-done")).toBeVisible();
  await page.keyboard.press("Escape");

  await signInAsOfficer(page);
  await page.goto("/officer");
  const officerRow = page.getByTestId(`exception-${exceptionId}`);
  await expect(officerRow).toHaveAttribute("data-status", "FOUNDER_SIGNED");
  await officerRow.getByRole("button", { name: "Approve" }).click();
  const waiting = page.getByTestId("queue-timelock");
  await expect(waiting.getByTestId(`exception-${exceptionId}`)).toHaveAttribute("data-status", "QUEUED");
  await expect(waiting).toContainText("You or the founder can cancel them during the wait.");
  await expect(page.getByTestId(`exception-${exceptionId}`).getByTestId("timelock-countdown")).toContainText("Can happen in");
});
