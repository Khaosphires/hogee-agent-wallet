import { expect, test, type Page } from "@playwright/test";
import { expectPageHygiene, expectPersona, signInAsOfficer, watch } from "../support/app";

test.beforeEach(async ({ page }) => {
  await signInAsOfficer(page);
  await page.goto("/officer");
  await expectPersona(page, "officer");
});

const STATES = /^(done|yours|waiting|saving|later|skipped)$/;
const LABELS = /^(Done|Your turn|Waiting for (Mei|Rina)|Saving|Not yet|Skipped)$/;

/** The folded "Demo tools" section, opened. */
async function openDemoTools(page: Page) {
  const tools = page.getByTestId("demo-tools");
  if ((await tools.getAttribute("open")) === null) await tools.locator("summary").click();
  await expect(tools.getByTestId("demo-controls")).toBeVisible();
  return tools;
}

/** The set-up checklist, opened when it is folded (all done, or skipped in the Sample business). */
async function openChecklist(page: Page) {
  const checklist = page.getByTestId("officer-checklist");
  await expect(checklist).toBeVisible();
  if ((await checklist.getAttribute("data-complete")) === "true" && (await checklist.getAttribute("open")) === null) await checklist.locator("summary").click();
  return checklist;
}

/** The requests that need the officer now, from the API (the console shows the section only when there are some). */
async function needsDecisionCount(page: Page): Promise<number> {
  const res = await page.request.get("/api/exceptions");
  expect(res.ok()).toBe(true);
  const rows = (await res.json()) as { status: string }[];
  return rows.filter((e) => ["OPEN", "FOUNDER_SIGNED", "APPROVED"].includes(e.status)).length;
}

test("the console leads with four figures, then the work, what happened, and folded demo tools", async ({ page }) => {
  const seen = watch(page);
  const console_ = page.getByTestId("officer-console");
  await expect(console_).toHaveAttribute("data-queue-loaded", "true");
  const stats = page.getByTestId("officer-stats");
  await expect(stats).toBeVisible();
  for (const label of ["Loan", "Released", "Held for suppliers", "AI could pay now"]) await expect(stats).toContainText(label);

  const checklist = page.getByTestId("officer-checklist");
  await expect(checklist).toBeVisible();
  const steps = checklist.getByTestId("checklist-step");
  await expect(steps).toHaveCount(4);
  expect(await steps.evaluateAll((els) => els.map((e) => e.getAttribute("data-step")))).toEqual(["open", "code", "passkey", "fund"]);
  for (const step of await steps.all()) {
    await expect(step).toHaveAttribute("data-state", STATES);
    await expect(step.getByTestId("checklist-state")).toHaveText(LABELS);
  }
  // At most one step is the officer's turn at a time; the mock always serves an open loan; nothing is "skipped" here.
  expect(await checklist.locator("[data-testid=checklist-step][data-state=yours]").count()).toBeLessThanOrEqual(1);
  await expect(steps.first()).toHaveAttribute("data-state", "done");
  await expect(checklist.locator("[data-state=skipped]")).toHaveCount(0);

  // Decisions show only when there are some; the releases follow; the set-up leads while it is not complete.
  const waiting = await needsDecisionCount(page);
  await expect(page.getByTestId("queue-needs-decision")).toHaveCount(waiting > 0 ? 1 : 0);
  await expect(page.getByTestId("stage-gate")).toContainText("Budget releases");
  const order = await page.locator("[data-testid=officer-checklist], [data-testid=queue-needs-decision], [data-testid=stage-gate], [data-testid=demo-tools]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  const expected = ["queue-needs-decision", "stage-gate"].filter((id) => id !== "queue-needs-decision" || waiting > 0);
  const complete = (await checklist.getAttribute("data-complete")) === "true";
  expect(order).toEqual(complete ? [...expected, "officer-checklist", "demo-tools"] : ["officer-checklist", ...expected, "demo-tools"]);

  // Demo tools are folded until opened.
  await expect(page.getByTestId("demo-controls")).toBeHidden();
  await openDemoTools(page);
  await expectPageHygiene(page, "/officer");
  seen.assertClean();
});

test("requests read in plain words: no status codes, no facility tag, a clock that folds hours", async ({ page }) => {
  await expect(page.getByTestId("officer-console")).toHaveAttribute("data-queue-loaded", "true");
  const history = page.getByTestId("officer-history");
  if ((await history.count()) > 0) await history.locator("summary").click();
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/\b(OPEN|FOUNDER_SIGNED|APPROVED|QUEUED|EXECUTABLE|EXECUTED|DENIED|CANCELLED|EXPIRED)\b/);
  expect(text).not.toMatch(/\(facility: [A-Z]{3}\)/);
  // A countdown never shows more than 59 minutes on its minute hand ("1565:38"); hours and days fold in.
  expect(text).not.toMatch(/\b\d{3,}:\d{2}\b/);
});

