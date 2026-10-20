/**
 * scripts/fisco/anchor.sh end to end on a LOCAL Anvil started with `--chain-id 11155111` (TEST_ANCHOR_RPC, an
 * http://127.0.0.1:<port> URL; skipped without it), with a throwaway keystore created here in a temp folder
 * (HOGEE_ANCHOR_KEYSTORE; the hogee-deployer keystore is never read) and funded with anvil_setBalance:
 *   - the script signs with `cast mktx`, decodes, asks, publishes and captures; the sidecar it writes passes
 *     checkSepoliaAnchor (with the test signer) and the online confirmation against the same Anvil;
 *   - one changed byte in the sidecar or in the pack fails the check; the default signer (the hogee-deployer) fails it;
 *   - a second run refuses (already anchored) and an "n" answer sends nothing (the nonce does not move);
 *   - audit run-12 v-2: the script sets the nonce, gas limit and both fee caps itself (EIP-1559, gas <= 60,000, max fee
 *     <= 50 gwei, max priority fee 1 gwei) and names them, with the most it can cost, in the [y/N] question; a "y"
 *     typed ahead is thrown away; a base fee over 20 gwei or a pending tx stops it; cast's stderr never shows the RPC
 *     URL; a broken foundry.toml above the temp folder is never read.
 *   - post-fix re-check: without HOGEE_ANCHOR_KEYSTORE the password (and the answer) are read from /dev/tty, never
 *     stdin: under a pseudo-terminal (/usr/bin/script) with stdin /dev/null, the password typed on the terminal opens
 *     the keystore (a throwaway one at a temp HOME's hogee-deployer path, so the signer check then refuses it).
 * The answer is written only once the question is printed (the script drains what came before it).
 *   PATH=$HOME/.foundry/bin:$PATH anvil --port 8648 --chain-id 11155111 --silent &
 *   TEST_ANCHOR_RPC=http://127.0.0.1:8648 pnpm --filter @hogee/redteam exec vitest run test/fisco/anchor-sh.live.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTransaction, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSepoliaAnchor } from "../../../../tools/verify-evidence/src/fisco/anchor";
import { confirmSepoliaAnchor } from "../../../../tools/verify-evidence/src/fisco/anchor-online";
import { anchorPack, type AnchorPack } from "../../../../tools/verify-evidence/test/fisco/anchor-fixture";

const RPC = process.env.TEST_ANCHOR_RPC ?? "";
const LIVE = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(RPC);
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fisco/anchor.sh");
const CAST = join(homedir(), ".foundry/bin/cast");
const NODE_DIR = dirname(process.execPath);

let a: AnchorPack;
let root: string;
let keystore: string;
let password: string;
let signer: string;
const roots: string[] = [];

const cast = (args: readonly string[], env: Record<string, string> = {}): string =>
  execFileSync(CAST, args, { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: homedir(), ...env }, encoding: "utf8" }).trim();
const nonce = (): string => cast(["nonce", signer, "--rpc-url", RPC]);
const rpc = (method: string, ...params: string[]): string => cast(["rpc", method, ...params, "--rpc-url", RPC]);
/** The next block's base fee, then one block mined so `cast base-fee` (latest) reports it. */
const setBaseFee = (wei: bigint): void => {
  rpc("anvil_setNextBlockBaseFeePerGas", `0x${wei.toString(16)}`);
  rpc("evm_mine");
};
const GWEI = 1_000_000_000n;
const QUESTION = "[y/N] ";

