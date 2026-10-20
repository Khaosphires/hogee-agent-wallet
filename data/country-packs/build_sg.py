"""Build the SG pack: research JSON -> source ledger -> SG.json. Never fetches the web.

  build_sg.py                                  ledger -> SG.json
  build_sg.py --check                          is SG.json current with the ledger?
  build_sg.py --import-research DIR            sg-a.json + sg-b.json -> ledger (re-checks every snippetHash)
  build_sg.py --import-research DIR --check    is the ledger current with the research?

The research JSON (sg-research-a, sg-research-b) lives outside the repository; the ledger is the committed copy of the
facts this pack uses. Importing refuses a snippet that does not hash to its recorded snippetHash, an UNCERTAIN fact and
a project.md tier that disagrees with the research's own evidenceProjectMd.
"""

import argparse
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("snippet_hash", ROOT / "scripts/snippet-hash.py")
HASH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HASH)
DIRECTORY = Path(__file__).resolve().parent
LEDGER = ROOT / "docs/compliance/SG-source-ledger.json"
VERSION = "2026-10-18-researched.1"
SIGNOFF_FIELDS = ("verifiedBy", "verifiedOn")
RESEARCH = {"a": ("sg-research-a", "sg-a.json"), "b": ("sg-research-b", "sg-b.json")}

# The demo reserve is Hogee's own assumption, quoted from README.md at the commit that added it (a permalink).
README_COMMIT = "a6bbf8f292cf679fc05f71414287f488df0f899d"
DEMO_RESERVE = {
    "id": "demo-reserve",
    "paths": ["reserveFloorBps"],
    "value": 300,
    "quote": "Hogee uses a 300 basis-point reserve floor as a demo policy assumption, not a Singapore tax rate.",
    "sourceUrl": f"https://github.com/Khaosphires/hogee/blob/{README_COMMIT}/data/country-packs/README.md#sg-demo-reserve-assumption",
    "locator": "data/country-packs/README.md, section 'SG demo reserve assumption', first sentence (commit a6bbf8f)",
    "retrievedAt": "2026-10-18T14:28:48Z",
    "evidence": "tier3",
    "sourceType": "mock",
    "note": "Project-defined demo policy, not a Singapore tax rate. Mirrors MY.json's reserve leaf (300, tier3, mock), per P1's answer Q2 of 18 Oct. The compiler's SG reserve policy (500 bps) is separate.",
}