test("every request shows what it changes, read from its payload, never the title the seed wrote", async ({ page }) => {
  await expect(page.getByTestId("officer-console")).toHaveAttribute("data-queue-loaded", "true");
  const res = await page.request.get("/api/exceptions");
  expect(res.ok()).toBe(true);
  type Row = { exceptionId: string; kind: string; status: string; title: string; payload: Record<string, unknown> };
  const rows = (await res.json()) as Row[];
  // Closed requests are folded into History; open it so every row is on the page.
  const history = page.getByTestId("officer-history");
  if ((await history.count()) > 0 && (await history.getAttribute("open")) === null) await history.locator("summary").click();
  await expect(page.getByTestId("exception-detail")).toHaveCount(rows.length);

  // The supplier's balance (needs a decision): the order, which payment and the delivery check's code, not the title.
  const balance = rows.find((e) => e.kind === "RELEASE_ESCROW_BALANCE");
  expect(balance, "the default seed has a balance request").toBeDefined();
  const balanceRow = page.getByTestId(`exception-${balance?.exceptionId}`);
  const detail = balanceRow.getByTestId("exception-detail");
  await expect(detail).toContainText(`Order${String(balance?.payload.orderId)}`);
  await expect(detail).toContainText(`Which paymentPayment ${Number(balance?.payload.idx) + 1}`);
  await expect(detail).toContainText("Delivery check code");
  await expect(detail.locator(`[title="${String(balance?.payload.evidenceHash)}"]`)).toHaveCount(1);
  await expect(balanceRow).not.toContainText(balance?.title ?? "");

  // A change in its safety wait shows what the officer would let happen by not vetoing it (the seed's are whole-wallet restarts).
  for (const e of rows.filter((r) => r.kind === "UNPAUSE")) {
    const row = page.getByTestId(`exception-${e.exceptionId}`);
    const target = typeof e.payload.lineKey === "string" ? "Payments from the" : "Every payment, from every pocket";
    await expect(row.getByTestId("exception-detail")).toContainText(`Restarts${target}`);
    await expect(row).not.toContainText(e.title);
  }
});

test("steps 2 and 3 keep the enrolment helpers' test ids and labels", async ({ page }) => {
  await openChecklist(page);
  const enrolment = page.getByTestId("founder-enrolment");
  const code = enrolment.locator("[data-testid=checklist-step][data-step=code]");
  const passkey = enrolment.locator("[data-testid=checklist-step][data-step=passkey]");
  await expect(passkey.getByTestId("pending-founder-key").or(passkey.getByTestId("no-pending-key"))).toBeVisible();
  if (await passkey.getByTestId("no-pending-key").isVisible()) {
    await expect(code.getByRole("button", { name: "Generate enrolment code" })).toBeEnabled();
  } else {
    // A key waiting for review blocks a new code, and the step to check it is the officer's turn.
    await expect(passkey).toHaveAttribute("data-state", "yours");
    await expect(passkey.getByTestId("passkey-id-suffix")).toContainText(/passkey ID ends in\s*…\S{4}$/);
    await expect(passkey.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
  }
});

test("the add-money form keeps its name, and shows only when it is the officer's turn", async ({ page }) => {
  await openChecklist(page);
  await expect(page.locator("[data-testid=checklist-step][data-step=fund]")).toHaveAttribute("data-state", STATES);
  // Read the step's state and the form together, in one pass over the page, and retry until they agree: another test
  // may change the shared mock between two separate reads (the old flake at this line).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = document.querySelector("[data-testid=checklist-step][data-step=fund]")?.getAttribute("data-state");
        const forms = document.querySelectorAll("form[aria-label='Fund the facility']").length;
        return state === "yours" ? forms === 1 : forms === 0;
      }),
    )
    .toBe(true);
});

