import { describe, expect, it } from "vitest";
import { ApiClientError } from "./api/client";
import { API_UPLOAD_CAP_BYTES, chatErrorMessage, chatFailure, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, missingPackFacts, uploadErrorText } from "./live-errors";

const compileFailed = (details?: Record<string, unknown>) => new ApiClientError("COMPILE_FAILED", "refused", 409, undefined, undefined, details);

describe("missingPackFacts", () => {
  it("lists the facts of a PACK_FACT_MISSING refusal", () => {
    expect(missingPackFacts(compileFailed({ reason: "PACK_FACT_MISSING", missingFacts: ["indirectTax.rate", 3, "customs.deMinimisMinor"] }))).toEqual([
      "indirectTax.rate",
      "customs.deMinimisMinor",
    ]);
  });

  it("ignores constitution violations, other codes and missing details", () => {
    expect(missingPackFacts(compileFailed({ violations: [{ code: "RESERVE_BELOW_FLOOR", message: "x" }] }))).toBeUndefined();
    expect(missingPackFacts(compileFailed())).toBeUndefined();
    expect(missingPackFacts(new ApiClientError("VALIDATION", "bad", 422, undefined, undefined, { reason: "PACK_FACT_MISSING", missingFacts: [] }))).toBeUndefined();
    expect(missingPackFacts(null)).toBeUndefined();
  });
});

describe("chatErrorMessage", () => {
  it("unwraps the ApiError envelope the chat transport throws", () => {
    const body = JSON.stringify({ error: { code: "UPSTREAM", message: "Privacy redaction is unavailable" } });
    expect(chatErrorMessage(new Error(body))).toBe("Privacy redaction is unavailable");
  });

  it("keeps any other message as it is", () => {
    expect(chatErrorMessage(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(chatErrorMessage(new Error('{"not":"an api error"}'))).toBe('{"not":"an api error"}');
  });
});

const envelope = (code: string, message: string) => new Error(JSON.stringify({ error: { code, message } }));

describe("chatFailure", () => {
  it("says the assistant is unavailable for a 5xx answer, with the server's message", () => {
    expect(chatFailure(envelope("UPSTREAM", "Privacy redaction is unavailable"))).toEqual({
      unavailable: true,
      title: "The assistant is unavailable right now",
      message: "Privacy redaction is unavailable",
    });
  });

  it("says the assistant is unavailable when no API answer came back", () => {
    for (const e of [new Error("Failed to fetch"), new Error("<!DOCTYPE html><html>500</html>"), new Error('{"not":"an api error"}')]) {
      const f = chatFailure(e);
      expect(f.unavailable, e.message).toBe(true);
      expect(f.message).not.toContain("<");
    }
  });

  it("shows a refusal (4xx) as itself, with the server's message and no retry", () => {
    expect(chatFailure(envelope("VALIDATION", "The message is too long"))).toEqual({ unavailable: false, title: "Check the input", message: "The message is too long" });
    expect(chatFailure(envelope("FORBIDDEN", "Only the founder can chat"))).toEqual({ unavailable: false, title: "Not allowed for this role", message: "Only the founder can chat" });
    expect(chatFailure(envelope("CONFLICT", "The facility is not open")).unavailable).toBe(false);
  });
});

describe("upload limit", () => {
  it("leaves room under the API's 10 MiB cap for the multipart overhead", () => {
    expect(API_UPLOAD_CAP_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(API_UPLOAD_CAP_BYTES - 16 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(9 * 1024 * 1024);
    // The shown limit is rounded down, so a file of the shown size always fits.
    expect(MAX_UPLOAD_LABEL).toBe("9.9 MB");
    expect(9.9 * 1024 * 1024).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
  });
});

describe("uploadErrorText", () => {
  const notFound = new ApiClientError("NOT_FOUND", "No escrow milestone of that order is waiting for inspection evidence (or its release is already being signed)", 404);

  it("explains the inspection 404 without calling it frozen, and keeps the server's message", () => {
    const text = uploadErrorText(notFound);
    expect(text).toContain("No escrow milestone of that order is waiting for inspection evidence (or its release is already being signed).");
    expect(text).toMatch(/already made/);
    expect(text).toMatch(/waiting for your signature/);
    expect(text).toMatch(/runs out/);
    expect(text).toMatch(/doesn't know the order/);
    expect(text.toLowerCase()).not.toContain("frozen");
  });

  it("doesn't double the full stop of a server message that has one", () => {
    expect(uploadErrorText(new ApiClientError("NOT_FOUND", "No such order.", 404))).toMatch(/^No such order\. /);
  });

  it("explains an upload that never got an answer, with the shown limit", () => {
    expect(uploadErrorText(new ApiClientError("UPSTREAM", "Can't reach the Hogee API", 0))).toBe(
      "The upload didn't reach Hogee. If the file is big, try a smaller one (under 9.9 MB).",
    );
  });

  it("shows any other refusal as its plain-English title and the server's message", () => {
    expect(uploadErrorText(new ApiClientError("VALIDATION", "Upload a PDF, JPEG or PNG inspection report", 422))).toBe("Check the input: Upload a PDF, JPEG or PNG inspection report");
    expect(uploadErrorText(new ApiClientError("UPSTREAM", "The API answered 502", 502))).toBe("Service unavailable: The API answered 502");
  });
});
