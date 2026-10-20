#!/bin/bash
# profiles.sh: node.sb and build.sb on a throwaway chain dir, with system tools (true, touch, cat, ln, nc, perl,
# security) standing in for the sandboxed code (never fisco-bcos or build_chain.sh). Proves both profiles parse and
# confine writes to their folders. chain-check.sh --selftest covers network, reads and listens; its link probe
# (selftest_links), its listen probe (selftest_listen) for node4's Web3 port 8546 (allowed) and 8547 (denied), and its
# run-12 probes (selftest_procargs: other processes' arguments; selftest_trustd: the trustd lookup; selftest_hardlink)
# also run here, the run-12 ones also under copies of the profiles without their rule, which must fail them. nc
# listens on 127.0.0.1:8546 for 2 s under node.sb; the 8547 bind is refused by the sandbox (a port in use is skipped).
# Usage: bash profiles.sh
set -uo pipefail
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TOP=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/hogee-fisco-sb.XXXXXX")
trap 'rm -rf -- "$TOP"' EXIT
D="$(cd "$TOP" && /bin/pwd -P)/D"
mkdir -p "$D"/{nodes/.tmp,keys,deploy,logs,run,facts,bin,cwd,tools,build,home,tmp}
P=0; F=0
ok() { P=$((P + 1)); echo "ok   $*"; }
bad() { F=$((F + 1)); echo "FAIL $*"; }
node_sb() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$D/nodes/.tmp" TMPDIR="$D/nodes/.tmp" /usr/bin/sandbox-exec \
    -D NODES_DIR="$D/nodes" -D BIN="$D/bin/fisco-bcos" -D SELFTEST=1 -f "${NODE_SB:-$R/node.sb}" "$@"
}
build_sb() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$D/home" TMPDIR="$D/tmp" /usr/bin/sandbox-exec -D CHAIN_DIR="$D" \
    -D BIN="$D/bin/fisco-bcos" -D OPENSSL_CELLAR=/opt/homebrew/Cellar/openssl@3 -f "${BUILD_SB:-$R/build.sb}" "$@"
}
allowed() { local label="$1"; shift; if "$@" 2>/dev/null; then ok "$label allowed"; else bad "$label denied"; fi; }
denied() {
  local label="$1" out
  shift
  if out=$("$@" 2>&1); then bad "$label allowed"; return; fi
  case "$out" in *"Operation not permitted"*) ok "$label denied by the sandbox" ;; *) bad "$label failed otherwise: $out" ;; esac
}
if /usr/bin/sandbox-exec -D NODES_DIR="$D/nodes" -D BIN=/usr/bin/true -f "$R/node.sb" /usr/bin/true; then
  ok "node.sb parses and runs its BIN (/usr/bin/true) with the kern.proc denies"
else bad "node.sb: /usr/bin/true as BIN failed"; fi
allowed "node.sb touch D/nodes/x" node_sb /usr/bin/touch "$D/nodes/x"
allowed "node.sb touch D/nodes/.tmp/x" node_sb /usr/bin/touch "$D/nodes/.tmp/x"
for t in x keys/x deploy/x logs/x run/x facts/x bin/x cwd/x tools/x build/x home/x tmp/x ../outside; do
  denied "node.sb touch D/$t" node_sb /usr/bin/touch "$D/$t"
done
# Links in NODES_DIR to a file outside D: a symlink the sandbox makes is only a name (reads through it are denied); a
# hard link to an outside file cannot be made. (A hard link made outside the sandbox would be readable: the sandbox
# checks paths. Nothing in scripts/fisco makes one.)
echo "outside dummy" >"$TOP/outside-dummy"; echo "outside dummy" >"$TOP/dummy"
allowed "node.sb ln -s in D/nodes to a file outside D (a name only)" node_sb /bin/ln -s "$TOP/outside-dummy" "$D/nodes/link-sym"
denied "node.sb read a file outside D through that symlink" node_sb /bin/cat "$D/nodes/link-sym"
denied "node.sb hard link in D/nodes to a file outside D" node_sb /bin/ln "$TOP/outside-dummy" "$D/nodes/link-hard"
[ ! -e "$D/nodes/link-hard" ] && ok "node.sb: no hard link was created" || bad "node.sb: a hard link to an outside file exists"
# chain-check.sh's own selftest_links, run on this throwaway D (its expect_denied, pass, fail, note, printable).
CC_OUT=$(
  . "$R/lib.sh"
  eval "$(sed -n '/^expect_denied() {/,/^}/p; /^selftest_links() {/,/^}/p' "$R/chain-check.sh")"
  pass() { echo "PASS $*"; }; fail() { echo "FAIL $*"; }; note() { echo "NOTE $*"; }
  SB_NODES="$D/nodes/cc"; mkdir -p "$SB_NODES"; OUTSIDE="$TOP"; sb_node() { node_sb "$@"; }
  selftest_links
)
printf '%s\n' "$CC_OUT" | sed 's/^/  chain-check selftest_links: /'
case "$CC_OUT" in *FAIL*) bad "chain-check selftest_links reported a FAIL" ;; *) ok "chain-check selftest_links: no FAIL" ;; esac
printf '%s\n' "$CC_OUT" | grep -q '^PASS node.sb hard link in its NODES_DIR to a file outside D: creation denied by the sandbox$' &&
  printf '%s\n' "$CC_OUT" | grep -q '^PASS node.sb read a file outside D through a symlink in its NODES_DIR: denied by the sandbox$' &&
  ok "chain-check selftest_links: symlink read and hard link creation denied" || bad "chain-check selftest_links lines"
