> 本文是英文版 [deployment.md](deployment.md) 的中文译本，两者不一致时以英文版为准。

# 部署（Deployment）

本文覆盖从一台新机器到服务跑起来的全部步骤：依赖、安装、模型接入、启动服务、端口、环境变量、生产构建、可选的 Langfuse 追踪、数据与备份、常见故障，以及不需要安装的桌面包（第 10 节）。服务跑起来之后怎么用，见[用户手册](user-guide.zh-CN.md)。

当前版本面向单机或可信的本地网络设计。目前还没有身份认证（authentication）机制；不要把这套服务暴露到公网。

## 1 依赖

| 项目 | 版本 | 使用方 |
|---|---|---|
| Node.js | 24 或更新（使用内置的 `node:sqlite`） | 任务服务、agent、web 构建、simulator 的工具与驱动程序 |
| Python | 3.12 或更新 | observatory、simulator 的驱动程序 |
| pi coding agent | `@earendil-works/pi-coding-agent` 1.0.4 | 运行执行者与模拟用户 |
| pi 能连到的一个模型 | pi 支持的任意服务商（见第 3 节） | 供执行者使用 |

任务服务由 Node.js 直接运行，自己的第三方包有两个：docx（把选中的条目导出成 Word 文件时用）与 pdfjs-dist（读出上传的 PDF 文件里的文字时用）；校验图的 Mermaid 文本时用页面那边装的 mermaid。三样都随 `make install` 装好。观测台只需要 Python 标准库。跑测试需要 pytest，它随 `observatory` 这个包的 `[test]` 附加项（extra）一起安装。

## 2 安装

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.4
git clone https://github.com/netbuddy/taskwright.git && cd taskwright
python3 -m venv .venv && . .venv/bin/activate
make install
```

`make install` 依次执行 `npm ci`（npm workspaces：agent、web、sim）与 `python3 -m pip install -e 'observatory[test]'`。不想装 pytest 时，改为执行 `npm ci` 与 `python3 -m pip install -e observatory`。

观测台与模拟用户的驱动程序用 `PATH` 里的 `python3` 运行，并且要用到上面装的 `observatory` 包，所以每开一个新终端，启动它们之前都要先激活虚拟环境（在代码仓根目录执行 `. .venv/bin/activate`）。不激活就会因找不到 `taskwright_observatory` 模块而报 `ModuleNotFoundError` 退出。模拟用户不需要 `server` 包；它经 Node.js 启动任务服务与模拟用户的 pi，所以 `PATH` 里还要有 Node.js 与 pi。任务服务、`scripts/dev.sh` 与 `scripts/tui.sh` 由 Node.js 运行，不需要虚拟环境。示例脚本 `examples/library-lending/run.sh` 是例外：它只需要 `curl` 和一个 `python3`。

## 3 模型接入

Taskwright 自己不直接调用模型，调用模型的是 pi；执行者用的是 pi 启动时指定的那个模型。模型写在启动配置文件（startup profile）`backend/profiles/dev.json` 里：

```json
"model": "openai/gpt-6-luna",
"thinking": "medium",
```

模型名的写法是「服务商/模型」（`provider/model`）。要换模型，可以直接改 `dev.json` 里的 `model`，也可以把它复制成 `backend/profiles/<name>.json`、改好副本，再给任务服务或 `scripts/tui.sh` 传 `--profile <name>`。启动配置里的文件路径（`system_prompt_file`、`platform_skill`、代码仓自带扩展的 `path`）按代码仓根目录解析；写成绝对路径时照原样使用。`pi --list-models [关键词]` 列出 pi 认识的模型及其服务商名；`pi auth check --provider <服务商>`（或 `--model <服务商/模型>`）可以在启动服务之前检查 pi 是否有可用的凭据；凭据可用时它打印 `ready`。

pi 把凭据与自定义模型存放在 `~/.pi/agent/` 下（`auth.json` 与 `models.json`；环境变量 `PI_CODING_AGENT_DIR` 可以改这个目录）。任务服务用它自己的环境变量启动 pi，所以在启动服务的那个终端里设置的环境变量会传到 pi。

模型服务也可以在网页界面上配置，经[接口参考](api.zh-CN.md)第 10 节的那组接口。这时任务服务在 `models.json` 与 `auth.json` 里加上它自己的几项，名字是 `taskwright-…`，文件里别的内容原样保留；每次改之前在文件旁边存一份备份（`<文件名>.taskwright-backup-<时刻>`，只留最近 5 份）。在那里选定的语言模型优先于启动配置，桌面包里也优先于 pi 的 `settings.json`。它从下一次打开或者新建会话起使用，改了之后重新打开的旧会话也用它；正在进行的会话不受影响。选了什么记在产品自己的设置文件里：数据目录下的 `settings.json`（数据目录怎样定见第 8.1 节；没有另给时是用户数据目录，Linux 是 `$XDG_DATA_HOME/taskwright/`，缺省是用户主目录下的 `.local/share/taskwright/`），设了 `TASKWRIGHT_SETTINGS_FILE` 时是它指的文件。这个文件里不存密钥。

接入模型有三条路径。

**不自动访问外网。** 各个启动配置的 `flags.offline` 都是真，任务服务启动 pi 时带 `--offline`：pi 不自己访问外网，不去取更新的模型目录，不检查新版本，找不到搜索工具 rg、fd 时也不去下载。向模型服务发的请求不受影响。由此有两件事要知道。一、助手的 `grep` 与 `find` 两个工具要用 rg 与 fd：桌面包自带；自己安装的机器，最简单的办法是先在命令行里不带 `--offline` 运行一次 `pi`，让它自己下载。二、pi 自带的模型目录不会自己变新：用 ChatGPT 订阅的，在设置页面 Codex 订阅的详情里点「更新模型目录」，或者运行 `pi update --models`。要让 pi 照旧自己访问外网，把启动配置里的 `offline` 改成 `false`。

### 3.1 默认路径：ChatGPT（Codex）订阅

默认启动配置用的是 `openai/gpt-6-luna`，需要一个 ChatGPT Plus 或 Pro 订阅，并在 pi 里登录：

```bash
pi                 # 在任意目录启动一次 pi 的交互模式
/login             # 在 pi 里选择 OpenAI，按提示用 ChatGPT 订阅登录
```

令牌（token）保存在 `~/.pi/agent/auth.json`，过期后自动刷新。用 `pi auth check --provider openai` 检查。pi 更早的版本另有一个登录入口（列表里的 OpenAI Codex (legacy)），凭据记在 `openai-codex` 名下；Taskwright 不再用它，只在那里登录过的电脑要用上面的入口重新登录一次。任务服务以 RPC 模式启动 pi，这种模式下无法登录，所以要事先用运行服务的同一个操作系统用户登录一次。

### 3.2 服务商接口密钥（OpenAI、Anthropic 等）

两种做法任选其一：启动服务之前设置该服务商的环境变量；或者把密钥写进 `~/.pi/agent/auth.json`（在 pi 里执行 `/login` 并选择接口密钥类服务商，写的也是这个文件）：

```bash
export OPENAI_API_KEY=...        # 对应的模型名形如 openai/<模型编号>
export ANTHROPIC_API_KEY=...     # 对应的模型名形如 anthropic/<模型编号>
```

```json
{
  "openai":    { "type": "api_key", "key": "..." },
  "anthropic": { "type": "api_key", "key": "..." }
}
```

其他服务商各有自己的变量（例如 `GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`）；`pi --help` 会列出这些变量，pi 的[服务商文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md)给出每个服务商在 `auth.json` 里的键名。`auth.json` 里的密钥优先于环境变量。然后把启动配置里的 `model` 改成 `pi --list-models anthropic` 这类命令列出的名字，例如 `"anthropic/<模型编号>"`。

### 3.3 本地 OpenAI 兼容端点（Ollama、llama.cpp）

在 `~/.pi/agent/models.json` 里把端点登记成一个自定义服务商（custom provider）：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [ { "id": "<模型在服务端的名字>" } ]
    }
  }
}
```

