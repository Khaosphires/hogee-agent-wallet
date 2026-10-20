#!/usr/bin/env bash
# scripts/fisco/anchor.sh --pack evidence/fisco/fm-<16hex> [--rpc <url>]
#
# The public Sepolia timestamp of a FISCO mirror pack (docs/fisco/ANCHOR.md). P1 or the user runs it, by hand, once
# per pack: it sends ONE Sepolia tx from the hogee-deployer keystore to itself, value 0, whose input is the plain
# ASCII anchor text naming the pack and keccak256(hashes.json), then writes evidence/fisco/anchors/<packId>.sepolia.json.
#
#   0. The keystore password and the [y/N] answer are read from the controlling terminal (/dev/tty) only, never from
#      stdin: a pipe, a here-doc or `yes |` can neither unlock the key nor approve the send. Without a controlling
#      terminal it refuses before anything else. Test-only: with HOGEE_ANCHOR_KEYSTORE set, both come from stdin (and
#      the hogee-deployer's address is then refused).
#   1. Works in a fresh mktemp -d folder; cast runs there with a scrubbed environment (PATH and HOME only, plus the
#      RPC URL as ETH_RPC_URL, so the URL is never on a command line), with no stdin, and next to an empty
#      foundry.toml, so Foundry's project-root search stops there: no repo .env or foundry.toml (nor one in a parent
#      of the temp folder) is read, and the FISCO scripts' dead-proxy environment is not used. cast's stderr is never
#      shown as is (it can quote the RPC URL, or a node's text): URLs are replaced and control bytes dropped.
#   2. `cast chain-id` must be 11155111.
#   3. Prints the text, the calldata and what Etherscan's "View input as UTF-8" will show; cast from-utf8 must agree.
#   4. Reads the keystore password hidden (read -rsp) into a mode-600 file in that folder, removed on exit.
#   5. Sets every fee field itself, so the RPC shapes nothing it signs: the nonce from `cast nonce` (latest, and no
#      pending tx), the gas limit from the calldata (21,000 + the larger of 16 per non-zero byte and EIP-7623's floor
#      of 40, + 2,000; `cast estimate` must not need more), a base fee from `cast base-fee` of at most 20 gwei, a max
#      priority fee of 1 gwei and a max fee of min(2 x base + 1 gwei, 50 gwei).
#   6. `cast mktx` signs (to = the signer, the calldata as raw input); the password file is removed right after.
#   7. `cast decode-transaction` AND fisco:anchor check-raw must both show chain 11155111, to = self, value 0, the
#      exact input, EIP-1559, the nonce read, gas <= 60,000, max fee <= 50 gwei and max priority fee <= 2 gwei;
#      otherwise nothing is sent.
#   8. Drains anything typed ahead on the terminal, then asks [y/N] (naming the nonce, gas limit, both fee caps and
#      the most it can cost in ETH), then `cast publish`.
#   9. fisco:anchor capture polls the receipt and writes the sidecar (exclusive create, no links).
#
# The URL comes from --rpc, else SEPOLIA_RPC_URL_CAPTURE, else the public node; https only (plain http only on
# 127.0.0.1), no userinfo; it is never printed. Test-only override: HOGEE_ANCHOR_KEYSTORE (a throwaway keystore);
# the default is the hogee-deployer's, whose address must be ANCHOR_SIGNER; with the override, the password and the
# answer come from stdin, so ANCHOR_SIGNER is refused there. Refuses to run when the pack is already anchored.
set -euo pipefail
umask 077

ANCHOR_SIGNER="0x46405e378F5AC837b8E18a96105e3ff3CCB22251"
SEPOLIA_CHAIN_ID=11155111
SEPOLIA_CHAIN_ID_HEX="0xaa36a7"
DEFAULT_RPC="https://ethereum-sepolia-rpc.publicnode.com"
DEFAULT_KEYSTORE="$HOME/.foundry/keystores/hogee-deployer"
FOUNDRY_BIN="$HOME/.foundry/bin"
CAST="$FOUNDRY_BIN/cast"
JQ=/usr/bin/jq
TEXT_RE='^hogee-fisco-anchor v1 pack=(fm-[0-9a-f]{16}) hashes=0x[0-9a-f]{64} chain=20200 head=(0|[1-9][0-9]{0,15}) head-hash=0x[0-9a-f]{64}$'
GWEI=1000000000
MAX_BASE_FEE=$((20 * GWEI))
MAX_FEE_CAP=$((50 * GWEI))
PRIORITY_FEE=$((1 * GWEI))
MAX_PRIORITY_FEE=$((2 * GWEI))
MAX_GAS_LIMIT=60000
GAS_HEADROOM=2000
DRAIN_MAX_CHARS=4096

die() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
info() {
  printf '%s\n' "$*"
}
lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}
# fmt_units <integer> <decimals>: the integer scaled down by 10^decimals, trailing zeros trimmed (3.5, 0.0001, 2).
fmt_units() {
  local v="$1" d="$2" scale=1 i frac
  for ((i = 0; i < d; i++)); do scale=$((scale * 10)); done
  frac="$(printf "%0${d}d" $((v % scale)))"
  frac="${frac%"${frac##*[!0]}"}"
  if [ -n "$frac" ]; then printf '%s.%s' $((v / scale)) "$frac"; else printf '%s' $((v / scale)); fi
}
# calldata_gas <0x-hex>: the gas limit for a plain self-send with this input. 21,000, plus the larger of the standard
# calldata cost (16 per non-zero byte, 4 per zero byte) and EIP-7623's floor (10 per calldata unit: 4 units a non-zero
# byte, 1 a zero byte; live on Sepolia since Pectra), plus GAS_HEADROOM. The all-ASCII text: 21,000 + 40/byte + 2,000.
calldata_gas() {
  local hex="${1#0x}" i zero=0 nonzero=0 standard floor
  for ((i = 0; i < ${#hex}; i += 2)); do
    if [ "${hex:i:2}" = "00" ]; then zero=$((zero + 1)); else nonzero=$((nonzero + 1)); fi
  done
  standard=$((4 * zero + 16 * nonzero))
  floor=$((10 * (zero + 4 * nonzero)))
  printf '%s' $((21000 + (standard > floor ? standard : floor) + GAS_HEADROOM))
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && /bin/pwd -P)"
REDTEAM_DIR="$REPO_DIR/scripts/redteam"
HOME_DIR="$HOME"

PACK=""
RPC_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pack) [ "$#" -ge 2 ] || die "--pack needs a folder"; PACK="$2"; shift 2 ;;
    --rpc) [ "$#" -ge 2 ] || die "--rpc needs a URL"; RPC_ARG="$2"; shift 2 ;;
    *) die "usage: scripts/fisco/anchor.sh --pack evidence/fisco/fm-<16hex> [--rpc <url>]" ;;
  esac
done
[ -n "$PACK" ] || die "usage: scripts/fisco/anchor.sh --pack evidence/fisco/fm-<16hex> [--rpc <url>]"

# 0. fd 3 is where the password and the answer are read: the controlling terminal, or (test-only override) stdin.
# Opening /dev/tty fails when the process has no controlling terminal (cron, a detached job, a CI runner).
if [ -n "${HOGEE_ANCHOR_KEYSTORE:-}" ]; then
  exec 3<&0
elif (: </dev/tty) 2>/dev/null; then
  exec 3</dev/tty
else
  die "no controlling terminal: the keystore password and the [y/N] answer are read from /dev/tty only. Nothing sent."
fi
[ -x "$CAST" ] && [ -x "$JQ" ] || die "missing tool: $CAST or $JQ"
NODE="$(command -v node)" || die "node is not on PATH"
[ -d "$PACK" ] && [ ! -L "$PACK" ] || die "--pack must be a real folder: $PACK"
PACK_DIR="$(cd -- "$PACK" && /bin/pwd -P)"

RPC="${RPC_ARG:-${SEPOLIA_RPC_URL_CAPTURE:-$DEFAULT_RPC}}"
case "$RPC" in
  https://*) ;;
  http://127.0.0.1:* | http://127.0.0.1/*) ;;
  *) die "the RPC URL must be https (plain http only on 127.0.0.1)" ;;
esac
authority="${RPC#*://}"
authority="${authority%%/*}"
authority="${authority%%\?*}"
case "$authority" in *@*) die "the RPC URL must not carry a user name or password" ;; esac
[ -n "$authority" ] || die "the RPC URL has no host"

