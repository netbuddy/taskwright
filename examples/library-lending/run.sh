#!/usr/bin/env bash
# From an empty directory to a generated requirements document, through the HTTP API only.
# Start the backend first (see the repository README), then:
#   examples/library-lending/run.sh [http://127.0.0.1:8790]
# Needs curl and python3. The agent uses whatever model your startup profile names.
set -euo pipefail
API="${1:-http://127.0.0.1:8790}/api/v1"
HERE="$(cd "$(dirname "$0")" && pwd)"
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

echo "1. create a task"
TASK=$(curl -sf -X POST "$API/tasks" -H 'Content-Type: application/json' \
  -d '{"task_type": "srs-authoring", "task_name": "School library lending", "domain_tag": "library"}' | json 'd["task_id"]')
echo "   task: $TASK"

echo "2. upload the requirements material"
curl -sf -X POST "$API/tasks/$TASK/materials" -F "file=@$HERE/requirements.md" | json 'd["path"]'

echo "3. open a session (this starts the agent)"
SESSION=$(curl -sf -X POST "$API/tasks/$TASK/sessions" | json 'd["session_id"]')
curl -sf "$API/tasks/$TASK/snapshot?session=$SESSION" > /dev/null

echo "4. ask the agent to work"
curl -sf -X POST "$API/tasks/$TASK/messages?session=$SESSION" -H 'Content-Type: application/json' \
  -d '{"text": "请读 inputs 里的材料，整理成需求规格说明。", "client_id": "example-1"}' > /dev/null

echo "5. wait until the agent has replied and is idle (usually a few minutes; progress every 5 seconds)"
STATE=busy
for _ in $(seq 1 360); do
  LINE=$(curl -s "$API/tasks/$TASK/snapshot?session=$SESSION" | json \
    '" ".join([("done" if d["executor"]["state"] == "idle" and any(m.get("type") == "assistant_reply" for m in d["conversation"]["messages"]) else d["executor"]["state"]),
               str(len((d.get("task") or {}).get("items") or [])),
               ((d.get("current_work") or {}).get("steps") or [{}])[-1].get("text", "")])' 2>/dev/null || echo "unreachable 0")
  STATE=${LINE%% *}
  printf '\r   %-8s items: %-3s %-60.60s' "$STATE" "$(echo "$LINE" | cut -d' ' -f2)" "$(echo "$LINE" | cut -d' ' -f3-)"
  case "$STATE" in
    done) break ;;
    exited|failed_to_start) echo; echo "   the agent stopped ($STATE); see the server log and <runs>/$TASK/pi-events/" >&2; exit 1 ;;
  esac
  sleep 5
done
echo
[ "$STATE" = done ] || { echo "   gave up after 30 minutes; the agent is still working (state: $STATE)" >&2; exit 1; }
curl -sf "$API/tasks/$TASK/snapshot?session=$SESSION" | json \
  '"\n".join("   agent: " + m.get("text", "") for m in d["conversation"]["messages"] if m.get("type") == "assistant_reply")'

echo "6. generate the document from the current version of every item"
SELECTION=$(curl -sf "$API/tasks/$TASK/snapshot?session=$SESSION" | json \
  'json.dumps({"selection": [{"item_id": i["item_id"], "version_no": i["version_no"]} for i in d["task"]["items"]], "format": "markdown"})')
curl -sf -X POST "$API/tasks/$TASK/documents/preview" -H 'Content-Type: application/json' -d "$SELECTION" \
  | json 'd["text"]' > "srs-$TASK.md"
echo "   written to srs-$TASK.md ($(wc -l < "srs-$TASK.md") lines)"
