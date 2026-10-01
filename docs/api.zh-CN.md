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

`GET /api/v1/tasks/{task_id}/events?session={session_id}` — 一条 SSE 流。每条消息由一行 `event:` 和一行 `data:`（JSON）组成。**只有数据库事件带 `id:` 行**，其值等于事件序号。服务器每 15 秒发一次保活注释；客户端应在静默 45 秒后重连，并忽略未知的事件类型与字段。不带 `session` 时收到整个任务的事件；任务页用这种连接只听 `executor_state`，在助手做完一轮时重读任务。建立事件流不会启动执行者。

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

来源（source）的种类：`文档原文`（材料里的逐字引用）、`用户的话`（用户在对话里说的话）、`执行者补充`（由智能体（agent）添加，并附上理由）、`领域说明`（同一个任务里的一条领域说明；locator 是它的条目编号，例如 `DN-002`，excerpt 是所依据的那一句）。早期版本还写过一种 `用户直接修改`（在界面里的一次直接编辑，locator 是操作编号）：现在不再写，旧记录留在库里，但接口读出的任务数据里不再包含它。集合（collection）名与字段名由任务定义（task definition）给出。

| 事件 | 发生时机 | `data` |
|---|---|---|
| `task_changed` | 任务被创建、完成或放弃时 | `seq`、`at`、`task_id`、`task_name`、`status_before`、`status_after`、`actor`、`completion` |
| `review_recorded` | 评审者（reviewer）评完一个条目时；`verdict` 为 `合规` 或 `不合规`，由代码按发现所依据规则的级别算出 | `seq`、`at`、`task_id`、`item_id`、`revision_no`、`verdict`、`reason`、`findings`（每条有 `rule_id`、`level`（`必选` 或 `可选`）、`field`、`index`（从 0 起，指整个字段时为 null）、`problem`、`suggestion`）、`op_id`（用户在界面上发起的评审才有）、`completion` |
| `review_unfinished` | 一个条目的评审没有完成（超时、调用失败、两次输出不合格、评审期间条目被改），不记合规与否 | `seq`、`at`、`task_id`、`item_id`、`revision_no`、`reason`、`op_id`、`completion` |
| `review_progress` | 界面发起的一批评审（`request_review`）开始时（`done` 为 0），以及每评完一个条目时 | `seq`、`at`、`task_id`、`op_id`、`done`、`total`、`current`（此刻正在评的条目）、`item_id`（刚评完的条目，开始时为 null）、`completion` |
| `review_batch` | 一次评审（一个批次）结束时，不论是用户发起的还是助手经工具发起的；`no` 是第几次评审 | `seq`、`at`、`task_id`、`no`、`batch_id`、`started_by`（`user` 或 `executor`）、`scope`（`pending` 或 `named`）、`items`（`item_id`、`revision_no`）、`forced`（早先版本经「仍要重评」再评的条目；现在的评审恒为空）、`total`、`passed`、`failed`、`unfinished`、`problems`、`advice`、`completion` |
| `review_waived` | 用户保留了评审不合规的条目现在的写法 | `seq`、`at`、`task_id`、`items`（`item_id`、`revision_no`）、`reason`（可为 null）、`source`（`detail` 或 `panel`）、`op_id`、`completion` |
| `review_unwaived` | 用户撤销了保留 | `seq`、`at`、`task_id`、`items`、`op_id`、`completion` |
| `review_rules_changed` | 用户改了一个集合的评审规则开关 | `seq`、`at`、`task_id`、`collection`、`off`、`promote`、`op_id`，以及这个集合新的 `review_rules`、`all_rules`、`rule_switches`、`rules_hash`、`completion` |
| `review_finished` | 这批评审全部结束时 | `seq`、`at`、`task_id`、`op_id`、`total`、`passed`、`failed`、`unfinished`、`results`（`item_id`、`revision_no`、`status`）、`error`（中途出了意外时写原因，否则为 null）、`completion` |
| `item_viewed` | 用户打开了条目详情，或在请确认卡片上点了「这几条都看过了」；条目在那次修订上记为已读 | `seq`、`at`、`task_id`、`items`（`item_id`、`revision_no`）、`op_id`、`completion` |
| `confirmation_recorded` | 已读以外的确认标记：用户改了条目或把问题条目标为先不管（`basis` 为 `ui_edit`，随修订一起写），或撤回了确认（`basis` 为 `ui_click`，`accepted` 为假） | `seq`、`at`、`task_id`、`items`（`item_id`、`revision_no`、`accepted`）、`basis`、`op_id`、`completion` |
| `resync`（无 id） | 需要重放的事件太多 | `{"reason": "gap_too_large"}` |

数据库事件的序号可能跳号：任务库里有几种记录不推送。它们是助手对用户一句话的理解（`USER_INTENT_RECORDED`，以及理解没有写成的三种情形 `USER_INTENT_INVALID`、`USER_INTENT_MISSING`、`STRUCTURED_OUTPUT_UNMATCHED`）与助手回复时记下的行为（`EXECUTOR_ACTS_RECORDED`）。前几种的内容由后端合成「理解为」那一行，随 `step` 与 `work_summary` 送到页面；回复的内容由 `assistant_reply` 送到页面。页面见到跳号时重读一份快照。

### 3.2 对话事件与进度事件（无编号，不参与重放）

除 `service_exiting` 外都带有 `session_id`；`service_exiting` 发给每个任务的每一条打开着的事件流。