# chain-check.sh's own selftest_listen: node4's Web3 port 8546 may be bound under node.sb, 8547 may not. A port free
# before must be free again afterwards (no probe left listening).
port_free() { ! /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
FREE_BEFORE=""; for p in 8546 8547; do port_free "$p" && FREE_BEFORE="$FREE_BEFORE $p"; done
LS_OUT=$(
  . "$R/lib.sh"
  eval "$(sed -n '/^selftest_listen() {/,/^}/p' "$R/chain-check.sh")"
  pass() { echo "PASS $*"; }; fail() { echo "FAIL $*"; }; note() { echo "NOTE $*"; }
  OUTSIDE="$TOP"; sb_node() { node_sb "$@"; }
  selftest_listen "node.sb listen 127.0.0.1:8546 (node4 Web3)" 8546 allowed
  selftest_listen "node.sb listen 127.0.0.1:8547 (not a chain port)" 8547 denied
)
printf '%s\n' "$LS_OUT" | sed 's/^/  chain-check selftest_listen: /'
case "$LS_OUT" in *FAIL*) bad "chain-check selftest_listen reported a FAIL" ;; *) ok "chain-check selftest_listen: no FAIL" ;; esac
for want in "PASS node.sb listen 127.0.0.1:8546 (node4 Web3): allowed" \
  "PASS node.sb listen 127.0.0.1:8547 (not a chain port): denied by the sandbox"; do
  if printf '%s\n' "$LS_OUT" | grep -qxF -- "$want"; then ok "${want#PASS }"
  elif printf '%s\n' "$LS_OUT" | grep -q '^NOTE'; then echo "note ${want#PASS }: not testable (port in use)"
  else bad "missing: $want"; fi
done
sleep 0.5
for p in $FREE_BEFORE; do port_free "$p" && ok "port $p free again after the probe" || bad "port $p still has a listener after the probe"; done
allowed "build.sb runs /usr/bin/true" build_sb /usr/bin/true
grep -q '^(deny sysctl-read (sysctl-name "kern.proc") (sysctl-name-prefix "kern.procargs") (sysctl-name-prefix "kern.proc."))$' \
  "$R/build.sb" && ok "build.sb denies the kern.proc/kern.procargs sysctls (as node.sb)" || bad "build.sb: no kern.proc deny"
[ "$(grep -n 'deny sysctl-read' "$R/build.sb" | cut -d: -f1)" -gt "$(grep -n '^(allow sysctl-read)' "$R/build.sb" | cut -d: -f1)" ] &&
  ok "build.sb: the deny comes after (allow sysctl-read)" || bad "build.sb deny order"
for t in build/y nodes/y home/y tmp/y; do allowed "build.sb touch D/$t" build_sb /usr/bin/touch "$D/$t"; done
for t in y keys/y deploy/y logs/y run/y facts/y bin/y cwd/y tools/y nodes2 buildx ../outside; do
  denied "build.sb touch D/$t" build_sb /usr/bin/touch "$D/$t"
done

# --- run-12: Mach services, other processes, hard links. chain-check.sh's own probes (selftest_procargs,
# selftest_trustd, selftest_hardlink) run here on the throwaway D; each probe that can pass is also run under a copy of
# the profile without its rule and must then fail, so no probe passes vacuously.
line_no() { grep -nxF -- "$2" "$1" | head -1 | cut -d: -f1; }
XPC='(deny mach-lookup (xpc-service-name-prefix ""))'
for sb in node.sb build.sb; do
  imp=$(line_no "$R/$sb" '(import "bsd.sb")'); xpc=$(line_no "$R/$sb" "$XPC")
  [ -n "$imp" ] && [ -n "$xpc" ] && [ "$xpc" -gt "$imp" ] && ok "$sb: every XPC service lookup denied, after the bsd.sb import" ||
    bad "$sb: no xpc-service deny after the import"
  pi=$(line_no "$R/$sb" '(deny process-info*)'); self=$(line_no "$R/$sb" '(allow process-info* (target self))')
  sys=$(grep -n '^(deny sysctl-read' "$R/$sb" | cut -d: -f1)
  [ -n "$pi" ] && [ -n "$self" ] && [ "$self" = $((pi + 1)) ] && [ "$pi" -gt "$imp" ] && [ "$pi" -gt "$sys" ] &&
    ok "$sb: process-info denied except on itself, after the import and the sysctl deny" || bad "$sb: process-info rules"
done
mach_list() { sed -n '/^(deny mach-lookup (global-name/,/))$/p' "$1" | tr -s ' \n' ' '; }
ML=$(mach_list "$R/node.sb")
case "$ML" in *'"com.apple.trustd" "com.apple.trustd.agent"'*'"com.apple.nsurlsessiond"'*) ok "node.sb: the Mach deny list names trustd and nsurlsessiond" ;;
  *) bad "node.sb Mach deny list: $ML" ;; esac
