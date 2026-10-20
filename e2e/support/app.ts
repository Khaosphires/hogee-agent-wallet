/** Shared helpers for the smoke tests: network/console guards, wording check, persona switching. */
import { expect, test, type Page } from "@playwright/test";
import { bannedWordsIn } from "./wording";

export { bannedWordsIn };

const LOCAL_PROTOCOLS = new Set(["data:", "blob:", "about:"]);

// A 4xx from the API is an answer the page renders (e.g. a record the seed doesn't have), not a failure; Chrome
// still logs it as a console error, so it is skipped here. Any /api 5xx is recorded instead.
const RESOURCE_4XX = /Failed to load resource: the server responded with a status of 4\d\d/;

/** Records every request that leaves localhost, page errors, console errors and /api 5xx answers. */
export function watch(page: Page) {
  const offOrigin: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!LOCAL_PROTOCOLS.has(url.protocol) && url.hostname !== "localhost") offOrigin.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 500 && new URL(response.url()).pathname.startsWith("/api/")) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !RESOURCE_4XX.test(message.text())) errors.push(message.text());
  });
  return {
    offOrigin,
    errors,
    assertClean() {
      expect(offOrigin, "requests left localhost").toEqual([]);
      expect(errors, "console or page errors").toEqual([]);
    },
  };
}

/**
 * Body text shows no banned words (project.md D5 / §14.4, VISION-DECISIONS §0.5: the wording lint's own check plus
 * "confidence") and the page does not scroll sideways. Call it once the content under test is on screen.
 */
export async function expectPageHygiene(page: Page, label: string): Promise<void> {
  expect(bannedWordsIn(await page.locator("body").innerText()), `${label} shows banned words`).toEqual([]);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sideways > 0) {
    expect(sideways, `${label} scrolls sideways; widest elements: ${(await overflowing(page)).join(" | ")}`).toBeLessThanOrEqual(0);
  }
}

