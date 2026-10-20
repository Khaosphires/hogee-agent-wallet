#!/bin/bash
# chain-down.sh: stop the local FISCO mirror chain (TERM by pid file, then KILL leftovers) and optionally wipe its
# chain dir. Signals only processes that are fisco-bcos; wipes only a dir carrying its own .hogee-fisco marker.
set -euo pipefail
set +x
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

usage() {
  cat <<'EOF'
Usage: chain-down.sh [--dir D] [--wipe]
  --dir D  chain dir made by chain-up.sh (default ~/fisco-hogee)
  --wipe   after stopping, remove D entirely (rm -rf, everything in it: keys, nodes, deploy files, bin, and any
           download kept there); only if D/.hogee-fisco names D
Also removes /private/tmp/secp256k1.param (written by build_chain.sh) and fails if ~/.fisco exists.
EOF
}

D_RAW="$HOME/fisco-hogee"
WIPE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) D_RAW="${2:?--dir needs a path}"; shift 2 ;;
    --wipe) WIPE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument $1" ;;
  esac
done
refuse_root
D=$(resolve_chain_dir "$D_RAW")
require_marker "$D"

# Our nodes: the pid files in D/run, plus any fisco-bcos still running from D/bin (a lost pid file).
PIDS=""
for nd in $(node_dirs "$D"); do
  pf=$(node_pid_file "$D" "$nd")
  pid=""
  [ -L "$pf" ] || pid=$(cat -- "$pf" 2>/dev/null || true)
  if pid_is_node "$pid"; then PIDS="$PIDS $pid"; fi
done
for pid in $(pgrep -f -- "$D/bin/fisco-bcos -c config.ini" 2>/dev/null || true); do
  case " $PIDS " in *" $pid "*) ;; *) pid_is_node "$pid" && PIDS="$PIDS $pid" ;; esac
done

alive() {
  local pid left=""
  for pid in $PIDS; do pid_is_node "$pid" && left="$left $pid"; done
  printf '%s' "$left"
}

if [ -n "$PIDS" ]; then
  info "stopping fisco-bcos pids:$PIDS"
  for pid in $PIDS; do kill -TERM "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 30); do
    [ -n "$(alive)" ] || break
    sleep 1
  done
  LEFT=$(alive)
  if [ -n "$LEFT" ]; then
    info "still running after 30 s, sending KILL:$LEFT"
    for pid in $LEFT; do kill -KILL "$pid" 2>/dev/null || true; done
    sleep 1
  fi
  [ -z "$(alive)" ] || die "fisco-bcos still running:$(alive)"
else
  info "no fisco-bcos process found for $D"
fi
for nd in $(node_dirs "$D"); do rm -f -- "$(node_pid_file "$D" "$nd")"; done
info "PASS stopped"

PARAM=/private/tmp/secp256k1.param
if [ -e "$PARAM" ] || [ -L "$PARAM" ]; then
  if [ -O "$PARAM" ] && [ ! -L "$PARAM" ]; then rm -f -- "$PARAM" && info "removed $PARAM"; else
    info "NOTE $PARAM exists and is not ours; left alone"
  fi
fi

if [ "$WIPE" = 1 ]; then
  require_marker "$D"
  # chain-up.sh leaves D/bin read-only (mode 555); make it removable (a real folder only, never through a link).
  if [ -d "$D/bin" ] && [ ! -L "$D/bin" ]; then chmod 700 "$D/bin"; fi
  rm -rf -- "$D"
  [ ! -e "$D" ] || die "could not remove $D"
  info "PASS wiped $D"
fi

[ ! -e "$FISCO_HOME_P/.fisco" ] || die "~/.fisco exists (nothing here should create it); inspect it"
info "PASS ~/.fisco does not exist"
