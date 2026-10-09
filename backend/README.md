# backend：任务服务

这个目录是任务服务：给页面的 HTTP 接口，并启动、看护每个任务的助手程序（pi）。接口的写法见 `docs/api.md`。

代码由 Node 24 直接运行（去掉类型标注即可执行，不经构建）：HTTP 用 `node:http`，SQLite 用 `node:sqlite`。自己的第三方包有两个，版本都固定、头一次用到时才加载：docx（把选中的条目导出成 Word 文件时用）与 pdfjs-dist（读出上传的 PDF 文件里的文字时用）；校验图的 Mermaid 文本时用仓根 `node_modules` 里的 mermaid。
完成条件的核对与建任务直接在同一进程里调用 `agent/src/lib` 的函数，与 pi 进程里的工具用的是同一份代码。

它**不写任务数据库**：库只由 pi 进程里的工具与扩展命令写。唯一的例外是建任务，而且也不在这里写，是调用 agent 侧的
`createTask` 核心函数。`tests/no_writes.test.ts` 扫描本目录全部文件，从 `agent/src/lib` 导入的名字必须在白名单里。
白名单只收只读函数、常量、写材料旁边文件的函数（Word 文本投影与分段清单，写的是文件不是库）和 `createTask`；写库的函数不能加进去。

## 接口

前端用到的全部接口都已接上：

| 接口 | 说明 |
|---|---|
| `GET /api/v1/tasks`、`GET /api/v1/task-types`、`POST /api/v1/tasks` | 任务列表（含「占用中」「旧格式」两种打不开的任务）、任务类型、建任务。 |
| `GET …/tasks/{t}`、`GET …/sessions`、`POST …/sessions` | 任务页、会话列表、新建会话（新建时按需起 pi）。 |
| `GET …/snapshot`、`GET …/events`、`GET …/conversation` | 整份数据（带 session 参数时打开那条会话，按需起 pi 或续接）、事件流（SSE）、往前读对话。 |
| `POST …/messages` | 说一句话（斜杠改写、附件模板），或卡片点击（`origin` 为 `card_choice`，经扩展命令 `/tw-ui`）。 |
| `POST …/actions` | 直接操作：经扩展命令 `/tw-user` 写库，等结果 10 秒。 |
| `POST …/control` | 让助手停下（`action` 只能是 `stop`）：清掉排队的话、中止这一轮。 |
| `GET …/items/{i}/revisions`、`GET …/revisions` | 条目修订史、修订日志。 |
| `GET …/materials/content`、`GET …/materials/raw`、`POST …/materials` | 材料原文、原样取回、上传（Word 材料另生成文本投影）。 |
| `POST …/documents/preview`、`POST …/documents/download` | 按某次修订生成文档。 |
| `GET /api/v1/service` | 服务信息：`{ok, app, version, mode, pid, port, capabilities: {exit, model}, model: {name, reason}}`，不需要任务。`capabilities.model` 是模型探测的结果（见下文「模型探测」），`model.reason` 是一句写明查过哪两个文件的原因。 |
| `POST /api/v1/service/exit` | 退出服务：只在 `--mode desktop` 下有，只接受本机回环地址的请求（别处来的回 403 `forbidden`）；先回 `{ok: true}` 再收尾退出。 |

## 目录里有什么

| 文件 | 它做什么 |
|---|---|
| `src/main.mts` | 命令行入口：检查参数后调 `start.ts`。 |
| `src/start.ts` | 启动函数 `startService`（参数对象进，实际端口与停止函数出），命令行入口与打包后的启动程序都调它：建服务、监听端口；收到 SIGTERM、SIGINT、SIGHUP（Windows 另有 SIGBREAK）或桌面形态下的退出请求时关掉各任务的 pi、删掉本服务写的占用标记再退出。 |
| `src/web.ts` | 网页静态文件：给了 `--web` 时出页面，找不到的路径回首页，跳出目录的路径拒绝。 |
| `src/model_probe.ts` | 模型探测：启动配置写的模型在 pi 配置目录里有没有登记或登录。 |
| `src/listen.ts` | 按运行形态定缺省绑定地址；端口被占时依次换后面的端口。 |
| `src/http.ts` | 路由与各接口，以及查询串、multipart 的解析。 |
| `src/service.ts` | 任务服务：扫描任务目录、占用、任务列表、任务页、修订日志、上传材料、生成文档时「用户的话」的出处。 |
| `src/library.ts` | 只读读库、拼接口形状；完成条件在同一进程里调用 agent 的核对函数。 |
| `src/render.ts` | 按任务目录里的文档模板渲染 Markdown 文档。 |
| `src/conversation.ts`、`src/work_summary.ts` | 从 pi 会话文件拼对话记录、切出每一次工作（修订日志据此找出触发修订的那句话）。 |
| `src/launch.ts` | 读启动配置，拼 pi 的命令行与环境变量。 |
| `src/pi_session.ts` | pi 子进程与 RPC 收发，三种归档文件。 |
| `src/executor.ts` | 执行者看护：每个任务一个，启动、续接、切换会话，把 pi 事件翻译成过程与对话类事件，转交说话、卡片点击、直接操作与停下。 |
| `src/hub.ts` | 事件分发：订阅、库事件带序号补发、保活、兜底轮询。 |
| `src/sessions.ts` | 一个任务的会话文件：会话列表与会话条目。 |
| `src/workspace.ts` | 建任务：复制起始文件、写 pi 项目设置、调用 `createTask`，失败时整体清理。 |
| `src/occupancy.ts` | 任务占用标记 `service.lock`。 |
| `src/projection.ts` | Word 材料文本投影的薄适配：投影只有一份实现，这里只负责调用它。 |
| `src/paths.ts` | 仓根目录与各资源的位置（只在这一处从自身文件位置推出仓根），以及用户数据目录。 |
| `profiles/` | 启动配置：`dev.json` 开发与服务器用，`desktop.json` 桌面包用（除 Langfuse 环境标签外与 dev 相同），`fake.json` 测试用（模型换成假模型端点）。 |
| `prompts/executor_system_prompt.md` | 执行者的系统提示，启动配置的 `system_prompt_file` 指向它。 |
| `fake_model/` | 假模型端点：按脚本回话的 OpenAI 兼容本地服务，给测试与手工验证用，说明见其中的 README.md。 |

