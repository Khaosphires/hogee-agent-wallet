"""Run: python -m unittest discover -s scripts -p test_snippet_hash.py -v"""

import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("snippet-hash.py")
SPEC = importlib.util.spec_from_file_location("snippet_hash", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SnippetHashTests(unittest.TestCase):
    def test_known_sha256(self):
        self.assertEqual(MODULE.snippet_hash("abc"), "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

    def test_whitespace_equivalence(self):
        self.assertEqual(MODULE.normalize_sentence(" \tA\r\n B\u00a0\u2003C \n"), "A B C")
        self.assertEqual(MODULE.snippet_hash("A B C"), MODULE.snippet_hash("\tA\nB  C "))

    def test_utf8_and_no_unicode_normalization(self):
        self.assertEqual(MODULE.snippet_hash("中文 😀"), "0x" + hashlib.sha256("中文 😀".encode()).hexdigest())
        self.assertNotEqual(MODULE.snippet_hash("é"), MODULE.snippet_hash("e\u0301"))
        self.assertNotEqual(MODULE.snippet_hash("A"), MODULE.snippet_hash("a"))

    def test_reject_empty(self):
        for text in ("", " \r\n\t", "\u00a0"):
            with self.assertRaises(ValueError):
                MODULE.snippet_hash(text)

    def test_cli_inputs(self):
        expected = MODULE.snippet_hash("A B")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sentence.txt"
            path.write_bytes(b" A\r\n B \n")
            for args, stdin in [([" A  B "], None), (["--file", str(path)], None), (["--stdin"], b"A\tB")]:
                result = subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin, capture_output=True, check=True)
                self.assertEqual(result.stdout.decode().strip(), expected)

    def test_raw_body_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "body.bin"
            body = b"\xff A\r\n B \n"
            path.write_bytes(body)
            result = subprocess.run([sys.executable, str(SCRIPT), "--raw-file", str(path)], capture_output=True, check=True)
            self.assertEqual(result.stdout.decode().strip(), "0x" + hashlib.sha256(body).hexdigest())

    def test_cli_errors(self):
        for args, stdin in [([], None), ([""], None), (["a", "--stdin"], b"b"), (["--stdin"], b"\xff")]:
            result = subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main()