接 llama.cpp 的 `llama-server` 时，用同样的写法再加一个服务商，名字自定（例如 `llamacpp`），`baseUrl` 写它的 OpenAI 兼容地址，默认是 `http://127.0.0.1:8080/v1`。服务端不校验密钥时，`apiKey` 只是个占位值，但 pi 要求有一个值才会把这个模型当作可用。然后把启动配置里的 `model` 改成 `"ollama/<模型名>"`（或 `"llamacpp/<模型名>"`）。各字段的含义（`contextWindow`、`maxTokens`、`reasoning`、`compat` 各开关）见 pi 的[自定义模型文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md)。pi 另有一个专门对接 llama.cpp 路由服务器（router）的服务商，用 `/login llama.cpp` 配置，见 pi 的 [llama.cpp 文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/llama-cpp.md)。

Taskwright 依赖模型稳定地调用工具：每次回复都经 `reply` 工具发出，每次保存都经 `save_revision` 工具并带结构化参数。能力较弱的本地模型可能反复产生被拒的调用；被拒的频率可以在观测台里看到。

## 4 启动各项服务

| 服务 | 命令 | 默认端口 |
|---|---|---|
| 任务服务（HTTP/SSE 接口） | `node backend/src/main.mts [--data <dir>] --tasks <dir> --runs <dir> [--knowledge <dir>] --port <port> [--mode desktop\|server] [--host <address>] [--profile <name>] [--web <dir>]` | 无默认值，需自行指定 |
| 网页界面（开发服务器） | `TASKWRIGHT_API_TARGET=http://127.0.0.1:<api port> npm run dev -w web` | 5680（`TASKWRIGHT_WEB_PORT`） |
| 两者一起启动 | `scripts/dev.sh`（或 `make dev`） | API 8790，web 5680 |
| 两者一起启动，用假模型并建好演示任务 | `scripts/dev.sh --demo` | API 8790，web 5680 |
| 观测台 | `python3 -m taskwright_observatory --runs <archive dir> --workspaces <tasks dir>` | 8770 |

