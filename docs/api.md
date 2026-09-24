# API reference

> For integrators who drive Taskwright from their own programs. Taskwright is in alpha (0.1.0-alpha), so endpoints and event shapes may still change between releases. Users of the web interface do not need this page; see the [user guide](user-guide.md).

The task service speaks HTTP and Server-Sent Events (SSE). All paths start with `/api/v1`. Times are ISO 8601 strings with a time zone. Section numbers below are stable; code comments refer to them as `docs/api.md §N`.

## 1 How a client should use it

1. **On page load: open the event stream first, then read a snapshot.** Buffer database events that arrive before the snapshot; when the snapshot arrives, drop buffered events whose sequence number is not greater than the snapshot's `seq`, and apply the rest in order. Conversation and progress events are shown as they arrive.
2. **After that, only listen.** The only other reads are on demand: an item's versions, a material's text, earlier conversation, and document generation.
3. **Screen changes come only from events.** A request's response says only "accepted" (with an operation id) or "rejected" (with the reason). A database event may arrive before the response; match it by `op_id`. A rejected request produces no event.
4. **Recovery.** On reconnect the browser sends the last received database event id (`Last-Event-ID`); the server replays what came after it. If more than 500 events are missing, the server sends `resync` and the client starts again from step 1. Apply each sequence number once.

## 3 Event stream

`GET /api/v1/tasks/{task_id}/events?session={session_id}` — an SSE stream. Each message is one `event:` line and one `data:` line (JSON). **Only database events have an `id:` line**, equal to their sequence number. The server sends a keep-alive comment every 15 seconds; clients should reconnect after 45 seconds of silence and ignore unknown event types and fields.

### 3.1 Database events (numbered, replayable)

```
event: deliverable_changed
id: 12
data: {
  "seq": 12, "at": "2026-01-01T09:30:05+08:00",
  "task_id": "TASK-20260101-AB12", "revision_no": 3,
  "actor": "executor",                 // executor or user
  "work_id": "…",                      // for the executor: the unit of work that produced it
  "op_id": null,                       // for the user: the direct operation's id, as returned by /actions
  "undo_of_revision": null,            // set when this revision undoes another
  "operations": [
    { "op": "add", "collection": "功能用例", "item_id": "UC-005", "title": "…",
      "version_before": null, "version_after": 1,
      "fields": { … all fields of that version … },
      "sources": [ { "kind": "文档原文", "locator": "inputs/requirements.md", "excerpt": "…",
                     "supports": [ { "field": "基本流程", "index": 0 } ] } ] },   // empty supports = the whole item
    { "op": "update", … }, { "op": "delete", "fields": null, "sources": [], … },
    { "op": "restore", … }             // undoing a delete
  ],
  "completion": { … see 4.2 … }        // null when it cannot be computed
}
```

