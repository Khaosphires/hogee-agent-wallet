/**
 * A passkey the browser remembers must not become a dead end when the mock forgets its keys (a demo reset or a
 * restart clears them, not the browser's storage; P1 reviews of #6). The dialog keeps the stored passkey and offers
 * "Create a new passkey" next to signing again; the new passkey needs a new enrolment code (G2), since the reset also
 * forgot the codes. It resets the shared mock store, so it runs in its own project after both viewport projects
 * (playwright.config.ts "after-reset").
 */
import type { Page } from "@playwright/test";
import { addVirtualAuthenticator } from "../passkey/virtual-authenticator";
import { resetMock } from "../support/app";
import { expect, test } from "../support/enrolment";

/** The one button that opens the plan's sign sheet: "Sign the plan" for a draft, "View what you signed" once signed. */
const sheetButton = (page: Page) => page.getByRole("button", { name: /^(Sign the plan|View what you signed)$/ });

test("after a demo reset, a refused passkey can be replaced with a new one (nothing is deleted)", async ({ page, enrolPasskey }) => {
  await addVirtualAuthenticator(page);
  await page.goto("/plan");
  await sheetButton(page).click();
  const dialog = page.getByRole("dialog");
  await enrolPasskey(dialog);
  await dialog.getByRole("button", { name: "Sign with passkey", exact: true }).click();
  await expect(dialog.getByTestId("sign-done")).toBeVisible();
  await page.keyboard.press("Escape");

  await resetMock();
  await page.reload();
  await sheetButton(page).click();
  await expect(dialog.getByRole("button", { name: "Create your passkey first" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Sign with passkey", exact: true }).click();
  await expect(dialog.getByTestId("sign-error")).toContainText("not the founder's registered key");
  // The remembered passkey stays (live, the officer console still needs it); a new one replaces it only on success.
  await expect(dialog.getByRole("button", { name: "Sign with passkey", exact: true })).toBeVisible();
  await enrolPasskey(dialog, { opener: "Create a new passkey" });
  await expect(dialog.getByRole("button", { name: "Create a new passkey" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Sign with passkey", exact: true }).click();
  await expect(dialog.getByTestId("sign-done")).toBeVisible();
});