| 事件 | 发生时机 | `data` |
|---|---|---|
| `work_started` | 智能体开始工作 | `work_id`、`at`、`triggered_by`（消息编号） |
| `step` | 一次工具调用（tool call）开始，以及本轮结束时补发的一行修正 | `work_id`、`step_key`、`text`、`in_progress`、`failed` |
| `user_message` | pi 接收了一条用户消息 | `message_id`（会话条目编号；极少数情况下来不及找到条目时为空）、`client_id`、`at`、`text`、`origin`（`typed`、`card_choice`、`ui_request`）、`card`、`queued` |
| `assistant_reply` | 智能体作出了回复 | `message_id`、`at`、`work_id`、`via_reply_tool`、`informs`、`act`、`text`、`degraded`（见第 5.3 节） |
| `ui_action_noted` | 一次直接操作完成 | `message_id`、`at`、`text`、`event_seq`、`op_id`、`revision_no`、`undoable`、`kind`（操作种类）、`review`（评审结束那一条才有：`total`、`passed`、`failed`、`unfinished`、`problems`、`advice`） |
| `material_added` | 上传了一份材料 | `at`、`path`、`bytes`、`modified_at` |
| `work_summary` | 一个工作单元结束后 | `work_id`、`at`、`seconds`、`step_count`、`stages`（每项带 `text`）、`outcome`（这个工作单元怎样结束，取值与 `work_ended` 相同；刷新后读到的对话里的 `work_summary` 消息带同样的值） |
| `work_ended` | 智能体这一轮工作稳定下来 | `work_id`、`at`、`seconds`、`step_count`（与 `work_summary` 的相同，由会话记录算出，被停下时一条消息里没有开始执行的工具调用也算在内；会话记录读不出这次工作时用本轮记下的计数）、`outcome`（`replied`、`no_reply`、`stopped_by_user`、`failed`；按这个工作单元最后一条助手消息判断，所以调用模型出错、随后自动重试成功的工作单元是 `replied` 或 `no_reply`，不是 `failed`） |
| `problem` | 需要让用户知道的问题（见第 5.5 节） | `code`、`text`、`retry` |
| `executor_state` | 执行者的可用状态发生变化 | `state`（`not_started`、`starting`、`idle`、`working`、`exited`、`failed_to_start`）、`text`、`active_session`；续接失败（`session_resume_failed`）之后 `state` 为 `not_started`，`text` 写明助手没有接上这条会话 |
| `system_note` | 会话开始时的任务状态消息，或固定的兜底提示句 | `message_id`、`at`、`text`、`kind`（`task_status` 或 `reply_fallback`）；任务状态消息的 `text` 是页面上的写法：开头是「这条会话开始时（时刻）的任务状况：」或「接着这条会话继续时（时刻），上次之后交付物的变化：」，只写给助手看的那一行（还在等回应的助手行为）不带；助手看到的原文不变，刷新之后从对话记录读回的也是页面上的写法 |
| `service_exiting` | 服务即将停止：页面上请求退出、收到 SIGINT 或 SIGTERM、收到 SIGHUP（Windows 另有 SIGBREAK）；在关掉各任务的 pi、结束事件流之前发出 | `mode`（`desktop` 或 `server`）、`at`。页面收到后应显示服务已经停止，并且不再重连。 |

## 4 读取

### 4.1 快照

`GET /api/v1/tasks/{task_id}/snapshot?session={session_id}` — 以这种方式打开一个会话，同时也会启动或恢复执行者。`seq` 与所有表都在同一个只读事务里读出。执行者启动不起来时，快照照常返回：对话记录从会话文件读取，条目从任务库读取，`executor.state` 为 `failed_to_start`，`executor.text` 写明原因，写法与 `executor_state` 事件相同。每次带 `session` 的快照请求都会再试着启动一次，所以问题修好之后刷新页面即可恢复。

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
                         "reviews": [ { "revision_no": 5, "verdict": "不合规", "reason": "…", "at": "…", "batch_id": "ui-op-…", "rules_hash": "…", "forced": false, "seq": 41,
                                        "findings": [ { "rule_id": "UC-R7", "level": "必选", "field": "基本流程", "index": 1,
                                                        "problem": "…", "suggestion": "…" } ] } ],
                         "confirmations": [ { "revision_no": 5, "accepted": true, "at": "…", "basis": "viewed" } ],
                         "waivers": [ { "revision_no": 5, "reason": "…", "source": "panel", "at": "…", "revoked": false, "seq": 44 } ],
                         "confirmation_stale": false, "viewed": true, "confirmation_basis": "viewed" } ],
            "review_batches": [ { "no": 1, "batch_id": "ui-op-…", "at": "…", "started_by": "user", "scope": "pending", "total": 16, "passed": 12, "failed": 4, … } ] },
  "materials": [ { "path": "inputs/requirements.md", "bytes": 1234, "modified_at": "…", "derived_from": null } ],   // derived_from 见第 5.1 节「材料」
  "conversation": { "messages": [ … 最近的 100 条，每条都带 "type" … ], "has_earlier": false, "earliest_id": "…" },
  "current_work": null,
  "review_in_progress": null }         // 或 { "op_id": "ui-op-…", "done": 1, "total": 4, "current": ["UC-002"] }
