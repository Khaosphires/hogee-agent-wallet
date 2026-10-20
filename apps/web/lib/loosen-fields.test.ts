/**
 * LoosenRequest's target / aux / newValue (contracts/src/TreasuryLoosenRules.sol _checkLoosen, _applyLoosen): a field
 * a change kind uses is shown as its own plain row; a field it doesn't use must be zero, or the browser refuses to sign
 * (red summary, disabled button). Across every struct and every change kind, no signed field is left neither shown nor
 * checked.
 */
import { describe, expect, it } from "vitest";
import type { SignatureKind, SignatureRequestResponse, TypedData } from "@hogee/core";
import { LOOSEN_KINDS, chainTagOf, hogeeDomain, hogeeTypes, toBytes32Tag } from "@hogee/api-mock/eip712";
import { LOOSEN_FIELD_USE, checkedZeroFields } from "./loosen-fields";
import { bytesToBase64Url, hexToBytes, type Hex } from "./passkey-encode";
import { DONT_SIGN_SUMMARY, signGate, signSummary } from "./sign-summary";
import { signedRows } from "./signed-rows";
import { checkSignatureRequest, digestOf, type SigningContext } from "./typed-data";

const CHAIN = 11155111;
const DEPLOYMENT = "final-1";
const NOW = Date.UTC(2026, 9, 19, 6, 0);
const CONTRACT = "0x00000000000000000000000000000000000000aa";
const ZERO = `0x${"0".repeat(64)}`;
const STRAY = `0x${"0".repeat(63)}1`;
const CTX: SigningContext = { kind: "LoosenRequest", chainId: CHAIN, deploymentId: DEPLOYMENT };
type KindName = keyof typeof LOOSEN_KINDS;

/** A valid message per change kind, shaped as the live API and the mock build it (services/exceptions.ts loosenFields). */
const VALID: Record<KindName, { target: string; aux: string; newValue: string }> = {
  LOOSEN_RAISE_PER_TX_CAP: { target: toBytes32Tag("ADS"), aux: ZERO, newValue: "60000" },
  LOOSEN_RAISE_WINDOW_CAP: { target: toBytes32Tag("ADS"), aux: ZERO, newValue: "120000" },
  LOOSEN_ADD_PAYEE: { target: toBytes32Tag("printer-sg"), aux: toBytes32Tag("PACKAGING"), newValue: BigInt(`0x${"ab".repeat(32)}`).toString() },
  LOOSEN_EXTEND_AGENT_EXPIRY: { target: ZERO, aux: ZERO, newValue: String(NOW / 1000 + 30 * 86_400) },
  LOOSEN_EXTEND_LINE_EXPIRY: { target: toBytes32Tag("ADS"), aux: ZERO, newValue: String(NOW / 1000 + 30 * 86_400) },
  LOOSEN_MOVE_POCKETS: { target: toBytes32Tag("CONTINGENCY"), aux: toBytes32Tag("ADS"), newValue: "20000" },
  LOOSEN_UNPAUSE: { target: toBytes32Tag("ADS"), aux: ZERO, newValue: "0" },
  LOOSEN_WITHDRAW_RESERVE: { target: toBytes32Tag("iras-tax"), aux: ZERO, newValue: "5000" },
};

function loosen(kind: KindName, over: Partial<{ target: string; aux: string; newValue: string }> = {}): TypedData {
  const domain = hogeeDomain({ verifyingContract: CONTRACT, chainTag: toBytes32Tag(chainTagOf(CHAIN)), deploymentId: toBytes32Tag(DEPLOYMENT) });
  return {
    domain,
    types: { LoosenRequest: hogeeTypes.LoosenRequest.map((f) => ({ ...f })) },
    primaryType: "LoosenRequest",
    message: { kind: String(LOOSEN_KINDS[kind]), ...VALID[kind], ...over, deploymentId: toBytes32Tag(DEPLOYMENT), nonce: "3", expiry: String(NOW / 1000 + 600) },
  };
}

function request(td: TypedData): SignatureRequestResponse {
  const digest = digestOf(td);
  return {
    requestId: "sig-l",
    typedData: td,
    digest,
    challengeB64url: bytesToBase64Url(hexToBytes(digest as Hex)),
    displayModel: { title: "Change", kind: td.primaryType, rows: [], digest, chainId: CHAIN, contract: CONTRACT, deploymentId: DEPLOYMENT },
    expiresAt: String(td.message.expiry),
  };
}

