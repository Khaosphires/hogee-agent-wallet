# UN Security Council sanctions list (`un_sc.csv`)

`un_sc.csv` is the local list that `@hogee/checks` `screenSanctions` matches supplier names against (project.md §11, §26.8).
It is generated; never edit it by hand. Rebuild it with `scripts/build-sanctions.mjs` (instructions below).

## Source

| Field | Value |
|---|---|
| Publisher | United Nations Security Council, Consolidated United Nations Security Council Sanctions List |
| Source URL | https://scsanctions.un.org/resources/xml/en/consolidated.xml |
| Served from | The URL answers with a redirect to the UN's own file storage (`unsolprodfiles.blob.core.windows.net`, file `consolidatedLegacyByPRN.xml`); the signed query string of that redirect expires and is not recorded |
| Retrieved at | 2026-10-18T13:57:04Z |
| sha256 of the downloaded XML | `baf03595ff252d54ed078a7a873b96b07228ccc49119b107b91626c30f9def13` |
| XML size | 2185376 bytes |
| List generated (`dateGenerated`) | 2026-10-17T23:00:01.054Z |
| Rows | 1010 (736 individuals, 274 entities) |

This list comes straight from the UN, not from OpenSanctions, so the OpenSanctions CC BY-NC 4.0 licence note does not
apply. The UN publishes the list for public use; see the UN website's terms of use.

## Columns

- `name`: individuals are `FIRST_NAME SECOND_NAME THIRD_NAME FOURTH_NAME`; entities are `FIRST_NAME`.
- `aliases`: every `ALIAS_NAME` (all qualities: good, low, a.k.a., f.k.a.) plus `NAME_ORIGINAL_SCRIPT`, separated by `;`
  (an alias the list packed with `;` becomes separate aliases), without duplicates of the name.
- `listId`: the UN reference number (e.g. `CDi.001`).
- `listedOn`: `LISTED_ON` as `YYYY-MM-DD`, or empty.

Rows are sorted by `listId`. Text is NFC, with control characters removed and whitespace collapsed.

## Rebuild

1. Download the XML into its own new, empty directory outside the repo (never run anything from it):
   `curl -sSL --proto '=https' --max-filesize 60000000 -o <dir>/consolidated.xml https://scsanctions.un.org/resources/xml/en/consolidated.xml`
2. Record the UTC time of the download, then run:
   `node scripts/build-sanctions.mjs --xml <dir>/consolidated.xml --retrieved-at <ISO-8601 UTC>`
3. Run `pnpm validate:data` and commit `un_sc.csv` with this README.
