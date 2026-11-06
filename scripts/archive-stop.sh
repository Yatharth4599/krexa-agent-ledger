#!/usr/bin/env bash
# Stop the detached archive recorder.
set -euo pipefail

cd "$(dirname "$0")/.."
PIDFILE="data/archive/recorder.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "no pidfile at $PIDFILE; nothing to stop"
  exit 0
fi

PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
  # The pnpm wrapper spawns tsx as a child, so take the process group down with it.
  kill -- "-$(ps -o pgid= -p "$PID" | tr -d ' ')" 2>/dev/null || kill "$PID"
  echo "stopped pid $PID"
else
  echo "pid $PID is not running"
fi
rm -f "$PIDFILE"
