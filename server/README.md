# taskwright_server：启动与看护 pi 的后端代码

这个目录里的 Python 代码跑在 pi 进程**之外**。pi 是一个命令行 coding agent（用自然语言驱动、
自己决定调哪个工具的命令行程序），我们把它当作智能体的循环原样取用。

这里的代码只做三件事：按配置启动 pi、把用户的话转给它、把它说的话与做的事显示出来。
它**不写任务数据库**，**不建库**，**不做核对**，**不解读用户说的话**，**不评价模型的产出**——
任务数据只能由 pi 进程里的工具写，库也由那些工具建，那部分代码是 TypeScript，不在这个目录。
本目录里的 `check_db` 只是事后只读查账，写入时的核对在工具里。

日常开发一律用 RPC 方式（remote procedure call mode，远程过程调用模式：pi 不画界面，改成按行
收发 JSON），因为将来发布出去的程序也是这样调它的，这样开发时看到的行为与发布后一致。

## 目录里有什么

| 文件 | 它做什么 |
|---|---|
| `launch.py` | 把启动配置读成一条 pi 命令行与一份环境变量。全部代码里拼 pi 命令行的地方只有它的 `build_command` 函数这一处。 |
| `profiles/dev.json` | 开发用的启动配置：模式、模型、加载哪些扩展、工具白名单、要传给 pi 的环境变量名单。 |
| `pi_session.py` | 会话类：启动 pi 子进程、发话、逐条读事件、判定一句话说完了、把原始事件流归档、pi 没了立刻报告；每次启动时在后端补记里记下 pi 实际加载的 skill、上下文文件与知识仓库各文件的摘要值。 |
| `chat.py` | 终端对话客户端，经 RPC 操作 pi，日常开发用它。入口是 `python -m taskwright_server.chat <任务目录>`。开场打印任务现状消息；「回复」与「保存修订」两个工具的结果经 `agent/src/cli/render.mts` 排版，与 pi 终端界面里的显示是同一份。 |
| `tui.py` | TUI 验证程序：用 pi 自带的终端界面（交互模式）跟执行者对话，给人亲手验证用。启动配置与 RPC 模式同一份，只是不写 `--mode rpc`。入口是 `python -m taskwright_server.tui <任务目录> --label 名字`，可加 `--continue`（续接最近一条会话）、`--session <会话文件>`、`--env-tag <Langfuse 环境标签>`。在 pi 里打 `/tw-board` 看交付物看板，Ctrl+O 展开工具输出。每次启动在 `$TASKWRIGHT_RUNS_DIR/pi-tui/` 下记一份启动记录。 |
| `prompts/executor_system_prompt.md` | 执行者的系统提示。启动时用 `--system-prompt` 整体替换 pi 自带的系统提示，这份文字是执行者行为的一部分，改动要连同测试一起评估。 |
| `taskdb.py` | 只读地读新格式（按条目记版本）的任务数据库。`dbshow`、`check_db` 与观测台都经它读，读法只有这一份。 |
| `dbshow.py` | 只读查看任务目录里的 `task.sqlite`。入口是 `python -m taskwright_observatory.dbshow <任务目录>`。 |
| `check_db.py` | 只读的不变式核对。入口是 `python -m taskwright_observatory.check_db <任务目录>`，逐项打印通过或不通过。 |
| `create_task.py` | 创建一个任务（2026-09-21 起任务由用户在界面上创建）：建任务目录、放起始文件（`fixtures/<任务类型>/`）与材料，再起 Node 子进程运行 `agent/src/cli/create_task.mts` 写任务记录，发起方 `user`。任何一步失败整个创建失败并清掉目录。用法 `python -m taskwright_server.create_task <任务目录> [--name 任务名] [--tag 领域标签] [--material 文件]`。 |
| `service/` | 任务服务：给前端的 HTTP 接口（见 docs/api.md），每个任务起一个 pi 进程并把事件推给前端。入口是 `python -m taskwright_server.service --tasks <放任务目录的上级目录> --runs <归档目录> --port <端口>`，用法见 `service/README.md`。 |
| `new_workspace.py` | 只复制起始文件、不建库，给 `create_task.py` 与测试用。 |
| `fixtures/` | 建新任务目录用的起始文件模板，每个模板一个目录，说明见 `fixtures/README.md`。 |
| `fixtures/srs-authoring/` | 「软件需求规格说明编制」任务的起始文件：任务定义、执行者的 skill、领域规矩文档、文档模板、pi 的项目设置（排队模式）。`create_task.py` 与集成测试都用它；`fixtures/term-clarification/` 是更早的旧模板，只作对照。 |
| `fake_model/` | 假模型端点：按脚本回固定内容的本地 HTTP 服务，接口与 OpenAI 的聊天接口兼容，给集成测试用，让门禁拒绝这类机制可以被确定性地测。用法与脚本格式见 `fake_model/README.md`。 |
| `tests/` | 读取一侧的单元测试。夹具库由 `agent` 里真实的核心函数写出（要用 node）。 |
| `tests/integration/` | 集成测试：真实的 pi 进程经 RPC 驱动，模型换成假模型端点，只对库里的行、事件流与会话文件断言。`rig.py` 是直接驱动 pi 的试验台，`service_rig.py` 是经任务服务驱动的试验台。跑法：在代码仓根目录下 `python3 -m pytest server/tests/integration -q`。 |

