# Golden hash vectors — P3 task 3.4

`hash-vectors.json` contains 23 real, computed reference rows in the frozen `{name, input, jcs, keccak256}` format. These are exact hashing expectations, unlike the mock hashes in the UI fixtures. No P1/P2 files are changed.

Each digest is **Keccak-256 of the UTF-8 bytes of the RFC 8785 canonical JSON**, prefixed with `0x`. Do not hash pretty-printed JSON, add a newline, normalize Unicode, or substitute NIST SHA3-256. This suite does not cover EIP-712 or salted rationale concatenation.

## Generate and test (Python 3.12)

From the repository root, preferably in your own virtual environment:

```sh
python -m pip install -r data/golden/requirements.txt
python data/golden/build_vectors.py
python data/golden/build_vectors.py --check
python -m unittest discover -s data/golden -p "test_*.py" -v
pnpm --filter @hogee/core validate:data --require "data/golden/hash-vectors.json"
```

Generation is deterministic and performs no network calls. `--check` recomputes the full file and exits nonzero for a missing or changed file. Only the generator writes the JSON; never type or edit expected digests manually.

## Independent JavaScript check

Install into an uncommitted scratch directory to avoid modifying shared package manifests:

```sh
npm install --prefix .p3-tools --no-audit --no-fund --ignore-scripts canonicalize@2.1.0 @noble/hashes@1.8.0
```

PowerShell:

```powershell
$env:NODE_PATH = (Resolve-Path .p3-tools/node_modules).Path
node data/golden/check_vectors.cjs
Remove-Item Env:NODE_PATH
```

POSIX shell: `NODE_PATH="$PWD/.p3-tools/node_modules" node data/golden/check_vectors.cjs`.

The independent check uses canonicalize and noble-hashes, while generation uses rfc8785 and PyCryptodome. Both check the known empty-byte Keccak digest before processing vectors. Empty bytes are not JSON, so that sanity check is separate from the JSON array. Do not commit `.p3-tools`, virtual environments, caches or installed dependencies.

## Coverage and edge cases

- Recursive key ordering, equivalent objects with different insertion order, and preserved array order.
- UTF-16 property ordering: the emoji key sorts before the U+E000 key, unlike Python code-point sorting.
- Unicode/emoji values, composed versus decomposed characters (no normalization), escapes/control characters, empty objects/arrays/strings.
- Top-level and nested booleans/null; safe positive/negative integers through 2^53−1; an exact binary64 value of 2^53; number-format thresholds and negative zero.
- Minor-unit strings, including "9007199254740993", which must remain a string to avoid precision loss.

`rfc8785` rejects Python integer objects outside ±(2^53−1). The 2^53 boundary vector therefore uses `float(2**53)`, which is exactly representable; it does not round an unsafe integer into a fixture. Its JSON input may show `.0`, while JCS emits `9007199254740992`. Larger monetary amounts stay strings. Tests separately reject unsafe Python integers, NaN/infinities and lone surrogates.

P1 can import the rows into the TypeScript hash tests and assert both the canonical string and digest for every row. Duplicate digests for the equivalent-object pair and positive/negative zero are intentional. P1’s own hashing implementation must still run against these vectors; the independent JS cross-check is not a claim that their implementation has been tested.
