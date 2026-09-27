#!/usr/bin/env bash
# Talks to the executor of one task in pi's own terminal interface, for trying things out by hand.
#   scripts/tui.sh <task dir> [--label <name>] [--profile <name>] [--continue | --session <session file>] [--env-tag <tag>]
# The task must exist already (create it in the web interface or through POST /api/v1/tasks).
# The command line comes from the same startup profile and the same code the task service uses to start pi
# (backend/src/print_command.mts), without --mode rpc. Session files go to $TASKWRIGHT_RUNS_DIR/pi-sessions/<label>/
# (default ./runs); pi's interactive mode writes no raw event archive, so these sessions do not show in the observatory.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -lt 1 ] || [ "${1#-}" != "$1" ]; then
  sed -n '3,4p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
TASK="$1"
shift
SCRIPT="$(node "$ROOT/backend/src/print_command.mts" --task "$TASK" --shell "$@")"
eval "$SCRIPT"
printf '%s\n' "$TW_INFO"
echo "下面把终端交给 pi。在 pi 里打 /tw-board 看交付物看板，Ctrl+O 展开或折叠工具块，Ctrl+T 展开或折叠思考，Ctrl+D（输入框为空时）退出。"

MARK="$(mktemp)"
trap 'rm -f "$MARK"' EXIT
trap ':' INT                      # while pi has the terminal, Ctrl+C belongs to pi; this script keeps running
CODE=0
(cd "$TW_WORKSPACE" && "$@") || CODE=$?
trap - INT

if [ "$CODE" -eq 0 ]; then echo "pi 已退出，退出码 0。"; else echo "pi 已退出，退出码 $CODE。退出码不是 0，多半是扩展加载失败，看上面 pi 打的错误。"; fi
FOUND=0
while IFS= read -r file; do
  FOUND=1
  echo "  会话文件 $file"
  echo "  会话编号 $(node -e 'const l = require("fs").readFileSync(process.argv[1], "utf-8").split("\n")[0]; try { console.log(JSON.parse(l).id ?? "") } catch { console.log("") }' "$file")"
done < <(find "$TW_SESSION_DIR" -maxdepth 1 -name '*.jsonl' -newer "$MARK" 2>/dev/null | sort)
[ "$FOUND" -eq 1 ] || echo "  这次没有写出会话文件（pi 在第一条助手消息之前不写会话文件）。"
exit "$CODE"
