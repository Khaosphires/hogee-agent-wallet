/**
 * The scripted demo video for the chat-first journey (docs/submission/VIDEO-SCRIPT.md; project.md §19.2): 1920×1080,
 * a CDP virtual authenticator for the passkey, action overlays, a source label on screen, captions → subtitles.
 *
 * Two parts, each on its own server, cut and joined by join-parts.mjs (`REPLAY=<runId> node demo/record-replay.mjs`):
 *   - DEMO_PART=main: every mock scene (Mei's journey, then the CFO) on the fresh scenario (MOCK_SCENARIO=fresh, a
 *     short cooling), labelled as the mock on screen;
 *   - DEMO_PART=evidence: the attacks and the evidence check on a REPLAY=<runId> server, labelled as a replay of a
 *     recorded run on the bundle's own chain.
 * Each part records its scenes back to back and writes where each one starts and ends; the join puts the scenes in the
 * script's order (the attacks come between the payment and the CFO). One server cannot be the mock and a replay at
 * once without mislabelling a scene, so there is no single-run mode.
 *
 * The holds (`pause`) pace the video for the viewer; every step first waits on its condition (a test id, an
 * attribute), so a slow page never lets the recording run ahead of the screen. Every page opens in the app's recording
 * mode (`?recording=1`, UX-PLAN D14: no demo tools, no deployment ids, no "Clear this chat"; the Sample labels stay).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addVirtualAuthenticator } from "../passkey/virtual-authenticator";
import { DEMO_COUNTRY, bannedWordsIn, resetMock } from "../support/app";
import { generateEnrolmentCode, showSignDetails, typeEnrolmentCodeInCard } from "../support/enrolment";
import { card, expectFreshMock, fillTermsForm, fundFacility, nextStepBar, nextStepButton, orderableCandidate, say, scheduleRow, signInDialog, watchSearch, type SupplierSearch } from "../support/journey";
import { act, caption, installOverlay, setSource } from "./overlay";
import {
  ATTACK_BEATS,
  CFO_NOTHING_TIGHTENED,
  DEMO_COOLING_SECONDS,
  MAX_ATTACK_BEATS,
  MAX_SECONDS,
  RECORDED_APP_HEIGHT,
  REPLAY_SCENES,
  SCENES,
  SOURCE_LABEL,
  chainWords,
  fillCaption,
  nothingTightened,
  slotMs,
  type Scene,
} from "./scenes";
import type { Cue } from "./srt";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");

/** `path` in the app's recording mode (apps/web lib/presentation.ts; kept for the tab in sessionStorage). */
const rec = (path: string): string => `${path}${path.includes("?") ? "&" : "?"}recording=1`;

/** A small PDF for the delivery check upload (the mock stores its check code, never the file). */
const DELIVERY_CHECK_PDF = { name: "delivery-check.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% Hogee demo: delivery check of 600 tumblers\n%%EOF\n") };

type Part = "main" | "evidence";

const PART: Part | undefined = (() => {
  const value = process.env.DEMO_PART?.trim();
  if (value === undefined || value === "") return undefined;
  if (value !== "main" && value !== "evidence") throw new Error(`DEMO_PART must be main or evidence, got "${value}"`);
  return value;
})();

const inPart = (id: string): boolean => (PART === "evidence") === REPLAY_SCENES.includes(id);

/** One scene's span in this part's recording (ms from the director's start). */
interface Segment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Runs this part's scenes back to back. Each scene holds until its slot ends (scenes.ts slotMs) and closes its last
 * caption there, so a caption never spills into the next scene once the join reorders them.
 */
