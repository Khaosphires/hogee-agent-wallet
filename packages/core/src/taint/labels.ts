/**
 * Value-level taint (project.md §7.3, CaMeL-style): every value carries `{trust, sensitivity}` and the label
 * travels with the VALUE, not the turn. User turns and our DB are trusted; listings, invoices, emails,
 * unverified webhooks and web pages are untrusted.
 *
 * An untrusted value may fill a typed field (an invoice amount for an already-bound payee, checked against the
 * caps or the milestone). It can NEVER choose a payee, add an action, raise a cap, or enter an outbound tool
 * argument. The sinks below enforce that twice:
 *   - at compile time: they only accept `Trusted<T>` (a `Labeled` whose trust is the literal "trusted"), so
 *     passing an `Untrusted<T>`, or a `Labeled<T>` whose trust is not statically known, is a type error;
 *   - at run time: they re-check the label (casts and JSON round trips cannot smuggle a value through).
 */
import type { Taint } from "../schemas/primitives";

export type Trust = Taint["trust"];
export type Sensitivity = Taint["sensitivity"];

export interface Labeled<T, Tr extends Trust = Trust, S extends Sensitivity = Sensitivity> {
  readonly value: T;
  readonly taint: { readonly trust: Tr; readonly sensitivity: S };
  /** Provenance, e.g. "db:payees", "user:turn-3", "reader:invoice:inv-7". */
  readonly source: string;
}
export type Trusted<T, S extends Sensitivity = Sensitivity> = Labeled<T, "trusted", S>;
export type Untrusted<T, S extends Sensitivity = Sensitivity> = Labeled<T, "untrusted", S>;

export const TRUSTED_PUBLIC: Taint = Object.freeze({ trust: "trusted", sensitivity: "public" });
export const UNTRUSTED_PUBLIC: Taint = Object.freeze({ trust: "untrusted", sensitivity: "public" });

export type SinkKind = "payee" | "action" | "capRaise" | "outbound";

/** Machine reason codes for taint refusals (≤ 32 chars, ReasonCode format). */
export const TAINT_REASON: { readonly [K in SinkKind]: string } & { readonly privateOutbound: string } = {
  payee: "TAINTED_PAYEE",
  action: "TAINTED_ACTION",
  capRaise: "TAINTED_CAP",
  outbound: "TAINTED_OUTBOUND",
  privateOutbound: "PRIVATE_OUTBOUND",
};

export class TaintError extends Error {
  override readonly name = "TaintError";
  constructor(
    readonly reasonCode: string,
    readonly sink: SinkKind,
    readonly valueSource: string,
  ) {
    super(`${reasonCode}: a value from ${valueSource} cannot reach the ${sink} sink`);
  }
}

function make<T, Tr extends Trust, S extends Sensitivity>(value: T, trust: Tr, sensitivity: S, source: string): Labeled<T, Tr, S> {
  return Object.freeze({ value, taint: Object.freeze({ trust, sensitivity }), source });
}

export function trusted<T>(value: T, source: string): Trusted<T, "public">;
export function trusted<T, S extends Sensitivity>(value: T, source: string, sensitivity: S): Trusted<T, S>;
export function trusted<T>(value: T, source: string, sensitivity: Sensitivity = "public"): Trusted<T> {
  return make(value, "trusted", sensitivity, source);
}

export function untrusted<T>(value: T, source: string): Untrusted<T, "public">;
export function untrusted<T, S extends Sensitivity>(value: T, source: string, sensitivity: S): Untrusted<T, S>;
export function untrusted<T>(value: T, source: string, sensitivity: Sensitivity = "public"): Untrusted<T> {
  return make(value, "untrusted", sensitivity, source);
}

/** A label known only at run time (e.g. read back from the DB). */
export function labeled<T>(value: T, taint: Taint, source: string): Labeled<T> {
  return make(value, taint.trust, taint.sensitivity, source);
}

/** Least upper bound: untrusted if any input is untrusted; private if any input is private. */
export function joinTaint(...taints: readonly Taint[]): Taint {
  return {
    trust: taints.some((t) => t.trust === "untrusted") ? "untrusted" : "trusted",
    sensitivity: taints.some((t) => t.sensitivity === "private") ? "private" : "public",
  };
}

/** Transform a value; the result keeps the input's label (taint travels with derived values). */
export function mapLabeled<T, U, Tr extends Trust, S extends Sensitivity>(v: Labeled<T, Tr, S>, f: (x: T) => U): Labeled<U, Tr, S> {
  return make(f(v.value), v.taint.trust, v.taint.sensitivity, v.source);
}

/** Combine several labeled values; the result carries the join of their labels. */
export function combineLabeled<T, U>(vs: readonly Labeled<T>[], f: (xs: T[]) => U, source = "derived"): Labeled<U> {
  return labeled(
    f(vs.map((v) => v.value)),
    joinTaint(...vs.map((v) => v.taint)),
    vs.length > 0 ? `${source}(${vs.map((v) => v.source).join(",")})` : source,
  );
}

export function isTrusted<T>(v: Labeled<T>): v is Trusted<T> {
  return v.taint.trust === "trusted";
}

/** Runtime guard that narrows `Labeled<T>` to `Trusted<T>` or throws TaintError for the named sink. */
export function assertTrusted<T>(v: Labeled<T>, sink: SinkKind): asserts v is Trusted<T> {
  if (v.taint.trust !== "trusted") throw new TaintError(TAINT_REASON[sink], sink, v.source);
}

/** The value of a payee choice. Only a trusted value (registry/DB/founder) may choose who gets paid. */
export function payeeSink<T>(v: Trusted<T>): T {
  assertTrusted(v as Labeled<T>, "payee");
  return v.value;
}

/** The value that selects an action (kind, line, order, stage). Untrusted content cannot add actions. */
export function actionSink<T>(v: Trusted<T>): T {
  assertTrusted(v as Labeled<T>, "action");
  return v.value;
}

/** A value that raises a cap, extends an expiry, moves or releases money. Never untrusted. */
export function capRaiseSink<T>(v: Trusted<T>): T {
  assertTrusted(v as Labeled<T>, "capRaise");
  return v.value;
}

/** An argument of a tool call that sends data out (research query, lookup). Trusted AND public only. */
export function outboundArgSink<T>(v: Trusted<T, "public">): T {
  const l = v as Labeled<T>;
  assertTrusted(l, "outbound");
  if (l.taint.sensitivity !== "public") throw new TaintError(TAINT_REASON.privateOutbound, "outbound", l.source);
  return v.value;
}

/**
 * Explicit, audited endorsement: an untrusted value becomes trusted only if a deterministic check written in
 * code accepts it (e.g. an invoice's payee equals the payee bound to its order). The new source records it.
 */
export function endorse<T, S extends Sensitivity>(v: Labeled<T, Trust, S>, check: (value: T) => boolean, reason: string): Trusted<T, S> | null {
  if (!check(v.value)) return null;
  return make(v.value, "trusted", v.taint.sensitivity, `endorsed:${reason}<-${v.source}`);
}
