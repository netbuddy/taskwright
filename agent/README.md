# agent：任务型智能体在 pi 进程里的工具与扩展点

本目录放的是加载进 pi 进程的 TypeScript 代码。pi 是一个命令行 coding agent（用自然语言驱动、
自己决定调哪个工具的命令行程序），我们原样取用它的循环，自己只写两类代码：工具与扩展点。

## 目录结构

| 路径 | 里面是什么 |
|---|---|
| `extension.ts` | 扩展入口。它只做登记：把工具、扩展命令与各个钩子挂到 pi 上，自己不含任何逻辑。 |
| **工具（`tools/`，模型调用）** | 每个文件只声明参数、调用 `lib/` 里的核心函数、把结果转成 pi 要的返回形状。 |
| `tools/save_revision.ts` | 「保存修订」（`save_revision`）：把一批按条目的新增、修改、删除存成一次修订。 |
| `tools/reply.ts` | 「回复」（`reply`）：执行者对用户说的每一句话都经它发出；合格时结束本次运行，连续被拒到上限时放行纯文字回复并标 `degraded`。 |
| `tools/get_item.ts` | 「查看条目」（`get_item`）：按编号看一个条目某一版的全部字段、来源、当前版本号、评审与确认状态。只读。 |
| `tools/get_task_status.ts` | 「查询任务状态」（`get_task_status`）：各集合的条目、完成条件逐项、未解决的问题条目、未读清单（用户还没看过现在样子的条目）、最近一次修订。只读，输出与 `/tw-board` 同源。 |
| `tools/complete_task.ts` | 「完成任务」：按任务定义的完成条件逐项核对，全部满足才把任务标为已完成。 |
| **扩展点（`hooks/`）** | 挂在 pi 的事件上或登记成扩展命令，不写任务数据；扩展命令写库时调用与工具相同的核心函数。 |
| `hooks/task_status.ts` | 打开会话时往会话里追加任务现状消息（`customType` 为 `taskwright-task-status`），并经状态栏同名的键报给后端。 |
| `hooks/reply_fallback.ts` | 兜底：执行者没有经「回复」说话就停下时，追加一句固定的话要它改用「回复」，至多两次。 |
| `hooks/user_commands.ts` | 两个扩展命令：`/tw-user <JSON>` 是用户在界面上的直接操作（改字段、删条目、确认、撤回确认、标为先不管、撤销），不经模型写库；`/tw-ui <JSON>` 是卡片上需要执行者再出力的点击。结果经状态栏键 `taskwright-user-result`、`taskwright-ui-result` 回传。 |
| `hooks/board_command.ts` | 扩展命令 `/tw-board`：打印交付物看板，`/tw-board UC-001` 打印一个条目的全部字段与来源。只读，执行者看不到。 |
| `hooks/tui_render.ts` | 「回复」与「保存修订」在 pi 终端界面里的渲染器，只有交互模式调用，经 `withTuiRenderers` 并进工具定义。 |
| `hooks/report_to_backend.ts` | 只读小扩展：把激活的工具清单、pi 的轮号、Langfuse 运行记录编号报给后端。 |
| **核心逻辑（`lib/`，不依赖 pi）** | 普通函数，单元测试直接调用。 |
| `lib/schema.ts` | 建表语句（全部代码里只有这一份）、来源的四种种类、「确保库已建好」的函数。 |
| `lib/db.ts` | 给出库文件的位置、开立即事务、往事件表写一条事件。全部代码里只有这里往事件表写。 |
| `lib/definition.ts` | 读取任务定义并校验它的形状。 |
| `lib/conditions.ts` | 完成条件：登记条件名与查库的事实核对函数。看板、查询任务状态、完成任务都用这一组函数。 |
| `lib/create_task.ts` | 「创建任务」的核心逻辑（一库一任务：库里已有任务就拒绝，不论状态）。 |
| `lib/save_revision.ts` | 「保存修订」的核心逻辑。 |
| `lib/speak.ts` | 「说话」类工具的公共骨架：读这一轮的工具调用、要求单独调用、合格时返回结束本次运行的标记。 |
| `lib/reply.ts` | 「回复」的核对：形式核对、提问等向用户要的回应必须挂在条目上、告知点名的条目要存在、卡片不能只是复述刚说过的话、请确认只认当前版本、连续被拒的计数与上限。 |
| `lib/task_query.ts` | 「查看条目」与「查询任务状态」的核心逻辑，只读库。 |
| `lib/model_call.ts` | 工具里直接调一次模型时共用的两样东西：模型调用记录的形状、从模型输出里取 JSON。现在只有「请求评审」的评审者用。 |
| `lib/complete_task.ts` | 「完成任务」的核心逻辑。 |
| `lib/user_ops.ts` | 用户直接操作的核心逻辑，`/tw-user` 调用它；改到的字段写「用户直接修改」来源，通知正文带改后的值；标为已读（打开详情）写依据为「已读」的确认标记，幂等。 |
| `lib/task_status.ts` | 任务现状消息的内容：新会话写现状，续接旧会话写上次之后的变化。只读库。 |
| `lib/board.ts` | 交付物看板的取数与排版，`/tw-board` 与两个只读工具共用。 |
| `lib/tool_render.ts` | 「回复」与「保存修订」怎样排成几行给人看；终端界面的渲染器与后端的终端客户端都用它。 |
| **命令行入口（`cli/`，不经 pi）** | 给后端的 Python 代码起 Node 子进程调用。 |
| `cli/create_task.mts` | 创建任务：后端（`server/taskwright_server/create_task.py`）建好任务目录之后运行它写任务记录，发起方 `user`。 |
| `cli/render.mts` | 排版：标准输入给一次工具结果，标准输出拿回排好的几行；后端的终端客户端 `chat.py` 用它。 |
| `tests/` | 单元测试。它们直接测 `lib/` 里的核心函数，不经过 pi，也不经过模型。 |

