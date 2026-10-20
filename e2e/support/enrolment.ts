/**
 * Founder passkey enrolment for the e2e tests (G2; docs/G2-notes-for-P2.md §1–2). The loan officer generates a one-time
 * code in the officer console, and the founder types it into the welcome step's passkey card (UX-PLAN D1) or, as the
 * fallback, into the sign dialog before creating the passkey.
 *
 * - The officer works in a separate browser context, as on their own device, signed in with signInAsOfficer's
 *   Node-minted cookie: the founder's page, persona cookie and open dialog stay as they are, and the officer access
 *   code never enters a browser.
 * - The mock keeps one founder key slot, as live does: a second registration while a key waits for review is
 *   FounderKeyAlreadySet, and a new code revokes the last one. All tests share one mock and the viewport projects run
 *   in parallel workers, so an enrolling test holds a cross-process lock from generating its code until the test ends,
 *   and first rejects any key an earlier test (or the mock's seed) left pending.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { signInAsOfficer } from "./app";

export { expect };

const LOCK_POLL_MS = 250;
const LOCK_WAIT_MS = 90_000;
const CODE_SHAPE = /^[A-Za-z0-9_-]{24}$/;

const baseUrl = (): string => test.info().project.use.baseURL ?? "http://localhost:3000";

/** One lock per server port, so agents running their own servers on other ports never wait on each other. */
const lockPath = (): string => join(tmpdir(), `hogee-e2e-founder-enrolment-${new URL(baseUrl()).port || "80"}.lock`);

