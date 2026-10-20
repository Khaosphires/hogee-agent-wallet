/**
 * scripts/fisco/anchor.sh reads the keystore password and the [y/N] answer from the controlling terminal only
 * (post-fix re-check of run-12): a pipe, a here-doc or `yes |` can neither give the password nor approve the send.
 * Without a controlling terminal (a new session, as a detached child is) and without the test-only
 * HOGEE_ANCHOR_KEYSTORE, it refuses before it reads anything or asks any RPC.
 * HOME is a throwaway folder (no Foundry, no keystore): the hogee-deployer keystore is never looked at, and the RPC is a
 * closed loopback port, so nothing leaves this machine whatever the script does.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fisco/anchor.sh");
const NODE_DIR = dirname(process.execPath);
let root: string;

/** anchor.sh in a new session (no controlling terminal), stdin a pipe carrying a password and a "y". */
function detached(env: Record<string, string> = {}): Promise<{ status: number | null; out: string }> {
  return new Promise((done) => {
    const pack = join(root, "fisco", "fm-0123456789abcdef");
    const child = spawn("/bin/bash", [SCRIPT, "--pack", pack, "--rpc", "http://127.0.0.1:9"], {
      env: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: root, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stdin.on("error", () => undefined);
    child.stdin.end("piped-password\ny\ny\n");
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, out });
    });
  });
}

describe("anchor.sh: the password and the answer come from /dev/tty", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "anchor-tty-"));
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "fisco", "fm-0123456789abcdef"), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("refuses to run without a controlling terminal, before reading stdin or asking the RPC", async () => {
    const { status, out } = await detached();
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL: no controlling terminal: the keystore password and the \[y\/N\] answer are read from \/dev\/tty only\. Nothing sent\./);
    expect(out).not.toMatch(/missing tool|keystore file|chain-id|Keystore password|Publish to Sepolia/);
  });

  it("with the test-only HOGEE_ANCHOR_KEYSTORE, stdin is allowed (the live test drives it that way)", async () => {
    const { status, out } = await detached({ HOGEE_ANCHOR_KEYSTORE: join(root, "no-such-keystore") });
    expect(status).not.toBe(0);
    expect(out).not.toMatch(/controlling terminal/);
  });
});
