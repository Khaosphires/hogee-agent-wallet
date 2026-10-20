/**
 * The four FINAL role keys and the regulator's FISCO key reach the replay on an inherited file descriptor, never on argv
 * or in the environment (run-11 C2): an environment's launch-time copy stays readable to same-user processes after any
 * scrub, and pnpm would hold it too. replay.sh starts `node --import tsx src/fisco/cli.ts --keys-fd 3 … 3< <(printf …)`
 * directly. The regulator key (`REGULATOR_PRIVATE_KEY_FISCO`) is the FISCO chain's committee governor and auth admin,
 * decrypted by replay.sh from the chain folder's own keystore; it has no meaning on any other chain.
 *
 * Hand-off format, nothing else accepted: exactly five lines `NAME=0x<64 lowercase hex>\n` (LF after the last one too),
 * one per name in ROLE_KEY_NAMES, any order, at most 4 KiB in all. The reader closes the descriptor whatever happens.
 * Errors name a line number or a variable, never a value.
 */
import { closeSync, fstatSync, readSync } from "node:fs";
import { KEY_SETS, keyEnvName, SIGNER_ROLES } from "@hogee/worker";
import type { Hex } from "viem";

/** The regulator's key (FISCO only): the genesis committee governor and auth admin of the mirror chain. */
export const REGULATOR_KEY_NAME = "REGULATOR_PRIVATE_KEY_FISCO";
export const FINAL_KEY_NAMES = ["AGENT_PRIVATE_KEY_FINAL", "LENDER_PRIVATE_KEY_FINAL", "ORACLE_PRIVATE_KEY_FINAL", "RELAYER_PRIVATE_KEY_FINAL"] as const;
export const ROLE_KEY_NAMES = [...FINAL_KEY_NAMES, REGULATOR_KEY_NAME] as const;
export type RoleKeyName = (typeof ROLE_KEY_NAMES)[number];
export type RoleKeys = Readonly<Record<RoleKeyName, Hex>>;

export const MAX_KEYS_BYTES = 4096;
const LINE_RE = /^([A-Z_]{1,40})=(0x[0-9a-f]{64})$/;
const EAGAIN_WAIT_MS = 10;
const READ_DEADLINE_MS = 10_000;

export class RoleKeysError extends Error {
  override readonly name = "RoleKeysError";
}

const isRoleKeyName = (name: string): name is RoleKeyName => (ROLE_KEY_NAMES as readonly string[]).includes(name);

/** The five keys from the hand-off text; RoleKeysError on any deviation from the format above. */
export function parseRoleKeys(text: string): RoleKeys {
  if (Buffer.byteLength(text) > MAX_KEYS_BYTES) throw new RoleKeysError(`the key hand-off is over ${MAX_KEYS_BYTES} bytes`);
  if (!text.endsWith("\n")) throw new RoleKeysError("the key hand-off must be newline-terminated lines");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== ROLE_KEY_NAMES.length) throw new RoleKeysError(`the key hand-off has ${lines.length} lines, not ${ROLE_KEY_NAMES.length}`);
  const keys: Partial<Record<RoleKeyName, Hex>> = {};
  lines.forEach((line, i) => {
    const m = LINE_RE.exec(line);
    if (!m) throw new RoleKeysError(`line ${i + 1} of the key hand-off is not NAME=0x<64 lowercase hex>`);
    const name = m[1] as string;
    if (!isRoleKeyName(name)) throw new RoleKeysError(`line ${i + 1} of the key hand-off names a variable other than the four FINAL role keys and ${REGULATOR_KEY_NAME}`);
    if (keys[name] !== undefined) throw new RoleKeysError(`${name} appears more than once in the key hand-off`);
    keys[name] = m[2] as Hex;
  });
  const missing = ROLE_KEY_NAMES.filter((n) => keys[n] === undefined);
  if (missing.length > 0) throw new RoleKeysError(`the key hand-off lacks ${missing.join(", ")}`);
  return Object.freeze(keys as Record<RoleKeyName, Hex>);
}

function errnoOf(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "error";
}

const waitSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Reads `fd` to EOF (≤ MAX_KEYS_BYTES) into `buf`; returns the byte count. Waits out EAGAIN on a non-blocking pipe. */
function readAll(fd: number, buf: Buffer): number {
  const deadline = Date.now() + READ_DEADLINE_MS;
  let n = 0;
  for (;;) {
    let got: number;
    try {
      got = readSync(fd, buf, n, buf.length - n, null);
    } catch (error: unknown) {
      const code = errnoOf(error);
      if (code === "EAGAIN" && Date.now() < deadline) {
        waitSync(EAGAIN_WAIT_MS);
        continue;
      }
      throw new RoleKeysError(`could not read --keys-fd ${fd} (${code})`);
    }
    if (got === 0) return n;
    n += got;
    if (n > MAX_KEYS_BYTES) throw new RoleKeysError(`the key hand-off is over ${MAX_KEYS_BYTES} bytes`);
  }
}

/** Reads the hand-off from descriptor `fd` (a pipe, socket or file), closes it, and parses it. */
export function readRoleKeysFd(fd: number): RoleKeys {
  if (!Number.isSafeInteger(fd) || fd < 3) throw new RoleKeysError("--keys-fd must be a descriptor number of 3 or more");
  let kind: { isFIFO(): boolean; isSocket(): boolean; isFile(): boolean };
  try {
    kind = fstatSync(fd);
  } catch {
    throw new RoleKeysError(`--keys-fd ${fd} is not open`);
  }
  const buf = Buffer.alloc(MAX_KEYS_BYTES + 1);
  try {
    if (!(kind.isFIFO() || kind.isSocket() || kind.isFile())) throw new RoleKeysError(`--keys-fd ${fd} is not a pipe, socket or file`);
    const n = readAll(fd, buf);
    return parseRoleKeys(buf.subarray(0, n).toString("utf8"));
  } finally {
    buf.fill(0);
    closeSync(fd);
  }
}

/**
 * Fails when any role key (either set) or the regulator's key is in this process's environment: the hand-off is the fd
 * only, and a key in the environment means the launcher still exports it (the launch-time copy outlives any scrub).
 * Names it, never its value.
 */
export function refuseKeysInEnv(env: Readonly<Record<string, string | undefined>>): void {
  const names = [...KEY_SETS.flatMap((set) => SIGNER_ROLES.map((role) => keyEnvName(role, set))), REGULATOR_KEY_NAME];
  const present = names.filter((name) => env[name] !== undefined);
  if (present.length > 0) throw new RoleKeysError(`role keys are in this process's environment (${present.join(", ")}); hand them over on --keys-fd only`);
}
