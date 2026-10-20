# evals-e5 decisions (E5 privacy dataset, 2026-10-18)

**Owner:** agent `evals-e5`, branch `wip/evals-e5`. For P1 to fold into `docs/G0-DECISIONS.md` after the merge.

**Delivered:**
- `evals/datasets/e5/docs.jsonl`: 190 rows (150 MY/ID, then 40 SG).
- The `docs.meta.jsonl` sidecar and a README in the same folder.
- The generator, `evals/scripts/gen-e5.mjs` plus its modules in `evals/scripts/e5/`.

## 1. What E5 is

| Gap | Choice |
|---|---|
| What E5 evaluates | **PII redaction**: Presidio default against Presidio plus our recognizers, scored by redaction recall and precision (project.md §15, §12.2). The same §15 row also lists "local vs cloud extraction accuracy". The frozen `E5DocRow` has no extraction labels, so this dataset labels PII spans only. Extraction accuracy needs its own labels (see §4) |
| Who reads the file | There is no E5 loader or scorer in the API. `runtime/eval-data.ts` loads E2 and the supplier sets, and the eval services cover E1–E3. The readers are P3's Python eval (task 3.12) and `packages/privacy` tests. `pnpm validate:data` already validates `docs.jsonl` |
| Chinese documents | Allowed. `E5DocRow` has no `lang` field (`LANGS` is `en/ms/id`). The sidecar records `zh` for them |

## 2. Label rule

| Gap | Choice |
|---|---|
| What counts as an entity | The **reference detector** (`detect()` in `evals/scripts/e5/ids.mjs`) defines the labels. A span is a format match that passes the validator and is not inside a longer letter/digit group: no ASCII letter or digit next to it, and it does not continue a digit group through one space or dash. Every row must equal the detector's output for all eight entities. So hard negatives provably fail, and `docs.jsonl` holds no SG PII. The README has the full table |
| `MY_NRIC` | Real `YYMMDD` date, in either century, and a JPN place-of-birth code. MyKad has no check digit |
| `ID_NIK` | Valid province code, regency and district not `00`, real date with women's day + 40, serial not `0000` |
| `ID_NPWP` | **Verified 2026-10-18.** The 9th digit is the Luhn check over the first 8. DJP publishes no check-digit rule, so this rests on two independent implementations that agree: python-stdnum `stdnum/id/npwp.py` (`luhn.validate(number[:9])`) and Perl `Business::ID::NPWP` 0.092 (format `ST.sss.sss.C-OOO.BBB`, Luhn over the first 9 digits). Both docs' example numbers pass our validator, and a changed `C` fails. The 16-digit form is confirmed by DJP's "Materi FAQ NPWP16 Digit" (1/12/2023): Q2, a business with a 15-digit NPWP gets `"0"` + the 15 digits; Q9, an individual's 16-digit NPWP is the NIK. A NIK used as an NPWP is never generated, because its label would be ambiguous. No generator change was needed |
| `MY_BANK_ACCOUNT` | No checksum exists. A number counts as an account only with a bank word earlier on the same line, within 48 characters. **Lengths verified 2026-10-18** against two bank-published IBG tables and one government notice; no generator change was needed. (1) CIMB's IBG listing (cimb.com.my): Maybank 12, Public Bank 10, RHB 14, Hong Leong 11–13, AmBank 13, Bank Islam 14, BSN 16. (2) UOB Malaysia's "IBG & DuitNow Participating Bank code & account length" (savings): Maybank 12, CIMB 10 and 14, Public Bank 10, RHB 14, Hong Leong 11 and 13, AmBank 13, Bank Islam 14, BSN 16. (3) The JANM Perak notice of 17 Jun 2022: CIMB Bank and Bank Rakyat accounts are 10 digits. We use 10 for CIMB and 11 for Hong Leong. Maybank's own IBG list timed out on every fetch; both tables carry "guidance only" disclaimers |
| `SG_NRIC` | Checksum as in SG-DECISIONS.md. The E5 M-series rule (`XWUTRQPNJLK`, offset 3) **must match the privacy agent's final table**, which they are verifying. On p1/dev `5a555d3`, `packages/privacy/src/validators.ts` has the same S/T, F/G and M tables and offsets. If privacy changes M, change `SG_LETTERS`/`SG_OFFSET` in `ids.mjs` and regenerate. That affects only M-prefixed FINs (the `sgFinChat` rows). `S1234567D` passes, which supports the S/T table |
| Phones | MY: mobile `01X` + 7 digits (`011`/`015` + 8); landline 03 + 8, `0[4-79]` + 7, `08[2-9]` + 6. ID: operator prefixes `81x`–`89x` with 9–12 national digits; landline area code + 6–8 digits. SG: per SG-DECISIONS.md |
| Out-of-scope PII | Left out so that labels stay unambiguous: emails, Chinese phone and ID numbers, Indonesian and Singapore bank accounts. Names and street names appear unlabelled; they are invented and street-level only |

