/**
 * Mei's chat-first journey end to end (plan §1; VISION-WAVE1-BRIEFS int-e2e-author), on the mock's fresh scenario
 * (MOCK_SCENARIO=fresh, SG): intake → needs card → the plan signed inline with a passkey → a recorded web search with
 * the injected pages excluded → pick → the drafted enquiry, copied → "I've made a deal" → preset 30/70, 2,500 BU and
 * the payout form → the SupplierApproval signed inline → the order card (cooling, then the deposit paid automatically)
 * → "How are we doing?" → the CFO card → the /dashboard tabs → goods arrived, the delivery check and the balance from
 * the Next step bar → the whole conversation again from history at 320–1920 px. Along the way: the Next step bar's
 * step at each stage, the quick replies ("is my money safe?", "who is the supplier?") and one card per thing.
 *
 * Run it on its own server: `pnpm --filter @hogee/e2e journey` (support/run-fresh.mjs sets MOCK_SCENARIO=fresh and a
 * 5 s cooling). It resets the shared mock store first, so it never shares a server with the smoke projects.
 *
 * Each step names, in [brackets], the agents whose work it asserts; docs/decisions/int-e2e-author.md maps every
 * assertion to its owner. Every wait is on a condition (a test id, an attribute, a response), never on a fixed time.
 */
import { addVirtualAuthenticator } from "../passkey/virtual-authenticator";
import { expectPageHygiene, resetMock, watch } from "../support/app";
import type { Locator, Page } from "@playwright/test";
import { expect, generateEnrolmentCode, test } from "../support/enrolment";
import {
  CFO_DISCLAIMER,
  CFO_OVERVIEW_TILES,
  DEMO_ORDER,
  INJECTED_SUPPLIER_IDS,
  LISTING_DOMAINS,
  answerIntake,
  assistantMessages,
  card,
  expectFreshMock,
  fillTermsForm,
  fundFacility,
  getJson,
  nextStepBar,
  nextStepButton,
  orderableCandidate,
  say,
  scheduleRow,
  signInDialog,
  watchSearch,
  type CfoReport,
  type OrderTerms,
  type SupplierSearch,
} from "../support/journey";

/** The Wallet page's sections in order (apps/web/lib/sections.ts "/dashboard"). */
const WALLET_SECTION_IDS = ["wallet-overview", "wallet-activity", "wallet-spending", "wallet-sales", "wallet-profit", "wallet-forecast", "wallet-tax", "wallet-receipts"] as const;

/** The mock's cooling (DEMO_TIMELOCK_SECONDS, default 120 s) plus room for the order card's next poll. */
const COOLING_WAIT_MS = Number(process.env.DEMO_TIMELOCK_SECONDS ?? 120) * 1000 + 30_000;
/** The mock search is PENDING for 2 s and the card polls every 1.5 s (v-search). */
const SEARCH_WAIT_MS = 20_000;
const WIDTHS = [320, 768, 1280, 1920] as const;
/** How the signed rows print the order total (signed-rows.ts formats BU with a thousands separator). */
const DEMO_ORDER_TOTAL_TEXT = "2,500 BU";

test.describe.configure({ mode: "serial" });

/**
 * The welcome card's passkey (UX-PLAN D1, ux-sign's PasskeySetupCard): the loan officer's one-time code, from a second
 * browser, typed into the card. Inline (ux-sign's fixture `enrolPasskeyInCard` does the same) so this spec typechecks
 * on its own branch; the journey runs alone on its server, so no enrolment lock is needed.
 */
async function passkeyFromWelcomeCard(page: Page): Promise<void> {
  const code = await generateEnrolmentCode(page);
  const setup = page.getByTestId("passkey-setup");
  await expect(setup).toHaveAttribute("data-state", "form");
  await setup.getByLabel("Set-up code from your loan officer").fill(code);
  await setup.getByRole("button", { name: "Create passkey", exact: true }).click();
  await expect(setup).toHaveAttribute("data-state", "done");
  await expect(setup.getByTestId("passkey-id-suffix")).toHaveText(/^…[A-Za-z0-9_-]{4}$/);
}

