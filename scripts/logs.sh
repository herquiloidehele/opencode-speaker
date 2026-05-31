#!/usr/bin/env bash
# Tail opencode-speaker plugin logs from opencode's central log directory.
# Automatically re-attaches to the newest log file when opencode restarts.
#
# Usage:
#   bash scripts/logs.sh                 # default filter: 'opencode-speaker'
#   bash scripts/logs.sh 'speaker|tts'   # custom regex (passed to grep -E)
#
# Override the log directory via OPENCODE_LOG_DIR if opencode stores logs
# somewhere other than the default macOS/Linux path.

set -u

LOG_DIR=${OPENCODE_LOG_DIR:-$HOME/.local/share/opencode/log}
FILTER=${1:-opencode-speaker}

if [ ! -d "$LOG_DIR" ]; then
  echo "log dir not found: $LOG_DIR" >&2
  exit 1
fi

cleanup() { kill $(jobs -p) 2>/dev/null; }
trap cleanup EXIT INT TERM

current=""
while :; do
  newest=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)
  if [ -n "$newest" ] && [ "$newest" != "$current" ]; then
    if [ -n "$current" ]; then
      kill $(jobs -p) 2>/dev/null
      wait 2>/dev/null
      echo
      echo "---- new opencode session detected: $(basename "$newest") ----"
    else
      echo "---- tailing $(basename "$newest") (filter: /$FILTER/) ----"
    fi
    current=$newest
    # -n 200: show recent context on first attach; -F: follow + retry on rotate.
    tail -n 200 -F "$current" 2>/dev/null \
      | grep --line-buffered --color=always -E "$FILTER" &
  fi
  sleep 1
done