`lib/` 下的模块都不依赖 pi，是普通的函数；`tools/` 下的文件只做登记与形状转换。

分工是硬的：写库只发生在工具的执行函数里。执行函数是注册工具时交给 pi 的 `execute` 函数，模型发出
工具调用后，pi 拿着参数运行它。扩展的事件钩子不写任务数据。代码里没有任何判断内容好坏的规则或关键词
清单：用例写得好不好、EARS 句式对不对由评审者判断，代码只核对集合、字段、类型、必填与来源是否齐全。

## 任务数据放在哪里

任务数据放在任务目录根目录下的 `task.sqlite` 里，一个任务目录一个库。库由写入工具在执行函数里建：
「创建任务」发现库文件不存在，就建齐九张表；「保存修订」发现库文件不存在，就拒绝并说明还没有创建任务，
不会留下一个空库。库里已经有 `slot` 表，说明它是更早的旧格式，两个工具都会拒绝，并说明
「这个任务目录的库是旧格式，请换一个新的任务目录」。

| 表 | 一行是什么 |
|---|---|
| `task` | 一行是一个任务：任务定义的路径与原文快照、状态（进行中、已完成、已放弃）、创建它的会话编号与调用编号。 |
| `revision` | 一行是某个任务的第 N 次修订，也就是一次「保存修订」调用。 |
| `item` | 一行是一个条目的身份：条目编号（例如 UC-001）、所属集合、在第几次修订新增与删除。 |
| `item_version` | 一行是某个条目的第几版内容，存下之后不再改动。 |
| `item_source` | 一行是某个条目某一版的一条来源所支持的一处：种类、出处、摘录，以及支持的字段名与列表里的第几项（都为空表示支持整个条目）。一条来源支持几处就展开成几行。 |
| `review`、`judgement`、`judgement_item` | 这三张表记评审、确认判读与判读明细。确认由「登记用户确认」与用户在界面上的确认写；评审要等「请求评审」工具（尚未提供）。 |
| `event` | 一行是库里发生的一件事。每次写入都同时记一条，带 pi 的会话编号、调用编号与发起方（执行者 `executor` 或用户 `user`）。 |

