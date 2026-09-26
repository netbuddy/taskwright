> 本文是英文版 [api.md](api.md) 的中文译本，两者不一致时以英文版为准。

# 接口参考（API reference）

> 本文写给用自己的程序驱动 Taskwright 的集成者。Taskwright 处于 alpha 阶段（0.1.0-alpha），接口与事件的形状在各版本之间仍可能变动。只用网页界面的使用者不需要读本文，见[用户手册](user-guide.zh-CN.md)。

任务服务（task service）说的是 HTTP 与服务器推送事件（Server-Sent Events，SSE）。所有路径都以 `/api/v1` 开头。时间一律是带时区的 ISO 8601 字符串。下文的节号是稳定的；代码注释里会用 `docs/api.md §N` 这种写法来引用它们。

**修订（revision）。** 每一次保存——执行者的一次 `save_revision` 调用，或用户的一次直接操作——都产生交付物的一次修订，序号在任务内从 1 起连续递增。条目没有自己的版本号：条目在某一时刻的内容由「条目编号加修订号」标识，条目改动过的修订号天然不连续（UC-001 可能在修订 4 和修订 9 改过）。条目「当前所在的修订」是最近一次新增、修改或恢复它的那次修订。确认与评审是挂在「条目加修订」上的标记，条目之后再改动时，这些标记不会跟着移动。

**一次只有一方在写。** 用户的一句话启动智能体的一次运行。运行期间再来的说话与直接操作一律被拒绝，错误码 `session_busy`，`data.reason` 为 `working`；不排队。客户端应在 `executor.state` 为 `working` 时禁用发送与写入。

**工作编号。** 一次工作的编号是 `w-` 加上启动它的那句用户的话的会话条目编号。实时推送的事件（`work_started`、`step`、`assistant_reply`、`work_summary`、`work_ended`）与刷新后读到的对话用同一个编号；修订日志（4.3 节）写明智能体的每次修订属于哪次工作。

## 1 客户端应当如何使用这套接口

1. **页面加载时：先打开事件流，再读一份快照（snapshot）。** 把快照到达之前收到的数据库事件先缓存起来；快照到达后，丢弃序号不大于快照 `seq` 的那些缓存事件，其余的按顺序应用。对话事件与进度事件则是随到随显示。
2. **此后只监听。** 除此之外唯一的读取都是按需发起的：某个条目改动过的各次修订、某份材料的正文、更早的对话、生成文档。
3. **界面变化只能来自事件。** 一次请求的响应只会说「已接受」（附带一个操作编号 op_id）或「已拒绝」（附带原因）。数据库事件有可能先于响应到达，要按 `op_id` 去匹配。被拒绝的请求不产生任何事件。
4. **断线重连。** 重连时浏览器发送最后收到的数据库事件编号（`Last-Event-ID`），服务器把之后的事件重放一遍。如果缺失的事件超过 500 条，服务器发送 `resync`，客户端从第 1 步重新开始。每个序号只应用一次。

## 3 事件流

`GET /api/v1/tasks/{task_id}/events?session={session_id}` — 一条 SSE 流。每条消息由一行 `event:` 和一行 `data:`（JSON）组成。**只有数据库事件带 `id:` 行**，其值等于事件序号。服务器每 15 秒发一次保活注释；客户端应在静默 45 秒后重连，并忽略未知的事件类型与字段。

### 3.1 数据库事件（有编号，可重放）

```
event: deliverable_changed
id: 12
data: {
  "seq": 12, "at": "2026-01-01T09:30:05+08:00",
  "task_id": "TASK-20260101-AB12", "revision_no": 3,
  "actor": "executor",                 // executor（执行者）或 user（用户）
  "work_id": "…",                      // 对执行者而言：产生这次变更的一个工作单元
  "op_id": null,                       // 对用户而言：/actions 返回的那次直接操作的编号
  "undo_of_revision": null,            // 若这次修订是撤销另一次修订而产生的，写被撤销的那次修订号
  "operations": [
    { "op": "add", "collection": "功能用例", "item_id": "UC-005", "title": "…",
      "revision_before": null, "revision_after": 7,   // 条目改前与改后所在的修订；新增时改前为 null，删除时改后为 null
      "fields": { … 截至这次修订的全部字段 … },
      "sources": [ { "kind": "文档原文", "locator": "inputs/requirements.md", "excerpt": "…",
                     "supports": [ { "field": "基本流程", "index": 0 } ] } ] },   // supports 为空表示支撑整个条目
    { "op": "update", … }, { "op": "delete", "fields": null, "sources": [], … },
    { "op": "restore", … }             // 撤销一次删除
  ],
  "completion": { … 见第 4.2 节 … }    // 无法计算时为 null
}
```

