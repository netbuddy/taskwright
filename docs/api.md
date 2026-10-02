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

`GET /api/v1/tasks/{task_id}/events?session={session_id}` — an SSE stream. Each message is one `event:` line and one `data:` line (JSON). **Only database events have an `id:` line**, equal to their sequence number. The server sends a keep-alive comment every 15 seconds; clients should reconnect after 45 seconds of silence and ignore unknown event types and fields. Without `session` the stream carries the events of the whole task; the task page uses such a stream and listens only to `executor_state`, to reload the task when the assistant finishes a turn. Opening an event stream does not start the executor.

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

Source kinds: `文档原文` (verbatim document excerpt), `用户的话` (the user's words), `执行者补充` (added by the agent, with its reason), `领域说明` (a domain note of the same task; locator is its item id such as `DN-002`, excerpt is the sentence relied on). Earlier versions also wrote `用户直接修改` (a direct edit in the interface, locator is the operation id); it is no longer written, and old records stay in the database but are left out of the task data the interface returns. Collection and field names come from the task definition.

| Event | When | `data` |
|---|---|---|
| `task_changed` | task created, completed or abandoned | `seq`, `at`, `task_id`, `task_name`, `status_before`, `status_after`, `actor`, `completion` |
| `review_recorded` | the reviewer reviewed one item; `verdict` is `合规` (compliant) or `不合规` (not compliant), computed from the rule levels of the findings | `seq`, `at`, `task_id`, `item_id`, `revision_no`, `verdict`, `reason`, `findings` (each `rule_id`, `level` `必选` or `可选`, `field`, `index` from 0 or null, `problem`, `suggestion`), `op_id` (set when the user started the review), `completion` |
| `review_unfinished` | a review of one item did not finish (timeout, failed call, two invalid outputs, or the item changed meanwhile); no verdict is recorded | `seq`, `at`, `task_id`, `item_id`, `revision_no`, `reason`, `op_id`, `completion` |
| `review_progress` | a review started from the interface (`request_review`) began (`done` 0) or finished one more item | `seq`, `at`, `task_id`, `op_id`, `done`, `total`, `current` (items being reviewed now), `item_id` (the item just finished, null at the start), `completion` |
| `review_batch` | a review (batch) ended, whether started by the user or by the agent's tool; `no` is its number ("review N") | `seq`, `at`, `task_id`, `no`, `batch_id`, `started_by` (`user` or `executor`), `scope` (`pending` or `named`), `items` (`item_id`, `revision_no`), `forced` (items reviewed again through the former "review again"; empty for reviews made now), `total`, `passed`, `failed`, `unfinished`, `problems`, `advice`, `completion` |
| `review_waived` | the user kept the current wording of items that failed review | `seq`, `at`, `task_id`, `items` (`item_id`, `revision_no`), `reason` (may be null), `source` (`detail` or `panel`), `op_id`, `completion` |
| `review_unwaived` | the user withdrew a kept wording | `seq`, `at`, `task_id`, `items`, `op_id`, `completion` |
| `review_rules_changed` | the user switched review rules of a collection | `seq`, `at`, `task_id`, `collection`, `off`, `promote`, `op_id`, and the collection's new `review_rules`, `all_rules`, `rule_switches`, `rules_hash`, `completion` |
| `review_finished` | that review is over | `seq`, `at`, `task_id`, `op_id`, `total`, `passed`, `failed`, `unfinished`, `results` (`item_id`, `revision_no`, `status`), `error` (null unless the review stopped unexpectedly), `completion` |
| `item_viewed` | the user opened an item's details, or clicked "I've read these" on a confirm card; the item is now read as of that revision | `seq`, `at`, `task_id`, `items` (`item_id`, `revision_no`), `op_id`, `completion` |
| `confirmation_recorded` | a confirmation mark other than "read": the user edited an item or marked an issue item as keep-pending (`basis` `ui_edit`, written together with the revision), or withdrew a confirmation (`basis` `ui_click`, `accepted` false) | `seq`, `at`, `task_id`, `items` (`item_id`, `revision_no`, `accepted`), `basis`, `op_id`, `completion` |
| `resync` (no id) | too many events to replay | `{"reason": "gap_too_large"}` |

Database event numbers can skip: a few kinds of records in the task database are not pushed. They are the assistant's understanding of what the user said (`USER_INTENT_RECORDED`, and the three cases where no understanding was written, `USER_INTENT_INVALID`, `USER_INTENT_MISSING` and `STRUCTURED_OUTPUT_UNMATCHED`) and the acts the assistant recorded with a reply (`EXECUTOR_ACTS_RECORDED`). The backend turns the first kinds into the 理解为 ("understood as") line, sent with `step` and `work_summary`; the content of a reply reaches the page through `assistant_reply`. The page reads a new snapshot when it sees a skipped number.

### 3.2 Conversation and progress events (not numbered, not replayed)

All carry `session_id` except `service_exiting`, which goes to every open stream of every task.

| Event | When | `data` |
|---|---|---|
| `work_started` | the agent starts working | `work_id`, `at`, `triggered_by` (message id) |
| `step` | a tool call starts, and a corrected line when the turn ends | `work_id`, `step_key`, `text`, `in_progress`, `failed` |
| `user_message` | pi accepted a user message | `message_id` (the session entry id; may be empty in the rare case the entry cannot be found in time), `client_id`, `at`, `text`, `origin` (`typed`, `card_choice`, `ui_request`), `card`, `queued` |
| `assistant_reply` | the agent replied | `message_id`, `at`, `work_id`, `via_reply_tool`, `informs`, `act`, `text`, `degraded` (see 5.3) |
| `ui_action_noted` | a direct operation completed | `message_id`, `at`, `text`, `event_seq`, `op_id`, `revision_no`, `undoable`, `kind` (the operation kind), `review` (for the note at the end of a review: `total`, `passed`, `failed`, `unfinished`, `problems`, `advice`) |
| `material_added` | a material was uploaded | `at`, `path`, `bytes`, `modified_at` |
| `material_removed` | a material was deleted (section 5.1) | `at`, `path`; the files generated from a Word material were deleted with it and get no event of their own |
| `work_summary` | after a unit of work | `work_id`, `at`, `seconds`, `step_count`, `stages` (each with `text`), `outcome` (how the unit of work ended, with the values of `work_ended`; the `work_summary` messages of the conversation read after a reload carry the same value) |
| `work_ended` | the agent settled | `work_id`, `at`, `seconds`, `step_count` (the same as in `work_summary`, computed from the session record, so after a stop it counts the tool calls of a message that never started; the count kept during the turn is used only when the session record does not give this unit of work), `outcome` (`replied`, `no_reply`, `stopped_by_user`, `failed`; decided by the last assistant message of the unit of work, so a unit of work whose model call failed and was then retried successfully is `replied` or `no_reply`, not `failed`) |
| `problem` | something the user should know (see 5.5) | `code`, `text`, `retry` |
| `executor_state` | the agent's availability changed | `state` (`not_started`, `starting`, `idle`, `working`, `exited`, `failed_to_start`), `text`, `active_session`; after a failed resume (`session_resume_failed`) `state` is `not_started` and `text` says the assistant did not pick up the session |
| `system_note` | the task-status message at session start, or the fixed fallback sentence | `message_id`, `at`, `text`, `kind` (`task_status` or `reply_fallback`); the `text` of a task-status message is the page's wording: it opens with 这条会话开始时（time）的任务状况： ("the task at the start of this session (time):") or 接着这条会话继续时（time），上次之后交付物的变化： ("continuing this session (time), changes to the deliverable since last time:"), and leaves out the line written only for the assistant (its acts still waiting for an answer); the assistant still reads the original, and the conversation read back after a reload has the page's wording too |
| `service_exiting` | the service is about to stop: exit requested from the page, SIGINT or SIGTERM, SIGHUP (SIGBREAK on Windows); sent before each task's pi is closed and the streams end | `mode` (`desktop` or `server`), `at`. A page that receives it should show that the service has stopped and stop reconnecting. |

## 4 Reading

### 4.1 Snapshot

`GET /api/v1/tasks/{task_id}/snapshot?session={session_id}` — opening a session this way also starts or resumes the agent. `seq` and all tables are read in one read transaction. If the agent cannot be started, the snapshot is still answered: the conversation comes from the session file and the items from the task database, `executor.state` is `failed_to_start` and `executor.text` gives the reason, worded as in the `executor_state` event. Every snapshot with `session` tries to start the agent again, so once the cause is fixed, reloading the page is enough.

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
                         "reviews": [ { "revision_no": 5, "verdict": "不合规", "reason": "…", "at": "…", "batch_id": "ui-op-…", "rules_hash": "…", "forced": false, "seq": 41,
                                        "findings": [ { "rule_id": "UC-R7", "level": "必选", "field": "基本流程", "index": 1,
                                                        "problem": "…", "suggestion": "…" } ] } ],
                         "confirmations": [ { "revision_no": 5, "accepted": true, "at": "…", "basis": "viewed" } ],
                         "waivers": [ { "revision_no": 5, "reason": "…", "source": "panel", "at": "…", "revoked": false, "seq": 44 } ],
                         "confirmation_stale": false, "viewed": true, "confirmation_basis": "viewed" } ],
            "review_batches": [ { "no": 1, "batch_id": "ui-op-…", "at": "…", "started_by": "user", "scope": "pending", "total": 16, "passed": 12, "failed": 4, … } ] },
  "materials": [ { "path": "inputs/requirements.md", "bytes": 1234, "modified_at": "…", "derived_from": null } ],   // derived_from: see Materials in 5.1
  "conversation": { "messages": [ … the latest 100, each with "type" … ], "has_earlier": false, "earliest_id": "…" },
  "current_work": null,
  "review_in_progress": null }         // or { "op_id": "ui-op-…", "done": 1, "total": 4, "current": ["UC-002"] }