每一条写入类的行都带 `event_seq` 一列，指向产生它的那条事件；事件里有 pi 的调用编号。
建表语句全文与每一列的中文注释见 `lib/schema.ts`，注释会随建表语句一起存进库里的 `sqlite_master`。

库用 WAL 模式（write-ahead logging，改动先写进旁边的日志文件再合并回库文件），读与写互不阻塞；
写与写之间排队，打开库时设忙等待超时 5000 毫秒（`lib/schema.ts` 的 `BUSY_TIMEOUT_MS`）。取这个数值的
依据是 2026-09-21 的实测：4 个进程同时写 80 次，最长一次等了 154 毫秒；另一个进程占住写锁 3 秒时，
写入等 3.1 秒后成功。最早格式的库是默认的回滚日志模式，写入一侧第一次打开它时自动切成 WAL；旧格式
（有 `slot` 表）的库不切。WAL 模式下一个库是 `task.sqlite`、`task.sqlite-wal`、`task.sqlite-shm` 三个文件，
复制或归档时要三个一起复制，或者先做检查点再只复制 `task.sqlite`（见 `server/README.md`）。

数据库用 Node 自带的 `node:sqlite` 模块，不引入需要编译的第三方包。本目录没有任何依赖；
`package.json` 只声明 TypeScript 按 ES 模块解析，并给出跑测试的命令。

## 创建任务与保存修订

**创建任务**（核心函数 `createTask`，参数 `definition_path`、可选的 `task_name` 与 `domain_tag`）。一库一任务：
库里已经有任务时一律拒绝。它读取并校验任务定义，写一行任务（带用户起的任务名与领域标签）、记一条
`TASK_CREATED` 事件。它不再登记成执行者的工具，只经 `cli/create_task.mts` 由后端调用：

```
node cli/create_task.mts --dir <任务目录> --definition docs/task-definitions/srs-authoring.json --op-id ui-op-… [--name 任务名] [--tag 领域标签]
```

**保存修订**（`save_revision`，参数 `operations`：操作列表）。每个操作是新增、修改、删除三种之一：

```
{ "op": "add", "collection": "功能用例", "fields": { … }, "sources": [ … ] }
{ "op": "update", "item": "UC-001", "base_revision": 4, "fields": { 只写要改的字段 }, "sources": [ 可省略 ] }
{ "op": "delete", "item": "UC-001", "base_revision": 4 }
```

一次调用产生一次修订，修订号在任务内从 1 起连续递增。条目没有单独的版本号：条目在某一时刻的内容由「条目编号加修订号」
标识，条目「当前所在的修订」是它最近一次被新增、修改或恢复的那次修订。修改与删除必须带 `base_revision`，即模型所见的这个条目
当前所在的修订号；它与库里的不符时整批拒绝，拒绝的话写明「条目 UC-001 已经被用户改到修订 9（你看到的是修订 4），请先读最新内容再改」
并附上当前内容，「被谁改」取自那次修订的事件的发起方。

每条来源是 `{ "kind": "文档原文" | "用户的话" | "执行者补充", "locator": "…", "excerpt": "…", "supports": [ … ] }`。来源还有第四种「用户直接修改」，只由用户的直接操作写（出处是操作编号），执行者填它会被拒绝。
`supports` 写这条来源支持哪几处，每项是 `{ "field": 字段名 }` 或 `{ "field": 字段名, "index": 列表里的第几项（从 0 起） }`，
不写或空列表表示支持整个条目；字段必须是这个集合声明的、改后的内容里不为空的，`index` 只用于列表型字段并且小于项数。
种类是「用户的话」时模型不填出处：工具在当前会话分支的用户消息里，从最近往前找逐字包含摘录的那一条，
把出处填成「会话编号#会话条目编号」（例如 `01a0c228-…#ecf018ae`）；找不到就拒绝，要求逐字摘录原话。
扩展追加的自定义消息不算用户的话。