只用 Python 标准库，没有第三方依赖。

## 开工前要设的三个环境变量

配置文件里不写任何机器上的绝对路径，也不写任何密钥。随机器变化的三样东西经环境变量给：

| 环境变量 | 设成什么 |
|---|---|
| `TASKWRIGHT_LANGFUSE_PLUGIN` | Langfuse 观测插件所在的目录。目录里应当有 `src/index.ts`。不设也能跑，只是没有观测数据。 |
| `TASKWRIGHT_LANGFUSE_ENV_FILE` | 存放 Langfuse 密钥与服务地址的文件。这个文件放在代码仓**之外**。 |
| `TASKWRIGHT_RUNS_DIR` | 运行目录。原始事件流、会话文件都归档到这里。不设就用当前目录下的 `runs`。 |

密钥文件每行写一个「名字=值」，内容是这四项（值按你自己的部署填）：

```
LANGFUSE_BASE_URL=http://<你的 Langfuse 地址>
LANGFUSE_PUBLIC_KEY=<公钥>
LANGFUSE_SECRET_KEY=<私钥>
TASKWRIGHT_LANGFUSE_PROJECT_ID=<项目编号>
```

这个文件建议把权限设成只有自己能读（`chmod 600`）。密钥只经环境变量传给 pi，不进命令行参数——
命令行参数在进程列表里是同机器上所有人都看得见的。

Langfuse 里这批数据的环境标签固定是 `development`，写在 `profiles/dev.json` 的 `langfuse` 一节里。

## 怎么用

创建一个任务（一库一任务，任务目录就是任务目录），然后开始对话：

```bash
python -m taskwright_server.create_task <任务目录> --name <任务名> --material <需求材料>
python -m taskwright_server.chat <任务目录>
```

起始文件取自本目录 `fixtures/srs-authoring/`（任务定义、执行者的 skill、领域规矩文档、文档模板、pi 的项目设置），
相对路径就是它们在任务目录里的相对路径。创建时就建库并写好任务记录；执行者没有「创建任务」工具。
打开会话时扩展会往会话里追加一条任务现状消息（`taskwright-task-status`）。

**库是 WAL 模式，复制与归档时要连同附属文件。** WAL 模式（write-ahead logging）下改动先写进旁边的
日志文件，再合并回库文件，所以一个库是 `task.sqlite`、`task.sqlite-wal`、`task.sqlite-shm` 三个文件，
最新的改动可能只在 `-wal` 里。复制或归档一个任务目录的库时，二选一：三个文件一起复制；或者先停掉用这个
任务目录的 pi，再做一次检查点（checkpoint，把日志合并回库文件），例如
`python3 -c "import sqlite3; sqlite3.connect('<任务目录>/task.sqlite').execute('PRAGMA wal_checkpoint(TRUNCATE)')"`，
之后只复制 `task.sqlite` 也完整。2026-09-21 实测：写入者连接还开着时只复制 `task.sqlite`，副本少了一次修订。

读取一侧（`taskdb.py`、`dbshow`、`check_db`）一律只读打开，忙等待超时 5 秒。只读连接在目录可写时会自己
建出 `-wal` 与 `-shm` 两个文件并留在那里，这是正常的，下一次写入时会被清掉。任务目录不可写、又没有这两个
文件时，只读打开会报 `attempt to write a readonly database`，这时 `taskdb.open_readonly` 改用 `immutable=1`
打开（没有 `-wal` 文件说明库文件本身就是最新的）；目录不可写而 `-wal` 在时照常报错，不冒漏读的险。

打一句话回车，这句话原样发给 pi。以斜杠开头的是客户端自己的命令，不会发给 pi：

| 命令 | 它做什么 |
|---|---|
| `/state` | 看 pi 当前的状态：模型、会话编号、会话文件、消息条数、是否在流式输出、是否在压缩。 |
| `/new` | 在同一个 pi 进程里另起一条会话，前面说过的话不再带着。 |
| `/abort` | 中止正在跑的那句话。pi 正说话的时候也可以打。 |
| `/db` | 显示任务数据库里的内容，与 `python -m taskwright_observatory.dbshow <任务目录>` 打印的一样。 |
| `/restart` | 重启 pi 并接回原来这条会话。改了 pi 进程里的工具代码之后用它让新代码生效，同时不丢前面说过的话。 |
| `/events` | 打开或关掉「实时打印原始事件」。排查问题时用。 |
| `/help` | 显示这张表。 |
| `/quit` | 退出。 |