```

`review_in_progress` is the review started from the interface that is running now, shaped like `op_id`, `done`, `total` and `current` of the `review_progress` event and taken from the last review progress in the task database. It is null when that review is over, when the agent is not running, or when the progress was written before the agent's current start (the agent exited during the review). The page uses it to show 评审中 ("reviewing") right after a reload; when it is null and the page still has an unfinished review, the page clears it.

`display` is the collection's optional display settings from the task definition (null when not given): `side_tab`, `group_field`, `leading_groups` and `note`; they only change how the collection is shown. `needs_review` says whether the completion conditions require "every item passed review" for the collection; `review_rules` is the collection's rule list after rules switched off or made required in the task definition (null for a collection without review rules). A finding under a `必选` (required) rule is a problem and makes the item not compliant; a finding under a `可选` (optional) rule is advice. `all_rules` lists every rule of the rule file with its `state` in this task: `required`, `optional`, `off` or `promoted`. `rules_hash` is the rule fingerprint, a hash of the rule file and the task's switches; a review counts only while its `rules_hash` equals the collection's (reviews without one, from older versions, always count), so switching rules sends every item of the collection back to waiting for review. `waivers` are the user's kept wordings. Reviews and waivers carry `seq`, the number of the event they were recorded at. An item's review verdict at its current revision comes from its last review there (by `seq`) that counts under the current `rules_hash`: compliant is passed; not compliant is failed, unless a waiver on that revision that is not `revoked` has a larger `seq`, which makes the item count as passed by the user's decision. With no such review the item waits for review. `forced` is true on reviews recorded by earlier versions through the former "review again"; they are read like any other review.

Confirmation marks. A confirmation is a mark on "item + revision": it does not move when the item is changed later. Its `basis` is `viewed` (the user opened the item's details, or clicked "I've read these" on a confirm card), `ui_edit` (the user edited the item or marked it keep-pending; the edited content counts as confirmed) or `ui_click` (a withdrawal made by earlier versions, `accepted` false; the API no longer accepts that operation, and withdrawals already in a database are still read; older databases also contain confirmations clicked in the interface); older databases may also contain `user_words`, confirmations recorded by the agent from the user's words in earlier versions. `viewed` on an item is true when the item has an accepting mark of any basis on any revision, and `confirmation_basis` then names the basis: that of the latest mark on the current revision when that mark is an acceptance, otherwise that of the latest accepting mark; an item whose `viewed` is false is **unread**. Reading counts per item and only goes one way: an item does not become unread again when it is changed later, nor when the database holds a withdrawal made by an earlier version. `confirmation_stale` is true when the item has an accepting mark but the latest mark on its current revision is not an acceptance (it was changed after it was read, or its confirmation was withdrawn). The completion condition 「每个条目用户确认」 is met when no item of the collection is unread.

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
| `GET /api/v1/tasks/{task_id}` | task page (also for closed tasks) | the task, plus `materials` (each entry has one field more than in the snapshot, `deletable`: whether it can be deleted now, see **Deleting a material** in section 5.1), `sessions` (shaped as in the session list in the next row) and `knowledge_libraries` (the ids of the knowledge libraries the task uses, section 11) |
| `GET …/sessions` | sessions | `{ok, sessions: [{session_id, name, started_at, last_active_at, message_count, active, revision_count}]}`; `revision_count` is the number of revisions the session produced (counted by session id in the revision table, 0 when there are none). For a new session in which nothing has been said, `name`, `started_at` and `last_active_at` are null |
| `POST …/sessions` | new session | `{ok, session_id}`; `session_busy` while the agent works in another session |
| `GET …/items/{item_id}/revisions` | the item's content in each revision that changed it | `{ok, item_id, revisions: [{revision_no, by, at, fields, sources, reviews, confirmations}]}` |
| `GET …/revisions` | the revision log | `{ok, latest_revision, revisions: [{revision_no, at, by, session_id, work_id, op_id, undo_of_revision, trigger, intent, operations}]}`, newest first. `work_id` is the agent's unit of work (empty for the user's revisions); `op_id` is the user's direct operation. `trigger` says what caused the revision: `{kind: "typed" \| "card_choice" \| "ui_request", text, message_id}` for the message that started the agent's work, `{kind: "user_action", action, text}` for a direct operation (`text` such as 你把 TBD-003 标为先不管, "you kept TBD-003 pending"), or `{kind: "none"}`. `intent` is the user act that caused an agent's revision, when the agent recorded its understanding of your message and the revision matches it: `{act_id, function, function_name, summary}` (`act_id` such as r13-2, `function` one of the nine user functions of the understanding schema, `function_name` its Chinese name such as 纠正); it is empty for your own revisions and for tasks without understanding records. Each operation has `op`, `item_id`, `collection`, `title`, `revision_before`, `revision_after` and `fields_changed` (field names that differ from the item's previous revision; empty for add, delete and restore). |
| `GET …/materials/content?path=…` | a material's text | `{ok, path, text}`; the path must stay inside the materials directory. For a `.docx` the text is the generated Markdown projection (see **Materials** in 5.1); for a task created with 0.2 that only has the old `<name>.docx.txt`, that file |
| `GET …/materials/raw?path=…` | a material file as uploaded | the file's bytes; `Content-Type` by extension: `text/markdown; charset=utf-8` for `.md`, `text/plain; charset=utf-8` for `.txt`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` for `.docx`, `application/octet-stream` otherwise. Same path rule as `content`; the web interface uses it to show Word files in their original layout |
| `POST …/materials/delete` `{path}` | delete a material that has not entered the conversation | `{ok, path}`; `rejected` for one that has; see **Deleting a material** in section 5.1 |
| `GET …/knowledge`, `POST …/knowledge` `{libraries}` | the knowledge libraries the task uses, and changing them | see section 11 |
| `GET …/conversation?session=…&before={message_id}&limit=100` | earlier conversation | same shape as `conversation` in 4.1 |
| `POST …/documents/preview` and `…/download` `{"revision_no": N, "items": [ids], "format": "markdown"}` | render the whole deliverable as of one revision (default: the latest), optionally only the listed items | preview: `{ok, text}`; download: the file. The document says which revision it was generated from, and marks each item with the revision its content comes from and whether it was confirmed and reviewed in that revision; a confirmation is written with its basis: read (已读), user edit (用户修改) or explicit confirmation (明确确认). A revision number beyond the latest, or an item not in the deliverable at that revision, returns `bad_request`. |

