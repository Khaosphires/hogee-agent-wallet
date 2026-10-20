import { expect, test, type Page } from "@playwright/test";
import { sectionsFor } from "../../apps/web/lib/sections";
import { FOUNDER_LABEL, FOUNDER_NAME, expectPageHygiene, expectPersona, openDemoMenu, signInAsOfficer, watch } from "../support/app";

// UX revamp (19 Oct): each page's own owner renames its heading, and the branches merge one by one, so a heading may
// read either way until the last one lands. Proof (/evidence, /timeline) and the officer console are this package's.
const ROUTES = [
  { path: "/chat", heading: /^Chat$/ },
  { path: "/plan", heading: /^(Launch plan|Your plan|Plan)$/ },
  { path: "/suppliers", heading: /^Suppliers$/ },
  { path: "/dashboard", heading: /^(CFO|Your money|Wallet)$/ },
  { path: "/timeline", heading: /^Proof$/ },
  { path: "/evidence", heading: /^Proof$/ },
  { path: "/officer", heading: /^Loan officer$/ },
] as const;

const FOUNDER_PERSONA = FOUNDER_NAME === "Mei" ? "founder:mei" : "founder:rina";
// The side nav lists each page's sections in lib/sections.ts order (the bento pages put them on screen in that order,
// and P1 may reorder a page's list to match its layout), so the expected lists are read from there.
const PLAN_SECTIONS = sectionsFor("/plan").map((s) => s.label);
const WALLET_SECTIONS = sectionsFor("/dashboard").map((s) => s.label);

/**
 * The Plan has drawn its sections (it shows a loading block until it knows whether there is a plan), so a stand-in
 * from ensureSections never lands ahead of a real section.
 */
async function planReady(page: Page): Promise<void> {
  await expect(page.getByTestId("plan-state").first()).toBeVisible();
}

/**
 * Makes sure the page has a `<section id>` for each id (the side nav's targets). The pages draw their own (ux2-wallet,
 * ux2-plan); where a branch doesn't yet, a tall stand-in goes at the end of <main>, after hydration, so the nav's jump
 * is tested on its own. A real section, when there is one, comes first in the page and wins.
 */
async function ensureSections(page: Page, ids: readonly string[]): Promise<void> {
  await page.evaluate((list) => {
    const main = document.querySelector("main");
    if (!main) throw new Error("no <main>");
    for (const id of list) {
      if (document.getElementById(id)) continue;
      const section = document.createElement("section");
      section.id = id;
      section.dataset.testStandIn = "";
      section.style.minHeight = "90vh";
      section.textContent = `Stand-in for ${id}`;
      main.append(section);
    }
    // Room below, so the last stand-in can reach the top of the screen.
    const spacer = document.createElement("div");
    spacer.style.height = "100vh";
    main.append(spacer);
  }, ids);
}

const sidebarNav = (page: Page) => page.getByTestId("sidebar").getByRole("navigation", { name: "Main" });

test("every route renders inside the shell in mock mode", async ({ page }) => {
  const seen = watch(page);
  for (const route of ROUTES) {
    await page.goto(route.path);
    await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByTestId("demo-menu")).toHaveAttribute("data-mode", "mock");
    await expectPageHygiene(page, route.path);
  }
  seen.assertClean();
});

test("the founder's side nav is the brand, Chat · Wallet · Plan and Settings at the foot; quick settings sit top right", async ({ page }) => {
  await page.goto("/chat");
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByRole("link", { name: "Hogee, home" })).toHaveAttribute("href", "/chat");
  // No list is open on the chat (it has no sections), so the nav's links are the three pages.
  const nav = sidebarNav(page);
  await expect(nav.getByRole("link")).toHaveText(["Chat", "Wallet", "Plan"]);
  await expect(nav.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(sidebar.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  // Settings is pinned at the foot, outside the page list.
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0);

  const bar = page.locator("header");
  const quick = bar.getByTestId("demo-menu");
  await expect(quick).toHaveAttribute("data-persona", FOUNDER_PERSONA);
  await expect(quick).toHaveAccessibleName(new RegExp(`${FOUNDER_NAME}$`));
  // No page links, mode chip, persona switch or deployment id in the bar itself (K15, M11).
  await expect(bar.getByRole("navigation")).toHaveCount(0);
  await expect(bar.getByTestId("mode-badge")).toHaveCount(0);
  await expect(bar.getByRole("radiogroup", { name: "Persona" })).toHaveCount(0);
  await expect(bar).not.toContainText("final-");
});