来源（source）的种类：`文档原文`（材料里的逐字引用）、`用户的话`（用户在对话里说的话）、`执行者补充`（由智能体（agent）添加，并附上理由）、`领域说明`（同一个任务里的一条领域说明；locator 是它的条目编号，例如 `DN-002`，excerpt 是所依据的那一句）、`用户直接修改`（在界面里的一次直接编辑；由系统写入，locator 是操作编号）。集合（collection）名与字段名由任务定义（task definition）给出。

| 事件 | 发生时机 | `data` |
|---|---|---|
| `task_changed` | 任务被创建、完成或放弃时 | `seq`、`at`、`task_id`、`task_name`、`status_before`、`status_after`、`actor`、`completion` |
| `review_recorded` | 评审者（reviewer）评完一个条目时；`verdict` 为 `合规` 或 `不合规`，由代码按发现所依据规则的级别算出 | `seq`、`at`、`task_id`、`item_id`、`revision_no`、`verdict`、`reason`、`findings`（每条有 `rule_id`、`level`（`必选` 或 `可选`）、`field`、`index`（从 0 起，指整个字段时为 null）、`problem`、`suggestion`）、`op_id`（用户在界面上发起的评审才有）、`completion` |
| `review_unfinished` | 一个条目的评审没有完成（超时、调用失败、两次输出不合格、评审期间条目被改），不记合规与否 | `seq`、`at`、`task_id`、`item_id`、`revision_no`、`reason`、`op_id`、`completion` |
| `review_progress` | 界面发起的一批评审（`request_review`）开始时（`done` 为 0），以及每评完一个条目时 | `seq`、`at`、`task_id`、`op_id`、`done`、`total`、`current`（此刻正在评的条目）、`item_id`（刚评完的条目，开始时为 null）、`completion` |
| `review_batch` | 一次评审（一个批次）结束时，不论是用户发起的还是助手经工具发起的；`no` 是第几次评审 | `seq`、`at`、`task_id`、`no`、`batch_id`、`started_by`（`user` 或 `executor`）、`scope`（`pending` 或 `named`）、`items`（`item_id`、`revision_no`）、`forced`（这次要求重评的条目）、`total`、`passed`、`failed`、`unfinished`、`problems`、`advice`、`completion` |
| `review_waived` | 用户保留了评审不合规的条目现在的写法 | `seq`、`at`、`task_id`、`items`（`item_id`、`revision_no`）、`reason`（可为 null）、`source`（`detail` 或 `panel`）、`op_id`、`completion` |
| `review_unwaived` | 用户撤销了保留 | `seq`、`at`、`task_id`、`items`、`op_id`、`completion` |
| `review_rules_changed` | 用户改了一个集合的评审规则开关 | `seq`、`at`、`task_id`、`collection`、`off`、`promote`、`op_id`，以及这个集合新的 `review_rules`、`all_rules`、`rule_switches`、`rules_hash`、`completion` |
| `review_finished` | 这批评审全部结束时 | `seq`、`at`、`task_id`、`op_id`、`total`、`passed`、`failed`、`unfinished`、`results`（`item_id`、`revision_no`、`status`）、`error`（中途出了意外时写原因，否则为 null）、`completion` |
| `item_viewed` | 用户打开了条目详情，或在请确认卡片上点了「这几条都看过了」；条目在那次修订上记为已读 | `seq`、`at`、`task_id`、`items`（`item_id`、`revision_no`）、`op_id`、`completion` |
| `confirmation_recorded` | 已读以外的确认标记：用户改了条目或把问题条目标为先不管（`basis` 为 `ui_edit`，随修订一起写），或撤回了确认（`basis` 为 `ui_click`，`accepted` 为假） | `seq`、`at`、`task_id`、`items`（`item_id`、`revision_no`、`accepted`）、`basis`、`op_id`、`completion` |
| `resync`（无 id） | 需要重放的事件太多 | `{"reason": "gap_too_large"}` |

### 3.2 对话事件与进度事件（无编号，不参与重放）

都带有 `session_id`。