```

`review_in_progress` 是正在进行的一批界面发起的评审，形状与 `review_progress` 事件里的 `op_id`、`done`、`total`、`current` 相同，取自任务库里最后一条评审进度。这一批已经结束、助手现在没有在运行、或者这条进度写于助手这一次启动之前（助手在评审中途退出过）时为 null。页面据此在刷新之后立刻显示「评审中」；为 null 而页面上还有没结束的评审时，页面把它清掉。

`display` 是任务定义里这个集合可选的显示方式（没写时为 null）：`side_tab`、`group_field`、`leading_groups` 与 `note`，只影响显示。`needs_review` 表示完成条件是否要求这个集合「每个条目评审通过」；`review_rules` 是这个集合实际要评的规则清单（任务定义里关闭或升为必选之后的），没有写评审规矩的集合为 null。依据 `必选` 规则的发现是「问题」，有一条条目就不合规；依据 `可选` 规则的发现是「建议」，不影响结论。`all_rules` 列出规则文件里的全部规则与它在这个任务里的状态 `state`：`required`（必选）、`optional`（可选）、`off`（已关闭）、`promoted`（升为必选）。`rules_hash` 是规则指纹，由规则文件与这个任务的开关算出；评审记录只有 `rules_hash` 与集合的相同时才算数（早期版本的记录没有指纹，照旧算数），所以改了规则开关，这个集合的条目都回到待评审。`waivers` 是用户保留的写法。评审记录与保留记录都带 `seq`，即记下它的那条事件的序号。条目在当前所在修订上的评审结论取这个修订上、在当前 `rules_hash` 下算数的最后一条评审记录（按 `seq`）：合规是通过；不合规是不通过，除非这个修订上有一条没撤销（`revoked` 为假）、`seq` 比它大的保留，那样条目按用户的决定算通过。没有这样的评审记录时条目待评审。`forced` 为真的是早先版本经「仍要重评」写下的记录，读的时候与别的记录同样对待。

确认标记（confirmation mark）。确认是挂在「条目加修订」上的标记，条目之后再被改动时它不随之移动。它的 `basis`（依据）有三种：`viewed`（已读：用户打开了条目详情，或在请确认卡片上点了「这几条都看过了」）、`ui_edit`（用户改了条目或把它标为先不管，改出来的内容算作已确认）、`ui_click`（早先版本的撤回确认，`accepted` 为假，接口已经不再接受这个操作，库里已有的照常读；较早的库里还有在界面上点的确认）；较早的库里还可能有 `user_words`，那是早期版本由执行者按用户的话登记的确认。条目的 `viewed` 为真，表示它在任何一次修订上有过一条接受的标记（任一依据），这时 `confirmation_basis` 写明依据：它当前所在修订上最近一条标记是接受时取那一条的依据，否则取最近一条接受的标记的依据；`viewed` 为假的条目就是**未读**。已读是按条目算的、只进不退：条目之后被改，或者库里有早先版本留下的撤回确认，都不会变回未读。`confirmation_stale` 为真，表示条目有过接受的标记，但它当前所在修订上最近一条标记不是接受（看过之后又被改过，或者确认被撤回了）。完成条件「每个条目用户确认」在集合里没有未读条目时满足。

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

**材料。** `POST …/materials`（multipart，单文件）：接受 `.md`、`.txt` 与 Word 的 `.docx`，最大 5 MB，存入该任务的材料目录（带路径分隔符的文件名会被拒绝）。返回 `{ok, path}`。上传的内容与本任务已有的某份材料的字节完全相同时（不论文件名），拒绝并且什么都不保存（`duplicate_content`，409）；文件名与已有的某份材料相同而内容不同时，同样拒绝（`name_taken`，409）。两种拒绝的 `data.path` 都是已有的那份材料，说明里写出它的文件名。只与用户放进来的材料比较，Word 文件旁边的投影与分段清单（带 `derived_from` 的项）不参与。内容按原始字节的 SHA-256 比较，每次上传时现算，不保存。判断两个文件名是否相同时，两边都去掉首尾空白、统一成 Unicode 规范化的 NFC 形式、不区分大小写；只差全角半角的（例如全角括号与半角括号）算不同的名字。这条规则只用来判断是否同名，文件照上传时的名字保存。检查的先后是类型、保留的文件名、大小、内容、文件名；内容与文件名都相同时回 `duplicate_content`。以前重名的文件会存成「原名-2.扩展名」，现在不再这样。`.docx` 另在旁边生成一份给助手读的 Markdown 投影 `文件名.docx.md`，文件里的图片抽到 `文件名.docx.media/`。同时写一份分段清单 `文件名.docx.segments.json`：按启动配置「材料分段」一节的参数把投影按标题分块（`heading_depth` 是认到第几级标题；有文字的段少于 `min_paragraphs` 的块并入下一块，多于 `max_paragraphs` 的块按段数切开），每块记标题、起止段落号、在投影里的起止行号、有文字的段数与字数。文件里记着参数的摘要，参数改了之后，下次读到时重算并覆盖。同时写一份位置表 `文件名.docx.locations.json`：文件头（格式版本 `version`、位置规则的版本 `rules_version`、`source`、段落总数 `paragraphs`、分页标记 `w:lastRenderedPageBreak` 的个数 `page_marks`，以及 `application`：`docProps/app.xml` 里记的保存文件的软件，没记时为空）与 `headings`：每个标题段一项，写段落号 `paragraph`、级别 `level`（1 是一级）与标题文字 `title`，`title` 与投影里这一段的标题行相同：自动编号（任何格式）加标题文字。标题段就是投影写成标题行的那些段落，所以表格里的段落不在其中。被引用的一段的章节是它（含）之前最近的标题；网页界面的来源标签从这里取章节，读不到位置表时不写章节。规则在 `agent/src/lib/docx_locations.ts`；位置表不记别的段落的文字，在它出现之前上传的 Word 文件没有位置表。段落按 `word/document.xml` 正文计数，表格与嵌套表格里的段落都数，文本框里的不数；页眉页脚、脚注尾注、批注不数。投影里每段一行，段落号写成 `[pN]`，放在这一段的正文前面；标题以 `#` 到 `######` 开头，级别先看段落自身的大纲级别，没写时看样式的大纲级别（沿样式继承往上找），再没有时看样式名「heading N」「标题 N」（大纲级别写成 9 表示正文，不是标题），Word 自动编号写在段落号前面，不算正文；列表项以 `- ` 开头，编号是 `1.` 这种形式时直接以编号开头；表格写成 Markdown 表格，Word 的一行写一行、第一行当表头，一格里的几段用 `<br>` 隔开，横向合并跨过的格子写 `（同左）`，纵向合并续格写 `（同上）`，嵌在格里的小表格的各段写进外层格子，前面注明 `（小表第 r 行第 c 列）`；图片写成链接 `![图 k](文件名.docx.media/imageN.png)`，放在它所在的段落里，标题里的图片除外：它另起一行写在标题行下面，不算标题文字；Word 图表与 SmartArt 写一行说明没有转出；文本框里的字写成引用块（`> （文本框）……`），没有段落号；空段落不写，段落号照数。公式里的字只取文字、按原顺序写进段落，不还原公式的排版（分式 a/b 写成 `ab`）。开头的注释写明段落总数与引用的写法。投影由 `agent/src/cli/docx_projection.mts` 生成，服务起 Node 子进程运行它。材料清单列出 `.docx`、`.md`、`.segments.json` 与 `.locations.json`；每一项带 `derived_from`：Word 文件旁边的投影、分段清单与位置表（`.md`、`.segments.json`、`.locations.json`，或 0.2 的 `.txt`）写那份 `.docx` 的路径，其余文件为 `null`，网页界面不列出带它的项。清单只列文件，所以不含图片目录。读不出来的 `.docx` 返回 `unsupported_type`，什么都不留下；以 `.docx.md` 或 `.docx.txt` 结尾的文件名返回 `bad_request`。消息的 `attachments` 里有 `.docx` 时，发给助手的文字会说明去读它旁边的 `.md`。0.2 建的任务保留原来的 `文件名.docx.txt`（每段一行，行首是 `[第 N 段]` 或 `[第 N 段 · 表 t 行 r 列 c]`）；Word 文件旁边没有 `.md` 时，助手、摘录核对与网页界面改读这份文件，分段清单按它现算、不写文件。

