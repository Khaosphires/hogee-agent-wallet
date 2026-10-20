/**
 * Error text the runner writes into a bundle is redacted (an RPC error carries the provider URL, which can hold its
 * key; stack lines carry local paths), and the secret scan looks for every loaded URL. The URLs below are fakes with
 * a DO-NOT-PRINT marker; no real provider is involved.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRequestError, RpcRequestError } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import type { Deployment } from "../src/api-internals";
import type { CaseDef } from "../src/cases/context";
import { REPO_ROOT } from "../src/config";
import { Bundle } from "../src/evidence";
import { errorReason, errorRecord, redactErrorText } from "../src/redact";
import { runCase } from "../src/run";
import { scanForSecrets, secretsOf, urlSecrets } from "../src/safety";
import type { Stack } from "../src/stack";

const MARK = "DO-NOT-PRINT-THIS-KEY";
const PRIMARY = `https://rpc.example.invalid/v2/${MARK}`;
const FALLBACK = `https://rpc2.example.invalid/rpc?apikey=${MARK}-2`;
const DB_URL = `postgres://hogee:${MARK}-pw@127.0.0.1:55511/hogee`;
const XENDIT = `xnd_development_${MARK}-xendit`;

const deployment = { chainId: 11155111, deploymentId: "final-test", chainTag: "sepolia", contracts: {} } as unknown as Deployment;

/** Just what runCase and secretsOf read. */
function stubStack(): Stack {
  return {
    label: "main",
    infra: { cfg: { target: "sepolia", rpcUrls: [PRIMARY, FALLBACK], databaseUrl: DB_URL } },
    deployment,
    childKeyEnv: { AGENT_PRIVATE_KEY_FINAL: `0x${"ab".repeat(32)}` },
    flags: { demoMode: true, cookieSecret: "c".repeat(43), officerToken: "o".repeat(43), stripeWebhookSecret: "w".repeat(43) },
    agent: { memoryKey: new Uint8Array(32).fill(7) },
    loadedSecrets: [XENDIT],
    generatedSecrets: [],
  } as unknown as Stack;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

const rpcFailure = () => new HttpRequestError({ url: PRIMARY, status: 429, body: { method: "eth_getBlockByNumber", params: ["finalized", false] } });

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("runCase error text", () => {
  it("a thrown viem HttpRequestError reaches errors/<id>.json and report.json redacted; the scan finds nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "rt-redact-"));
    const b = new Bundle(dir, { chainId: deployment.chainId, target: "sepolia" });
    const failing: CaseDef = {
      id: "T29",
      title: "a case whose RPC read fails",
      layers: "offchain",
      async run() {
        // the shape a failed getBlock poll takes: an RpcRequestError-style wrapper around the HTTP error
        throw new RpcRequestError({ body: { method: "eth_getBlockByNumber" }, error: { code: -32005, message: `limit exceeded for ${PRIMARY}` }, url: PRIMARY });
      },
    };
    const plain: CaseDef = { id: "T10", title: "a case that throws the HTTP error itself", layers: "offchain", run: async () => Promise.reject(rpcFailure()) };
    const lines: string[] = [];
    await runCase(stubStack(), b, {}, failing, (l) => lines.push(l));
    await runCase(stubStack(), b, {}, plain, (l) => lines.push(l));
    b.finish({ runId: "rt-test" });

    const files = allFiles(dir);
    expect(files.map((f) => f.slice(dir.length + 1)).sort()).toEqual(["errors/T10.json", "errors/T29.json", "evidence.json", "report.json"]);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain("DO-NOT-PRINT");
      expect(text).not.toContain("rpc.example.invalid");
      expect(text).not.toContain(REPO_ROOT);
      expect(text).not.toContain(homedir());
    }
    for (const line of lines) expect(line).not.toContain("DO-NOT-PRINT");

    const rec = JSON.parse(readFileSync(join(dir, "errors/T10.json"), "utf8")) as { message: string; stack: string[] };
    expect(rec.message).toMatch(/^HttpRequestError: HTTP request failed\./);
    expect(rec.message).toContain("URL: <url>");
    expect(rec.stack.length).toBeGreaterThan(0);
    expect(rec.stack.every((l) => l.startsWith("at "))).toBe(true);
    expect(rec.stack.some((l) => l.includes("scripts/redteam/test/redact.test.ts"))).toBe(true);

    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { cases: { taskId: string; status: string; reason?: string }[] };
    expect(report.cases.find((c) => c.taskId === "T10")).toMatchObject({ status: "fail", reason: "HttpRequestError: HTTP request failed." });
    expect(report.cases.find((c) => c.taskId === "T29")?.reason).toMatch(/^RpcRequestError: /);

    expect(scanForSecrets(dir, secretsOf(stubStack()))).toEqual([]);
  });

  it("cuts local paths before redacting (a path is not read as a URL) and keeps the cause chain", () => {
    const error = new Error(`ENOENT: no such file or directory, open '${join(REPO_ROOT, "packages/chain/deployments/x.json")}'`, { cause: rpcFailure() });
    const rec = errorRecord(error);
    expect(rec.message).toBe("Error: ENOENT: no such file or directory, open 'packages/chain/deployments/x.json'");
    expect(rec.causes).toEqual(["HttpRequestError: HTTP request failed."]);
    expect(errorReason(error)).toBe("Error: ENOENT: no such file or directory, open 'packages/chain/deployments/x.json'");
    expect(redactErrorText(`at f (file://${REPO_ROOT}/scripts/redteam/src/run.ts:52:13)`)).toBe("at f (scripts/redteam/src/run.ts:52:13)");
    expect(redactErrorText("at g (/Users/someone/elsewhere/a.ts:1:1) and /home/ci/b.ts")).toBe("at g (~/elsewhere/a.ts:1:1) and ~/b.ts");
  });

  it("the plug child's stderr line and crash text are redacted", () => {
    const line = `plug-child failed: ${errorReason(rpcFailure(), 500)}`;
    expect(line).toBe("plug-child failed: HttpRequestError: HTTP request failed.");
    const stderr = `node:internal/x\n${rpcFailure().message}\n    at main (${REPO_ROOT}/scripts/redteam/src/plug-child.ts:30:9)`;
    const clean = redactErrorText(stderr);
    expect(clean).not.toContain("DO-NOT-PRINT");
    expect(clean).toContain("at main (scripts/redteam/src/plug-child.ts:30:9)");
  });
});