| 事件 | 发生时机 | `data` |
|---|---|---|
| `work_started` | 智能体开始工作 | `work_id`、`at`、`triggered_by`（消息编号） |
| `step` | 一次工具调用（tool call）开始，以及本轮结束时补发的一行修正 | `work_id`、`step_key`、`text`、`in_progress`、`failed` |
| `user_message` | pi 接收了一条用户消息 | `message_id`（会话条目编号；极少数情况下来不及找到条目时为空）、`client_id`、`at`、`text`、`origin`（`typed`、`card_choice`、`ui_request`）、`card`、`queued` |
| `assistant_reply` | 智能体作出了回复 | `message_id`、`at`、`work_id`、`via_reply_tool`、`informs`、`act`、`text`、`degraded`（见第 5.3 节） |
| `ui_action_noted` | 一次直接操作完成 | `message_id`、`at`、`text`、`event_seq`、`op_id`、`revision_no`、`undoable`、`kind`（操作种类）、`review`（评审结束那一条才有：`total`、`passed`、`failed`、`unfinished`、`problems`、`advice`） |
| `material_added` | 上传了一份材料 | `at`、`path`、`bytes`、`modified_at` |
| `work_summary` | 一个工作单元结束后 | `work_id`、`at`、`seconds`、`step_count`、`stages`（每项带 `text`） |
| `work_ended` | 智能体这一轮工作稳定下来 | `work_id`、`at`、`seconds`、`step_count`、`outcome`（`replied`、`no_reply`、`stopped_by_user`、`failed`） |
| `problem` | 需要让用户知道的问题（见第 5.5 节） | `code`、`text`、`retry` |
| `executor_state` | 执行者的可用状态发生变化 | `state`（`not_started`、`starting`、`idle`、`working`、`exited`、`failed_to_start`）、`text`、`active_session` |
| `system_note` | 会话开始时的任务状态消息，或固定的兜底提示句 | `message_id`、`at`、`text`、`kind`（`task_status` 或 `reply_fallback`） |

## 4 读取

### 4.1 快照

`GET /api/v1/tasks/{task_id}/snapshot?session={session_id}` — 以这种方式打开一个会话，同时也会启动或恢复执行者。`seq` 与所有表都在同一个只读事务里读出。

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
            "completion": { … 见第 4.2 节 … },
            "items": [ { "item_id": "UC-001", "collection": "功能用例", "title": "…", "revision_no": 5, "revision_by": "user",
                         "revision_at": "…", "revisions": [2, 5], "fields": { … }, "sources": [ … ],
                         "reviews": [ { "revision_no": 5, "verdict": "不合规", "reason": "…", "at": "…", "batch_id": "ui-op-…", "rules_hash": "…", "forced": false,
                                        "findings": [ { "rule_id": "UC-R7", "level": "必选", "field": "基本流程", "index": 1,
                                                        "problem": "…", "suggestion": "…" } ] } ],
                         "confirmations": [ { "revision_no": 5, "accepted": true, "at": "…", "basis": "viewed" } ],
                         "waivers": [ { "revision_no": 5, "reason": "…", "source": "panel", "at": "…", "revoked": false } ],
                         "confirmation_stale": false, "viewed": true, "confirmation_basis": "viewed" } ],
            "review_batches": [ { "no": 1, "batch_id": "ui-op-…", "at": "…", "started_by": "user", "scope": "pending", "total": 16, "passed": 12, "failed": 4, … } ] },
  "materials": [ { "path": "inputs/requirements.md", "bytes": 1234, "modified_at": "…", "derived_from": null } ],   // derived_from 见第 5.1 节「材料」
  "conversation": { "messages": [ … 最近的 100 条，每条都带 "type" … ], "has_earlier": false, "earliest_id": "…" },
  "current_work": null }
```

`display` 是任务定义里这个集合可选的显示方式（没写时为 null）：`side_tab`、`group_field`、`leading_groups` 与 `note`，只影响显示。`needs_review` 表示完成条件是否要求这个集合「每个条目评审通过」；`review_rules` 是这个集合实际要评的规则清单（任务定义里关闭或升为必选之后的），没有写评审规矩的集合为 null。依据 `必选` 规则的发现是「问题」，有一条条目就不合规；依据 `可选` 规则的发现是「建议」，不影响结论。`all_rules` 列出规则文件里的全部规则与它在这个任务里的状态 `state`：`required`（必选）、`optional`（可选）、`off`（已关闭）、`promoted`（升为必选）。`rules_hash` 是规则指纹，由规则文件与这个任务的开关算出；评审记录只有 `rules_hash` 与集合的相同时才算数（早期版本的记录没有指纹，照旧算数），所以改了规则开关，这个集合的条目都回到待评审。`waivers` 是用户保留的写法；条目当前所在修订上一条没撤销（`revoked` 为假）的保留，让条目按用户的决定算通过。

确认标记（confirmation mark）。确认是挂在「条目加修订」上的标记，条目之后再被改动时它不随之移动。它的 `basis`（依据）有三种：`viewed`（已读：用户打开了条目详情，或在请确认卡片上点了「这几条都看过了」）、`ui_edit`（用户改了条目或把它标为先不管，改出来的内容算作已确认）、`ui_click`（撤回确认，`accepted` 为假；较早的库里还有在界面上点的确认）；较早的库里还可能有 `user_words`，那是早期版本由执行者按用户的话登记的确认。条目的 `viewed` 为真，表示它当前所在修订上最近一条标记是接受（任一依据），这时 `confirmation_basis` 写明依据；`viewed` 为假的条目就是**未读**。完成条件「每个条目用户确认」在集合里没有未读条目时满足。

任务被完成或放弃后，`task` 依旧会返回，消息与直接操作会返回 `task_closed`，文档仍可生成。客户端必须从 `definition` 中取得集合名、字段名与枚举值，绝不能写死在代码里。

### 4.2 完成条件（completion conditions）

```
"completion": { "all_met": false, "unmet_count": 2, "brief": "要完成任务，还差 2 项：……", "conditions": [
  { "collection": "功能用例", "name": "每个条目评审通过", "met": false, "state": "unmet", "done": 0, "total": 7,
    "missing": ["UC-001", …], "note": "…" } ],
  "hints": [ { "kind": "unlinked_domain_notes", "collection": "领域说明", "items": ["DN-001"],
    "summary": "有 1 条领域说明还没有和任何条目关联：DN-001。" } ] }
