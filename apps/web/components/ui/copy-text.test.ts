/** The copy button's clipboard step: it reports "copied" only when the browser accepted the text, and never throws. */
import { describe, expect, it } from "vitest";
import { COPY_FAILED_TEXT, copyStatusText, copyText, type ClipboardWriter } from "./copy-text";

const writer = (impl: (text: string) => Promise<void>): ClipboardWriter & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    writeText: (text: string) => {
      calls.push(text);
      return impl(text);
    },
  };
};

describe("copyText", () => {
  it("is copied once the clipboard accepts the exact text", async () => {
    const clipboard = writer(() => Promise.resolve());
    await expect(copyText("0xabc…", clipboard)).resolves.toBe("copied");
    expect(clipboard.calls).toEqual(["0xabc…"]);
  });

  it("fails when there is no clipboard (insecure context, old browser, server render)", async () => {
    await expect(copyText("x", undefined)).resolves.toBe("failed");
    await expect(copyText("x", null)).resolves.toBe("failed");
  });

  it("fails when the clipboard object has no writeText", async () => {
    await expect(copyText("x", {} as unknown as ClipboardWriter)).resolves.toBe("failed");
  });

  it("fails when the browser refuses the write (permission denied, document not focused)", async () => {
    const clipboard = writer(() => Promise.reject(new DOMException("Document is not focused.", "NotAllowedError")));
    await expect(copyText("x", clipboard)).resolves.toBe("failed");
  });

  it("fails, without throwing, when writeText throws synchronously", async () => {
    const clipboard: ClipboardWriter = {
      writeText: () => {
        throw new TypeError("Illegal invocation");
      },
    };
    await expect(copyText("x", clipboard)).resolves.toBe("failed");
  });
});

describe("copyStatusText (the polite live region)", () => {
  it("is empty while idle, the copied label after a copy, and the fallback hint after a failure", () => {
    expect(copyStatusText("idle", "Copied")).toBe("");
    expect(copyStatusText("copied", "Copied")).toBe("Copied");
    expect(copyStatusText("failed", "Copied")).toBe(COPY_FAILED_TEXT);
    expect(COPY_FAILED_TEXT).toBe("Copy failed — select the text");
  });

  it("uses a caller's own failure hint when given one", () => {
    expect(copyStatusText("failed", "Copied", "Copy failed — select the address")).toBe("Copy failed — select the address");
  });
});
