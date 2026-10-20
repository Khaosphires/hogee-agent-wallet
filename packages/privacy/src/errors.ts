import type { PiiEntity } from "@hogee/core";

/** A frozen PiiEntity name, or another detected type (e.g. "SG_NRIC" before core lists it, "EMAIL_ADDRESS"). */
export type PiiEntityName = PiiEntity | (string & {});

/** Thrown by assertNoIds when an ID-like pattern would leave the machine. Names entity types only, never the text. */
export class PiiLeakError extends Error {
  constructor(readonly entities: readonly PiiEntityName[]) {
    super(`Outbound text contains ID patterns: ${entities.join(", ")}`);
    this.name = "PiiLeakError";
  }
}

/** data/pii/*.json is missing, malformed or holds an unsafe regex: every call fails closed until it is fixed. */
export class PrivacyConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`PII configuration is invalid: ${message}`, options);
    this.name = "PrivacyConfigError";
  }
}

/** Input above the size cap is refused rather than scanned partially (fail closed). */
export class PrivacyInputTooLargeError extends Error {
  constructor(
    readonly length: number,
    readonly max: number,
  ) {
    super(`Text of ${length} characters exceeds the ${max}-character privacy scan limit`);
    this.name = "PrivacyInputTooLargeError";
  }
}