```

`hints`（提示）列出显示在完成条件旁边、但不挡完成任务的事实；没有时是空列表。目前只有一种 `unlinked_domain_notes`：没有还在的条目把它写成来源、也没有还在的条目在条目引用字段里写它、它自己的条目引用字段也没有指向还在的条目的领域说明。

每条完成条件处于三种状态之一。`met`：该集合有条目，且全部满足条件。`unmet`：有条目不满足，或者「至少一条」这类条件一条也没找到。`empty`：该集合没有条目，因此「每个条目都要满足」这类条件无从检查。`empty` 在判断任务是否可以完成时仍算满足（`met` 仍为 `true`，所以可选集合可以保持空），但绝不能把它当作进度展示：应当汇报还有多少条条件处于 `unmet`（`unmet_count`），而不是有多少条已满足。`brief` 是智能体自己看到的那句一句话摘要；到处都应沿用这句话或同样的措辞。

### 4.3 其他读取与任务管理

| 端点（endpoint） | 用途 | 返回 |
|---|---|---|
| `GET /api/v1/task-types` | 「新建任务」时用的任务类型列表 | `{ok, task_types: [{task_type, name}]}` |
| `GET /api/v1/tasks` | 任务列表 | `{ok, tasks: [{task_id, task_name, task_type, domain_tag, status, item_count, completion_met, completion_total, completion_unmet, last_active_at, session_count, supported}]}`（展示时用 `completion_unmet`，即「还差 N 项」）。修订取代条目版本之前创建的任务也会列出，`supported` 为 `false`，`status` 为「旧格式」，另带 `note`；它打不开。正被别的在跑的服务占用的任务也会列出，`supported` 为 `false`，`status` 为「占用中」，另带 `occupied`（`port`、`pid`、`host`）与 `note`；对它的一切请求都返回 `task_occupied`。 |
| `POST /api/v1/tasks` `{task_type, task_name, domain_tag}` | 创建任务 | `{ok, task_id}`；之后再上传材料 |
| `GET /api/v1/tasks/{task_id}` | 任务页（已关闭的任务同样可读） | 该任务，外加 `materials` 与 `sessions` |
| `GET …/sessions` | 会话列表 | `{ok, sessions: [{session_id, name, started_at, last_active_at, message_count, active}]}` |
| `POST …/sessions` | 新建会话 | `{ok, session_id}`；执行者在别的会话里工作时返回 `session_busy` |
| `GET …/items/{item_id}/revisions` | 条目在改动过它的每次修订下的内容 | `{ok, item_id, revisions: [{revision_no, by, at, fields, sources, reviews, confirmations}]}` |
| `GET …/revisions` | 修订日志 | `{ok, latest_revision, revisions: [{revision_no, at, by, session_id, work_id, op_id, undo_of_revision, trigger, intent, operations}]}`，最新的在前。`work_id` 是智能体的那次工作（用户的修订为空）；`op_id` 是用户的那次直接操作。`trigger` 写触发这次修订的事：智能体的修订是 `{kind: "typed" \| "card_choice" \| "ui_request", text, message_id}`，即启动那次工作的那句话；用户的修订是 `{kind: "user_action", action, text}`，`text` 是「你把 TBD-003 标为先不管」这样的一句操作名；都找不到时是 `{kind: "none"}`。`intent` 是触发智能体这次修订的那项用户行为：智能体对你那句话写下的理解里有与这次修订对得上的一项时给出，`{act_id, function, function_name, summary}`（`act_id` 如 r13-2，`function` 是理解格式里九种用户功能之一，`function_name` 是它的中文名，如「纠正」）；用户自己的修订、没有理解记录的任务为空。每个操作有 `op`、`item_id`、`collection`、`title`、`revision_before`、`revision_after` 和 `fields_changed`（与条目上一次改动相比值不同的字段名；新增、删除、恢复时为空）。 |
| `GET …/materials/content?path=…` | 某份材料的正文 | `{ok, path, text}`；路径必须落在材料目录内。`.docx` 返回的是生成的 Markdown 投影（见第 5.1 节「材料」）；0.2 建的任务只有旧的 `文件名.docx.txt` 时返回那份 |
| `GET …/materials/raw?path=…` | 材料文件的原样内容 | 文件的原始字节；`Content-Type` 按扩展名给：`.md` 为 `text/markdown; charset=utf-8`，`.txt` 为 `text/plain; charset=utf-8`，`.docx` 为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，其余为 `application/octet-stream`。路径限制与 `content` 相同；网页界面用它按原版式显示 Word 文件 |
| `GET …/conversation?session=…&before={message_id}&limit=100` | 更早的对话 | 形状与第 4.1 节 `conversation` 相同 |
| `POST …/documents/preview` 与 `…/download` `{"revision_no": N, "items": [编号…], "format": "markdown"}` | 按某一次修订（缺省为最新）渲染整份交付物，也可以只列出其中几个条目 | 预览：`{ok, text}`；下载：文件本身。文档写明它按哪次修订生成，并在每个条目上标出它的内容来自哪次修订、在那次修订上有没有确认与评审；确认写明依据：已读、用户修改或明确确认。修订号超过最新修订，或列出的条目在那次修订时不在交付物里，返回 `bad_request` |

## 5 对话

对话保存在 pi 的会话文件里；数据库不存对话内容。

### 5.1 用户说话

`POST …/messages?session={session_id}`，请求体为 `{"text": "…", "client_id": "…", "attachments": ["inputs/…"], "origin": "typed", "card": null}`。响应为 `{ok, client_id, queued}`，`queued` 恒为 `false`。对应的 `user_message` 事件带有相同的 `client_id`。智能体正在工作时，消息被拒绝，错误码 `session_busy`，`data.reason` 为 `working`；等这次工作结束后再发。以 `/` 开头的文本会在送到 pi 之前被加上「用户说：」前缀，因此永远不会被当成命令。

**材料。** `POST …/materials`（multipart，单文件）：接受 `.md`、`.txt` 与 Word 的 `.docx`，最大 5 MB，存入该任务的材料目录（重名文件会自动追加编号；带路径分隔符的文件名会被拒绝）。返回 `{ok, path}`。`.docx` 另在旁边生成一份给助手读的 Markdown 投影 `文件名.docx.md`，文件里的图片抽到 `文件名.docx.media/`。同时写一份分段清单 `文件名.docx.segments.json`：按启动配置「材料分段」一节的参数把投影按标题分块（`heading_depth` 是认到第几级标题；有文字的段少于 `min_paragraphs` 的块并入下一块，多于 `max_paragraphs` 的块按段数切开），每块记标题、起止段落号、在投影里的起止行号、有文字的段数与字数。文件里记着参数的摘要，参数改了之后，下次读到时重算并覆盖。段落按 `word/document.xml` 正文计数，表格与嵌套表格里的段落都数，文本框里的不数；页眉页脚、脚注尾注、批注不数。投影里每段一行，段落号写成 `[pN]`，放在这一段的正文前面；标题按大纲级别以 `#` 到 `######` 开头，Word 自动编号写在段落号前面，不算正文；列表项以 `- ` 开头，编号是 `1.` 这种形式时直接以编号开头；表格写成 Markdown 表格，Word 的一行写一行、第一行当表头，一格里的几段用 `<br>` 隔开，横向合并跨过的格子写 `（同左）`，纵向合并续格写 `（同上）`，嵌在格里的小表格的各段写进外层格子，前面注明 `（小表第 r 行第 c 列）`；图片写成链接 `![图 k](文件名.docx.media/imageN.png)`，放在它所在的段落里；Word 图表与 SmartArt 写一行说明没有转出；文本框里的字写成引用块（`> （文本框）……`），没有段落号；空段落不写，段落号照数。开头的注释写明段落总数与引用的写法。投影由 `agent/src/cli/docx_projection.mts` 生成，服务起 Node 子进程运行它。材料清单列出 `.docx`、`.md` 与 `.segments.json`；每一项带 `derived_from`：Word 文件旁边的投影与分段清单（`.md`、`.segments.json`，或 0.2 的 `.txt`）写那份 `.docx` 的路径，其余文件为 `null`，网页界面不列出带它的项。清单只列文件，所以不含图片目录。读不出来的 `.docx` 返回 `unsupported_type`，什么都不留下；以 `.docx.md` 或 `.docx.txt` 结尾的文件名返回 `bad_request`。消息的 `attachments` 里有 `.docx` 时，发给助手的文字会说明去读它旁边的 `.md`。0.2 建的任务保留原来的 `文件名.docx.txt`（每段一行，行首是 `[第 N 段]` 或 `[第 N 段 · 表 t 行 r 列 c]`）；Word 文件旁边没有 `.md` 时，助手、摘录核对与网页界面改读这份文件，分段清单按它现算、不写文件。