function director(page: Page, chain: string) {
  const t0 = Date.now();
  const cues: Cue[] = [];
  const segments: Segment[] = [];
  let open: { text: string; startMs: number } | undefined;
  let sceneStart = 0;
  let sceneSlot = 0;
  const elapsed = () => Date.now() - t0;
  const closeCue = async () => {
    if (open) cues.push({ startMs: open.startMs, endMs: elapsed(), text: open.text });
    open = undefined;
    await caption(page, "");
  };
  return {
    t0,
    elapsed,
    cues,
    segments,
    /** Shows `text` (a scene caption, `{chain}` filled in) until the next one or the scene's end. */
    async say(text: string) {
      const filled = fillCaption(text, chain);
      if (open) cues.push({ startMs: open.startMs, endMs: elapsed(), text: open.text });
      open = { text: filled, startMs: elapsed() };
      await caption(page, filled);
    },
    /** Holds until `offsetMs` from the end of the current scene's slot (negative: before it ends). */
    async untilSlotEnd(offsetMs = 0) {
      const wait = sceneStart + sceneSlot + offsetMs - elapsed();
      if (wait > 0) await page.waitForTimeout(wait);
    },
    async scene(id: string, body: (s: Scene) => Promise<void>) {
      if (!inPart(id)) return;
      const s = SCENES.find((x) => x.id === id);
      if (!s) throw new Error(`no scene ${id}`);
      sceneStart = elapsed();
      sceneSlot = slotMs(id);
      await body(s);
      await this.untilSlotEnd();
      await closeCue();
      segments.push({ id, startMs: sceneStart, endMs: elapsed() });
    },
  };
}

type Director = ReturnType<typeof director>;

/** Off camera, before the main part's director starts: a fresh store, and the server it needs. */
async function prepareMainPart(page: Page): Promise<void> {
  expect(process.env.MOCK_SCENARIO, "DEMO_PART=main runs on MOCK_SCENARIO=fresh (node demo/record-replay.mjs sets it)").toBe("fresh");
  expect(process.env.DEMO_TIMELOCK_SECONDS, "the pay scene's caption states the recording's cooling").toBe(String(DEMO_COOLING_SECONDS));
  await resetMock();
  await expectFreshMock(page);
  // Compile /chat and /dashboard off camera, so no scene opens on a compiling page.
  await page.goto(rec("/dashboard"));
  await expect(page.getByRole("heading", { level: 1, name: "Wallet", exact: true })).toBeVisible({ timeout: 120_000 });
  await page.goto(rec("/chat"));
  await expect(page.getByTestId("chat-opener")).toBeVisible({ timeout: 120_000 });
  await page.goto("about:blank");
}

/**
 * The evidence part runs on a REPLAY server (a mock left on the port would be reused). Compiles /evidence off camera
 * and returns the words for the bundle's own chain, read from its contracts.json (never from the session, which keeps
 * the mock's deployment).
 */
async function prepareReplayPart(page: Page): Promise<string> {
  const runId = process.env.REPLAY?.trim();
  expect(runId, "DEMO_PART=evidence needs REPLAY=<runId>").toBeTruthy();
  const session = (await (await page.request.get("/api/session")).json()) as { mode?: string };
  expect(session.mode, "DEMO_PART=evidence needs a REPLAY=<runId> server (stop any mock server on the port first)").toBe("replay");
  const contracts = await page.request.get(`/api/evidence/${runId}/files/contracts.json`);
  expect(contracts.ok(), `the replayed bundle ${runId} has no contracts.json`).toBe(true);
  const { chainId } = (await contracts.json()) as { chainId: number };
  await page.goto(rec("/evidence"));
  await expect(page.getByTestId("verify-count")).toBeVisible({ timeout: 120_000 });
  await page.goto("about:blank");
  return chainWords(chainId);
}

/** The passing evidence rows of a task the replayed run holds (a refusal and its forced revert are two rows). */
const taskRows = (page: Page, taskId: string): Locator =>
  page.getByTestId("evidence-row").filter({ has: page.getByRole("cell", { name: taskId, exact: true }) });

/**
 * Outlines rows for a moment (no click): the attacks scene points at rows, it changes nothing. A task's rows need not
 * sit together (the anchored refusal comes after the reverts), so each one is centred in turn for its share of the hold.
 */
async function spotlight(page: Page, rows: Locator, holdMs: number): Promise<void> {
  const all = await rows.all();
  for (const row of all) await row.evaluate((el) => ((el as HTMLElement).style.outline = "3px solid #f59e0b"));
  for (const row of all) {
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(Math.floor(holdMs / all.length));
  }
  for (const row of all) await row.evaluate((el) => ((el as HTMLElement).style.outline = ""));
}

