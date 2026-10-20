/**
 * Reads the official UN Security Council Consolidated List XML (https://scsanctions.un.org/resources/xml/en/consolidated.xml)
 * as plain text and pins the few ENTITY rows the supplier data uses as sanctions-screening TEST rows. The XML is
 * untrusted input: it is only matched with fixed regular expressions (no XML parser, no entity expansion, nothing
 * executed) and every extracted field is checked against a strict pattern before it is kept.
 */
import { createHash } from "node:crypto";

export const UN_SC_SOURCE_URL = "https://scsanctions.un.org/resources/xml/en/consolidated.xml";
/** Selection rule (deterministic): DPRK-list entities whose name ends "TRADING CORPORATION", by reference number. */
export const UN_SC_SELECTION = "ENTITY rows with UN_LIST_TYPE DPRK whose FIRST_NAME ends with TRADING CORPORATION, ordered by REFERENCE_NUMBER; first 4";
const PICK = 4;

const NAME_RE = /^[A-Z0-9][A-Z0-9 ().,&'-]{2,120}$/;
const REF_RE = /^[A-Z]{2}e\.[0-9]{3}$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const INSTANT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

function field(block, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
  return m ? m[1].trim() : null;
}

function entityOf(block) {
  const e = {
    referenceNumber: field(block, "REFERENCE_NUMBER"),
    dataId: field(block, "DATAID"),
    name: field(block, "FIRST_NAME"),
    listedOn: field(block, "LISTED_ON"),
    unListType: field(block, "UN_LIST_TYPE"),
  };
  const ok = REF_RE.test(e.referenceNumber ?? "") && /^[0-9]{1,12}$/.test(e.dataId ?? "") && NAME_RE.test(e.name ?? "") && DATE_RE.test(e.listedOn ?? "");
  return ok ? e : null;
}

/** The pinned extract as read back from disk, re-checked field by field (it feeds supplier names). Throws if off. */
export function checkedExtract(extract) {
  const entities = Array.isArray(extract?.entities) ? extract.entities : [];
  const ok = (e) => REF_RE.test(e?.referenceNumber ?? "") && NAME_RE.test(e?.name ?? "") && DATE_RE.test(e?.listedOn ?? "") && e?.unListType === "DPRK";
  if (extract?.source !== UN_SC_SOURCE_URL || entities.length < PICK || !entities.every(ok)) throw new Error("un-sc-entities.json is not a valid pinned extract; rerun extract-un");
  return extract;
}

/** The pinned extract for `xml` (the file's exact bytes as a Buffer). Throws when the rule finds fewer than 4 rows. */
export function extractUnScEntities(xmlBytes, retrievedAt) {
  if (!INSTANT_RE.test(String(retrievedAt))) throw new Error("--retrieved-at must be a UTC date-time like 2026-10-18T14:01:01Z");
  const xml = xmlBytes.toString("utf8");
  const generated = /<CONSOLIDATED_LIST\b[^>]*\bdateGenerated="([^"]+)"/.exec(xml)?.[1];
  if (!generated) throw new Error("not a UN consolidated list (no CONSOLIDATED_LIST dateGenerated)");
  const blocks = xml.match(/<ENTITY>[\s\S]*?<\/ENTITY>/g) ?? [];
  const picked = blocks
    .map(entityOf)
    .filter((e) => e !== null && e.unListType === "DPRK" && e.name.endsWith("TRADING CORPORATION"))
    .sort((a, b) => (a.referenceNumber < b.referenceNumber ? -1 : 1))
    .slice(0, PICK);
  if (picked.length < PICK) throw new Error(`selection found ${picked.length} entities, need ${PICK}`);
  return {
    source: UN_SC_SOURCE_URL,
    dateGenerated: generated,
    retrievedAt,
    sha256: createHash("sha256").update(xmlBytes).digest("hex"),
    entityRowsInFile: blocks.length,
    selection: UN_SC_SELECTION,
    use: "Sanctions-screening TEST rows only: each name below is copied verbatim from the list so the screening check has a real name to match. Every other field of a supplier record that carries one of these names is fictional demo data; it is not an offer from, or a statement about, the listed entity.",
    entities: picked,
  };
}
