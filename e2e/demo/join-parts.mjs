#!/usr/bin/env node
// Joins the two-part recording (VIDEO-SCRIPT production step 2) into out/hogee-demo-1080p.mp4:
//   out/parts/main/      DEMO_PART=main on the mock's fresh scenario: Mei's journey and the CFO;
//   out/parts/evidence/  DEMO_PART=evidence on a REPLAY=<runId> server: the attacks and the evidence check.
// Each part records its scenes back to back and lists each scene's span (part.json `segments`). The join cuts every
// scene out of its part and concatenates them in the script's order (`timeline`: the attacks come between the payment
// and the CFO), moves each part's subtitles with its scenes, and burns them in one ffmpeg pass into the band under the
// browser's frame (ffmpeg.mjs APP_HEIGHT). Also writes out/subtitles.srt and out/scenes.json. Fails when the total
// passes 300 s (§19.2).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_HEIGHT, burnFilter, H264_OUTPUT, requireLibassFfmpeg } from "./ffmpeg.mjs";

export const MAX_SECONDS = 300;
const out = join(dirname(fileURLToPath(import.meta.url)), "out");

/**
 * The cut list: each scene of `timeline`, in order, from the part that recorded it, with where it lands in the final
 * video, and the cues clipped to the scenes they belong to and moved with them. Throws on a missing or doubled scene,
 * on parts that disagree on the order, or on a total over MAX_SECONDS.
 */
export function joinPlan(parts) {
  const timeline = parts[0]?.timeline;
  if (!Array.isArray(timeline) || parts.some((p) => JSON.stringify(p.timeline) !== JSON.stringify(timeline))) {
    throw new Error("the parts disagree on the scene order (record both with the same scenes.ts)");
  }
  const cuts = [];
  const cues = [];
  let offsetMs = 0;
  for (const id of timeline) {
    const owners = parts.flatMap((p, partIndex) => p.segments.filter((s) => s.id === id).map((s) => ({ partIndex, s })));
    if (owners.length !== 1) throw new Error(`scene ${id} was recorded ${owners.length} times, expected once`);
    const { partIndex, s } = owners[0];
    if (!(s.endMs > s.startMs)) throw new Error(`scene ${id} has an empty span`);
    cuts.push({ id, partIndex, fromMs: s.startMs, toMs: s.endMs, atMs: offsetMs });
    for (const c of parts[partIndex].cues) {
      const startMs = Math.max(c.startMs, s.startMs);
      const endMs = Math.min(c.endMs, s.endMs);
      if (endMs > startMs) cues.push({ startMs: startMs - s.startMs + offsetMs, endMs: endMs - s.startMs + offsetMs, text: c.text });
    }
    offsetMs += s.endMs - s.startMs;
  }
  const seconds = offsetMs / 1000;
  if (seconds > MAX_SECONDS) throw new Error(`the joined video is ${seconds.toFixed(1)} s, over the ${MAX_SECONDS} s ceiling (§19.2)`);
  return { cuts, cues, seconds };
}

/** The same SubRip stamps as srt.ts. */
const stamp = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor((t % 3_600_000) / 60_000))}:${pad(Math.floor((t % 60_000) / 1000))},${pad(t % 1000, 3)}`;
};
export const toSrt = (cues) => cues.map((c, i) => `${i + 1}\n${stamp(c.startMs)} --> ${stamp(c.endMs)}\n${c.text}\n`).join("\n");

/** One trim per cut (each input split into as many streams as it has cuts), concatenated, then the subtitles burned. */
export function filterGraph(cuts, parts, srt) {
  const sec = (ms) => (ms / 1000).toFixed(3);
  const split = parts.map((p, i) => {
    const n = cuts.filter((c) => c.partIndex === i).length;
    return n === 0 ? "" : `[${i}:v]split=${n}${Array.from({ length: n }, (_, k) => `[p${i}s${k}]`).join("")}`;
  });
  const used = parts.map(() => 0);
  const trims = cuts.map((c, k) => {
    const lead = parts[c.partIndex].leadMs;
    const src = `[p${c.partIndex}s${used[c.partIndex]++}]`;
    return `${src}trim=start=${sec(lead + c.fromMs)}:end=${sec(lead + c.toMs)},setpts=PTS-STARTPTS[c${k}]`;
  });
  const concat = `${cuts.map((_, k) => `[c${k}]`).join("")}concat=n=${cuts.length}:v=1:a=0,${burnFilter(srt)}[v]`;
  return [...split.filter(Boolean), ...trims, concat].join(";");
}

function readPart(name) {
  const dir = join(out, "parts", name);
  const video = join(dir, "hogee-demo.webm");
  const meta = join(dir, "part.json");
  for (const f of [video, meta]) {
    if (!existsSync(f)) {
      console.error(`Missing ${f}. Record both parts first: REPLAY=<runId> node demo/record-replay.mjs`);
      process.exit(1);
    }
  }
  const part = JSON.parse(readFileSync(meta, "utf8"));
  if (part.part !== name || !Number.isFinite(part.leadMs) || !Array.isArray(part.segments) || !Array.isArray(part.cues)) {
    console.error(`${meta} is not a ${name} part record`);
    process.exit(1);
  }
  // The join crops every part to the browser's frame above the subtitle band (ffmpeg.mjs APP_HEIGHT).
  if (part.frame?.width !== 1920 || part.frame?.height !== APP_HEIGHT) {
    console.error(`${meta}: the browser was ${part.frame?.width}×${part.frame?.height}, expected 1920×${APP_HEIGHT} (record again with this demo.spec.ts)`);
    process.exit(1);
  }
  return { ...part, video };
}

function main() {
  const parts = [readPart("main"), readPart("evidence")];
  const [mock, replay] = parts;
  if (!replay.mode.startsWith("replay:")) {
    console.error(`The evidence part was recorded in ${replay.mode} mode; it must be a REPLAY=<runId> recording`);
    process.exit(1);
  }
  if (mock.mode !== "mock") {
    console.error(`The main part was recorded in ${mock.mode} mode; record it on the mock (REPLAY unset)`);
    process.exit(1);
  }
  let plan;
  try {
    plan = joinPlan(parts);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  writeFileSync(join(out, "subtitles.srt"), toSrt(plan.cues));
  const scenes = plan.cuts.map((c) => ({ id: c.id, startMs: c.atMs, part: parts[c.partIndex].part }));
  writeFileSync(join(out, "scenes.json"), `${JSON.stringify({ seconds: plan.seconds, scenes, mode: `${mock.mode} + ${replay.mode}` }, null, 2)}\n`);

  requireLibassFfmpeg();
  const inputs = parts.flatMap((p) => ["-i", p.video]);
  const args = ["-y", ...inputs, "-filter_complex", filterGraph(plan.cuts, parts, "subtitles.srt"), "-map", "[v]", ...H264_OUTPUT, "hogee-demo-1080p.mp4"];
  const run = spawnSync("ffmpeg", args, { cwd: out, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
  console.log(`Wrote ${join(out, "hogee-demo-1080p.mp4")} (${plan.seconds.toFixed(1)} s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
