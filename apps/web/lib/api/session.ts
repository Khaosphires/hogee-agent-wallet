// Session and persona (project.md §26.6): GET /api/session, POST /api/session/persona. The persona cookie is
// signed and httpOnly; only the server sets it (G0-DECISIONS §6 v-2). The mode (live|mock|replay) comes from here.
import { SetPersonaBody, type RouteBody } from "@hogee/api-contract";
import type { Session } from "@hogee/core";
import type { FounderPersona } from "../persona";
import { apiCall } from "./client";

/** The persona switch body, exactly as the contract accepts it. */
export type PersonaChange = RouteBody<"setPersona">;

/**
 * The body that switches to `founder`, or undefined when the contract does not accept that founder persona. Parsed
 * with the contract's own schema, so the web never sends a founder the API refuses and never casts one into shape.
 */
export function founderChange(founder: FounderPersona): PersonaChange | undefined {
  const parsed = SetPersonaBody.safeParse({ persona: founder });
  return parsed.success ? parsed.data : undefined;
}

export const getSession = (): Promise<Session> => apiCall("getSession");

export const setPersona = (change: PersonaChange): Promise<Session> => apiCall("setPersona", { body: change });
