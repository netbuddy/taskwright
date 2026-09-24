#!/usr/bin/env bash
# Starts the backend task service and the web dev server together; Ctrl+C stops both.
#   TASKWRIGHT_TASKS_DIR   where task directories live   (default: ./tasks)
#   TASKWRIGHT_RUNS_DIR    where raw event logs go       (default: ./runs)
#   TASKWRIGHT_API_PORT    backend port                  (default: 8790)
#   TASKWRIGHT_WEB_PORT    web dev server port           (default: 5680)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PYTHONPATH="$ROOT/server${PYTHONPATH:+:$PYTHONPATH}"
TASKS="${TASKWRIGHT_TASKS_DIR:-$ROOT/tasks}"
RUNS="${TASKWRIGHT_RUNS_DIR:-$ROOT/runs}"
API_PORT="${TASKWRIGHT_API_PORT:-8790}"
mkdir -p "$TASKS" "$RUNS"

python3 -m taskwright_server.service --tasks "$TASKS" --runs "$RUNS" --port "$API_PORT" &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT INT TERM

TASKWRIGHT_API_TARGET="http://127.0.0.1:$API_PORT" npm run dev -w web