### 5.2 智能体回复

只有智能体调用 `reply` 工具且被接受的那次调用，才会成为带 `via_reply_tool: true` 的 `assistant_reply` 事件。如果一个工作单元结束时没有一次被接受的回复，服务器会转发最后一段助手文本，带 `via_reply_tool: false` 且不带 `act`；如果连这个也没有，就发送代码为 `no_reply` 的 `problem`。工作单元因为出错而结束时，改发代码为 `failed` 的 `problem`，文字是「助手这一轮因为出错停下了，你可以再说一句，让它接着做。」。用户让它停下时，两种都不发。被停下或出错结束的工作单元即使没有步骤、也没有回复，也保留它的 `work_summary`，刷新之后也在。

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

问这个任务是否已经完成的请选择卡片，有一项的 `key` 是 `complete`（文字「已完成，提交交付物」），另一项的文字是「还没完成，继续修改」。智能体的 `complete_task` 只在最近一次对这种卡片的点击点的是 `complete`、而且点了之后交付物没有新的修订时才成功；打字发来的消息不算。

### 5.5 智能体工作期间

新的说话与直接操作都会被拒绝，错误码 `session_busy`（见第 5.1 节）；唯一的例外是不带 `notify_executor` 的 `mark_viewed`（打开条目详情），它不改交付物，执行者工作中照样接受。`POST …/control?session=…`，请求体为 `{"action": "stop"}`，会中止本次工作；已经保存的写入不受影响。返回 `{"ok": true, "cleared": […]}`：`cleared` 是随之清掉的、还排着队没交给智能体的话；对话严格轮替之后，智能体工作期间不再接受新的话，所以它总是空列表。模型服务不可用时，pi 会重试，服务器发送代码为 `model_unavailable` 的 `problem`。

### 5.6 谁来启动智能体

打开一个会话（带 `session` 的一次快照请求）会为该任务启动 pi，或者把它切换到这个会话。一个任务同一时刻只有一个活跃会话：智能体在会话 A 里工作时，会话 B 的消息与操作请求返回 `session_busy`。启动过程中，请求返回 `executor_starting`（稍等后重试一次）。说话、卡片点击与直接操作带着会话来时，如果 pi 不在运行（还没启动、已经退出、续接失败后被停掉），服务会像打开会话时一样先按需启动 pi 并续接这条会话；直接操作是在 pi 内部执行的。pi 启动不起来时返回 `executor_unavailable`；快照请求照常返回（见 4.1 节）。没有带 `session` 参数的直接操作不会启动 pi，pi 不在运行时返回 `executor_unavailable`。

