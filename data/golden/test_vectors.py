import hashlib
import json
import unittest

import rfc8785
from build_vectors import OUTPUT, EMPTY_KECCAK, build, digest, render


class GoldenVectorsTest(unittest.TestCase):
    def setUp(self):
        self.rows = {row["name"]: row for row in build()}

    def test_empty_keccak_is_not_sha3(self):
        self.assertEqual(digest(b""), EMPTY_KECCAK)
        self.assertNotEqual(digest(b""), "0x" + hashlib.sha3_256(b"").hexdigest())

    def test_checked_in_bytes_are_current(self):
        self.assertEqual(OUTPUT.read_bytes(), render())

    def test_every_row_recomputes_after_json_roundtrip(self):
        rows = json.loads(OUTPUT.read_text(encoding="utf-8"))
        self.assertEqual(len(rows), len({r["name"] for r in rows}))
        for row in rows:
            self.assertEqual(set(row), {"name", "input", "jcs", "keccak256"})
            data = rfc8785.dumps(row["input"])
            self.assertEqual(data.decode("utf-8"), row["jcs"])
            self.assertEqual(digest(data), row["keccak256"])

    def test_ordering_and_equivalence(self):
        a, b = (self.rows[n] for n in ["key-ordering", "key-ordering-same-object"])
        self.assertEqual(a["jcs"], '{"a":1,"b":2}')
        self.assertEqual(a["keccak256"], b["keccak256"])
        self.assertEqual(list(json.loads(self.rows["utf16-key-ordering"]["jcs"])), ["a", "é", "😀", "\ue000"])
        self.assertTrue(self.rows["array-order-preserved"]["jcs"].startswith('[3,1,2,'))

    def test_unicode_is_not_normalized(self):
        value = json.loads(self.rows["unicode-no-normalization"]["jcs"])
        self.assertNotEqual(value["composed"], value["decomposed"])

    def test_numeric_boundaries(self):
        self.assertEqual(self.rows["binary64-two-to-53"]["jcs"], "9007199254740992")
        self.assertEqual(self.rows["negative-zero"]["keccak256"], self.rows["positive-zero"]["keccak256"])
        self.assertEqual(self.rows["number-formatting"]["jcs"], '[1,1e-7,0.000001,100000000000000000000,1e+21,333333333.3333333]')
        self.assertEqual(self.rows["large-minor-string"]["jcs"], '{"amountMinor":"9007199254740993"}')

    def test_unsafe_python_integer_rejected(self):
        with self.assertRaises(rfc8785.IntegerDomainError):
            rfc8785.dumps(2**53)

    def test_nonfinite_numbers_and_lone_surrogates_rejected(self):
        for value in [float("nan"), float("inf"), float("-inf"), "\ud800"]:
            with self.subTest(value=repr(value)), self.assertRaises(rfc8785.CanonicalizationError):
                rfc8785.dumps(value)


if __name__ == "__main__":
    unittest.main()