/** What the mock scenes share: the director, the search the search scene saw, the officer's one-time code. */
interface MainRun {
  readonly page: Page;
  readonly d: Director;
  readonly pause: (ms: number) => Promise<void>;
  readonly searches: ReturnType<typeof watchSearch>;
  enrolmentCode: string;
  search?: SupplierSearch;
}

const readySearch = (run: MainRun): SupplierSearch => {
  if (!run.search) throw new Error("this scene needs the search scene's READY search");
  return run.search;
};

/** The opener with the passkey set-up card; off camera, the loan officer makes the one-time code in their own browser. */
async function hookScene(run: MainRun, s: Scene): Promise<void> {
  const { page, d, pause } = run;
  await page.goto(rec("/chat"));
  await expect(page.getByTestId("chat-opener")).toBeVisible();
  await expect(page.getByTestId("passkey-setup")).toHaveAttribute("data-state", "form");
  await expect(nextStepBar(page)).toHaveAttribute("data-step", "passkey");
  await d.say(s.captions[0] ?? "");
  [run.enrolmentCode] = await Promise.all([generateEnrolmentCode(page), pause(6_000)]);
  await d.say(s.captions[1] ?? "");
  await pause(6_000);
  await d.say(s.captions[2] ?? "");
}

/** Passkey first (the set-up card and the officer's code), the three questions, the plan card, its signature. */
async function needsScene(run: MainRun, s: Scene): Promise<void> {
  const { page, d, pause } = run;
  await d.say(s.captions[0] ?? "");
  await typeEnrolmentCodeInCard(page, run.enrolmentCode, (target) => act(page, "Mei creates her passkey", target));
  await pause(5_500);
  await d.say(s.captions[1] ?? "");
  await act(page, "Mei describes her business", page.getByRole("button", { name: /^I want to sell custom insulated tumblers/ }));
  for (let i = 0; i < 3; i += 1) {
    const question = page.getByTestId("question").nth(i);
    await expect(question).toBeVisible();
    await act(page, "Mei answers", question.getByRole("button").first(), 900);
  }
  const needs = card(page, "needs");
  await expect(needs).toBeVisible();
  await expect(nextStepBar(page)).toHaveAttribute("data-step", "sign-plan");
  await needs.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await d.say(s.captions[2] ?? "");
  await pause(10_000);
  await d.say(s.captions[3] ?? "");
  // The passkey made in the welcome card signs straight away: the sheet asks for no code.
  await signInDialog(page, needs.getByTestId("sign-open"), {
    click: (target) => act(page, "Sign the plan", target),
    beforeSign: () => pause(3_500),
  });
  await expect(needs.getByTestId("sign-status")).toHaveAttribute("data-state", "confirmed");
  await needs.getByTestId("sign-status").evaluate((el) => el.scrollIntoView({ block: "center" }));
  // Off camera: the loan officer adds the money (runbook §8 step 5), so the Next step offers Find suppliers.
  await fundFacility();
}

async function searchScene(run: MainRun, s: Scene): Promise<void> {
  const { page, d, pause } = run;
  await expect(nextStepBar(page)).toHaveAttribute("data-step", "find", { timeout: 20_000 });
  await d.say(s.captions[0] ?? "");
  await act(page, "Find suppliers", nextStepButton(page));
  await expect(card(page, "search")).toHaveAttribute("data-status", "READY", { timeout: 20_000 });
  const candidates = card(page, "candidates");
  await expect(candidates.getByTestId("candidate").first()).toBeVisible();
  await expect.poll(() => run.searches.ready()?.status).toBe("READY");
  run.search = run.searches.ready();
  await pause(2_500);
  await candidates.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(candidates.getByTestId("candidate").first()).toContainText("Unverified web supplier");
  await d.say(s.captions[1] ?? "");
  await pause(8_000);
  const summary = candidates.getByTestId("excluded-summary");
  await act(page, "Why pages are hidden", summary.locator("summary"));
  await expect(summary).toContainText("instructions aimed at the AI");
  await summary.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await d.say(s.captions[2] ?? "");
}