# Mapping table: ledger record id, research file, research key, pack paths, corroborating research keys (same file).
# A research key is a fact id in sg-a.json, or a dotted path under `pack` in sg-b.json (list indexes are numbers).
SOURCES = (
    ("acra-sp-fee-table", "a", "acra-sp-fee-table", ("entities.0.cost", "entities.1.cost", "registrations.0.cost"), ("acra-sp-setup-fee-115", "acra-sp-3yr-fee")),
    ("acra-sp-foreigners", "a", "acra-sp-foreigners", ("entities.0.eligibility", "entities.1.eligibility"), ("acra-sp-locals", "acra-foreigners-csp")),
    ("acra-sp-liability", "a", "acra-sp-liability", ("entities.0.liability",), ()),
    ("acra-partnership-liability", "a", "acra-partnership-liability", ("entities.1.liability",), ()),
    ("acra-co-fee-table", "a", "acra-co-fee-table", ("entities.2.cost", "registrations.1.cost"), ("acra-co-setup-fee-315",)),
    ("coa-s145-resident-director", "a", "coa-s145-resident-director", ("entities.2.eligibility",), ("acra-foreigners-csp",)),
    ("acra-company-liability", "a", "acra-company-liability", ("entities.2.liability",), ()),
    ("bnra-s5-before-business", "a", "bnra-s5-before-business", ("registrations.0.requirement",), ("bnra-s4-own-name", "acra-online-store", "acra-medisave", "cus-uen-customs-account", "sfa-uen-prereq")),
    ("coa-s145-for-incorporation", "a", "coa-s145-for-incorporation", ("registrations.1.requirement",), ("acra-foreigners-csp",)),
    ("uen-gov-identifier", "a", "uen-gov-identifier", ("taxIds.0.rule",), ("iras-sp-taxref-nric", "iras-uen-gst-number", "mof-uen-single-id")),
    ("iras-company-taxref-uen", "a", "iras-company-taxref-uen", ("taxIds.1.rule",), ("mof-uen-single-id",)),
    ("iras-sp-personal-rates", "a", "iras-sp-personal-rates", ("incomeTax.summary",), ("iras-pit-progressive", "iras-pit-first-20k", "iras-cit-17", "iras-cit-sute", "iras-cit-sute-3ya", "iras-cit-pte", "iras-cit-rebate-2026")),
    ("iras-gst-rate-9", "a", "iras-gst-rate-9", ("indirectTax.rate",), ("gsta-s16-9pct",)),
    ("iras-gst-threshold", "a", "iras-gst-threshold", ("indirectTax.registrationThreshold",), ("gsta-sc1-retrospective", "gsta-sc1-prospective", "iras-gst-compulsory")),
    ("cus-gst-cif-base", "a", "cus-gst-cif-base", ("imports.taxBase",), ("cus-customs-value-cif", "gsta-s18-import-value", "iras-import-gst-base", "iras-import-gst-everyone")),
    ("cus-dutiable-categories", "a", "cus-dutiable-categories", ("imports.dutySources.0",), ("cus-non-dutiable",)),
    ("stcced-9617", "a", "stcced-9617", ("imports.dutySources.1",), ("stcced-7323",)),
    ("cus-hs-checker", "a", "cus-hs-checker", ("imports.dutySources.2",), ()),
    ("cus-non-dutiable", "a", "cus-non-dutiable", ("imports.mfnDutyRateBps.drinkware_food_contact",), ("cus-dutiable-categories", "stcced-9617", "cus-pref-tariff")),
    ("approval-drinkware-agency", "b", "productApprovals.drinkware_food_contact.agency", ("productApprovals.drinkware_food_contact.agency",), tuple(f"productApprovals.drinkware_food_contact.supporting.{i}" for i in (1, 2, 3, 4, 5, 6))),
    ("approval-drinkware-cost", "b", "productApprovals.drinkware_food_contact.cost", ("productApprovals.drinkware_food_contact.cost",), ()),
    ("approval-drinkware-time", "b", "productApprovals.drinkware_food_contact.time", ("productApprovals.drinkware_food_contact.time",), ("productApprovals.drinkware_food_contact.supporting.0",)),
    ("approval-cosmetics-agency", "b", "productApprovals.cosmetics.agency", ("productApprovals.cosmetics.agency",), ()),
    ("approval-cosmetics-cost", "b", "productApprovals.cosmetics.cost", ("productApprovals.cosmetics.cost",), ("productApprovals.cosmetics.supporting.0",)),
    ("approval-cosmetics-time", "b", "productApprovals.cosmetics.time", ("productApprovals.cosmetics.time",), ()),
    ("approval-electrical-agency", "b", "productApprovals.electrical.agency", ("productApprovals.electrical.agency",), ()),
    ("approval-electrical-cost", "b", "productApprovals.electrical.cost", ("productApprovals.electrical.cost",), ("productApprovals.electrical.supporting.0",)),
    ("approval-electrical-time", "b", "productApprovals.electrical.time", ("productApprovals.electrical.time",), ()),
    ("approval-apparel-agency", "b", "productApprovals.apparel.agency", ("productApprovals.apparel.agency",), ("productApprovals.apparel.supporting.0",)),
    ("approval-apparel-cost", "b", "productApprovals.apparel.cost", ("productApprovals.apparel.cost",), ()),
    ("approval-apparel-time", "b", "productApprovals.apparel.time", ("productApprovals.apparel.time",), ()),
    ("approval-food-agency", "b", "productApprovals.food.agency", ("productApprovals.food.agency",), ()),
    ("approval-food-cost", "b", "productApprovals.food.cost", ("productApprovals.food.cost",), ("productApprovals.food.supporting.0",)),
    ("approval-food-time", "b", "productApprovals.food.time", ("productApprovals.food.time",), ()),
    ("paynow-fee-bps", "b", "paymentRails.0.feeBps", ("paymentRails.0.feeBps",), ("paymentRails.0.supporting.2",)),
    ("paynow-fee-condition", "b", "paymentRails.0.feeCondition", ("paymentRails.0.feeCondition",), ("paymentRails.0.feeBps", "paymentRails.0.supporting.0")),
    ("shopee-commission", "b", "marketplaces.0.fees.0.rateBps", ("marketplaces.0.fees.0.rateBps",), ("marketplaces.0.supporting.0", "marketplaces.0.supporting.1")),
    ("shopee-transaction", "b", "marketplaces.0.fees.1.rateBps", ("marketplaces.0.fees.1.rateBps",), ()),
    ("pdpa-obligations", "b", "dataProtection.summary", ("dataProtection.summary",), ("dataProtection.supporting.0", "dataProtection.supporting.2")),
    ("pdpa-breach-72h", "b", "dataProtection.breachNotificationHours", ("dataProtection.breachNotificationHours",), ("dataProtection.supporting.1",)),
)

