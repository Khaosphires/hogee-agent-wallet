/**
 * Words beside a seal (DESIGN.md §2, §7): the signer's name and the time in the facility's own zone, "19 Oct, 14:02
 * SGT". The zone follows the facility currency (SGD → Singapore, MYR → Kuala Lumpur); anything else reads in UTC
 * rather than guessing.
 */
import type { Persona } from "@hogee/core";

const ZONES: Record<string, { tz: string; label: string }> = {
  SGD: { tz: "Asia/Singapore", label: "SGT" },
  MYR: { tz: "Asia/Kuala_Lumpur", label: "MYT" },
};
const UTC = { tz: "UTC", label: "UTC" };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string, withYear = false): Intl.DateTimeFormat {
  const key = `${tz}:${withYear}`;
  let f = formatters.get(key);
  if (!f) {
    f = withYear
      ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz })
      : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz });
    formatters.set(key, f);
  }
  return f;
}

const zoneOf = (currency: string | undefined) => (currency && ZONES[currency]) || UTC;

/** Unix seconds as a date in the facility's zone: "15 Dec 2026" ("Invalid date" never shows: a bad value reads "an unknown date"). */
export function zonedDate(unixSeconds: number, currency: string | undefined): string {
  if (!Number.isFinite(unixSeconds)) return "an unknown date";
  return formatterFor(zoneOf(currency).tz, true).format(new Date(unixSeconds * 1000));
}

/** Unix seconds as "19 Oct, 14:02 SGT" in the facility's zone. */
export const zonedDateTime = (unixSeconds: number, currency: string | undefined): string | null => sealTime(new Date(unixSeconds * 1000).toISOString(), currency);

/** "in 9 min" until `unixSeconds`, "in less than a minute", or null once it has passed. */
export function expiresIn(unixSeconds: number, nowMs: number): string | null {
  const left = unixSeconds * 1000 - nowMs;
  if (!Number.isFinite(left) || left <= 0) return null;
  const minutes = Math.floor(left / 60_000);
  return minutes < 1 ? "in less than a minute" : `in ${minutes} min`;
}

export function sealTime(iso: string, currency: string | undefined): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const zone = zoneOf(currency);
  const parts = formatterFor(zone.tz).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")} ${zone.label}`;
}

const SIGNER: Record<Persona, string> = {
  "founder:mei": "Mei",
  "founder:rina": "Rina",
  officer: "the loan officer",
};

/** Who a seal belongs to, from the session persona (null before the session is known: no name is made up). */
export function signerName(persona: Persona | undefined): string | null {
  return persona ? SIGNER[persona] : null;
}

/**
 * The seal's signer line: "Signed by Mei with a passkey". The page knows a passkey signed, never which authenticator
 * (Touch ID, a phone, a security key), so it never names one; without a name it reads "Signed with a passkey", and
 * without a known method (a signature read back from history) it says nothing about how.
 */
export function sealSignerLine(signer: string | null, method: "passkey" | "wallet" | null): string {
  const how = method === "passkey" ? " with a passkey" : method === "wallet" ? " with a wallet" : "";
  return `Signed${signer ? ` by ${signer}` : ""}${how}`;
}

const PERSONA_CURRENCY: Partial<Record<Persona, string>> = { "founder:mei": "SGD", "founder:rina": "MYR" };

/** The facility currency to read times in: the plan's, or before there is one the founder persona's own (Mei: SGD). */
export const zoneCurrency = (planCurrency: string | undefined, persona: Persona | undefined): string | undefined =>
  planCurrency ?? (persona ? PERSONA_CURRENCY[persona] : undefined);
