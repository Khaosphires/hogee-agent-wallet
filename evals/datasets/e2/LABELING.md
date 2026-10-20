# E2 labelling rules (task 1.3b)

**Owner:** P1 writes this file; P3 labels with it.
**Status:** approved 2026-10-17. The five open decisions are settled (D4–D8, marked **Decided**), so labelling can start. Every line marked **[VERIFY]** takes its number from the verified country pack, not from this file.

E2 measures plan quality (project.md §15). For each of the 40 prompts, the label is the plan a careful human would compile from three inputs:
- the prompt;
- the true value of its hidden slot;
- the **verified** country pack (`data/country-packs/SG.json`, `MY.json`; `ID.json`).

The label never depends on what any model said. Labels are written before any run and frozen at gate G4 (git tag `labels-frozen`).

## 1. Row format

`evals/datasets/e2/labels.jsonl`, one row per prompt (project.md §26.8):

```json
{"promptId":"e2-my-001","fields":{"entityType":"sole_prop","registrations":["SSM_SOLE_PROP","LHDN_TIN"],"indirectTaxRegistered":false,"eInvoicing":false,"dutyRoute":"FORM_E","productApproval":"NONE","reserveBps":500,"licenceCostMinor":"6000"}}
```

**How each field is scored:**
- `registrations`: compared as a **set** (order ignored).
- `licenceCostMinor`: exact digit string.
- All other fields: exact match.
- That makes 8 fields × 40 prompts = 320 labels.

## 2. Assumptions every label shares

1. **Launch scale.** First-year turnover is below every registration threshold unless the prompt says otherwise. Budgets in the set are S$2k–S$20k and RM2k–RM50k (Rp5m–Rp150m).
2. **Selling online only.** Marketplaces or an own site from home, with no physical shop, unless the prompt says otherwise.
3. **Every plan-changing fact is either stated in the prompt or is the prompt's `hiddenSlot`.**
   - The plan-changing facts are residency, product category, buy-from country and budget ceiling.
   - If a label needs a fact that is neither stated nor hidden, the prompt is defective. Fix the prompt; don't guess.
4. **Hidden slot.** Label as if the agent asked and got the hidden slot's true value. The eval auto-answers from `hiddenSlot`.

## 3. Field rules

### 3.1 `entityType`