### 5.2 智能体回复

只有智能体调用 `reply` 工具且被接受的那次调用，才会成为带 `via_reply_tool: true` 的 `assistant_reply` 事件。如果一个工作单元结束时没有一次被接受的回复，服务器会转发最后一段助手文本，带 `via_reply_tool: false` 且不带 `act`；如果连这个也没有，就发送代码为 `no_reply` 的 `problem`。

### 5.3 回复的结构

```
"informs": [ { "text": "…", "items": [ { "item_id": "UC-004", "revision_no": 2 } ] } ],   // 事实性陈述：智能体刚做了什么或发现了什么；items 可选，点名这条告知说到的条目，每个条目写它当前所在的修订
"act": null | {
  "kind": "ask" | "confirm" | "suggest" | "choose" | "propose",
  "text": "…",
  "items": [ { "item_id": "TBD-001", "revision_no": 3 } ],  // confirm、ask、suggest、propose 必填；每个条目只能写它当前所在的修订
  "scope": "general",                                       // 仅 ask/suggest/propose：不针对任何条目时用（此时不填 items）
  "options": [ { "key": "a", "text": "…" } ],               // 仅 choose
  "value": "…", "basis": [ { "kind": "文档原文", "locator": "…", "excerpt": "…" } ],   // 仅 suggest；每条依据与 save_revision 的来源同一套逐字核对，用户的话的出处是工具填写的
  "preview": [ { "effect": "remove" | "add" | "change", "text": "…" } ]           // 仅 propose
},
"text": "…"                      // 以自然语言呈现的回复正文
```

