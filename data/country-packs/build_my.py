"""Build the MY pack from captured source excerpts; never fetches the web."""

import argparse
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("snippet_hash", ROOT / "scripts/snippet-hash.py")
HASH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HASH)
DIRECTORY = Path(__file__).resolve().parent
LEDGER = ROOT / "docs/compliance/MY-source-ledger.json"
VERSION = "2026-10-18-researched.2"
SIGNOFF_FIELDS = ("verifiedBy", "verifiedOn")


def load_ledger():
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    records = {row["id"]: row for row in ledger["records"]}
    if len(records) != len(ledger["records"]):
        raise ValueError("duplicate source IDs")
    return ledger, records


def build():
    _, records = load_ledger()

    def leaf(source_id):
        row = records[source_id]
        out = {
            "value": row["value"],
            "sourceUrl": row["sourceUrl"],
            # When this research session opened the page and captured the excerpt (not the publication date).
            "retrievedAt": row["retrievedAt"],
            "snippetHash": HASH.snippet_hash(row["quote"]),
            "evidence": row["evidence"],
            "sourceType": row["sourceType"],
        }
        # Human sign-off: copied only when a person has added both fields to the ledger record.
        signoff = {k: row[k] for k in SIGNOFF_FIELDS if k in row}
        if signoff and len(signoff) != len(SIGNOFF_FIELDS):
            raise ValueError(f"{source_id}: verifiedBy and verifiedOn go together")
        return {**out, **signoff}

    return {
        "countryCode": "MY",
        "version": VERSION,
        "tier": "RESEARCHED",
        "currency": "MYR",
        "reserveFloorBps": leaf("demo-reserve"),
        "registrations": [
            {
                "code": "SSM_SOLE_PROP",
                "entityTypes": ["sole_prop", "partnership"],
                "requirement": leaf("ssm-registration-deadline"),
                "cost": leaf("ssm-trade-name-fee"),
            },
            {
                "code": "SSM_SDN_BHD",
                "entityTypes": ["sdn_bhd"],
                "requirement": leaf("ssm-sdn-bhd-requirement"),
                "cost": leaf("ssm-sdn-bhd-fee"),
            },
            {
                # Automatic TIN is sourced for individuals only; a company TIN stays absent (fails closed).
                "code": "LHDN_TIN",
                "entityTypes": ["sole_prop", "partnership"],
                "requirement": leaf("lhdn-tin-requirement"),
                "cost": leaf("lhdn-tin-cost"),
            },
        ],
        "indirectTax": {
            "rate": leaf("sales-tax-rate-tumbler"),
            "registrationThreshold": leaf("sst-registration-threshold"),
        },
        "eInvoicing": {"threshold": leaf("myinvois-threshold")},
        "imports": {
            "taxBase": leaf("imports-tax-base"),
            "dutySources": [leaf("duty-source-full-rate"), leaf("duty-source-acfta")],
            "ftaCertificates": [{
                "route": "FORM_E",
                "partnerCountry": "CN",
                "name": leaf("form-e-name"),
                "dutyRateBps": leaf("form-e-duty-tumbler"),
            }],
        },
        "productApprovals": {
            "drinkware_food_contact": {
                "agency": leaf("food-contact-agency"),
                "cost": leaf("food-contact-cost"),
                "time": leaf("food-contact-time"),
            },
        },
        "dataProtection": {
            "summary": leaf("pdp-affected-subjects"),
            "breachNotificationHours": leaf("pdp-breach-hours"),
        },
    }


def encoded():
    return (json.dumps(build(), ensure_ascii=False, indent=2) + "\n").encode("utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = DIRECTORY / "MY.json"
    expected = encoded()
    if args.check:
        if not target.exists() or target.read_bytes() != expected:
            parser.exit(1, "MY.json missing or stale; run build_my.py after reviewing source changes\n")
        print("MY.json matches source ledger (RESEARCHED; not human-verified)")
    else:
        target.write_bytes(expected)
        print("Wrote MY.json (RESEARCHED; human sign-off pending)")
