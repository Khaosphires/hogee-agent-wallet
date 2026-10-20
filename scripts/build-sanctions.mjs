#!/usr/bin/env node
// Builds data/sanctions/un_sc.csv (project.md §26.8, columns name,aliases,listId,listedOn) and its README from a
// downloaded copy of the UN Security Council Consolidated List XML. The XML is untrusted input: it is read as text
// and parsed with plain string matching (no XML library, no DTD or entity expansion, no code from the download).
//
// Usage (download into its own new directory first; this script never fetches anything):
//   node scripts/build-sanctions.mjs --xml <path/to/consolidated.xml> --retrieved-at <ISO-8601 UTC> [--out data/sanctions]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
const HEADER = ['name', 'aliases', 'listId', 'listedOn'];
// SanctionsRow limits (packages/core/src/schemas/datasets.ts).
const MAX_NAME = 300;
const MAX_ALIASES = 4000;
const MAX_LIST_ID = 64;
const MAX_XML_BYTES = 64 * 1024 * 1024;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function fail(message) {
  throw new Error(`build-sanctions: ${message}`);
}

function codePoint(cp) {
  if (!Number.isInteger(cp) || (cp < 0x20 && cp !== 0x9 && cp !== 0xa && cp !== 0xd) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail(`invalid character reference ${cp}`);
  return String.fromCodePoint(cp);
}

/** Decodes the five XML entities and numeric references; any other '&' is refused. */
export function decodeXmlText(raw) {
  return raw.replace(/&([^;&<]{0,10});?/g, (whole, ref) => {
    if (!whole.endsWith(';')) fail(`bare '&' in text near ${JSON.stringify(whole)}`);
    if (/^#x[0-9A-Fa-f]{1,6}$/.test(ref)) return codePoint(Number.parseInt(ref.slice(2), 16));
    if (/^#\d{1,7}$/.test(ref)) return codePoint(Number.parseInt(ref.slice(1), 10));
    const named = Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : undefined;
    if (named === undefined) fail(`unknown XML entity &${ref};`);
    return named;
  });
}

/** NFC, control characters removed, whitespace collapsed. */
export function cleanText(raw) {
  return decodeXmlText(raw)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Text of every <tag>…</tag> (or <tag/>) in `block`; an element of that name in any other form fails the build. */
function values(block, tag) {
  const all = (block.match(new RegExp(`<${tag}[\\s/>]`, 'g')) ?? []).length;
  const empty = (block.match(new RegExp(`<${tag}/>`, 'g')) ?? []).length;
  const found = [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))];
  if (found.length + empty !== all) fail(`<${tag}> with attributes or markup inside is not supported`);
  return found.map((m) => cleanText(m[1])).filter((v) => v !== '');
}

function first(block, tag) {
  return values(block, tag)[0] ?? '';
}

/** Contents of each <tag>…</tag>, scanned linearly; an unclosed or nested element fails the build. */
function blocks(xml, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const out = [];
  let at = xml.indexOf(open);
  while (at !== -1) {
    const end = xml.indexOf(close, at + open.length);
    if (end === -1) fail(`unclosed ${open}`);
    const body = xml.slice(at + open.length, end);
    if (body.includes(open)) fail(`nested ${open}`);
    out.push(body);
    at = xml.indexOf(open, end + close.length);
  }
  return out;
}

function uniqueAliases(name, candidates) {
  const seen = new Set([name.toLowerCase()]);
  const out = [];
  for (const alias of candidates) {
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/** One CSV row from an <INDIVIDUAL> or <ENTITY> block. */
export function rowOf(block, kind) {
  const nameParts = kind === 'INDIVIDUAL' ? ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map((t) => first(block, t)) : [first(block, 'FIRST_NAME')];
  const name = nameParts.filter(Boolean).join(' ');
  const listId = first(block, 'REFERENCE_NUMBER');
  const listedOn = first(block, 'LISTED_ON');
  if (!name) fail(`${kind} ${listId || '(no reference)'} has no name`);
  if (!listId) fail(`${kind} "${name}" has no REFERENCE_NUMBER`);
  // The list sometimes packs several aliases into one ALIAS_NAME separated by ';' (the CSV's own separator).
  const aliasNames = values(block, 'ALIAS_NAME').flatMap((a) => a.split(';').map((x) => x.trim()).filter(Boolean));
  const aliases = uniqueAliases(name, [...aliasNames, ...values(block, 'NAME_ORIGINAL_SCRIPT')]);
  const row = { name, aliases: aliases.join(';'), listId, listedOn: ISO_DATE.test(listedOn) ? listedOn : '' };
  if (row.name.length > MAX_NAME) fail(`${listId}: name longer than ${MAX_NAME}`);
  if (row.aliases.length > MAX_ALIASES) fail(`${listId}: aliases longer than ${MAX_ALIASES}`);
  if (row.listId.length > MAX_LIST_ID) fail(`${listId}: listId longer than ${MAX_LIST_ID}`);
  return row;
}

/** Parses the consolidated list XML text into sorted rows plus the list's generation time. */
export function parseConsolidatedList(xml) {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--/i.test(xml)) fail('DOCTYPE, ENTITY, CDATA or comment sections are not expected');
  if ((xml.match(/<\?/g) ?? []).length > (/^\uFEFF?<\?xml\b/.test(xml) ? 1 : 0)) fail('processing instructions are not expected');
  const root = /<CONSOLIDATED_LIST\b[^>]*\bdateGenerated="([^"]+)"/.exec(xml);
  if (!root) fail('missing <CONSOLIDATED_LIST dateGenerated=...>');
  const dateGenerated = root[1];
  if (!ISO_INSTANT.test(dateGenerated)) fail(`unexpected dateGenerated ${JSON.stringify(dateGenerated)}`);
  const individuals = blocks(xml, 'INDIVIDUAL').map((b) => rowOf(b, 'INDIVIDUAL'));
  const entities = blocks(xml, 'ENTITY').map((b) => rowOf(b, 'ENTITY'));
  const openTags = (tag) => (xml.match(new RegExp(`<${tag}>`, 'g')) ?? []).length;
  if (individuals.length !== openTags('INDIVIDUAL') || entities.length !== openTags('ENTITY')) fail('unbalanced INDIVIDUAL/ENTITY tags');
  if (individuals.length === 0 || entities.length === 0) fail('no individuals or no entities found');
  const rows = [...individuals, ...entities].sort((a, b) => (a.listId < b.listId ? -1 : a.listId > b.listId ? 1 : 0));
  const ids = new Set(rows.map((r) => r.listId));
  if (ids.size !== rows.length) fail('duplicate REFERENCE_NUMBER values');
  return { dateGenerated, individuals: individuals.length, entities: entities.length, rows };
}

function csvField(value) {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows) {
  const lines = [HEADER.join(','), ...rows.map((r) => HEADER.map((c) => csvField(r[c])).join(','))];
  return `${lines.join('\n')}\n`;
}

export function readme(meta) {
  return `# UN Security Council sanctions list (\`un_sc.csv\`)

\`un_sc.csv\` is the local list that \`@hogee/checks\` \`screenSanctions\` matches supplier names against (project.md §11, §26.8).
It is generated; never edit it by hand. Rebuild it with \`scripts/build-sanctions.mjs\` (instructions below).

## Source

| Field | Value |
|---|---|
| Publisher | United Nations Security Council, Consolidated United Nations Security Council Sanctions List |
| Source URL | ${meta.sourceUrl} |
| Served from | The URL answers with a redirect to the UN's own file storage (\`unsolprodfiles.blob.core.windows.net\`, file \`consolidatedLegacyByPRN.xml\`); the signed query string of that redirect expires and is not recorded |
| Retrieved at | ${meta.retrievedAt} |
| sha256 of the downloaded XML | \`${meta.sha256}\` |
| XML size | ${meta.bytes} bytes |
| List generated (\`dateGenerated\`) | ${meta.dateGenerated} |
| Rows | ${meta.rows} (${meta.individuals} individuals, ${meta.entities} entities) |

This list comes straight from the UN, not from OpenSanctions, so the OpenSanctions CC BY-NC 4.0 licence note does not
apply. The UN publishes the list for public use; see the UN website's terms of use.

## Columns

- \`name\`: individuals are \`FIRST_NAME SECOND_NAME THIRD_NAME FOURTH_NAME\`; entities are \`FIRST_NAME\`.
- \`aliases\`: every \`ALIAS_NAME\` (all qualities: good, low, a.k.a., f.k.a.) plus \`NAME_ORIGINAL_SCRIPT\`, separated by \`;\`
  (an alias the list packed with \`;\` becomes separate aliases), without duplicates of the name.
- \`listId\`: the UN reference number (e.g. \`CDi.001\`).
- \`listedOn\`: \`LISTED_ON\` as \`YYYY-MM-DD\`, or empty.

Rows are sorted by \`listId\`. Text is NFC, with control characters removed and whitespace collapsed.

## Rebuild

1. Download the XML into its own new, empty directory outside the repo (never run anything from it):
   \`curl -sSL --proto '=https' --max-filesize 60000000 -o <dir>/consolidated.xml ${meta.sourceUrl}\`
2. Record the UTC time of the download, then run:
   \`node scripts/build-sanctions.mjs --xml <dir>/consolidated.xml --retrieved-at <ISO-8601 UTC>\`
3. Run \`pnpm validate:data\` and commit \`un_sc.csv\` with this README.
`;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--xml', '--retrieved-at', '--out'].includes(key) || value === undefined) fail(`usage: --xml <file> --retrieved-at <ISO> [--out <dir>]`);
    out[key.slice(2)] = value;
  }
  if (!out.xml || !out['retrieved-at']) fail('--xml and --retrieved-at are required');
  if (!ISO_INSTANT.test(out['retrieved-at'])) fail('--retrieved-at must be an ISO-8601 UTC instant (…Z)');
  return out;
}

function main() {
  const a = args(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(a.out ?? path.join(here, '..', 'data', 'sanctions'));
  const size = statSync(a.xml).size;
  if (size === 0 || size > MAX_XML_BYTES) fail(`XML size ${size} is outside 1..${MAX_XML_BYTES} bytes`);
  const bytes = readFileSync(a.xml);
  const parsed = parseConsolidatedList(bytes.toString('utf8'));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'un_sc.csv'), toCsv(parsed.rows));
  const meta = {
    sourceUrl: SOURCE_URL,
    retrievedAt: a['retrieved-at'],
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    dateGenerated: parsed.dateGenerated,
    rows: parsed.rows.length,
    individuals: parsed.individuals,
    entities: parsed.entities,
  };
  writeFileSync(path.join(outDir, 'README.md'), readme(meta));
  process.stdout.write(`${JSON.stringify(meta)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
