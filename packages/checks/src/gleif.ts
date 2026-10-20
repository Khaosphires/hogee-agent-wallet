/**
 * GLEIF LEI lookup by legal name (https://api.gleif.org/api/v1/lei-records, `filter[entity.legalName]`). The GLEIF
 * API is GET-only, so the supplier's legal name is the only thing sent, in the query string; text that looks like
 * personal data (an e-mail address, a long digit run such as a phone or ID number) is refused before any request.
 * Every record is checked (ISO 17442 check digits); a malformed answer fails closed.
 */
import { z } from "zod";
import { httpGet, parseJsonBody, type HttpOptions } from "./http";
import { CheckInputError, CheckUnavailableError, type LeiRecord } from "./types";

export const GLEIF_HOST = "api.gleif.org";
export const GLEIF_ACCEPT = "application/vnd.api+json";
/** Records returned at most (GLEIF allows 1..200 per page). */
export const GLEIF_PAGE_SIZE = 10;
const GLEIF_URL = `https://${GLEIF_HOST}/api/v1/lei-records`;
const GLEIF_MAX_BYTES = 256 * 1024;
const MIN_NAME_CHARS = 2;
const MAX_NAME_CHARS = 200;

const GleifRecord = z.object({
  attributes: z.object({
    lei: z.string().regex(/^[A-Z0-9]{18}\d{2}$/),
    entity: z.object({
      legalName: z.object({ name: z.string().min(1).max(500) }),
      legalAddress: z.object({ country: z.string().regex(/^[A-Z]{2}$/) }),
    }),
    registration: z.object({ status: z.string().min(1).max(40) }),
  }),
});
const GleifPage = z.object({ data: z.array(GleifRecord).max(GLEIF_PAGE_SIZE) });

/** ISO 17442 / ISO 7064 MOD 97-10: letters A..Z = 10..35, the whole number mod 97 must be 1. */
export function leiChecksumValid(lei: string): boolean {
  if (!/^[A-Z0-9]{20}$/.test(lei)) return false;
  let rem = 0;
  for (const ch of lei) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** The legal name to send, or a CheckInputError. Only a company name is ever sent. */
export function supplierNameForGleif(name: string): string {
  if (typeof name !== "string") throw new CheckInputError("legal name must be a string");
  const n = name.trim().replace(/\s+/g, " ");
  if (n.length < MIN_NAME_CHARS || n.length > MAX_NAME_CHARS) throw new CheckInputError(`legal name must be ${MIN_NAME_CHARS}-${MAX_NAME_CHARS} characters`);
  if (/[\p{Cc}\p{Cf}]/u.test(n)) throw new CheckInputError("legal name contains control characters");
  // NFKC folds fullwidth forms ("＠", "１"); separators between digits are dropped so "900101-14-5678" or
  // "+60 12-345 6789" count as one digit run.
  const probe = n.normalize("NFKC").replace(/(?<=\p{Nd})[\s().+\-/]+(?=\p{Nd})/gu, "");
  if (probe.includes("@") || /\p{Nd}{7,}/u.test(probe)) throw new CheckInputError("legal name looks like it holds personal data; not sent");
  return n;
}

/** GLEIF lookup by legal name. Sends only the supplier name. Throws when GLEIF cannot answer. */
export async function lookupLEI(name: string, opts: HttpOptions = {}): Promise<readonly LeiRecord[]> {
  const legalName = supplierNameForGleif(name);
  const url = new URL(`${GLEIF_URL}?filter[entity.legalName]=${encodeURIComponent(legalName)}&page[size]=${GLEIF_PAGE_SIZE}`);
  const { status, bytes } = await httpGet(url, { service: "GLEIF", host: GLEIF_HOST, accept: GLEIF_ACCEPT, maxBytes: GLEIF_MAX_BYTES }, opts);
  if (status !== 200) throw new CheckUnavailableError(`GLEIF answered HTTP ${status}`);
  const parsed = GleifPage.safeParse(parseJsonBody(bytes, "GLEIF"));
  if (!parsed.success) throw new CheckUnavailableError("GLEIF answer has an unexpected shape");
  return parsed.data.data.map(({ attributes: a }) => {
    if (!leiChecksumValid(a.lei)) throw new CheckUnavailableError("GLEIF answer holds an LEI with bad check digits");
    return { lei: a.lei, legalName: a.entity.legalName.name, country: a.entity.legalAddress.country, status: a.registration.status };
  });
}