describe("the secret scan and loaded URLs", () => {
  it("lists each URL, its path+query when 16 characters or longer, the database password and the Xendit key", () => {
    const list = secretsOf(stubStack());
    expect(list).toEqual(expect.arrayContaining([PRIMARY, `/v2/${MARK}`, FALLBACK, `/rpc?apikey=${MARK}-2`, DB_URL, `${MARK}-pw`, XENDIT]));
    // a local Anvil URL has no path worth scanning for ("/"), only the URL itself
    expect(urlSecrets(["http://127.0.0.1:8591", "postgres://hogee@127.0.0.1:55511/hogee"])).toEqual(["http://127.0.0.1:8591", "postgres://hogee@127.0.0.1:55511/hogee"]);
  });

  it("flags a bundle file that holds a raw RPC URL, its key-bearing path, the database password or the Xendit key", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-scan-url-"));
    const b = new Bundle(dir, { chainId: deployment.chainId, target: "sepolia" });
    mkdirSync(join(dir, "artifacts", "T5"), { recursive: true });
    b.write("artifacts/T1/raw.json", { error: `HTTP request failed.\nURL: ${PRIMARY}` });
    writeFileSync(join(dir, "artifacts", "T5", "schemeless.txt"), `rpc.example.invalid/v2/${MARK}`);
    b.write("artifacts/T6/db.json", { error: `password authentication failed (${MARK}-pw)` });
    b.write("artifacts/T7/rail.json", { key: XENDIT });
    b.write("artifacts/T8/clean.json", { explorerUrl: "https://sepolia.etherscan.io/tx/0x00", error: "HTTP request failed.\nURL: <url>" });
    expect(scanForSecrets(dir, secretsOf(stubStack())).sort()).toEqual(
      [join("artifacts", "T1", "raw.json"), join("artifacts", "T5", "schemeless.txt"), join("artifacts", "T6", "db.json"), join("artifacts", "T7", "rail.json")].sort(),
    );
  });
});