# Value text changed from the research's wording; each change only restates the research's own snippets and notes.
VALUE_EDITS = {
    "paynow-fee-condition": (
        "Flat per-payment bank fees, not a percentage; they vary by bank and were checked at OCBC only. OCBC business "
        "accounts: a PayNow payment pays the FAST fee of SGD 0.50, and the SGD 0.20 PayNow lookup fee is waived until "
        "31 Dec 2028. 0 bps is the percentage part only.",
        "P1 (18 Oct): low confidence, keep the text honest. Says OCBC was the only bank checked (research notes) and "
        "that 0 bps is the percentage part only (research notes on feeBps).",
    ),
    "pdpa-obligations": (
        "PDPA 2012: organisations must meet consent, notification, purpose limitation, accuracy, protection, retention, "
        "transfer limitation, access/correction and data breach notification obligations. A breach that is likely to "
        "cause significant harm or is of significant scale must be notified to the PDPC and affected individuals. Notify "
        "the PDPC no later than 3 calendar days after determining that a breach is notifiable, and affected individuals "
        "at the same time or after.",
        "Appended the last sentence from breachNotificationHours and supporting 0 and 1 (P1, 18 Oct: the 72 hours count "
        "from the determination that a breach is notifiable; notify individuals too), because the hours leaf has no "
        "condition field.",
    ),
}

# Research notes reworded where they use a word the project bans (AGENT-RULES); snippets are never reworded.
NOTE_EDITS = {
    "shopee-transaction": (
        "Every successful order, all payment methods incl. PayNow; base includes buyer-paid shipping and Shopee vouchers "
        "and loyalty cashback. SPayLater 3.27%-6.54%. Applies to new sellers from day 1.",
        "P1 (18 Oct): reworded the research note's name for Shopee's loyalty cashback; the research file keeps the original.",
    ),
}

# Research facts mapped out on purpose. Importing refuses them, as a record or as corroboration.
EXCLUDED_REFS = {
    ("b", "marketplaces.0.fees.2.rateBps"): "the optional Promo Xtra Programme fee (see notCarried)",
    ("b", "marketplaces.0.supporting.2"): "the Promo Xtra Programme new-seller waiver (see notCarried)",
}
# Substrings that must not appear in any ledger or pack text outside a verbatim snippet (AGENT-RULES banned words).
# Written split so that a repository grep for the words themselves finds nothing in this file.
BANNED_SUBSTRINGS = ("c" "oin", "to" "ken")

# Shopee fee names carry each fee's condition (the schema's fee entry has only a name and a rate).
SHOPEE_FEES = (
    ("commission fee (sellers outside PXP; waived for a new seller's first 120 days)", "shopee-commission"),
    ("transaction fee", "shopee-transaction"),
)
APPROVALS = (("drinkware_food_contact", "drinkware"), ("cosmetics", "cosmetics"), ("electrical", "electrical"), ("apparel", "apparel"), ("food", "food"))