续接或切换会话之后，服务核对 pi 报告的会话是不是请求的那一条。pi 报告的是别的会话（例如会话文件不在了，pi 没有报错而是新开了一条），或者 pi 拒绝切换时，服务不采纳那条会话：停掉这个任务的 pi，写一行日志（任务编号、请求的会话、pi 报告的会话），并返回 `session_resume_failed`。核对发生在把用户的话交给 pi 之前，所以这句话没有发出去，也没有进入任何会话；下一次请求时按平常的方式重新启动 pi。这种情况下快照照常返回，对话记录从会话文件读取，`executor.state` 为 `not_started`。会话文件整个不在时仍返回 `not_found`。服务启动时把 `--tasks` 与 `--runs` 转成绝对路径，交给 pi 的会话文件路径也一律是绝对路径。

## 6 直接操作

`POST …/actions?session={session_id}`：

```
{ "client_id": "…", "kind": "edit_fields" | "delete_item" | "mark_viewed" | "keep_pending" | "undo" | "request_review" | "waive_review" | "unwaive_review" | "set_review_rules" | "submit_deliverable",
  "targets": [ { "item_id": "UC-002", "base_revision": 3 } ],  // 打开这个条目时它所在的修订号；undo 时用 "revision_no"
  "fields": { "基本流程": ["…", "…"] },                          // edit_fields：给出完整的新值；submit_deliverable：{ "revision_no": N }
  "notify_executor": false }
```

响应为 `{ok, client_id, op_id}`；处理结果以带同一个 `op_id` 的事件形式到达。规则如下。

1. 每个 `base_revision` 都必须是该条目当前所在的修订，否则整批请求都会被拒绝，错误码为 `stale_revision`，并列出每个过期条目、它现在所在的修订以及是谁改的。
2. 撤销修订 N 会产生一次新修订 M，把修订 N 涉及的每个条目都还原到修改前的状态（新增用删除来撤销，删除用恢复来撤销），并记录 `undo_of_revision`；如果某个条目在那之后又被改动过，这次撤销会被拒绝，错误码为 `undo_conflict`。
3. `mark_viewed` 把每个目标在 `base_revision` 上记为已读。它是幂等的：条目在那次修订上最近一条标记已经是接受的就跳过，全部跳过时什么都不写、也不发事件。不带 `notify_executor` 时（界面在用户打开条目详情时这样发）不往会话里追加任何东西；带上时（请确认卡片上的「这几条都看过了」）追加一条界面操作说明，并发出第 7 节的固定句式。评审未通过的条目仍然可以记为已读。
4. 撤回确认（`unconfirm`）这个操作已经去掉：收到时与早先退役的 `confirm` 一样回 400 `bad_request`，说明里列出现在可用的操作种类。库里早先留下的撤回记录照常读得出、显示得出：条目在那次修订上最近一条标记是不接受时 `confirmation_stale` 为真，条目仍算已读。
5. `edit_fields` 与 `keep_pending` 在产生修订的同一个事务里，为这次修订同时记一条确认标记（依据 `ui_edit`）。
6. `request_review` 请评审者评审每个目标在 `base_revision` 上的内容；`targets` 为空列表时评全部待评审的条目（所在集合要求评审、当前所在的修订还没有评审记录的条目）。核对通过就立即响应，评审在后台进行，每个条目各发一条 `review_progress`，以及 `review_recorded` 或 `review_unfinished`，全部结束时发 `review_finished`，都带同一个 `op_id`。「待评审」指条目当前所在的修订在集合当前的 `rules_hash` 下还没有评审记录。同一次修订、同一套规则只评一次：点名的目标已经有这样的记录时拒绝，说明写「什么都没有评，因为：X 在当前修订上已经评过，内容和规则都没变；同一次修订、同一套规则只评审一次。」。请求里不再有强制重评这一项，带了 `force` 也不转交。上一批评审还在进行、没有要评的条目、目标所在集合不要求评审、目标不在它当前所在的修订时也拒绝（`rejected`）。每一批评审结束时发一条 `review_batch`。这里发起的评审结束后，往会话里追加一条界面操作说明，只写一句计数（`kind` 为 `request_review`，`review` 带计数），逐条发现不在里面，智能体经 `get_task_status` 去取。不引出智能体的运行。客户端对它不显示「正在保存」。
7. `waive_review` 保留每个目标现在的写法，要求目标在 `base_revision` 上的评审结论是不通过（见 4.1 节：当前规则下最后一条评审记录不合规，并且在它之后还没有保留），保留针对的就是这最后一条；`fields` 可以带 `reason`（理由）与 `source`（`detail` 或 `panel`）。这条按用户的决定算通过；条目再改动，评审要重做。`unwaive_review` 撤销算数的那条保留。没有可保留或可撤销的时拒绝。两种都只有用户能做，智能体没有对应的工具。
8. `set_review_rules` 设定一个集合哪些可选规则关闭、哪些升为必选：`targets` 为空列表，`fields` 写 `{ "collection": 集合名, "off": [规则编号…], "promote": [规则编号…] }`。它同时改任务目录里的任务定义副本与库里的快照；关必选规则、写了不存在的编号、集合没有评审规则、与现在一样时拒绝。已有评审记录不变；规则指纹变了，这个集合的条目都回到待评审。
9. 对已关闭的任务，任何操作都返回 `task_closed`。
10. 智能体工作期间，任何操作都返回 `session_busy`，`data.reason` 为 `working`；不带 `notify_executor` 的 `mark_viewed` 除外。
11. `submit_deliverable` 由用户把任务标为已完成：用户在条目区顶部的绿色提示条上点「已完成，提交交付物」、再在确认框里点「提交」时，网页界面发出它。`targets` 为空列表，`fields` 写 `{ "revision_no": N }`，是页面当时看到的交付物最新修订号。它与智能体的 `complete_task` 做同一组核对，这次点击本身就是用户的同意。完成条件没有全部满足时返回 `rejected`，说明以「任务没有标为已完成。」开头，后面写缺什么。N 不是交付物现在的最新修订时返回 `rejected`，说明是「这次没有提交：你看到的是修订 N，交付物现在已经是修订 M。请看过现在的内容再提交。」。都通过时任务变为已完成：发出 `task_changed`，`actor` 为 `user`，不带 `op_id`；会话里追加一条界面操作说明（`kind` 为 `submit_deliverable`）：「界面操作（不是用户打的字）：用户在页面上确认这个任务已经完成，提交了交付物（修订 N）。任务已标为已完成，交付物不能再改，仍然可以生成文档。」它不引出智能体的工作，也不能撤销。客户端不要为它显示「正在保存」。界面只在任务进行中、`completion.all_met` 为真、智能体不在工作、而且这条会话里没有还没回应的、带 `key` 为 `complete` 选项的请选择卡片（见 5.4）时显示这条提示条。

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
| `executor_unavailable` | 503 | pi 启动失败（`data.detail`），或者 pi 不在运行时来了没有带 `session` 的直接操作 |
| `session_resume_failed` | 503 | 续接或切换之后 pi 接着的不是请求的会话（见 5.6 节）；pi 已停掉，用户的话没有发出去；`data.session_id` 是请求的会话 |
| `busy_timeout` | 503 | 等待数据库写锁超时 |
| `too_large`、`unsupported_type` | 413、415 | 附件过大，或类型不受支持 |
| `duplicate_content`、`name_taken` | 409 | 上传的材料与本任务已有的某份材料内容完全相同，或者与已有的某份材料同名而内容不同（见第 5 节的「材料」）；`data.path` 是已有的那份材料 |
| `in_use` | 409 | 选定的模型属于要删除的模型服务，或者正要被停用（见第 10 节）；`data.provider_id` 是那个模型服务 |
| `config_unwritable` | 409 | `models.json`、`auth.json` 或产品自己的设置文件读不成一个 JSON 对象，或者里面有注释、改写时会丢掉（见第 10 节）；`data.file` 是文件名，文件原样不动 |
| `config_locked` | 503 | 别的程序拿着这几个文件之一的锁超过两秒（见第 10 节）；`data.file` 是文件名 |