## 5 Conversation

The conversation lives in pi's session file; the database does not store it.

### 5.1 The user says something

`POST …/messages?session={session_id}` with `{"text": "…", "client_id": "…", "attachments": ["inputs/…"], "origin": "typed", "card": null}`. Response `{ok, client_id, queued}`; `queued` is always `false`. The matching `user_message` event carries the same `client_id`. While the agent works, the message is refused with `session_busy` and `data.reason` `working`; send it again when the work has ended. Text starting with `/` is prefixed with `用户说：` before it reaches pi, so it is never taken as a command.

**Materials.** `POST …/materials` (multipart, one file): `.md`, `.txt` or Word `.docx`, at most 5 MB, stored in the task's materials directory (names with path separators are rejected). Returns `{ok, path}`. An upload is refused and nothing is stored when its bytes are the same as those of a material already in the task, whatever its name (`duplicate_content`, 409), or when a material with other bytes already has its name (`name_taken`, 409); in both cases `data.path` is that material and the message names it. Only materials put in by users are compared, not the projections and segment lists beside Word files (the entries with `derived_from`). Bytes are compared by their SHA-256, computed on every upload and not stored. Two names are the same when they are equal after removing white space at both ends, converting to Unicode NFC and ignoring case; names that differ only in full-width and half-width forms (for example full-width and half-width brackets) are different. The rule only decides whether names are the same: a file is stored under the name it was uploaded with. The checks run in this order: type, reserved names, size, bytes, name; when both the bytes and the name match, the answer is `duplicate_content`. An upload whose name was taken used to be stored as `<name>-2.<ext>`; that no longer happens. For a `.docx` the service also writes a Markdown projection for the assistant beside it, `<name>.docx.md`, and extracts its pictures to `<name>.docx.media/`. It also writes a segment list, `<name>.docx.segments.json`: the projection divided into blocks at the headings down to the level set in the startup profile's `材料分段` section (`heading_depth`; a block with fewer paragraphs than `min_paragraphs` joins the next one, and one with more than `max_paragraphs` is cut by paragraph count), each block with its heading, first and last paragraph number, first and last line in the projection, number of paragraphs with text and number of characters. The file records a digest of the parameters; when they change, the list is recomputed and rewritten the next time it is read. It also writes a location table, `<name>.docx.locations.json`: a header (the format `version`, the `rules_version` of the location rules, `source`, the paragraph count `paragraphs`, the number of page marks `w:lastRenderedPageBreak` in `page_marks`, and `application`, the program that saved the file as recorded in `docProps/app.xml`, empty when it is not recorded) and `headings`, one entry per heading paragraph with its `paragraph` number, its `level` (1 is the top level) and its `title`, the same text as that paragraph's heading line in the projection: its automatic number in whatever format, then the heading text. The heading paragraphs are the ones the projection writes as headings, so paragraphs in table cells are not among them. The web interface takes the chapter in a source label from this table and leaves the chapter out when the table cannot be read. The chapter of a cited paragraph is the nearest heading at or before it. The rules are in `agent/src/lib/docx_locations.ts`; the table holds no text of the other paragraphs, and Word files uploaded before it existed have none. Paragraphs are counted in the body of `word/document.xml`, table and nested-table paragraphs included, text-box paragraphs left out; headers, footers, footnotes, endnotes and comments are not counted. In the projection each paragraph is one line and its number is written `[pN]` in front of its text; headings start with `#` to `######` by level, taken from the paragraph's outline level, else its style's outline level (looked up through the base styles), else a style name `heading N` or `标题 N` (outline level 9 means body text, not a heading), and Word's automatic numbering is written in front of the number, not as part of the text; list items start with `- ` or with their number when it is of the form `1.`; tables are Markdown tables, one line per Word row with the first row as the header, the paragraphs of a cell separated by `<br>`, cells covered by a horizontal merge written `（同左）` and by a vertical merge `（同上）`, and the paragraphs of a nested table written into the outer cell after `（小表第 r 行第 c 列）`; a picture is a link `![图 k](<name>.docx.media/imageN.png)` in its paragraph, except in a heading, where it goes on its own line under the heading line and is not part of the heading text; a Word chart or SmartArt diagram becomes a line saying it was not converted; text-box text is a quote (`> （文本框）…`) without a paragraph number; empty paragraphs are not written but are still counted. The text of an equation is taken in order as plain text, without its layout (a fraction a/b is written `ab`). A comment at the top gives the paragraph count and how to cite. The projection is written by `agent/src/cli/docx_projection.mts`, which the service runs as a Node child process. The material list returns the `.docx`, the `.md`, the `.segments.json` and the `.locations.json`; each entry has `derived_from`, which is the path of the `.docx` for a projection, segment list or location table beside it (`.md`, `.segments.json`, `.locations.json`, or the 0.2 `.txt`) and `null` for every other file, and the web interface leaves out entries that have it. The list holds files only, so the picture folder is not in it. A `.docx` that cannot be read is refused with `unsupported_type` and nothing is kept, and names ending in `.docx.md` or `.docx.txt` are refused with `bad_request`. When a message's `attachments` include a `.docx`, the text sent to the assistant says to read the `.md` beside it. Tasks created with 0.2 keep their `<name>.docx.txt` (one line per paragraph, starting with `[第 N 段]` or `[第 N 段 · 表 t 行 r 列 c]`); when a Word file has no `.md`, the assistant, the excerpt check and the web interface read that file instead, and its segment list is computed from it when needed without being written.

