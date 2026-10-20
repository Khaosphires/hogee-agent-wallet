import { expect, test, type Page, type Route } from "@playwright/test";
import { expectPageHygiene, watch } from "../support/app";

// Proof → Checks' FISCO BCOS mirror (REG-BRIEF fisco-proof): the newest mirror pack the API lists is fetched file by
// file and checked in the browser with the Sepolia bundle it mirrors. Never a faked pass; an Etherscan link only for a
// timestamp the browser's own check accepted on a pack that passed; a pack with no timestamp is "not timestamped yet",
// never a check line (audit run-12 v-1); a server without the routes (404) is a quiet empty state.

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const ETHERSCAN_TX = "https://sepolia.etherscan.io/tx/0x";
const SECTION = "#proof-fisco";

/** Waits for the section's own check to finish; returns its tone. */
async function checked(page: Page): Promise<string | null> {
  const mirror = page.getByTestId("fisco-mirror");
  await expect(mirror).toBeVisible({ timeout: 30_000 });
  await expect(mirror).not.toHaveAttribute("data-tone", "checking", { timeout: 90_000 });
  return mirror.getAttribute("data-tone");
}

/** Every link in the section that leaves the app. */
const sectionLinks = (page: Page) => page.locator(`${SECTION} a[href^='http']`).evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href));

/** The timestamp's check row, if any. */
const anchorRow = (page: Page) => page.getByTestId("fisco-checks").locator("[data-check='Sepolia timestamp']");

/** The red verdict, with its count and the reference-only note, and no timestamp link. */
async function expectNotVerified(page: Page): Promise<void> {
  const verdict = page.getByTestId("fisco-verdict");
  await expect(verdict).toHaveAttribute("data-tone", "failed");
  await expect(verdict.getByRole("heading", { name: "Not verified" })).toBeVisible();
  await expect(page.getByTestId("fisco-count")).toHaveText(/^\d+ of \d+ checks passed$/);
  await expect(page.getByTestId("fisco-reference-only")).toBeVisible();
  await expect(page.getByTestId("fisco-checks")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("fisco-etherscan")).toHaveCount(0);
  await expect(page.getByTestId("fisco-replayed")).toHaveCount(0);
  expect(await sectionLinks(page)).toEqual([]);
}

test("the FISCO mirror is checked in this browser, with only localhost answering", async ({ page, context }) => {
  const seen = watch(page);
  await context.route(/^https?:\/\/(?!localhost[:/])/, (route) => route.abort("internetdisconnected"));
  await page.goto("/evidence");
  const section = page.locator(SECTION);
  await expect(section.getByRole("heading", { name: "FISCO BCOS mirror", level: 2 })).toBeVisible();
  const tone = await checked(page);
  const verdict = page.getByTestId("fisco-verdict");
  if (tone === "verified") {
    await expect(verdict.getByRole("heading")).toHaveText(/^(\d+) of \1 checks passed in this browser$/);
    await expect(page.getByTestId("fisco-count")).toHaveCount(0);
    await expect(page.getByTestId("fisco-reference-only")).toHaveCount(0);
    // The replay date comes from the pack this browser verified.
    await expect(page.getByTestId("fisco-replayed")).toHaveText(/^ · replayed \d{1,2} [A-Z][a-z]{2}$/);
  } else {
    expect(tone).toBe("failed");
    await expectNotVerified(page);
  }
  // The three stops, the nodes and the timestamp, then the full step list behind Show details.
  await expect(page.getByTestId("fisco-stop")).toHaveCount(3);
  expect(await page.getByTestId("fisco-stop").evaluateAll((els) => els.map((e) => e.getAttribute("data-step")))).toEqual(["F1", "M1", "R17"]);
  await expect(page.getByTestId("fisco-nodes")).toContainText("FISCO BCOS (local) · 20200");
  const anchor = page.getByTestId("fisco-anchor");
  await expect(anchor).toHaveAttribute("data-state", /^(anchored|unproven|none|unavailable|failed)$/);
  const anchorState = await anchor.getAttribute("data-state");
  // A link only for a timestamp the browser's check accepted on a pack that passed, and only to the pinned Etherscan.
  if (anchorState !== "anchored") {
    await expect(page.getByTestId("fisco-etherscan")).toHaveCount(0);
    await expect(page.locator(SECTION)).not.toContainText("the Sepolia timestamp is the public part");
  }
  for (const href of await sectionLinks(page)) expect(href.startsWith(ETHERSCAN_TX), href).toBe(true);
  await page.getByTestId("fisco-details").locator(":scope > summary").click();
  await expect(page.getByTestId("fisco-steps").getByRole("listitem").first()).toBeVisible();
  // Not timestamped yet is a neutral state, never a (passing) check line.
  if (anchorState === "none") {
    await expect(anchor).toContainText("Not timestamped yet");
    await expect(anchorRow(page)).toHaveCount(0);
  }
  // A passing row carries the checker's own detail too (as the CLI prints it), so its caveats travel with the pass.
  const passed = page.getByTestId("fisco-checks").locator("[data-check][data-ok='true']");
  for (const row of await passed.all()) await expect(row.getByTestId("fisco-check-detail"), (await row.getAttribute("data-check")) ?? "").not.toBeEmpty();
  await expectPageHygiene(page, "/evidence (FISCO mirror)");
  seen.assertClean();
});