- `--tasks` 是任务目录的创建位置（每个任务一个目录，以任务编号命名）；`--runs` 是每个任务的原始 pi 事件与会话文件的归档位置（`<runs>/<task id>/pi-events/` 与 `pi-sessions/`）。`--knowledge` 是知识库的根目录：各任务选用的参考资料库（接口文档第 11 节）。三者不给时都放在用户数据目录下（Linux 是 `~/.local/share/taskwright/`），分别是 `tasks/`、`runs/` 与 `knowledge/`；给了 `--data <dir>` 或环境变量 `TASKWRIGHT_DATA_DIR` 时放在那个目录下。任务登记 `service.sqlite`、升级前的备份 `backups/` 与升级报告也在数据目录下（数据目录怎样定、怎样升级见第 8.1 节）。
- 任务类型也在数据目录下的 `task-types/`：每种一个子目录（随附的一种是 `requirements-engineering/`，即「需求工程」），新建任务从这里复制。服务启动时，产品自带的任务类型（安装位置的 `task-types/`）里数据目录下还没有的，整个复制过来，`task-types/manifest.json` 记下每种是从产品自带的第几版、什么时候、由哪个产品版本复制来的；已经有的一律不覆盖，所以升级产品不会改掉数据目录里的任务类型。每种任务类型的每个修订存一份完整目录，在 `task-types/.revisions/<键>/<修订号>/`（复制来的那一刻是修订 1），修订的经过（时刻、谁改的、说明、改了哪些文件）记在 `service.sqlite` 里。数据包暂时不带 `task-types/`。
- 各服务默认绑定 `0.0.0.0`（可用 `--host` 更改）。唯一的例外是以 `--mode desktop` 启动的任务服务，它默认绑定 `127.0.0.1`。
- 任务服务有一个运行形态参数 `--mode desktop|server`（缺省 `server`）。`server` 用于多人共用的服务器：默认绑定 `0.0.0.0`，没有退出接口。`desktop` 用于一个人在自己电脑上使用：默认绑定 `127.0.0.1`，并多出一个只接受本机请求的 `POST /api/v1/service/exit`。两种形态下 `--host` 都优先于默认地址。两种形态的日志写法相同：写到标准输出，同时追加到 `TASKWRIGHT_LOG_DIR` 下当天的文件（缺省是数据目录下的 `logs/`）。`GET /api/v1/service` 与退出接口的说明见 `docs/api.zh-CN.md` 第 9 节。只有在本机打开的页面才有退出的入口；服务按请求的来源地址判断是不是本机，所以桌面形态不要放在反向代理后面（否则服务看到的是代理的地址）。
- 任务服务的 `--debug`（缺省不带）打开调试模式：设置页面多一栏「调试」，里面可以设一个提示词目录；工作视图的右侧栏多一个「调试」页签，任务页多一个「导出为用户画像」，另多几个调试用的接口（接口文档第 13 节）。这些接口没有另外的访问控制，而服务器形态缺省绑定全部网卡，所以调试模式只在自己的机器上用，用完去掉这个参数重新启动。`scripts/dev.sh --debug` 与桌面安装包的启动程序都把这个参数原样传给任务服务。
- **任何能打开页面的人都能修改模型配置。** 在加登录之前，任何能打开这个网址的人都能在网页界面上修改模型配置，包括换掉 API 密钥、删除模型服务。以 `--mode server` 启动的任务服务，只在可信的内网里部署。
- 给任务服务的端口被占用时，它会依次尝试后面的端口，最多共试 10 个，全部被占时报错退出。给 `--port 0` 时由系统挑一个空闲端口。实际使用的端口会打印到日志、写进各任务的占用标记，并由 `GET /api/v1/service` 返回。
- `scripts/dev.sh` 在 `TASKWRIGHT_API_PORT`（缺省 8790）上起任务服务，并把网页开发服务器指向任务服务报出的实际端口，所以端口被占时网页不会被转到别的服务上。加 `--demo` 时，任务服务用假模型端点（`tools/fake-model/`）与启动配置 `fake` 运行，任务、归档与知识库放在退出时删除的临时目录里，并由 `examples/library-lending/run.sh` 建好一个带示例材料与几个条目的演示任务；不需要模型服务与密钥，但 `PATH` 里要有 pi。`--demo` 只是让你看页面的样子：假模型照固定的脚本回答，这不算走查产品；要走查，不带 `--demo` 启动并接上真的模型。
- 任务服务给了 `--web <dir>`（例如构建好的 `web/dist`）时，自己托管网页：不以 `/api/` 开头的 GET 请求从这个目录取文件，找不到的路径回首页。这样不需要第 6 节的反向代理，也不需要开发服务器。
- 以 `--mode desktop` 启动的任务服务，起 pi 之前读 pi 配置目录里 `settings.json` 的 `defaultProvider` 与 `defaultModel`，两项都有就用它们代替启动配置里的模型（见第 10.4 节）；`--mode server` 不读这个文件。
- 用 Ctrl+C 或按进程编号（process id）停止服务；任务服务收到 SIGHUP（关掉它所在的终端或 Windows 的命令行窗口）时也同样收尾。任务服务退出时会顺带关闭它为每个任务启动的 pi 进程。

## 5 环境变量

| 变量 | 使用方 | 含义 |
|---|---|---|
| `TASKWRIGHT_RUNS_DIR` | `scripts/tui.sh`、观测台、`scripts/dev.sh` | 命令行未指定归档目录时使用的默认值（默认 `./runs`）。 |
| `TASKWRIGHT_WEB_PORT` | web 开发服务器 | 端口（默认 5680）。 |
| `TASKWRIGHT_API_TARGET` | web 开发服务器 | `/api` 代理转发的目标地址（默认：本机的任务服务 `http://127.0.0.1:8790`，即 `scripts/dev.sh` 起任务服务的端口）。 |
| `TASKWRIGHT_TASKS_DIR`、`TASKWRIGHT_API_PORT` | `scripts/dev.sh` | 任务目录的根路径与 API 端口。 |
| `TASKWRIGHT_KNOWLEDGE_DIR` | `scripts/dev.sh` | 知识库的根目录（默认 `./knowledge`）。 |
| `TASKWRIGHT_TASKS_ROOT` | agent | 服务启动 pi 时设：任务根目录。不在它之下的任务库拒绝写入。单独跑 agent 代码时（命令行工具、测试）不设，也就不核对。 |
| `TASKWRIGHT_LOG_DIR` | 任务服务 | 任务服务追加每日日志文件 `backend-<日期>.log` 的目录（缺省是数据目录下的 `logs/`；数据目录怎样定见第 8.1 节，没有另给时是用户数据目录）。 |
| `TASKWRIGHT_LANGFUSE_PLUGIN` | 任务服务、`scripts/tui.sh` | 可选的 Langfuse 插件所在的位置（见第 7 节）。 |
| `TASKWRIGHT_LANGFUSE_ENV_FILE` | 任务服务、`scripts/tui.sh`、observatory | 保存 Langfuse 地址与密钥的文件。 |
| `TASKWRIGHT_LANGFUSE_PROJECT_ID` | observatory | Langfuse 项目编号，用于生成直达链接。 |
| `TASKWRIGHT_SIM_MATERIALS_DIR` | simulator | 存放模拟用户画像所用材料的目录。 |
| `TASKWRIGHT_DATA_DIR` | 任务服务、桌面包的启动程序 | 数据目录：任务登记、任务类型（`task-types/`）、升级前的备份与升级报告放在这里；任务目录、归档目录与知识库目录没有另给时也在它下面。命令行的 `--data` 优先于它（见第 8.1 节）。 |
| `TASKWRIGHT_SETTINGS_FILE` | 任务服务 | 产品自己的设置文件：在网页界面上选定的模型与登记的模型服务（缺省是数据目录下的 `settings.json`；数据目录没有另给时是用户数据目录）。先前的版本不论数据目录在哪里，都把这个文件放在用户数据目录下：没有设这个变量、数据目录下还没有 `settings.json` 而用户数据目录下有时，任务服务启动时复制一份过来（原件不删），日志里写一句「产品设置从……复制到……；以后只读新的一份」。测试与试用环境把它指到临时文件。 |
| `OPENAI_API_KEY` 等服务商变量 | pi | 模型凭据，见第 3.2 节。 |

## 6 网页界面的生产构建

