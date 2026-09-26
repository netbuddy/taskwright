# API reference

> For integrators who drive Taskwright from their own programs. Taskwright is in alpha (0.1.0-alpha), so endpoints and event shapes may still change between releases. Users of the web interface do not need this page; see the [user guide](user-guide.md).

The task service speaks HTTP and Server-Sent Events (SSE). All paths start with `/api/v1`. Times are ISO 8601 strings with a time zone. Section numbers below are stable; code comments refer to them as `docs/api.md §N`.

**Revisions.** Every save — one `save_revision` call by the agent, or one direct operation by the user — produces one revision of the deliverable, numbered from 1 within the task. Items have no version numbers of their own: an item's content at a point in time is identified by its item id plus a revision number, and the revisions in which an item changed are naturally not consecutive (UC-001 may have changed in revisions 4 and 9). An item's *current revision* is the last revision that added, changed or restored it. Confirmations and reviews are marks on "item + revision"; they do not move when the item changes later.

**One writer at a time.** A message from the user starts one run of the agent. While it runs, the service refuses further messages and direct operations with `session_busy` (`data.reason` is `working`); nothing is queued. Clients should disable sending and writing while `executor.state` is `working`.

**Work ids.** A unit of work is identified by `w-` followed by the session entry id of the user message that started it. Live events (`work_started`, `step`, `assistant_reply`, `work_summary`, `work_ended`) and the conversation read after a reload use the same id, and the revision log (4.3) names the work each revision of the agent belongs to.

## 1 How a client should use it

