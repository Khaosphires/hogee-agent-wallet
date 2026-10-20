import { expect, test, type Page, type Route } from "@playwright/test";
import { expectPageHygiene, watch } from "../support/app";

// The replay tests route /api/session through route.fetch: a poll still in flight when a test ends must not fail the run.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** Opens a "Show details" fold when it is closed. */
async function openDetails(page: Page, testId: string) {
  const details = page.getByTestId(testId);
  if ((await details.getAttribute("open")) === null) await details.locator(":scope > summary").click();
}

test("Try an attack leads Proof's first page", async ({ page }) => {
  await page.goto("/evidence");
  const hero = page.getByTestId("red-team");
  await expect(hero).toBeVisible();
  await expect(hero.getByRole("heading", { name: "Try an attack" })).toBeVisible();
  // It comes before the proof pack, right under the tabs.
  await expect(page.locator("#proof-pack")).toBeVisible();
  const order = await page.locator("[data-testid=proof-tabs], [data-testid=red-team], #proof-pack").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? e.id));
  expect(order).toEqual(["proof-tabs", "red-team", "proof-pack"]);
  // Its figure is read from the activity record: attacks to try before any, then how many were stopped.
  await expect(page.getByTestId("attacks-stopped")).toContainText(/Attacks to try|Stopped so far/);
});

/** The mock's reserved run id prefix for its own sample and example (api-mock evidence.ts, web proof-model.ts). */
const SAMPLE_RUN_PREFIX = "sample:";

/** The listed runs' ids, newest exported first, the fixture sample last. */
async function listedRuns(page: Page): Promise<string[]> {
  const res = await page.request.get("/api/evidence/runs");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { runId: string }[]).map((r) => r.runId);
}

test("the evidence explorer lists rows with links behind Show details and verifies offline", async ({ page }) => {
  const seen = watch(page);
  const defaultRun = (await listedRuns(page))[0] ?? "";
  await page.goto("/evidence");
  const rows = page.getByTestId("evidence-row");
  await expect(rows.first()).toBeVisible();
  // Rows are named from templates, never the run's own title.
  await expect(page.getByTestId("evidence-row").filter({ hasText: /MOCK:/ })).toHaveCount(0);
  // Receipts and files sit behind Show details; then every executed or blocked action links to a tx hash, a decision id
  // or a trace (D14).
  await page.getByTestId("evidence-details-toggle").click();
  for (const row of await rows.all()) {
    await expect(row.getByText(/^(decision|trace)\b|0x[0-9a-f]{4}…/).first()).toBeVisible();
  }

  const panel = page.getByTestId("verify-panel");
  await expect(panel).not.toHaveAttribute("data-tone", "checking", { timeout: 60_000 });
  const tone = await panel.getAttribute("data-tone");
  // Audit run-10 v-2: only the mock's own sample may read as one; a recorded (exported) pack checks in full or is red.
  if (defaultRun.startsWith(SAMPLE_RUN_PREFIX)) expect(tone).toBe("sample");
  else expect(tone).toMatch(/^(verified|failed)$/);
  if (tone === "verified") {
    await expect(panel).toContainText("Every check passed");
    await expect(page.getByTestId("verify-recorded")).toHaveText(/^Recorded on \S.* · \d{1,2} \w{3,4}$/);
    await expect(page.getByTestId("verify-count")).toHaveText(/^(\d+) of \1 checks passed$/);
    await expect(page.getByTestId("verify-meaning")).toContainText("Internally consistent");
  } else if (tone === "failed") {
    await expect(panel).toContainText("Not verified");
    await expect(page.getByTestId("verify-count")).toBeVisible();
    await expect(page.getByTestId("verify-practice-note")).toHaveCount(0);
  } else {
    await expect(page.getByTestId("verify-practice-note")).toBeVisible();
    await expect(page.getByTestId("verify-count")).toHaveCount(0);
    await expect(panel).not.toContainText("Not verified");
    // A sample's scripted rows never read as a pass.
    await expect(rows.filter({ hasText: "Pass" })).toHaveCount(0);
  }
  // The checks, the blockchain link and the versions sit behind Show details (a real failure lists its checks in the open).
  await openDetails(page, "verify-details");
  const checks = page.getByTestId("verify-checks");
  await expect(checks).toBeVisible();
  // The verifier lists each check it ran, in plain English.
  await expect(checks.getByRole("listitem").first()).toBeVisible();
  await expect(checks.locator("[data-check='bundle files']")).toContainText("Every file is present and well formed");
  await expect(checks).toHaveAttribute("data-ok", tone === "verified" ? "true" : "false");
  // Proof's shared header: this is the Checks sub-page.
  await expect(page.getByTestId("proof-tabs").getByRole("link", { name: "Checks" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("verify-anchor")).toBeVisible();
  // Mock data never links to a real explorer. The one exception is the FISCO mirror's Sepolia timestamp, which is real
  // public data: linked in every mode, only once the browser's own check of it passed, and only to the pinned
  // Etherscan (REG-BRIEF fisco-proof; evidence-fisco.spec.ts).
  const outside = await page.locator("a[href^='http']").evaluateAll((links) =>
    links.filter((a) => !a.closest("[data-explorer='sepolia-anchor']")).map((a) => (a as HTMLAnchorElement).href),
  );
  expect(outside).toEqual([]);
  for (const href of await page.locator("[data-explorer='sepolia-anchor'] a").evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href))) {
    expect(href.startsWith("https://sepolia.etherscan.io/tx/0x"), href).toBe(true);
  }
  await expectPageHygiene(page, "/evidence");
  seen.assertClean();
});