运行 `npm run build -w web`，然后用一个反向代理托管 `web/dist/`，把 `/api` 转发给任务服务；也可以不用反向代理，给任务服务 `--web web/dist`（见第 4 节）。要为 `/api/v1/tasks/*/events` 关闭响应缓冲（因为它是一条服务器推送事件流），并调高读超时时间。反向代理自己的请求体上限要设得不小于上传上限再加上 multipart 包装的余量（nginx 写 `client_max_body_size 6m;`，它的缺省是 1 MB），否则较大的上传会被代理用它自己的错误页拒绝，用户看不到任务服务的那句话。没有 HTTP/2 时，浏览器对同一主机只允许大约六个并发连接，所以每个浏览器最多同时打开四个任务页面。

## 7 可选：Langfuse 追踪

追踪功能是可选的；不启用它系统照样能正常运行。它使用官方的 pi 可观测性插件（observability plugin）**pi-observability-plugin**，本次发布固定使用其仓库的 `2509b35` 提交。

1. 检出（check out）该插件到那个提交，并把 `TASKWRIGHT_LANGFUSE_PLUGIN` 指向它所在的目录（该目录须包含 `src/index.ts`）。
2. 把连接信息写进仓库之外的一个文件，每行一个 `名称=值`，再把 `TASKWRIGHT_LANGFUSE_ENV_FILE` 指向它：

   ```
   LANGFUSE_BASE_URL=https://<your Langfuse host>
   LANGFUSE_PUBLIC_KEY=<public key>
   LANGFUSE_SECRET_KEY=<secret key>
   TASKWRIGHT_LANGFUSE_PROJECT_ID=<project id>
   ```

   把这个文件设为只有你自己可读（`chmod 600`）。密钥只通过环境变量传给 pi，绝不写在命令行里，因为同一台机器上的其他用户可能在进程列表里看到命令行内容。
3. 环境标签（environment tag）默认取自配置文件里的 `langfuse.environment`；某次运行想覆盖它时，设置 `LANGFUSE_TRACING_ENVIRONMENT`。

## 8 数据与备份

每个任务目录下都有 `task.sqlite`，在 WAL 模式下还会有 `task.sqlite-wal` 与 `task.sqlite-shm`。要么把这三个文件一起复制，要么先停掉该任务对应的 pi 进程，再做一次检查点（checkpoint）：

```bash
python3 -c "import sqlite3; sqlite3.connect('<task dir>/task.sqlite').execute('PRAGMA wal_checkpoint(TRUNCATE)')"
```

做完检查点之后，单独一个 `task.sqlite` 文件就是完整的。对话本身不在数据库里，而在 `<runs>/<task id>/pi-sessions/` 下 pi 的会话文件里；想保留对话，这些文件也要备份。

**一个任务只由一个服务服务。** 在跑的服务往它服务的每个任务目录里写一份 `service.lock`（端口、进程号、启动时刻、主机名），停下时删掉。另一个服务看到同一台主机上一个活着的进程写的标记（或者别的主机写的任何标记），就不接手这个任务：列表里写「占用中」和占着它的服务的端口，打开它的请求一律拒绝。进程已经不在了的标记是崩溃留下的，接手时覆盖，并在日志里写一行。看一份标记：`cat <任务目录>/service.lock`。

**复制或搬动任务数据。** 任务目录里的路径都是相对的，任务目录可以搬家或复制。pi 的会话文件记着它当初是在哪个任务目录里开始的；服务续接这样的会话时，如果记着的目录不是自己的任务目录，就把会话文件第一行改写为自己的任务目录（原文件原样留在旁边，名为「….cwd-时刻.bak」），日志里写「会话文件记的工作目录是 X，已按本服务的任务目录 Y 续接」。服务还把自己的任务根目录传给 pi（`TASKWRIGHT_TASKS_ROOT`），不在它之下的任务库一律拒绝写入。所以复制出来的服务不会写回原来的任务数据。在副本上起服务之前先停掉原来的服务，否则副本会显示为占用中。

**知识库。** 知识库根目录下有 `libraries.json`，每个知识库一个目录，里面是 `documents.json` 与放文档本体的 `files/`（Word 文档旁边还有文字版等生成的文件）。备份时把整个目录一起复制。两个 JSON 文件每次都整份替换（先写临时文件再改名），所以服务在跑时复制下来的要么是旧清单、要么是新清单；恰好在那一刻上传的文档可能已经在 `files/` 里、还不在清单里。任务选用了哪些库记在任务目录的 `knowledge.json` 里，随任务一起备份。

### 8.1 升级到新版本

新版本的程序遇到上一版留下的数据，会把它升到现在的格式，任务的内容不变。现在只升级格式 8 起的任务库（本版本开发期间建的任务）；0.5.0 与更早的版本建的任务不再升级，任务列表里标「旧格式」并写明它的格式，打不开，启动、`data upgrade` 与导入数据包都不改它。

这一版把格式 8 的任务升到格式 9 时另做三件事，升级报告里逐一写明：任务类型「软件需求规格说明编制」（键 `srs-authoring`）改名「需求工程」（键 `requirements-engineering`），任务目录里的任务定义文件与 skill 目录、任务库里的定义、`task.json` 里的类型名一起改；集合「总体分析」改名「业务说明」，任务定义、条目、事件与随任务类型复制进任务目录的文件一起改，材料不动，评审规则文件随之改了字，已有的评审仍算作当前规则下评的；任务定义里的「右侧栏页签」一项去掉。数据目录的格式也从 1 升到 2（`service.sqlite` 多一张任务类型修订表），与任务一起升级。

**数据的版本记在哪里。** 每个任务库记着自己的格式版本；任务目录里的 `task.json` 记着这个任务是哪个产品版本建的、最近一次是哪个版本升级的；数据目录下的 `service.sqlite`（任务登记与任务类型的修订记录）记着数据目录的格式版本与最近写它的产品版本。数据目录是 `--data` 给的目录，没有给时看环境变量 `TASKWRIGHT_DATA_DIR`，再没有时取 `--tasks` 的上一级目录，都没有就是用户数据目录。

**升级走哪条路，看运行形态。**