const KIND_NAMES = Object.keys(LOOSEN_KINDS) as KindName[];
const USES = ["target", "aux", "newValue"] as const;

describe("which change kinds use target, aux and newValue (mirrors the contract)", () => {
  it("names every LOOSEN_* kind, and nothing else", () => {
    expect(Object.keys(LOOSEN_FIELD_USE).sort()).toEqual([...KIND_NAMES].sort());
  });

  it("aux has a meaning only for ADD_PAYEE (the pocket) and MOVE_POCKETS (the pocket it moves to)", () => {
    expect(KIND_NAMES.filter((k) => LOOSEN_FIELD_USE[k].aux !== "zero")).toEqual(["LOOSEN_ADD_PAYEE", "LOOSEN_MOVE_POCKETS"]);
    expect(LOOSEN_FIELD_USE.LOOSEN_EXTEND_AGENT_EXPIRY.target).toBe("zero");
    expect(LOOSEN_FIELD_USE.LOOSEN_UNPAUSE.newValue).toBe("zero");
  });
});

describe.each(KIND_NAMES)("%s", (kind) => {
  it("passes the check as the server builds it, and every signed field is shown or checked to be zero", () => {
    const req = request(loosen(kind));
    const check = checkSignatureRequest(req, CTX, NOW);
    expect(check.ok, check.reason).toBe(true);
    const rows = signedRows(req.typedData, undefined, undefined, "SGD");
    const shown = new Set(rows.flatMap((r) => r.fields));
    const zero = new Set(checkedZeroFields(req.typedData));
    for (const field of hogeeTypes.LoosenRequest) expect(shown.has(field.name) || zero.has(field.name), `${kind}: ${field.name} is shown or checked`).toBe(true);
    // A field is either shown (it means something) or checked empty (it doesn't), never both.
    for (const field of zero) expect(shown.has(field), `${kind}: ${field} is checked empty, so no row shows it`).toBe(false);
    expect(signSummary(req.typedData, check).ok).toBe(true);
  });

  it.each(USES.filter((f) => LOOSEN_FIELD_USE[kind][f] === "zero"))("refuses a non-zero %s, which this kind doesn't use", (field) => {
    const td = loosen(kind, { [field]: field === "newValue" ? "1" : STRAY });
    const req = request(td);
    const check = checkSignatureRequest(req, CTX, NOW);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/part this change doesn't use/);
    expect(signSummary(td, check)).toBe(DONT_SIGN_SUMMARY);
    expect(signGate({ hasRequest: true, checkOk: check.ok, signed: false, busy: undefined }).disabled).toBe(true);
  });

  it.each(USES.filter((f) => LOOSEN_FIELD_USE[kind][f] !== "zero"))("shows %s as its own plain row", (field) => {
    const rows = signedRows(loosen(kind), undefined, undefined, "SGD");
    const row = rows.find((r) => r.fields.includes(field) && r.label !== "Change");
    expect(row, `${kind}: a row for ${field}`).toBeDefined();
    expect(row?.value.length).toBeGreaterThan(0);
  });
});

describe("aux rows read plainly", () => {
  it("ADD_PAYEE names the pocket the new payee is paid from; MOVE_POCKETS the pocket that receives the money", () => {
    const pocketRow = (kind: KindName) => signedRows(loosen(kind)).find((r) => r.fields.includes("aux"));
    expect(pocketRow("LOOSEN_ADD_PAYEE")).toMatchObject({ label: "Paid from", value: "your Packaging pocket" });
    expect(pocketRow("LOOSEN_MOVE_POCKETS")).toMatchObject({ label: "Moved to", value: "your Ads pocket" });
  });
});

describe("every signed field of every struct is shown or checked (no silent field)", () => {
  it.each(Object.keys(hogeeTypes) as SignatureKind[])("%s: the zero-checked fields are only LoosenRequest's unused ones", (kind) => {
    if (kind === "LoosenRequest") return;
    const td = { primaryType: kind, message: {} } as unknown as TypedData;
    expect(checkedZeroFields(td)).toEqual([]);
  });
});