/** <base>/fisco/<packId>/ with the fixture pack; returns the pack folder. */
function writePack(base: string): string {
  const dir = join(base, "fisco", a.packId);
  for (const [path, body] of Object.entries(a.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

interface RunOptions {
  /** Written once the [y/N] question is printed; null closes stdin there instead (no answer). */
  readonly answer?: string | null;
  /** Written with the password, before the question (typed ahead). */
  readonly ahead?: string;
  readonly password?: string;
  readonly rpc?: string;
  readonly tmp?: string;
}

/** Runs anchor.sh: the password at once (plus `ahead`), the answer only after the question appears. */
function anchorSh(dir: string, o: RunOptions = {}): Promise<{ status: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn("/bin/bash", [SCRIPT, "--pack", dir, "--rpc", o.rpc ?? RPC], {
      env: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: homedir(), TMPDIR: o.tmp ?? root, HOGEE_ANCHOR_KEYSTORE: keystore },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let asked = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    const seen = (chunk: Buffer): void => {
      out += chunk.toString("utf8");
      if (asked || !out.includes(QUESTION)) return;
      asked = true;
      const answer = o.answer === undefined ? "y\n" : o.answer;
      if (answer === null) child.stdin.end();
      else child.stdin.end(answer);
    };
    child.stdout.on("data", seen);
    child.stderr.on("data", seen);
    child.stdin.on("error", () => undefined);
    child.stdin.write(`${o.password ?? password}\n${o.ahead ?? ""}`);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, out });
    });
  });
}