- **桌面形态（`--mode desktop`，桌面包就是这样）。** 启动时发现有上一版留下的任务，程序照常起来，但页面整屏显示「数据升级」：要升级几个任务、备份放在哪里。点「开始升级」后一个任务一个任务地做，页面显示做到第几项。都做成了，页面自动进入正常界面；有任务没有做成时，页面停在这里显示报告，点「继续使用」进入正常界面。升级做完之前，别的功能都不能用。
- **服务器形态（`--mode server`）。** 启动时发现有上一版留下的任务，服务不启动，日志与标准错误里写明原因，退出码是 1。管理员先运行下面的命令，做完再启动服务。这样不会有人访问到升级了一半的数据。提示里给的就是要运行的完整命令：任务目录或知识库目录不在数据目录下面时（启动服务时另给了 `--tasks`、`--knowledge`），命令里带着同样的参数，照抄即可；升级报告的开头写着这一次扫的是哪个任务目录。

```bash
node backend/src/main.mts data upgrade --data <数据目录>     # 桌面包：taskwright-x86_64.AppImage data upgrade [--data <数据目录>]
```

这条命令不起服务。有服务正在用这个数据目录时它不做（任务目录里有活着的占用标记），先停下那个服务。它的退出码：0 是都升级成了，或者本来就没有要升级的；1 是有任务没有做成，或者整体没有做成；2 是没有做（参数不对、有服务在用、数据比这个程序新）。桌面形态也可以用这条命令代替页面上的升级。

**备份。** 升级之前，程序把要改的文件复制到数据目录下的 `backups/<年月日-时分秒>-<旧产品版本>/`：每个要升级的任务的任务库（`tasks/<任务目录名>/task.sqlite`，是完整的副本）与它的 `task.json`、任务登记 `service.sqlite`、产品设置文件 `settings.json`、知识库清单 `knowledge/libraries.json`。有一样复制不成，就一个任务都不升级。备份不会自动删除，确认新版本用着没有问题之后可以手工删掉。

**报告。** 每次升级写一份报告到数据目录下的 `logs/upgrade-<年月日-时分秒>.txt`，页面与命令行显示的是同一份：每个任务从哪个格式升到哪个格式、成功还是没有做成与原因、用了多久，合计，以及备份的位置与大小。

**一个任务没有做成。** 它原样不动，别的任务照常升级。服务起来之后，它在任务列表里标「需要处理」并写着原因，打不开；下次启动不再自动重试它。原因去掉之后（例如占着它的另一个服务停了），运行上面的命令，命令每次都把没有做成的任务再试一遍。

**回到旧版本。** 新版本升级过的数据，旧版本的程序不打开，会提示「这份数据由 x 写入，请用 x 或更新的版本打开」。要退回去：停下服务，装回旧版本的程序，把备份里的文件复制回原来的位置（任务库复制回各任务目录，并删掉任务目录里新版本写的 `task.json` 与数据目录下的 `service.sqlite`），再启动。升级之后在新版本里做的改动不在备份里。

**任务类型的说明不随升级更新。** 任务目录里的说明与评审规则是建任务时复制进来的，升级不改它们。任务类型的说明有版本号；一个任务用的那一版与产品自带的不同时，任务页上写「任务类型说明是 x 版，当前产品自带的是 y 版」。

### 8.2 导出与导入

**数据包**是一个 zip 文件（文件名以 `.taskwright.zip` 结尾），里面是任务与知识库的一份副本。换一台机器、把单机上的数据搬到服务器上、升级之前先留一份，都用它。导出不改原来的数据。

**三个范围。** 整套（一个数据目录里的全部任务与知识库）、一个任务、一个知识库。整套只能用命令行导出与导入；一个任务、一个知识库既可以用命令行，也可以经服务的接口（接口文档第 12 节）。

**命令。** 都不起服务。桌面包把 `node backend/src/main.mts` 换成安装包的文件名，例如 `taskwright-x86_64.AppImage data export …`。

```bash
node backend/src/main.mts data export --data <数据目录> --to <数据包>                       # 整套
node backend/src/main.mts data export --data <数据目录> --task <任务编号> --to <数据包>      # 一个任务
node backend/src/main.mts data export --data <数据目录> --task <任务编号> --with-events --to <数据包>  # 一个任务，带上事件归档
node backend/src/main.mts data export --data <数据目录> --with-materials --to <数据包>       # 整套，带上材料与知识库文档的原件
node backend/src/main.mts data export --data <数据目录> --library <知识库编号> --to <数据包>  # 一个知识库
node backend/src/main.mts data import --data <数据目录> --from <数据包> [--renumber]
node backend/src/main.mts data upgrade --pack <数据包> --to <新的数据包>
```

- `data export`：服务开着也可以导出，正在使用的任务照样带上（包里记着导出时它正在使用）。还没有升级的数据目录也可以导出。`--to` 的文件已经在时不覆盖。事件归档（`runs/<任务编号>/pi-events/`，助手每一步的原始记录与运行日志）缺省不带，只带对话记录；查问题要用它们时加 `--with-events`。材料与知识库文档的原件和它们的文字版、分段清单、位置表缺省也不带，只带一张材料清单与一张文档清单（记在清单文件里）；换机器、要连原件一起搬时加 `--with-materials`（接口是 `?with_materials=1`）。命令行导出没有启动配置，清单里的分段参数写默认值；经服务的接口导出时写服务实际用的值。
- `data import`：有服务正在用这个数据目录时不做，先停下它（或者经服务的接口导入）；这个数据目录自己有上一版的数据还没有升级时也不做，先运行 `data upgrade`。目标可以是一个空目录。
- `data upgrade --pack`：把一个旧版本的数据导出的包升到现在的格式，写成一个新的包，原来的包不动；不需要数据目录。导入时遇到旧格式的包会自己先升级，所以这条命令只在想先得到一个新格式的包时才用。
- 退出码：0 是都做成了（导入时因为已经存在而跳过的不算没有做成）；1 是有任务或知识库没有做成，或者导出时有任务目录没有带上；2 是没有做（参数不对、数据目录正被服务使用、数据包不对或者比这个程序新、目标文件已经在）。

**包里有什么。**

