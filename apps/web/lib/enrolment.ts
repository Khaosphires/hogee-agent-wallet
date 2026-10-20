/**
 * Founder passkey enrolment (G2; docs/G2-notes-for-P2.md §1–2): the loan officer generates a one-time code in the
 * officer console and the founder types it in before creating their passkey. Pure helpers: the code's shape, the time it has
 * left, and plain-English copy for each refusal (the generic FORBIDDEN copy, "Not allowed for this role", is wrong here).
 */
import { EnrolmentCode, errorCopy } from "@hogee/core";
import { ApiClientError } from "./api/client";

/** What the founder typed, without spaces: a code read aloud or pasted from a message often has some. */
export const normalizeEnrolmentCode = (text: string): string => text.replace(/\s+/g, "");

/** 24 base64url characters (core EnrolmentCode), so a typo is caught before any request. */
export const isEnrolmentCode = (text: string): boolean => EnrolmentCode.safeParse(text).success;

/** Where a registration failed: the same API code means different things at each step. */
export type RegistrationStep = "options" | "device" | "verify";

/** A failed founder registration and the step it failed at. */
export class RegistrationFailure extends Error {
  constructor(
    readonly step: RegistrationStep,
    readonly error: unknown,
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "RegistrationFailure";
  }
}

/** FORBIDDEN at options or verify: wrong, used, replaced or expired (the server gives one answer for all four). */
export const CODE_NOT_VALID = "This code doesn't work any more. It may be wrong, used, replaced or expired. Ask your loan officer for a new one.";

/** The shape check's words (the form and the server's VALIDATION answer say the same). */
export const CODE_SHAPE_TEXT = "Enter the 24-character code from your loan officer. It only has letters, numbers, - and _.";

/** The device's passkey prompt was dismissed or ran out of time (NotAllowedError). */
export const PROMPT_CANCELLED = "The passkey request was cancelled or took too long. Try again.";

/**
 * The authenticator already holds the founder's current key: register/options lists it in excludeCredentials, so the
 * device refuses to make a second credential (InvalidStateError) instead of overwriting the one that signs.
 */
export const ALREADY_ON_DEVICE = 'This device already has your passkey. Press "Sign with passkey" instead.';

export const alreadyOnDevice = (failure: RegistrationFailure): boolean =>
  failure.step === "device" && failure.error instanceof Error && failure.error.name === "InvalidStateError";

const fallback = (error: ApiClientError): string => {
  const copy = errorCopy(error.code);
  return `${copy.title}. ${copy.detail}`;
};

/** The founder-facing reason a registration step failed. */
export function registrationErrorText(step: RegistrationStep, error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "VALIDATION":
        return CODE_SHAPE_TEXT;
      case "FORBIDDEN":
        return CODE_NOT_VALID;
      case "FounderKeyAlreadySet":
        return "A passkey is already waiting for your loan officer to approve it, or is already approved. Ask them to check it before you create another.";
      case "CONFLICT":
        return step === "verify"
          ? "Your loan officer rejected this passkey. Ask them for a new code, then create a new passkey."
          : "Your loan isn't open yet. Ask your loan officer to open it, then try again.";
      default:
        return fallback(error);
    }
  }
  if (error instanceof Error && error.name === "NotAllowedError") return PROMPT_CANCELLED;
  if (alreadyOnDevice(new RegistrationFailure(step, error))) return ALREADY_ON_DEVICE;
  return error instanceof Error ? error.message : String(error);
}

type FounderKeyAction = "generate" | "approve" | "reject";

const FOUNDER_KEY_COPY: Partial<Record<`${FounderKeyAction}:${string}`, string>> = {
  "generate:CONFLICT": "The loan isn't open yet. Open it first (step 1), then make the code.",
  "approve:CONFLICT": "This passkey isn't waiting any more (it was rejected or replaced). Check the one below.",
  "reject:NOT_FOUND": "That passkey is no longer waiting for review.",
  "reject:CONFLICT": "You already approved this passkey and it's being saved, so you can't reject it now.",
  "reject:FounderKeyAlreadySet": "This passkey is already approved and saved. It can't be rejected.",
};

/** The officer-facing reason an enrolment action failed. */
export function founderKeyErrorText(action: FounderKeyAction, error: ApiClientError): string {
  return FOUNDER_KEY_COPY[`${action}:${error.code}`] ?? `${errorCopy(error.code).title}: ${error.message}`;
}

/** "14:05" left until `expiresAtIso`, or undefined once it has passed (or can't be read: treat it as expired). */
export function timeLeft(expiresAtIso: string, nowMs: number): string | undefined {
  const leftMs = Date.parse(expiresAtIso) - nowMs;
  if (!Number.isFinite(leftMs) || leftMs <= 0) return undefined;
  const seconds = Math.ceil(leftMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
