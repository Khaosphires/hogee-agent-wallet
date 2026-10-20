/**
 * How often the agent may tighten a line (fixr-cfo, re-check LOW 3: the guard must not ratchet a line down pass after
 * pass): at most once per rolling max(windowSeconds, 1 day). A line the agent lowered less than that ago is left alone,
 * and its BURN_ALERT links the prefilled change request that raises the lowered cap back to its committed value. The
 * reserve is not a line: it stays at one raise per UTC day (tighten.ts).
 */
import { raiseCapHref } from "./text";
import type { CfoAgentAction, CfoInputs, CfoLineIn } from "./types";

const DAY_SECONDS = 86_400n;

/** The line's cooldown in milliseconds: its rolling window, never less than a day. */
export function cooldownMs(line: CfoLineIn): number {
  const ws = line.windowSeconds ?? 0n;
  return Number(ws > DAY_SECONDS ? ws : DAY_SECONDS) * 1000;
}

/** The agent's latest action on `line` within its cooldown (a future-dated one counts too), or null. */
export function recentTightening(i: CfoInputs, line: CfoLineIn, nowMs: number): CfoAgentAction | null {
  const within = i.agentActions.filter((a) => a.lineKey === line.lineKey && a.action !== "RAISE_RESERVE_BPS" && nowMs - Date.parse(a.at) < cooldownMs(line));
  return within.reduce<CfoAgentAction | null>((latest, a) => (latest === null || Date.parse(a.at) > Date.parse(latest.at) ? a : latest), null);
}

/** The prefilled request raising the cap the agent recently lowered on `line` back to its committed value, or null. */
export function raiseBackHref(i: CfoInputs, line: CfoLineIn, nowMs: number): string | null {
  const a = recentTightening(i, line, nowMs);
  if (a?.action === "LOWER_WINDOW_CAP" && line.committedWindowCapMinor !== undefined) return raiseCapHref(line.lineKey, "window", line.committedWindowCapMinor);
  if (a?.action === "LOWER_PER_TX_CAP" && line.committedPerTxCapMinor !== undefined) return raiseCapHref(line.lineKey, "perTx", line.committedPerTxCapMinor);
  return null;
}