test("the fixture sample never shows a red Not verified: it says it is a sample", async ({ page }) => {
  const runs = await listedRuns(page);
  const sample = runs.find((id) => id.startsWith(SAMPLE_RUN_PREFIX));
  expect(sample, "the mock always lists its fixture sample").toBeDefined();
  await page.goto("/evidence");
  if (runs.length > 1) {
    await page.getByTestId("pack-select").click();
    // Its option reads "<runId> · <rows> rows · <day>"; no exported pack's id holds the reserved prefix.
    await page.getByRole("option", { name: sample }).click();
  }
  const panel = page.getByTestId("verify-panel");
  await expect(panel).not.toHaveAttribute("data-tone", "checking", { timeout: 60_000 });
  await expect(panel).toHaveAttribute("data-tone", "sample");
  await expect(panel.getByRole("heading", { name: "Sample proof pack" })).toBeVisible();
  await expect(page.getByTestId("verify-practice-note")).toBeVisible();
  await expect(page.getByTestId("verify-count")).toHaveCount(0);
  await expect(panel).not.toContainText("Not verified");
  // A sample's scripted rows never read as a pass.
  const rows = page.getByTestId("evidence-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: "Pass" })).toHaveCount(0);
});

test("on a phone, each test is a small card and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/evidence");
  await expect(page.getByTestId("evidence-card").first()).toBeVisible();
  await expect(page.getByTestId("evidence-row").first()).toBeHidden();
  await expectPageHygiene(page, "/evidence (phone)");
});

test("the explorer works with the network cut off (only localhost answers)", async ({ page, context }) => {
  await context.route(/^https?:\/\/(?!localhost[:/])/, (route) => route.abort("internetdisconnected"));
  await page.goto("/evidence");
  await expect(page.getByTestId("evidence-row").first()).toBeVisible();
  await expect(page.getByTestId("verify-panel")).not.toHaveAttribute("data-tone", "checking", { timeout: 60_000 });
  await openDetails(page, "verify-details");
  await expect(page.getByTestId("verify-checks")).toBeVisible();
});

// A structurally valid bundle (it loads, so the verifier reports its anchor) whose hashes are dummies, so it is "Not
// verified". The API's own answer for the run carries lookalike links that the page must never use.
const SEPOLIA = 11_155_111;
const ANVIL = 31_337;
const RUN = "ev-anchor-test";
const TX = `0x${"7a".repeat(32)}`;
const BLOCK_HASH = `0x${"b1".repeat(32)}`;
const ADDR = { PlanRegistry: `0x${"a1".repeat(20)}`, Treasury: `0x${"b2".repeat(20)}` } as const;
const ETHERSCAN = "https://sepolia.etherscan.io";
const LOOKALIKE = "https://sepolia.etherscan.io.example";

const codePage = (address: string) => `${ETHERSCAN}/address/${address}#code`;

