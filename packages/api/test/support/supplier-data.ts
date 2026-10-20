/**
 * TEST STUBS for the real supplier data (data/suppliers, written by data/suppliers/build.mjs). The checks agent owns
 * the real packages/checks bodies; these stand in for them so the catalog can be ranked offline:
 * - sanctions: an exact (case- and whitespace-insensitive) match on the UN SC names pinned in
 *   data/suppliers/un-sc-entities.json;
 * - USCC: an independent GB 32100-2015 check-character implementation (not the generator's), so the data is checked
 *   by a second implementation;
 * - FX: fixed mock rates (CNY/MYR from support/catalog.ts, CNY/SGD here).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHex32, type Sourced } from "@hogee/core";
import type { ApiLogger, ChecksPort } from "../../src/context";
import { FX_CNY_MYR } from "./catalog";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const DATA_DIR = join(REPO, "data");

export interface UnScExtract {
  readonly source: string;
  readonly entities: readonly { readonly referenceNumber: string; readonly name: string; readonly listedOn: string }[];
}
export const UN_SC: UnScExtract = JSON.parse(readFileSync(join(DATA_DIR, "suppliers", "un-sc-entities.json"), "utf8")) as UnScExtract;

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toUpperCase();
const LISTED = new Set(UN_SC.entities.map((e) => norm(e.name)));
export const onUnList = (name: string): boolean => LISTED.has(norm(name));

const CHARSET = "0123456789ABCDEFGHJKLMNPQRTUWXY";
/** GB 32100-2015: weights 3^(i-1) mod 31; check = (31 - sum mod 31) mod 31. Written apart from build.mjs on purpose. */
export function usccChecksumOk(code: string): boolean {
  if (code.length !== 18) return false;
  const v = [...code].map((c) => CHARSET.indexOf(c));
  if (v.some((x) => x < 0)) return false;
  let sum = 0;
  let w = 1;
  for (let i = 0; i < 17; i += 1) {
    sum += (v[i] ?? 0) * w;
    w = (w * 3) % 31;
  }
  return (31 - (sum % 31)) % 31 === v[17];
}

export const FX_CNY_SGD: Sourced<number> = { ...FX_CNY_MYR, value: 0.19, sourceUrl: "https://example.invalid/fx/cny-sgd", snippetHash: fakeHex32("test:fx:cny-sgd") };

export const supplierChecks: ChecksPort = {
  screenSanctions: async (name) => ({ hit: onUnList(name) }),
  validateRegistryId: (kind, id) => ({ valid: kind === "uscc" && usccChecksumOk(id) }),
  fx: async (pair) => {
    if (pair === "CNY/MYR") return FX_CNY_MYR;
    if (pair === "CNY/SGD") return FX_CNY_SGD;
    throw new Error(`no test FX rate for ${pair}`);
  },
};

export function collectingLog(): ApiLogger & { readonly events: string[] } {
  const events: string[] = [];
  const push = (e: string) => void events.push(e);
  return { events, info: push, warn: push, error: push };
}

/** The raw listing text's lines (one sentence per line, as build.mjs writes them). */
export const linesOf = (text: string): string[] => text.split("\n").filter((l) => l.length > 0);
