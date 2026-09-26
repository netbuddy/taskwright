# backend：任务服务的 TypeScript 版

这个目录是任务服务（给前端的 HTTP 接口）的 TypeScript 版，用来接替 `server/taskwright_server/service/` 里的 Python 版。
接口的路径、字段、错误形状与 Python 版逐字一致，前端不需要知道后面换了哪一版。两版在切换之前并存，行为靠双跑对照核对（见下文）。

代码由 Node 24 直接运行（去掉类型标注即可执行，不经构建），没有任何第三方依赖：HTTP 用 `node:http`，SQLite 用 `node:sqlite`。
完成条件的核对与建任务直接在同一进程里调用 `agent/src/lib` 的函数，与 pi 进程里的工具用的是同一份代码。

它**不写任务数据库**：库只由 pi 进程里的工具与扩展命令写。唯一的例外是建任务，而且也不在这里写，是调用 agent 侧的
`createTask` 核心函数。`tests/no_writes.test.ts` 扫描本目录全部文件，从 `agent/src/lib` 导入的名字必须在白名单里。

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
| `GET /api/v1/service` | 服务信息：`{ok, app, version, mode, pid, port, capabilities: {exit}}`，不需要任务。Python 版没有。 |
| `POST /api/v1/service/exit` | 退出服务：只在 `--mode desktop` 下有，只接受本机回环地址的请求（别处来的回 403 `forbidden`）；先回 `{ok: true}` 再收尾退出。Python 版没有。 |

## 目录里有什么

| 文件 | 它做什么 |
|---|---|
| `src/main.mts` | 入口：读命令行参数、建服务、监听端口；收到 SIGTERM、SIGINT 或桌面形态下的退出请求时关掉各任务的 pi、删掉本服务写的占用标记再退出。 |
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
| `fake_model/` | 假模型端点：按脚本回话的 OpenAI 兼容本地服务，给双跑对照与测试用，说明见其中的 README.md。 |
| `compare/compare.mts` | 双跑对照：对两个后端执行同一串操作，归一化后逐条比较响应。 |
| `compare/read_only.mts` | 已有任务的只读对照：不起服务，在进程内调用两版的拼装函数逐项比较。 |

## 起法

```
node backend/src/main.mts --tasks <放任务目录的上级目录> --runs <归档目录> --port <端口> [--mode desktop|server] [--host 地址] [--profile dev]
```

`--tasks` 与 `--runs` 不给时放在用户数据目录下（Linux 是 `~/.local/share/taskwright/`）。

`--mode` 是运行形态，缺省 `server`：

| 形态 | 缺省绑定地址 | 退出接口 |
|---|---|---|
| `server`（服务器用，缺省） | `0.0.0.0` | 没有（404） |
| `desktop`（单机桌面用） | `127.0.0.1` | 有，只接受本机请求 |

`--host` 给了以它为准。两种形态的日志写法相同：写标准输出，也追加到日志目录下当天的文件（`TASKWRIGHT_LOG_DIR`，缺省在用户数据目录的 `logs/` 下）。
运行形态写进启动日志与占用标记（`mode` 一项）。

`--port` 给的端口被占时依次试后面的端口，最多 10 个，全被占时报错退出；实际端口打印到日志、写进占用标记，并由 `GET /api/v1/service` 回出。

## 测试

```
cd backend && node --test 'tests/*.test.ts'
```

测试用的库由 `agent/tests/fixtures/` 里的夹具脚本写出（子进程运行，内部调用真实的写入函数），本目录不导入写入函数。
`scripts/test-all.sh` 已包含这一套。

## 双跑对照

先各起一个后端，各用自己的空目录（不要把已有的任务目录交给它们）：

```
python -m taskwright_server.service --tasks /tmp/a/tasks --runs /tmp/a/runs --port 8960
node backend/src/main.mts --tasks /tmp/b/tasks --runs /tmp/b/runs --port 8961
node backend/compare/compare.mts --a http://127.0.0.1:8960 --a-tasks /tmp/a/tasks --a-runs /tmp/a/runs \
                                 --b http://127.0.0.1:8961 --b-tasks /tmp/b/tasks --b-runs /tmp/b/runs --out result.json
```

脚本逐步打印「一致」或「差异」，全部一致时退出码为 0。归一化规则写在脚本开头的说明里。

已有的任务数据只做只读对照，不起服务：

```
node backend/compare/read_only.mts --tasks <已有的任务目录> --runs <已有的归档目录>
```

它在进程内调用两版的扫描与拼装函数，占用标记的写入换成不写文件的版本，库一律只读打开；输出不做归一化，逐字比较。