**Deleting a material.** `POST …/materials/delete` with `{"path": "inputs/…"}` deletes a material that a user put in, together with the files generated from a Word material (its projection, segment list, location table and picture folder, and the 0.2 `.txt` projection), and pushes `material_removed` (section 3.2). It returns `{ok, path}`. Only a material that has not entered the conversation can be deleted. A material has entered the conversation when any session of the task was active after the material was uploaded: the latest activity of all sessions is later than or equal to the upload time, compared in milliseconds, and equal counts as entered. The upload time is the modification time of the material file: an upload creates the file exclusively and the service does not rewrite it afterwards. A new session in which nothing has been said has no activity time and does not count. A material that has entered the conversation is refused with `rejected` (422) and the message 这份材料已经进入了对话，不能删除。 ("this material has entered the conversation and cannot be deleted"); `data.path` is the material. In the task page response (`GET /api/v1/tasks/{task_id}`) every entry of `materials` carries `deletable`, decided the same way; it is also false when the task is completed or abandoned and for a generated file. That the agent is working at the moment is not counted. The other refusals are as before: a path outside the materials directory is refused with `bad_request`, and so is the path of a generated file; a path that is not in the material list gives `not_found`; a completed or abandoned task gives `task_closed`; while the agent is working the request is refused with `session_busy` (`data.reason` `working`), after the check above. A deletion leaves no trace: the agent can only cite a material inside a session, so every cited material has entered the conversation, and a material that can be deleted has no source pointing to it. Before a material enters the conversation it can be deleted and uploaded again; afterwards a new file can only be uploaded beside it, and items are not changed. Known limitation: the upload time is the file's modification time, so when a task directory is copied without keeping file times, or another program rewrites a material file, the time becomes later and the material can be deleted again.

### 5.2 The agent replies

Only accepted calls of the agent's `reply` tool become `assistant_reply` events with `via_reply_tool: true`. If a unit of work ends without an accepted reply, the server forwards the last assistant text with `via_reply_tool: false` and no `act`; if there is none, it sends `problem` with code `no_reply`. When the unit of work ended because of an error, it sends `problem` with code `failed` instead, with the text 助手这一轮因为出错停下了，你可以再说一句，让它接着做。 ("the assistant stopped this turn because of an error; say something more to let it continue"). When the user stopped the work, it sends neither. A unit of work that was stopped or failed keeps its `work_summary`, also after a reload, even when it has no step and no reply.

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

A Choose card that asks whether the task is finished has an option with `key` `complete` (text 已完成，提交交付物) and one with the text 还没完成，继续修改 ("not finished, keep editing"). The agent's `complete_task` succeeds only when the latest click on such a card was on `complete` and the deliverable has had no new revision since; typed messages do not count.

### 5.5 While the agent is working

