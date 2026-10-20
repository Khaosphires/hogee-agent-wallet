/**
 * Minimal CBOR (RFC 8949) decoder for WebAuthn attestation objects and COSE keys: unsigned/negative ints, byte and
 * text strings, arrays, maps, and the simple values false/true/null. Indefinite lengths, tags and floats are refused
 * (WebAuthn never needs them). Bounded: nesting depth and item counts are capped, every length is checked against
 * the buffer, so a hostile input can only fail with CborError.
 */
export type CborValue = number | bigint | string | Uint8Array | boolean | null | CborValue[] | Map<CborValue, CborValue>;

export class CborError extends Error {
  override readonly name = "CborError";
}

const MAX_DEPTH = 8;
const MAX_ITEMS = 256;

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new CborError("truncated");
    return this.buf[this.pos++] as number;
  }

  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new CborError("truncated");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  length(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return (this.byte() << 8) | this.byte();
    if (info === 26) return ((this.byte() << 24) >>> 0) + (this.byte() << 16) + (this.byte() << 8) + this.byte();
    throw new CborError("unsupported length");
  }
}

function item(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError("too deep");
  const first = r.byte();
  const major = first >> 5;
  const info = first & 0x1f;
  switch (major) {
    case 0:
      return r.length(info);
    case 1:
      return -1 - r.length(info);
    case 2:
      return Uint8Array.from(r.bytes(r.length(info)));
    case 3:
      return new TextDecoder("utf-8", { fatal: true }).decode(r.bytes(r.length(info)));
    case 4: {
      const n = r.length(info);
      if (n > MAX_ITEMS) throw new CborError("too many items");
      const out: CborValue[] = [];
      for (let i = 0; i < n; i += 1) out.push(item(r, depth + 1));
      return out;
    }
    case 5: {
      const n = r.length(info);
      if (n > MAX_ITEMS) throw new CborError("too many items");
      const out = new Map<CborValue, CborValue>();
      for (let i = 0; i < n; i += 1) {
        const k = item(r, depth + 1);
        if (out.has(k)) throw new CborError("duplicate map key");
        out.set(k, item(r, depth + 1));
      }
      return out;
    }
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new CborError("unsupported simple value");
    default:
      throw new CborError("unsupported major type");
  }
}

/** Decodes one item; with `exact` the input must hold nothing after it. Returns the item and the bytes it used. */
export function decodeCbor(buf: Uint8Array, exact = true): { value: CborValue; used: number } {
  const r = new Reader(buf);
  try {
    const value = item(r, 0);
    if (exact && r.pos !== buf.length) throw new CborError("trailing bytes");
    return { value, used: r.pos };
  } catch (e) {
    if (e instanceof CborError) throw e;
    throw new CborError("malformed");
  }
}