test("the quick settings hold the data label, View as and the way into Proof", async ({ page }) => {
  await page.goto("/chat");
  const panel = await openDemoMenu(page);
  const badge = panel.getByTestId("mode-badge");
  await expect(badge).toHaveAttribute("data-mode", "mock");
  await expect(badge).toHaveText("Sample data");
  // The blockchain and app version are hover text only.
  await expect(badge).toHaveAttribute("title", /^Blockchain \d+, app version \S+$/);
  const persona = panel.getByRole("radiogroup", { name: "Persona" });
  await expect(persona.getByRole("radio")).toHaveText([FOUNDER_LABEL, "Loan officer"]);
  await expect(persona.getByRole("radio", { name: FOUNDER_LABEL })).toHaveAttribute("aria-checked", "true");
  await panel.getByRole("link", { name: "For reviewers: Proof" }).click();
  await expect(page).toHaveURL(/\/evidence$/);
  await expect(panel).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Proof" }).getByRole("link", { name: "Checks" })).toHaveAttribute("aria-current", "page");
});

test("the footer is one BU line with the rest behind What's a BU?, and the way into Proof", async ({ page }) => {
  await page.goto("/plan");
  const bu = page.getByTestId("bu-note");
  await expect(bu).toContainText("Amounts are in BU (budget units).");
  // Every property of a BU stays one press away (project.md D4).
  const more = bu.getByText(/can't send them to anyone, swap them for money, or count on them being worth a fixed amount/);
  await expect(more).toBeHidden();
  await bu.getByText("What's a BU?").click();
  await expect(more).toBeVisible();
  await expect(bu).toContainText("a licensed partner bank holds the money");
  await expect(page.getByTestId("footer-proof")).toHaveText("Proof (for reviewers)");
});

test("a skip link is the first stop for the keyboard and lands in the page", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("Proof has two sub-pages under one header, and the footer links to it", async ({ page }) => {
  await page.goto("/plan");
  await page.getByTestId("footer-proof").click();
  await expect(page).toHaveURL(/\/evidence$/);
  const tabs = page.getByTestId("proof-tabs");
  await expect(tabs.getByRole("link")).toHaveText(["Checks", "Activity record"]);
  await tabs.getByRole("link", { name: "Activity record" }).click();
  await expect(page).toHaveURL(/\/timeline$/);
  await expect(tabs.getByRole("link", { name: "Activity record" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Proof" })).toBeVisible();
});

test("the officer's side nav is Loan officer · Wallet · Proof, and Proof stays lit, its sub-pages listed, on both", async ({ page }) => {
  await signInAsOfficer(page);
  await page.goto("/officer");
  const nav = sidebarNav(page);
  await expect(nav.getByRole("link")).toHaveText(["Loan officer", "Wallet", "Proof"]);
  const quick = page.getByTestId("demo-menu");
  await expect(quick).toHaveAttribute("data-persona", "officer");
  await expect(quick).toHaveAccessibleName(/Loan officer$/);
  await expect(page.getByTestId("sidebar").getByRole("link", { name: "Settings" })).toBeVisible();
  for (const [path, sub] of [["/evidence", "Checks"], ["/timeline", "Activity record"]] as const) {
    await page.goto(path);
    await expect(nav.getByRole("link", { name: "Proof" })).toHaveAttribute("aria-current", "page");
    // Proof's drop-down starts open on its own pages and lists its two sub-pages, the current one marked.
    await expect(nav.getByRole("button", { name: "Proof pages" })).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("link", { name: sub })).toHaveAttribute("aria-current", "page");
  }
  await nav.getByRole("link", { name: "Checks" }).click();
  await expect(page).toHaveURL(/\/evidence$/);
});

test("each page's drop-down lists its sections: the current page's starts open, the others open on their chevron", async ({ page }) => {
  await page.goto("/plan");
  const nav = sidebarNav(page);
  const plan = nav.getByRole("button", { name: "Plan sections" });
  await expect(plan).toHaveAttribute("aria-expanded", "true");
  const planList = page.locator(`[id="${await plan.getAttribute("aria-controls")}"]`);
  await expect(planList.getByRole("link")).toHaveText(PLAN_SECTIONS);
  await expect(planList.getByRole("link", { name: "Rules" })).toHaveAttribute("href", "/plan#plan-rules");

  const wallet = nav.getByRole("button", { name: "Wallet sections" });
  await expect(wallet).toHaveAttribute("aria-expanded", "false");
  const walletList = page.locator(`[id="${await wallet.getAttribute("aria-controls")}"]`);
  await expect(walletList.getByRole("link")).toHaveCount(0);
  await wallet.click();
  await expect(wallet).toHaveAttribute("aria-expanded", "true");
  await expect(walletList.getByRole("link")).toHaveText(WALLET_SECTIONS);
  // The page link itself still navigates; the chevron only opens and closes.
  await expect(page).toHaveURL(/\/plan$/);
  await plan.click();
  await expect(plan).toHaveAttribute("aria-expanded", "false");
  await expect(planList.getByRole("link")).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Plan", exact: true })).toHaveAttribute("aria-current", "page");
});

test("opening one page's list closes the other lists, except the current page's", async ({ page }) => {
  await page.goto("/settings");
  const nav = sidebarNav(page);
  const wallet = nav.getByRole("button", { name: "Wallet sections" });
  const plan = nav.getByRole("button", { name: "Plan sections" });
  const settings = page.getByTestId("sidebar").getByRole("button", { name: "Settings sections" });
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await wallet.click();
  await expect(wallet).toHaveAttribute("aria-expanded", "true");
  await plan.click();
  await expect(plan).toHaveAttribute("aria-expanded", "true");
  await expect(wallet).toHaveAttribute("aria-expanded", "false");
  // The current page's list stays as it was.
  await expect(settings).toHaveAttribute("aria-expanded", "true");
});

test("a section on the same page: the nav scrolls to it, highlights it for a moment and marks it as here", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await planReady(page);
  await ensureSections(page, ["plan-rules"]);
  const rules = page.locator("#plan-rules").first();
  const link = sidebarNav(page).getByRole("link", { name: "Rules" });
  await link.click();
  await expect(page).toHaveURL(/\/plan#plan-rules$/);
  await expect(link).toHaveAttribute("aria-current", "location");
  await expect(rules).toHaveAttribute("data-section-flash", "");
  // The highlight starts once the scroll has ended: the section is already in place, under the 56 px top bar.
  const landed = (await rules.boundingBox())?.y ?? -1;
  expect(landed).toBeGreaterThanOrEqual(56);
  expect(landed).toBeLessThan(160);
  // The highlight is brief.
  await expect(rules).not.toHaveAttribute("data-section-flash", "", { timeout: 4_000 });
  await expect(link).toHaveAttribute("aria-current", "location");
  seen.assertClean();
});

test("a section on another page, or in the address: the page opens, then the section is highlighted once it is drawn", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/chat");
  const nav = sidebarNav(page);
  await nav.getByRole("button", { name: "Plan sections" }).click();
  await nav.getByRole("link", { name: "Rules" }).click();
  await expect(page).toHaveURL(/\/plan#plan-rules$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await planReady(page);
  await ensureSections(page, ["plan-rules"]);
  await expect(page.locator("#plan-rules").first()).toHaveAttribute("data-section-flash", "");

  await page.goto("/dashboard");
  await page.goto("/plan#plan-rules");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await planReady(page);
  await ensureSections(page, ["plan-rules"]);
  await expect(page.locator("#plan-rules").first()).toHaveAttribute("data-section-flash", "");
  await expect(nav.getByRole("link", { name: "Rules" })).toHaveAttribute("aria-current", "location");
  seen.assertClean();
});

test("a jump into a page that is still growing scrolls again, so the section is in place when it is highlighted", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/chat");
  const nav = sidebarNav(page);
  await nav.getByRole("button", { name: "Plan sections" }).click();
  // The Plan's data "lands" while the jump is under way: 900 px appear above its sections soon after it opens.
  await page.evaluate(() => {
    const grow = () => {
      const main = document.querySelector("main");
      const first = main?.querySelector("section[id]");
      if (!main || !first) return void window.setTimeout(grow, 50);
      window.setTimeout(() => {
        const block = document.createElement("div");
        block.style.height = "900px";
        first.before(block);
      }, 250);
    };
    window.addEventListener("hogee:test-grow", grow, { once: true });
  });
  await nav.getByRole("link", { name: "Rules" }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("hogee:test-grow")));
  await planReady(page);
  await ensureSections(page, ["plan-rules"]);
  const rules = page.locator("#plan-rules").first();
  await expect(rules).toHaveAttribute("data-section-flash", "");
  await expect.poll(async () => (await rules.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(56);
  await expect.poll(async () => (await rules.boundingBox())?.y ?? 999).toBeLessThan(160);
});

test("a page can ask for the jump by event; an id that isn't on the page does nothing", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const ask = (id: string) => page.evaluate((target) => window.dispatchEvent(new CustomEvent("hogee:jump-to-section", { detail: { id: target } })), id);
  await ask("plan-nowhere");
  await ask("<b>");
  await expect(page.locator("[data-section-flash]")).toHaveCount(0);
  await planReady(page);
  await ensureSections(page, ["plan-signature"]);
  await ask("plan-signature");
  await expect(page.locator("#plan-signature").first()).toHaveAttribute("data-section-flash", "");
  seen.assertClean();
});

test("while scrolling, the side nav marks the section in view", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await planReady(page);
  await ensureSections(page, ["plan-pockets"]);
  const nav = sidebarNav(page);
  // Sections that start a row of their own at every width (Safety limit shares the Summary's row in the bento Plan).
  for (const [id, label] of [["plan-pockets", "Pockets"], ["plan-summary", "Summary"], ["plan-pockets", "Pockets"]] as const) {
    await page.evaluate((target) => document.getElementById(target)?.scrollIntoView({ block: "start", behavior: "instant" }), id);
    await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "location");
    await expect(nav.locator('[aria-current="location"]')).toHaveCount(1);
  }
});

test("at phone width the side nav is a drawer from the left: pages and their sections, Settings, and it closes after a choice", async ({ page }) => {
  const seen = watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat");
  await expect(page.getByTestId("sidebar")).toBeHidden();
  // The quick settings stay in the top bar at every width.
  await expect(page.locator("header").getByTestId("demo-menu")).toBeVisible();
  const open = page.getByRole("button", { name: "Open menu" });
  await open.click();
  const drawer = page.getByRole("dialog", { name: "Menu" });
  const nav = drawer.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(["Chat", "Wallet", "Plan"]);
  await expect(drawer.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(drawer.getByRole("radiogroup", { name: "Persona" })).toHaveCount(0);
  await expectPageHygiene(page, "/chat nav drawer (390 px)");
  await nav.getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(drawer).toBeHidden();

  // A section on this page: the drawer closes and the section is highlighted.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await planReady(page);
  await ensureSections(page, ["plan-rules"]);
  await open.click();
  await expect(drawer.getByRole("button", { name: "Plan sections" })).toHaveAttribute("aria-expanded", "true");
  await drawer.getByRole("link", { name: "Rules" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator("#plan-rules").first()).toHaveAttribute("data-section-flash", "");
  await expect.poll(async () => (await page.locator("#plan-rules").first().boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(56);
  seen.assertClean();
});

test("the root redirects to the founder's chat", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/chat$/);
});

test("fonts are self-hosted", async ({ page }) => {
  const fontUrls: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fontUrls.push(request.url());
  });
  await page.goto("/chat");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(fontUrls.length).toBeGreaterThan(0);
  for (const url of fontUrls) expect(new URL(url).hostname).toBe("localhost");
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/Geist/i);
});

test("the officer persona needs the operator access code", async ({ page }) => {
  await page.goto("/chat");
  const panel = await openDemoMenu(page);
  await panel.getByRole("radiogroup", { name: "Persona" }).getByRole("radio", { name: "Loan officer" }).click();
  const dialog = page.getByRole("dialog", { name: "Switch to the loan officer" });
  // A demo says where the code is, never the code itself.
  await expect(dialog.getByTestId("officer-code-hint")).toHaveText("Demo: the access code is printed in the terminal where the app was started.");
  await expect(dialog.getByLabel("Officer access code")).toHaveAccessibleDescription(/printed in the terminal/);
  await dialog.getByLabel("Officer access code").fill("x".repeat(40));
  await dialog.getByRole("button", { name: "Switch" }).click();
  await expect(dialog.getByText("That access code isn't accepted.")).toBeVisible();
  // The modal hides the page from assistive tech while open; close it, then the founder is still the one signed in.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expectPersona(page, FOUNDER_NAME === "Mei" ? "founder:mei" : "founder:rina");
  await expect((await openDemoMenu(page)).getByRole("radio", { name: FOUNDER_LABEL })).toHaveAttribute("aria-checked", "true");
});
