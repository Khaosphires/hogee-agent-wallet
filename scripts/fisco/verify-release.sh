#!/bin/bash
# verify-release.sh: check the downloaded FISCO BCOS v3.17.1 release files and install the node binary into the
# chain dir. It downloads nothing and never runs fisco-bcos; it only reads, hashes and inspects the files.
set -euo pipefail
set +x
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

usage() {
  cat <<'EOF'
Usage: verify-release.sh <dl-dir> [--dir D] [--offline]
  <dl-dir>   folder holding build_chain.sh and fisco-bcos-macOS-arm.tar.gz (as downloaded; nothing is fetched here)
  --dir D    chain dir (default ~/fisco-hogee); the binary is installed as D/bin/fisco-bcos (mode 555)
  --offline  skip the cross-check against GitHub's asset digests (`gh api`); the pinned SHA256SUMS still apply
Checks: exact sizes; SHA-256 against scripts/fisco/SHA256SUMS and GitHub's release digests; the tarball lists only
fisco-bcos; the extracted binary's size and digest; file, codesign -dv, otool -L (only the known system libraries),
the URLs inside the binary and a cloud-host grep (printed for review). Exit 0 only if every check passes.
EOF
}

DL=""
D_RAW="$HOME/fisco-hogee"
OFFLINE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) D_RAW="${2:?--dir needs a path}"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option $1" ;;
    *) [ -z "$DL" ] || die "one <dl-dir> only"; DL="$1"; shift ;;
  esac
done
[ -n "$DL" ] || { usage >&2; exit 2; }
refuse_root
[ -d "$DL" ] || die "no such folder: $DL"
DL=$(cd -- "$DL" && pwd -P)
D=$(resolve_chain_dir "$D_RAW")

BC="$DL/build_chain.sh"
TGZ="$DL/$FISCO_TARBALL"
for f in "$BC" "$TGZ"; do
  [ -f "$f" ] && [ ! -L "$f" ] || die "missing or not a regular file: $f"
done

check_file() {
  local f="$1" want_size="$2" name got
  name=$(basename -- "$f")
  got=$(size_of "$f")
  [ "$got" = "$want_size" ] || die "$name size $got, expected $want_size"
  got=$(sha256_of "$f")
  [ "$got" = "$(pinned_sha256 "$name")" ] || die "$name sha256 $got does not match SHA256SUMS"
  info "PASS $name: $want_size bytes, sha256 $got (SHA256SUMS)"
}

check_github() {
  local name="$1" want got
  want="sha256:$(pinned_sha256 "$name")"
  got=$(gh api "repos/FISCO-BCOS/FISCO-BCOS/releases/tags/$FISCO_VERSION" \
    --jq ".assets[] | select(.name == \"$name\") | .digest") || die "gh api failed (use --offline to skip)"
  [ "$got" = "$want" ] || die "$name: GitHub digest '$got' differs from SHA256SUMS"
  info "PASS $name: GitHub release digest matches"
}

check_file "$BC" "$FISCO_SIZE_BUILD_CHAIN"
check_file "$TGZ" "$FISCO_SIZE_TARBALL"
if [ "$OFFLINE" = 1 ]; then
  info "SKIP GitHub digest cross-check (--offline)"
else
  command -v gh >/dev/null || die "gh not found (use --offline to skip the GitHub cross-check)"
  check_github build_chain.sh
  check_github "$FISCO_TARBALL"
  gh api "repos/FISCO-BCOS/FISCO-BCOS/releases/tags/$FISCO_VERSION" \
    --jq '"INFO release prerelease=\(.prerelease) uploaders=\([.assets[].uploader.login] | unique | join(","))"'
fi

LIST=$(tar -tzf "$TGZ")
[ "$LIST" = "fisco-bcos" ] || die "the tarball must list exactly 'fisco-bcos', got: $(printf '%s' "$LIST" | tr '\n' ' ')"
info "PASS tarball lists exactly fisco-bcos"