NOT_CARRIED = (
    {"leaf": "registrations.IRAS_GST", "research": "sg-research-a iras-gst-cost (UNCERTAIN), iras-gst-compulsory (CONFIRMED)",
     "reason": "The requirement is confirmed, but no IRAS page states the registration fee ('0' was inferred from the e-service listing). A registration entry needs a sourced cost, so it is left out. Launch-scale plans are not GST-registered and never need it; a GST-registered plan fails closed on registrations.IRAS_GST.cost."},
    {"leaf": "productApprovals.other", "research": "sg-research-b productApprovals.other (UNCERTAIN)",
     "reason": "A catch-all category that can hold HSA, CPSO or SFA goods, so NONE would fail open. Missing means unknown; the compiler fails closed."},
    {"leaf": "marketplaces.shopee Promo Xtra Programme (PXP) fee", "research": "sg-research-b marketplaces.0.fees.2.rateBps and marketplaces.0.supporting.2 (CONFIRMED, optional)",
     "reason": "Optional: it applies only to a seller who joins the Promo Xtra Programme (545 bps, capped at SGD 60 per item), and Mei does not. Left out on P1's instruction (18 Oct) together with its source page, whose address uses a word the project bans; the address stays in the research file only."},
    {"leaf": "marketplaces.lazada", "research": "sg-research-b marketplaces.1 (UNCERTAIN)", "reason": "No official fee page was captured; only third-party blogs."},
    {"leaf": "marketplaces.tiktok_shop", "research": "sg-research-b marketplaces.2 (UNCERTAIN)", "reason": "No official fee page was captured; only third-party blogs."},
    {"leaf": "eInvoicing", "research": "sg-research-a iras-invoicenow-all (CONFIRMED)",
     "reason": "InvoiceNow follows GST registration and has no turnover threshold; the schema refuses an eInvoicing section for SG (PACK_SECTIONS_NOT_APPLICABLE)."},
    {"leaf": "incomeTax.finalRateBps, incomeTax.exemptTurnover", "research": "sg-research-a structural",
     "reason": "SG has no final turnover tax and no turnover-based income-tax exemption."},
    {"leaf": "imports.mfnDutyRateBps.<cosmetics|electrical|apparel|food|other>", "research": "sg-research-a cus-dutiable-categories",
     "reason": "Only the tumbler tariff lines were researched. Customs lists four dutiable categories, so most goods pay no duty, but no per-category check was made (food can include intoxicating liquors). Missing means the caller passes the rate (MFN_RATE_REQUIRED)."},
    {"leaf": "imports.ftaCertificates entries", "research": "sg-research-a cus-pref-tariff",
     "reason": "Carried as [] (structural): an FTA certificate only lowers customs duty, tumblers already pay none, and no FTA lowers import GST. CN goods therefore take the MFN route at 0."},
    {"leaf": "TradeNet permit fee per consignment", "research": "sg-research-a cus-permit-fee, sg-research-b nonPack.importPermitPerConsignment",
     "reason": "No pack field. About SGD 3.19 ('319') per permit when the importer files it; SFA charges nothing for a food-contact permit. Plan copy and the LOGISTICS line only."},
    {"leaf": "tumbler HS code", "research": "sg-research-a (UNCERTAIN)",
     "reason": "9617.00.10 (vacuum-insulated) or 7323.93.90 (non-vacuum stainless); duty 0 either way. Not a pack field; only a Customs ruling is binding."},
    {"leaf": "premises registration", "research": "sg-research-a gb-hbb-no-approval (UNCERTAIN emphasis)",
     "reason": "No SG equivalent of PBT_LICENCE for an online-only home business, and no registration code exists for one."},
)


def project_tier(url):
    """project.md §26.3: tier1 = an exact sentence on an official government page (.gov.sg); else official non-government."""
    host = urlparse(url).hostname or ""
    return "tier1" if host == "gov.sg" or host.endswith(".gov.sg") else "tier2"


def checked(fact, where):
    """The fact itself, after its snippet re-hashes to the recorded snippetHash. Raises on a mismatch (never fixes it)."""
    recomputed = HASH.snippet_hash(fact["snippet"])
    if recomputed != fact["snippetHash"]:
        raise ValueError(f"{where}: snippet hashes to {recomputed}, research recorded {fact['snippetHash']}")
    return fact


def resolve(research, source, key):
    """(fact, status) for a research key; the status of an sg-b leaf is its nearest ancestor's `status`."""
    if (source, key) in EXCLUDED_REFS:
        raise ValueError(f"{RESEARCH[source][0]} {key} is excluded: {EXCLUDED_REFS[(source, key)]}")
    if source == "a":
        fact = research["a"].get(key)
        if fact is None:
            raise KeyError(f"sg-research-a has no fact {key}")
        return checked(fact, f"sg-research-a {key}"), fact["status"]
    node, status = research["b"], "CONFIRMED"
    for part in key.split("."):
        node = node[int(part)] if isinstance(node, list) else node[part]
        if isinstance(node, dict) and isinstance(node.get("status"), str):
            status = node["status"]
    return checked(node, f"sg-research-b pack.{key}"), status