核心函数的调用上下文（`lib/create_task.ts` 的 `CallContext`）有发起方 `actor`（缺省 `executor`）：工具登记处固定填
`executor`；以后用户在界面上的直接操作经扩展命令调用同一个核心函数，填 `user`，`callId` 填后端生成的操作编号
（以 `ui-` 开头）。两个工具返回值的 `details` 都带 `event_seq`，即这次写入记下的那条事件的序号。
条目引用类型的字段，值一律是条目编号的数组（例如 `["UC-001", "CON-002"]`，可以为空数组），每个编号都要指向本任务里存在且没有被删除的条目；只写一个字符串会被拒绝。
整批操作形成一次修订，记一条 `REVISION_SAVED` 事件。有任何一个操作不对，整批都不写入，拒绝的文字逐条
列出哪个操作的哪一处不对。条目编号由工具按「编号前缀加三位流水号」生成，删过的号不复用。修改时省略
`sources` 就沿用上一版的全部来源；给了就只替换这次改到的字段上的来源，没改的字段的来源沿用；只给 `sources`、
不改字段时整体替换。

## 怎么跑单元测试

在本目录下运行下面这条命令。本机是 Node 24，用的是 Node 自带的测试工具，不需要安装任何东西。

```
node --test 'tests/*.test.ts'
```

每个测试在临时目录里建一个新库。应当看到最后几行里 `ℹ fail 0`，`ℹ pass` 与 `ℹ tests` 的数目相同。

## 怎么运行

日常一律经后端以 RPC 方式启动 pi。启动参数收在 `server/taskwright_server/profiles/dev.json`，拼命令行的唯一一处是
`server/taskwright_server/launch.py`。几点要紧的：

- `--tools` 白名单以 `server/taskwright_server/profiles/dev.json` 为准：read 读文件，ls 列出目录里有哪些文件（两者都是 pi 自带的只读工具），其余是本目录登记的工具。白名单里必须写上自定义工具的名字，漏写时模型看不到它。`create_task` 已从白名单去掉。不开放 find、grep、bash。
- 系统提示用 `--system-prompt` 整体替换成执行者自己的系统提示（`server/taskwright_server/prompts/executor_system_prompt.md`）。
- 启动配置关掉了 pi 的技能自动发现（`--no-skills`），免得本机全局目录里的技能混进来；技能改用 `--skill` 显式加载，
  先传平台 skill `--skill <代码仓>/agent/prompts/skills/taskwright-executor`（本目录 `prompts/skills/` 下，所有任务类型共用，
  写在启动配置的 `platform_skill` 一项），再传任务目录里的 `--skill <任务目录>/.pi/skills`。先后决定 pi 的 skill 清单里的顺序。

## 怎么核对三类代码的边界

在本目录下运行：

```
grep -rnE "(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO) +event\b" --include=*.ts lib tools hooks
grep -rnE "(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO) +(task|revision|item|item_version|item_source)\b" --include=*.ts lib tools hooks
grep -rnE "CREATE TABLE" --include=*.ts lib tools hooks
grep -nE "sqlite|INSERT|UPDATE|SELECT" extension.ts hooks/*.ts
```

应当看到：往 `event` 写只在 `lib/db.ts`；往任务数据的几张表写只在 `lib/create_task.ts`、
`lib/save_revision.ts` 与 `lib/complete_task.ts`（它只改任务的状态与结束时刻）；建表语句只在 `lib/schema.ts`；
`extension.ts` 与 `hooks/` 里没有任何读写库的语句（最后一条命令只会命中 `hooks/user_commands.ts` 文件头注释里
提到 `node:sqlite` 的那一行）。用户的直接操作经 `lib/user_ops.ts` 调用 `saveRevision` 写条目，确认记录写在
`judgement` 与 `judgement_item` 两张表，不在上面第二条命令查的范围里。