## 9 其他约定

1. 取决于任务定义的文本（集合名、字段名与类型、枚举值、完成条件的名称）一律以接口返回的数据为准。
2. 可能有多个页面同时在看同一个任务；后到的那次保存有可能因为条目所在的修订已经过期而被拒绝。
3. 路径带着版本号 `v1`；字段只会新增，含义不会改变；客户端应忽略未知的事件与字段。
4. 本版本尚不支持：多用户并发、身份认证、流式回复文本。
5. **服务信息与运行形态。** 下面两个接口不需要任务。
   - `GET /api/v1/service` 返回 `{ "ok": true, "app": "taskwright", "version": …, "mode": "desktop" | "server", "pid": …, "port": …, "capabilities": { "exit": true | false, "model": true | false, "model_config": true | false }, "model": { "name": …, "reason": … }, "upload": { "max_bytes": 5242880, "too_large_text": "单个文件不能超过 5 MB。", "extensions": [".md", ".txt", ".docx"], "types_text": ".md、.txt 与 Word 的 .docx", "unsupported_type_text": "只接受 .md、.txt 与 Word 的 .docx 文件。" } }`，其中 `port` 是服务实际监听的端口；`upload` 给出上传上限（字节）、超过时给用户看的那句话（与 `too_large` 拒绝里的是同一句）、允许上传的扩展名、这些类型给人看的写法（`types_text`）与 `unsupported_type` 拒绝里的那句话（`unsupported_type_text`），后两项由扩展名拼出。网页界面按上限与扩展名在发送之前就拦下过大或类型不符的文件，显示对应的那句话；按扩展名过滤可选的文件，按 `types_text` 写上传框的说明。它有三种用途：打包后的启动程序用它认出某个端口上跑的是不是自己；部署与监控用它探活；客户端按 `capabilities` 决定显示还是隐藏相应的按钮或提示。`capabilities.exit` 只在以 `--mode desktop` 启动、并且这次请求来自本机回环地址时为 `true`（与退出接口的判断相同）；从别的电脑打开页面时为 `false`，页面也就不显示退出的入口。经反向代理访问时，服务看到的来源是代理的地址，所以桌面形态不应放在反向代理后面。`capabilities.model_config` 是页面能不能修改模型配置（见第 10 节）；现在从哪台电脑打开都能改，恒为 `true`，这个字段留给以后加登录时用。
   - `capabilities.model` 是模型探测的结果：服务起 pi 时要用的模型「服务商/模型」（`model.name`；在模型配置里选定了语言模型时就是它，见第 10 节），在 pi 配置目录的 `models.json` 里登记了、或者这个服务商在 `auth.json` 里有一项，就是 `true`。`model.reason` 是一句说明：以 `--mode desktop` 启动时写明查过的两个文件的完整路径，以 `--mode server` 启动时只写文件名，不带出服务器上的目录。探测在每次请求时现查，只读这两个文件，不启动 pi；服务商的密钥只放在环境变量里的情形识别不了，这时是 `false`。以 `--mode desktop` 启动时，`model.name` 可能来自 pi 的 `settings.json`（见部署文档第 10.4 节）。
   - `POST /api/v1/service/exit` 只在以 `--mode desktop` 启动时存在，以 `--mode server` 启动时返回 `not_found`。它只接受来自本机回环地址（`127.0.0.1` 或 `::1`；`::ffff:127.0.0.1` 是 IPv4 回环地址在 IPv6 套接字上的写法，也算本机）的请求，其他来源一律返回 `forbidden`（403）。它先回答 `{ "ok": true }`，再照收到 SIGTERM 时的做法收尾：停止接收新连接、向每一条打开着的事件流发 `service_exiting`、关掉各任务的 pi、删掉本服务写的占用标记，然后退出进程。它只供 0.3 的过渡安装包使用（这种包由服务自己打开浏览器，没有桌面外壳）；最终的桌面版由外壳停止服务，这个接口不承诺长期保留。
   - 运行形态（`--mode desktop|server`，缺省 `server`）决定默认绑定地址（`desktop` 为 `127.0.0.1`，`server` 为 `0.0.0.0`，两种形态下 `--host` 都优先）以及退出接口是否存在；其余行为两种形态完全相同。运行形态会写进启动日志和各任务的占用标记（`service.lock` 里的 `mode` 一项）。