def corroboration(research, source, key):
    fact, _ = resolve(research, source, key)
    entry = {"research": f"{RESEARCH[source][0]} {key}", "sourceUrl": fact["sourceUrl"], "retrievedAt": fact["retrievedAt"], "quote": fact["snippet"], "snippetHash": fact["snippetHash"]}
    return {**entry, "locator": fact["locator"]} if "locator" in fact else entry


def record(research, rid, source, key, paths, corroborating):
    fact, status = resolve(research, source, key)
    if status.startswith("UNCERTAIN"):
        raise ValueError(f"{rid}: research marks {key} {status}; leave it out")
    tier = project_tier(fact["sourceUrl"])
    if source == "b" and fact["evidenceProjectMd"] != tier:
        raise ValueError(f"{rid}: project.md tier {tier} disagrees with the research's {fact['evidenceProjectMd']}")
    row = {
        "id": rid,
        "paths": list(paths),
        "value": fact["value"],
        "quote": fact["snippet"],
        "snippetHash": fact["snippetHash"],
        "sourceUrl": fact["sourceUrl"],
        "locator": fact.get("locator", f"see {RESEARCH[source][0]} pack.{key}"),
        "retrievedAt": fact["retrievedAt"],
        "evidence": tier,
        "sourceType": fact["sourceType"],
        "research": {"agent": RESEARCH[source][0], "ref": key, "status": status, "evidence": fact["evidence"], "confidence": fact["confidence"]},
        "note": fact.get("notes", ""),
    }
    if rid in NOTE_EDITS:
        note, reason = NOTE_EDITS[rid]
        row = {**row, "note": note, "noteEdit": reason}
    if rid in VALUE_EDITS:
        value, reason = VALUE_EDITS[rid]
        row = {**row, "value": value, "researchValue": fact["value"], "valueEdit": reason}
    if corroborating:
        row = {**row, "corroboration": [corroboration(research, source, k) for k in corroborating]}
    return row


def banned_text(value, path="", quote=False):
    """(path, is_snippet) for every string under `value` holding a banned substring; quotes are flagged, never changed."""
    if isinstance(value, dict):
        return [x for k, v in value.items() for x in banned_text(v, f"{path}.{k}", quote or k == "quote")]
    if isinstance(value, list):
        return [x for i, v in enumerate(value) for x in banned_text(v, f"{path}.{i}", quote)]
    if isinstance(value, str) and any(b in value.lower() for b in BANNED_SUBSTRINGS):
        return [(path, quote)]
    return []


def refuse_banned(value, name):
    hits = banned_text(value)
    if any(is_snippet for _, is_snippet in hits):
        raise ValueError(f"{name}: a verbatim snippet holds a banned word ({hits}); escalate to P1, never reword a snippet")
    if hits:
        raise ValueError(f"{name}: banned word outside a snippet at {[path for path, _ in hits]}; reword it in the mapping")
    return value


def import_ledger(directory):
    files = {s: json.loads((Path(directory) / name).read_text(encoding="utf-8")) for s, (_, name) in RESEARCH.items()}
    research = {"a": {f["id"]: f for f in files["a"]["facts"]}, "b": files["b"]["pack"]}
    if len(research["a"]) != len(files["a"]["facts"]):
        raise ValueError("duplicate fact ids in sg-research-a")
    reserve = {**DEMO_RESERVE, "snippetHash": HASH.snippet_hash(DEMO_RESERVE["quote"])}
    return refuse_banned({
        "reviewedOn": "2026-10-18",
        "reviewer": "AI-assisted copy by agent sg-pack of the sg-research-a and sg-research-b facts; human sign-off pending",
        "research": {agent: files[s]["generatedAt"] for s, (agent, _) in RESEARCH.items()},
        "tierConvention": "project.md §26.3: tier1 = exact sentence on a .gov.sg page; tier2 = official non-government source; tier3 = demo assumption. research.evidence keeps the research's own grade.",
        "records": [reserve, *(record(research, *row) for row in SOURCES)],
        "notCarried": list(NOT_CARRIED),
    }, "SG-source-ledger.json")


def load_ledger():
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    records = {row["id"]: row for row in ledger["records"]}
    if len(records) != len(ledger["records"]):
        raise ValueError("duplicate source IDs")
    return ledger, records