function bundle(chainId: number) {
  const sepolia = chainId === SEPOLIA;
  const contractEntry = (address: string) => ({ address, verifiedUrl: sepolia ? codePage(address) : null, verified: sepolia });
  const manifestEntry = (name: string, address: string) => ({ address, verifiedUrl: sepolia ? codePage(address) : `http://localhost/mock/${name}` });
  const row = {
    taskId: "S1",
    title: "Agent pays the ads pocket within its cap",
    expected: "success",
    layer: "onchain_success",
    outcome: "pass",
    txHash: TX,
    chainId,
    deploymentId: "final-1",
    block: 16,
    contract: "Treasury",
    function: "spend",
    artifacts: [],
  };
  const manifest = {
    runId: RUN,
    gitCommit: "abcdef1",
    deployments: { "final-1": { chainId, contracts: { PlanRegistry: manifestEntry("PlanRegistry", ADDR.PlanRegistry), Treasury: manifestEntry("Treasury", ADDR.Treasury) } } },
    toolVersions: { node: "24" },
  };
  const files: Record<string, unknown> = {
    "manifest.json": manifest,
    "evidence.json": [row],
    "contracts.json": {
      format: "hogee.evidence/1",
      runId: RUN,
      facilityId: "fac-rina",
      exportedAt: "2026-10-18T12:00:00Z",
      deploymentId: "final-1",
      chainId,
      chainTag: sepolia ? "sepolia" : "anvil",
      explorer: sepolia ? ETHERSCAN : null,
      contracts: { PlanRegistry: contractEntry(ADDR.PlanRegistry), Treasury: contractEntry(ADDR.Treasury) },
      excludedEvalTraces: 0,
    },
    "plans.json": [],
    "signatures.json": [],
    "payments.json": [],
    "chain-actions.json": [],
    "rationales.json": [],
    "traces.json": [],
    "llm-calls.json": [],
    "blocks.json": [{ number: "0x10", hash: BLOCK_HASH, parentHash: `0x${"b0".repeat(32)}`, timestamp: "0x6712f000" }],
    [`receipts/${TX}.json`]: {
      transactionHash: TX,
      transactionIndex: "0x0",
      blockHash: BLOCK_HASH,
      blockNumber: "0x10",
      from: `0x${"22".repeat(20)}`,
      to: ADDR.Treasury,
      status: "0x1",
      logs: [],
      logsBloom: `0x${"0".repeat(512)}`,
      gasUsed: "0x5208",
      cumulativeGasUsed: "0x5208",
    },
  };
  files["hashes.json"] = { algorithm: "keccak256", files: Object.fromEntries([...Object.keys(files), "SUMMARY.md"].map((path) => [path, `0x${"00".repeat(32)}`])) };
  files["SUMMARY.md"] = "# Evidence bundle (test)\n";
  // What GET /api/evidence/:runId answers: the same rows and manifest, but with links pointing elsewhere.
  const tampered = {
    manifest: { ...manifest, deployments: { "final-1": { chainId, contracts: { Treasury: { address: ADDR.Treasury, verifiedUrl: `${LOOKALIKE}/address/${ADDR.Treasury}#code` } } } } },
    rows: [{ ...row, explorerUrl: `${LOOKALIKE}/tx/${TX}` }],
    files: Object.keys(files).sort(),
  };
  return { files, tampered };
}

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Serves the test bundle as the only evidence run: in replay, with the session as replay on `chainId`; else as is (mock). */
async function serveBundle(page: Page, chainId: number, replay: boolean): Promise<void> {
  const { files, tampered } = bundle(chainId);
  if (replay) {
    await page.route("**/api/session", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      return json(route, { ...((await res.json()) as object), mode: "replay", chainId, deploymentId: "final-1" });
    });
  }
  await page.route(/\/api\/evidence\//, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === "/api/evidence/runs") return json(route, [{ runId: RUN, createdAt: "2026-10-18T12:00:00Z", gitCommit: "abcdef1", rowCount: 1 }]);
    if (path === `/api/evidence/${RUN}`) return json(route, tampered);
    const file = path.slice(`/api/evidence/${RUN}/files/`.length);
    const body = files[file];
    if (body === undefined) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "no file" } }) });
    return route.fulfill({ status: 200, contentType: file.endsWith(".md") ? "text/markdown" : "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });
  });
}

const serveReplayBundle = (page: Page, chainId: number): Promise<void> => serveBundle(page, chainId, true);

const externalLinks = (page: Page) => page.locator("a[href^='http']").evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href));

