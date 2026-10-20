"""Checks the MY pack's provenance linkage and that Rina's facts are present, sourced and in pack units."""

import re
from urllib.parse import urlparse
import unittest
import build_my

ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
MINOR = re.compile(r"^(0|[1-9][0-9]*)$")
RECORD_FIELDS = {"id", "paths", "value", "quote", "sourceUrl", "locator", "retrievedAt", "evidence", "sourceType", "note"}
# Excerpts stay short; a few statutory sentences run slightly over 300 characters and are kept whole.
MAX_QUOTE = 450


def walk(pack, path):
    leaf = pack
    for part in path.split("."):
        leaf = leaf[int(part)] if isinstance(leaf, list) else leaf[part]
    return leaf


def leaves(value):
    if isinstance(value, dict):
        return [value] if "snippetHash" in value else [x for v in value.values() for x in leaves(v)]
    return [x for v in value for x in leaves(v)] if isinstance(value, list) else []


class MalaysiaPackTests(unittest.TestCase):
    def setUp(self):
        self.pack = build_my.build()
        self.ledger, self.records = build_my.load_ledger()

    def test_generated_file_current(self):
        self.assertEqual((build_my.DIRECTORY / "MY.json").read_bytes(), build_my.encoded())

    def test_every_leaf_matches_one_ledger_record(self):
        seen = set()
        for row in self.ledger["records"]:
            for path in row["paths"]:
                self.assertNotIn(path, seen)
                seen.add(path)
                leaf = walk(self.pack, path)
                self.assertEqual(leaf["value"], row["value"], path)
                self.assertEqual(leaf["sourceUrl"], row["sourceUrl"], path)
                self.assertEqual(leaf["retrievedAt"], row["retrievedAt"], path)
                self.assertEqual(leaf["snippetHash"], build_my.HASH.snippet_hash(row["quote"]), path)
                self.assertEqual((leaf["evidence"], leaf["sourceType"]), (row["evidence"], row["sourceType"]), path)
                # Only a person adds sign-off fields, in the ledger; the pack mirrors them and never invents one.
                for field in build_my.SIGNOFF_FIELDS:
                    self.assertEqual(leaf.get(field), row.get(field), path)
        self.assertEqual(len(leaves(self.pack)), len(seen))

    def test_ledger_records_are_checkable(self):
        for row in self.ledger["records"]:
            with self.subTest(row["id"]):
                self.assertLessEqual(RECORD_FIELDS, set(row))
                self.assertRegex(row["retrievedAt"], ISO_UTC)
                self.assertTrue(row["quote"].strip())
                self.assertLessEqual(len(row["quote"]), MAX_QUOTE)
                self.assertTrue(row["locator"].strip())
                self.assertEqual(urlparse(row["sourceUrl"]).scheme, "https")
                for extra in row.get("corroboration", []):
                    self.assertEqual(urlparse(extra["sourceUrl"]).scheme, "https")
                    self.assertTrue(extra["locator"].strip() and extra["quote"].strip())

    def test_only_the_reserve_is_a_demo_assumption(self):
        for row in self.ledger["records"]:
            with self.subTest(row["id"]):
                host = urlparse(row["sourceUrl"]).hostname
                if row["id"] == "demo-reserve":
                    self.assertEqual((row["evidence"], row["sourceType"]), ("tier3", "mock"))
                    continue
                self.assertEqual(row["sourceType"], "live")
                # project.md §26.3: tier1 only for an official government page (.gov.my).
                self.assertEqual(row["evidence"] == "tier1", host.endswith(".gov.my"))
                self.assertIn(row["evidence"], ("tier1", "tier2"))

    def test_rina_facts_present(self):
        pack = self.pack
        self.assertEqual(pack["tier"], "RESEARCHED")
        regs = {r["code"]: r for r in pack["registrations"]}
        self.assertEqual(regs["SSM_SOLE_PROP"]["entityTypes"], ["sole_prop", "partnership"])
        self.assertEqual(regs["SSM_SDN_BHD"]["entityTypes"], ["sdn_bhd"])
        self.assertEqual(regs["LHDN_TIN"]["entityTypes"], ["sole_prop", "partnership"])
        self.assertEqual(regs["LHDN_TIN"]["cost"]["value"], "0")
        self.assertEqual(pack["imports"]["taxBase"]["value"], "CIF")
        self.assertEqual(len(pack["imports"]["dutySources"]), 2)
        (cert,) = pack["imports"]["ftaCertificates"]
        self.assertEqual((cert["route"], cert["partnerCountry"], cert["dutyRateBps"]["value"]), ("FORM_E", "CN", 0))
        drink = pack["productApprovals"]["drinkware_food_contact"]
        self.assertEqual((drink["agency"]["value"], drink["cost"]["value"], drink["time"]["value"]), ("NONE", "0", 0))
        self.assertEqual(pack["dataProtection"]["breachNotificationHours"]["value"], 72)

    def test_units(self):
        pack = self.pack
        regs = {r["code"]: r for r in pack["registrations"]}
        self.assertEqual(pack["eInvoicing"]["threshold"]["value"], str(3_000_000 * 100))
        self.assertEqual(regs["SSM_SOLE_PROP"]["cost"]["value"], str(60 * 100))
        self.assertEqual(regs["SSM_SDN_BHD"]["cost"]["value"], str((1_000 + 10) * 100))
        self.assertEqual(pack["indirectTax"]["registrationThreshold"]["value"], str(500_000 * 100))
        self.assertEqual(pack["indirectTax"]["rate"]["value"], 10 * 100)
        self.assertEqual(pack["reserveFloorBps"]["value"], 300)
        for minor in (pack["eInvoicing"]["threshold"], pack["indirectTax"]["registrationThreshold"],
                      *(r["cost"] for r in pack["registrations"]),
                      pack["productApprovals"]["drinkware_food_contact"]["cost"]):
            self.assertRegex(minor["value"], MINOR)
        for count in (pack["indirectTax"]["rate"], pack["imports"]["ftaCertificates"][0]["dutyRateBps"],
                      pack["productApprovals"]["drinkware_food_contact"]["time"],
                      pack["dataProtection"]["breachNotificationHours"], pack["reserveFloorBps"]):
            self.assertIsInstance(count["value"], int)


if __name__ == "__main__":
    unittest.main()