每说完一句话，客户端打一行小结：用了几次模型请求、几次工具调用、耗时多少秒，再给一条
Langfuse 里这条会话的链接。

# 检查与复现手册

这一节写给要亲手核对这套东西的人。三部分：在 Langfuse 里怎么查、在数据库里怎么查、怎样从零复现。

## 一、怎样在 Langfuse 里检查

1. **打开与登录。** 浏览器打开密钥文件里 `LANGFUSE_BASE_URL` 写的那个地址。账号与口令不写在这里，
   问建这套环境的人要，或者看你自己那份密钥文件旁边的记录。
2. **进项目。** 左上角有两级选择器，前一个是组织，后一个是项目。选到你在密钥文件里
   `TASKWRIGHT_LANGFUSE_PROJECT_ID` 填的那个项目。
3. **找到这次对话。** 左栏点 **Sessions**（会话）。一次 `python -m taskwright_server.chat` 从头到尾算一条
   会话；你说的每一句话在这条会话下是一条运行记录（trace）——它对应 pi 的一次运行（agent run），也就是从 agent_start 到 agent_settled 的那一整段。
   会话编号就是客户端每句话小结后面那条链接末尾的那一串，也可以在客户端里打 `/state` 看到。
   会话页顶上写着 `Total traces: N`，N 就是你说过几句话。
4. **进一条运行记录。** 在会话页右侧点某一轮的 `Pi Turn` 链接，或者左栏走 **Tracing**（追踪）再点
   那一行。进去之后左边是一棵树：最上面是这一轮，下面挂着「Conversational Turn」，再下面是
   一次次 `LLM Call`（模型请求）与 `Tool: <工具名>`（工具调用）。
5. **在一条记录里各看什么。**

   | 想看什么 | 点哪里 |
   |---|---|
   | 系统提示全文 | 点任意一条 `LLM Call`，右边 **System** 一栏就是；太长时点「Expand system prompt」展开。 |
   | 发给模型的完整消息列表 | 同一条 `LLM Call` 右边，System 下面按 **User**、**Assistant**、**Tool** 逐条排下来。想看原始结构就点右上角的 **JSON** 切过去。 |
   | 工具定义 | 同一条 `LLM Call` 右边的 **Tools** 一栏，列出这次请求带了哪几个工具，并标出哪个被调用了。 |
   | 工具调用的参数与返回 | 点 `Tool: <工具名>` 那一条，右边 **Input** 是参数，**Output** 是工具返回给模型的那句话。 |
   | 调用编号 | 还是那条工具记录，右边 **Metadata** 一栏里的 `tool_id`。它与数据库 `event` 表的 `call_id` 是同一个值。 |
   | 被拒绝的工具调用 | 树上那一条会带红色 `ERROR` 标记，右边写着 `Tool execution failed`，Output 就是拒绝的原因。 |
   | 词元用量与耗时 | 每条 `LLM Call` 的标题行上就有，例如 `26 prompt → 45 completion` 与 `Latency: 2.04s`。 |

6. **环境标签。** 每条运行记录都带 `Env: development` 的标记，用来和将来正式跑的数据分开。

## 二、怎样在 `task.sqlite` 里检查

这台机器上没有 `sqlite3` 命令行程序，所以用仓库里的两个小工具查。它们都是只读的。

```bash
# 分五段打印：任务、各集合的条目（当前版本）、每个条目的版本历史与来源、修订列表、最近的事件
python -m taskwright_observatory.dbshow <任务目录>

# 多看几条事件
python -m taskwright_observatory.dbshow <任务目录> --events 30

# 逐项核对库里的记录互相对得上
python -m taskwright_observatory.check_db <任务目录>
```

应当看到的样子：

- 还没有创建任务的任务目录，两个工具都打印「这个任务目录还没有创建任务」并正常退出。
- 创建过任务之后，「任务」一段里有一个状态为进行中的任务，编号形如 `TASK-001`。
- 「各集合的条目」一段按任务定义里的集合逐个列出条目，编号形如 `UC-001`、`TBD-001`。
- 每个条目的每一版都有至少一条来源，写明种类、出处、所支持的字段（「支持整个条目」或具体字段）与摘录；「用户的话」的出处形如「会话编号#会话条目编号」。
- 「修订列表」里每次修订都列出它的操作；「事件列表」里 `TASK_CREATED` 与 `REVISION_SAVED` 两种事件的
  调用编号都不为空；执行者写的发起方是 `executor`，用户在界面上的操作写的是 `user`，调用编号以 `ui-` 开头。
