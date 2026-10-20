/**
 * Overlays for the recorded video (§19.2): a "what is being clicked" badge, a source label that stays on screen for the
 * whole part (where the pictures come from: the mock or a replay, so mock screens are never taken for live ones), and
 * (only with HOGEE_DEMO_CAPTIONS=screen) a caption bar. By default captions go to subtitles.srt and are burned in by
 * ffmpeg, so they never appear twice. Next's dev indicator is hidden in recordings.
 */
import type { Locator, Page } from "@playwright/test";

const ON_SCREEN_CAPTIONS = process.env.HOGEE_DEMO_CAPTIONS === "screen";

const INIT = () => {
  const ensure = (): { caption: HTMLDivElement; action: HTMLDivElement } => {
    let root = document.getElementById("hogee-demo-overlay");
    if (!root) {
      root = document.createElement("div");
      root.id = "hogee-demo-overlay";
      root.innerHTML =
        "<style>nextjs-portal{display:none!important}</style>" +
        '<div data-caption style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:1400px;padding:14px 22px;border-radius:12px;background:rgba(17,24,39,.86);color:#fff;font:600 26px/1.35 system-ui,sans-serif;text-align:center;z-index:2147483647;pointer-events:none;display:none"></div>' +
        '<div data-action style="position:fixed;right:28px;top:84px;padding:8px 14px;border-radius:999px;background:#0f766e;color:#fff;font:600 18px system-ui,sans-serif;z-index:2147483647;pointer-events:none;display:none"></div>' +
        '<div data-source style="position:fixed;left:24px;top:84px;max-width:340px;padding:6px 12px;border-radius:8px;background:rgba(17,24,39,.78);color:#fff;font:600 15px/1.3 system-ui,sans-serif;z-index:2147483647;pointer-events:none;display:none"></div>';
      document.documentElement.appendChild(root);
    }
    const source = root.querySelector("[data-source]") as HTMLDivElement;
    const label = (window as unknown as { __hogeeSourceText?: string }).__hogeeSourceText ?? "";
    source.textContent = label;
    source.style.display = label ? "block" : "none";
    return { caption: root.querySelector("[data-caption]") as HTMLDivElement, action: root.querySelector("[data-action]") as HTMLDivElement };
  };
  const w = window as unknown as { __hogeeCaption: (t: string) => void; __hogeeAction: (t: string) => void; __hogeeSource: () => void };
  w.__hogeeSource = () => void ensure();
  w.__hogeeCaption = (t) => {
    const { caption } = ensure();
    caption.textContent = t;
    caption.style.display = t ? "block" : "none";
  };
  w.__hogeeAction = (t) => {
    const { action } = ensure();
    action.textContent = t;
    action.style.display = t ? "block" : "none";
  };
  document.addEventListener("DOMContentLoaded", () => ensure());
};

export async function installOverlay(page: Page): Promise<void> {
  await page.addInitScript(INIT);
}

/**
 * The source label for every page from now on (an init script, so it survives navigations) and the current one: what
 * the viewer is looking at, e.g. "Mock: simulated chain, recorded web search, sample sales".
 */
export async function setSource(page: Page, text: string): Promise<void> {
  await page.addInitScript((t) => {
    (window as unknown as { __hogeeSourceText?: string }).__hogeeSourceText = t;
  }, text);
  await page.evaluate((t) => {
    const w = window as unknown as { __hogeeSourceText?: string; __hogeeSource?: () => void };
    w.__hogeeSourceText = t;
    w.__hogeeSource?.();
  }, text);
}

/** Draws the caption only with HOGEE_DEMO_CAPTIONS=screen (otherwise it goes to the SRT only). */
export async function caption(page: Page, text: string): Promise<void> {
  if (!ON_SCREEN_CAPTIONS) return;
  await page.evaluate((t) => (window as unknown as { __hogeeCaption?: (t: string) => void }).__hogeeCaption?.(t), text);
}

/** Shows what is about to be clicked, outlines it, clicks, then clears both. */
export async function act(page: Page, label: string, target: Locator, pauseMs = 700): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate((t) => (window as unknown as { __hogeeAction?: (t: string) => void }).__hogeeAction?.(t), `▶ ${label}`);
  const handle = await target.elementHandle();
  await handle?.evaluate((el) => {
    (el as HTMLElement).style.outline = "3px solid #f59e0b";
    (el as HTMLElement).style.outlineOffset = "3px";
  });
  await page.waitForTimeout(pauseMs);
  await target.click();
  await handle?.evaluate((el) => {
    (el as HTMLElement).style.outline = "";
    (el as HTMLElement).style.outlineOffset = "";
  }).catch(() => undefined);
  await page.evaluate(() => (window as unknown as { __hogeeAction?: (t: string) => void }).__hogeeAction?.("")).catch(() => undefined);
}