async function enquiryScene(run: MainRun, s: Scene): Promise<void> {
  const { page, d } = run;
  const search = readySearch(run);
  const candidates = card(page, "candidates");
  await d.say(s.captions[0] ?? "");
  const chosen = orderableCandidate(search);
  const other = search.candidates.find((c) => c.supplierId !== chosen.supplierId && c.canOrder && !c.priceFlag);
  for (const c of [chosen, ...(other ? [other] : [])]) {
    const row = candidates.locator(`[data-testid=candidate][data-supplier-id="${c.supplierId}"]`);
    // Three rows show first, the rest behind "Show N more" (ux-order D27).
    if (!(await row.isVisible())) await act(page, "Show more", candidates.getByTestId("candidates-more"));
    await act(page, `Picks #${c.rank}`, row.getByRole("checkbox"));
  }
  await act(page, "Write a message", candidates.getByTestId("pick-submit"));
  const enquiry = card(page, "enquiry");
  await expect(enquiry).toBeVisible();
  await enquiry.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await act(page, "Copies the message", enquiry.getByTestId("copy-enquiry"));
}

/** The deal in her words, the deal form, then Save and sign: one press saves and opens the order's sign sheet. */
async function termsScene(run: MainRun, s: Scene): Promise<void> {
  const { page, d, pause } = run;
  const search = readySearch(run);
  const chosen = orderableCandidate(search);
  await d.say(s.captions[0] ?? "");
  await say(page, `went with #${chosen.rank}, 30% deposit, 70% on delivery`, (target) => act(page, "Mei reports the deal", target));
  const form = card(page, "terms");
  // Her words pre-select the 30/70 split.
  await expect(form.getByRole("radio", { name: /^30\/70/, checked: true })).toBeVisible();
  await form.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await pause(3_000);
  await d.say(s.captions[1] ?? "");
  await pause(2_500);
  await fillTermsForm(form, search, chosen.displayName);
  await pause(3_000);
  await d.say(s.captions[2] ?? "");
  // Sign about 18 s before the scene ends: the pay scene opens on the safety wait's countdown, and the deposit lands
  // early enough in it for its caption (DEMO_COOLING_SECONDS from the signature).
  await d.untilSlotEnd(-18_000);
  await signInDialog(page, form.getByTestId("terms-submit"), {
    click: (target) => act(page, "Save and sign", target),
    beforeSign: async (dialog) => {
      await expect(dialog.getByTestId("sign-unverified")).toBeVisible();
      await pause(2_500);
      // The signed rows and Hogee's notes (not signed) are folded under "Show details" (UX-PLAN D16).
      await showSignDetails(dialog);
      const notes = dialog.getByTestId("server-description");
      await notes.evaluate((el) => ((el as HTMLDetailsElement).open = true));
      await expect(notes).toContainText("Found by web search, not verified");
      await notes.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await pause(2_000);
    },
  });
}

async function payScene(run: MainRun, s: Scene): Promise<void> {
  const { page, d } = run;
  const order = card(page, "order");
  await expect(order).toBeVisible();
  await order.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const paid = order.locator(scheduleRow("ON_ORDER", true));
  await expect(order.getByTestId("cooling-countdown").or(paid).first()).toBeVisible();
  await d.say(s.captions[0] ?? "");
  await expect(paid).toBeVisible({ timeout: (DEMO_COOLING_SECONDS + 30) * 1000 });
  await expect(order.getByTestId("goods-arrived")).toBeVisible();
  await d.say(s.captions[1] ?? "");
}

/** Goods arrived → the delivery check (here a report file) → Pay the balance with her passkey → Order complete. */
async function balanceScene(run: MainRun, s: Scene): Promise<void> {
  const { page, d, pause } = run;
  const order = card(page, "order");
  await d.say(s.captions[0] ?? "");
  await act(page, "Goods arrived", order.getByTestId("goods-arrived"));
  await expect(nextStepBar(page)).toHaveAttribute("data-step", "upload");
  await order.getByTestId("balance-block").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await pause(2_500);
  await order.getByLabel("Inspection report").setInputFiles(DELIVERY_CHECK_PDF);
  await pause(1_500);
  await act(page, "Upload report", order.getByRole("button", { name: "Upload report" }));
  const pay = order.getByRole("button", { name: "Pay the balance" });
  await expect(pay).toBeEnabled({ timeout: 20_000 });
  await pause(2_500);
  await d.say(s.captions[1] ?? "");
  await signInDialog(page, pay, { click: (target) => act(page, "Pay the balance", target), beforeSign: () => pause(2_000) });
  await expect(order.locator(scheduleRow("ON_DELIVERY_INSPECTED", true))).toBeVisible({ timeout: 30_000 });
  const complete = order.getByTestId("order-complete");
  await expect(complete).toBeVisible();
  await complete.evaluate((el) => el.scrollIntoView({ block: "center" }));
}

