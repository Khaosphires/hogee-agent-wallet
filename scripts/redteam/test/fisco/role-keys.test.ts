import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { main, parseArgs, senderRoles } from "../../src/fisco/cli";
import { privateKeyToAccount } from "viem/accounts";
import { MAX_KEYS_BYTES, parseRoleKeys, readRoleKeysFd, refuseKeysInEnv, ROLE_KEY_NAMES, RoleKeysError } from "../../src/fisco/role-keys";
import { httpFixture, methodOf, rpcAnswer, type HttpFixture } from "./http-fixture";

const REDTEAM = join(dirname(fileURLToPath(import.meta.url)), "../..");
const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const keys = (): Record<string, string> => Object.fromEntries(ROLE_KEY_NAMES.map((n) => [n, generatePrivateKey()]));
const lines = (k: Record<string, string>): string => Object.entries(k).map(([n, v]) => `${n}=${v}\n`).join("");
const REQUIRED = ["--rpc", "http://127.0.0.1:8545", "--deployment", "d.json", "--broadcast", "b.json", "--genesis", "config.genesis", "--sepolia-code", "code-sepolia", "--native-tls", "facts/sdk", "--ledger-rpc", "http://127.0.0.1:8546"];

/** An open read fd on a temp file holding `text` (a stand-in for the pipe replay.sh hands over). */
function fdOf(text: string | Buffer): number {
  const dir = mkdtempSync(join(tmpdir(), "fisco-keys-"));
  temps.push(dir);
  const p = join(dir, "k");
  writeFileSync(p, text, { mode: 0o600 });
  return openSync(p, "r");
}

const isClosed = (fd: number): boolean => {
  try {
    fstatSync(fd);
    return false;
  } catch {
    return true;
  }
};