KEYSTORE="${HOGEE_ANCHOR_KEYSTORE:-$DEFAULT_KEYSTORE}"
case "$KEYSTORE" in /*) ;; *) KEYSTORE="$PWD/$KEYSTORE" ;; esac
[ -f "$KEYSTORE" ] && [ ! -L "$KEYSTORE" ] || die "no keystore file (a link is refused) at $KEYSTORE"

W="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/hogee-anchor.XXXXXX")"
trap 'rm -rf -- "$W"' EXIT
trap 'exit 130' INT TERM
chmod 700 "$W"
mkdir -m 700 "$W/cwd"
case "$W/" in "$REPO_DIR/"*) die "the temp folder must be outside the repo" ;; esac
# Foundry looks for its project root (foundry.toml, .env) upwards from cwd: an empty file here ends that search.
: >"$W/cwd/foundry.toml"

# Unset every exported variable in this subshell, then export only what the tool needs (values stay off argv).
scrubbed() {
  local v
  for v in $(compgen -e); do unset "$v" 2>/dev/null || true; done
  export PATH="$FOUNDRY_BIN:/usr/bin:/bin" HOME="$HOME_DIR" LC_ALL=C
}
# stdin -> stdout, made safe to show: control bytes (but tab and newline) dropped, non-ASCII bytes as "?", the RPC
# URL and its host replaced, then any other scheme://... replaced (cast quotes the URL in a failed request's error).
scrub() {
  local line host_lc
  host_lc="$(lower "$authority")"
  LC_ALL=C tr -d '\000-\010\013-\037\177' | LC_ALL=C tr '\200-\377' '?' | while IFS= read -r line || [ -n "$line" ]; do
    line="${line//"$RPC"/<rpc>}"
    line="${line//"$authority"/<rpc>}"
    line="${line//"$host_lc"/<rpc>}"
    printf '%s\n' "$line"
  done | LC_ALL=C sed -E 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]*#<url>#g'
}
cast_() {
  local rc=0
  (cd -- "$W/cwd" && scrubbed && export ETH_RPC_URL="$RPC" && exec "$CAST" "$@") </dev/null 3<&- 2>"$W/cast.err" || rc=$?
  if [ -s "$W/cast.err" ]; then scrub <"$W/cast.err" >&2; fi
  rm -f -- "$W/cast.err"
  return "$rc"
}
anchor_ts() {
  (cd -- "$REDTEAM_DIR" && scrubbed && export PATH="$(dirname -- "$NODE"):$PATH" SEPOLIA_RPC_URL_CAPTURE="$RPC" &&
    exec "$NODE" --import tsx src/fisco/anchor.ts "$@") </dev/null 3<&-
}
# Throws away whatever was typed ahead on fd 3 (a stray "y" or Enter while signing), so only an answer given after
# the question is read. macOS /bin/bash 3.2 has no `read -t 0` poll: one character at a time, 1 s timeout each. Every
# read is `<&3` (fd 0 becomes the terminal for that read), not `read -u 3`: bash 3.2's -s turns echo off on fd 0 only.
drain_input() {
  local _c n=0
  while IFS= read -r -s -n 1 -t 1 _c <&3; do
    n=$((n + 1))
    [ "$n" -lt "$DRAIN_MAX_CHARS" ] || die "input keeps arriving before the question. Nothing sent."
  done
  return 0
}

# 2. The chain.
chain="$(cast_ chain-id)" || die "cast chain-id failed"
[[ "$chain" =~ ^[0-9]{1,20}$ ]] || die "cast chain-id did not print a number. Nothing sent."
[ "$chain" = "$SEPOLIA_CHAIN_ID" ] || die "the RPC is on chain $chain, not Sepolia ($SEPOLIA_CHAIN_ID). Nothing sent."

# 3. The text and calldata, from this pack (strictly loaded), cross-checked with cast.
out="$(anchor_ts text --pack "$PACK_DIR")" || die "fisco:anchor text failed (see above)"
TEXT="$(printf '%s\n' "$out" | sed -n 's/^text: //p')"
CALLDATA="$(printf '%s\n' "$out" | sed -n 's/^calldata: //p')"
[[ "$TEXT" =~ $TEXT_RE ]] || die "the anchor text is not in its strict form"
PACK_ID="${BASH_REMATCH[1]}"
[ "$PACK_ID" = "$(basename -- "$PACK_DIR")" ] || die "the pack folder is not named after its packId $PACK_ID"
[[ "$CALLDATA" =~ ^0x[0-9a-f]+$ ]] || die "the calldata is not lowercase hex"
[ "$(lower "$(cast_ from-utf8 "$TEXT")")" = "$CALLDATA" ] || die "cast from-utf8 does not give the same calldata"
SIDECAR="$(dirname -- "$PACK_DIR")/anchors/$PACK_ID.sepolia.json"
[ ! -e "$SIDECAR" ] && [ ! -L "$SIDECAR" ] || die "already anchored: $SIDECAR exists. Nothing sent."

info "Pack:      $PACK_ID"
info "Text:      $TEXT"
info "Calldata:  $CALLDATA"
info "Etherscan → View input as UTF-8 shows: $TEXT"

# 4. The password, hidden, into a private file (removed with the folder, and right after signing).
IFS= read -rsp "Keystore password for $(basename -- "$KEYSTORE") (hidden): " pw <&3 || die "no password given"
echo
printf '%s' "$pw" >"$W/pw"
chmod 600 "$W/pw"
unset pw

SIGNER="$(lower "$(cast_ wallet address --keystore "$KEYSTORE" --password-file "$W/pw")")" || die "cannot open the keystore"
[[ "$SIGNER" =~ ^0x[0-9a-f]{40}$ ]] || die "the keystore address is not an address"
if [ -n "${HOGEE_ANCHOR_KEYSTORE:-}" ]; then
  # The override reads the password and the answer from stdin (step 0): never with the hogee-deployer's key, whatever
  # path names it.
  [ "$SIGNER" != "$(lower "$ANCHOR_SIGNER")" ] || die "HOGEE_ANCHOR_KEYSTORE is for a throwaway test keystore, not the hogee-deployer's key. Nothing sent."
  info "TEST KEYSTORE (HOGEE_ANCHOR_KEYSTORE): signer $SIGNER; make verify-fisco accepts only $ANCHOR_SIGNER"
else
  [ "$SIGNER" = "$(lower "$ANCHOR_SIGNER")" ] || die "the hogee-deployer keystore is $SIGNER, not $ANCHOR_SIGNER. Nothing sent."
fi

# 5. Every fee field set here, none left to the RPC: nonce, gas limit and both fee caps.
NONCE="$(cast_ nonce "$SIGNER")" || die "cast nonce failed"
PENDING="$(cast_ nonce --block pending "$SIGNER")" || die "cast nonce (pending) failed"
[[ "$NONCE" =~ ^(0|[1-9][0-9]{0,14})$ ]] && [[ "$PENDING" =~ ^(0|[1-9][0-9]{0,14})$ ]] || die "cast nonce did not print a number. Nothing sent."
[ "$PENDING" = "$NONCE" ] || die "the signer has a pending tx (nonce $NONCE mined, $PENDING pending): wait for it (or re-run fisco:anchor capture with an earlier raw tx). Nothing sent."
GAS_LIMIT="$(calldata_gas "$CALLDATA")"
[ "$GAS_LIMIT" -le "$MAX_GAS_LIMIT" ] || die "the gas limit $GAS_LIMIT is over $MAX_GAS_LIMIT. Nothing sent."
ESTIMATE="$(cast_ estimate --from "$SIGNER" "$SIGNER" "$CALLDATA")" || die "cast estimate failed"
[[ "$ESTIMATE" =~ ^[1-9][0-9]{0,8}$ ]] || die "cast estimate did not print a gas amount. Nothing sent."
[ "$ESTIMATE" -le "$GAS_LIMIT" ] || die "the node estimates $ESTIMATE gas, over the $GAS_LIMIT computed (has calldata pricing changed?). Nothing sent."
BASE_FEE="$(cast_ base-fee)" || die "cast base-fee failed"
[[ "$BASE_FEE" =~ ^[0-9]{1,18}$ ]] || die "cast base-fee did not print a wei amount (or it is absurdly high). Nothing sent."
[ "$BASE_FEE" -le "$MAX_BASE_FEE" ] || die "the base fee is $(fmt_units "$BASE_FEE" 9) gwei, over $(fmt_units "$MAX_BASE_FEE" 9) gwei: try again later. Nothing sent."
MAX_FEE=$((2 * BASE_FEE + GWEI))
[ "$MAX_FEE" -le "$MAX_FEE_CAP" ] || MAX_FEE="$MAX_FEE_CAP"
MAX_COST_ETH="$(fmt_units $((GAS_LIMIT * MAX_FEE)) 18)"

# 6. Sign (no send). The input is the calldata as raw bytes (a 0x hex positional is raw calldata to cast mktx).
RAW="$(lower "$(cast_ mktx --keystore "$KEYSTORE" --password-file "$W/pw" --chain "$SEPOLIA_CHAIN_ID" --nonce "$NONCE" \
  --gas-limit "$GAS_LIMIT" --gas-price "$MAX_FEE" --priority-gas-price "$PRIORITY_FEE" "$SIGNER" "$CALLDATA")")" || die "cast mktx failed"
rm -f -- "$W/pw"
[[ "$RAW" =~ ^0x[0-9a-f]+$ ]] || die "cast mktx did not print a raw tx"
printf '%s\n' "$RAW" >"$W/raw.hex"
HASH="$(lower "$(cast_ keccak "$RAW")")"

# 7. Decode it twice (cast and our TypeScript) before anything leaves this machine. num: a 0x quantity of at most 16
# hex digits as a number (else -1, which fails every equality below).
cast_ decode-transaction "$RAW" >"$W/decoded.json" || die "cast decode-transaction failed"
"$JQ" -e --arg s "$SIGNER" --arg d "$CALLDATA" --arg c "$SEPOLIA_CHAIN_ID_HEX" --arg h "$HASH" \
  --argjson nonce "$NONCE" --argjson gas "$GAS_LIMIT" --argjson maxGas "$MAX_GAS_LIMIT" --argjson fee "$MAX_FEE" \
  --argjson maxFee "$MAX_FEE_CAP" --argjson tip "$PRIORITY_FEE" --argjson maxTip "$MAX_PRIORITY_FEE" '
  def num: if type == "string" and test("^0x[0-9a-fA-F]{1,16}$")
    then ltrimstr("0x") | ascii_downcase | explode | reduce .[] as $x (0; . * 16 + (if $x >= 97 then $x - 87 else $x - 48 end))
    else -1 end;
  (.type | ascii_downcase) == "0x2" and
  (.chainId | ascii_downcase) == $c and (.to | ascii_downcase) == $s and (.signer | ascii_downcase) == $s and
  .value == "0x0" and (.input | ascii_downcase) == $d and (.hash | ascii_downcase) == $h and
  (.nonce | num) == $nonce and
  (.gas | num) == $gas and (.gas | num) <= $maxGas and
  (.maxFeePerGas | num) == $fee and (.maxFeePerGas | num) <= $maxFee and
  (.maxPriorityFeePerGas | num) == $tip and (.maxPriorityFeePerGas | num) <= $maxTip' "$W/decoded.json" >/dev/null ||
  die "the signed tx is not the EIP-1559 value-0 self-send of the text on chain $SEPOLIA_CHAIN_ID at nonce $NONCE with the gas and fee caps set here. Nothing sent."
anchor_ts check-raw --pack "$PACK_DIR" --raw "$W/raw.hex" --signer "$SIGNER" --nonce "$NONCE" || die "fisco:anchor check-raw refused the signed tx. Nothing sent."

MAX_FEE_GWEI="$(fmt_units "$MAX_FEE" 9)"
TIP_GWEI="$(fmt_units "$PRIORITY_FEE" 9)"
info ""
info "Signed tx (type 0x2, nonce $NONCE, gas limit $GAS_LIMIT):"
info "  from = to = $SIGNER, value 0, chain $SEPOLIA_CHAIN_ID"
info "  max fee per gas $MAX_FEE_GWEI gwei (base fee now $(fmt_units "$BASE_FEE" 9) gwei), max priority fee per gas $TIP_GWEI gwei"
info "  maximum cost $MAX_COST_ETH ETH (gas limit x max fee per gas; the node estimates $ESTIMATE gas)"
info "  hash $HASH"
info "  raw  $RAW"
info "  (keep the raw tx: if capture fails after publishing, re-run fisco:anchor capture with it)"

# 8. The one public action, asked on the terminal after anything typed ahead is thrown away (the question is printed
# with printf, so it shows even under the test-only stdin override, where read -p would not print it).
drain_input
printf 'Publish to Sepolia now? nonce %s, gas limit %s, max fee %s gwei, max priority fee %s gwei, at most %s ETH [y/N] ' \
  "$NONCE" "$GAS_LIMIT" "$MAX_FEE_GWEI" "$TIP_GWEI" "$MAX_COST_ETH" >&2
IFS= read -r answer <&3 || answer=""
case "$answer" in
  y | Y) ;;
  *) info "Not sent."; exit 1 ;;
esac
published="$(cast_ publish --async "$RAW")" || die "cast publish failed (see above); check Etherscan for $HASH before trying again"
sent="$(lower "$(printf '%s' "$published" | tr -d '[:space:]')")"
[ "$sent" = "$HASH" ] || die "the node answered another tx hash, not $HASH; check Etherscan before anything else"
info "Published $HASH"

# 9. Wait for the receipt and write the sidecar.
anchor_ts capture --pack "$PACK_DIR" --raw "$W/raw.hex" --signer "$SIGNER" ||
  die "capture failed; the tx is public: re-run fisco:anchor capture with the raw tx printed above"
info "Next: make verify-fisco PACK=${PACK_DIR#"$REPO_DIR/"} (P1 adds --require-anchor)"
