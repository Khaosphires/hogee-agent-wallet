/**
 * The clipboard step behind <CopyButton>, kept free of React so it can be unit-tested. The browser can refuse a
 * write for many reasons (no clipboard on http, permission denied, document not focused): every one of them is a
 * "failed" outcome the button shows, never a thrown error and never a false "copied".
 */

export type CopyOutcome = "copied" | "failed";
export type CopyStatus = "idle" | CopyOutcome;

/** The one clipboard method the button needs (navigator.clipboard satisfies it). */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/** How long the button says "Copied" before it returns to its label. */
export const COPIED_MS = 2_000;

export const COPY_FAILED_TEXT = "Copy failed — select the text";

/** Writes `text` to the clipboard; resolves "copied" only once the browser has accepted it. */
export async function copyText(text: string, clipboard: ClipboardWriter | null | undefined): Promise<CopyOutcome> {
  if (!clipboard || typeof clipboard.writeText !== "function") return "failed";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    // The refusal is shown to the person as the failure hint; there is nothing else to recover.
    return "failed";
  }
}

/** The text for the polite live region: silent while idle, so nothing is announced on render. */
export function copyStatusText(status: CopyStatus, copiedLabel: string, failedText: string = COPY_FAILED_TEXT): string {
  if (status === "copied") return copiedLabel;
  if (status === "failed") return failedText;
  return "";
}