## 起法

```
node backend/src/main.mts --tasks <放任务目录的上级目录> --runs <归档目录> --port <端口> [--mode desktop|server] [--host 地址] [--profile dev] [--web 网页目录]
```

`--tasks` 与 `--runs` 不给时放在用户数据目录下（Linux 是 `~/.local/share/taskwright/`）。

`--mode` 是运行形态，缺省 `server`：

| 形态 | 缺省绑定地址 | 退出接口 |
|---|---|---|
| `server`（服务器用，缺省） | `0.0.0.0` | 没有（404） |
| `desktop`（单机桌面用） | `127.0.0.1` | 有，只接受本机请求 |

`--host` 给了以它为准。两种形态的日志写法相同：写标准输出，也追加到日志目录下当天的文件（`TASKWRIGHT_LOG_DIR`，缺省在用户数据目录的 `logs/` 下）。
运行形态写进启动日志与占用标记（`mode` 一项）。

`--port` 给的端口被占时依次试后面的端口，最多 10 个，全被占时报错退出；给 0 时由操作系统挑一个空闲端口。实际端口打印到日志、写进占用标记，并由 `GET /api/v1/service` 回出。

`--web <目录>` 给了网页静态文件所在的目录（例如构建好的 `web/dist`）时，由本服务出页面：不以 `/api/` 开头的 GET 请求从这个目录取文件，
找不到的路径回首页 `index.html`（前端是单页应用），解码后跳出目录的路径回 400。不给时行为不变，所有路径都归接口。开发时仍由 vite 出页面。

收到 SIGHUP（关掉终端；Windows 关掉控制台窗口时 Node 收到的也是它）与收到 SIGTERM 一样收尾。

### 模型探测

`GET /api/v1/service` 每次都现查：启动配置写的模型「服务商/型号」，在 pi 的配置目录（`PI_CODING_AGENT_DIR`，没设时是 `~/.pi/agent`）里
①模型登记文件 `models.json` 登记了这个服务商与型号，或②登录凭据文件 `auth.json` 里有这个服务商一项（只看键名，不读凭据内容），
二者之一即 `capabilities.model` 为 true。只读这两个文件，不起 pi。原因句 `model.reason` 在 desktop 形态写两个文件的完整路径，
server 形态只写文件名（服务信息远程也看得到，不带出服务器上的目录）。识别不了的情形：内置服务商的密钥只放在环境变量里，这时判 false，
原因句里写明。

### 桌面形态下的模型

`--mode desktop` 时，起 pi 之前读 pi 配置目录里 `settings.json` 的 `defaultProvider` 与 `defaultModel`（pi 的 `/model` 命令写的也是这两项），
两项都有就用「defaultProvider/defaultModel」代替启动配置里的模型；读不到或缺一项时照旧用启动配置里的。桌面包里的启动配置是只读的，
用户换模型靠的就是这个。模型探测与服务信息里的 `model.name` 按替换后的结果；后端补记的启动记录多写一项「模型来自」。
`--mode server` 不读这个文件，行为与启动记录都不变。实现在 `launch.ts` 的 `resolveModel`。

## 测试

```
cd backend && node --test --import ./tests/deadline.ts 'tests/*.test.ts'
```

每个测试文件有总时限（`tests/deadline.ts`，缺省 300 秒，慢机器上可用环境变量 `TASKWRIGHT_TEST_FILE_DEADLINE` 放宽）：到时还没结束的文件报为失败，多半是有服务器、连接或子进程没有关。
同一个文件还保证测试不碰用户自己的 pi 配置目录：没有设环境变量 `PI_CODING_AGENT_DIR` 时，它为每个测试文件的进程在系统临时目录下新建一个空目录并把变量指到它，进程退出时删掉；所以测试命令里的 `--import ./tests/deadline.ts` 不能省。
测试用的库由 `agent/tests/fixtures/` 里的夹具脚本写出（子进程运行，内部调用真实的写入函数），本目录不导入写入函数。
`scripts/test-all.sh` 已包含这一套。测试起后端时一律给端口 0（`tests/helpers.ts` 的 `spawnBackend`），几个会话同时跑测试也不会抢同一个端口。
几份测试拿 `tests/fixtures/expected/` 里的期望值逐字比较，说明见那里的 README.md。