## 10 模型配置

这组接口供网页界面配置模型服务（model provider，提供模型调用接口的一方，可以是本机或内网里运行的程序，也可以是商业公司的在线接口），并选定用哪个模型。助手用的语言模型由 pi 调用：pi 从它配置目录（`PI_CODING_AGENT_DIR`，缺省是用户主目录下的 `.pi/agent`）里的 `models.json` 读模型服务的登记，从 `auth.json` 读密钥。嵌入模型（embedding model，把一段文字换算成一串数字的模型，知识库按意思检索时要用）由任务服务自己调用；这一版只记下选了哪一个。选了哪些模型记在产品自己的设置文件里（见[部署文档](deployment.zh-CN.md)第 5 节）。

**什么时候生效。** 新选定的语言模型从下一次打开或者新建会话起使用；正在进行的会话不受影响。任务服务在启动 pi 之后、`new_session` 之后、`switch_session` 之后，只要 pi 用的模型与选定的不同，就用 `set_model` 换过去。所以改了之后重新打开的旧会话也接着用新选定的模型，pi 会在那条会话的记录里加一条换模型的记录。换不过去时这条会话不打开：请求返回 `executor_unavailable`，执行者状态里写明哪个模型用不了、为什么。没有选定语言模型时照 0.3 的规则：用启动配置里的模型，以 `--mode desktop` 启动时用 pi 的 `settings.json` 指定的那一个。

**任务服务写什么。** 它只增改、删除自己登记的模型服务：名字以 `taskwright-` 开头，并且记在设置文件的名单上。`models.json` 与 `auth.json` 里别的内容原样保留，包括用户在任务服务管的那几项里手工另加的字段。每次写之前，它把文件复制一份到同一目录，名字是 `<文件名>.taskwright-backup-<时刻>`，只留最近 5 份；`auth.json` 的备份与原文件权限相同（0600）。它与 pi 用同样的锁：在文件旁边建一个名字是文件名加 `.lock` 的目录。写的时候先写临时文件，再改名替换原文件。文件里有注释时（pi 允许写注释）不改写，因为改写会把注释丢掉，请求返回 `config_unwritable`。

**密钥从不返回。** 有密钥的模型服务显示 `key: {set: true, last4: "3f9c"}`。

### 10.1 对象

**模型服务**（`provider`）：

| 字段 | 含义 |
|---|---|
| `id` | 它在 `models.json` 里登记的名字，例如 `taskwright-ollama`（同一种类的第二个是 `-2`，依此类推）；也是「服务商/模型」里服务商那一段 |
| `managed` | 在这里添加的模型服务是 `true`。用户手工写进 `models.json` 的是 `false`：它们只读地列出来，只有 `id`、`name` 与模型，模型一律显示为勾选了的语言模型；这里不能改、不能删，也不查它们的密钥，但是其中的模型可以选为语言模型 |
| `kind` | `ollama`、`llamacpp`、`vllm`、`deepseek`、`aliyun`（只有按量付费）、`openai_compatible` 或 `codex`；`managed` 为 `false` 时是 `null` |
| `name` | 给人看的名字 |
| `base_url` | 用户填的地址；`codex` 与只读的模型服务是 `null` |
| `key` | `{set, last4}`；`codex` 与只读的模型服务是 `null` |
| `status` | 上一次连接检查的结果 `{checked_at, ok, message}`；`codex` 是 `{checked_at, ok, logged_in, message}`；只读的模型服务是 `null` |
| `models` | `[{id, type, enabled, context_window, context_source}]`：`type` 是 `language`（语言模型）或 `embedding`（嵌入模型）；只有勾选了（`enabled`）的模型可以选定；`context_window` 是上下文长度，整数，单位是词元（token），或 `null`；`context_source` 是 `service`（从模型服务查到的）、`user`（用户填的）或 `null` |
| `models_fetched_at` | 上一次获取模型列表的时刻，或 `null` |
| `in_use` | `[]`；选定的某种模型属于这个模型服务时，写 `language` 和／或 `embedding` |

### 10.2 接口

与其余接口一样，只用 GET 与 POST。

