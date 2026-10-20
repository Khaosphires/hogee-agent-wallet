"""P3 task 3.4: deterministic RFC 8785 + Ethereum Keccak-256 reference vectors."""
import argparse
import json
from pathlib import Path

import rfc8785
from Crypto.Hash import keccak

OUTPUT = Path(__file__).with_name("hash-vectors.json")
EMPTY_KECCAK = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"


def digest(data: bytes) -> str:
    return "0x" + keccak.new(digest_bits=256, data=data).hexdigest()


def inputs():
    # 2**53 is exactly representable as binary64. rfc8785 intentionally rejects
    # Python integers outside the safe integer range, so this boundary is a float.
    # Real money remains a digit string; never use this as permission to round it.
    return [
        ("key-ordering", {"b": 2, "a": 1}),
        ("key-ordering-same-object", {"a": 1, "b": 2}),
        ("nested-key-ordering", {"z": {"b": 2, "a": 1}, "a": [{"y": 2, "x": 1}]}),
        ("utf16-key-ordering", {"\ue000": "private-use", "😀": "emoji", "a": "ascii", "é": "accent"}),
        ("unicode-values", {"name": "Rina", "text": "你好 — café", "emoji": "😀🧾"}),
        ("unicode-no-normalization", {"composed": "é", "decomposed": "e\u0301"}),
        ("escaped-controls", {"text": '\"\\\b\f\n\r\t\x00\x1f/'}),
        ("empty-object", {}),
        ("empty-array", []),
        ("empty-string", ""),
        ("booleans-null", {"true": True, "false": False, "null": None}),
        ("top-level-null", None),
        ("top-level-true", True),
        ("top-level-false", False),
        ("safe-integer-boundaries", [-9007199254740991, -1, 0, 1, 9007199254740991]),
        ("binary64-two-to-53", float(2**53)),
        ("minor-string", {"amountMinor": "1000000"}),
        ("large-minor-string", {"amountMinor": "9007199254740993"}),
        ("string-versus-number", ["100", 100]),
        ("negative-zero", -0.0),
        ("positive-zero", 0),
        ("number-formatting", [1.0, 1e-7, 1e-6, 1e20, 1e21, 333333333.3333333]),
        ("array-order-preserved", [3, 1, 2, {"b": 2, "a": 1}]),
    ]


def build():
    if digest(b"") != EMPTY_KECCAK:
        raise RuntimeError("Keccak sanity check failed; SHA3-256 is not interchangeable")
    rows = []
    for name, value in inputs():
        canonical = rfc8785.dumps(value)
        rows.append({"name": name, "input": value, "jcs": canonical.decode("utf-8"),
                     "keccak256": digest(canonical)})
    return rows


def render():
    return (json.dumps(build(), ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the checked-in file differs; write nothing")
    args = parser.parse_args()
    content = render()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_bytes() != content:
            raise SystemExit("Golden vectors missing or stale; run build_vectors.py and review the diff")
        print(f"{len(build())} golden vectors match a fresh Python computation")
    else:
        OUTPUT.write_bytes(content)
        print(f"Wrote {len(build())} golden vectors to {OUTPUT.name}")
