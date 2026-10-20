/**
 * The demo video's script and its join, checked without recording (demo/scenes.ts, demo/join-parts.mjs): every
 * caption and source label passes the wording rule, the scenes follow VIDEO-SCRIPT.md's order within 5 minutes, each
 * part names its source, the cooling the pay scene states is the one record-replay.mjs gives the mock server, and the
 * join puts each part's scenes and subtitles in the script's order.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { bannedWordsIn } from "../support/app";
import {
  ATTACK_BEATS,
  CFO_NOTHING_TIGHTENED,
  DEMO_COOLING_SECONDS,
  MAX_SECONDS,
  PLANNED_END_SECONDS,
  REPLAY_SCENES,
  SCENES,
  SOURCE_LABEL,
  chainWords,
  fillCaption,
  slotMs,
} from "../demo/scenes";

const DEMO = join(dirname(fileURLToPath(import.meta.url)), "..", "demo");
const CHAINS = [chainWords(11_155_111), chainWords(31_337)];

interface Cut {
  readonly id: string;
  readonly partIndex: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly atMs: number;
}
interface PartRecord {
  readonly timeline: readonly string[];
  readonly leadMs: number;
  readonly segments: readonly { id: string; startMs: number; endMs: number }[];
  readonly cues: readonly { startMs: number; endMs: number; text: string }[];
}
const { joinPlan } = (await import(pathToFileURL(join(DEMO, "join-parts.mjs")).href)) as {
  joinPlan: (parts: readonly PartRecord[]) => { cuts: Cut[]; cues: { startMs: number; endMs: number; text: string }[]; seconds: number };
};

test("every caption and source label passes the wording rule, on either replay chain", () => {
  for (const chain of CHAINS) {
    for (const c of [...SCENES.flatMap((s) => s.captions), CFO_NOTHING_TIGHTENED]) expect(bannedWordsIn(fillCaption(c, chain)), c).toEqual([]);
    for (const label of Object.values(SOURCE_LABEL)) expect(bannedWordsIn(fillCaption(label, chain)), label).toEqual([]);
  }
});

test("the scenes follow VIDEO-SCRIPT.md's order within 5 minutes, each with its source", () => {
  expect(SCENES.map((s) => s.id)).toEqual(["hook", "needs", "search", "enquiry", "terms", "pay", "balance", "attacks", "cfo", "verify"]);
  expect(REPLAY_SCENES).toEqual(["attacks", "verify"]);
  const starts = SCENES.map((s) => s.at);
  expect(starts, "planned starts in order").toEqual([...starts].sort((a, b) => a - b));
  expect(PLANNED_END_SECONDS).toBeLessThanOrEqual(MAX_SECONDS);
  for (const s of SCENES) expect(slotMs(s.id), s.id).toBeGreaterThan(0);
  expect(SOURCE_LABEL.mock).toMatch(/^Mock\b/);
  expect(SOURCE_LABEL.replay).toMatch(/^Replay\b.*\{chain\}/);
  // The replay opens by saying it is one, on the bundle's own chain; no replay caption names a chain itself.
  expect(SCENES.find((s) => s.id === "attacks")?.captions[0]).toMatch(/\breplay\b.*\{chain\}/);
  for (const s of SCENES.filter((x) => x.source === "replay")) for (const c of s.captions) expect(c, `${s.id}: ${c}`).not.toMatch(/Sepolia|Anvil/);
  // Each attack beat has its caption.
  const attacks = SCENES.find((s) => s.id === "attacks");
  for (const beat of ATTACK_BEATS) expect(attacks?.captions[beat.caption], beat.taskId).toBeTruthy();
});

test("the pay scene states the cooling that record-replay.mjs gives the mock server", () => {
  const pay = SCENES.find((s) => s.id === "pay");
  expect(pay?.captions[0]).toContain(`${DEMO_COOLING_SECONDS} in this recording`);
  const recorder = readFileSync(join(DEMO, "record-replay.mjs"), "utf8");
  expect(recorder).toContain(`const DEMO_COOLING_SECONDS = "${DEMO_COOLING_SECONDS}";`);
});

test("the join puts each part's scenes and subtitles in the script's order", () => {
  const timeline = SCENES.map((s) => s.id);
  // Each part records its own scenes back to back (ms from its director's start).
  const seg = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });
  const main: PartRecord = {
    timeline,
    leadMs: 2_000,
    segments: [
      seg("hook", 0, 20_000),
      seg("needs", 20_000, 65_000),
      seg("search", 65_000, 105_000),
      seg("enquiry", 105_000, 125_000),
      seg("terms", 125_000, 160_000),
      seg("pay", 160_000, 192_000),
      seg("balance", 192_000, 200_000),
      seg("cfo", 200_000, 227_000),
    ],
    cues: [
      { startMs: 170_000, endMs: 192_000, text: "pay line" },
      { startMs: 203_000, endMs: 227_000, text: "cfo line" },
    ],
  };
  const replay: PartRecord = {
    timeline,
    leadMs: 1_500,
    segments: [seg("attacks", 0, 35_000), seg("verify", 35_000, 65_000)],
    cues: [{ startMs: 1_000, endMs: 35_000, text: "attack line" }],
  };
  const plan = joinPlan([main, replay]);
  expect(plan.cuts.map((c) => c.id)).toEqual(timeline);
  const at = (id: string) => plan.cuts.find((c) => c.id === id)?.atMs;
  // The attacks start where the balance scene ends, and the CFO after the attacks.
  expect(at("attacks")).toBe(200_000);
  expect(at("cfo")).toBe(235_000);
  expect(at("verify")).toBe(262_000);
  expect(plan.seconds).toBe(292);
  expect(plan.cues).toEqual([
    { startMs: 170_000, endMs: 192_000, text: "pay line" },
    { startMs: 201_000, endMs: 235_000, text: "attack line" },
    { startMs: 238_000, endMs: 262_000, text: "cfo line" },
  ]);
  expect(() => joinPlan([main, { ...replay, segments: replay.segments.slice(0, 1) }])).toThrow(/verify was recorded 0 times/);
  expect(() => joinPlan([main, { ...replay, segments: [...replay.segments, seg("verify", 65_000, 100_000)] }])).toThrow(/recorded 2 times/);
  expect(() => joinPlan([main, { ...replay, segments: [seg("attacks", 0, 35_000), seg("verify", 35_000, 80_000)] }])).toThrow(/over the 300 s ceiling/);
});