- `check_db` 逐项打印八项核对（第 8 项是「发起方与编号相符」），最后一行是「全部通过。」，退出码是 0。

在对话过程中不想切窗口，就在客户端里打 `/db`，显示的内容与 `dbshow` 一样。

**怎样拿库里的调用编号到 Langfuse 里找到那次工具调用**：`dbshow` 的事件列表与修订列表里都有调用编号，
复制那一串，到 Langfuse 里打开对应的会话，逐条工具记录看右边 Metadata 的 `tool_id`，相同的那条
就是同一次调用。两边逐字相同，不需要做任何换算。

更早的旧格式任务目录（库里有 `slot` 表），`dbshow` 仍按原来的样子打印；本产品不提供旧格式的核对。

## 三、怎样从零手工复现

```bash
# 第一步：设三个环境变量（把尖括号里的换成你自己的路径）
export TASKWRIGHT_LANGFUSE_PLUGIN=<Langfuse 观测插件所在目录>
export TASKWRIGHT_LANGFUSE_ENV_FILE=<密钥文件>
export TASKWRIGHT_RUNS_DIR=<运行目录>

# 第二步：在代码仓根目录下创建一个任务，材料放进它的 inputs/
python -m taskwright_server.create_task <任务目录> --name <任务名> --material <你的需求材料>

# 第三步：开始对话
python -m taskwright_server.chat <任务目录>
```

启动后先看客户端打出的几行：启动 pi 的完整命令（里面应当有 `--tools` 白名单，内容以 `profiles/dev.json` 为准、
`--system-prompt` 与两个 `--skill`：先是代码仓里的平台 skill `agent/prompts/skills/taskwright-executor`，再是 `<任务目录>/.pi/skills`）、两个扩展各自加载到哪个文件、环境标签、
原始事件流归档到哪个文件、会话文件在哪、Langfuse 里这条会话的链接。**两个扩展都要显示出路径**，
Langfuse 那个显示「没有加载」就说明 `TASKWRIGHT_LANGFUSE_PLUGIN` 没设对。

然后照平常说话，例如告诉它材料放在 inputs 目录下、请它整理成需求规格说明。不要教它调用哪个工具：
执行者应当自己去读两份 skill 的正文（先平台 skill，再任务 skill）、读材料、分批保存条目（任务已经由 `create_task` 建好，执行者没有创建任务的工具）。每句话之后看三样：客户端打的
工具调用行（工具名、参数、成功还是被拒）、小结行、以及 `/db` 显示的库里的变化。想看模型到底收到了
什么，去 Langfuse 里按第一节的路子看；系统提示末尾应当有一段 skill 清单，里面依次列着 `taskwright-executor` 与 `srs-authoring`。

几个常用的查看动作：

```
/state     看会话编号与消息条数
/db        看库里的任务数据
/events    打开实时打印原始事件，排查问题时用，再打一次关掉
/quit      退出
```

**改了 pi 进程里的工具代码之后怎么办**：不用退出重来，在客户端里打 `/restart`。它会先问 pi 要当前
会话文件的位置，关掉 pi，再用同一个会话文件重新启动。重启之后接着说话，模型仍然记得前面说过的话，
Langfuse 里新的运行记录也还挂在同一条会话下。客户端会打出接回的会话文件路径与新的归档文件路径。

**事后去哪看**：运行目录下 `pi-events/` 是每次启动的原始事件流（一次 `/restart` 会多出一个文件），
`pi-sessions/` 是 pi 自己的会话文件。这两处是原样归档，没有经过任何加工。

每个归档文件旁边还有后端补记（同名的 `.backend.jsonl`）。除了启动命令、实际工具清单、提示、标准错误与退出码，
每次启动时它还记三样，观测台任务页的「知识的使用」就读它们：

- **已加载的 skill**：启动后经 RPC 的 `get_commands` 问 pi，来源是 skill 的那几项就是 pi 实际加载的 skill，
  记名字、描述与文件路径。pi 没起来或者这条命令没有回应时，如实记「取不到」与原因，不让启动因此失败。
- **上下文文件**（AGENTS.md 一类）：pi 的 RPC 没有查询这一项的命令，所以记「取不到」并写明原因；
  另记后端照 pi 的发现规则（pi 的配置目录，加上任务目录与它的每一级上级目录）在启动那一刻查到的文件，
  并注明那不是 pi 报告的。
- **知识仓库摘要**：启动 pi 之前那一刻，任务目录里 `.pi/skills/` 与 `docs/` 下每份文件的路径、字节数与
  内容摘要值（SHA-256 取前 16 位），加上代码仓里平台 skill 目录下的每份文件（带「来自：平台 skill」与它在代码仓里的路径）。
  只记摘要值，不记内容。「启动」那条记录里也有一项「平台 skill」，写着它在代码仓里的路径与摘要值。