def build(records=None):
    """The pack from the ledger's records (or the given ones); refuses a quote that does not hash to its snippetHash."""
    records = load_ledger()[1] if records is None else records

    def leaf(source_id):
        row = records[source_id]
        digest = HASH.snippet_hash(row["quote"])
        if digest != row["snippetHash"]:
            raise ValueError(f"{source_id}: quote hashes to {digest}, ledger records {row['snippetHash']}")
        out = {
            "value": row["value"],
            "sourceUrl": row["sourceUrl"],
            # When the research session captured the page (not its publication date).
            "retrievedAt": row["retrievedAt"],
            "snippetHash": digest,
            "evidence": row["evidence"],
            "sourceType": row["sourceType"],
        }
        # Human sign-off: copied only when a person has added both fields to the ledger record.
        signoff = {k: row[k] for k in SIGNOFF_FIELDS if k in row}
        if signoff and len(signoff) != len(SIGNOFF_FIELDS):
            raise ValueError(f"{source_id}: verifiedBy and verifiedOn go together")
        return {**out, **signoff}

    def approval(short):
        return {field: leaf(f"approval-{short}-{field}") for field in ("agency", "cost", "time")}

    return {
        "countryCode": "SG",
        "version": VERSION,
        "tier": "RESEARCHED",
        "currency": "SGD",
        "reserveFloorBps": leaf("demo-reserve"),
        "entities": [
            {"type": "sg_sole_prop", "cost": leaf("acra-sp-fee-table"), "eligibility": leaf("acra-sp-foreigners"), "liability": leaf("acra-sp-liability")},
            {"type": "sg_partnership", "cost": leaf("acra-sp-fee-table"), "eligibility": leaf("acra-sp-foreigners"), "liability": leaf("acra-partnership-liability")},
            {"type": "pte_ltd", "cost": leaf("acra-co-fee-table"), "eligibility": leaf("coa-s145-resident-director"), "liability": leaf("acra-company-liability")},
        ],
        # No IRAS_GST entry: its fee is unsourced (see the ledger's notCarried); launch scale never needs it.
        "registrations": [
            {"code": "ACRA_BUSINESS", "entityTypes": ["sg_sole_prop", "sg_partnership"], "requirement": leaf("bnra-s5-before-business"), "cost": leaf("acra-sp-fee-table")},
            {"code": "ACRA_PTE_LTD", "entityTypes": ["pte_ltd"], "requirement": leaf("coa-s145-for-incorporation"), "cost": leaf("acra-co-fee-table")},
        ],
        "taxIds": [
            {"code": "ACRA_BUSINESS", "rule": leaf("uen-gov-identifier")},
            {"code": "ACRA_PTE_LTD", "rule": leaf("iras-company-taxref-uen")},
        ],
        "incomeTax": {"summary": leaf("iras-sp-personal-rates")},
        "indirectTax": {"rate": leaf("iras-gst-rate-9"), "registrationThreshold": leaf("iras-gst-threshold")},
        "imports": {
            "taxBase": leaf("cus-gst-cif-base"),
            "dutySources": [leaf("cus-dutiable-categories"), leaf("stcced-9617"), leaf("cus-hs-checker")],
            "ftaCertificates": [],
            "mfnDutyRateBps": {"drinkware_food_contact": leaf("cus-non-dutiable")},
        },
        "productApprovals": {category: approval(short) for category, short in APPROVALS},
        "paymentRails": [{"id": "PAYNOW", "feeBps": leaf("paynow-fee-bps"), "feeCondition": leaf("paynow-fee-condition")}],
        "marketplaces": [{"channel": "shopee", "fees": [{"name": name, "rateBps": leaf(rid)} for name, rid in SHOPEE_FEES]}],
        "dataProtection": {"summary": leaf("pdpa-obligations"), "breachNotificationHours": leaf("pdpa-breach-72h")},
    }


def dump(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def encoded():
    return dump(refuse_banned(build(), "SG.json"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--import-research", metavar="DIR", type=Path)
    args = parser.parse_args()
    if args.import_research:
        target, expected, name = LEDGER, dump(import_ledger(args.import_research)), "SG-source-ledger.json"
    else:
        target, expected, name = DIRECTORY / "SG.json", encoded(), "SG.json"
    if args.check:
        if not target.exists() or target.read_bytes() != expected:
            parser.exit(1, f"{name} missing or stale; rebuild it after reviewing the source change\n")
        print(f"{name} is current (RESEARCHED; human sign-off pending)")
    else:
        target.write_bytes(expected)
        print(f"Wrote {name} (RESEARCHED; human sign-off pending)")


if __name__ == "__main__":
    main()
