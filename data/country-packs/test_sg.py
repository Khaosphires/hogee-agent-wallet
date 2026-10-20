"""Checks the SG pack's structure, provenance linkage, hash recomputation and money units."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from urllib.parse import urlparse
import build_sg

DIRECTORY = Path(__file__).resolve().parent
RESEARCH_DIR = Path(os.environ.get("SG_RESEARCH_DIR", Path.home() / "hogee-wt/research"))


def leaves(value, path=""):
    """(dotted path, leaf) for every Sourced leaf in the pack."""
    if isinstance(value, dict):
        if "snippetHash" in value:
            return [(path, value)]
        return [x for k, v in value.items() for x in leaves(v, f"{path}.{k}" if path else k)]
    if isinstance(value, list):
        return [x for i, v in enumerate(value) for x in leaves(v, f"{path}.{i}")]
    return []


class SingaporePackTests(unittest.TestCase):
    def setUp(self):
        self.pack = build_sg.build()
        self.ledger, self.records = build_sg.load_ledger()

    def test_generated_file_current(self):
        self.assertEqual((DIRECTORY / "SG.json").read_bytes(), build_sg.encoded())

    @unittest.skipUnless((RESEARCH_DIR / "sg-a.json").exists(), "research JSON not present (it lives outside the repo)")
    def test_ledger_current_with_research(self):
        self.assertEqual(build_sg.LEDGER.read_bytes(), build_sg.dump(build_sg.import_ledger(RESEARCH_DIR)))

    def test_every_leaf_has_one_ledger_record(self):
        by_path = dict(leaves(self.pack))
        seen = set()
        for row in self.ledger["records"]:
            for path in row["paths"]:
                self.assertNotIn(path, seen)
                seen.add(path)
                leaf = by_path[path]
                self.assertEqual(leaf["value"], row["value"], path)
                self.assertEqual(leaf["sourceUrl"], row["sourceUrl"], path)
                self.assertEqual(leaf["retrievedAt"], row["retrievedAt"], path)
                self.assertEqual(leaf["snippetHash"], build_sg.HASH.snippet_hash(row["quote"]), path)
                self.assertNotIn("verifiedBy", leaf)
                self.assertNotIn("verifiedOn", leaf)
        self.assertEqual(set(by_path), seen)

    def test_hashes_recompute_with_the_cli(self):
        quotes = [(r["id"], r["quote"], r["snippetHash"]) for r in self.ledger["records"]]
        quotes += [(c["research"], c["quote"], c["snippetHash"]) for r in self.ledger["records"] for c in r.get("corroboration", [])]
        script = build_sg.ROOT / "scripts/snippet-hash.py"
        for where, quote, recorded in quotes:
            out = subprocess.run([sys.executable, str(script), "--stdin"], input=quote.encode("utf-8"), capture_output=True, check=True)
            self.assertEqual(out.stdout.decode().strip(), recorded, where)

    def test_a_tampered_snippet_or_uncertain_fact_is_refused(self):
        fact = {"snippet": "Registration to Import Processed Food Products and Food Appliances Free", "snippetHash": "0x" + "0" * 64}
        with self.assertRaisesRegex(ValueError, "snippet hashes to"):
            build_sg.checked(fact, "test")
        research = {"a": {"x": {"status": "UNCERTAIN", "snippet": "s", "snippetHash": build_sg.HASH.snippet_hash("s")}}, "b": {}}
        with self.assertRaisesRegex(ValueError, "leave it out"):
            build_sg.record(research, "x", "a", "x", ("p",), ())
        records = copy.deepcopy(self.records)
        records["acra-sp-fee-table"]["quote"] += " (edited)"
        with self.assertRaisesRegex(ValueError, "ledger records"):
            build_sg.build(records)

    def test_no_banned_word_in_pack_or_ledger(self):
        for path in (DIRECTORY / "SG.json", build_sg.LEDGER):
            text = path.read_text(encoding="utf-8").lower()
            for word in build_sg.BANNED_SUBSTRINGS:
                self.assertNotIn(word, text, path.name)
        word = build_sg.BANNED_SUBSTRINGS[0]
        with self.assertRaisesRegex(ValueError, "reword it in the mapping"):
            build_sg.refuse_banned({"records": [{"note": f"Shopee {word}s"}]}, "test")
        with self.assertRaisesRegex(ValueError, "never reword a snippet"):
            build_sg.refuse_banned({"records": [{"quote": f"Shopee {word}s"}]}, "test")

    def test_structure(self):
        p = self.pack
        self.assertEqual([p["countryCode"], p["currency"], p["tier"]], ["SG", "SGD", "RESEARCHED"])
        self.assertNotIn("eInvoicing", p)
        self.assertEqual([e["type"] for e in p["entities"]], ["sg_sole_prop", "sg_partnership", "pte_ltd"])
        self.assertEqual([(r["code"], r["entityTypes"]) for r in p["registrations"]], [("ACRA_BUSINESS", ["sg_sole_prop", "sg_partnership"]), ("ACRA_PTE_LTD", ["pte_ltd"])])
        self.assertEqual([t["code"] for t in p["taxIds"]], ["ACRA_BUSINESS", "ACRA_PTE_LTD"])
        self.assertEqual(set(p["incomeTax"]), {"summary"})
        self.assertEqual([p["indirectTax"]["rate"]["value"], p["imports"]["taxBase"]["value"], p["imports"]["ftaCertificates"]], [900, "CIF", []])
        self.assertEqual({k: v["value"] for k, v in p["imports"]["mfnDutyRateBps"].items()}, {"drinkware_food_contact": 0})
        approvals = {k: tuple(v[f]["value"] for f in ("agency", "cost", "time")) for k, v in p["productApprovals"].items()}
        self.assertEqual(approvals, {
            "drinkware_food_contact": ("SFA", "0", 1), "cosmetics": ("HSA", "1300", 0),
            "electrical": ("CPSO_SAFETY_MARK", "18000", 1), "apparel": ("NONE", "0", 0), "food": ("SFA", "0", 1),
        })
        rail = p["paymentRails"]
        self.assertEqual([(r["id"], r["feeBps"]["value"], "feeCondition" in r) for r in rail], [("PAYNOW", 0, True)])
        self.assertEqual([m["channel"] for m in p["marketplaces"]], ["shopee"])
        self.assertEqual([f["rateBps"]["value"] for f in p["marketplaces"][0]["fees"]], [1417, 327])
        self.assertTrue(all(0 < len(f["name"]) <= 80 for f in p["marketplaces"][0]["fees"]))
        self.assertEqual(p["dataProtection"]["breachNotificationHours"]["value"], 72)

    def test_reserve_mirrors_my_and_quotes_the_readme(self):
        my = json.loads((DIRECTORY / "MY.json").read_text(encoding="utf-8"))["reserveFloorBps"]
        sg = self.pack["reserveFloorBps"]
        self.assertEqual([sg["value"], sg["evidence"], sg["sourceType"]], [my["value"], my["evidence"], my["sourceType"]])
        readme = (DIRECTORY / "README.md").read_text(encoding="utf-8")
        self.assertIn(self.records["demo-reserve"]["quote"], readme)
        self.assertIn("### SG demo reserve assumption", readme)

    def test_evidence_tiers_follow_project_md(self):
        for path, leaf in leaves(self.pack):
            if path == "reserveFloorBps":
                continue
            host = urlparse(leaf["sourceUrl"]).hostname
            self.assertEqual(leaf["sourceType"], "live", path)
            self.assertEqual(leaf["evidence"], "tier1" if host.endswith(".gov.sg") else "tier2", path)

    def test_money_units_are_sgd_cents(self):
        p = self.pack
        money = [p["entities"][0]["cost"], p["entities"][2]["cost"], p["registrations"][0]["cost"], p["registrations"][1]["cost"],
                 p["indirectTax"]["registrationThreshold"]] + [v["cost"] for v in p["productApprovals"].values()]
        for leaf in money:
            self.assertIsInstance(leaf["value"], str)
            self.assertRegex(leaf["value"], r"^(0|[1-9][0-9]*)$")
        self.assertEqual(p["entities"][0]["cost"]["value"], str((15 + 100) * 100))
        self.assertEqual(p["entities"][2]["cost"]["value"], str((15 + 300) * 100))
        self.assertEqual(p["indirectTax"]["registrationThreshold"]["value"], str(1_000_000 * 100))
        self.assertEqual(p["productApprovals"]["cosmetics"]["cost"]["value"], str(13 * 100))
        self.assertEqual(p["productApprovals"]["electrical"]["cost"]["value"], str(180 * 100))

    def test_left_out_facts_stay_out(self):
        p = self.pack
        self.assertNotIn("IRAS_GST", [r["code"] for r in p["registrations"]])
        self.assertNotIn("other", p["productApprovals"])
        for key in ("finalRateBps", "exemptTurnover"):
            self.assertNotIn(key, p["incomeTax"])
        named = {row["leaf"] for row in self.ledger["notCarried"]}
        self.assertTrue({"registrations.IRAS_GST", "productApprovals.other", "marketplaces.lazada", "marketplaces.tiktok_shop", "eInvoicing",
                         "marketplaces.shopee Promo Xtra Programme (PXP) fee"} <= named)
        for source, key in build_sg.EXCLUDED_REFS:
            with self.assertRaisesRegex(ValueError, "is excluded"):
                build_sg.resolve({"a": {}, "b": {}}, source, key)
        for row in self.ledger["records"]:
            self.assertFalse(row.get("research", {}).get("status", "").startswith("UNCERTAIN"), row["id"])


if __name__ == "__main__":
    unittest.main()
