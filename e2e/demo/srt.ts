/** SubRip subtitles from the measured caption timings. */
export interface Cue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

const stamp = (ms: number): string => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const f = t % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(f).padStart(3, "0")}`;
};

export function toSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startMs)} --> ${stamp(c.endMs)}\n${c.text}\n`).join("\n");
}