/** Opens the sign sheet's "Show details" (UX-PLAN D16; ux-sign's showSignDetails): the signed rows are folded there. */
async function showSignDetails(dialog: Locator): Promise<void> {
  const details = dialog.getByTestId("sign-details");
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.getByText("Show details", { exact: true }).click();
  await expect(dialog.getByRole("list", { name: "What you sign" })).toBeVisible();
}

test.beforeAll(async () => {
  await resetMock();
});

test("Mei's chat journey: needs, plan, web suppliers, enquiry, terms, order, CFO", async ({ page }) => {
  test.setTimeout(6 * 60_000 + COOLING_WAIT_MS);
  const seen = watch(page);
  const searches = watchSearch(page);
  // The Next step bar (UX-PLAN §3) replaced the 7-step stepper: data-step is the step, data-stage the journey stage.
  const bar = nextStepBar(page);
  await addVirtualAuthenticator(page);

  await test.step("the server is the fresh scenario after the reset [v-contract]", async () => {
    await expectFreshMock(page);
  });

  await test.step("intake: the opener, then three questions [v-chat-ui opener, v-chat-server mock intake]", async () => {
    await page.goto("/chat");
    await expect(page.getByTestId("chat-opener")).toBeVisible();
    // Passkey first (D1), never blocking: the card, the opener with its three promises, and no stepper, no Stop button.
    await expect(page.getByTestId("passkey-setup")).toBeVisible();
    await expect(page.getByRole("list", { name: "What Hogee promises" }).getByRole("listitem")).toHaveCount(3);
    await expect(bar).toHaveAttribute("data-step", "passkey");
    await expect(page.getByTestId("journey-stepper")).toHaveCount(0);
    await expect(page.getByTestId("wallet-pause")).toHaveCount(0);
    // Passkey first (ux-sign): the officer's one-time code, typed into the welcome card, from a second browser.
    await passkeyFromWelcomeCard(page);
    await expect(bar).toHaveAttribute("data-step", "intake");
    await answerIntake(page);
  });

  await test.step("the needs card arrives with the plan to sign [v-chat-server parts, v-chat-ui needs card, core-needs]", async () => {
    const needs = card(page, "needs");
    await expect(needs).toBeVisible();
    await expect(needs).toContainText(" BU");
    await expect(needs.getByTestId("sign-status")).toHaveAttribute("data-state", "idle");
    await expect(page.getByTestId("intent-card")).toContainText("AI-drafted");
    await expect(page.getByTestId("card-sign")).toHaveCount(1);
    // One "What I heard" line, one plan card, and the step: read it and sign it (the passkey is on this device).
    await expect(page.getByTestId("intent-card")).toHaveCount(1);
    await expect(page.getByTestId("card-needs")).toHaveCount(1);
    await expect(bar).toHaveAttribute("data-step", "sign-plan");
    await expect(bar).toHaveAttribute("data-stage", "NEEDS_REVIEW");
    await expectPageHygiene(page, "/chat (needs)");
  });

  await test.step("Mei signs the plan inline with a passkey [v-chat-ui SignHost, mock signing; G2 code]", async () => {
    const needs = card(page, "needs");
    // The passkey made in the welcome card signs straight away (no "Create your passkey first").
    await signInDialog(page, needs.getByTestId("sign-open"));
    await expect(needs.getByTestId("sign-status")).toHaveAttribute("data-state", "confirmed");
    const plan = await getJson<{ status: string; txHash: string }>(page, "/api/plans/current");
    expect(plan.status).toBe("COMMITTED");
    const planMessage = assistantMessages(page).filter({ has: page.getByTestId("card-needs") });
    await expect(planMessage.getByTestId("tx-hash").first()).toHaveAttribute("title", new RegExp(`^${plan.txHash}`));
    // D4: the founder's press shows as what they did, never as a bubble they didn't type.
    await expect(page.getByTestId("action-event").filter({ hasText: "You signed your plan" })).toBeVisible();
    await expect(page.locator("[data-testid=chat-message][data-role=user]").filter({ hasText: /^Signed$/ })).toHaveCount(0);
    // Before the loan officer adds money: who we wait for.
    await expect(bar).toHaveAttribute("data-step", "funding");
    await expect(bar).toHaveAttribute("data-stage", "PLAN_ACTIVE");
  });

  await test.step("the loan officer funds the facility, off screen [existing route; live parity, runbook §8 step 5]", async () => {
    await fundFacility();
    const balances = await getJson<{ fundedMinor: string }>(page, "/api/balances");
    expect(BigInt(balances.fundedMinor)).toBeGreaterThan(0n);
    await expect(bar).toHaveAttribute("data-step", "find");
    await expect(bar).toContainText("is ready to spend");
  });

  await test.step("is my money safe? a template, no model text, no new sign card [ux-chat quick replies, D5]", async () => {
    await say(page, "is my money safe?");
    await expect(assistantMessages(page).last()).toContainText("Your money is protected in three ways.");
    await expect(page.getByTestId("card-sign")).toHaveCount(1);
  });

  await test.step("Find suppliers from the Next step bar: the recorded web search runs [ux-chat bar, v-chat-server start_search, v-search card + mock]", async () => {
    await expect(nextStepButton(page)).toHaveText("Find suppliers");
    await nextStepButton(page).click();
    const search = card(page, "search");
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute("data-provider", "recorded");
    await expect(search).toContainText("recorded sample");
    await expect(search).toHaveAttribute("data-status", "READY", { timeout: SEARCH_WAIT_MS });
  });

  let ready: SupplierSearch | undefined;
  await test.step("candidates: unverified web suppliers, the injected pages excluded [v-search candidates card + pipeline]", async () => {
    const candidates = card(page, "candidates");
    await expect(candidates).toBeVisible();
    // The watcher reads the polled body asynchronously: wait for it rather than assume it is in already.
    await expect.poll(() => searches.ready()?.status, { message: "a READY GET /api/suppliers/search/:id answer" }).toBe("READY");
    ready = searches.ready();
    if (!ready) throw new Error("no READY search answer");
    expect(ready.provider).toBe("recorded");
    expect(ready.candidates.length).toBeGreaterThan(0);
    const rows = candidates.getByTestId("candidate");
    await expect(rows).toHaveCount(ready.candidates.length);
    for (const c of ready.candidates) {
      const row = candidates.locator(`[data-testid=candidate][data-supplier-id="${c.supplierId}"]`);
      await expect(row).toHaveAttribute("data-origin", "web");
      await expect(row).toContainText("Unverified web supplier");
      expect(c.unverified, `${c.supplierId} is a web candidate, so it is unverified`).toBe(true);
    }
    // The pages with instructions aimed at the AI never become candidates, and the card says why they are missing.
    for (const id of INJECTED_SUPPLIER_IDS) {
      expect(ready.candidates.map((c) => c.supplierId)).not.toContain(id);
      await expect(candidates.locator(`[data-supplier-id="${id}"]`)).toHaveCount(0);
    }
    const injection = ready.excludedByGate.find((g) => g.gate === "AI_INJECTION");
    expect(injection?.count, "both injected recorded pages are excluded by the AI_INJECTION gate").toBe(INJECTED_SUPPLIER_IDS.length);
    await expect(candidates.getByTestId("excluded-summary")).toContainText("instructions aimed at the AI");
    // Listing links: server-checked hosts only, opened without a referrer or an opener.
    for (const link of await candidates.locator("a[href^='http']").all()) {
      const rel = (await link.getAttribute("rel")) ?? "";
      for (const word of ["noopener", "noreferrer", "nofollow"]) expect(rel.split(/\s+/), `rel of ${await link.getAttribute("href")}`).toContain(word);
      await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
      const host = new URL((await link.getAttribute("href")) ?? "").hostname;
      expect(LISTING_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)), `listing host ${host}`).toBe(true);
    }
    await expect(bar).toHaveAttribute("data-stage", "CANDIDATES");
    await expectPageHygiene(page, "/chat (candidates)");
  });
  if (!ready) throw new Error("no READY search");
  const search = ready;
  const chosen = orderableCandidate(search);

  await test.step("Mei picks a supplier and copies the drafted enquiry [v-search pick, buildEnquiry; v-chat-ui enquiry card]", async () => {
    const candidates = card(page, "candidates");
    const row = candidates.locator(`[data-testid=candidate][data-supplier-id="${chosen.supplierId}"]`);
    // ux-order D27: three rows first, the rest behind "Show N more" (hidden rows stay in the DOM).
    if (!(await row.isVisible())) await candidates.getByTestId("candidates-more").click();
    await row.getByRole("checkbox").check();
    await candidates.getByTestId("pick-submit").click();
    const enquiry = card(page, "enquiry");
    await expect(enquiry).toBeVisible();
    await expect(enquiry).toContainText("Hogee never sends messages for you.");
    await expect(enquiry.getByTestId("enquiry-subject")).not.toBeEmpty();
    const body = await enquiry.getByTestId("enquiry-body").innerText();
    // Built from enums and the quantity only: no seller names, no founder details.
    for (const c of search.candidates) expect(body).not.toContain(c.displayName);
    expect(body).not.toContain("Mei");
    await enquiry.getByTestId("copy-enquiry").click();
    const firstLine = body.trim().split("\n")[0] ?? "";
    expect(firstLine.length).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(firstLine);
    await expect(bar).toHaveAttribute("data-step", "message");
    await expect(bar).toHaveAttribute("data-stage", "PICKED");
  });

  await test.step("who is the supplier? the template and the list card again; the older list is one 'Updated below' line [ux-chat D5, D7]", async () => {
    await say(page, "who is the supplier?");
    const last = assistantMessages(page).last();
    await expect(last).toContainText("Copy your message and send it to them yourself.");
    await expect(last.getByTestId("card-candidates")).toBeVisible();
    await expect(page.getByTestId("card-candidates")).toHaveCount(1);
    await expect(page.getByTestId("card-moved").first()).toBeVisible();
  });

  let terms: OrderTerms | undefined;
  await test.step("I've made a deal: preset 30/70, 2,500 BU, the payout form [v-chat-server start_terms, v-terms card + confirmTerms, core-terms]", async () => {
    // The enquiry's own buttons are quiet after a later message; the bar's "I've made a deal" sends the same start_terms.
    await expect(nextStepButton(page)).toHaveText("I've made a deal");
    await nextStepButton(page).click();
    const form = card(page, "terms");
    await expect(form).toBeVisible();
    // The preset card is itself the radio (RadioGroupCard), named "30/70: …".
    const preset = form.locator(`[data-preset="${DEMO_ORDER.preset}"]`);
    await expect(preset).toHaveAttribute("data-available", "true");
    await expect(preset).toHaveAccessibleName(/^30\/70/);
    await preset.click();
    await expect(preset).toBeChecked();
    await fillTermsForm(form, search, chosen.displayName);
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/orders/terms" && r.request().method() === "POST");
    // ux-order D2: "Save and sign" saves, and only after the 200 opens the SupplierApproval sheet itself.
    await signInDialog(page, form.getByTestId("terms-submit"), {
      beforeSign: async (dialog) => {
        // The signed rows are decoded from the typed data, folded under "Show details"; the server's description (not
        // signed) says where the supplier came from.
        await showSignDetails(dialog);
        await expect(dialog.getByRole("list", { name: "What you sign" })).toContainText(DEMO_ORDER_TOTAL_TEXT);
        await expect(dialog.getByTestId("server-description")).toContainText("Found by web search, not verified");
      },
    });
    const res = await saved;
    expect(res.status(), "submitOrderTerms").toBe(200);
    terms = (await res.json()) as OrderTerms;
    expect(terms).toMatchObject({ status: "CONFIRMED", supplierId: chosen.supplierId, totalMinor: DEMO_ORDER.totalMinor, orderId: null });
    expect(terms.schedule.map((r) => [r.trigger, r.amountMinor, r.autoRelease])).toEqual([
      ["ON_ORDER", DEMO_ORDER.depositMinor, true],
      ["ON_DELIVERY_INSPECTED", DEMO_ORDER.balanceMinor, false],
    ]);
    await expect(form.getByTestId("terms-error")).toHaveCount(0);
    const rows = form.getByTestId("schedule-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-trigger", "ON_ORDER");
    await expect(rows.nth(0)).toHaveAttribute("data-auto", "true");
    await expect(rows.nth(0).locator("[data-minor]").first()).toHaveAttribute("data-minor", DEMO_ORDER.depositMinor);
    await expect(rows.nth(1)).toHaveAttribute("data-auto", "false");
    await expect(rows.nth(1).locator("[data-minor]").first()).toHaveAttribute("data-minor", DEMO_ORDER.balanceMinor);
  });
  if (!terms) throw new Error("no confirmed terms");
  const termsId = terms.termsId;

  await test.step("the SupplierApproval signed from Save and sign: the fallback sign card shows it confirmed [v-chat-server terms_saved, ux-order D2]", async () => {
    // The plan's sign card stays above; the supplier order's (sent with terms_saved) is the second one.
    await expect(page.getByTestId("card-sign")).toHaveCount(2);
    await expect(card(page, "sign").getByTestId("sign-status")).toHaveAttribute("data-state", "confirmed");
  });

  await test.step("the order card: cooling, then the agent pays the deposit by itself [v-chat-server data-order, v-terms order card + mock cooling]", async () => {
    const order = card(page, "order");
    await expect(order).toBeVisible();
    await expect(order).toHaveAttribute("data-order-id", /^order-w[a-z2-7]{12}-001$/);
    const bound = await getJson<OrderTerms>(page, `/api/orders/terms/${termsId}`);
    expect(bound.status).toBe("USED");
    expect(bound.coolingEndsAt, "a web order starts with the payee's cooling period").not.toBeNull();
    await expect(order).toHaveAttribute("data-order-id", bound.orderId ?? "");
    const deposit = order.locator('[data-testid=schedule-row][data-trigger="ON_ORDER"]');
    const paidDeposit = order.locator(scheduleRow("ON_ORDER", true));
    // While cooling runs the countdown shows; the deposit is paid only once it ends.
    await expect(order.getByTestId("cooling-countdown").or(paidDeposit).first()).toBeVisible();
    await expect(paidDeposit).toBeVisible({ timeout: COOLING_WAIT_MS });
    await expect(order.getByTestId("cooling-countdown")).toHaveCount(0);
    await expect(deposit).toContainText("Paid automatically");
    await expect(deposit.getByTestId("tx-hash")).toBeVisible();
    await expect(deposit.locator("[data-minor]").first()).toHaveAttribute("data-minor", DEMO_ORDER.depositMinor);
    const balance = order.locator('[data-testid=schedule-row][data-trigger="ON_DELIVERY_INSPECTED"]');
    await expect(order.locator(scheduleRow("ON_DELIVERY_INSPECTED", false))).toBeVisible();
    await expect(balance).toContainText("Waiting for you");
    await expect(balance.locator("[data-minor]").first()).toHaveAttribute("data-minor", DEMO_ORDER.balanceMinor);
    await expect(bar).toHaveAttribute("data-step", "in-transit");
    await expect(bar).toHaveAttribute("data-stage", "OPERATING");
    await expectPageHygiene(page, "/chat (order)");
  });

  await test.step("How are we doing? The CFO card [v-chat-server mock classifier, v-cfo card + report, core-cfo]", async () => {
    await say(page, "How are we doing?");
    const cfo = card(page, "cfo");
    await expect(cfo).toHaveAttribute("data-view", "overview");
    const report = await getJson<CfoReport>(page, "/api/cfo");
    for (const [tile, field] of Object.entries(CFO_OVERVIEW_TILES)) {
      await expect(cfo.getByTestId(`cfo-tile-${tile}`).locator("[data-minor]").first()).toHaveAttribute("data-minor", report.overview[field]);
    }
    // The deposit the agent paid is the only supplier cost so far (cash basis).
    expect(report.pnl.supplierCostMinor).toBe(DEMO_ORDER.depositMinor);
    expect(report.disclaimer).toBe(CFO_DISCLAIMER);
    await expect(cfo.getByTestId("cfo-disclaimer")).toHaveText(CFO_DISCLAIMER);
    // The mock's sales are a labelled sample, never shown as real.
    await expect(cfo.getByTestId("cfo-data-label")).toContainText("Sample data");
    await expectPageHygiene(page, "/chat (CFO)");
  });

  await test.step("the Wallet page and its sections [v-cfo dashboard]", async () => {
    await card(page, "cfo").locator('a[href="/dashboard?tab=overview"]').click();
    await expect(page).toHaveURL(/\/dashboard\?tab=overview$/);
    await expect(page.getByRole("heading", { level: 1, name: "Wallet", exact: true })).toBeVisible();
    await expect(page.getByTestId("cfo-disclaimer")).toHaveText(CFO_DISCLAIMER);
    for (const id of WALLET_SECTION_IDS) {
      const section = page.locator(`#${id}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
    }
    await expectPageHygiene(page, "/dashboard");
    // An old ?tab= link lands on its section.
    await page.goto("/dashboard?tab=pnl");
    await expect(page.locator("#wallet-profit")).toBeInViewport({ ratio: 0.2 });
  });

  await test.step("goods arrived, the delivery check, then the balance from the Next step bar: order complete [ux-chat bar + D35, v-terms order card]", async () => {
    await page.goto("/chat");
    await expect(bar).toHaveAttribute("data-step", "in-transit");
    await expect(nextStepButton(page)).toHaveText("Goods arrived");
    await nextStepButton(page).click();
    await expect(bar).toHaveAttribute("data-step", "upload");
    const order = card(page, "order");
    await order.getByLabel("Inspection report").setInputFiles({ name: "delivery-check.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 delivery check") });
    await order.getByRole("button", { name: "Upload report" }).click();
    await expect(bar).toHaveAttribute("data-step", "pay-balance");
    await expect(bar).toContainText("Sign to pay the balance of 1,750 BU.");
    await signInDialog(page, nextStepButton(page));
    await expect(order.locator(scheduleRow("ON_DELIVERY_INSPECTED", true))).toBeVisible({ timeout: 30_000 });
    await expect(order.getByTestId("order-complete")).toBeVisible();
    await expect(bar).toHaveAttribute("data-step", "done");
    // D35: the reply to the release says the order is complete, never that the balance still waits.
    await expect(assistantMessages(page).last()).toContainText("Order complete");
    await expect(page.getByTestId("action-event").filter({ hasText: "You signed to pay the balance" })).toBeVisible();
    // D7: the order card shows once in full; its older copies are one line each.
    await expect(page.getByTestId("card-order")).toHaveCount(1);
    await expect(page.getByTestId("card-moved").first()).toBeVisible();
    await expectPageHygiene(page, "/chat (order complete)");
  });

  await test.step("the finished conversation reloads from history at every width [v-chat-server persist, every card owner]", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/chat");
      // Each card loaded from REST, not its skeleton: the width check measures the real content.
      await expect(card(page, "needs").getByTestId("sign-status")).toHaveAttribute("data-state", "confirmed");
      await expect(card(page, "candidates").getByTestId("candidate").first()).toBeVisible();
      await expect(card(page, "enquiry").getByTestId("enquiry-body")).not.toBeEmpty();
      await expect(card(page, "terms")).toHaveAttribute("data-supplier-id", chosen.supplierId);
      await expect(page.locator(`[data-testid=card-order][data-order-id^="order-w"]`)).toBeVisible();
      await expect(page.locator(scheduleRow("ON_ORDER", true))).toBeVisible();
      await expect(card(page, "cfo").getByTestId("cfo-tile-cash")).toBeVisible();
      await expectPageHygiene(page, `/chat at ${width} px`);
    }
  });

  seen.assertClean();
});

