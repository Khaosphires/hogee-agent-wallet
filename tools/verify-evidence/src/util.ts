/** Small shared helpers: check results, hex and byte handling. Browser-safe (no node: imports). */
import type { Hex } from "viem";

export type VerifyCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
};

/** Collects the problems of one check category; `result()` reports the first few. */
export class Problems {
  private readonly items: string[] = [];
  private notes: string[] = [];
  constructor(readonly name: string) {}

  add(problem: string): void {
    this.items.push(problem);
  }

  /** An informational remark that does not fail the check (e.g. an orphan spend answered by the treasury pause). */
  note(remark: string): void {
    this.notes.push(remark);
  }

  get count(): number {
    return this.items.length;
  }

  result(okDetail: string): VerifyCheck {
    if (this.items.length === 0) {
      const extra = this.notes.length > 0 ? `; ${summarise(this.notes)}` : "";
      return { name: this.name, ok: true, detail: `${okDetail}${extra}` };
    }
    return { name: this.name, ok: false, detail: summarise(this.items) };
  }
}

const SHOWN = 4;

function summarise(items: readonly string[]): string {
  const shown = items.slice(0, SHOWN).join("; ");
  return items.length > SHOWN ? `${shown}; and ${items.length - SHOWN} more` : shown;
}

export const lower = (s: string): string => s.toLowerCase();
export const sameHex = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

/** Bytes of a 0x-hex string, or null when it is not even-length hex. */
export function hexToBytesOrNull(h: string): Uint8Array | null {
  if (!HEX_RE.test(h)) return null;
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): Hex {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as Hex;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8Bytes = (s: string): Uint8Array => encoder.encode(s);

/** A bundle file as bytes (text files arrive as strings from the explorer, as bytes from the CLI). */
export const fileBytes = (v: string | Uint8Array): Uint8Array => (typeof v === "string" ? utf8Bytes(v) : v);

/** A bundle file as text; null when its bytes are not valid UTF-8. */
export function fileText(v: string | Uint8Array): string | null {
  if (typeof v === "string") return v;
  try {
    return decoder.decode(v);
  } catch {
    return null;
  }
}

/** JSON.parse that reports failure as undefined. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A JSON-RPC quantity ("0x1a") as a bigint; null when malformed. */
export function quantity(q: string): bigint | null {
  return /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(q) ? BigInt(q) : null;
}

/** §26.3 decisionId: a lowercase UUID left-padded to bytes32. */
export function decisionIdToBytes32(uuid: string): Hex {
  return `0x${"0".repeat(32)}${uuid.replaceAll("-", "")}` as Hex;
}

/** Right-padded ASCII bytes32 (lineId, payeeId, deploymentId, chainTag, …), §26.3. */
export function tagToBytes32(label: string): Hex {
  let hex = "";
  for (let i = 0; i < label.length; i += 1) hex += label.charCodeAt(i).toString(16).padStart(2, "0");
  return `0x${hex.padEnd(64, "0")}` as Hex;
}

/** The ShortId of a right-padded bytes32 tag, or null when it is not one. */
export function bytes32ToTag(value: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const bytes = hexToBytesOrNull(value) as Uint8Array;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  let s = "";
  for (let i = 0; i < end; i += 1) {
    const c = bytes[i] as number;
    if (c < 0x20 || c > 0x7e) return null;
    s += String.fromCharCode(c);
  }
  return s;
}