[ "$ML" = "$(mach_list "$R/build.sb")" ] && ok "build.sb: the same Mach deny list as node.sb" || bad "build.sb Mach deny list differs from node.sb's"
PB=$(
  . "$R/lib.sh"
  eval "$(sed -n '/^selftest_procargs() {/,/^}/p; /^selftest_trustd() {/,/^}/p; /^apple_root_pem() {/,/^}/p;
    /^selftest_hardlink() {/,/^}/p' "$R/chain-check.sh")"
  pass() { echo "PASS $*"; }; fail() { echo "FAIL $*"; }; note() { echo "NOTE $*"; }
  # Copies without each rule (the mutants): no process-info deny; trustd off the Mach deny list.
  sed '/^(deny process-info\*)$/d' "$R/node.sb" >"$TOP/node-pi.sb"; sed '/^(deny process-info\*)$/d' "$R/build.sb" >"$TOP/build-pi.sb"
  sed 's/"com\.apple\.trustd\(\.agent\)\{0,1\}"/"com.apple.hogee-unused"/g' "$R/node.sb" >"$TOP/node-td.sb"
  sed 's/"com\.apple\.trustd\(\.agent\)\{0,1\}"/"com.apple.hogee-unused"/g' "$R/build.sb" >"$TOP/build-td.sb"
  selftest_procargs node.sb node_sb
  selftest_procargs build.sb build_sb
  NODE_SB="$TOP/node-pi.sb" selftest_procargs "mutant node.sb" node_sb
  BUILD_SB="$TOP/build-pi.sb" selftest_procargs "mutant build.sb" build_sb
  if apple_root_pem "$D/nodes/apple-root.pem"; then
    selftest_trustd node.sb node_sb "$D/nodes/apple-root.pem"
    selftest_trustd build.sb build_sb "$D/nodes/apple-root.pem"
    NODE_SB="$TOP/node-td.sb" selftest_trustd "mutant node.sb" node_sb "$D/nodes/apple-root.pem"
    BUILD_SB="$TOP/build-td.sb" selftest_trustd "mutant build.sb" build_sb "$D/nodes/apple-root.pem"
  else note "trustd lookup: not testable (no Apple root certificate)"; fi
  printf 'logs dummy\n' >"$D/logs/dummy"; printf 'keys dummy\n' >"$D/keys/dummy"
  selftest_hardlink "build.sb hard link in D/build to a file outside D" build_sb "$TOP/outside-dummy" "$D/build/link-hard"
  selftest_hardlink "build.sb hard link in D/tmp to a file in D/logs" build_sb "$D/logs/dummy" "$D/tmp/link-hard"
  selftest_hardlink "build.sb hard link in D/nodes to a file in D/keys" build_sb "$D/keys/dummy" "$D/nodes/link-hard"
  selftest_hardlink "node.sb hard link in D/nodes to a file in D/keys" node_sb "$D/keys/dummy" "$D/nodes/link-hard"
)
printf '%s\n' "$PB" | sed 's/^/  chain-check probes: /'
# Real profiles: PASS (or NOTE where the Mac cannot show the canary or the certificate check at all); mutants: FAIL.
for sb in node.sb build.sb; do
  for what in "another process's arguments and table entry: denied by the sandbox" "trustd lookup: denied"; do
    if printf '%s\n' "$PB" | grep -q "^PASS $sb: $what"; then ok "$sb: $what"
    elif printf '%s\n' "$PB" | grep -q "^NOTE $sb: "; then echo "note $sb: $what: not testable here"
    else bad "$sb: $what"; fi
  done
  for what in "another process's arguments are readable" "trustd lookup: allowed"; do
    if printf '%s\n' "$PB" | grep -q "^FAIL mutant $sb: $what"; then ok "mutant $sb (rule removed): the probe fails ($what)"
    elif printf '%s\n' "$PB" | grep -q "^NOTE mutant $sb: "; then echo "note mutant $sb: not testable here"
    else bad "mutant $sb: the probe did not notice the missing rule ($what)"; fi
  done
done
for want in "build.sb hard link in D/build to a file outside D" "build.sb hard link in D/tmp to a file in D/logs" \
  "build.sb hard link in D/nodes to a file in D/keys" "node.sb hard link in D/nodes to a file in D/keys"; do
  printf '%s\n' "$PB" | grep -qxF "PASS $want: creation denied by the sandbox" && ok "$want: denied" || bad "$want"
done
for f in build/link-hard tmp/link-hard nodes/link-hard; do [ ! -e "$D/$f" ] || bad "D/$f exists"; done
[ "$(stat -f %l "$D/keys/dummy")" = 1 ] && [ "$(stat -f %l "$D/logs/dummy")" = 1 ] && ok "no hard link to D/keys or D/logs left" ||
  bad "a hard link to D/keys or D/logs exists"
echo "profiles: $P passed, $F failed"
[ "$F" = 0 ]
