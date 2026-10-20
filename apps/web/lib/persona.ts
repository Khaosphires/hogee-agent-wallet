/**
 * Personas (SG-DECISIONS Q1). PERSONAS holds one founder per demo country, "founder:rina" (MY) and "founder:mei" (SG),
 * and the API accepts only the founder of its HOGEE_COUNTRY. Pages and routes treat either founder persona as "the
 * founder" through isFounderPersona, so nothing outside this file names a founder.
 */
import { MEI_IDS, RINA_IDS, type Persona, type Session } from "@hogee/core";

export type FounderPersona = Extract<Persona, `founder:${string}`>;

export function isFounderPersona(persona: Persona | undefined): persona is FounderPersona {
  return persona !== undefined && persona.startsWith("founder:");
}

/** The "View as" choices in the Demo menu (REWRITES B36). */
export const PERSONA_LABEL: Record<Persona, string> = {
  "founder:rina": "Rina (founder)",
  "founder:mei": "Mei (founder)",
  officer: "Loan officer",
};

/** The short name on the Demo menu's button ("Demo · Mei") and in the officer's checklist ("Set up Mei"). */
export const PERSONA_NAME: Record<Persona, string> = {
  "founder:rina": "Rina",
  "founder:mei": "Mei",
  officer: "Loan officer",
};

/** The demo founders (core demo constants) by founderId. */
const FOUNDER_BY_ID: ReadonlyMap<string, FounderPersona> = new Map<string, FounderPersona>([
  [RINA_IDS.founderId, "founder:rina"],
  [MEI_IDS.founderId, "founder:mei"],
]);

type SessionPersona = Pick<Session, "persona" | "founderId">;

/**
 * This deployment's founder: the session's own persona when a founder is signed in, else the demo founder its
 * founderId names. undefined for any other founderId, so the switch never offers a founder the API would refuse.
 */
export function founderPersonaOf(session: SessionPersona): FounderPersona | undefined {
  if (isFounderPersona(session.persona)) return session.persona;
  return FOUNDER_BY_ID.get(session.founderId);
}

/** The personas the header switch offers: this deployment's founder (when known), then the officer. */
export function personaOptions(session: SessionPersona): readonly Persona[] {
  const founder = founderPersonaOf(session);
  return founder ? [founder, "officer"] : ["officer"];
}
