#!/usr/bin/env bash
# Starts the backend task service and the web dev server together; Ctrl+C stops both.
#   TASKWRIGHT_TASKS_DIR   where task directories live   (default: ./tasks)
#   TASKWRIGHT_RUNS_DIR    where raw event logs go       (default: ./runs)
#   TASKWRIGHT_API_PORT    backend port                  (default: 8790; the next free one if taken)
#   TASKWRIGHT_WEB_PORT    web dev server port           (default: 5680)
#
# scripts/dev.sh --demo starts the same two servers without a model service: the backend uses the fake model endpoint
# (backend/fake_model/) with the launch profile `fake`, its tasks and archives go to a temporary directory that is
# removed on exit, and examples/library-lending/run.sh creates a demo task with the example material, a session and a
# few items, so the pages have something to show. The fake model answers from examples/library-lending/fake-model.json.
# It needs pi on PATH, like the real backend, but no model service and no key.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEMO=""
case "${1:-}" in
  "") ;;
  --demo) DEMO=1 ;;
  *) echo "dev.sh: unknown option '$1' (the only option is --demo)" >&2; exit 2 ;;
esac

TASKS="${TASKWRIGHT_TASKS_DIR:-$ROOT/tasks}"
RUNS="${TASKWRIGHT_RUNS_DIR:-$ROOT/runs}"
API_PORT="${TASKWRIGHT_API_PORT:-8790}"
PIDS=()
CLEANUP=()
trap 'for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; for f in "${CLEANUP[@]}"; do rm -rf "$f"; done' EXIT INT TERM

# Prints the first match of the sed expression PATTERN in FILE once it appears; fails when process PID ends first
# or after 15 seconds.
wait_for() {
  local file="$1" pattern="$2" pid="$3" what="$4" found=""
  for _ in $(seq 150); do
    found="$(sed -n "$pattern" "$file" | head -n 1)"
    [ -n "$found" ] && { echo "$found"; return 0; }
    kill -0 "$pid" 2>/dev/null || { echo "dev.sh: $what did not start" >&2; return 1; }
    sleep 0.1
  done
  echo "dev.sh: $what did not start within 15 seconds" >&2
  return 1
}

PROFILE=()
if [ -n "$DEMO" ]; then
  DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/taskwright-demo-XXXXXX")"
  CLEANUP+=("$DEMO_DIR")
  TASKS="$DEMO_DIR/tasks"
  RUNS="$DEMO_DIR/runs"
  node backend/fake_model/main.mts --script examples/library-lending/fake-model.json --log "$DEMO_DIR/fake-model.jsonl" \
    --agent-dir "$DEMO_DIR/pi-agent" > "$DEMO_DIR/fake-model.out" 2>&1 &
  PIDS+=($!)
  wait_for "$DEMO_DIR/fake-model.out" '/pi-agent/p' "${PIDS[-1]}" "the fake model endpoint" > /dev/null
  export PI_CODING_AGENT_DIR="$DEMO_DIR/pi-agent"
  PROFILE=(--profile fake)
  echo "dev.sh: demo data in $DEMO_DIR (removed on exit)"
fi
mkdir -p "$TASKS" "$RUNS"

# The backend moves to the next free port when API_PORT is taken; read the port it actually uses from its first log
# line, so the web dev server never forwards to some other service that happens to hold API_PORT.
LOG="$(mktemp)"
CLEANUP+=("$LOG")
node backend/src/main.mts --tasks "$TASKS" --runs "$RUNS" --port "$API_PORT" "${PROFILE[@]}" > >(tee "$LOG") 2>&1 &
PIDS+=($!)
ACTUAL="$(wait_for "$LOG" 's|.*http://[^:]*:\([0-9][0-9]*\)/api/v1/tasks .*|\1|p' "${PIDS[-1]}" "the backend")"

if [ -n "$DEMO" ]; then
  # The example script creates the task, uploads the material, opens a session and lets the fake model save a few items.
  (cd "$DEMO_DIR" && bash "$ROOT/examples/library-lending/run.sh" "http://127.0.0.1:$ACTUAL")
fi

TASKWRIGHT_API_TARGET="http://127.0.0.1:$ACTUAL" npm run dev -w web