只有智能体在等用户的一个具体回应时才带 `act`；回答用户的问题、汇报做了什么，`act` 为 `null`。告知从不画成卡片：它点名的条目画成条目链接（有 `act` 时跟在那条告知后面；没有 `act` 时在正文下方列一行「提到的条目」，同一个条目只列一次）。告知能点名条目之前录下的会话里，告知是纯文字；服务器一律整理成对象再发出。`degraded: true` 表示：多次被拒绝后放行的一条纯文本回复；展示时应当作纯文本处理，附一行提示，不带卡片。回复以受限的 Markdown 渲染（段落、列表、加粗、行内代码）。

### 5.4 卡片按钮

结果必须写入数据库的按钮走 `/actions`（见第 6 节）；需要智能体进一步处理的按钮走 `/messages`，带 `origin: "card_choice"` 与 `card: {reply_message_id, kind, choice}`，用第 7 节里的固定句式。

| 卡片 | 按钮 | 走向 |
|---|---|---|
| confirm（确认） | 这几条都看过了 | `/actions`，kind 为 `mark_viewed`，目标取自卡片的 items，`notify_executor: true` |
| confirm（确认） | 不对 | `/messages` |
| choose（选择） | 某个选项 | `/messages` |
| suggest（建议） | 采纳 / 换一个 | `/messages` |
| propose（提议） | 就这样做 / 不要 | `/messages` |
| ask（针对某个问题条目） | 先不管 | `/actions`，kind 为 `keep_pending`，`notify_executor: true` |
| ask（针对条目） | 我不知道，你按常识补 | `/messages` |

### 5.5 智能体工作期间

新的说话与直接操作都会被拒绝，错误码 `session_busy`（见第 5.1 节）；唯一的例外是不带 `notify_executor` 的 `mark_viewed`（打开条目详情），它不改交付物，执行者工作中照样接受。`POST …/control?session=…`，请求体为 `{"action": "stop"}`，会中止本次工作；已经保存的写入不受影响。模型服务不可用时，pi 会重试，服务器发送代码为 `model_unavailable` 的 `problem`。

### 5.6 谁来启动智能体

打开一个会话（带 `session` 的一次快照请求）会为该任务启动 pi，或者把它切换到这个会话。一个任务同一时刻只有一个活跃会话：智能体在会话 A 里工作时，会话 B 的消息与操作请求返回 `session_busy`。启动过程中，请求返回 `executor_starting`（稍等后重试一次）；如果 pi 启动失败或已退出，返回 `executor_unavailable`。直接操作是在 pi 内部执行的，所以 pi 不在运行时它们同样会失败。