| Country | Situation | Label |
|---|---|---|
| MY | citizen or PR, solo | `sole_prop` |
| MY | citizen or PR, prompt names a partner or co-founder | `partnership` |
| MY | foreigner (any) | `sdn_bhd` (foreigners can't register a sole proprietorship) |
| MY | prompt explicitly asks for limited liability or outside investors | `sdn_bhd` |
| ID | citizen, solo | `perorangan` (keeps the 0.5% final tax, PP 20/2026) |
| ID | citizen, solo, explicitly wants a legal entity / limited liability | `pt_perorangan` (also keeps the 0.5% rate) |
| ID | citizen with partners | `cv`. **Decided (D4):** a CV loses the permanent 0.5% rate, so score the agent's warning about that separately |
| ID | foreigner (any) | `pt` (foreign-owned PT) |
| SG | citizen, PR or foreigner, solo | `sg_sole_prop` |
| SG | prompt names a partner or co-founder | `sg_partnership` |
| SG | prompt explicitly asks for limited liability or outside investors (shareholders) | `pte_ltd` |
| SG | the pack's `entities[].eligibility` doesn't list the founder's residency for the type above | `pte_ltd`. SG.json lists citizen, PR and foreigner for all three types (a foreigner registers through local representation, SG-DECISIONS 23:25), so this never applies today |

### 3.2 `registrations` (set)

| Country | Rule |
|---|---|
| MY | `sole_prop` or `partnership` → `SSM_SOLE_PROP`; `sdn_bhd` → `SSM_SDN_BHD`. **Always** `LHDN_TIN`. Add `SST` only if `indirectTaxRegistered` is true. Add `MYINVOIS` only if `eInvoicing` is true. Add `PBT_LICENCE` only if the prompt has physical premises (shop, stall, kitchen open to customers) |
| ID | **Always** `NIB_OSS`. Citizens: `NPWP_NIK` (the NIK is the tax number since 1 Jul 2024). Add `PKP` only if `indirectTaxRegistered` is true |
| SG | `sg_sole_prop` or `sg_partnership` → `ACRA_BUSINESS`; `pte_ltd` → `ACRA_PTE_LTD`. The UEN that ACRA assigns is the tax reference, so there is no separate tax-id registration. Add `IRAS_GST` only if `indirectTaxRegistered` is true. As in D8, a sole proprietor or partnership registers its business name even when the prompt gives none: a marketplace shop sells under a name, so the exemption for the owner's own full NRIC name never applies |

### 3.3 `indirectTaxRegistered` (boolean: must register at launch)

- **MY (SST):** true only if the business manufactures taxable goods or sells taxable services above the threshold in `indirectTax.registrationThreshold` **[VERIFY]**. A reseller importing finished goods is **false**; import sales tax is still paid at the border, but that isn't registration.
- **ID (PKP):** true only if expected turnover is above `indirectTax.registrationThreshold` (Rp4.8bn **[VERIFY]**). At launch scale this is false.
- **SG (GST):** true only if expected taxable turnover is above `indirectTax.registrationThreshold` (SGD 1M **[VERIFY]**). At launch scale this is false. Import GST is still paid at the border, but that isn't registration.

### 3.4 `eInvoicing` (boolean: required at launch)

- **MY (MyInvois):** true only if expected turnover is at or above `eInvoicing.threshold` (RM3M per guideline v4.8 **[VERIFY on LHDN]**). At launch scale this is false.
- **ID (e-Faktur):** true only for PKP, so false whenever `indirectTaxRegistered` is false.
- **SG (InvoiceNow):** follows GST registration, so false whenever `indirectTaxRegistered` is false. SG.json has no `eInvoicing` section (the schema refuses one for SG).

### 3.5 `dutyRoute`

| Situation | Label |
|---|---|
| Buys from inside the selling country (domestic supplier) | `EXEMPT` |
| Buys from CN into MY or ID, goods covered by ACFTA | `FORM_E` |
| Buys from CN into SG | `MFN`. SG.json lists no Form E (`ftaCertificates: []`) and sources the MFN duty, which is 0 for non-dutiable goods. Never `EXEMPT`: that route is domestic only and would also zero the import GST |
| Buys from any other country, or from CN with goods excluded from ACFTA | `MFN` |
| Buys from another ASEAN country | **Decided (D5):** ATIGA (Form D) isn't in the enum, so these are left out of the 40 prompts |

### 3.6 `productApproval` (one value)

| `productCategory` | MY | ID | SG (from `productApprovals.<category>.agency` **[VERIFY]**) |
|---|---|---|---|
| `drinkware_food_contact` | **[VERIFY]**: `KKM_FOOD` or `NONE` (open question in project.md §10.2) | **[VERIFY]** | `SFA` (importer registration for food-contact articles, fee 0; not `NONE`) |
| `cosmetics` | `NPRA` | `BPOM` | `HSA` (cosmetic product notification) |
| `electrical` | `ST_SIRIM` | **[VERIFY]**: no ID value in the enum. Proposal: exclude from ID prompts | `CPSO_SAFETY_MARK` (controlled goods) |
| `food` | `KKM_FOOD` **[VERIFY]** | `BPJPH_HALAL` (halal is mandatory for micro/small food businesses from Oct 2026 **[VERIFY date]**) | `SFA` (processed food importer registration) |
| `apparel` | `NONE` | `NONE` | `NONE` |
| `other` | `NONE` | `NONE` | Not in SG.json, so not labelled: leave it out of SG prompts |

- Halal is voluntary in MY, so `JAKIM_HALAL` is labelled only if the prompt asks for halal certification.
- If two approvals apply, label the first one in this order: `NPRA`, `BPOM`, `ST_SIRIM`, `KKM_FOOD`, `BPJPH_HALAL`, `JAKIM_HALAL`. The compiler must use the same order. **Decided (D6):** keep the single frozen field and this order.
- SG approvals bind the business that imports the goods. So an SG prompt in a regulated category imports it; a founder who buys one locally from another importer isn't labelled, because the pack has no rule for that case.

### 3.7 `reserveBps` (integer)

**Decided (D7):** the compiler uses this reserve policy:

| Country / entity | `reserveBps` | Why |
|---|---|---|
| MY, any entity | 500 | Income-tax set-aside; matches the Rina demo (`reserveFloorBps` 300 in the facility, plan 500) |
| ID, `perorangan` / `pt_perorangan` | 50 | 0.5% final tax on turnover (PP 20/2026) |
| ID, `cv` / `pt` | 500 | Same set-aside as MY |
| SG, any entity | 500 | Mirrors MY (P1, SG-DECISIONS Q2); SG.json `reserveFloorBps` 300 |

The rule the compiler implements is `reserveBps = max(countryPack.reserveFloorBps, value above)`.

### 3.8 `licenceCostMinor` (digit string)

The sum of **mandatory government fees for the first year** for the labelled registrations and approval, in facility-currency minor units (MYR: sen, so RM60 = `"6000"`; SGD: cents; IDR × 100).

- Excludes professional or agent fees, optional items and anything voluntary.
- Every number comes from a country-pack leaf **[VERIFY]**. Current spec values:
  - MY sole proprietorship: RM60/yr with a business name, RM30/yr in the owner's own name. If the prompt names a shop or brand, use the business-name fee; if it gives no name, still use the business-name fee, since marketplace shops need one. **Decided (D8).**
  - MY Sdn Bhd: incorporation ~RM1,000–1,010 + RM50 name search. Use the pack's exact figure.
  - MY NPRA: RM50 per product. Use the product count from the prompt; default 1.
  - ID NIB: free (0). BPOM fees for micro businesses are waived under PP 15/2026 **[VERIFY]**.
  - SG `ACRA_BUSINESS`: S$115 (`"11500"`: S$15 name application + S$100 one-year registration). `ACRA_PTE_LTD`: S$315 (`"31500"`).
  - SG approvals: the pack's `productApprovals.<category>.cost` × the product count from the prompt (default 1): SFA 0, HSA S$13 per product in the general cosmetics tier (eye, lip, oral and hair-dye products cost S$28, so the set leaves them out), CPSO S$180 per registered product.
  - MY `LHDN_TIN` counts 0 for every entity. MY.json scopes its 0 to individuals; LHDN states no fee for a company's TIN either.

## 4. Process

1. P3 writes the 40 prompts first (24 SG / 16 MY / no ID, P1's Q4 of 18 Oct, which replaces 30 MY / 10 ID; 20 vague, each with exactly one `hiddenSlot`).
2. **Two labellers** label every row independently: P3, plus P1 or P2.
3. **Disagreements:** resolve them by reading this file. If this file is ambiguous, fix this file, not the row, and note the fix in the change log below.
4. **Commit the labels** before any eval run. CI validates the rows against the frozen schema (`pnpm validate:data`).
5. **Tag `labels-frozen` at G4.** After that, only add rows; never edit a label.

## Change log

- 2026-10-15: first draft (P1's AI).
- 2026-10-18: SG rows added (agent `evals-e2`, from SG-DESIGN §3 "evals (E2)" and P1's Q2 and Q4); the split is now 24 SG / 16 MY. Also: the MY `LHDN_TIN` fee for a Sdn Bhd (§3.8), and SG approvals bind the importer (§3.6).