# Extract into a fresh private folder inside D, check, then move into place.
prepare_chain_dir "$D"
safe_dir "$D/bin"
chmod 700 "$D/bin" # chain-up.sh leaves it read-only (555); it is read-only again when this script exits
X=$(mktemp -d "$D/bin/.extract.XXXXXX")
trap 'rm -rf -- "$X"; chmod 555 "$D/bin"' EXIT
tar -xzf "$TGZ" -C "$X" fisco-bcos
[ -f "$X/fisco-bcos" ] && [ ! -L "$X/fisco-bcos" ] || die "extracted fisco-bcos is not a regular file"
check_file "$X/fisco-bcos" "$FISCO_SIZE_BINARY"
BIN="$D/bin/fisco-bcos"
safe_target "$BIN"
if [ -e "$BIN" ]; then
  [ "$(sha256_of "$BIN")" = "$(pinned_sha256 fisco-bcos)" ] || die "$BIN exists with another digest; remove it first (D/bin is read-only: chmod 700 it)"
  info "PASS $BIN already installed (same digest)"
else
  mv -- "$X/fisco-bcos" "$BIN"
fi
chmod 555 "$BIN"
info "PASS installed $BIN (mode 555)"

# Static checks: nothing below executes the binary.
FILE_OUT=$(file -b -- "$BIN")
info "INFO file: $FILE_OUT"
case "$FILE_OUT" in *"Mach-O 64-bit executable arm64"*) ;; *) die "not a Mach-O arm64 executable" ;; esac
info "INFO codesign -dv:"
codesign -dv "$BIN" 2>&1 | sed 's/^/  /' || true

# otool -L: exactly these system libraries, from these paths (P1's inspection, 20 Oct 2026).
EXPECTED_LIBS="CoreFoundation CoreServices Network Security SystemConfiguration libSystem.B.dylib libc++.1.dylib libiconv.2.dylib"
LIBS=""
while read -r path _; do
  case "$path" in
    /System/Library/Frameworks/*.framework/*)
      fw=${path#/System/Library/Frameworks/}
      LIBS="$LIBS ${fw%%.framework/*}"
      ;;
    /usr/lib/libSystem.B.dylib | /usr/lib/libc++.1.dylib | /usr/lib/libiconv.2.dylib) LIBS="$LIBS ${path#/usr/lib/}" ;;
    *) die "otool -L: unexpected library $path" ;;
  esac
done < <(otool -L "$BIN" | tail -n +2)
# shellcheck disable=SC2086 # word splitting of the library list is intended
GOT_LIBS=$(printf '%s\n' $LIBS | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')
[ "$GOT_LIBS" = "$EXPECTED_LIBS" ] || die "otool -L: libraries '$GOT_LIBS', expected '$EXPECTED_LIBS'"
info "PASS otool -L: only $EXPECTED_LIBS"

strings -a "$BIN" >"$X/strings.txt"
URLS=$(grep -Eio 'https?://[^" ]+' "$X/strings.txt" | sort -u || true)
info "INFO URLs inside the binary: $(printf '%s\n' "$URLS" | grep -c . || true) unique"
printf '%s\n' "$URLS" | sed '/^$/d; s/^/  /'
HOSTS=$(grep -Eio '[a-z0-9.-]*(myqcloud|tencent|qq\.com|aliyun|baidu|webank)[a-z0-9./-]*' "$X/strings.txt" | sort -u || true)
info "INFO cloud-host grep (myqcloud|tencent|qq.com|aliyun|baidu|webank): $(printf '%s\n' "$HOSTS" | grep -c . || true) unique"
printf '%s\n' "$HOSTS" | sed '/^$/d; s/^/  /'
if grep -q '169\.254\.169\.254' "$X/strings.txt"; then
  info "INFO the binary contains the cloud metadata address 169.254.169.254 (AWS SDK); nodes start with"
  info "     AWS_EC2_METADATA_DISABLED=true and the node sandbox allows no such connection"
fi
info "PASS verify-release: $BIN ready (sha256 $(pinned_sha256 fisco-bcos))"