## 6 直接操作

`POST …/actions?session={session_id}`：

```
{ "client_id": "…", "kind": "edit_fields" | "delete_item" | "mark_viewed" | "unconfirm" | "keep_pending" | "undo" | "request_review" | "waive_review" | "unwaive_review" | "set_review_rules",
  "targets": [ { "item_id": "UC-002", "base_revision": 3 } ],  // 打开这个条目时它所在的修订号；undo 时用 "revision_no"
  "fields": { "基本流程": ["…", "…"] },                          // 仅 edit_fields：给出完整的新值
  "notify_executor": false,
  "force": false }                                               // 仅 request_review
```

响应为 `{ok, client_id, op_id}`；处理结果以带同一个 `op_id` 的事件形式到达。规则如下。

1. 每个 `base_revision` 都必须是该条目当前所在的修订，否则整批请求都会被拒绝，错误码为 `stale_revision`，并列出每个过期条目、它现在所在的修订以及是谁改的。
2. 撤销修订 N 会产生一次新修订 M，把修订 N 涉及的每个条目都还原到修改前的状态（新增用删除来撤销，删除用恢复来撤销），并记录 `undo_of_revision`；如果某个条目在那之后又被改动过，这次撤销会被拒绝，错误码为 `undo_conflict`。
3. `mark_viewed` 把每个目标在 `base_revision` 上记为已读。它是幂等的：条目在那次修订上最近一条标记已经是接受的就跳过，全部跳过时什么都不写、也不发事件。不带 `notify_executor` 时（界面在用户打开条目详情时这样发）不往会话里追加任何东西；带上时（请确认卡片上的「这几条都看过了」）追加一条界面操作说明，并发出第 7 节的固定句式。评审未通过的条目仍然可以记为已读。
4. `unconfirm` 撤回每个目标在 `base_revision` 上的确认：记一条 `accepted` 为假的标记，条目回到未读。
5. `edit_fields` 与 `keep_pending` 在产生修订的同一个事务里，为这次修订同时记一条确认标记（依据 `ui_edit`）。
6. `request_review` 请评审者评审每个目标在 `base_revision` 上的内容；`targets` 为空列表时评全部待评审的条目（所在集合要求评审、当前所在的修订还没有评审记录的条目）。核对通过就立即响应，评审在后台进行，每个条目各发一条 `review_progress`，以及 `review_recorded` 或 `review_unfinished`，全部结束时发 `review_finished`，都带同一个 `op_id`。「待评审」指条目当前所在的修订在集合当前的 `rules_hash` 下还没有评审记录。点名的目标已经有这样的记录时，不带 `"force": true` 就拒绝，说明写「这条在当前修订上已经评过（第 N 次评审），内容和规则都没变」；带了就再评一次，这条记录标 `forced`。上一批评审还在进行、没有要评的条目、目标所在集合不要求评审、目标不在它当前所在的修订时也拒绝（`rejected`）。每一批评审结束时发一条 `review_batch`。这里发起的评审结束后，往会话里追加一条界面操作说明，只写一句计数（`kind` 为 `request_review`，`review` 带计数），逐条发现不在里面，智能体经 `get_task_status` 去取。不引出智能体的运行。客户端对它不显示「正在保存」。
7. `waive_review` 保留每个目标在 `base_revision`、当前规则下评审不合规的写法；`fields` 可以带 `reason`（理由）与 `source`（`detail` 或 `panel`）。这条按用户的决定算通过；条目再改动，评审要重做。`unwaive_review` 撤销保留。没有可保留或可撤销的时拒绝。两种都只有用户能做，智能体没有对应的工具。
8. `set_review_rules` 设定一个集合哪些可选规则关闭、哪些升为必选：`targets` 为空列表，`fields` 写 `{ "collection": 集合名, "off": [规则编号…], "promote": [规则编号…] }`。它同时改任务目录里的任务定义副本与库里的快照；关必选规则、写了不存在的编号、集合没有评审规则、与现在一样时拒绝。已有评审记录不变；规则指纹变了，这个集合的条目都回到待评审。
9. 对已关闭的任务，任何操作都返回 `task_closed`。
10. 智能体工作期间，任何操作都返回 `session_busy`，`data.reason` 为 `working`；不带 `notify_executor` 的 `mark_viewed` 除外。

## 7 发送给智能体的固定句式