test("a Sepolia bundle's anchor links only to its own pages on the pinned Etherscan", async ({ page }) => {
  const seen = watch(page);
  await serveReplayBundle(page, SEPOLIA);
  await page.goto("/evidence");
  const panel = page.getByTestId("verify-panel");
  await expect(panel).toContainText("Not verified");
  // A real failure is red, with its count and its checks in the open.
  await expect(panel).toHaveAttribute("data-tone", "failed");
  await expect(page.getByTestId("verify-count")).toBeVisible();
  await expect(page.getByTestId("verify-checks").locator("[data-check='file hashes']")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("verify-checks").locator("[data-check='file hashes']")).toBeVisible();
  // Only practice data gets the "sample pack from another run" note: a replayed failure is never explained away.
  await expect(page.getByTestId("verify-practice-note")).toHaveCount(0);

  const anchor = page.getByTestId("verify-anchor");
  await expect(anchor).toHaveAttribute("data-state", "explorer");
  await expect(anchor).toContainText("Sepolia · 11155111");
  await expect(anchor).toContainText("Shown for reference only");
  await expect(anchor.locator(`a[href="${codePage(ADDR.Treasury)}"]`)).toBeVisible();
  await expect(anchor.locator(`a[href="${codePage(ADDR.PlanRegistry)}"]`)).toBeVisible();
  await expect(page.getByTestId("anchor-head").locator(`a[href="${ETHERSCAN}/block/16"]`)).toBeVisible();
  await expect(page.getByTestId("anchor-head")).toContainText(BLOCK_HASH);
  await page.getByTestId("anchor-txs").getByText("1 transaction with a receipt").click();
  await expect(page.getByTestId("anchor-txs").locator(`a[href="${ETHERSCAN}/tx/${TX}"]`)).toBeVisible();

  // The row's and the manifest's own links are ignored: both are rebuilt from the pinned explorer.
  await page.getByTestId("evidence-details-toggle").click();
  await expect(page.getByTestId("evidence-row").first().locator(`a[href="${ETHERSCAN}/tx/${TX}"]`)).toBeVisible();
  const links = await externalLinks(page);
  expect(links.length).toBeGreaterThan(0);
  for (const href of links) expect(href.startsWith(`${ETHERSCAN}/`), href).toBe(true);
  expect(links.filter((href) => href.includes("etherscan.io.example"))).toEqual([]);
  await expectPageHygiene(page, "/evidence (Sepolia replay)");
  seen.assertClean();
});

// Audit run-10 v-2: an exported pack that fails its check (changed bytes, a hand-edited row) was a grey "Sample proof
// pack" in practice mode, with no count and its rows relabelled "Sample". Only the mock's own sample may read so.
test("in practice mode too, a recorded pack that fails its check is a red Not verified with its count", async ({ page }) => {
  await serveBundle(page, SEPOLIA, false);
  await page.goto("/evidence");
  const panel = page.getByTestId("verify-panel");
  await expect(panel).not.toHaveAttribute("data-tone", "checking", { timeout: 60_000 });
  await expect(panel).toHaveAttribute("data-tone", "failed");
  await expect(panel.getByRole("heading", { name: "Not verified" })).toBeVisible();
  await expect(page.getByTestId("verify-count")).toBeVisible();
  await expect(page.getByTestId("verify-practice-note")).toHaveCount(0);
  await expect(page.getByTestId("verify-checks").locator("[data-check='file hashes']")).toHaveAttribute("data-ok", "false");
  // Its rows read Pass or Fail as the pack records them, never "Sample".
  const rows = page.getByTestId("evidence-row");
  await expect(rows.first()).toContainText("Pass");
  await expect(rows.filter({ hasText: "Sample" })).toHaveCount(0);
});

test("an Anvil bundle's anchor is shown without any explorer link", async ({ page }) => {
  await serveReplayBundle(page, ANVIL);
  await page.goto("/evidence");
  const anchor = page.getByTestId("verify-anchor");
  await expect(anchor).toHaveAttribute("data-state", "local");
  await expect(anchor).toContainText("No public explorer for this chain");
  await expect(anchor).toContainText("Anvil (local) · 31337");
  await expect(anchor).toContainText(ADDR.Treasury.slice(0, 8));
  await expect(page.getByTestId("evidence-row").first()).toBeVisible();
  expect(await externalLinks(page)).toEqual([]);
});
