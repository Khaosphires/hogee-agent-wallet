// Used by join-parts.mjs: the ffmpeg checks, the subtitle style and the H.264 output settings
// of the demo video (16:9, 1080p, H.264, burned-in subtitles, no audio; §19.2).
import { spawnSync } from "node:child_process";

/** Exits with a hint unless `ffmpeg` on PATH has the subtitles filter (libass). */
export function requireLibassFfmpeg() {
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
    console.error("ffmpeg is not on PATH. Install it (with libass), then run this script again.");
    process.exit(1);
  }
  // Homebrew's plain `ffmpeg` has no libass; `ffmpeg-full` does (keg-only: PATH=/opt/homebrew/opt/ffmpeg-full/bin:$PATH).
  const filters = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
  if (filters.status !== 0 || !/^\s*\S*\s+subtitles\s/m.test(filters.stdout)) {
    console.error("This ffmpeg has no subtitles filter (libass). On macOS: brew install ffmpeg-full, then PATH=/opt/homebrew/opt/ffmpeg-full/bin:$PATH");
    process.exit(1);
  }
}

/**
 * The browser's height in each part (demo.spec.ts records at 1920×APP_HEIGHT, scenes.ts RECORDED_APP_HEIGHT; Playwright
 * pads its 1920×1080 video below it). The 150 px under it is the subtitle band, so a subtitle never covers the app.
 */
export const APP_HEIGHT = 930;
const BAND_COLOUR = "0x111827";

// libass lays an SRT out on a 384×288 canvas and scales it to the video: one unit is 3.75 px at 1080p. FontSize 13 is
// about 49 px; MarginV 9 (about 34 px) keeps two lines inside the 150 px band. White text with a thin dark outline.
const STYLE = "FontName=Arial,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0,MarginV=9";

/**
 * Keep the browser's frame, fill the band under it, and burn `srt` into the band. The subtitles filter takes a
 * filtergraph path: run ffmpeg inside the folder that holds `srt`, so the relative name needs no escaping. Playwright's
 * recording is full range (yuvj); out_range=tv gives the standard limited-range yuv420p players expect.
 */
export const burnFilter = (srt) =>
  `crop=1920:${APP_HEIGHT}:0:0,scale=1920:${APP_HEIGHT}:out_range=tv,pad=1920:1080:0:0:color=${BAND_COLOUR},subtitles=${srt}:force_style='${STYLE}'`;

/** H.264, limited-range yuv420p, fast start, no audio. */
export const H264_OUTPUT = ["-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p", "-color_range", "tv", "-movflags", "+faststart", "-an"];