| 情形 | 句子 |
|---|---|
| 用户文本以 `/` 开头 | `用户说：{text}` |
| 带附件的消息 | `{text}\n（我上传了材料：{path1}、{path2}）` |
| 选了某个选项 | `我选：{option text}` |
| 在确认卡片上点「不对」 | `这个不对。`（或用户自己写的话） |
| 采纳 / 换一个建议 | `我采纳这个建议。` / `请换一个建议。` |
| 接受 / 拒绝一个提议 | `就这样做。` / `不要这样做。` |
| 在请确认卡片上点「这几条都看过了」之后（`notify_executor`） | `我已经看过了：{item（修订 N）, …}。请接着往下做。` |
| 「先不管」之后 | `我先不管 {item id}，请接着往下做。` |
| 在 ask 卡片上选「我不知道」 | `关于 {item ids}，我不知道，你按常识补上并标明是你补的。` |

直接操作还会在会话里追加一条标记为界面操作的消息，例如 `界面操作（不是用户打的字）：用户改了 UC-002 的「基本流程」，产生修订 5，UC-002 现在是修订 5。`

## 8 错误

结构：`{ "ok": false, "error": { "code": "…", "message": "…", "data": { … } } }`

| code | HTTP 状态码 | 含义 |
|---|---|---|
| `bad_request` | 400 | 请求格式错误，或路径落在材料目录之外 |
| `not_found` | 404 | 任务、会话、条目、材料或端点不存在 |
| `rejected` | 422 | 校验未通过；`data.reasons` 列出每一条原因 |
| `stale_revision` | 409 | 修订检查未通过；`data.items` 为 `[{item_id, base_revision, current_revision, changed_by}]` |
| `old_format` | 409 | 修订取代条目版本之前创建的任务，本版本不支持（任务列表里这类任务的 `supported` 为 `false`） |
| `undo_conflict` | 409 | 被撤销的那次修订之后，该条目又被改动过 |
| `task_closed` | 409 | 任务已完成或已放弃 |
| `session_busy` | 409 | 执行者正在工作：在另一个会话里（`data.active_session`），或者就在这个会话里而这时又来了说话或直接操作（`data.reason` 为 `working`） |
| `task_occupied` | 409 | 这个任务正被另一个在跑的服务占用（它的 `service.lock` 记着一个活着的进程）；`data` 里有那个服务的 `port`、`pid`、`host` |
| `forbidden` | 403 | 只接受本机请求的接口收到了从别处来的请求（目前只有 `POST /api/v1/service/exit`，见第 9 节） |
| `executor_starting` | 503 | pi 正在启动 |
| `executor_unavailable` | 503 | pi 启动失败或已退出（`data.detail`） |
| `busy_timeout` | 503 | 等待数据库写锁超时 |
| `too_large`、`unsupported_type` | 413、415 | 附件过大，或类型不受支持 |

## 9 其他约定

1. 取决于任务定义的文本（集合名、字段名与类型、枚举值、完成条件的名称）一律以接口返回的数据为准。
2. 可能有多个页面同时在看同一个任务；后到的那次保存有可能因为条目所在的修订已经过期而被拒绝。
3. 路径带着版本号 `v1`；字段只会新增，含义不会改变；客户端应忽略未知的事件与字段。
4. 本版本尚不支持：多用户并发、身份认证、流式回复文本。
5. **服务信息与运行形态。** 下面两个接口不需要任务，由 TypeScript 版任务服务（`backend/`）提供，Python 版任务服务没有。
   - `GET /api/v1/service` 返回 `{ "ok": true, "app": "taskwright", "version": …, "mode": "desktop" | "server", "pid": …, "port": …, "capabilities": { "exit": true | false } }`，其中 `port` 是服务实际监听的端口。它有三种用途：打包后的启动程序用它认出某个端口上跑的是不是自己；部署与监控用它探活；客户端按 `capabilities` 决定显示还是隐藏相应的按钮。
   - `POST /api/v1/service/exit` 只在以 `--mode desktop` 启动时存在，以 `--mode server` 启动时返回 `not_found`。它只接受来自本机回环地址（`127.0.0.1` 或 `::1`；`::ffff:127.0.0.1` 是 IPv4 回环地址在 IPv6 套接字上的写法，也算本机）的请求，其他来源一律返回 `forbidden`（403）。它先回答 `{ "ok": true }`，再照收到 SIGTERM 时的做法收尾：停止接收新连接、关掉各任务的 pi、删掉本服务写的占用标记，然后退出进程。它只供 0.3 的过渡安装包使用（这种包由服务自己打开浏览器，没有桌面外壳）；最终的桌面版由外壳停止服务，这个接口不承诺长期保留。
   - 运行形态（`--mode desktop|server`，缺省 `server`）决定默认绑定地址（`desktop` 为 `127.0.0.1`，`server` 为 `0.0.0.0`，两种形态下 `--host` 都优先）以及退出接口是否存在；其余行为两种形态完全相同。运行形态会写进启动日志和各任务的占用标记（`service.lock` 里的 `mode` 一项）。