describe("parseRoleKeys (run-11 C2: keys on an fd, never in argv or the environment)", () => {
  it("parses exactly the four FINAL names and the regulator's FISCO key, in any order", () => {
    const k = keys();
    const reversed = Object.fromEntries(Object.entries(k).reverse());
    expect(parseRoleKeys(lines(k))).toEqual(k);
    expect(parseRoleKeys(lines(reversed))).toEqual(k);
    expect(ROLE_KEY_NAMES).toHaveLength(5);
    expect(ROLE_KEY_NAMES).toContain("REGULATOR_PRIVATE_KEY_FISCO");
  });

  const bad: [string, (k: Record<string, string>) => string][] = [
    ["a missing name", (k) => lines(k).split("\n").slice(1).join("\n")],
    ["a missing regulator line (the four FINAL keys only)", (k) => lines(k).split("\n").filter((l) => !l.startsWith("REGULATOR_PRIVATE_KEY_FISCO=")).join("\n")],
    ["the regulator's key under another name", (k) => lines(k).replace("REGULATOR_PRIVATE_KEY_FISCO", "REGULATOR_PRIVATE_KEY_FINAL")],
    ["an extra name", (k) => `${lines(k)}AGENT_PRIVATE_KEY_LOOP=${generatePrivateKey()}\n`],
    ["an unknown name in place of one", (k) => lines(k).replace("ORACLE_PRIVATE_KEY_FINAL", "ORACLE_PRIVATE_KEY_FINALX")],
    ["a duplicate name", (k) => lines(k).replace("ORACLE_PRIVATE_KEY_FINAL", "AGENT_PRIVATE_KEY_FINAL")],
    ["upper-case hex", (k) => lines(k).replace(/=0x([0-9a-f]{64})/, (_m, h: string) => `=0x${h.toUpperCase()}`)],
    ["a key without 0x", (k) => lines(k).replace("=0x", "=")],
    ["a short key", (k) => lines(k).replace(/=0x([0-9a-f]{64})/, (_m, h: string) => `=0x${h.slice(2)}`)],
    ["a quoted key", (k) => lines(k).replace(/=(0x[0-9a-f]{64})/, '="$1"')],
    ["a space before =", (k) => lines(k).replace("AGENT_PRIVATE_KEY_FINAL=", "AGENT_PRIVATE_KEY_FINAL =")],
    ["CRLF line ends", (k) => lines(k).replace(/\n/g, "\r\n")],
    ["a blank line", (k) => `\n${lines(k)}`],
    ["no newline after the last line", (k) => lines(k).slice(0, -1)],
    ["an empty hand-off", () => ""],
  ];
  it.each(bad)("refuses %s, without echoing any key", (_label, make) => {
    const k = keys();
    let error: unknown;
    try {
      parseRoleKeys(make(k));
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(RoleKeysError);
    const message = String((error as Error).message).toLowerCase();
    for (const v of Object.values(k)) expect(message).not.toContain(v.slice(2, 18));
  });
});

describe("readRoleKeysFd", () => {
  it("reads the fd to EOF, parses it and closes it", () => {
    const k = keys();
    const fd = fdOf(lines(k));
    expect(readRoleKeysFd(fd)).toEqual(k);
    expect(isClosed(fd)).toBe(true);
  });

  it(`refuses more than ${MAX_KEYS_BYTES} bytes and still closes the fd`, () => {
    const k = keys();
    const fd = fdOf(`${lines(k)}${"#".repeat(MAX_KEYS_BYTES)}\n`);
    expect(() => readRoleKeysFd(fd)).toThrow(/4096 bytes/);
    expect(isClosed(fd)).toBe(true);
  });

  it("refuses stdin/stdout/stderr and a descriptor that is not open", () => {
    for (const fd of [0, 1, 2, -1, 3.5]) expect(() => readRoleKeysFd(fd)).toThrow(RoleKeysError);
    const fd = fdOf("x");
    closeSync(fd);
    expect(() => readRoleKeysFd(fd)).toThrow(/not open/);
  });
});

describe("refuseKeysInEnv / --keys-fd (no env fallback)", () => {
  it("refuses any FINAL or LOOP role key in the environment, naming it but not its value", () => {
    const v = generatePrivateKey();
    expect(() => refuseKeysInEnv({ LENDER_PRIVATE_KEY_FINAL: v })).toThrow(/LENDER_PRIVATE_KEY_FINAL/);
    expect(() => refuseKeysInEnv({ AGENT_PRIVATE_KEY_LOOP: v })).toThrow(RoleKeysError);
    expect(() => refuseKeysInEnv({ REGULATOR_PRIVATE_KEY_FISCO: v })).toThrow(/REGULATOR_PRIVATE_KEY_FISCO/);
    try {
      refuseKeysInEnv({ LENDER_PRIVATE_KEY_FINAL: v });
    } catch (e: unknown) {
      expect(String((e as Error).message)).not.toContain(v.slice(2));
    }
    expect(() => refuseKeysInEnv({ PATH: "/usr/bin", HOME: "/tmp" })).not.toThrow();
  });

  it("requires --native-tls and --ledger-rpc (pack v2: the native receipts and node4's ledger)", () => {
    const without = (flag: string) => {
      const i = REQUIRED.indexOf(flag);
      return [...REQUIRED.slice(0, i), ...REQUIRED.slice(i + 2), "--keys-fd", "3"];
    };
    expect(() => parseArgs(without("--native-tls"))).toThrow(/--native-tls/);
    expect(() => parseArgs(without("--ledger-rpc"))).toThrow(/--ledger-rpc/);
    expect(parseArgs([...REQUIRED, "--keys-fd", "3"])).toMatchObject({ nativeTls: "facts/sdk", ledgerRpc: "http://127.0.0.1:8546" });
  });

  it("requires --keys-fd (an integer ≥ 3)", () => {
    expect(() => parseArgs(REQUIRED)).toThrow(/--keys-fd/);
    expect(() => parseArgs([...REQUIRED, "--keys-fd", "0"])).toThrow(/--keys-fd/);
    expect(() => parseArgs([...REQUIRED, "--keys-fd", "3x"])).toThrow(/--keys-fd/);
    expect(parseArgs([...REQUIRED, "--keys-fd", "3"]).keysFd).toBe(3);
  });

  it("env-only keys are refused before anything is read or sent", async () => {
    const env = { ...keys(), PATH: "/usr/bin" };
    await expect(main(REQUIRED, env)).rejects.toThrow(/environment/);
    await expect(main(REQUIRED, { PATH: "/usr/bin" })).rejects.toThrow(/--keys-fd/);
  });
});

describe("senderRoles (before the first send): the regulator key must be the genesis auth admin", () => {
  const accounts = () => Object.fromEntries(["lender", "oracle", "agent", "relayer", "regulator"].map((r) => [r, privateKeyToAccount(generatePrivateKey())])) as Record<"lender" | "oracle" | "agent" | "relayer" | "regulator", ReturnType<typeof privateKeyToAccount>>;

  it("returns the five lowercase addresses when the regulator is the auth admin of an auth-checking chain", () => {
    const a = accounts();
    expect(senderRoles(a, { auth: { check: true, admin: a.regulator.address.toLowerCase() as `0x${string}` } }).regulator).toBe(a.regulator.address.toLowerCase());
  });

  it("refuses another admin, auth checks off, and a regulator key equal to a FINAL key", () => {
    const a = accounts();
    expect(() => senderRoles(a, { auth: { check: true, admin: a.agent.address.toLowerCase() as `0x${string}` } })).toThrow(/genesis auth_admin_account/);
    expect(() => senderRoles(a, { auth: { check: false, admin: a.regulator.address.toLowerCase() as `0x${string}` } })).toThrow(/auth-checking chain/);
    expect(() => senderRoles({ ...a, regulator: a.lender }, { auth: { check: true, admin: a.lender.address.toLowerCase() as `0x${string}` } })).toThrow(/one of the FINAL role keys/);
  });
});

describe("the CLI over a real inherited fd 3 (as replay.sh launches it)", () => {
  const open: HttpFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((f) => f.close()));
  });

  /** Runs `node --import tsx src/fisco/cli.ts …` with `handoff` written to its fd 3; resolves exit code + output. */
  function runCli(args: readonly string[], handoff: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/fisco/cli.ts", ...args], {
        cwd: REDTEAM,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      const fd3 = child.stdio[3] as NodeJS.WritableStream;
      fd3.on("error", () => {});
      fd3.end(handoff);
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
    });
  }

  it("parses the keys from fd 3, then fails closed on a wrong chain; no key appears in its output", async () => {
    const node = await httpFixture((hit) => rpcAnswer(hit, "0x1"));
    open.push(node);
    const k = keys();
    const args = [...REQUIRED.map((a) => (a === "http://127.0.0.1:8545" ? node.url : a)), "--keys-fd", "3"];
    const ok = await runCli(args, lines(k));
    expect(ok.code).toBe(1);
    expect(ok.out).toMatch(/GuardError: the RPC serves chain 1/);
    expect(node.hits.map(methodOf)).toEqual(["eth_chainId"]);
    for (const v of Object.values(k)) expect(ok.out.toLowerCase()).not.toContain(v.slice(2, 18));

    const bad = await runCli(args, lines(k).toUpperCase());
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/RoleKeysError/);
    expect(node.hits).toHaveLength(1);

    const envOnly = await runCli(args.slice(0, -2), "", k);
    expect(envOnly.code).toBe(1);
    expect(envOnly.out).toMatch(/environment/);
    expect(node.hits).toHaveLength(1);
  }, 60_000);

  it("prints a node's error text without control characters (no terminal escapes, no forged lines)", async () => {
    const node = await httpFixture((hit) => rpcAnswer(hit, null, { code: -32000, message: "boom\u001b]0;x\u0007\r\nfisco:replay ok\u001b[2J" }));
    open.push(node);
    const args = [...REQUIRED.map((a) => (a === "http://127.0.0.1:8545" ? node.url : a)), "--keys-fd", "3"];
    const run = await runCli(args, lines(keys()));
    expect(run.code).toBe(1);
    expect(run.out).toContain("boom?]0;x???fisco:replay ok?[2J");
    expect(run.out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(run.out.trimEnd().split("\n")).toHaveLength(1);
  }, 60_000);
});
