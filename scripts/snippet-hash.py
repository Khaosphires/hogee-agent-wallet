"""SHA-256 of a UTF-8 sentence after trimming/collapsing Unicode whitespace.

Usage: python scripts/snippet-hash.py "sentence"
       python scripts/snippet-hash.py --file sentence.txt
       python scripts/snippet-hash.py --stdin
API response bodies must use --raw-file (no decoding or normalization).
"""

import argparse
import hashlib
from pathlib import Path
import sys


def normalize_sentence(sentence: str) -> str:
    """Use Python str.split whitespace semantics; preserve case and Unicode forms."""
    normalized = " ".join(sentence.split())
    if not normalized:
        raise ValueError("sentence must contain non-whitespace text")
    return normalized


def snippet_hash(sentence: str) -> str:
    return "0x" + hashlib.sha256(normalize_sentence(sentence).encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sentence", nargs="?")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--file", type=Path)
    group.add_argument("--stdin", action="store_true")
    group.add_argument("--raw-file", type=Path)
    args = parser.parse_args()
    if sum([args.sentence is not None, args.file is not None, args.stdin, args.raw_file is not None]) != 1:
        parser.error("provide exactly one sentence, --file, --stdin, or --raw-file")
    try:
        if args.raw_file is not None:
            result = "0x" + hashlib.sha256(args.raw_file.read_bytes()).hexdigest()
        else:
            sentence = args.sentence
            if args.file is not None:
                sentence = args.file.read_bytes().decode("utf-8")
            elif args.stdin:
                sentence = sys.stdin.buffer.read().decode("utf-8")
            result = snippet_hash(sentence)
        print(result)
        return 0
    except (OSError, UnicodeError, ValueError) as exc:
        parser.exit(2, f"snippet-hash: {exc}\n")


if __name__ == "__main__":
    sys.exit(main())