## 3. Generation

| Gap | Choice |
|---|---|
| Determinism | Seed `20261018`, mulberry32, no clock and no `Math.random`. Each document has its own stream: seed + docId + attempt. A rendering that fails any row check is redrawn, up to 50 attempts, and then the run fails. Changing the template plan reshuffles the order |
| Offset integrity | Every span's code-point slice must match its entity's format and validator, and the detector must agree. Python slicing re-checked all 403 spans. 35 documents carry emoji before spans, so 65 spans have UTF-16 offsets that differ from their code-point offsets |
| Realistic values | Example numbers are excluded: core's `exampleE5DocRow` MyKad and phone, the stdnum NPWP example and `S1234567D`. So are runs of 5 equal or 5 consecutive digits. The new SSM form uses years 2015+, because a 2001–2012 registration number can parse as a valid MyKad |
| SG rows | **Merged 2026-10-18** once p1/dev's core gained the SG names (P1's instruction: Singapore is the main country, so its rows are scored). `SG_IN_MAIN = true` appends the 40 SG rows after the 150, which stayed byte-identical (same sha256). `docs.sg.jsonl` was removed, so there is one source of truth. SG rows may also contain MY entities (cross-border documents) |
| Sidecar | `docs.meta.jsonl` holds template, lang, docType, country, per-span format and decoy offsets, for breakdowns. It is outside the frozen schema; `validate:data` ignores it |
| Label scope | Confirmed by P1 (2026-10-18): the frozen `PII_ENTITIES` are the scope. Emails, Chinese phones and Indonesian bank accounts stay out; names stay unlabelled |
| Scope extension | The generator is split into `evals/scripts/e5/{ids,decoys,pools,templates,templates-sg}.mjs` to keep each file under 800 lines. The brief named only `gen-e5.mjs` |

## 4. Dry run against `@hogee/privacy` (p1/dev `5a555d3`, scratch script, not committed)

`redact()` ran over all 190 rows, with its UTF-16 offsets converted to code points. These numbers are a sanity check, not the E5 report.
- Exact typed matches:
  - `MY_NRIC` 38/38, `MY_BANK_ACCOUNT` 59/59, `ID_NPWP` 31/31, `SG_NRIC` 16/16;
  - `ID_NIK` 27/28, `MY_PHONE` 112/117, `SG_PHONE` 50/55, `ID_PHONE` 46/59.
- Precision: no prediction on any decoy, and 379 of 380 frozen-type predictions are exact.
- Misses (all are recognizer gaps; the labels follow the rule above):
  - bracketed ID landlines like `(061) 241 2447` (13);
  - Sabah/Sarawak 6-digit landlines like `082-291 796` and `+6082-952 957` (5);
  - a NIK written 4-4-4-4 (1);
  - bare 8-digit SG mobiles in chats, where the context word is on the line before (4);
  - `联系电话：+65 94509005`, where only `94509005` was found, so the `+65` was dropped (1).
- Privacy follow-up (their report, not re-run here):
  - `da1ed1c` on `wip/privacy` fixes the `+65` drop: the veto word "bu" was matching inside "Buddy".
  - Once P1 merges it, privacy says NIK 4-4-4-4, `(021)` landlines, the NPWP Luhn check and the 48-character bank window are in.
  - The Sabah/Sarawak landlines and the previous-line context stay open for P1.
  - Their M-series table is unchanged.

## 5. Open for P1

- If privacy's final M-series table differs from ours, regenerate (§2).
- Extraction accuracy (§15 E5) needs separate labels, such as invoice fields per document. This dataset does not provide them.
- The §4 misses are for the privacy owner to decide. The dataset should stay as it is, because these are the formats founders write.