New messages and direct operations are refused with `session_busy` (see 5.1); the one exception is `mark_viewed` without `notify_executor` (opening an item's details), which does not change the deliverable and is accepted while the agent works. `POST …/control?session=…` with `{"action": "stop"}` aborts the work; writes already saved stay. The answer is `{"ok": true, "cleared": […]}`: `cleared` holds the messages that were still queued for the agent and were dropped with the stop; since the conversation takes strict turns, no message is accepted while the agent works, so it is always empty. When the model service is unavailable, pi retries and the server sends `problem` with code `model_unavailable`.

### 5.6 Who starts the agent

Opening a session (a snapshot with `session`) starts pi for that task or switches it to that session. One task has one active session at a time: while the agent works in session A, messages and actions for session B return `session_busy`. During startup, requests return `executor_starting` (retry once shortly after). A message, a card click or a direct operation for a session starts pi on demand when it is not running (not started yet, exited, or stopped after a failed resume) and resumes that session first, as opening the session does; direct operations run inside pi. If pi cannot be started, the request returns `executor_unavailable`; a snapshot is still answered (section 4.1). A direct operation without a `session` parameter does not start pi and returns `executor_unavailable` while pi is not running.

After resuming or switching, the service checks that pi reports the requested session. If pi reports another session (for example because the session file is gone and pi opened a new session instead) or refuses to switch, the service does not adopt that session: it stops the task's pi, writes a log line with the task, the requested session and the session pi reported, and answers `session_resume_failed`. The check happens before a message is handed to pi, so the message is not sent and goes into no session; the next request starts pi again as usual. A snapshot is still answered in this case, with the conversation read from the session file and `executor.state` `not_started`. A session file that is missing altogether still gives `not_found`. The service turns `--tasks` and `--runs` into absolute paths when it starts, and hands pi absolute session file paths.

## 6 Direct operations

`POST …/actions?session={session_id}`:

```
{ "client_id": "…", "kind": "edit_fields" | "delete_item" | "mark_viewed" | "keep_pending" | "undo" | "request_review" | "waive_review" | "unwaive_review" | "set_review_rules" | "submit_deliverable",
  "targets": [ { "item_id": "UC-002", "base_revision": 3 } ],  // the item's revision when you opened it; for undo: "revision_no"
  "fields": { "基本流程": ["…", "…"] },                          // edit_fields: complete new values; submit_deliverable: { "revision_no": N }
  "notify_executor": false }
```

Response `{ok, client_id, op_id}`; the result arrives as events carrying the same `op_id`. Rules:

1. Every `base_revision` must be the item's current revision, otherwise the whole batch is rejected with `stale_revision` listing each stale item, its current revision and who changed it.
2. `undo` of revision N produces a new revision M that puts every item of N back to its previous state (an add is undone by a delete, a delete by a restore) and records `undo_of_revision`; if an item was changed again afterwards, the undo is rejected with `undo_conflict`.
3. `mark_viewed` marks each target as read as of `base_revision`. It is idempotent: an item whose latest mark on that revision is already an acceptance is skipped, and when every target is skipped nothing is written and no event is sent. Without `notify_executor` (the interface sends it when the user opens an item's details) nothing is appended to the session; with it (the "I've read these" card button) an interface-action note and the fixed sentence in section 7 are. Items that failed review can still be marked as read.
4. Withdrawing a confirmation (`unconfirm`) is no longer an operation: like the earlier retired `confirm`, it is answered with 400 `bad_request`, whose message lists the operation kinds that exist. Withdrawals made by earlier versions are still read and shown: when the latest mark on an item's revision is a non-acceptance, `confirmation_stale` is true, and the item still counts as read.
5. `edit_fields` and `keep_pending` also record a confirmation mark (basis `ui_edit`) on the revision they produce, in the same transaction.
6. `request_review` asks the reviewer to review the targets at their `base_revision`; an empty `targets` list means every item waiting for review (in a collection that requires review, with no review at its current revision). The response comes as soon as the request passes its checks; the review runs in the background and reports through `review_progress`, `review_recorded` or `review_unfinished` for each item, and `review_finished`, all carrying the same `op_id`. "Waiting for review" means the item's current revision has no review under the collection's current `rules_hash`. An item is reviewed once per revision and rule set: a named target that already has one is rejected with 什么都没有评，因为：X 在当前修订上已经评过，内容和规则都没变；同一次修订、同一套规则只评审一次。 ("nothing was reviewed: X was already reviewed at its current revision, neither content nor rules changed; one revision is reviewed once under one rule set"). The request no longer has a force-review field; a `force` field is not passed on. It is also rejected (`rejected`) while another review runs, when there is nothing to review, when a target is in a collection that is not reviewed, or when a target is not at its current revision. Each review ends with a `review_batch` event. When a review started here is over, an interface-action note is appended to the session with one sentence of counts (`kind` `request_review`, `review` with the counts); the findings are not in it, and the agent reads them with `get_task_status`. It does not start the agent. Clients should not show "saving" for it.
7. `waive_review` keeps the current wording of each target whose review verdict at its `base_revision` is failed (see section 4.1: its last review under the current rules is not compliant and nothing was kept after it); the waiver applies to that last review; `fields` may carry `reason` and `source` (`detail` or `panel`). The item then counts as passed by the user's decision until it changes. `unwaive_review` withdraws the waiver that counts. Both are rejected when there is nothing to keep or withdraw. Only the user can do either; the agent has no such tool.
8. `set_review_rules` sets which optional rules of a collection are switched off or made required: `targets` is empty and `fields` is `{ "collection": …, "off": [rule ids], "promote": [rule ids] }`. It updates the task definition copy in the task directory and in the database, and is rejected for required rules, unknown rule ids, a collection without review rules, or no change. Existing reviews are kept; the rule fingerprint changes, so the collection's items wait for review again.
9. On a closed task every operation returns `task_closed`.
10. While the agent is working every operation returns `session_busy` with `data.reason` `working`, except `mark_viewed` without `notify_executor`.
11. `submit_deliverable` completes the task on the user's behalf: the web interface sends it when the user clicks 已完成，提交交付物 ("finished, submit the deliverable") on the green bar above the items and then 提交 ("submit") in the confirmation. `targets` is empty and `fields` is `{ "revision_no": N }`, the latest revision of the deliverable the page showed. It runs the same checks as the agent's `complete_task`, and the click itself is the user's agreement. When a completion condition is not met it is refused with `rejected` and a message starting 任务没有标为已完成。 ("the task was not marked completed") followed by what is missing. When N is not the deliverable's latest revision it is refused with `rejected` and 这次没有提交：你看到的是修订 N，交付物现在已经是修订 M。请看过现在的内容再提交。 ("not submitted: you saw revision N, the deliverable is now at revision M; look at the current content and submit again"). Otherwise the task becomes 已完成: `task_changed` is sent with `actor` `user` and without `op_id`, and an interface-action note is appended to the session (`kind` `submit_deliverable`): 界面操作（不是用户打的字）：用户在页面上确认这个任务已经完成，提交了交付物（修订 N）。任务已标为已完成，交付物不能再改，仍然可以生成文档。 It does not start the agent's work, and it cannot be undone. Clients should not show "saving" for it. The interface shows the bar only while the task is in progress, `completion.all_met` is true, the agent is not working and the session has no unanswered Choose card with an option of `key` `complete` (see 5.4).

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
| `bad_request` | 400 | malformed request, or a path outside the materials directory or outside a knowledge library's `files/` |
| `not_found` | 404 | task, session, item, material, knowledge library, knowledge document or endpoint does not exist, or the service has no knowledge base |
| `rejected` | 422 | validation failed; `data.reasons` lists every reason |
| `stale_revision` | 409 | revision check failed; `data.items` = `[{item_id, base_revision, current_revision, changed_by}]` |
| `old_format` | 409 | a task created before revisions replaced item versions; not supported by this version (the task list shows such tasks with `supported: false`) |
| `undo_conflict` | 409 | the item changed again after the revision being undone |
| `task_closed` | 409 | the task is completed or abandoned |
| `session_busy` | 409 | the agent is working: in another session (`data.active_session`), or in this one when a message or direct operation arrives (`data.reason` is `working`); also when a material is deleted while it works |
| `task_occupied` | 409 | another running service serves this task (its `service.lock` names a live process); `data` has its `port`, `pid` and `host` |
| `forbidden` | 403 | an endpoint that accepts only requests from this machine got one from elsewhere (so far only `POST /api/v1/service/exit`, see section 9) |
| `executor_starting` | 503 | pi is starting |
| `executor_unavailable` | 503 | pi failed to start (`data.detail`), or a direct operation without `session` came while pi was not running |
| `session_resume_failed` | 503 | pi did not pick up the requested session after resuming or switching (section 5.6); pi was stopped and the message was not sent; `data.session_id` is the requested session |
| `busy_timeout` | 503 | waited too long for the database write lock |
| `too_large`, `unsupported_type` | 413, 415 | attachment too big (more than 5 MB for a material, 20 MB for a knowledge document) or of the wrong type |
| `duplicate_content`, `name_taken` | 409 | an uploaded material has the same bytes as one already in the task, or the name of one with other bytes (see **Materials** in section 5); `data.path` is that material. For a knowledge document, one already in the same library, and `data.name` is that document (section 11) |
| `in_use` | 409 | a chosen model belongs to the model service being removed, or is being disabled (section 10); `data.provider_id` is the model service |
| `config_unwritable` | 409 | `models.json`, `auth.json` or the product's settings file cannot be read as a JSON object, or contains comments that rewriting would lose (section 10); `data.file` is the file name, and the file is left as it is |
| `config_locked` | 503 | another program held the lock on one of those files for more than two seconds (section 10); `data.file` is the file name |

## 9 Other conventions

1. Texts that depend on the task definition (collection names, field names and types, enumeration values, completion condition names) always come from the API.
2. Several pages may watch the same task; a save from a second page may be rejected as stale.
3. Paths carry the version `v1`; fields are only ever added, never change meaning; clients ignore unknown events and fields.
4. Not in this version: multiple simultaneous users, authentication, streaming reply text.
5. **Service information and run mode.** These two endpoints need no task.
   - `GET /api/v1/service` returns `{ "ok": true, "app": "taskwright", "version": …, "mode": "desktop" | "server", "pid": …, "port": …, "capabilities": { "exit": true | false, "model": true | false, "model_config": true | false, "knowledge": true | false }, "model": { "name": …, "reason": … }, "upload": { "max_bytes": 5242880, "too_large_text": "单个文件不能超过 5 MB。", "extensions": [".md", ".txt", ".docx"], "types_text": ".md、.txt 与 Word 的 .docx", "unsupported_type_text": "只接受 .md、.txt 与 Word 的 .docx 文件。" } }`. `port` is the port the service actually listens on. `upload` gives the upload limit in bytes and the sentence shown when a file is over it, the same sentence as in the `too_large` rejection, the file extensions that can be uploaded, those types written out for people (`types_text`), and the sentence of the `unsupported_type` rejection (`unsupported_type_text`); the last two are built from the extensions. The web interface uses the limit and the extensions to refuse a file that is too large or of another type before sending it, with the matching sentence, the extensions to filter the file chooser, and `types_text` to write the upload hint. It serves three uses: a packaged launcher checks whether the service on a port is its own; deployment and monitoring use it as a health check; a client shows or hides controls and notices according to `capabilities`. `capabilities.exit` is `true` only when the service was started with `--mode desktop` and the request comes from the loopback address, the same check the exit endpoint makes; a page opened from another computer gets `false` and so shows no exit control. Behind a reverse proxy the service sees the proxy's address, so a desktop-mode service should not be put behind one. `capabilities.model_config` says whether the page may change the model configuration (section 10); it is always `true` now, from any computer, and is kept for when signing in is added.
   - `capabilities.model` is the result of a model check: it is `true` when the model the service will start pi with (`model.name`, as provider/model; the language model chosen in the model configuration when there is one, see section 10) is registered in `models.json` in pi's configuration directory, or its provider has an entry in `auth.json`. `model.reason` is one sentence: with `--mode desktop` it gives the full paths of the two files it looked at; with `--mode server` it names the files without their directories, so the server's paths are not shown to remote clients. The check runs on every request, reads only these two files and never starts pi; a provider whose key is only in an environment variable is not recognized and gives `false`. With `--mode desktop`, `model.name` may come from pi's `settings.json` (see section 10.4 of the deployment guide).
   - `capabilities.knowledge` is `true` when the service has a knowledge base (section 11). Then the answer also has `knowledge_upload`, with the same five items as `upload` for knowledge documents (the limit is 20 MB, and `too_large_text` is 单个文件不能超过 20 MB。) plus `kinds`, the document kinds with their Chinese names, `[{kind, name}]`. The web interface shows the 知识库 ("knowledge base") entry and asks where an upload goes only when `capabilities.knowledge` is `true`.
   - `POST /api/v1/service/exit` exists only when the service was started with `--mode desktop`; with `--mode server` it returns `not_found`. It accepts requests only from the loopback address (`127.0.0.1` or `::1`; `::ffff:127.0.0.1`, the IPv4 loopback address on an IPv6 socket, counts as loopback) and answers any other source with `forbidden` (403). It first answers `{ "ok": true }`, then shuts down as on SIGTERM: it stops accepting connections, sends `service_exiting` to every open event stream, closes each task's pi, removes the occupancy marks it wrote and exits. It is meant only for the 0.3 transitional package, in which the service opens the browser itself and there is no desktop shell; the final desktop version stops the service from its shell, and this endpoint is not promised to stay.
   - The run mode (`--mode desktop|server`, default `server`) decides the default bind address (`desktop`: `127.0.0.1`, `server`: `0.0.0.0`; `--host` overrides both) and whether the exit endpoint exists. Everything else behaves the same in both modes. The mode is written to the startup log and to each task's occupancy mark (`mode` in `service.lock`).

## 10 Model configuration

These endpoints let the web interface set up the model services and choose which models are used. The assistant's language model is called by pi, which reads the model services from `models.json` and their keys from `auth.json` in its configuration directory (`PI_CODING_AGENT_DIR`, by default `.pi/agent` in the home directory). The embedding model is called by the task service itself; in this version the task service only records which one is chosen. Which models are chosen is kept in the product's own settings file (see section 5 of the [deployment guide](deployment.md)).

**When a change takes effect.** A newly chosen language model is used from the next time a session is opened or created; a session in progress keeps its model. After starting pi, after `new_session` and after `switch_session`, when pi's model differs from the chosen one, the task service switches it with `set_model`. So a session opened again after the change also continues with the newly chosen model, and pi adds a model change to that session's record. If the switch fails, the session is not opened: the request returns `executor_unavailable`, and the executor state says which model could not be used and why. While no language model is chosen, the rules of 0.3 apply: the startup profile's model, or with `--mode desktop` the one named in pi's `settings.json`.

**What the task service writes.** It only adds, changes and removes the model services it registered itself; their names start with `taskwright-` and are listed in the settings file. Everything else in `models.json` and `auth.json` is kept exactly as it is, including fields added by hand to the entries the task service manages. Before each write it copies the file to `<file>.taskwright-backup-<time>` in the same directory and keeps the five most recent copies; backups of `auth.json` have the same permissions as the file (0600). It takes the same lock as pi, a directory named after the file with `.lock` appended, and writes through a temporary file that is then renamed. A file that contains comments (pi allows them) is not rewritten, since the comments would be lost; the request returns `config_unwritable`.

**Keys are never returned.** A model service with a key shows `key: {set: true, last4: "3f9c"}`.

### 10.1 Objects

A **model service** (`provider`):

| Field | Meaning |
|---|---|
| `id` | the name under which it is registered in `models.json`, such as `taskwright-ollama` (a second one of the same kind gets `-2`, and so on); also the provider part of `provider/model` |
| `managed` | `true` for the model services added here. `false` for those written into `models.json` by hand: they are listed read-only, with `id`, `name` and their models, all shown as enabled language models; they cannot be changed or removed here and their keys are not looked at, but their models can be chosen as the language model |
| `kind` | `ollama`, `llamacpp`, `vllm`, `deepseek`, `aliyun` (pay-as-you-go only), `openai_compatible` or `codex`; `null` when `managed` is `false` |
| `name` | the name shown to people |
| `base_url` | the address as entered; `null` for `codex` and for read-only services |
| `key` | `{set, last4}`; `null` for `codex` and for read-only services |
| `status` | the last connection check, `{checked_at, ok, message}`; for `codex`, `{checked_at, ok, logged_in, message}`; `null` for read-only services |
| `models` | `[{id, type, enabled, context_window, context_source}]`: `type` is `language` or `embedding`; only enabled models can be chosen; `context_window` is a whole number of tokens or `null`; `context_source` is `service` (read from the model service), `user` (entered) or `null` |
| `models_fetched_at` | when the model list was last fetched, or `null` |
| `in_use` | `[]`, or `language` and/or `embedding` when the chosen model of that type belongs to this service |

### 10.2 Endpoints

Like the rest of the API, these use only GET and POST.

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /api/v1/model-config` | everything the settings page shows | `{ok, editable, notice, selection, fallback, providers}`. `editable` is always `true` and `notice` always `null`; both are kept for when signing in is added. `selection` is `{language: {provider_id, model_id} \| null, embedding: {provider_id, model_id, query_prefix} \| null}`. `fallback` is the model pi is started with while no language model is chosen, `{model, from}` with `from` 启动配置 ("startup profile") or 助手程序的设置 ("the assistant program's settings": in desktop mode, the default model in pi's settings file), which the page shows as given, or `null` when a language model is chosen. `providers` lists the managed model services first, then the read-only ones. |
| `POST /api/v1/model-config/providers` `{kind, name, base_url, api_key}` | add a model service | Checks the connection once, without asking for a model, and saves only if the check succeeds: `{ok, provider}`. `name` may be omitted (a default by kind); `base_url` may be omitted for `ollama`, `llamacpp`, `vllm`, `deepseek` and `aliyun` (their default addresses), is required for `openai_compatible` and ignored for `codex`; for the three local kinds it is the server's address, and `/v1` is added for pi. `api_key` is required for `deepseek` and `aliyun`, optional for the others and ignored for `codex`. A failed check returns `rejected` (422) and saves nothing; `data.field` is `base_url` with 连不上这个地址。请确认模型服务已经启动，地址与端口没有写错。 ("cannot reach this address; check that the model service is running and the address and port are right"), or `api_key` with 模型服务拒绝了这个密钥。 ("the model service refused this key"). For `codex` the check only looks whether `auth.json` holds a Codex login; the service is saved either way. |
| `POST /api/v1/model-config/providers/{id}` `{name?, base_url?, api_key?, models?}` | change a model service | `{ok, provider}`. A new `base_url` or `api_key` is checked as when adding. `models` replaces the whole model list with `[{id, type, enabled, context_window}]`; an enabled language model without `context_window` is `rejected`, and so is an embedding model for `codex`. Disabling or removing a chosen model is `in_use`. A read-only service returns `not_found`. |
| `POST /api/v1/model-config/providers/{id}/delete` | remove a model service | `{ok}`; removes its entry from `models.json` and its key from `auth.json`. `in_use` (409) while a chosen model belongs to it; `not_found` for a read-only service. |
| `POST /api/v1/model-config/providers/{id}/check` | check the connection again (for `codex`: check the login again) | `{ok, provider}` with a new `status`; never `rejected` |
| `POST /api/v1/model-config/providers/{id}/fetch-models` | ask the model service for its models | `{ok, result, message, provider}`. `result` is `listed` (the list is merged into the stored one: new models are added disabled, known models keep their settings and take a new context length from the service unless one was entered, and `models_fetched_at` is set), `not_offered` (这个模型服务没有提供模型的清单，请手工添加。, "this model service offers no list of models; add them by hand") or `failed` (获取模型列表没有成功：reason。可以稍后再试，或者手工添加。, "fetching the model list failed: reason; try again later or add them by hand"; for `codex`, whose models cannot be added by hand, the second sentence is 可以稍后再试。, "try again later", or, when the subscription is not signed in, 请先在命令行里登录，再回到这里点「获取模型列表」。, "sign in on the command line first, then press 获取模型列表 here"). How each kind is asked is listed in 10.3. |
| `POST /api/v1/model-config/providers/{id}/context-window` `{model_id}` | find the context length the service really gives this model | `{ok, context_window, source, message}`; `context_window` is `null` when it cannot be found, and `message` then asks for it to be entered. For `ollama` this loads the model first and may take up to two minutes. The value is not saved; save it by changing the model service. |
| `POST /api/v1/model-config/selection` `{language, embedding}` | choose the models | `{ok, selection, note}`, `note` being 更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。 ("takes effect the next time a session is opened or created; a session in progress is not affected"). Each part is `{provider_id, model_id}` (the embedding part may add `query_prefix`) or `null`. The model must be enabled and of the right type, and a language model of a managed service must have a context length; otherwise `rejected`. The language model may come from a read-only service; the embedding model may not. `language: null` goes back to the 0.3 rules; `embedding: null` means no embedding model. |

### 10.3 How the model list and the context length are found

Every request to a model service times out after 5 seconds, except loading an `ollama` model (120 seconds).

| kind | model list | type | context length |
|---|---|---|---|
| `ollama` | `GET /api/tags`, then `POST /api/show` per model | `embedding` when `capabilities` has `embedding` but not `completion` | not filled from the list (`/api/show` gives the training maximum). `context-window` loads the model and reads `context_length` from `GET /api/ps`. |
| `llamacpp` | `GET /v1/models` | `language` | `meta.n_ctx` |
| `vllm` | `GET /v1/models` | `language` | `max_model_len` |
| `deepseek` | `GET /models` | `language` | `context_window` |
| `aliyun` | `GET /models`; `not_offered` when there is none | `embedding` when the name contains `embedding`, otherwise `language` | `null` |
| `openai_compatible` | `GET /models`; `not_offered` on 404 | `language` | `max_model_len`, `context_window` or `meta.n_ctx` when present, otherwise `null` |
| `codex` | pi's own catalog of the Codex subscription, read offline; empty until the subscription is logged in | `language` | from pi's catalog |

### 10.4 Changes to other parts

- `GET /api/v1/service`: `capabilities` gains `model_config` (section 9), and `capabilities.model` and `model` look at the chosen language model first.
- Errors (section 8) gain `in_use`, `config_unwritable` and `config_locked`.

## 11 Knowledge base

A task's materials are what the task organises into items; the knowledge base holds the reference documents consulted while doing so, such as standards, glossaries, templates and earlier deliverables. Materials do not go into the knowledge base. The knowledge base is divided into libraries, and each task uses some of them. The library `general` (通用知识库, "general knowledge base") is used by every task, cannot be renamed or deleted, and is created when the service starts and finds no library list; when an existing list still has it under its name from before 0.4.1, 通用库, the service changes that to the present name at startup and writes the list back, leaving names users chose alone. Documents have no versions: a changed document is uploaded as a new file. How the assistant uses the knowledge base and how a source cites one of its documents is at the end of this section.

**Storage.** Under the knowledge root (`--knowledge`, default `knowledge/` in the user data directory, next to the task directories): `libraries.json` (`{version: 1, libraries: [{id, name, created_at}]}`), and for each library `<id>/documents.json` (`{version: 1, documents: [{name, kind, bytes, sha256, uploaded_at}]}`) and the document files in `<id>/files/`. A Word document gets the same projection, segment list, location table and picture folder as a Word material (section 5.1), with its path written as `<id>/files/<name>`; these files are not listed in `documents`. Both JSON files are written to a temporary file first and then renamed. A library id is `lib-` followed by eight hexadecimal digits. The libraries a task uses are kept in `knowledge.json` in the task directory (`{version: 1, libraries: [id…], notes: [{at, text}]}`): a new task gets `["general"]`, and a task without that file (created before this version) counts as using `general` only; the file is written when its choice is changed. A service started without a knowledge root (possible only when the service is created in code, not from the command line) has no knowledge base: `capabilities.knowledge` is `false` and every endpoint below returns `not_found`.

**Document kinds.** `kind` is one of `standard` (规范), `glossary` (术语表), `template` (模板), `past_work` (以往的成果) and `other` (其他). It is only a label and does not decide how a document is used. The Chinese names come with the service information (`knowledge_upload.kinds`, section 9).

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /api/v1/knowledge` | all libraries with their documents | `{ok, libraries: [{id, name, created_at, used_by_tasks, documents: [{name, kind, bytes, uploaded_at}]}]}`. `used_by_tasks` counts the in-progress tasks that this service serves and that use the library; tasks served by another service are not counted |
| `POST /api/v1/knowledge/libraries` `{name}` | create a library | `{ok, library: {id, name, created_at}}`. An empty name gives `rejected` with 知识库的名字不能是空的。 ("the knowledge base name cannot be empty"); the name of another library, by the same name rule as materials, gives `rejected` with 已经有一个叫「…」的知识库了。 ("there is already a knowledge base called …") |
| `POST /api/v1/knowledge/libraries/{id}` `{name}` | rename a library | `{ok, library}`; `general` gives `rejected` with 通用知识库不能改名。 ("the general knowledge base cannot be renamed") |
| `POST /api/v1/knowledge/libraries/{id}/delete` | delete a library together with its documents | `{ok, id}`. Tasks served by this service that used the library stop using it, with a line in `notes` of their `knowledge.json` and no event; tasks served by another service are not changed. `general` gives `rejected` with 通用知识库不能删除。 ("the general knowledge base cannot be deleted") |
| `POST /api/v1/knowledge/libraries/{id}/documents` | upload a document (multipart, one file, plus a field `kind`) | `{ok, document: {name, kind, bytes, uploaded_at}}`. The checks follow uploading a material (section 5.1): file name, type (`.md`, `.txt`, Word `.docx`), reserved names, size (at most 20 MB, `too_large`; a larger request body is refused without being read), `kind` (`bad_request`), bytes, name. Bytes and names are compared within the same library only: the same bytes give `duplicate_content` with 这份文件与这个知识库里已有的文档《…》内容完全相同，没有重复保存。 and the same name with other bytes gives `name_taken` with 这个知识库里已经有一份叫《…》的文档，内容与这份不同。请给文件换一个名字再上传。; in both, `data.name` is the existing document. A `.docx` that cannot be read gives `unsupported_type` and nothing is kept |
| `POST /api/v1/knowledge/libraries/{id}/documents/delete` `{name}` | delete a document together with its generated files | `{ok}` |
| `GET /api/v1/knowledge/libraries/{id}/documents/content?name=…` | a document's text | `{ok, name, text}`; for a `.docx`, its projection. The file must be inside that library's `files/` (`bad_request` otherwise) |
| `GET /api/v1/knowledge/libraries/{id}/documents/raw?name=…` | a document file as uploaded | the file's bytes, with `Content-Type` as for materials |
| `GET /api/v1/tasks/{task_id}/knowledge` | the libraries the task uses | `{ok, libraries: [id…]}`; also in `knowledge_libraries` of `GET /api/v1/tasks/{task_id}` |
| `POST /api/v1/tasks/{task_id}/knowledge` `{libraries: [id…]}` | change the libraries the task uses | `{ok, libraries}`. `general` is always kept and put first; an unknown id gives `rejected` with 没有这个知识库：…。 ("no such knowledge base"); a completed or abandoned task gives `task_closed`. Changing the choice does not touch a conversation that is under way: the task status message at the start of the next conversation follows the new choice, and a resumed conversation gets the list again |

Uploading a material is unchanged. On the task page of the web interface an upload is always a material and no destination is asked; reference documents are uploaded on the knowledge base page, which calls the document upload above.

**How the assistant uses the knowledge base.** When the task service starts the assistant it hands over the knowledge root (an absolute path) in the environment variable `TASKWRIGHT_KNOWLEDGE_ROOT`; a service without a knowledge base does not, and drops a variable of that name from its own environment. The assistant only reads the knowledge base and gets no new tool; it uses the `read`, `grep` and `ls` it already has:

- The task status message at the start of each conversation lists, on a new line after the materials, 这个任务选用的知识库 ("the knowledge bases this task uses"): one line per library with its name and number of documents, then one line per document with its name, kind (in Chinese), size, the absolute path the assistant can read (for a Word document, the path of the projection `<name>.md` generated from it) and how to write the locator when citing it. The part is left out when none of the task's libraries has a document or the service has no knowledge base. `details.knowledge` of the message is the same list: `[{id, name, documents: [{name, kind, bytes, locator}]}]`.
- When a conversation is resumed, the part is written again only if the task's choice or the document list of a chosen library changed since the conversation's last message (judged by the modification times of `knowledge.json` in the task directory and of the chosen libraries' `documents.json`; creating, renaming or deleting a library the task does not use does not count, and neither does renaming a chosen one); when neither the deliverable nor the materials changed, the message says 交付物没有变化。 ("the deliverable has not changed") followed by this part.
- `get_task_status` lists the same part, with the same `details.knowledge`.
- Documents are always looked up on demand: the assistant reads the list, searches literally with `grep` and reads the relevant passage with `read`, and never loads a whole document into its context. This version searches literally only. Documents in the knowledge base are not organised into items.

**How a source cites a knowledge base document.** There is no new kind of source: the kind stays 文档原文 ("document excerpt") and the locator is `knowledge/<library id>/<document name>`, with a paragraph number for a Word document as for materials (`knowledge/<library id>/<document name>.docx#p12`). A locator that starts with `knowledge/` is a knowledge base source; any other is a material. Saving a revision and the basis of a suggested value in a reply check it the same way:

- The file is read from `<library id>/files/<document name>` under the knowledge root and the excerpt is checked verbatim by the rules for materials (a Word document against its projection, by paragraph number; a locator that names the projection itself is refused).
- Only documents in the libraries the task uses can be cited. A new source is refused, with the reason stated, in five cases: the service has no knowledge base, the locator is malformed, the library no longer exists, the task does not use that library, the document cannot be found.
- When the assistant gives one of the item's current sources once more unchanged (the same kind, locator and excerpt), it is kept without checking in all those cases: the source records what was cited at the time, and a missing document does not make the citation wrong. Material sources have no such exception: a material that has entered the conversation cannot be deleted (**Deleting a material** in section 5.1), so the file of a cited material is always there, and when it cannot be read the source is refused like a new one.
- A locator that is not a knowledge base source must resolve to a path inside the task directory: an absolute path outside it, or a relative path that leaves it through `..`, counts as unreadable and a new source with it is refused.

In review, sources citing knowledge base documents take part, like material sources, in deciding whether two items cite the same place; knowledge base documents are not added to the materials shown to the reviewer. In a generated document a knowledge base source is written 知识库，出处 <library name> / <document name> ("knowledge base, from …"), followed by 第 N 段 ("paragraph N") for a Word document, and by the library's id when the library no longer exists.

In the web interface a knowledge base source carries the label 知识库 ("knowledge base") and its locator reads "library name / document name"; clicking it shows the document's text in a read-only dialog (`documents/content` in the table above). When the document is no longer in that library's list the locator cannot be clicked and 这份文档已经不在知识库里 ("this document is no longer in the knowledge base") is written beside it. The work view fetches the library list (`GET /api/v1/knowledge`) when it opens and again when the browser window regains focus; changes to the knowledge base push no events.

[中文版](api.zh-CN.md)
