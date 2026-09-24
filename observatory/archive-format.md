# Archive format

The backend archives every pi process it starts. The observatory reads only these archives (plus the task databases and pi's own session files), so **any backend implementation must write exactly this format**.

For each pi process start there are three files in `<archive dir>/pi-events/`, sharing one base name `<label>-<YYYYMMDD>-<HHMMSS>`:

| File | Content |
|---|---|
| `<base>.jsonl` | the raw event stream: every line pi wrote to standard output, unchanged |
| `<base>.backend.jsonl` | backend notes: facts that are not in pi's output |
| `<base>.times.jsonl` | receive times: when the backend read each line of the raw stream |

pi's session files are archived separately under `<archive dir>/pi-sessions/<label>/<timestamp>_<session id>.jsonl` (pi's own format; a restarted process that resumes a session keeps appending to the same file). The task service uses one archive directory per task: `<runs>/<task id>/`.

All files are UTF-8, one JSON object per line, appended and flushed line by line, never rewritten.

## 1 Raw event stream (`<base>.jsonl`)

Each line is exactly one line of pi's RPC standard output (pi `--mode rpc`), byte for byte. Typical `type` values: `response` (answer to a command, with `command`, `success`, `data`), `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end` (with `toolCallId`, `toolName`, `args` or `result`, `isError`), `turn_end`, `agent_end`, `agent_settled`, `auto_retry_start`, `auto_retry_end`, and `extension_ui_request`. The meaning of these events is defined by pi; the archive adds nothing.

Extensions report facts through `extension_ui_request` lines with `method: "setStatus"`. The status keys used by Taskwright:

| `statusKey` | `statusText` (JSON) |
|---|---|
| `taskwright-turn` | `{"turnIndex", "timestamp", "langfuseTraceId"}` at the start of each turn |
| `taskwright-active-tools` | the list of tool names actually active in this process |
| `taskwright-task-status` | the task-status message appended at session start: `{"kind", "text", "details", "entry_id", "session_id"}` |
| `taskwright-task-status-error` | why the task-status message could not be written (plain text) |
| `taskwright-user-result` | result of a `/tw-user` direct operation: `{"op_id", "ok", "event_seqs", "results", "revision_no"}` or `{"op_id", "ok": false, "error": {"code", "message", "data"}}` |
| `taskwright-ui-result` | result of a `/tw-ui` card click: `{"op_id", "ok", "idle"}` or an error |

## 2 Backend notes (`<base>.backend.jsonl`)

Every line has `"记录"` (the record kind) and `"时刻"` (local time, `YYYY-MM-DDTHH:MM:SS`), plus the fields of that kind. Field names are part of the format.

| `记录` | When | Fields |
|---|---|---|
| `启动` | right after the process starts | `命令行` (argument list), `扩展` (list of `{名字, 解析到的文件, 文件在不在}`), `工具白名单`, `模型`, `环境标签`, `任务目录`, `接回的会话文件` (empty for a new session), `是不是重启接回` (bool), `归档文件` (the raw stream's file name) |
| `知识仓库摘要` | at start | for each file under the task directory's `.pi/skills/` and `docs/`: path, byte count, and the first 16 hex digits of its SHA-256; plus `说明` |
| `上下文文件` | at start | the context files (such as `AGENTS.md`) the backend found by pi's discovery rules, and a note that pi does not report its own list |
| `已加载的 skill` | at start | `取得到吗` (bool); if true, `取法` and `skill` (list of name, description, file path from pi's `get_commands`); if false, `为什么取不到` |
| `提示` | each time the backend sends a prompt | `原文` (the text sent), `投递方式`, `下一条请求编号` |
| `界面请求应答` | each `extension_ui_request` | `方法`, `标题`, `要不要应答` (bool), `回了什么` (dialogs are answered "no" or "cancel"; others are only recorded), `请求编号` |
| `本轮事实` | each `taskwright-turn` report | `内容` (the parsed JSON, or null), `原文` |
| `实际工具清单` | each `taskwright-active-tools` report | `工具` (list, or null), `原文` |
| `扩展写入的消息` | a custom message written by an extension (for example the task-status message) | `类型`, `文字`, optionally `会话条目编号`, `会话编号` |
| `标准错误` | each line pi wrote to standard error | `文字` |
| `退出` | when the process ends | `退出码`, `标准错误` (everything pi wrote there) |

## 3 Receive times (`<base>.times.jsonl`)

Line N describes line N of the raw stream: `{"行号": N, "收到时刻": <seconds since the Unix epoch, float>}`. pi's events carry no timestamps; all durations the observatory shows are computed from this file.

## 4 Compatibility rules

- Never rename or remove a field or a record kind; add new ones instead. Readers ignore what they do not know.
- Write the raw stream unchanged, even lines that are not valid JSON.
- Keep line N of the times file aligned with line N of the raw stream.
- Never write secrets into any of the three files. Keys reach pi only through environment variables, which are not archived.