test("recording mode hides the demo tools, the attack panel and the deployment id, never the data label", async ({ page }) => {
  await page.goto("/officer?recording=1");
  await expect(page.getByTestId("officer-checklist")).toBeVisible();
  await expect(page.getByTestId("demo-tools")).toHaveCount(0);
  // Kept for the tab: a client navigation without the query stays in recording mode.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Proof" }).click();
  await expect(page.getByTestId("proof-tabs")).toBeVisible();
  await expect(page.getByTestId("red-team")).toHaveCount(0);
  await page.getByTestId("proof-tabs").getByRole("link", { name: "Activity record" }).click();
  await expect(page.getByTestId("trace-event").first()).toBeVisible();
  await page.getByTestId("demo-menu").click();
  const badge = page.getByTestId("demo-menu-panel").getByTestId("mode-badge");
  // ux3-shell renames "Practice data" to "Sample data"; either passes until both branches are merged.
  await expect(badge).toHaveText(/^(Practice|Sample) data$/);
  await expect(badge).not.toHaveAttribute("title", /.+/);
  await expect(page.getByTestId("recording-note")).toBeVisible();
  await page.keyboard.press("Escape");
  // ?recording=0 turns it off again.
  await page.goto("/officer?recording=0");
  await expect(page.getByTestId("demo-tools")).toBeVisible();
});

test.describe("decisions (shared mock state: one viewport)", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "1280x720", "mutates the shared mock store");
    // The requests have loaded (the decisions and waiting sections render only when they have rows).
    await expect(page.getByTestId("officer-console")).toHaveAttribute("data-queue-loaded", "true");
  });

  test("approve calls the API and the status updates", async ({ page }) => {
    const queue = page.getByTestId("queue-needs-decision");
    test.skip((await queue.count()) === 0, "nothing needs a decision in this seed");
    const row = queue.locator("li[data-status]").filter({ has: page.getByRole("button", { name: "Approve" }) }).first();
    const id = await row.getAttribute("data-testid");
    const before = await row.getAttribute("data-status");
    const approved = page.waitForResponse((r) => r.url().includes("/approve") && r.request().method() === "POST");
    await row.getByRole("button", { name: "Approve" }).click();
    expect((await approved).ok()).toBe(true);
    await expect(page.getByTestId(id ?? "")).not.toHaveAttribute("data-status", before ?? "");
  });

  test("a change in its wait can be vetoed, and lands in History", async ({ page }) => {
    const waiting = page.getByTestId("queue-timelock");
    test.skip((await waiting.count()) === 0, "no queued change in this seed");
    await expect(waiting).toContainText("You or the founder can cancel them during the wait.");
    await expect(waiting).not.toContainText(/anyone/i);
    const row = waiting.locator("li[data-status]").first();
    const id = await row.getAttribute("data-testid");
    await expect(row.getByTestId("timelock-countdown")).toBeVisible();
    await row.getByRole("button", { name: "Veto" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel during the wait" });
    await dialog.getByLabel("Reason").fill("Not before the inspection");
    await dialog.getByRole("button", { name: "Veto" }).click();
    await expect(page.getByTestId("queue-closed").getByTestId(id ?? "")).toHaveAttribute("data-status", "CANCELLED");
  });

  test("a test sale raises revenue and keeps a share for tax", async ({ page }) => {
    const before = (await (await page.request.get("/api/balances")).json()) as { revenueMinor: string; reserveMinor: string };
    const tools = await openDemoTools(page);
    await tools.getByLabel("Test sale (BU)").fill("500");
    await tools.getByRole("button", { name: "Record a sale" }).click();
    await expect(page.getByTestId("demo-controls")).toContainText("Recorded");
    const after = (await (await page.request.get("/api/balances")).json()) as { revenueMinor: string; reserveMinor: string };
    expect(BigInt(after.revenueMinor) - BigInt(before.revenueMinor)).toBe(50_000n);
    expect(BigInt(after.reserveMinor)).toBeGreaterThan(BigInt(before.reserveMinor));
  });
});