/**
 * Brings a Wallet section on screen: through the side nav's link to it when the shell has one (ux2-nav: the sidebar
 * lists each page's sections), else by scrolling to it as that link does.
 */
async function showSection(page: Page, id: string, label: string): Promise<void> {
  const link = page.locator(`a[href$="#${id}"]:visible`).first();
  if ((await link.count()) > 0) {
    await act(page, label, link);
  } else {
    await page.locator(`#${id}`).evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 0.2 });
}

/** The count in the Wallet's line on what the AI did by itself: "Hogee's AI paid only what you signed (2 automatic payments) …". */
async function automaticOnScreen(page: Page): Promise<number> {
  const line = page.getByTestId("agent-actions-none");
  await expect(line).toContainText("paid only what you signed");
  const n = Number(/\((\d+) automatic payments?\)/.exec((await line.textContent()) ?? "")?.[1]);
  expect(n, "the Activity line names its automatic payments").toBeGreaterThan(0);
  return n;
}

/** "How are we doing?", the money card, then the Wallet: the four numbers, Activity (what the AI did), Profit, Forecast. */
async function cfoScene(run: MainRun, s: Scene): Promise<void> {
  const { page, d, pause } = run;
  await say(page, "How are we doing?", (target) => act(page, "How are we doing?", target));
  const cfo = card(page, "cfo");
  await expect(cfo).toHaveAttribute("data-view", "overview");
  await cfo.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await d.say(s.captions[0] ?? "");
  await pause(8_000);
  await act(page, "See all your numbers", cfo.locator('a[href="/dashboard?tab=overview"]'));
  await expect(page.getByRole("heading", { level: 1, name: "Wallet", exact: true })).toBeVisible();
  await expect(page.getByTestId("money-tiles")).toBeVisible();
  await pause(2_500);
  await showSection(page, "wallet-activity", "Activity");
  // The script's caption needs an AI tighten on screen; the mock has none, so say what the Activity line says, with its
  // own count of automatic payments.
  const tightened = (await page.getByTestId("agent-action").count()) > 0;
  await d.say(tightened ? (s.captions[1] ?? "") : nothingTightened(await automaticOnScreen(page)));
  await pause(8_000);
  await showSection(page, "wallet-profit", "Profit");
  await pause(3_000);
  await showSection(page, "wallet-forecast", "Forecast");
  await pause(2_000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await expect(page.getByTestId("cfo-sample-note").first()).toBeInViewport();
  await d.say(s.captions[2] ?? "");
}

/** The mock scenes: Mei's journey to the order complete, then the Wallet. */
async function mainScenes(page: Page, d: Director): Promise<void> {
  const run: MainRun = { page, d, pause: (ms) => page.waitForTimeout(ms), searches: watchSearch(page), enrolmentCode: "" };
  await d.scene("hook", (s) => hookScene(run, s));
  await d.scene("needs", (s) => needsScene(run, s));
  await d.scene("search", (s) => searchScene(run, s));
  await d.scene("enquiry", (s) => enquiryScene(run, s));
  await d.scene("terms", (s) => termsScene(run, s));
  await d.scene("pay", (s) => payScene(run, s));
  await d.scene("balance", (s) => balanceScene(run, s));
  await d.scene("cfo", (s) => cfoScene(run, s));
}

/** The replay scenes: the attacks, then the evidence check. */
async function replayScenes(page: Page, d: Director): Promise<void> {
  const pause = (ms: number) => page.waitForTimeout(ms);

  await d.scene("attacks", async (s) => {
    await page.goto(rec("/evidence"));
    await expect(page.getByTestId("evidence-row").first()).toBeVisible();
    await d.say(s.captions[0] ?? "");
    await pause(7_000);
    let shown = 0;
    for (const beat of ATTACK_BEATS) {
      if (shown === MAX_ATTACK_BEATS) break;
      const rows = taskRows(page, beat.taskId);
      // A beat shows only when the replayed run holds its rows, each one passing (the runner's verdict).
      if ((await rows.count()) === 0) continue;
      for (const row of await rows.all()) await expect(row).toHaveAttribute("data-outcome", "pass");
      await d.say(s.captions[beat.caption] ?? "");
      await spotlight(page, rows, 11_000);
      shown += 1;
    }
    expect(shown, `the replayed run holds none of the attack rows ${ATTACK_BEATS.map((b) => b.taskId).join(", ")}`).toBeGreaterThan(0);
  });

  await d.scene("verify", async (s) => {
    const from = d.elapsed();
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await d.say(s.captions[0] ?? "");
    // The caption says anyone can verify the bundle, so the scene never records one that does not verify.
    await expect(page.getByTestId("verify-count"), "the verifier did not finish on the evidence page").toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("verify-checks"), "the replay scenes need a bundle that verifies (REPLAY=<runId>)").toHaveAttribute("data-ok", "true");
    await expect(page.getByTestId("verify-panel")).toContainText("Internally consistent");
    await page.getByTestId("verify-anchor").evaluate((el) => el.scrollIntoView({ block: "center" }));
    const hold = from + 16_000 - d.elapsed();
    if (hold > 0) await pause(hold);
    await d.say(s.captions[1] ?? "");
  });
}