1. **On page load: open the event stream first, then read a snapshot.** Buffer database events that arrive before the snapshot; when the snapshot arrives, drop buffered events whose sequence number is not greater than the snapshot's `seq`, and apply the rest in order. Conversation and progress events are shown as they arrive.
2. **After that, only listen.** The only other reads are on demand: an item's revisions, a material's text, earlier conversation, and document generation.
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
      "revision_before": null, "revision_after": 7,   // the item's revision before and after; before is null for an add, after is null for a delete
      "fields": { … all fields as of this revision … },
      "sources": [ { "kind": "文档原文", "locator": "inputs/requirements.md", "excerpt": "…",
                     "supports": [ { "field": "基本流程", "index": 0 } ] } ] },   // empty supports = the whole item
    { "op": "update", … }, { "op": "delete", "fields": null, "sources": [], … },
    { "op": "restore", … }             // undoing a delete
  ],
  "completion": { … see 4.2 … }        // null when it cannot be computed
}
```

Source kinds: `文档原文` (verbatim document excerpt), `用户的话` (the user's words), `执行者补充` (added by the agent, with its reason), `领域说明` (a domain note of the same task; locator is its item id such as `DN-002`, excerpt is the sentence relied on), `用户直接修改` (a direct edit in the interface; written by the system, locator is the operation id). Collection and field names come from the task definition.

| Event | When | `data` |
|---|---|---|
| `task_changed` | task created, completed or abandoned | `seq`, `at`, `task_id`, `task_name`, `status_before`, `status_after`, `actor`, `completion` |
| `review_recorded` | the reviewer reviewed one item; `verdict` is `合规` (compliant) or `不合规` (not compliant), computed from the rule levels of the findings | `seq`, `at`, `task_id`, `item_id`, `revision_no`, `verdict`, `reason`, `findings` (each `rule_id`, `level` `必选` or `可选`, `field`, `index` from 0 or null, `problem`, `suggestion`), `op_id` (set when the user started the review), `completion` |
| `review_unfinished` | a review of one item did not finish (timeout, failed call, two invalid outputs, or the item changed meanwhile); no verdict is recorded | `seq`, `at`, `task_id`, `item_id`, `revision_no`, `reason`, `op_id`, `completion` |
| `review_progress` | a review started from the interface (`request_review`) began (`done` 0) or finished one more item | `seq`, `at`, `task_id`, `op_id`, `done`, `total`, `current` (items being reviewed now), `item_id` (the item just finished, null at the start), `completion` |
| `review_batch` | a review (batch) ended, whether started by the user or by the agent's tool; `no` is its number ("review N") | `seq`, `at`, `task_id`, `no`, `batch_id`, `started_by` (`user` or `executor`), `scope` (`pending` or `named`), `items` (`item_id`, `revision_no`), `forced` (items reviewed again on request), `total`, `passed`, `failed`, `unfinished`, `problems`, `advice`, `completion` |
| `review_waived` | the user kept the current wording of items that failed review | `seq`, `at`, `task_id`, `items` (`item_id`, `revision_no`), `reason` (may be null), `source` (`detail` or `panel`), `op_id`, `completion` |
| `review_unwaived` | the user withdrew a kept wording | `seq`, `at`, `task_id`, `items`, `op_id`, `completion` |
| `review_rules_changed` | the user switched review rules of a collection | `seq`, `at`, `task_id`, `collection`, `off`, `promote`, `op_id`, and the collection's new `review_rules`, `all_rules`, `rule_switches`, `rules_hash`, `completion` |
| `review_finished` | that review is over | `seq`, `at`, `task_id`, `op_id`, `total`, `passed`, `failed`, `unfinished`, `results` (`item_id`, `revision_no`, `status`), `error` (null unless the review stopped unexpectedly), `completion` |
| `item_viewed` | the user opened an item's details, or clicked "I've read these" on a confirm card; the item is now read as of that revision | `seq`, `at`, `task_id`, `items` (`item_id`, `revision_no`), `op_id`, `completion` |
| `confirmation_recorded` | a confirmation mark other than "read": the user edited an item or marked an issue item as keep-pending (`basis` `ui_edit`, written together with the revision), or withdrew a confirmation (`basis` `ui_click`, `accepted` false) | `seq`, `at`, `task_id`, `items` (`item_id`, `revision_no`, `accepted`), `basis`, `op_id`, `completion` |
| `resync` (no id) | too many events to replay | `{"reason": "gap_too_large"}` |

### 3.2 Conversation and progress events (not numbered, not replayed)

All carry `session_id`.

| Event | When | `data` |
|---|---|---|
| `work_started` | the agent starts working | `work_id`, `at`, `triggered_by` (message id) |
| `step` | a tool call starts, and a corrected line when the turn ends | `work_id`, `step_key`, `text`, `in_progress`, `failed` |
| `user_message` | pi accepted a user message | `message_id` (the session entry id; may be empty in the rare case the entry cannot be found in time), `client_id`, `at`, `text`, `origin` (`typed`, `card_choice`, `ui_request`), `card`, `queued` |
| `assistant_reply` | the agent replied | `message_id`, `at`, `work_id`, `via_reply_tool`, `informs`, `act`, `text`, `degraded` (see 5.3) |
| `ui_action_noted` | a direct operation completed | `message_id`, `at`, `text`, `event_seq`, `op_id`, `revision_no`, `undoable`, `kind` (the operation kind), `review` (for the note at the end of a review: `total`, `passed`, `failed`, `unfinished`, `problems`, `advice`) |
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
                            "fields": [ { "name": "用例名称", "type": "文本", "required": true, "values": null }, … ],
                            "display": null,
                            "needs_review": true,
                            "review_rules": [ { "id": "UC-R1", "level": "必选", "text": "…", "counter_example": "…", "example": "…" }, … ],
                            "all_rules": [ { "id": "UC-R13", "level": "可选", "text": "…", "state": "off" }, … ],
                            "rule_switches": { "off": ["UC-R13"], "promote": [] }, "rules_hash": "…" }, … ] },
            "completion": { … 4.2 … },
            "items": [ { "item_id": "UC-001", "collection": "功能用例", "title": "…", "revision_no": 5, "revision_by": "user",
                         "revision_at": "…", "revisions": [2, 5], "fields": { … }, "sources": [ … ],
                         "reviews": [ { "revision_no": 5, "verdict": "不合规", "reason": "…", "at": "…", "batch_id": "ui-op-…", "rules_hash": "…", "forced": false,
                                        "findings": [ { "rule_id": "UC-R7", "level": "必选", "field": "基本流程", "index": 1,
                                                        "problem": "…", "suggestion": "…" } ] } ],
                         "confirmations": [ { "revision_no": 5, "accepted": true, "at": "…", "basis": "viewed" } ],
                         "waivers": [ { "revision_no": 5, "reason": "…", "source": "panel", "at": "…", "revoked": false } ],
                         "confirmation_stale": false, "viewed": true, "confirmation_basis": "viewed" } ],
            "review_batches": [ { "no": 1, "batch_id": "ui-op-…", "at": "…", "started_by": "user", "scope": "pending", "total": 16, "passed": 12, "failed": 4, … } ] },
  "materials": [ { "path": "inputs/requirements.md", "bytes": 1234, "modified_at": "…", "derived_from": null } ],   // derived_from: see Materials in 5.1
  "conversation": { "messages": [ … the latest 100, each with "type" … ], "has_earlier": false, "earliest_id": "…" },
  "current_work": null }
```

