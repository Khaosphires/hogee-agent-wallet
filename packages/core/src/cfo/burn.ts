/**
 * Is a line burning faster than planned? Shared by the BURN_ALERT insight and proposeTightenings.
 *
 * Over the last n = min(7, sampleDays) UTC days (today included), compare the line's AGENT spend (SPEND: the payments the
 * agent itself made; never the founder's OWNER_SPEND or escrow, which the guard does not control) with its pace:
 *   - a pacing line: one pacing slot a day (Treasury takes at most one slot per line per day), pace = pacing × n;
 *   - any other line: the even rate that spends what it had at the start of those days (available + their spend)
 *     by validUntil, pace = (available + spend) × n / (daysLeft + n).
 * Burning = spend > 1.5 × pace (exact integer comparison). Needs ≥ 3 days of data and a live line (validUntil > now).
 */
import { LINE_KEYS, type LineKey } from "../schemas/enums";
import { MIN_SAMPLE_DAYS, SECONDS_PER_DAY, maDays, sumDays, unixSeconds, type Ledger } from "./ledger";
import type { CfoInputs, CfoLineIn } from "./types";

export interface LineBurn {
  readonly lineKey: LineKey;
  readonly days: number;
  readonly spentMinor: bigint;
  /** Pace over `days`, rounded down (display). */
  readonly paceMinor: bigint;
  /** spend / pace in tenths, rounded down (display). */
  readonly ratioTenths: bigint;
  /** Exact pace as a fraction per day: paceNum / paceDen minor a day. */
  readonly paceNum: bigint;
  readonly paceDen: bigint;
  /** 0 when not a pacing line. */
  readonly pacingMinor: bigint;
}

export function lineBurn(line: CfoLineIn, ledger: Ledger): LineBurn | null {
  if (ledger.sampleDays < MIN_SAMPLE_DAYS) return null;
  const validUntil = unixSeconds(line.validUntil, `${line.lineKey}.validUntil`);
  if (validUntil <= ledger.nowSec) return null;
  const days = maDays(ledger);
  const n = BigInt(days);
  const rows = ledger.agentSpend.filter((r) => r.lineKey === line.lineKey);
  const spent = sumDays(rows, ledger.today - days + 1, ledger.today);
  if (spent === 0n) return null;
  const pacing = line.pacingMinor ?? 0n;
  // pace a day = paceNum / paceDen
  const [paceNum, paceDen] = pacing > 0n ? [pacing, 1n] : [line.availableMinor + spent, (validUntil - ledger.nowSec) / SECONDS_PER_DAY + n];
  if (spent * 2n * paceDen <= 3n * paceNum * n) return null;
  return {
    lineKey: line.lineKey,
    days,
    spentMinor: spent,
    paceMinor: (paceNum * n) / paceDen,
    ratioTenths: (spent * 10n * paceDen) / (paceNum * n),
    paceNum,
    paceDen,
    pacingMinor: pacing,
  };
}

/** Lines burning faster than planned, in LINE_KEYS order (BURN_ALERT and proposeTightenings). */
export function burnsOf(i: CfoInputs, ledger: Ledger): LineBurn[] {
  const ordered = [...i.lines].sort((a, b) => LINE_KEYS.indexOf(a.lineKey) - LINE_KEYS.indexOf(b.lineKey));
  return ordered.flatMap((l) => lineBurn(l, ledger) ?? []);
}
