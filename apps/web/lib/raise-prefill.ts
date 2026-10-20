/**
 * The prefilled "ask for a higher cap" request a CFO link carries (core cfo raiseCapHref, fixr-cfo):
 * `/dashboard?raise=<LINE>&cap=<perTx|window>&to=<minor>#change-requests`. Untrusted URL text: only a known line, a
 * known cap kind and whole minor units are taken; anything else prefills nothing. It only fills the form: the founder
 * still writes the reason, presses Ask and signs, and the loan officer and the timelock decide.
 */
import { CAP_KINDS, LINE_KEYS, type CapKind, type LineKey } from "@hogee/core";

export interface RaisePrefill {
  readonly lineKey: LineKey;
  readonly cap: CapKind;
  /** The new cap in BU as the form's amount field takes it ("400", "12.5"). */
  readonly amountBu: string;
}

const MINOR = /^[1-9][0-9]{0,29}$/;

/** Whole minor units → the BU text parseBuInput reads back to the same minor value. */
export function minorToBuInput(minor: string): string {
  const v = BigInt(minor);
  const cents = v % 100n;
  return cents === 0n ? (v / 100n).toString() : `${v / 100n}.${cents.toString().padStart(2, "0")}`;
}

export function raisePrefill(search: string): RaisePrefill | null {
  const q = new URLSearchParams(search);
  const lineKey = q.get("raise");
  const cap = q.get("cap");
  const to = q.get("to");
  if (!lineKey || !(LINE_KEYS as readonly string[]).includes(lineKey)) return null;
  if (!cap || !(CAP_KINDS as readonly string[]).includes(cap)) return null;
  if (!to || !MINOR.test(to)) return null;
  return { lineKey: lineKey as LineKey, cap: cap as CapKind, amountBu: minorToBuInput(to) };
}
