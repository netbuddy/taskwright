#!/usr/bin/env bash
# Starts the backend task service and the web dev server together; Ctrl+C stops both.
#   TASKWRIGHT_TASKS_DIR   where task directories live   (default: ./tasks)
#   TASKWRIGHT_RUNS_DIR    where raw event logs go       (default: ./runs)
#   TASKWRIGHT_API_PORT    backend port                  (default: 8790; the next free one if taken)
#   TASKWRIGHT_WEB_PORT    web dev server port           (default: 5680)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TASKS="${TASKWRIGHT_TASKS_DIR:-$ROOT/tasks}"
RUNS="${TASKWRIGHT_RUNS_DIR:-$ROOT/runs}"
API_PORT="${TASKWRIGHT_API_PORT:-8790}"
mkdir -p "$TASKS" "$RUNS"

# The backend moves to the next free port when API_PORT is taken; read the port it actually uses from its first log
# line, so the web dev server never forwards to some other service that happens to hold API_PORT.
LOG="$(mktemp)"
node backend/src/main.mts --tasks "$TASKS" --runs "$RUNS" --port "$API_PORT" > >(tee "$LOG") 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true; rm -f "$LOG"' EXIT INT TERM
ACTUAL=""
for _ in $(seq 150); do
  ACTUAL="$(sed -n 's|.*http://[^:]*:\([0-9][0-9]*\)/api/v1/tasks .*|\1|p' "$LOG" | head -n 1)"
  [ -n "$ACTUAL" ] && break
  kill -0 "$API_PID" 2>/dev/null || { echo "dev.sh: the backend did not start" >&2; exit 1; }
  sleep 0.1
done
[ -n "$ACTUAL" ] || { echo "dev.sh: the backend did not report its port within 15 seconds" >&2; exit 1; }

TASKWRIGHT_API_TARGET="http://127.0.0.1:$ACTUAL" npm run dev -w web
