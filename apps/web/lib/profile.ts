/**
 * The founder's profile and business details (UX round 2, P1 decision 4), saved on this device only: localStorage
 * `hogee.profile.v1`. Nothing here reaches the server, the plan, a signature, a payee or a limit; it labels the Settings
 * page and the quick settings' avatar, nothing else.
 *
 * Every read is validated with zod, field by field: a missing, corrupt, oversized or tampered value falls back to the
 * defaults (a bad field falls back alone, so one broken field never wipes the rest). Nothing invalid is ever written.
 * Every storage access is in try/catch: a browser that refuses to store keeps the edit for this page view only.
 * The defaults are what the app already knows about the demo founder (core demo/mei.ts, the chat's opening line):
 * Mei Tan sells insulated tumblers on Shopee Singapore. Email, phone and the business name start empty, so nothing is
 * invented about anyone.
 *
 * Security notes (security-review): localStorage is readable by any script on this origin, so it holds only what Mei
 * types here, never a secret, key or code; values render as React text (escaped), never as HTML or in a URL; lengths
 * are capped and control or bidi-override characters are refused, so a stored value cannot spoof the layout.
 */
import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
// Relative, not "@/": the unit tests run this file without the Next path alias.
import type { FounderPersona } from "./persona";

export const PROFILE_STORAGE_KEY = "hogee.profile.v1";
/** Fired on window when this tab saves or clears the profile (other tabs hear the `storage` event). */
export const PROFILE_EVENT = "hogee:profile";
/** A stored value longer than this is not even parsed: it is not ours. */
export const PROFILE_MAX_STORED = 4_096;

export const AVATAR_COLOURS = ["teal", "blue", "violet", "rose", "graphite"] as const;
export type AvatarColour = (typeof AVATAR_COLOURS)[number];

/** The countries a demo founder can be in. Shown, never edited: it comes from the deployment's founder. */
export type ProfileCountry = "SG" | "MY";
export const COUNTRY_NAME: Readonly<Record<ProfileCountry, string>> = { SG: "Singapore", MY: "Malaysia" };

export interface Profile {
  readonly displayName: string;
  readonly avatarColour: AvatarColour;
  readonly email: string;
  readonly phone: string;
  readonly businessName: string;
  readonly whatYouSell: string;
  readonly whereYouSell: string;
}
export type ProfileField = keyof Profile;
export type ProfileTextField = Exclude<ProfileField, "avatarColour">;

export const PROFILE_FIELDS: readonly ProfileField[] = [
  "displayName",
  "avatarColour",
  "email",
  "phone",
  "businessName",
  "whatYouSell",
  "whereYouSell",
];

export const PROFILE_LIMITS: Readonly<Record<ProfileTextField, number>> = {
  displayName: 60,
  email: 254,
  phone: 20,
  businessName: 80,
  whatYouSell: 80,
  whereYouSell: 80,
};

// ---- defaults ------------------------------------------------------------------------------------------------------

const MEI: Profile = {
  displayName: "Mei Tan",
  avatarColour: "teal",
  email: "",
  phone: "",
  businessName: "",
  whatYouSell: "Insulated tumblers",
  whereYouSell: "Shopee Singapore",
};

const DEFAULTS: Readonly<Record<FounderPersona, Profile>> = {
  "founder:mei": MEI,
  "founder:rina": { ...MEI, displayName: "Rina", avatarColour: "violet", whereYouSell: "Shopee Malaysia" },
};

const COUNTRY_OF: Readonly<Record<FounderPersona, ProfileCountry>> = { "founder:mei": "SG", "founder:rina": "MY" };

/** The demo founder's defaults; Mei's when the founder isn't known yet (the session is still loading). */
export function defaultProfile(founder: FounderPersona | undefined): Profile {
  return founder ? DEFAULTS[founder] : MEI;
}

export function countryOf(founder: FounderPersona | undefined): ProfileCountry {
  return founder ? COUNTRY_OF[founder] : "SG";
}

// ---- validation ----------------------------------------------------------------------------------------------------

// C0/C1 controls and the bidi overrides/isolates: they could hide or reorder text on screen. Zero-width joiners stay
// (emoji and some scripts need them).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

const text = (field: ProfileTextField) =>
  z
    .string()
    .max(PROFILE_LIMITS[field], `Use ${PROFILE_LIMITS[field]} characters or fewer.`)
    .refine((v) => !UNSAFE_CHARS.test(v), "Remove the hidden characters from this.");

/** Digits only, with an optional leading +: what a phone number is once spaces, dashes, dots and brackets go. */
export const phoneDigits = (phone: string): string => phone.replace(/[\s\-().]/g, "");

// SG-DECISIONS (SG_PHONE): 8 digits starting with 3, 6, 8 or 9, with an optional +65.
const SG_PHONE = /^(\+65)?[3689]\d{7}$/;
// MY: 9 to 10 digits after a leading 0 or +60 (mobile 01x, landline 0x).
const MY_PHONE = /^(\+60|0)\d{8,10}$/;
const PHONE: Readonly<Record<ProfileCountry, { readonly pattern: RegExp; readonly hint: string }>> = {
  SG: { pattern: SG_PHONE, hint: "Enter 8 digits that start with 3, 6, 8 or 9. You can add +65 in front." },
  MY: { pattern: MY_PHONE, hint: "Enter a Malaysian number that starts with 0 or +60." },
};

