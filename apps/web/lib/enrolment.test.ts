import { describe, expect, it } from "vitest";
import { ApiClientError } from "./api/client";
import {
  ALREADY_ON_DEVICE,
  CODE_NOT_VALID,
  RegistrationFailure,
  alreadyOnDevice,
  founderKeyErrorText,
  isEnrolmentCode,
  normalizeEnrolmentCode,
  registrationErrorText,
  timeLeft,
} from "./enrolment";

const apiError = (code: ConstructorParameters<typeof ApiClientError>[0], status: number, message = "server says no") =>
  new ApiClientError(code, message, status);

const CODE = "ZXhhbXBsZS1lbnJvbG1lbnQt";

describe("normalizeEnrolmentCode / isEnrolmentCode", () => {
  it("drops every space, tab and line break (a code read aloud or pasted from a message)", () => {
    expect(normalizeEnrolmentCode(`  ZXhhbX BsZS1l\tbnJvbG1l\nbnQt `)).toBe(CODE);
  });

  it("accepts exactly 24 base64url characters", () => {
    expect(isEnrolmentCode(CODE)).toBe(true);
    expect(isEnrolmentCode("A-_a0".padEnd(24, "z"))).toBe(true);
  });

  it("refuses a short, long or non-base64url code", () => {
    expect(isEnrolmentCode(CODE.slice(1))).toBe(false);
    expect(isEnrolmentCode(`${CODE}A`)).toBe(false);
    expect(isEnrolmentCode(`${CODE.slice(1)}=`)).toBe(false);
    expect(isEnrolmentCode(`${CODE.slice(1)}+`)).toBe(false);
    expect(isEnrolmentCode("")).toBe(false);
  });
});

describe("registrationErrorText", () => {
  it("says a code is no longer valid for FORBIDDEN at either step, never 'Not allowed for this role'", () => {
    expect(registrationErrorText("options", apiError("FORBIDDEN", 403))).toBe(CODE_NOT_VALID);
    expect(registrationErrorText("verify", apiError("FORBIDDEN", 403))).toBe(CODE_NOT_VALID);
    expect(CODE_NOT_VALID).toContain("Ask your loan officer for a new one");
  });

  it("tells CONFLICT apart by step: facility not open (options) vs passkey rejected (verify)", () => {
    expect(registrationErrorText("options", apiError("CONFLICT", 409))).toContain("Your loan isn't open yet");
    expect(registrationErrorText("verify", apiError("CONFLICT", 409))).toContain("rejected this passkey");
  });

  it("explains a key already waiting for review", () => {
    expect(registrationErrorText("verify", apiError("FounderKeyAlreadySet", 409))).toContain("already waiting for your loan officer");
  });

  it("asks for the 24-character code on VALIDATION", () => {
    expect(registrationErrorText("options", apiError("VALIDATION", 422))).toContain("24-character code");
  });

  it("says the device already holds the founder's key when the authenticator refuses (excludeCredentials)", () => {
    const previouslyRegistered = Object.assign(new Error("The authenticator was previously registered"), { name: "InvalidStateError" });
    expect(registrationErrorText("device", previouslyRegistered)).toBe(ALREADY_ON_DEVICE);
    expect(ALREADY_ON_DEVICE).toContain('Press "Sign with passkey" instead');
    expect(alreadyOnDevice(new RegistrationFailure("device", previouslyRegistered))).toBe(true);
    expect(alreadyOnDevice(new RegistrationFailure("verify", previouslyRegistered))).toBe(false);
    expect(alreadyOnDevice(new RegistrationFailure("device", new Error("other")))).toBe(false);
  });

  it("names a cancelled device prompt and keeps any other message", () => {
    const cancelled = Object.assign(new Error("The operation either timed out or was not allowed"), { name: "NotAllowedError" });
    expect(registrationErrorText("device", cancelled)).toBe("The passkey request was cancelled or took too long. Try again.");
    expect(registrationErrorText("device", new Error("No authenticator"))).toBe("No authenticator");
    expect(registrationErrorText("verify", apiError("UPSTREAM", 502))).toMatch(/\.$/);
  });
});

describe("founderKeyErrorText", () => {
  it("generate: a facility that is not open yet", () => {
    expect(founderKeyErrorText("generate", apiError("CONFLICT", 409))).toContain("Open it first (step 1)");
  });

  it("reject: not pending, already being saved, or approved and saved", () => {
    expect(founderKeyErrorText("reject", apiError("NOT_FOUND", 404))).toContain("no longer waiting");
    expect(founderKeyErrorText("reject", apiError("CONFLICT", 409))).toContain("it's being saved");
    expect(founderKeyErrorText("reject", apiError("FounderKeyAlreadySet", 409))).toContain("already approved and saved");
  });

  it("approve: a key that is no longer the pending registration", () => {
    expect(founderKeyErrorText("approve", apiError("CONFLICT", 409))).toContain("isn't waiting any more");
  });

  it("falls back to the error's title and the server's message", () => {
    expect(founderKeyErrorText("approve", apiError("UPSTREAM", 502, "Chain unreachable"))).toMatch(/: Chain unreachable$/);
  });
});

describe("timeLeft", () => {
  const expiresAt = "2026-10-18T09:15:00.000Z";
  const at = (iso: string) => Date.parse(iso);

  it("counts down in m:ss", () => {
    expect(timeLeft(expiresAt, at("2026-10-18T09:00:00.000Z"))).toBe("15:00");
    expect(timeLeft(expiresAt, at("2026-10-18T09:14:05.400Z"))).toBe("0:55");
  });

  it("is undefined once the code has expired", () => {
    expect(timeLeft(expiresAt, at("2026-10-18T09:15:00.000Z"))).toBeUndefined();
    expect(timeLeft(expiresAt, at("2026-10-18T10:00:00.000Z"))).toBeUndefined();
  });

  it("is undefined for an unreadable time (fail closed: treat the code as expired)", () => {
    expect(timeLeft("not a date", at("2026-10-18T09:00:00.000Z"))).toBeUndefined();
  });
});