describe.skipIf(!LIVE)("anchor.sh on a local Anvil (chain id 11155111)", { timeout: 300_000 }, () => {
  beforeAll(async () => {
    a = await anchorPack();
    root = mkdtempSync(join(tmpdir(), "anchor-sh-"));
    roots.push(root);
    password = randomBytes(16).toString("hex");
    mkdirSync(join(root, "ks"), { mode: 0o700 });
    cast(["wallet", "new", join(root, "ks"), "throwaway"], { CAST_PASSWORD: password });
    keystore = join(root, "ks", "throwaway");
    writeFileSync(join(root, "pw"), password, { mode: 0o600 });
    signer = cast(["wallet", "address", "--keystore", keystore, "--password-file", join(root, "pw")]).toLowerCase();
    expect(cast(["chain-id", "--rpc-url", RPC])).toBe("11155111");
    cast(["rpc", "anvil_setBalance", signer, "0xde0b6b3a7640000", "--rpc-url", RPC]);
  }, 120_000);
  afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("anchors the pack: the sidecar passes offline and online; one changed byte fails it", async () => {
    const dir = writePack(join(root, "run-1"));
    const before = nonce();
    const { status, out } = await anchorSh(dir);
    expect(out).toContain(`Etherscan → View input as UTF-8 shows: ${a.text}`);
    expect(out).toContain(`TEST KEYSTORE (HOGEE_ANCHOR_KEYSTORE): signer ${signer}`);
    expect(out).toMatch(/Signed tx \(type 0x2,/);
    expect(out).not.toContain(password);
    expect(out).not.toContain(RPC.slice("http://".length));
    expect(status).toBe(0);
    expect(Number(nonce())).toBe(Number(before) + 1);

    // The fee fields are the script's, not the RPC's, and the question names them with the most it can cost.
    const bytes = Buffer.byteLength(a.text, "ascii");
    const gasLimit = 21_000 + 40 * bytes + 2_000;
    const asked = /Publish to Sepolia now\? nonce (\d+), gas limit (\d+), max fee ([\d.]+) gwei, max priority fee 1 gwei, at most ([\d.]+) ETH \[y\/N\]/.exec(out);
    expect(asked?.slice(1, 3)).toEqual([before, String(gasLimit)]);
    const path = join(realpathSync(root), "run-1", "fisco", "anchors", `${a.packId}.sepolia.json`);
    expect(out).toContain(`sidecar: ${path}`);
    const sidecar = readFileSync(path, "utf8");
    const tx = parseTransaction(JSON.parse(sidecar).rawSignedTx as Hex);
    expect(tx).toMatchObject({ type: "eip1559", nonce: Number(before), gas: BigInt(gasLimit), maxPriorityFeePerGas: GWEI });
    expect(tx.maxFeePerGas).toBeLessThanOrEqual(50n * GWEI);
    expect(tx.maxFeePerGas).toBeGreaterThanOrEqual(GWEI);
    expect(Number(asked?.[3])).toBe(Number(tx.maxFeePerGas) / 1e9);
    expect(asked?.[4]).toBe(String(Number(BigInt(gasLimit) * (tx.maxFeePerGas as bigint)) / 1e18));
    expect(BigInt(JSON.parse(sidecar).receipt.gasUsed)).toBe(BigInt(21_000 + 40 * bytes));
    const ok = checkSepoliaAnchor(a.files, sidecar, { signer });
    expect(ok).toMatchObject({ ok: true, anchored: true, anchor: { signer, txType: "eip1559", text: a.text } });
    expect(await confirmSepoliaAnchor(sidecar, RPC)).toMatchObject({ ok: true });

    expect(checkSepoliaAnchor(a.files, sidecar).ok).toBe(false);
    const s = JSON.parse(sidecar) as { rawSignedTx: string; receipt: { gasUsed: string } };
    const lastHex = s.rawSignedTx.at(-1) === "0" ? "1" : "0";
    const flipped = sidecar.replace(s.rawSignedTx, `${s.rawSignedTx.slice(0, -1)}${lastHex}`);
    expect(checkSepoliaAnchor(a.files, flipped, { signer }).ok).toBe(false);
    const gas = sidecar.replace(`"gasUsed": "${s.receipt.gasUsed}"`, `"gasUsed": "${s.receipt.gasUsed}0"`);
    expect(checkSepoliaAnchor(a.files, gas, { signer }).ok).toBe(true);
    expect((await confirmSepoliaAnchor(gas, RPC)).ok).toBe(false);
    const pack = { ...a.files, "chain.json": (a.files["chain.json"] as string).replace(/"headAtEnd": (\d)/, (_m, d: string) => `"headAtEnd": ${(Number(d) + 1) % 10}`) };
    expect(checkSepoliaAnchor(pack, sidecar, { signer }).ok).toBe(false);

    const again = await anchorSh(dir);
    expect(again.status).not.toBe(0);
    expect(again.out).toMatch(/already anchored/);
    expect(nonce()).toBe(String(Number(before) + 1));
  });

  it("sends nothing on any answer but y", async () => {
    const dir = writePack(join(root, "run-2"));
    const before = nonce();
    const { status, out } = await anchorSh(dir, { answer: "n\n" });
    expect(status).toBe(1);
    expect(out).toContain("Not sent.");
    expect(nonce()).toBe(before);
  });

  it("throws away a y typed ahead of the question: no answer after it sends nothing (audit run-12 v-2)", async () => {
    const dir = writePack(join(root, "run-ahead"));
    const before = nonce();
    const { status, out } = await anchorSh(dir, { ahead: "y\ny\n", answer: null });
    expect(out).toContain(QUESTION);
    expect(out).toContain("Not sent.");
    expect(status).toBe(1);
    expect(nonce()).toBe(before);
  });

  it("refuses a base fee over 20 gwei before signing (audit run-12 v-2)", async () => {
    const dir = writePack(join(root, "run-fee"));
    const before = nonce();
    setBaseFee(20n * GWEI + 1n);
    try {
      const { status, out } = await anchorSh(dir);
      expect(out).toMatch(/the base fee is 20\.000000001 gwei, over 20 gwei/);
      expect(out).not.toContain(QUESTION);
      expect(status).not.toBe(0);
      expect(nonce()).toBe(before);
    } finally {
      setBaseFee(GWEI);
    }
  });

  it("refuses to sign while the signer has a pending tx (the nonce read would replace or queue behind it)", async () => {
    const dir = writePack(join(root, "run-pending"));
    rpc("evm_setAutomine", "false");
    try {
      cast(["send", "--async", "--keystore", keystore, "--password-file", join(root, "pw"), "--rpc-url", RPC, signer, "0x"]);
      const { status, out } = await anchorSh(dir);
      expect(out).toMatch(/the signer has a pending tx/);
      expect(out).not.toContain(QUESTION);
      expect(status).not.toBe(0);
    } finally {
      rpc("evm_setAutomine", "true");
      rpc("evm_mine");
    }
  });

  it("never prints the RPC URL from cast's stderr (audit run-12 v-2)", async () => {
    const dir = writePack(join(root, "run-url"));
    const { status, out } = await anchorSh(dir, { rpc: "http://127.0.0.1:9/s3cr3t-key" });
    expect(status).not.toBe(0);
    expect(out).toMatch(/cast chain-id failed/);
    expect(out).toMatch(/<url>|<rpc>/);
    expect(out).not.toContain("127.0.0.1:9");
    expect(out).not.toContain("s3cr3t");
  });

  it("does not read a foundry.toml above its temp folder (audit run-12 v-2)", async () => {
    const dir = writePack(join(root, "run-toml"));
    const tmp = join(root, "tmp-with-toml");
    mkdirSync(tmp);
    writeFileSync(join(tmp, "foundry.toml"), "this is [ not toml\n");
    const before = nonce();
    const { status, out } = await anchorSh(dir, { tmp, answer: "n\n" });
    expect(out).toContain(QUESTION);
    expect(out).toContain("Not sent.");
    expect(status).toBe(1);
    expect(nonce()).toBe(before);
  });

  it("without the test override, reads the password from the terminal, not stdin (post-fix re-check)", async () => {
    const dir = writePack(join(root, "run-tty"));
    const home = join(root, "tty-home");
    mkdirSync(join(home, ".foundry", "keystores"), { recursive: true, mode: 0o700 });
    symlinkSync(join(homedir(), ".foundry", "bin"), join(home, ".foundry", "bin"));
    copyFileSync(keystore, join(home, ".foundry", "keystores", "hogee-deployer"));
    const before = nonce();
    const { status, out } = await new Promise<{ status: number | null; out: string }>((done) => {
      // script(1) gives the run a pseudo-terminal; anchor.sh's own stdin is /dev/null, so only /dev/tty has the password.
      // (cat: script must read a pipe; on node's stdio socket its tcgetattr fails.)
      const pty = `/bin/cat | /usr/bin/script -q /dev/null /bin/bash -c 'exec /bin/bash "$0" "$@" </dev/null' "$@"`;
      const child = spawn("/bin/bash", ["-c", pty, "pty", SCRIPT, "--pack", dir, "--rpc", RPC], {
        env: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: home, TMPDIR: root },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let text = "";
      let typed = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
      const seen = (chunk: Buffer): void => {
        text += chunk.toString("utf8");
        if (typed) return;
        // A run that stops before asking (FAIL) must not wait on the pipe until the timeout.
        if (text.includes("FAIL: ")) child.stdin.end();
        if (!text.includes("Keystore password for hogee-deployer (hidden): ")) return;
        typed = true;
        child.stdin.end(`${password}\n`);
      };
      child.stdout.on("data", seen);
      child.stderr.on("data", seen);
      child.stdin.on("error", () => undefined);
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ status: code, out: text });
      });
    });
    expect(out).not.toMatch(/no password given|no controlling terminal/);
    expect(out).toContain(`the hogee-deployer keystore is ${signer}, not 0x46405e378F5AC837b8E18a96105e3ff3CCB22251. Nothing sent.`);
    expect(out).not.toContain(password);
    expect(out).not.toContain(QUESTION);
    expect(status).not.toBe(0);
    expect(nonce()).toBe(before);
  });

  it("refuses a wrong password before signing anything", async () => {
    const dir = writePack(join(root, "run-3"));
    const before = nonce();
    const { status } = await anchorSh(dir, { password: "wrong-password" });
    expect(status).not.toBe(0);
    expect(nonce()).toBe(before);
  });
});
