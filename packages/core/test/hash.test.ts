import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HashVectors,
  JcsError,
  exampleSupplier,
  hashObject,
  jcs,
  keccak256Utf8,
  normalizeSnippet,
  payoutAccountHash,
  sha256Utf8,
  snippetHash,
} from "../src/index";

/** String from code points (keeps invisible characters out of the source). */
const cp = (...xs: number[]): string => String.fromCodePoint(...xs);

/** Number from its IEEE-754 bit pattern (RFC 8785 Appendix B lists numbers this way). */
function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("jcs (RFC 8785)", () => {
  it("reproduces the §3.2.2 sample (numbers, string escapes, literals)", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    ) as unknown;
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        `"string":"${cp(0x20ac)}$\\u000f\\nA'B\\"\\\\\\\\\\"/"}`,
    );
  });

  it("sorts keys by UTF-16 code units (§3.2.3 sample)", () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One",' +
        '"\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
    ) as unknown;
    // Checked on the string: re-parsing would let JS move the integer-like key "1" first.
    expect(jcs(input)).toBe(
      `{"\\r":"Carriage Return","1":"One","${cp(0x80)}":"Control",` +
        `"${cp(0xf6)}":"Latin Small Letter O With Diaeresis","${cp(0x20ac)}":"Euro Sign",` +
        `"${cp(0x1f600)}":"Emoji: Grinning Face","${cp(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`,
    );
  });

  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af6", "1e+23"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555555", "333333333.3333333"],
  ])("serialises Appendix B number %s as %s", (bits, text) => {
    expect(jcs(fromBits(bits))).toBe(text);
  });

  it("escapes control characters and keeps non-ASCII literal", () => {
    const s = `a${cp(0)}b${cp(0x1f)}\t"\\${cp(0xe9, 0x1f600)}`;
    expect(jcs({ s })).toBe(`{"s":"a\\u0000b\\u001f\\t\\"\\\\${cp(0xe9, 0x1f600)}"}`);
  });

  it("is independent of key insertion order, nested", () => {
    expect(jcs({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(jcs({ a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 }));
    expect(jcs({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  const loneHigh = String.fromCharCode(0xd800);
  const loneLow = String.fromCharCode(0xdc00);
  it.each([
    ["undefined value", { a: undefined }],
    ["undefined in array", [1, undefined]],
    ["bigint (money must be a digit string)", { amountMinor: 10n }],
    ["NaN", { x: Number.NaN }],
    ["Infinity", [Number.POSITIVE_INFINITY]],
    ["function", { f: () => 1 }],
    ["Date", { d: new Date(0) }],
    ["Map", new Map()],
    ["lone surrogate", { s: loneHigh }],
    ["lone surrogate key", { [loneLow]: 1 }],
    // eslint-disable-next-line no-sparse-arrays
    ["sparse array", [1, , 3]],
  ])("rejects %s", (_name, value) => {
    expect(() => jcs(value)).toThrow(JcsError);
  });

  it("rejects cycles but accepts repeated (acyclic) references", () => {
    const shared = { x: 1 };
    expect(jcs({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jcs(cyclic)).toThrow(JcsError);
  });
});

describe("keccak256 / hashObject", () => {
  it("keccak256 of the empty string (sanity: not sha3-256)", () => {
    expect(keccak256Utf8("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("hashObject = keccak256(utf8(JCS(value)))", () => {
    expect(hashObject({ b: "2", a: "1" })).toBe(keccak256Utf8('{"a":"1","b":"2"}'));
    expect(hashObject({})).toBe(keccak256Utf8("{}"));
  });

  it("matches the supplier A payoutAccountHash golden in packages/chain (eip712.test.ts)", () => {
    expect(payoutAccountHash(exampleSupplier.xenditTest)).toBe(
      "0x142ad066e84bde38bc37aadb3976a708f96b660bb1bed323a05cbf7c42191ccc",
    );
    expect(jcs({ channel: "MY_DUITNOW", accountNumber: "1234567890", holderName: "Supplier A Co Ltd" })).toBe(
      '{"accountNumber":"1234567890","channel":"MY_DUITNOW","holderName":"Supplier A Co Ltd"}',
    );
  });

  it("payoutAccountHash ignores keys outside {channel, accountNumber, holderName}", () => {
    const extra = { ...exampleSupplier.xenditTest, bank: "x" } as typeof exampleSupplier.xenditTest;
    expect(payoutAccountHash(extra)).toBe(payoutAccountHash(exampleSupplier.xenditTest));
  });
});

describe("snippetHash", () => {
  it("is 0x + sha256 of the trimmed, whitespace-collapsed sentence", () => {
    expect(sha256Utf8("abc")).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(snippetHash("  abc \n")).toBe(sha256Utf8("abc"));
    expect(snippetHash("a  b\n\tc")).toBe(sha256Utf8("a b c"));
  });

  it("collapses the same whitespace set as Python str.split()", () => {
    expect(normalizeSnippet(`${cp(0xa0)}RM3${cp(0x2009)}million${cp(0x3000)}turnover${cp(0x1c, 0x85)} `)).toBe(
      "RM3 million turnover",
    );
    expect(normalizeSnippet(`a${cp(0x2028)}b${cp(0x2029)}c`)).toBe("a b c");
    expect(normalizeSnippet(`keep${cp(0xfeff)}bom`)).toBe(`keep${cp(0xfeff)}bom`);
    expect(normalizeSnippet(" \t\n ")).toBe("");
  });
});

const GOLDEN_PATH = fileURLToPath(new URL("../../../data/golden/hash-vectors.json", import.meta.url));
const hasGolden = existsSync(GOLDEN_PATH);

describe.skipIf(!hasGolden)("golden hash vectors (data/golden/hash-vectors.json, P3)", () => {
  const vectors = hasGolden ? HashVectors.parse(JSON.parse(readFileSync(GOLDEN_PATH, "utf8"))) : [];
  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    expect(jcs(v.input)).toBe(v.jcs);
    expect(keccak256Utf8(v.jcs)).toBe(v.keccak256);
    expect(hashObject(v.input)).toBe(v.keccak256);
  });
});
