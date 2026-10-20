"use client";

import { useSession } from "@/lib/api/use-session";
import { founderPersonaOf, type FounderPersona } from "@/lib/persona";
import { useProfile, type Profile, type ProfileCountry } from "@/lib/profile";

export interface FounderProfile {
  /** This deployment's demo founder (the profile is always hers, whoever is viewing). */
  readonly founder: FounderPersona | undefined;
  readonly profile: Profile;
  readonly country: ProfileCountry;
  /** True when this device holds a saved profile (false: the demo defaults). */
  readonly stored: boolean;
  /** True once the session has loaded (until then the profile is Mei's defaults). */
  readonly ready: boolean;
  /** True when the person is viewing as the loan officer. */
  readonly officer: boolean;
}

/** The profile saved on this device for this deployment's founder, live across every view (lib/profile.ts). */
export function useFounderProfile(): FounderProfile {
  const { data: session } = useSession();
  const founder = session ? founderPersonaOf(session) : undefined;
  const { profile, country, stored } = useProfile(founder);
  return { founder, profile, country, stored, ready: Boolean(session), officer: session?.persona === "officer" };
}