/** A lock whose holder process has exited (a killed worker never releases it). */
function holderGone(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false; // being written right now
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function acquireLock(): Promise<() => void> {
  const path = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (holderGone(path)) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`waited ${LOCK_WAIT_MS / 1000} s for the founder-enrolment lock ${path}`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/** Clicks a target; the demo passes its on-camera `act` instead. */
export type Click = (target: Locator) => Promise<void>;

/** In the officer console (`page` on /officer as the loan officer): rejects a founder key still waiting for review. */
async function rejectPendingKey(page: Page): Promise<void> {
  const enrolment = page.getByTestId("founder-enrolment");
  const pending = enrolment.getByTestId("pending-founder-key");
  const none = enrolment.getByTestId("no-pending-key");
  await expect(pending.or(none)).toBeVisible();
  if (await pending.isVisible()) {
    await pending.getByRole("button", { name: "Reject", exact: true }).click();
    await pending.getByRole("group", { name: "Confirm the rejection" }).getByRole("button", { name: "Reject passkey" }).click();
    await expect(none).toBeVisible();
  }
}

/**
 * In the officer console (`page` on /officer as the loan officer, no key waiting for review): generates a code with
 * `click` and reads it from the console (it is shown once). Returns the code.
 */
export async function generateCodeInConsole(page: Page, click: Click = (target) => target.click()): Promise<string> {
  const enrolment = page.getByTestId("founder-enrolment");
  await expect(enrolment.getByTestId("no-pending-key")).toBeVisible();
  await click(enrolment.getByRole("button", { name: "Generate enrolment code" }));
  const shown = enrolment.getByTestId("one-time-code");
  await expect(shown.getByTestId("enrolment-code")).toHaveText(CODE_SHAPE);
  await expect(shown.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(shown).toContainText(/Expires .* left/);
  return (await shown.getByTestId("enrolment-code").textContent()) ?? "";
}

/** Runs `body` as the loan officer on /officer in their own browser context, as on their own device. */
async function asOfficerElsewhere<T>(founderPage: Page, body: (page: Page) => Promise<T>): Promise<T> {
  const browser = founderPage.context().browser();
  if (!browser) throw new Error("no browser to open the loan officer's context in");
  const officerContext = await browser.newContext({ baseURL: baseUrl() });
  try {
    const page = await officerContext.newPage();
    await signInAsOfficer(page);
    await page.goto("/officer");
    return await body(page);
  } finally {
    await officerContext.close();
  }
}

/**
 * As the loan officer, in their own browser context: reject a key still waiting for review, generate a code and read
 * it from the console (it is shown once). Returns the code.
 */
export async function generateEnrolmentCode(founderPage: Page): Promise<string> {
  return asOfficerElsewhere(founderPage, async (page) => {
    await rejectPendingKey(page);
    return generateCodeInConsole(page);
  });
}

/** As the loan officer, in their own browser context: reject a key still waiting for review (the mock's seed has one). */
export async function rejectPendingFounderKey(founderPage: Page): Promise<void> {
  await asOfficerElsewhere(founderPage, rejectPendingKey);
}

/** The label of the set-up code field, in the passkey card and in the sign dialog. */
export const SET_UP_CODE_LABEL = "Set-up code from your loan officer";

/** The founder opens the dialog's enrolment form with `opener`, types the code and creates the passkey with `click`. */
export async function typeEnrolmentCode(dialog: Locator, code: string, opener: string, click: Click = (target) => target.click()): Promise<void> {
  await dialog.getByRole("button", { name: opener }).click();
  const form = dialog.getByTestId("enrolment-form");
  await form.getByLabel(SET_UP_CODE_LABEL).fill(code);
  await click(form.getByRole("button", { name: "Create passkey", exact: true }));
  await expect(dialog.getByTestId("passkey-created")).toBeVisible();
}

/**
 * The founder types the code into the welcome step's passkey card (`passkey-setup`) and creates the passkey with
 * `click`; the card then shows the passkey ID's last four characters, which the loan officer's console matches.
 */
export async function typeEnrolmentCodeInCard(page: Page, code: string, click: Click = (target) => target.click()): Promise<void> {
  const setup = page.getByTestId("passkey-setup");
  await expect(setup).toHaveAttribute("data-state", "form");
  await setup.getByLabel(SET_UP_CODE_LABEL).fill(code);
  await click(setup.getByRole("button", { name: "Create passkey", exact: true }));
  await expect(setup).toHaveAttribute("data-state", "done");
  await expect(setup.getByTestId("passkey-id-suffix")).toHaveText(/^…[A-Za-z0-9_-]{4}$/);
}

/**
 * Opens the sign dialog's "Show details" (UX-PLAN D16): every signed row ("What you sign"), the code the passkey signs
 * and Hogee's notes are folded there. The check line (`digest-check`) stays above the button, outside it.
 */
export async function showSignDetails(dialog: Locator): Promise<void> {
  const details = dialog.getByTestId("sign-details");
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.getByText("Show details", { exact: true }).click();
  await expect(dialog.getByRole("list", { name: "What you sign" })).toBeVisible();
}

export interface EnrolOptions {
  /** The dialog button that opens the enrolment form (default "Create your passkey first"). */
  readonly opener?: "Create your passkey first" | "Create a new passkey";
}

/**
 * `enrolPasskey(dialog)`: the loan officer generates a code and the founder creates a passkey with it in the open sign
 * dialog. `enrolPasskeyInCard()`: the same, in the welcome step's passkey card on the current page. Either fixture holds
 * the enrolment lock from its first call until the test ends.
 */
export const test = base.extend<{
  enrolPasskey: (dialog: Locator, options?: EnrolOptions) => Promise<void>;
  enrolPasskeyInCard: () => Promise<void>;
}>({
  enrolPasskey: async ({ page }, use) => {
    let release: (() => void) | undefined;
    try {
      await use(async (dialog, options = {}) => {
        release ??= await acquireLock();
        const code = await generateEnrolmentCode(page);
        await typeEnrolmentCode(dialog, code, options.opener ?? "Create your passkey first");
      });
    } finally {
      release?.();
    }
  },
  enrolPasskeyInCard: async ({ page }, use) => {
    let release: (() => void) | undefined;
    try {
      await use(async () => {
        release ??= await acquireLock();
        const code = await generateEnrolmentCode(page);
        await typeEnrolmentCodeInCard(page, code);
      });
    } finally {
      release?.();
    }
  },
});