function fieldSchema(field: ProfileField, country: ProfileCountry): z.ZodType<string> {
  switch (field) {
    case "avatarColour":
      return z.enum(AVATAR_COLOURS);
    case "displayName":
      return text(field).refine((v) => v.trim().length > 0, "Enter your name.");
    case "email":
      return text(field).refine((v) => v === "" || z.email().safeParse(v).success, "Enter an email like name@example.com.");
    case "phone":
      return text(field).refine((v) => v === "" || PHONE[country].pattern.test(phoneDigits(v)), PHONE[country].hint);
    default:
      return text(field);
  }
}

/** Why `value` can't be saved in `field`, in one plain sentence; undefined when it can. Empty is fine except the name. */
export function fieldError(field: ProfileField, value: string, country: ProfileCountry): string | undefined {
  const result = fieldSchema(field, country).safeParse(value);
  return result.success ? undefined : (result.error.issues[0]?.message ?? "This can't be saved.");
}

/** What is saved for a field: text trimmed at both ends. */
export const tidy = (value: string): string => value.trim();

// ---- reading and writing -------------------------------------------------------------------------------------------

const StoredShape = z.record(z.string(), z.unknown());

/**
 * The stored profile, field by field over `defaults`: each field is used only when it passes its schema; a missing,
 * wrong-typed or invalid field takes its default. Anything that isn't a JSON object (or is too long) is all defaults.
 */
export function parseStoredProfile(raw: string | null, defaults: Profile, country: ProfileCountry): Profile {
  if (raw === null || raw.length > PROFILE_MAX_STORED) return defaults;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return defaults;
  }
  const shape = StoredShape.safeParse(json);
  if (!shape.success || Array.isArray(json)) return defaults;
  const stored = shape.data;
  const pick = <F extends ProfileField>(field: F): Profile[F] => {
    const parsed = fieldSchema(field, country).safeParse(stored[field]);
    return parsed.success ? (tidyField(field, parsed.data) as Profile[F]) : defaults[field];
  };
  return {
    displayName: pick("displayName"),
    avatarColour: pick("avatarColour"),
    email: pick("email"),
    phone: pick("phone"),
    businessName: pick("businessName"),
    whatYouSell: pick("whatYouSell"),
    whereYouSell: pick("whereYouSell"),
  };
}

const tidyField = (field: ProfileField, value: string): string => (field === "avatarColour" ? value : tidy(value));

/** The JSON stored for a profile, or undefined when any field is invalid (nothing invalid is ever written). */
export function serializeProfile(profile: Profile, country: ProfileCountry): string | undefined {
  const clean = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, tidyField(f, profile[f])])) as Record<ProfileField, string>;
  if (PROFILE_FIELDS.some((f) => fieldError(f, clean[f], country))) return undefined;
  return JSON.stringify(clean);
}

/** "MT" for "Mei Tan", "M" for "Mei": the first letter of the first and last words (whole characters, any script). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return "";
  const letter = (w: string) => (Array.from(w)[0] ?? "").toLocaleUpperCase();
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return last ? `${letter(first)}${letter(last)}` : letter(first);
}

/** The first word of the name ("Mei" for "Mei Tan"), for the quick settings' button. */
export const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] ?? "";

// ---- the browser store (useSyncExternalStore) ----------------------------------------------------------------------

// The latest profile when this browser refused to store it: it lasts for this page view.
let unsaved: string | null = null;

function readRaw(): string | null {
  if (unsaved !== null) return unsaved;
  try {
    return window.localStorage.getItem(PROFILE_STORAGE_KEY);
  } catch {
    return null; // storage blocked: defaults
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PROFILE_STORAGE_KEY) onChange();
  };
  window.addEventListener(PROFILE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PROFILE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export type SaveResult = "saved" | "this-page-only" | "invalid";

/** Saves the whole profile. "invalid" writes nothing; "this-page-only" means the browser refused to store it. */
export function saveProfile(profile: Profile, country: ProfileCountry): SaveResult {
  const json = serializeProfile(profile, country);
  if (json === undefined) return "invalid";
  let result: SaveResult = "saved";
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, json);
    unsaved = null;
  } catch {
    unsaved = json;
    result = "this-page-only";
  }
  window.dispatchEvent(new Event(PROFILE_EVENT));
  return result;
}

/** Back to the demo founder's defaults on this device. */
export function clearProfile(): void {
  unsaved = null;
  try {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // storage blocked: nothing was stored
  }
  window.dispatchEvent(new Event(PROFILE_EVENT));
}

/**
 * The profile for `founder` (this deployment's demo founder), live across every view and tab. The server render and
 * hydration use the defaults; the stored profile follows right after.
 */
export function useProfile(founder: FounderPersona | undefined): { readonly profile: Profile; readonly country: ProfileCountry; readonly stored: boolean } {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const country = countryOf(founder);
  return useMemo(() => ({ profile: parseStoredProfile(raw, defaultProfile(founder), country), country, stored: raw !== null }), [raw, founder, country]);
}