/**
 * The elements that start the overflow: each reaches past the viewport's right edge while its parent does not (the
 * element whose own width pushes the page sideways), named by tag, class, the nearest test id and its text.
 */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const past = (el: Element) => el.getBoundingClientRect().right > width + 0.5;
    const wide = [...document.body.querySelectorAll<HTMLElement>("*")].filter(past);
    const culprits = wide.filter((el) => el.parentElement === null || !past(el.parentElement));
    // Inside them, the boxes whose own content is wider than the box (a long unbroken string, a nowrap row).
    const cramped = culprits.flatMap((c) => [c, ...c.querySelectorAll<HTMLElement>("*")]).filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0);
    return [...culprits.slice(0, 5), ...cramped.slice(-3)].map((el) => {
      const id = el.closest("[data-testid]")?.getAttribute("data-testid");
      const what = `${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/).slice(0, 3).join(".")}`;
      return `${what} in ${id ?? "(no test id)"} right=${Math.round(el.getBoundingClientRect().right)} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    });
  });
}

/**
 * The country the mock serves: HOGEE_COUNTRY, which the web server inherits from the runner's environment (unset: SG,
 * the mock's default). Anything but SG or MY throws, as the mock does (fail closed).
 */
export const DEMO_COUNTRY: "SG" | "MY" = (() => {
  const value = process.env.HOGEE_COUNTRY ?? "SG";
  if (value !== "SG" && value !== "MY") throw new Error(`HOGEE_COUNTRY must be SG or MY for the e2e run, got "${value}"`);
  return value;
})();

/** The country switch's two countries, the plan's own first in this table (SG-DECISIONS: Singapore, then Malaysia). */
export const COUNTRY = (
  {
    SG: { home: "Singapore", other: "Malaysia" },
    MY: { home: "Malaysia", other: "Singapore" },
  } as const
)[DEMO_COUNTRY];

/**
 * The demo founder of the mock's country: Mei (SG) or Rina (MY). The mock serves one founder per HOGEE_COUNTRY and the
 * switch offers only that one (SG-DECISIONS Q1).
 */
export const FOUNDER_LABEL = DEMO_COUNTRY === "SG" ? "Mei (founder)" : "Rina (founder)";

/** The founder's short name on the quick settings button (the avatar and "Mei"). */
export const FOUNDER_NAME = DEMO_COUNTRY === "SG" ? "Mei" : "Rina";

/**
 * Opens the quick settings at the top right (UX round 2: the button that replaced the "Demo · Mei" menu, test id
 * `demo-menu`; it holds the data label, "View as", Sample business, Recording mode and the way into Proof) and returns
 * its panel. The button sits in the top bar at every width, so this works on phones too.
 */
export async function openDemoMenu(page: Page) {
  const panel = page.getByTestId("demo-menu-panel");
  if (!(await panel.isVisible().catch(() => false))) await page.getByTestId("demo-menu").click();
  await expect(panel).toBeVisible();
  return panel;
}

/** Who the session is, from the quick settings button (it carries the persona even while its panel is closed). */
export const expectPersona = (page: Page, persona: "founder:mei" | "founder:rina" | "officer") =>
  expect(page.getByTestId("demo-menu")).toHaveAttribute("data-persona", persona);

const FOUNDER_PERSONA = DEMO_COUNTRY === "SG" ? "founder:mei" : "founder:rina";

export const officerToken = (): string => {
  const token = process.env.E2E_OFFICER_TOKEN;
  if (!token) throw new Error("E2E_OFFICER_TOKEN is not set (playwright.config.ts sets it)");
  return token;
};

/**
 * Makes the page's browser context the loan officer's without the access code ever entering the browser: the
 * persona cookie is minted from Node, which Playwright does not trace. A retained trace records typed values, input
 * values in its DOM snapshots and request bodies, so typing the code would put it in the trace (P1 review of #5,
 * point 12). Call it before navigating; the cookie itself is per run and expires within 8 h.
 */
export async function signInAsOfficer(page: Page): Promise<void> {
  const { baseURL, name, value } = await officerCookie();
  await page.context().addCookies([{ name, value, domain: new URL(baseURL).hostname, path: "/api", httpOnly: true, sameSite: "Strict" }]);
}

/** The officer's persona cookie, minted from Node (see signInAsOfficer). */
async function officerCookie(): Promise<{ baseURL: string; name: string; value: string }> {
  const baseURL = test.info().project.use.baseURL ?? "http://localhost:3000";
  const res = await fetch(new URL("/api/session/persona", baseURL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona: "officer", officerToken: officerToken() }),
  });
  const pair = res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const eq = pair.indexOf("=");
  if (!res.ok || eq < 1) throw new Error(`officer sign-in answered ${res.status} without a persona cookie`);
  return { baseURL, name: pair.slice(0, eq), value: pair.slice(eq + 1) };
}

/**
 * POST `path` as the loan officer, from Node (signInAsOfficer's cookie; the access code never enters a browser).
 * Returns the JSON answer; anything but 2xx throws with the status.
 */
export async function officerPost(path: string, body: unknown = {}): Promise<unknown> {
  const { baseURL, name, value } = await officerCookie();
  const res = await fetch(new URL(path, baseURL), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${name}=${value}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

/** POST /api/demo/reset as the officer, from Node: the shared mock store goes back to its seed. */
export async function resetMock(): Promise<void> {
  await officerPost("/api/demo/reset");
}

/**
 * Switches the persona with the quick settings' "View as" radios (accessible name "Persona"). Switching to the officer TYPES
 * the access code, which a retained trace would record: callers turn tracing off (persona-switch.spec.ts, the demo
 * project); other tests use signInAsOfficer.
 * The field is blanked before any assertion can fail: when an expect fails, Playwright snapshots the page, input values
 * included, into error-context.md, and a failing expect inside the `try` would do it before `finally` ran (P1 re-review
 * of #6, finding 1). So only actions run while the code is in the field (an action takes no snapshot), and they time out
 * well before the test does, because at a test timeout the snapshot is also taken before `finally`.
 */
export async function switchPersona(page: Page, persona: "founder" | "officer"): Promise<void> {
  const group = (await openDemoMenu(page)).getByRole("radiogroup", { name: "Persona" });
  if (persona === "founder") {
    await group.getByRole("radio", { name: FOUNDER_LABEL }).click();
    await expectPersona(page, FOUNDER_PERSONA);
    return;
  }
  await group.getByRole("radio", { name: "Loan officer" }).click();
  const dialog = page.getByRole("dialog", { name: "Switch to the loan officer" });
  const code = dialog.getByLabel("Officer access code");
  try {
    await code.fill(officerToken(), { timeout: 15_000 });
    await dialog.getByRole("button", { name: "Switch" }).click({ timeout: 15_000 });
    // The panel closes as the dialog opens; wait for the dialog to close, then read the persona off the quick settings button.
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  } finally {
    if (await code.isVisible().catch(() => false)) await code.fill("", { timeout: 5_000 }).catch(() => undefined);
  }
  await expectPersona(page, "officer");
}
