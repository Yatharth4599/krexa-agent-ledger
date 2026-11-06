#!/usr/bin/env bash
# Start the archive recorder detached, so it keeps snapshotting after the terminal closes.
#
# The archive is the one part of this build that cannot be caught up later: a 15 minute
# snapshot not taken at 15:45 is gone. SPEC.md 2A.4 wants coverage from now until 13 Nov.
#
# Stop it with scripts/archive-stop.sh. Check on it with `pnpm archive:stats`.
set -euo pipefail

cd "$(dirname "$0")/.."
PIDFILE="data/archive/recorder.pid"
LOGFILE="data/archive/recorder.log"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running as pid $(cat "$PIDFILE")"
  echo "stop it first: ./scripts/archive-stop.sh"
  exit 0
fi

mkdir -p data/archive
nohup pnpm -F @krexa-ual/archive loop >> "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

sleep 4
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "recorder running as pid $(cat "$PIDFILE")"
  echo "log      $LOGFILE"
  echo "stop     ./scripts/archive-stop.sh"
  echo "coverage pnpm archive:stats"
else
  echo "recorder failed to start; last lines of $LOGFILE:" >&2
  tail -20 "$LOGFILE" >&2
  rm -f "$PIDFILE"
  exit 1
fi