`display` is the collection's optional display settings from the task definition (null when not given): `side_tab`, `group_field`, `leading_groups` and `note`; they only change how the collection is shown. `needs_review` says whether the completion conditions require "every item passed review" for the collection; `review_rules` is the collection's rule list after rules switched off or made required in the task definition (null for a collection without review rules). A finding under a `必选` (required) rule is a problem and makes the item not compliant; a finding under a `可选` (optional) rule is advice. `all_rules` lists every rule of the rule file with its `state` in this task: `required`, `optional`, `off` or `promoted`. `rules_hash` is the rule fingerprint, a hash of the rule file and the task's switches; a review counts only while its `rules_hash` equals the collection's (reviews without one, from older versions, always count), so switching rules sends every item of the collection back to waiting for review. `waivers` are the user's kept wordings; one on the item's current revision that is not `revoked` makes the item count as passed.

Confirmation marks. A confirmation is a mark on "item + revision": it does not move when the item is changed later. Its `basis` is `viewed` (the user opened the item's details, or clicked "I've read these" on a confirm card), `ui_edit` (the user edited the item or marked it keep-pending; the edited content counts as confirmed) or `ui_click` (a withdrawal, `accepted` false; older databases also contain confirmations clicked in the interface); older databases may also contain `user_words`, confirmations recorded by the agent from the user's words in earlier versions. `viewed` on an item is true when the latest mark on its current revision is an acceptance of any basis, and `confirmation_basis` then names that basis; an item whose `viewed` is false is **unread**. The completion condition 「每个条目用户确认」 is met when no item of the collection is unread.

When a task is completed or abandoned, `task` is still returned, messages and direct operations return `task_closed`, and documents can still be generated. Clients must take collection names, field names and enumeration values from `definition`, never hard-code them.

### 4.2 Completion conditions

```
"completion": { "all_met": false, "unmet_count": 2, "brief": "要完成任务，还差 2 项：……", "conditions": [
  { "collection": "功能用例", "name": "每个条目评审通过", "met": false, "state": "unmet", "done": 0, "total": 7,
    "missing": ["UC-001", …], "note": "…" } ],
  "hints": [ { "kind": "unlinked_domain_notes", "collection": "领域说明", "items": ["DN-001"],
    "summary": "有 1 条领域说明还没有和任何条目关联：DN-001。" } ] }
```

`hints` lists facts that are shown next to the conditions but never block completion; it is an empty list when there are none. The only kind so far is `unlinked_domain_notes`: domain notes that no live item cites as a source or lists in an item-reference field, and whose own item-reference field points at no live item.

Each condition has one of three states. `met`: the collection has items and all of them meet the condition. `unmet`: some item does not, or "at least one item" finds none. `empty`: the collection has no items, so a condition over "every item" has nothing to check. `empty` still counts as met for completing the task (`met` stays `true`, so optional collections may stay empty), but it must not be shown as progress: report how many conditions are still `unmet` (`unmet_count`), not how many are met. `brief` is the one-sentence summary the agent itself sees; use it, or the same wording, everywhere.

### 4.3 Other reads and task management

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /api/v1/task-types` | task types for "new task" | `{ok, task_types: [{task_type, name}]}` |
| `GET /api/v1/tasks` | task list | `{ok, tasks: [{task_id, task_name, task_type, domain_tag, status, item_count, completion_met, completion_total, completion_unmet, last_active_at, session_count, supported}]}` (show `completion_unmet`, "still missing N"). A task created before revisions replaced item versions is listed with `supported: false`, `status` 旧格式 ("old format") and a `note`; it cannot be opened. A task in use by another running service is listed with `supported: false`, `status` 占用中 ("in use"), `occupied` (`port`, `pid`, `host`) and a `note`; every request for it returns `task_occupied`. |
| `POST /api/v1/tasks` `{task_type, task_name, domain_tag}` | create a task | `{ok, task_id}`; upload materials afterwards |
| `GET /api/v1/tasks/{task_id}` | task page (also for closed tasks) | the task, plus `materials` and `sessions` |
| `GET …/sessions` | sessions | `{ok, sessions: [{session_id, name, started_at, last_active_at, message_count, active}]}` |
| `POST …/sessions` | new session | `{ok, session_id}`; `session_busy` while the agent works in another session |
| `GET …/items/{item_id}/revisions` | the item's content in each revision that changed it | `{ok, item_id, revisions: [{revision_no, by, at, fields, sources, reviews, confirmations}]}` |
| `GET …/revisions` | the revision log | `{ok, latest_revision, revisions: [{revision_no, at, by, session_id, work_id, op_id, undo_of_revision, trigger, intent, operations}]}`, newest first. `work_id` is the agent's unit of work (empty for the user's revisions); `op_id` is the user's direct operation. `trigger` says what caused the revision: `{kind: "typed" \| "card_choice" \| "ui_request", text, message_id}` for the message that started the agent's work, `{kind: "user_action", action, text}` for a direct operation (`text` such as 你把 TBD-003 标为先不管, "you kept TBD-003 pending"), or `{kind: "none"}`. `intent` is the user act that caused an agent's revision, when the agent recorded its understanding of your message and the revision matches it: `{act_id, function, function_name, summary}` (`act_id` such as r13-2, `function` one of the nine user functions of the understanding schema, `function_name` its Chinese name such as 纠正); it is empty for your own revisions and for tasks without understanding records. Each operation has `op`, `item_id`, `collection`, `title`, `revision_before`, `revision_after` and `fields_changed` (field names that differ from the item's previous revision; empty for add, delete and restore). |
| `GET …/materials/content?path=…` | a material's text | `{ok, path, text}`; the path must stay inside the materials directory. For a `.docx` the text is the generated Markdown projection (see **Materials** in 5.1); for a task created with 0.2 that only has the old `<name>.docx.txt`, that file |
| `GET …/materials/raw?path=…` | a material file as uploaded | the file's bytes; `Content-Type` by extension: `text/markdown; charset=utf-8` for `.md`, `text/plain; charset=utf-8` for `.txt`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` for `.docx`, `application/octet-stream` otherwise. Same path rule as `content`; the web interface uses it to show Word files in their original layout |
| `GET …/conversation?session=…&before={message_id}&limit=100` | earlier conversation | same shape as `conversation` in 4.1 |
| `POST …/documents/preview` and `…/download` `{"revision_no": N, "items": [ids], "format": "markdown"}` | render the whole deliverable as of one revision (default: the latest), optionally only the listed items | preview: `{ok, text}`; download: the file. The document says which revision it was generated from, and marks each item with the revision its content comes from and whether it was confirmed and reviewed in that revision; a confirmation is written with its basis: read (已读), user edit (用户修改) or explicit confirmation (明确确认). A revision number beyond the latest, or an item not in the deliverable at that revision, returns `bad_request`. |

## 5 Conversation

The conversation lives in pi's session file; the database does not store it.

### 5.1 The user says something

`POST …/messages?session={session_id}` with `{"text": "…", "client_id": "…", "attachments": ["inputs/…"], "origin": "typed", "card": null}`. Response `{ok, client_id, queued}`; `queued` is always `false`. The matching `user_message` event carries the same `client_id`. While the agent works, the message is refused with `session_busy` and `data.reason` `working`; send it again when the work has ended. Text starting with `/` is prefixed with `用户说：` before it reaches pi, so it is never taken as a command.

**Materials.** `POST …/materials` (multipart, one file): `.md`, `.txt` or Word `.docx`, at most 5 MB, stored in the task's materials directory (a number is appended to duplicate names; names with path separators are rejected). Returns `{ok, path}`. For a `.docx` the service also writes a Markdown projection for the assistant beside it, `<name>.docx.md`, and extracts its pictures to `<name>.docx.media/`. Paragraphs are counted in the body of `word/document.xml`, table and nested-table paragraphs included, text-box paragraphs left out; headers, footers, footnotes, endnotes and comments are not counted. In the projection each paragraph is one line and its number is written `[pN]` in front of its text; headings start with `#` to `######` by outline level, and Word's automatic numbering is written in front of the number, not as part of the text; list items start with `- ` or with their number when it is of the form `1.`; tables are Markdown tables, one line per Word row with the first row as the header, the paragraphs of a cell separated by `<br>`, cells covered by a horizontal merge written `（同左）` and by a vertical merge `（同上）`, and the paragraphs of a nested table written into the outer cell after `（小表第 r 行第 c 列）`; a picture is a link `![图 k](<name>.docx.media/imageN.png)` in its paragraph; a Word chart or SmartArt diagram becomes a line saying it was not converted; text-box text is a quote (`> （文本框）…`) without a paragraph number; empty paragraphs are not written but are still counted. A comment at the top gives the paragraph count and how to cite. The projection is written by `agent/src/cli/docx_projection.mts`, which the service runs as a Node child process. The material list returns the `.docx` and the `.md`; each entry has `derived_from`, which is the path of the `.docx` for a projection beside it (`.md`, or the 0.2 `.txt`) and `null` for every other file, and the web interface leaves out entries that have it. The list holds files only, so the picture folder is not in it. A `.docx` that cannot be read is refused with `unsupported_type` and nothing is kept, and names ending in `.docx.md` or `.docx.txt` are refused with `bad_request`. When a message's `attachments` include a `.docx`, the text sent to the assistant says to read the `.md` beside it. Tasks created with 0.2 keep their `<name>.docx.txt` (one line per paragraph, starting with `[第 N 段]` or `[第 N 段 · 表 t 行 r 列 c]`); when a Word file has no `.md`, the assistant, the excerpt check and the web interface read that file instead.

### 5.2 The agent replies

Only accepted calls of the agent's `reply` tool become `assistant_reply` events with `via_reply_tool: true`. If a unit of work ends without an accepted reply, the server forwards the last assistant text with `via_reply_tool: false` and no `act`; if there is none, it sends `problem` with code `no_reply`.

### 5.3 Reply shape

```
"informs": [ { "text": "…", "items": [ { "item_id": "UC-004", "revision_no": 2 } ] } ],   // facts: what the agent just did or found; items (optional) names the items an inform mentions, each at its current revision
"act": null | {
  "kind": "ask" | "confirm" | "suggest" | "choose" | "propose",
  "text": "…",
  "items": [ { "item_id": "TBD-001", "revision_no": 3 } ],  // required for confirm, ask, suggest, propose; each item's current revision only
  "scope": "general",                                       // ask/suggest/propose only: not about any item (then no items)
  "options": [ { "key": "a", "text": "…" } ],               // choose only
  "value": "…", "basis": [ { "kind": "文档原文", "locator": "…", "excerpt": "…" } ],   // suggest only; each basis is checked verbatim like a save_revision source, and the user's words carry the locator the tool filled in
  "preview": [ { "effect": "remove" | "add" | "change", "text": "…" } ]           // propose only
},
"text": "…"                      // the reply as prose
```

`act` is present only when the agent waits for a specific response from the user; answering a question or reporting what it did carries `act: null`. Informs never become cards: the items they name are shown as item links (with an act, after that inform; without one, in a single line 提到的条目, "items mentioned", under the text, each item once). Sessions recorded before informs could name items stored them as plain strings; the server always sends them as objects. `degraded: true` marks a plain-text reply let through after repeated rejections; show it as plain text with a one-line note and no card. Replies are rendered as limited Markdown (paragraphs, lists, bold, inline code).

### 5.4 Card buttons

A button whose result must be written to the database goes through `/actions` (section 6); a button that needs the agent to do more goes through `/messages` with `origin: "card_choice"` and `card: {reply_message_id, kind, choice}`, using the fixed sentences in section 7.

| Card | Button | Goes to |
|---|---|---|
| confirm | I've read these | `/actions`, kind `mark_viewed`, targets from the card's items, `notify_executor: true` |
| confirm | Not right | `/messages` |
| choose | an option | `/messages` |
| suggest | Adopt / Another one | `/messages` |
| propose | Do it / Don't | `/messages` |
| ask (on an issue item) | Keep pending | `/actions`, kind `keep_pending`, `notify_executor: true` |
| ask (on items) | I don't know, fill in from common sense | `/messages` |

### 5.5 While the agent is working

New messages and direct operations are refused with `session_busy` (see 5.1); the one exception is `mark_viewed` without `notify_executor` (opening an item's details), which does not change the deliverable and is accepted while the agent works. `POST …/control?session=…` with `{"action": "stop"}` aborts the work; writes already saved stay. When the model service is unavailable, pi retries and the server sends `problem` with code `model_unavailable`.

### 5.6 Who starts the agent

Opening a session (a snapshot with `session`) starts pi for that task or switches it to that session. One task has one active session at a time: while the agent works in session A, messages and actions for session B return `session_busy`. During startup, requests return `executor_starting` (retry once shortly after); if pi failed or exited, `executor_unavailable`. Direct operations run inside pi, so they fail while pi is not running.

## 6 Direct operations

`POST …/actions?session={session_id}`:

```
{ "client_id": "…", "kind": "edit_fields" | "delete_item" | "mark_viewed" | "unconfirm" | "keep_pending" | "undo" | "request_review" | "waive_review" | "unwaive_review" | "set_review_rules",
  "targets": [ { "item_id": "UC-002", "base_revision": 3 } ],  // the item's revision when you opened it; for undo: "revision_no"
  "fields": { "基本流程": ["…", "…"] },                          // edit_fields only: complete new values
  "notify_executor": false,
  "force": false }                                               // request_review only
```

Response `{ok, client_id, op_id}`; the result arrives as events carrying the same `op_id`. Rules:

1. Every `base_revision` must be the item's current revision, otherwise the whole batch is rejected with `stale_revision` listing each stale item, its current revision and who changed it.
2. `undo` of revision N produces a new revision M that puts every item of N back to its previous state (an add is undone by a delete, a delete by a restore) and records `undo_of_revision`; if an item was changed again afterwards, the undo is rejected with `undo_conflict`.
3. `mark_viewed` marks each target as read as of `base_revision`. It is idempotent: an item whose latest mark on that revision is already an acceptance is skipped, and when every target is skipped nothing is written and no event is sent. Without `notify_executor` (the interface sends it when the user opens an item's details) nothing is appended to the session; with it (the "I've read these" card button) an interface-action note and the fixed sentence in section 7 are. Items that failed review can still be marked as read.
4. `unconfirm` withdraws the confirmation of each target's `base_revision`: it records a mark with `accepted` false, and the item becomes unread again.
5. `edit_fields` and `keep_pending` also record a confirmation mark (basis `ui_edit`) on the revision they produce, in the same transaction.
6. `request_review` asks the reviewer to review the targets at their `base_revision`; an empty `targets` list means every item waiting for review (in a collection that requires review, with no review at its current revision). The response comes as soon as the request passes its checks; the review runs in the background and reports through `review_progress`, `review_recorded` or `review_unfinished` for each item, and `review_finished`, all carrying the same `op_id`. "Waiting for review" means the item's current revision has no review under the collection's current `rules_hash`. A named target that already has one is rejected with 这条在当前修订上已经评过（第 N 次评审），内容和规则都没变 ("already reviewed at this revision (review N); neither content nor rules changed") unless the request carries `"force": true`; the review made then is recorded with `forced`. It is also rejected (`rejected`) while another review runs, when there is nothing to review, when a target is in a collection that is not reviewed, or when a target is not at its current revision. Each review ends with a `review_batch` event. When a review started here is over, an interface-action note is appended to the session with one sentence of counts (`kind` `request_review`, `review` with the counts); the findings are not in it, and the agent reads them with `get_task_status`. It does not start the agent. Clients should not show "saving" for it.
7. `waive_review` keeps the current wording of each target that failed review at its `base_revision` under the current rules; `fields` may carry `reason` and `source` (`detail` or `panel`). The item then counts as passed by the user's decision until it changes. `unwaive_review` withdraws it. Both are rejected when there is nothing to keep or withdraw. Only the user can do either; the agent has no such tool.
8. `set_review_rules` sets which optional rules of a collection are switched off or made required: `targets` is empty and `fields` is `{ "collection": …, "off": [rule ids], "promote": [rule ids] }`. It updates the task definition copy in the task directory and in the database, and is rejected for required rules, unknown rule ids, a collection without review rules, or no change. Existing reviews are kept; the rule fingerprint changes, so the collection's items wait for review again.
9. On a closed task every operation returns `task_closed`.
10. While the agent is working every operation returns `session_busy` with `data.reason` `working`, except `mark_viewed` without `notify_executor`.

## 7 Fixed sentences sent to the agent

| Situation | Sentence |
|---|---|
| user text starts with `/` | `用户说：{text}` |
| message with attachments | `{text}\n（我上传了材料：{path1}、{path2}）` |
| chose an option | `我选：{option text}` |
| "Not right" on a confirm card | `这个不对。` (or the user's own words) |
| adopt / another suggestion | `我采纳这个建议。` / `请换一个建议。` |
| accept / decline a proposal | `就这样做。` / `不要这样做。` |
| after "I've read these" on a confirm card (`notify_executor`) | `我已经看过了：{item（修订 N）, …}。请接着往下做。` |
| after "Keep pending" | `我先不管 {item id}，请接着往下做。` |
| "I don't know" on an ask card | `关于 {item ids}，我不知道，你按常识补上并标明是你补的。` |

Direct operations also append a message to the session marked as an interface action, for example `界面操作（不是用户打的字）：用户改了 UC-002 的「基本流程」，产生修订 5，UC-002 现在是修订 5。`

## 8 Errors

Shape: `{ "ok": false, "error": { "code": "…", "message": "…", "data": { … } } }`

| code | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | malformed request, or a path outside the materials directory |
| `not_found` | 404 | task, session, item, material or endpoint does not exist |
| `rejected` | 422 | validation failed; `data.reasons` lists every reason |
| `stale_revision` | 409 | revision check failed; `data.items` = `[{item_id, base_revision, current_revision, changed_by}]` |
| `old_format` | 409 | a task created before revisions replaced item versions; not supported by this version (the task list shows such tasks with `supported: false`) |
| `undo_conflict` | 409 | the item changed again after the revision being undone |
| `task_closed` | 409 | the task is completed or abandoned |
| `session_busy` | 409 | the agent is working: in another session (`data.active_session`), or in this one when a message or direct operation arrives (`data.reason` is `working`) |
| `task_occupied` | 409 | another running service serves this task (its `service.lock` names a live process); `data` has its `port`, `pid` and `host` |
| `forbidden` | 403 | an endpoint that accepts only requests from this machine got one from elsewhere (so far only `POST /api/v1/service/exit`, see section 9) |
| `executor_starting` | 503 | pi is starting |
| `executor_unavailable` | 503 | pi failed to start or exited (`data.detail`) |
| `busy_timeout` | 503 | waited too long for the database write lock |
| `too_large`, `unsupported_type` | 413, 415 | attachment too big or of the wrong type |

## 9 Other conventions

1. Texts that depend on the task definition (collection names, field names and types, enumeration values, completion condition names) always come from the API.
2. Several pages may watch the same task; a save from a second page may be rejected as stale.
3. Paths carry the version `v1`; fields are only ever added, never change meaning; clients ignore unknown events and fields.
4. Not in this version: multiple simultaneous users, authentication, streaming reply text.
5. **Service information and run mode.** These two endpoints need no task. The TypeScript task service (`backend/`) provides them; the Python task service does not.
   - `GET /api/v1/service` returns `{ "ok": true, "app": "taskwright", "version": …, "mode": "desktop" | "server", "pid": …, "port": …, "capabilities": { "exit": true | false } }`. `port` is the port the service actually listens on. It serves three uses: a packaged launcher checks whether the service on a port is its own; deployment and monitoring use it as a health check; a client shows or hides controls according to `capabilities`.
   - `POST /api/v1/service/exit` exists only when the service was started with `--mode desktop`; with `--mode server` it returns `not_found`. It accepts requests only from the loopback address (`127.0.0.1` or `::1`; `::ffff:127.0.0.1`, the IPv4 loopback address on an IPv6 socket, counts as loopback) and answers any other source with `forbidden` (403). It first answers `{ "ok": true }`, then shuts down as on SIGTERM: it stops accepting connections, closes each task's pi, removes the occupancy marks it wrote and exits. It is meant only for the 0.3 transitional package, in which the service opens the browser itself and there is no desktop shell; the final desktop version stops the service from its shell, and this endpoint is not promised to stay.
   - The run mode (`--mode desktop|server`, default `server`) decides the default bind address (`desktop`: `127.0.0.1`, `server`: `0.0.0.0`; `--host` overrides both) and whether the exit endpoint exists. Everything else behaves the same in both modes. The mode is written to the startup log and to each task's occupancy mark (`mode` in `service.lock`).

[中文版](api.zh-CN.md)