| 接口 | 用途 | 返回 |
|---|---|---|
| `GET /api/v1/model-config` | 设置页面要显示的全部内容 | `{ok, editable, notice, selection, fallback, providers}`。`editable` 恒为 `true`，`notice` 恒为 `null`，两项都留给以后加登录时用。`selection` 是 `{language: {provider_id, model_id} \| null, embedding: {provider_id, model_id, query_prefix} \| null}`。`fallback` 是没有选定语言模型时 pi 启动用的模型 `{model, from}`，`from` 是「启动配置」或「pi 设置」；选定了语言模型时是 `null`。`providers` 先列在这里添加的模型服务，再列只读的。 |
| `POST /api/v1/model-config/providers` `{kind, name, base_url, api_key}` | 添加一个模型服务 | 先检查一次能不能连上（不发模型请求），连上了才保存：`{ok, provider}`。`name` 可以不给（按种类给缺省名）；`base_url` 对 `ollama`、`llamacpp`、`vllm`、`deepseek`、`aliyun` 可以不给（用它们的缺省地址），对 `openai_compatible` 必须给，对 `codex` 不看；本地的三种填的是服务的地址，交给 pi 时后面加 `/v1`。`api_key` 对 `deepseek` 与 `aliyun` 必须给，对别的种类可以不给，对 `codex` 不看。检查不通过时返回 `rejected`（422），什么都不保存；`data.field` 是 `base_url` 时说明是「连不上这个地址。请确认模型服务已经启动，地址与端口没有写错。」，是 `api_key` 时是「模型服务拒绝了这个密钥。」。`codex` 只看 `auth.json` 里有没有 Codex 的登录凭据，有没有都保存。 |
| `POST /api/v1/model-config/providers/{id}` `{name?, base_url?, api_key?, models?}` | 修改一个模型服务 | `{ok, provider}`。给了新的 `base_url` 或 `api_key` 时与添加时一样先检查。`models` 用 `[{id, type, enabled, context_window}]` 整个替换模型清单；勾选了却没有 `context_window` 的语言模型返回 `rejected`，`codex` 下的嵌入模型也是。停用或删掉选定的模型返回 `in_use`。只读的模型服务返回 `not_found`。 |
| `POST /api/v1/model-config/providers/{id}/delete` | 删除一个模型服务 | `{ok}`；从 `models.json` 删掉它那一项，从 `auth.json` 删掉它的密钥。选定的模型属于它时返回 `in_use`（409）；只读的模型服务返回 `not_found`。 |
| `POST /api/v1/model-config/providers/{id}/check` | 重新检查连接（`codex` 是重新检查登录） | `{ok, provider}`，带新的 `status`；不会返回 `rejected` |
| `POST /api/v1/model-config/providers/{id}/fetch-models` | 向模型服务查询它的模型 | `{ok, result, message, provider}`。`result` 是 `listed`（查到的清单并进已存的：新的模型不勾选，已有的模型保留原来的设置，上下文长度不是用户填的就换成查到的值，并记下 `models_fetched_at`）、`not_offered`（「这个模型服务没有提供模型的清单，请手工添加。」）或 `failed`（「获取模型列表没有成功：原因。可以稍后再试，或者手工添加。」）。各种类怎样查见 10.3。 |
| `POST /api/v1/model-config/providers/{id}/context-window` `{model_id}` | 查模型服务实际给这个模型的上下文长度 | `{ok, context_window, source, message}`；查不到时 `context_window` 是 `null`，`message` 请用户手工填写。`ollama` 要先载入这个模型，可能要等两分钟。查到的值不保存，要保存就修改模型服务。 |
| `POST /api/v1/model-config/selection` `{language, embedding}` | 选定模型 | `{ok, selection, note}`，`note` 是「更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。」。两部分各是 `{provider_id, model_id}`（嵌入模型可以另带 `query_prefix`，查询前缀）或 `null`。模型要勾选了、种类要对，在这里添加的模型服务里的语言模型还要有上下文长度，否则返回 `rejected`。语言模型可以选只读的模型服务里的，嵌入模型不行。`language: null` 回到 0.3 的规则；`embedding: null` 表示不用嵌入模型。 |

### 10.3 怎样查模型列表与上下文长度

向模型服务发的每个请求 5 秒没有回答就放弃，只有载入 `ollama` 的模型等 120 秒。

| 种类 | 模型列表 | 种类的判断 | 上下文长度 |
|---|---|---|---|
| `ollama` | `GET /api/tags`，再对每个模型发 `POST /api/show` | `capabilities` 里有 `embedding` 而没有 `completion` 的是嵌入模型 | 列表里不填（`/api/show` 给的是训练时的最大值）。`context-window` 先载入模型，再从 `GET /api/ps` 读 `context_length`。 |
| `llamacpp` | `GET /v1/models` | 语言模型 | `meta.n_ctx` |
| `vllm` | `GET /v1/models` | 语言模型 | `max_model_len` |
| `deepseek` | `GET /models` | 语言模型 | `context_window` |
| `aliyun` | `GET /models`；没有这个接口时是 `not_offered` | 名字里有 `embedding` 的是嵌入模型，别的是语言模型 | `null` |
| `openai_compatible` | `GET /models`；回 404 时是 `not_offered` | 语言模型 | 有 `max_model_len`、`context_window` 或 `meta.n_ctx` 就用它，否则是 `null` |
| `codex` | pi 自带的 Codex 订阅模型目录，不联网读取；没有登录时是空的 | 语言模型 | 取自 pi 的目录 |

### 10.4 其他部分的变化

- `GET /api/v1/service`：`capabilities` 多一项 `model_config`（见第 9 节）；`capabilities.model` 与 `model` 先看选定的语言模型。
- 错误（第 8 节）多三种：`in_use`、`config_unwritable`、`config_locked`。