test("one changed byte in a served pack file is a red Not verified", async ({ page }) => {
  await page.route(/\/api\/evidence\/fisco\/fm-[0-9a-f]{16}\/files\/steps\.json$/, async (route) => {
    const res = await route.fetch();
    const body = Buffer.from(await res.body());
    const at = body.length - 3;
    body[at] = (body[at] ?? 0) ^ 0x01;
    await route.fulfill({ response: res, body });
  });
  await page.goto("/evidence");
  expect(await checked(page)).toBe("failed");
  await expectNotVerified(page);
});

// ---- a pack that can't pass: the stops are shown, for reference only ---------------------------------------------

const PACK = "fm-00000000000000e2";
const SOURCE_RUN = "ev-74756ea61a72ae7c";
const word = (n: number) => n.toString(16).padStart(64, "0");
const errorString = (text: string) => {
  const hex = Buffer.from(text, "ascii").toString("hex");
  return `0x08c379a0${word(32)}${word(text.length)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};
const SPEND = `0x${"5a".repeat(4)}${"00".repeat(224)}`;
const txHash = (seq: number) => `0x${seq.toString(16).padStart(64, "0")}`;

/** A v2-shaped mirror pack with the three stops (synthetic: it fails the checks, as any pack not from the real run must). */
function displayPack(): Record<string, string> {
  const steps = [
    { seq: 1, id: "G0", role: "regulator", kind: "mined", block: 6, status: 0, output: `0x${word(0)}` },
    { seq: 21, id: "G1", role: "regulator", kind: "mined", block: 27, status: 0, output: `0x${word(0)}` },
    { seq: 22, id: "V1", role: "regulator", kind: "mined", block: 28, status: 0, output: `0x${word(1)}` },
    { seq: 23, id: "F1", role: "agent", kind: "mined-reverted", block: 29, status: 22, output: errorString("Account's status is abnormal") },
    // Not FISCO's own words for status 18: the card falls back to the catalogue's error name.
    { seq: 30, id: "M1", role: "agent", kind: "mined-reverted", block: 35, status: 18, output: errorString("Call permission denied: ask the regulator") },
    { seq: 36, id: "R17", role: "agent", kind: "mined-reverted", block: 41, status: 16, output: "0x" },
  ];
  const files: Record<string, string> = {
    "pack.json": JSON.stringify({ format: "hogee.fisco-mirror/2", packId: PACK, createdAt: "2026-10-20T09:00:00.000Z", gitCommit: "abcdef1", sourceBundle: { runId: SOURCE_RUN, files: {} } }),
    "chain.json": JSON.stringify({ chainId: 20200, nodeCount: 5, sealerCount: 4, observerCount: 1 }),
    "steps.json": JSON.stringify({
      format: "hogee.fisco-mirror/2",
      steps: steps.map((s) => ({ seq: s.seq, id: s.id, title: "MOCK: the pack's own words", signerRole: s.role, expected: s.kind === "mined" ? "ok" : "refused", outcome: { kind: s.kind, txHash: txHash(s.seq) } })),
    }),
  };
  for (const s of steps) {
    const hash = txHash(s.seq);
    files[`txs/${hash}.json`] = JSON.stringify({
      hash,
      tx: { hash, input: s.role === "agent" ? SPEND : "0x" },
      receipt: { blockNumber: `0x${s.block.toString(16)}`, status: s.status === 0 ? "0x1" : "0x0" },
      native: { transactionHash: hash, blockNumber: s.block, status: s.status, output: s.output },
    });
  }
  return files;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const NOT_FOUND = { error: { code: "NOT_FOUND", message: "not here" } };

test("a pack that fails its checks never reads as a pass: its three stops are shown for reference only", async ({ page }) => {
  const files = displayPack();
  await page.route(/\/api\/evidence\/fisco(\/.*)?$/, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === "/api/evidence/fisco") return json(route, 200, [{ packId: PACK, createdAt: "2026-10-20T09:00:00.000Z", files: Object.keys(files).sort(), anchored: false }]);
    const file = files[path.slice(`/api/evidence/fisco/${PACK}/files/`.length)];
    return file === undefined ? json(route, 404, NOT_FOUND) : route.fulfill({ status: 200, contentType: "application/json", body: file });
  });
  await page.goto("/evidence");
  expect(await checked(page)).toBe("failed");
  await expectNotVerified(page);
  const stops = page.getByTestId("fisco-stop");
  for (const [i, [step, block, reason]] of [
    ["F1", 29, "Account's status is abnormal · status 22"],
    ["M1", 35, "PermissionDenied · status 18"],
    ["R17", 41, "Paused · status 16"],
  ].entries()) {
    const stop = stops.nth(i);
    await expect(stop).toHaveAttribute("data-step", String(step));
    await expect(stop).toHaveAttribute("data-present", "true");
    await expect(stop).toContainText(`block ${block}`);
    await expect(stop.getByTestId("fisco-stop-reason")).toHaveText(String(reason));
    // Grey under a red verdict: never the refusal tone of a proven stop.
    await expect(stop.locator("[data-slot=pill]")).toHaveAttribute("data-tone", "neutral");
  }
  await expect(page.getByTestId("fisco-stops")).not.toContainText("byte for byte");
  await expect(page.getByTestId("fisco-nodes")).toHaveAttribute("data-ledger", "unchecked");
  await expect(page.locator(SECTION)).not.toContainText("ask the regulator");
  // No sidecar: "not timestamped yet", neutral and outside the count (audit run-12 v-1).
  await expect(page.getByTestId("fisco-anchor")).toHaveAttribute("data-state", "none");
  await expect(page.getByTestId("fisco-anchor")).toContainText("Not timestamped yet");
  await expect(anchorRow(page)).toHaveCount(0);
  // Step titles are Hogee's own, never the pack's text.
  await page.getByTestId("fisco-details").locator(":scope > summary").click();
  await expect(page.getByTestId("fisco-steps")).toContainText("The regulator freezes the agent's account");
  await expect(page.locator(SECTION)).not.toContainText("MOCK:");
  await expectPageHygiene(page, "/evidence (FISCO reference only)");
});

test("an anchor that doesn't check never gets an Etherscan link", async ({ page }) => {
  await page.route(/\/api\/evidence\/fisco$/, async (route) => {
    const res = await route.fetch();
    const packs = (await res.json()) as { anchored: boolean }[];
    return json(route, 200, packs.map((p) => ({ ...p, anchored: true })));
  });
  await page.route(/\/api\/evidence\/fisco\/fm-[0-9a-f]{16}\/anchor$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ format: "hogee.fisco-anchor/1", txHash: `0x${"ab".repeat(32)}` }) }),
  );
  await page.goto("/evidence");
  await checked(page);
  const anchor = page.getByTestId("fisco-anchor");
  await expect(anchor).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("fisco-etherscan")).toHaveCount(0);
  expect(await sectionLinks(page)).toEqual([]);
  // A served sidecar that fails is a counted, failing line.
  await expect(page.getByTestId("fisco-verdict")).toHaveAttribute("data-tone", "failed");
  await expect(anchorRow(page)).toHaveAttribute("data-ok", "false");
});

test("a server without the mirror routes (404) shows a quiet empty state, and the proof pack still checks", async ({ page }) => {
  const seen = watch(page);
  await page.route(/\/api\/evidence\/fisco$/, (route) => json(route, 404, NOT_FOUND));
  await page.goto("/evidence");
  await expect(page.getByTestId("fisco-none")).toBeVisible();
  await expect(page.getByTestId("fisco-none")).toContainText("No mirror to check");
  await expect(page.getByTestId("fisco-error")).toHaveCount(0);
  await expect(page.getByTestId("fisco-mirror")).toHaveCount(0);
  await expect(page.getByTestId("verify-panel")).not.toHaveAttribute("data-tone", "checking", { timeout: 60_000 });
  seen.assertClean();
});