// The app fills the frame above the subtitle band (scenes.ts RECORDED_APP_HEIGHT); the video stays 1920×1080.
test.use({ viewport: { width: 1920, height: RECORDED_APP_HEIGHT } });

test("records the Hogee demo", async ({ page }) => {
  test.skip(DEMO_COUNTRY !== "SG", "the video is Singapore-first (Mei, SGD); HOGEE_COUNTRY=MY serves Rina");
  if (!PART) throw new Error("Set DEMO_PART=main or DEMO_PART=evidence; record both with REPLAY=<runId> node demo/record-replay.mjs");
  test.setTimeout(12 * 60_000);
  const recordingStart = Date.now();
  await addVirtualAuthenticator(page);
  // The enquiry scene presses "Copy": without the clipboard permission the card shows "Copy failed" on camera.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await installOverlay(page);
  const chain = PART === "evidence" ? await prepareReplayPart(page) : "";
  if (PART === "main") await prepareMainPart(page);
  // Every caption this part may show passes the wording rule before anything is recorded.
  const lines = [...SCENES.filter((x) => inPart(x.id)).flatMap((x) => x.captions), ...(PART === "main" ? [CFO_NOTHING_TIGHTENED] : [])];
  for (const c of lines) expect(bannedWordsIn(fillCaption(c, chain)), `caption: ${c}`).toEqual([]);
  await setSource(page, fillCaption(SOURCE_LABEL[PART === "evidence" ? "replay" : "mock"], chain));
  const d = director(page, chain);

  if (PART === "main") await mainScenes(page, d);
  else await replayScenes(page, d);

  const seconds = d.elapsed() / 1000;
  expect(seconds, "one part alone must stay under 5 minutes (§19.2); join-parts.mjs checks the total").toBeLessThanOrEqual(MAX_SECONDS);
  const mode = process.env.REPLAY ? `replay:${process.env.REPLAY}` : "mock";
  const dir = join(OUT, "parts", PART);
  mkdirSync(dir, { recursive: true });
  // leadMs: video recorded before the director started (cut by join-parts.mjs). Segments and cues are in ms from the
  // director's start; timeline is the script's scene order, which the join follows.
  // frame: the browser's size inside the 1920×1080 recording (the rest is padding that join-parts.mjs crops).
  const frame = page.viewportSize();
  const part = { part: PART, mode, leadMs: d.t0 - recordingStart, endMs: d.elapsed(), frame, timeline: SCENES.map((x) => x.id), segments: d.segments, cues: d.cues };
  writeFileSync(join(dir, "part.json"), `${JSON.stringify(part, null, 2)}\n`);
  const video = page.video();
  await page.close();
  await video?.saveAs(join(dir, "hogee-demo.webm"));
});
