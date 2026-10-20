/**
 * Live-API outcomes the pages explain in plain English rather than as a generic error (P1's live notes, 18 Oct):
 * a country pack that lacks a fact the plan needs, a failed chat turn, and inspection uploads.
 */
import { ApiError, httpStatusFor, routes } from "@hogee/api-contract";
import { errorCopy } from "@hogee/core";
import type { ApiClientError } from "./api/client";

/** details.reason of a 409 COMPILE_FAILED from a pack gap (core exports the same string from p1/dev on). */
export const PACK_FACT_MISSING = "PACK_FACT_MISSING";

/** The API's cap on an upload's whole multipart body (packages/api http/register.ts MAX_UPLOAD_BYTES). */
export const API_UPLOAD_CAP_BYTES = 10 * 1024 * 1024;
/** Room for the multipart boundaries, part headers and file name, which count toward the API's cap. */
const MULTIPART_MARGIN_BYTES = 64 * 1024;
/** The largest file the page sends: bigger ones are refused by the API, and the browser may only see a reset. */
export const MAX_UPLOAD_BYTES = API_UPLOAD_CAP_BYTES - MULTIPART_MARGIN_BYTES;
/**
 * The limit as shown ("9.9 MB", the word people know), from the MiB figure rounded down: a file of the shown size
 * always fits, since 9.9 MB (decimal) is smaller still than 9.9 MiB.
 */
export const MAX_UPLOAD_LABEL = `${Math.floor((MAX_UPLOAD_BYTES / (1024 * 1024)) * 10) / 10} MB`;

/**
 * The country-pack facts a compile needed and didn't find, when the error is that refusal:
 * 409 COMPILE_FAILED with details {reason: "PACK_FACT_MISSING", missingFacts: ["indirectTax.rate", ...]}.
 */
export function missingPackFacts(error: ApiClientError | null | undefined): string[] | undefined {
  if (error?.code !== "COMPILE_FAILED") return undefined;
  const details = error.details;
  if (details?.reason !== PACK_FACT_MISSING || !Array.isArray(details.missingFacts)) return undefined;
  return details.missingFacts.filter((fact): fact is string => typeof fact === "string");
}

/** The ApiError envelope ({"error": {...}}) the chat transport throws as the error's message, if it is one. */
function chatEnvelope(error: Error): ApiError["error"] | undefined {
  try {
    const parsed = ApiError.safeParse(JSON.parse(error.message));
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    // Not JSON: a network failure, a broken stream or a non-API body.
    return undefined;
  }
}

/**
 * The server's own message for a failed chat turn. The chat transport throws the response body as the error's
 * message, so an ApiError envelope ({"error": {...}}) is unwrapped; anything else is shown as it is.
 */
export function chatErrorMessage(error: Error): string {
  return chatEnvelope(error)?.message ?? error.message;
}

export interface ChatFailure {
  /** The assistant itself is down (an answer of 500 or more, or no API answer): say so and offer Try again. */
  readonly unavailable: boolean;
  readonly title: string;
  /** The server's own message, or what happened when no API answer came back. */
  readonly message: string;
}

const CHAT_DOWN = "The assistant is unavailable right now";

/**
 * A failed chat turn in plain English (P1 review of #10). Only a 5xx answer, or none, means the assistant is down; a
 * 4xx is a refusal of this turn, shown as its @hogee/core copy and the server's message (retrying it won't help). The
 * status is the one the API sets for the code on POST /api/chat (httpStatusFor).
 */
export function chatFailure(error: Error): ChatFailure {
  const envelope = chatEnvelope(error);
  if (!envelope) {
    return { unavailable: true, title: CHAT_DOWN, message: "No answer came back from the server. Check that the app is still running, then try again." };
  }
  if (httpStatusFor(routes.chat, envelope.code) >= 500) return { unavailable: true, title: CHAT_DOWN, message: envelope.message };
  return { unavailable: false, title: errorCopy(envelope.code).title, message: envelope.message };
}

/** A message as a sentence: trimmed, with a full stop unless it already ends a sentence. */
const sentence = (text: string): string => {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * An inspection upload's failure in plain English (P1 review of #10). The 404 means no milestone of the order takes
 * evidence now: it was released, its release is being signed (until that request expires), or the order is unknown.
 * Status 0 means no answer, which is how an oversized upload often looks (the API resets it).
 */
export function uploadErrorText(error: ApiClientError): string {
  if (error.code === "NOT_FOUND") {
    return `${sentence(error.message)} This happens when this payment was already made, when it's waiting for your signature (you can upload again if that request runs out), or when Hogee doesn't know the order.`;
  }
  if (error.status === 0) return `The upload didn't reach Hogee. If the file is big, try a smaller one (under ${MAX_UPLOAD_LABEL}).`;
  return `${errorCopy(error.code).title}: ${error.message}`;
}