| 包里的路径 | 内容 |
|---|---|
| `tasks/<任务编号>/` | 任务目录：任务库（一份完整的副本）、`docs/`、`task.json`、选用的知识库、建任务时放进来的设置与方法说明。材料目录 `inputs/` 缺省只是一个空目录，导出时加 `--with-materials` 才带里面的文件 |
| `runs/<任务编号>/` | 这个任务的归档，原样：对话记录（`pi-sessions/`）。事件归档（`pi-events/`）缺省不带，导出时加 `--with-events` 才带。没有对话过的任务没有这一部分 |
| `knowledge/<知识库编号>/` | 知识库目录：文档清单 `documents.json`。`files/` 下的文档、文字版、片段与向量化得到的数字串缺省不带（`files/` 只是一个空目录），导出时加 `--with-materials` 才带 |
| `knowledge/libraries.json` | 包里这些知识库在知识库清单里的条目 |
| `service/tasks.json` | 包里这些任务在任务登记里的行 |
| `说明.txt` | 给人看的说明：包里有什么、没有什么、怎样导入。不在清单文件里，导入时不解出来 |
| 清单文件（包里名为 `manifest.json`） | 包的格式版本、导出它的产品版本、数据的格式版本、导出时刻、范围、带没带事件归档与材料原件、任务与知识库的清单，以及每个文件的路径、字节数、SHA-256 与修改时刻。每个任务另有材料清单（`materials`：每份材料的路径、槽位、角色、放进来的时刻、字节数与 SHA-256，它的文字版、分段清单、位置表各自的字节数与 SHA-256，分段清单的块数），每个知识库另有文档清单（`documents`：照抄 `documents.json`）；`projection` 一节记生成文字版与分段清单所用的规则版本与分段参数。带不带原件，这两张清单都写 |

**包里没有**产品设置、模型配置与密钥，所以在新的机器上要重新配置模型服务（第 3 节）；缺省也没有事件归档，也没有材料与知识库文档的原件和文字版；也没有占用标记、任务库旁边的日志文件与各种临时文件。没有事件归档的任务照常导入、照常使用，观测台里它的会话写「没有事件归档」。不带原件的包并不干净：条目里有原文的逐字摘录，业务说明里有转述，对话记录也在包里。

**不带材料的包导入之后**，任务照常能打开。材料页上，材料表里记着而文件不在的每份材料都列出来，大小一栏写「文件缺失，请补齐」，「查看」是灰的；在原文页签打开它、或者读它的两个接口，得到的是「文件缺失，请补齐：<文件名>」（错误码 `material_missing`）。助手要读这样的材料时会被拦下，并得到「请用户在材料页补齐后再读」的提示，不会凭记忆补写内容。

**导入怎样做。** 先核对整个包：清单文件读得出来、包不比这个程序新、包里的文件与清单文件一一对应、每个文件的 SHA-256 与清单文件记的相同。有一处不对，整个包都不导入，数据目录原样不动。核对通过之后一项一项导入，一项没有做成不影响别的。文件的修改时刻照导出时的样子恢复，所以进入过对话的材料导入之后仍然不能删除、不能替换。

- **编号已经有任务在用。** 缺省跳过这个任务并写进报告。加 `--renumber`（接口是 `?renumber=1`）时改成一个新编号导入，两个任务并存：任务库、任务目录、归档目录与任务登记都用新编号；归档的内容原样，里面出现的旧编号不改。
- **知识库不改编号**，`--renumber` 对知识库不起作用。知识库编号写在文档的文字版与任务来源的出处里，改了它们就会指错库。数据目录里没有这个编号的库时照常导入；有而它是空的，就导入到它的位置上；有而里面有文档，就跳过并写进报告，包里那个库的文档要在知识库页面另行上传。编号不同而名字与已有的库相同时，名字后面加「（导入）」。
- **旧版本的数据。** 包里的任务是上一版的格式时，导入之前先把它升到现在的格式（与第 8.1 节的升级是同一段代码），不另留备份——包本身就是备份。升不了的任务不导入，报告里写原因。
- **比这个程序新的包**不导入，提示「这份数据由 x 写入，请用 x 或更新的版本打开」。
- **报告。** 每次导入写一份报告到数据目录下的 `logs/import-<年月日-时分秒>.txt`，命令行打印的是同一份：导入了什么、跳过了什么与原因、改了哪些编号、哪些任务先做了升级。

**换一台机器。** 在旧机器上运行 `data export --data <数据目录> --with-materials --to all.taskwright.zip`（换机器要连材料原件一起带）；把这个文件带到新机器；在新机器上装好程序，运行 `data import --data <数据目录> --from all.taskwright.zip`；配置模型服务，启动。

**把单机上的数据搬到服务器上。** 办法相同：在单机上导出整套（或者一个个任务），在服务器上停下服务后用 `data import` 导入，再启动服务；只搬一两个任务时也可以不停服务，经接口导入。服务器上已经有同编号的任务时按上面「编号已经有任务在用」处理。

**限制。** 一个数据包不能超过 4 GB，里面的文件不能超过 65534 个，一个文件也不能超过 4 GB；超过时导出被拒绝并说明，这时按任务、按知识库分开导出。经接口导入的包不能超过 1 GB，更大的用命令行。服务被强行停掉时，没有做完的导入会在任务、归档、知识库三个目录下留下名字以 `.importing-` 开头的目录；服务启动时把留了一小时以上的自动清掉（不到一小时的可能是命令行正在做的一次导入，不动）。

**保管。** 数据包里有条目与对话记录的副本（加了 `--with-materials` 的还有材料与知识库文档的原件），没有加密：拿到包的人就能读到里面的全部内容。包放在哪里、给谁，照这些材料本来的保密要求办；用完不再需要的包要删掉。

## 9 常见故障

**助手启动不起来。** 工作视图整页只读，输入框上方的提示条在「助手现在不可用：助手没有启动起来，」后面写明原因。PATH 里找不到 pi，或者 pi 脚本开头指定的解释器不存在时，写「找不到助手的程序（pi），请检查安装。」。系统拒绝启动时只写系统给的英文代号：文件没有执行权限时是「系统原因：EACCES」，命令行太长时（系统提示整份放在命令行里）是「系统原因：E2BIG」，打开的文件数、内存或进程数到了上限时是「系统原因：EMFILE」「ENFILE」「ENOMEM」或「EAGAIN」。启动配置或环境变量写错（系统提示文件、扩展、密钥文件不存在等）时照原样写出是哪一项。另有三种情形，提示条整句是固定的：助手的程序启动之后立刻退出时写「助手现在不可用：助手启动之后立刻退出了。请把这个页面的地址告诉管理员。」；启动之前任务服务没能建好归档目录、打开归档文件或备份并改写要续接的会话文件（没有写权限、磁盘满）时写「助手现在不可用：启动助手之前，任务服务没能写入它要用的文件，系统原因：EACCES。请把这个页面的地址告诉管理员。」，系统原因取不到时写「系统原因：未知」；其他没有预料到的错误写「助手现在不可用：助手没有启动起来。请把这个页面的地址告诉管理员。」。这几种情形下页面上不出现助手的程序写到错误输出里的原文，也不出现文件路径。系统给的原话（带程序的路径）与助手的程序写到错误输出里的原文写在后端日志里（「任务 <任务编号> 的助手没有启动起来：…」），也放在 `executor_unavailable` 错误的 `data.detail` 里。

