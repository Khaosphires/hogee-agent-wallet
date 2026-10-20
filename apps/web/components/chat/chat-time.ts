/**
 * When things happened in the chat, from evidence only (ux2-chat): a message gets a time when this page saw it arrive,
 * or when it is a button press whose single-use id is a UUIDv7 (the browser mints it at the press, so its first 48 bits
 * are the press time); a reply inherits the time of the press or message it answers. History without evidence gets no
 * time: nothing is made up. The thread prints a quiet centred time where a stretch of the conversation starts.
 */

const UUIDV7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A press before 2024 or after 2100 is not a real press time: a malformed or made-up id. */
const EARLIEST = Date.UTC(2024, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);

/** The unix ms a UUIDv7 carries, or null for anything that is not a plausible v7 id. */
export function uuidv7Ms(id: string): number | null {
  const m = UUIDV7.exec(id);
  if (!m) return null;
  const ms = Number.parseInt(`${m[1]}${m[2]}`, 16);
  return ms >= EARLIEST && ms < LATEST ? ms : null;
}

/** The slice of a UI message this module reads. */
export interface TimedMessage {
  readonly id: string;
  readonly role: string;
  readonly parts: readonly { readonly type: string; readonly data?: unknown }[];
}

const actionIdOf = (m: TimedMessage): string | null => {
  if (m.role !== "user") return null;
  for (const p of m.parts) {
    if (p.type !== "data-action") continue;
    const action = (p.data as { action?: { actionId?: unknown } } | undefined)?.action;
    return typeof action?.actionId === "string" ? action.actionId : null;
  }
  return null;
};

/**
 * The action ids the server minted inside its replies' Next buttons (core nextPart): a press of one of those carries
 * the time the reply was written, not the time of the press, so it is never read as a press time.
 */
export function serverMintedIds(messages: readonly TimedMessage[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role === "user") continue;
    for (const p of m.parts) {
      if (p.type !== "data-next") continue;
      const actions = (p.data as { actions?: readonly { action?: { actionId?: unknown } }[] } | undefined)?.actions ?? [];
      for (const a of actions) if (typeof a.action?.actionId === "string") out.add(a.action.actionId);
    }
  }
  return out;
}

/**
 * A press's time: when this page saw it pressed (`pressedAt`, by action id), else the time its UUIDv7 id carries when
 * the browser minted it at the press; a Next button's server-minted id gives none.
 */
export function pressTime(actionId: string, pressedAt: ReadonlyMap<string, number>, minted: ReadonlySet<string>): number | null {
  return pressedAt.get(actionId) ?? (minted.has(actionId) ? null : uuidv7Ms(actionId));
}

/**
 * Each message's time where there is evidence: `seen` (ms this page sent a typed message), else a press's time
 * (pressTime), else (a reply) the time of the message just before it. Pure.
 */
export function messageTimes(
  messages: readonly TimedMessage[],
  seen: ReadonlyMap<string, number>,
  pressedAt: ReadonlyMap<string, number> = new Map(),
): ReadonlyMap<string, number> {
  const minted = serverMintedIds(messages);
  const out = new Map<string, number>();
  let previous: number | null = null;
  for (const m of messages) {
    const action = actionIdOf(m);
    const own = seen.get(m.id) ?? (action ? pressTime(action, pressedAt, minted) : null);
    const at: number | null = own ?? (m.role === "assistant" ? previous : null);
    if (at !== null) out.set(m.id, at);
    previous = at;
  }
  return out;
}

/** Thirty minutes between two known times starts a new stretch of the conversation (a new centred time). */
export const BREAK_GAP_MS = 30 * 60_000;

/**
 * The ids of the messages that open a stretch: the first message with a known time, then each one whose time is at
 * least `gapMs` after the last known time, or on another day in `timeZone`. Pure.
 */
export function timeBreaks(messages: readonly TimedMessage[], times: ReadonlyMap<string, number>, timeZone: string, gapMs = BREAK_GAP_MS): ReadonlySet<string> {
  const out = new Set<string>();
  let last: number | null = null;
  for (const m of messages) {
    const at = times.get(m.id);
    if (at === undefined) continue;
    if (last === null || at - last >= gapMs || dayKey(at, timeZone) !== dayKey(last, timeZone)) out.add(m.id);
    last = at;
  }
  return out;
}

/** The facility's zone for a display currency (SGD → Singapore, MYR → Kuala Lumpur), else UTC rather than a guess. */
export function zoneOfCurrency(currency: string | undefined): string {
  if (currency === "SGD") return "Asia/Singapore";
  if (currency === "MYR") return "Asia/Kuala_Lumpur";
  return "UTC";
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, kind: "day" | "clock" | "date"): Intl.DateTimeFormat {
  const key = `${timeZone}:${kind}`;
  let f = formatters.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions =
      kind === "day"
        ? { year: "numeric", month: "2-digit", day: "2-digit", timeZone }
        : kind === "clock"
          ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }
          : { day: "numeric", month: "short", timeZone };
    // en-US for the month: en-GB now says "Sept", and the app writes "28 Sep" (DESIGN.md §2).
    f = new Intl.DateTimeFormat(kind === "day" ? "en-CA" : kind === "date" ? "en-US" : "en-GB", options);
    formatters.set(key, f);
  }
  return f;
}

/** "2026-10-19" in the zone: two times share a day when their keys match. */
export const dayKey = (ms: number, timeZone: string): string => fmt(timeZone, "day").format(new Date(ms));

const DAY_MS = 86_400_000;

/** "28 Sep" in the zone (day first, whatever the formatter's own order). */
function shortDate(ms: number, timeZone: string): string {
  const parts = fmt(timeZone, "date").formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")}`;
}

/** A centred stretch time: "Today, 14:02", "Yesterday, 09:15" or "28 Sep, 10:14", in the facility's zone. */
export function stretchLabel(ms: number, nowMs: number, timeZone: string): string {
  const clock = fmt(timeZone, "clock").format(new Date(ms));
  const day = dayKey(ms, timeZone);
  if (day === dayKey(nowMs, timeZone)) return `Today, ${clock}`;
  if (day === dayKey(nowMs - DAY_MS, timeZone)) return `Yesterday, ${clock}`;
  return `${shortDate(ms, timeZone)}, ${clock}`;
}

/** "Just now", "5 min ago", "2 h ago", "Yesterday", "3 days ago", then the date ("28 Sep"). A future time reads "Just now". */
export function relativeTime(ms: number, nowMs: number, timeZone: string): string {
  const ago = nowMs - ms;
  if (ago < 60_000) return "Just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  if (dayKey(ms, timeZone) === dayKey(nowMs, timeZone)) return `${Math.floor(ago / 3_600_000)} h ago`;
  if (dayKey(ms, timeZone) === dayKey(nowMs - DAY_MS, timeZone)) return "Yesterday";
  const days = Math.max(2, Math.round(ago / DAY_MS));
  return days < 7 ? `${days} days ago` : shortDate(ms, timeZone);
}