Source kinds: `文档原文` (verbatim document excerpt), `用户的话` (the user's words), `执行者补充` (added by the agent, with its reason), `用户直接修改` (a direct edit in the interface; written by the system, locator is the operation id). Collection and field names come from the task definition.

| Event | When | `data` |
|---|---|---|
| `task_changed` | task created, completed or abandoned | `seq`, `at`, `task_id`, `task_name`, `status_before`, `status_after`, `actor`, `completion` |
| `review_recorded` | a reviewer's verdict (once the reviewer ships) | `seq`, `at`, `task_id`, `item_id`, `version_no`, `verdict`, `findings`, `completion` |
| `confirmation_recorded` | the user confirmed or withdrew a confirmation | `seq`, `at`, `task_id`, `items` (`item_id`, `version_no`, `accepted`), `basis` (`ui_click` or `user_words`), `op_id`, `completion` |
| `resync` (no id) | too many events to replay | `{"reason": "gap_too_large"}` |

### 3.2 Conversation and progress events (not numbered, not replayed)

All carry `session_id`.

| Event | When | `data` |
|---|---|---|
| `work_started` | the agent starts working | `work_id`, `at`, `triggered_by` (message id) |
| `step` | a tool call starts, and a corrected line when the turn ends | `work_id`, `step_key`, `text`, `in_progress`, `failed` |
| `user_message` | pi accepted a user message | `message_id` (empty while queued, sent again once merged), `client_id`, `at`, `text`, `origin` (`typed`, `card_choice`, `ui_request`), `card`, `queued` |
| `assistant_reply` | the agent replied | `message_id`, `at`, `work_id`, `via_reply_tool`, `informs`, `act`, `text`, `degraded` (see 5.3) |
| `ui_action_noted` | a direct operation completed | `message_id`, `at`, `text`, `event_seq`, `op_id`, `revision_no`, `undoable` |
| `material_added` | a material was uploaded | `at`, `path`, `bytes`, `modified_at` |
| `work_summary` | after a unit of work | `work_id`, `at`, `seconds`, `step_count`, `stages` (each with `text`) |
| `work_ended` | the agent settled | `work_id`, `at`, `seconds`, `step_count`, `outcome` (`replied`, `no_reply`, `stopped_by_user`, `failed`) |
| `problem` | something the user should know (see 5.5) | `code`, `text`, `retry` |
| `executor_state` | the agent's availability changed | `state` (`not_started`, `starting`, `idle`, `working`, `exited`, `failed_to_start`), `text`, `active_session` |
| `system_note` | the task-status message at session start, or the fixed fallback sentence | `message_id`, `at`, `text`, `kind` (`task_status` or `reply_fallback`) |

## 4 Reading

### 4.1 Snapshot

`GET /api/v1/tasks/{task_id}/snapshot?session={session_id}` — opening a session this way also starts or resumes the agent. `seq` and all tables are read in one read transaction.

```
{ "ok": true, "seq": 12, "generated_at": "…",
  "executor": { "state": "idle", "text": "…", "active_session": "…" },
  "session": { "session_id": "…", "name": "…", "started_at": "…", "last_active_at": "…" },
  "task": { "task_id": "…", "task_name": "…", "task_type": "srs-authoring", "domain_tag": null, "status": "进行中",
            "started_at": "…", "ended_at": null,
            "definition": { "collections": [ { "name": "功能用例", "prefix": "UC",
                            "fields": [ { "name": "用例名称", "type": "文本", "required": true, "values": null }, … ] }, … ] },
            "completion": { … 4.2 … },
            "items": [ { "item_id": "UC-001", "collection": "功能用例", "title": "…", "version_no": 2, "version_by": "user",
                         "version_at": "…", "version_count": 2, "fields": { … }, "sources": [ … ],
                         "reviews": [], "confirmations": [ { "version_no": 2, "accepted": true, "at": "…", "basis": "ui_click" } ],
                         "confirmation_stale": false } ] },
  "materials": [ { "path": "inputs/requirements.md", "bytes": 1234, "modified_at": "…" } ],
  "conversation": { "messages": [ … the latest 100, each with "type" … ], "has_earlier": false, "earliest_id": "…" },
  "current_work": null }
```

When a task is completed or abandoned, `task` is still returned, messages and direct operations return `task_closed`, and documents can still be generated. Clients must take collection names, field names and enumeration values from `definition`, never hard-code them.

### 4.2 Completion conditions

```
"completion": { "all_met": false, "unmet_count": 2, "brief": "要完成任务，还差 2 项：……", "conditions": [
  { "collection": "功能用例", "name": "每个条目评审通过", "met": false, "state": "unmet", "done": 0, "total": 7,
    "missing": ["UC-001", …], "note": "…" } ] }
```

Each condition has one of three states. `met`: the collection has items and all of them meet the condition. `unmet`: some item does not, or "at least one item" finds none. `empty`: the collection has no items, so a condition over "every item" has nothing to check. `empty` still counts as met for completing the task (`met` stays `true`, so optional collections may stay empty), but it must not be shown as progress: report how many conditions are still `unmet` (`unmet_count`), not how many are met. `brief` is the one-sentence summary the agent itself sees; use it, or the same wording, everywhere.

### 4.3 Other reads and task management

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /api/v1/task-types` | task types for "new task" | `{ok, task_types: [{task_type, name}]}` |
| `GET /api/v1/tasks` | task list | `{ok, tasks: [{task_id, task_name, task_type, domain_tag, status, item_count, completion_met, completion_total, completion_unmet, last_active_at, session_count}]}` (show `completion_unmet`, "still missing N") |
| `POST /api/v1/tasks` `{task_type, task_name, domain_tag}` | create a task | `{ok, task_id}`; upload materials afterwards |
| `GET /api/v1/tasks/{task_id}` | task page (also for closed tasks) | the task, plus `materials` and `sessions` |
| `GET …/sessions` | sessions | `{ok, sessions: [{session_id, name, started_at, last_active_at, message_count, active}]}` |
| `POST …/sessions` | new session | `{ok, session_id}`; `session_busy` while the agent works in another session |
| `GET …/items/{item_id}/versions` | all versions of an item | `{ok, versions: [{version_no, revision_no, by, at, fields, sources, reviews, confirmations}]}` |
| `GET …/materials/content?path=…` | a material's text | `{ok, path, text}`; the path must stay inside the materials directory |
| `GET …/conversation?session=…&before={message_id}&limit=100` | earlier conversation | same shape as `conversation` in 4.1 |
| `POST …/documents/preview` and `…/download` `{"selection": [{item_id, version_no}], "format": "markdown"}` | render a document | preview: `{ok, text}`; download: the file. Versions without review or confirmation are rendered and marked as such. |

## 5 Conversation

The conversation lives in pi's session file; the database does not store it.

### 5.1 The user says something

`POST …/messages?session={session_id}` with `{"text": "…", "client_id": "…", "attachments": ["inputs/…"], "origin": "typed", "card": null}`. Response `{ok, client_id, queued}`. The matching `user_message` event carries the same `client_id`. While the agent works, the message is queued and delivered when the current work ends; queued messages are delivered together. Text starting with `/` is prefixed with `用户说：` before it reaches pi, so it is never taken as a command.

**Materials.** `POST …/materials` (multipart, one file): `.md` or `.txt`, at most 5 MB, stored in the task's materials directory (a number is appended to duplicate names; names with path separators are rejected). Returns `{ok, path}`.

### 5.2 The agent replies

Only accepted calls of the agent's `reply` tool become `assistant_reply` events with `via_reply_tool: true`. If a unit of work ends without an accepted reply, the server forwards the last assistant text with `via_reply_tool: false` and no `act`; if there is none, it sends `problem` with code `no_reply`.

### 5.3 Reply shape

```
"informs": ["…", "…"],          // facts: what the agent just did or found
"act": null | {
  "kind": "ask" | "confirm" | "suggest" | "choose" | "propose",
  "text": "…",
  "items": [ { "item_id": "TBD-001", "version_no": 1 } ],   // required for confirm, ask, suggest, propose; current versions only
  "scope": "general",                                       // ask/suggest/propose only: not about any item (then no items)
  "options": [ { "key": "a", "text": "…" } ],               // choose only
  "value": "…", "basis": [ { "kind": "文档原文", "locator": "…", "excerpt": "…" } ],   // suggest only
  "preview": [ { "effect": "remove" | "add" | "change", "text": "…" } ]           // propose only
},
"text": "…"                      // the reply as prose
```

`degraded: true` marks a plain-text reply let through after repeated rejections; show it as plain text with a one-line note and no card. Replies are rendered as limited Markdown (paragraphs, lists, bold, inline code).

### 5.4 Card buttons

A button whose result must be written to the database goes through `/actions` (section 6); a button that needs the agent to do more goes through `/messages` with `origin: "card_choice"` and `card: {reply_message_id, kind, choice}`, using the fixed sentences in section 7.

| Card | Button | Goes to |
|---|---|---|
| confirm | Confirm | `/actions`, kind `confirm`, targets from the card's items, `notify_executor: true` |
| confirm | Not right | `/messages` |
| choose | an option | `/messages` |
| suggest | Adopt / Another one | `/messages` |
| propose | Do it / Don't | `/messages` |
| ask (on an open issue) | Keep pending | `/actions`, kind `keep_pending`, `notify_executor: true` |
| ask (on items) | I don't know, fill in from common sense | `/messages` |

### 5.5 While the agent is working

New messages are queued (see 5.1). `POST …/control?session=…` with `{"action": "stop"}` clears the queue (the cleared messages are returned so the user can resend them) and aborts; writes already saved stay. When the model service is unavailable, pi retries and the server sends `problem` with code `model_unavailable`.

### 5.6 Who starts the agent

Opening a session (a snapshot with `session`) starts pi for that task or switches it to that session. One task has one active session at a time: while the agent works in session A, messages and actions for session B return `session_busy`. During startup, requests return `executor_starting` (retry once shortly after); if pi failed or exited, `executor_unavailable`. Direct operations run inside pi, so they fail while pi is not running.

## 6 Direct operations

`POST …/actions?session={session_id}`:

```
{ "client_id": "…", "kind": "edit_fields" | "delete_item" | "confirm" | "unconfirm" | "keep_pending" | "undo",
  "targets": [ { "item_id": "UC-002", "base_version": 1 } ],   // for undo: "revision_no"
  "fields": { "基本流程": ["…", "…"] },                          // edit_fields only: complete new values
  "notify_executor": false }
```

Response `{ok, client_id, op_id}`; the result arrives as events carrying the same `op_id`. Rules:

1. Every `base_version` must be the item's current version, otherwise the whole batch is rejected with `stale_version` listing each stale item, its current version and who changed it.
2. `undo` restores every item of that revision to its previous state (an add is undone by a delete, a delete by a restore) and records `undo_of_revision`; if an item was changed again afterwards, the undo is rejected with `undo_conflict`.
3. Items that failed review can still be confirmed.
4. On a closed task every operation returns `task_closed`.

## 7 Fixed sentences sent to the agent

| Situation | Sentence |
|---|---|
| user text starts with `/` | `用户说：{text}` |
| message with attachments | `{text}\n（我上传了材料：{path1}、{path2}）` |
| chose an option | `我选：{option text}` |
| "Not right" on a confirm card | `这个不对。` (or the user's own words) |
| adopt / another suggestion | `我采纳这个建议。` / `请换一个建议。` |
| accept / decline a proposal | `就这样做。` / `不要这样做。` |
| after a confirmation (`notify_executor`) | `我已经在界面上确认了：{item version, …}。请接着往下做。` |
| after "Keep pending" | `我先不管 {item id}，请接着往下做。` |
| "I don't know" on an ask card | `关于 {item ids}，我不知道，你按常识补上并标明是你补的。` |

Direct operations also append a message to the session marked as an interface action, for example `界面操作（不是用户打的字）：用户把 UC-002 的「基本流程」改成了第 2 版。`

## 8 Errors

Shape: `{ "ok": false, "error": { "code": "…", "message": "…", "data": { … } } }`

| code | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | malformed request, or a path outside the materials directory |
| `not_found` | 404 | task, session, item, material or endpoint does not exist |
| `rejected` | 422 | validation failed; `data.reasons` lists every reason |
| `stale_version` | 409 | version check failed; `data.items` = `[{item_id, version_no, by}]` |
| `undo_conflict` | 409 | the item changed again after the revision being undone |
| `task_closed` | 409 | the task is completed or abandoned |
| `session_busy` | 409 | the agent is working in another session (`data.active_session`) |
| `executor_starting` | 503 | pi is starting |
| `executor_unavailable` | 503 | pi failed to start or exited (`data.detail`) |
| `busy_timeout` | 503 | waited too long for the database write lock |
| `too_large`, `unsupported_type` | 413, 415 | attachment too big or of the wrong type |

## 9 Other conventions

1. Texts that depend on the task definition (collection names, field names and types, enumeration values, completion condition names) always come from the API.
2. Several pages may watch the same task; a save from a second page may be rejected as stale.
3. Paths carry the version `v1`; fields are only ever added, never change meaning; clients ignore unknown events and fields.
4. Not in this version: multiple simultaneous users, authentication, streaming reply text.

[中文版](api.zh-CN.md)