**pi 没有可用的模型。** 如果 pi 根本启动不起来（例如启动配置写了一个 pi 不认识的模型），打开会话就会失败：界面提示「助手现在不可用：助手启动之后立刻退出了。请把这个页面的地址告诉管理员。」，执行者状态变为 `failed_to_start`，接口返回 `executor_unavailable`，pi 写到标准错误的最后几行在它的 `data.detail` 与后端日志里。如果 pi 启动了、但模型服务拒绝或不响应它的请求（凭据缺失或过期、端点没开），pi 会自动重试，页面右上角的提示条写「模型服务暂时不可用，正在第 N 次重试。」（pi 没有说第几次时是「模型服务暂时不可用，正在重试。」）；它来自一个代码为 `model_unavailable` 的 `problem` 事件，提示条 8 秒后自己消失，重试一直不成时会一再出现。用 `pi auth check --model <服务商/模型>` 与 `pi --list-models <关键词>` 判断属于哪一种，再按第 3 节修正凭据或模型名。

**没有选定模型，或者选定的模型用不了。** 设置里没有选定语言模型、启动配置里也没有写模型时，任务服务不启动助手，工作视图的提示条写「助手现在不可用：还没有选定语言模型，请先到设置里添加模型服务并选定。」。在设置里选定的模型换不过去时，提示条写「助手现在不可用：选定的模型「<服务商/模型>」用不了，<原因>。请到设置的「模型」一栏检查。」，原因是三种之一：「模型登记里找不到它」「它的模型服务还没有设置密钥或者还没有登录」「换成这个模型没有成功」。两种情形下接口都返回 `executor_unavailable`；后一种 pi 给的英文原因在后端日志（「任务 <任务编号> 的助手换不到选定的模型 …」）与 `data.detail` 里。按第 3 节或第 10.4 节在设置的「模型」一栏添加、检查模型服务。

**去哪里看。**

- 任务服务把输出打印在启动它的那个终端里，同时把同样的内容追加到 `TASKWRIGHT_LOG_DIR` 下的 `backend-<日期>.log`（缺省是数据目录下的 `logs/`）。
- `<runs>/<task id>/pi-events/` 下，每启动一次 pi 就有一组文件：原始 pi 事件流（`<标签>-<时间>.jsonl`）、后端补记（`.backend.jsonl`，含 pi 的退出码与标准错误）、每一行的收到时刻（`.times.jsonl`）。格式见 [observatory/archive-format.md](../observatory/archive-format.md)。
- `<runs>/<task id>/pi-sessions/` 下是 pi 的会话文件，也就是对话本身。
- 观测台（见[用户手册第 7 节](user-guide.zh-CN.md#7-用观测台查看智能体做了什么)）把这些归档展示成页面，包括每次被拒的工具调用及其原因。

**写入反复被拒。** 一批操作里只要有一个不对，工具就整批拒绝，并逐条写明原因。原因可以在观测台的轮次视图里看到，也可以用 `python3 -m taskwright_observatory.dbshow <task dir>` 查看。

**在反向代理后面页面不再更新。** 事件流的响应缓冲没有关闭，见第 6 节。

## 10 桌面包

桌面包是给一个人在自己电脑上用的安装包：一个文件里装着 Node、任务服务、pi、网页界面，以及 pi 的检索工具要用的 rg 与 fd 两个程序，不需要另装 Node、Python 或 pi。桌面包自带的 pi 是 1.0.4，它和它的依赖的版本由代码仓 `release/pi/` 里的锁文件钉住，每次构建带进去的都相同。Linux 有 `taskwright-x86_64.AppImage` 与 `taskwright-linux-x64` 两种，内容相同，差别只在怎样运行：AppImage 不解压，直接挂载运行，但在较旧的发行版上要装 libfuse2；单可执行文件不依赖 FUSE，但每个版本第一次启动时要解压一份到数据目录下的 `cache/`（约 45 MB）。Windows 是 `taskwright-win-x64.exe`；构建方法见代码仓的 `release/README.md`。0.3 的桌面包还是过渡形态：没有桌面外壳，由服务自己打开系统浏览器。

### 10.1 启动

双击，或在终端里运行。启动时先看 8950 到 8959 端口上有没有一个已经在运行的桌面包：有就只打开浏览器，然后结束；没有就以 `--mode desktop --profile desktop --port 8950` 启动任务服务，只绑定 `127.0.0.1`，再用系统浏览器打开 `http://127.0.0.1:<端口>/`。命令行上追加的参数原样交给任务服务，并且优先于上面这些默认值，例如 `--host 0.0.0.0` 让同一网络里的其他电脑也能访问（这时请留意本文开头关于不要暴露到公网的提醒）。

单可执行文件（`taskwright-linux-x64` 与 Windows 的 exe）在每个版本第一次启动时，把内容解压到数据目录下的 `cache/payload/<构建号>/`，以后再启动就不再解压；AppImage 把扩展复制一份到 `cache/agent-<构建号>/`。新版本第一次启动成功后，旧版本的这两样自动删掉。Windows 上双击 exe 会出现一个命令行窗口，它就是服务的状态窗口，显示地址与日志；在 Linux 上双击 AppImage 不出现窗口，日志只写到文件里（见第 10.2 节）。

### 10.2 数据与日志

桌面包写的东西都在一个目录（数据目录）下，删掉这一个目录就等于卸载：Linux 是 `~/.local/share/taskwright/`，Windows 是 `%LOCALAPPDATA%\Taskwright\`，macOS 是 `$HOME/Library/Application Support/Taskwright/`。

| 数据目录下的 | 内容 |
|---|---|
| `tasks/`、`runs/`、`knowledge/` | 任务目录、归档目录（对话记录与事件归档）、知识库 |
| `logs/` | 服务的日志 `backend-<日期>.log`，以及升级与导入的报告 |
| `backups/` | 数据升级之前的备份 |
| `settings.json`、`service.sqlite` | 产品设置（选定的模型等，不含密钥）、任务登记 |
| `pi/` | Taskwright 自己的 pi 配置目录：`models.json`（登记的模型服务）、`auth.json`（密钥）、`settings.json` |
| `cache/` | 程序内容：单可执行文件解压出的 `payload/<构建号>/`、AppImage 复制出的 `agent-<构建号>/`；可以删，下次启动重新生成 |

设了环境变量 `TASKWRIGHT_DATA_DIR`（或者启动时给了 `--data <目录>`）时，整棵树跟着放到它指定的目录下。`TASKWRIGHT_CACHE_DIR` 与 `PI_CODING_AGENT_DIR` 可以把 `cache/` 与 `pi/` 单独指到别处。在服务器上用命令行起任务服务（第 4 节）时，`--data` 或 `TASKWRIGHT_DATA_DIR` 同样带着 `tasks/`、`runs/`、`knowledge/`、`logs/`、`backups/`、`settings.json` 与 `service.sqlite`；`pi/` 与 `cache/` 只有桌面包才有，命令行起的服务用的是 `PI_CODING_AGENT_DIR` 指的 pi 配置目录（没设时是 pi 自己的缺省目录）。

另外两处在系统临时目录里、不在数据目录下：pi 加载扩展时的编译缓存（`jiti/`）与 Node 的模块编译缓存（`node-compile-cache/`）。它们是随时可以重新生成的临时文件，系统清理临时目录时一起清掉。备份方法同第 8 节；装了新版本之后第一次启动，页面会先显示「数据升级」，见第 8.1 节。

### 10.3 退出

三种办法任选其一：在页面左下角（任务列表页、任务页）或右上角（工作视图）的「本机用户」菜单里点「退出服务」，确认之后退出；关掉服务的命令行窗口；在命令行窗口里按 Ctrl+C。三种办法都先通知打开着的页面（工作视图随即显示服务已退出、不再重连），再关掉各任务的 pi、删掉占用标记，然后退出。「本机用户」菜单只在本机打开的页面里有；从别的电脑打开的页面没有这个菜单。

### 10.4 配置模型服务

桌面包里不带任何密钥。模型服务的登记与凭据放在数据目录下 Taskwright 自己的 pi 配置目录 `pi/` 里（见第 10.2 节），设了环境变量 `PI_CODING_AGENT_DIR` 时以它为准；桌面包不读写本机 pi 的配置目录（`~/.pi/agent/`）。第一次启动时，`pi/` 里还没有 `models.json` 与 `auth.json`、而 `~/.pi/agent/` 里有其中之一，就从那里复制必要的几项过来（是复制，以后两边各改各的）：`auth.json`（凭据）整份复制；`models.json` 只留 Taskwright 自己登记的模型服务（服务名以 `taskwright-` 开头、并且在产品设置的名单上），你在本机 pi 里登记的别的服务不复制；`settings.json` 照样复制，但它的缺省服务是没有复制过来的服务时，去掉 `defaultProvider` 与 `defaultModel`。日志里记一行复制了哪几份，有没有复制的服务登记时再记一行写出它们的服务名；设置页的「模型」一栏写明「已从本机 pi 的配置复制」，并列出没有复制的服务登记。要在 Taskwright 里用那些服务，在设置页里重新添加。第 3.1 节的 ChatGPT 订阅登录写的是 pi 的配置目录：第一次启动之后再登录的，登录时要让 `PI_CODING_AGENT_DIR` 指着数据目录下的 `pi/`。

桌面包不带默认的模型。第一次打开时页面顶部提示还没有选定语言模型，点「去配置模型」，在设置页面的「模型」一栏添加模型服务并选定（用 ChatGPT 订阅的先照第 3.1 节登录）。从更早的版本升级上来的，也要到设置里选定一次。也可以不在页面上选，而在 pi 的配置目录（数据目录下的 `pi/`）里放两个文件：`models.json` 登记模型服务；`settings.json` 用 `defaultProvider` 与 `defaultModel` 两项指定用哪一个（pi 的 `/model` 命令写的也是这两项）。桌面包启动 pi 时，这两项都有就用它们。放好文件之后重新启动桌面包。在网页界面上选定的语言模型（见第 3 节）优先于这两项。

例一：本机的 llama.cpp（或其他 OpenAI 兼容接口）。`models.json`：

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [ { "id": "<模型在服务端的名字>" } ]
    }
  }
}
```

`settings.json`：

```json
{ "defaultProvider": "local", "defaultModel": "<模型在服务端的名字>" }
```

例二：在线的模型服务（提供 OpenAI 兼容接口的服务商）。`models.json`：

```json
{
  "providers": {
    "online": {
      "baseUrl": "https://<服务商的接口地址>/v1",
      "api": "openai-completions",
      "apiKey": "<你的密钥>",
      "models": [ { "id": "<模型编号>" } ]
    }
  }
}
```

`settings.json`：

```json
{ "defaultProvider": "online", "defaultModel": "<模型编号>" }
```

`models.json` 里有密钥时，把它设为只有你自己可读。字段的含义见第 3.3 节与 pi 的自定义模型文档。

桌面包启动后会检查它要用的模型有没有着落：`models.json` 里登记了这个服务商与模型，或者 `auth.json` 里有这个服务商（用 pi 登录过）。两样都没有时，或者根本没有写用哪个模型时，页面顶部显示「还没有选定语言模型，助手现在不能工作。」，「详情」里写明原因；没有写用哪个模型时不启动助手。这项检查只读这两个文件；如果某个服务商的密钥只放在环境变量里（第 3.2 节），这里也会显示没有找到，但助手实际可以工作。

### 10.5 端口被占用时

8950 被别的程序占着时，任务服务依次试 8951 到 8959，用第一个空闲的端口，浏览器打开的地址随之改变。十个端口都被占时，启动失败，日志里写明原因。用环境变量 `TASKWRIGHT_PORT` 可以改起始端口。
