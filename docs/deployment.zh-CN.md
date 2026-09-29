> 本文是英文版 [deployment.md](deployment.md) 的中文译本，两者不一致时以英文版为准。

# 部署（Deployment）

本文覆盖从一台新机器到服务跑起来的全部步骤：依赖、安装、模型接入、启动服务、端口、环境变量、生产构建、可选的 Langfuse 追踪、数据与备份、常见故障，以及不需要安装的桌面包（第 10 节）。服务跑起来之后怎么用，见[用户手册](user-guide.zh-CN.md)。

当前版本面向单机或可信的本地网络设计。目前还没有身份认证（authentication）机制；不要把这套服务暴露到公网。

## 1 依赖

| 项目 | 版本 | 使用方 |
|---|---|---|
| Node.js | 24 或更新（使用内置的 `node:sqlite`） | 任务服务、agent、web 构建、simulator 的工具与驱动程序 |
| Python | 3.12 或更新 | observatory、simulator 的驱动程序 |
| pi coding agent | `@earendil-works/pi-coding-agent` 0.85.1 | 运行执行者与模拟用户 |
| pi 能连到的一个模型 | pi 支持的任意服务商（见第 3 节） | 供执行者使用 |

任务服务由 Node.js 直接运行，不用任何第三方包；观测台只需要 Python 标准库。跑测试需要 pytest，它随 `observatory` 与 `server` 两个包的 `[test]` 附加项（extra）一起安装。

## 2 安装

```bash
npm install -g @earendil-works/pi-coding-agent@0.85.1
git clone https://github.com/netbuddy/taskwright.git && cd taskwright
python3 -m venv .venv && . .venv/bin/activate
make install
```

`make install` 依次执行 `npm ci`（npm workspaces：agent、web、sim）与 `python3 -m pip install -e 'observatory[test]' -e 'server[test]'`。不想装 pytest 时，改为执行 `npm ci` 与 `python3 -m pip install -e observatory -e server`。

观测台与模拟用户的驱动程序用 `PATH` 里的 `python3` 运行，并且要用到上面装的 `observatory` 包，所以每开一个新终端，启动它们之前都要先激活虚拟环境（在代码仓根目录执行 `. .venv/bin/activate`）。不激活就会因找不到 `taskwright_observatory` 模块而报 `ModuleNotFoundError` 退出。模拟用户不需要 `server` 包；它经 Node.js 启动任务服务与模拟用户的 pi，所以 `PATH` 里还要有 Node.js 与 pi。任务服务、`scripts/dev.sh` 与 `scripts/tui.sh` 由 Node.js 运行，不需要虚拟环境。示例脚本 `examples/library-lending/run.sh` 是例外：它只需要 `curl` 和一个 `python3`。

## 3 模型接入

Taskwright 自己不直接调用模型，调用模型的是 pi；执行者用的是 pi 启动时指定的那个模型。模型写在启动配置文件（startup profile）`backend/profiles/dev.json` 里：

```json
"model": "openai-codex/gpt-6-luna",
"thinking": "medium",
```

模型名的写法是「服务商/模型」（`provider/model`）。要换模型，可以直接改 `dev.json` 里的 `model`，也可以把它复制成 `backend/profiles/<name>.json`、改好副本，再给任务服务或 `scripts/tui.sh` 传 `--profile <name>`。启动配置里的文件路径（`system_prompt_file`、`platform_skill`、代码仓自带扩展的 `path`）按代码仓根目录解析；写成绝对路径时照原样使用。`pi --list-models [关键词]` 列出 pi 认识的模型及其服务商名；`pi auth check --provider <服务商>`（或 `--model <服务商/模型>`）可以在启动服务之前检查 pi 是否有可用的凭据；凭据可用时它打印 `ready`。

pi 把凭据与自定义模型存放在 `~/.pi/agent/` 下（`auth.json` 与 `models.json`；环境变量 `PI_CODING_AGENT_DIR` 可以改这个目录）。任务服务用它自己的环境变量启动 pi，所以在启动服务的那个终端里设置的环境变量会传到 pi。

接入模型有三条路径。

### 3.1 默认路径：ChatGPT（Codex）订阅

默认启动配置用的是 `openai-codex/gpt-6-luna`，需要一个 ChatGPT Plus 或 Pro 订阅，并在 pi 里登录：

```bash
pi                 # 在任意目录启动一次 pi 的交互模式
/login             # 在 pi 里选择「ChatGPT Plus/Pro (Codex)」，在浏览器里完成登录
```

令牌（token）保存在 `~/.pi/agent/auth.json`，过期后自动刷新。用 `pi auth check --provider openai-codex` 检查。任务服务以 RPC 模式启动 pi，这种模式下无法登录，所以要事先用运行服务的同一个操作系统用户登录一次。

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
| 任务服务（HTTP/SSE 接口） | `node backend/src/main.mts --tasks <dir> --runs <dir> --port <port> [--mode desktop\|server] [--host <address>] [--profile <name>] [--web <dir>]` | 无默认值，需自行指定 |
| 网页界面（开发服务器） | `TASKWRIGHT_API_TARGET=http://127.0.0.1:<api port> npm run dev -w web` | 5680（`TASKWRIGHT_WEB_PORT`） |
| 两者一起启动 | `scripts/dev.sh`（或 `make dev`） | API 8790，web 5680 |
| 两者一起启动，用假模型并建好演示任务 | `scripts/dev.sh --demo` | API 8790，web 5680 |
| 观测台 | `python3 -m taskwright_observatory --runs <archive dir> --workspaces <tasks dir>` | 8770 |

- `--tasks` 是任务目录的创建位置（每个任务一个目录，以任务编号命名）；`--runs` 是每个任务的原始 pi 事件与会话文件的归档位置（`<runs>/<task id>/pi-events/` 与 `pi-sessions/`）。两者不给时都放在用户数据目录下（Linux 是 `~/.local/share/taskwright/`）。
- 各服务默认绑定 `0.0.0.0`（可用 `--host` 更改）。唯一的例外是以 `--mode desktop` 启动的任务服务，它默认绑定 `127.0.0.1`。
- 任务服务有一个运行形态参数 `--mode desktop|server`（缺省 `server`）。`server` 用于多人共用的服务器：默认绑定 `0.0.0.0`，没有退出接口。`desktop` 用于一个人在自己电脑上使用：默认绑定 `127.0.0.1`，并多出一个只接受本机请求的 `POST /api/v1/service/exit`。两种形态下 `--host` 都优先于默认地址。两种形态的日志写法相同：写到标准输出，同时追加到 `TASKWRIGHT_LOG_DIR` 下当天的文件（缺省是用户数据目录下的 `logs/`）。`GET /api/v1/service` 与退出接口的说明见 `docs/api.zh-CN.md` 第 9 节。只有在本机打开的页面才有退出的入口；服务按请求的来源地址判断是不是本机，所以桌面形态不要放在反向代理后面（否则服务看到的是代理的地址）。
- 给任务服务的端口被占用时，它会依次尝试后面的端口，最多共试 10 个，全部被占时报错退出。实际使用的端口会打印到日志、写进各任务的占用标记，并由 `GET /api/v1/service` 返回。
- `scripts/dev.sh` 在 `TASKWRIGHT_API_PORT`（缺省 8790）上起任务服务，并把网页开发服务器指向任务服务报出的实际端口，所以端口被占时网页不会被转到别的服务上。加 `--demo` 时，任务服务用假模型端点（`backend/fake_model/`）与启动配置 `fake` 运行，任务与归档放在退出时删除的临时目录里，并由 `examples/library-lending/run.sh` 建好一个带示例材料与几个条目的演示任务；不需要模型服务与密钥，但 `PATH` 里要有 pi。
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
| `TASKWRIGHT_TASKS_ROOT` | agent | 服务启动 pi 时设：任务根目录。不在它之下的任务库拒绝写入。单独跑 agent 代码时（命令行工具、测试）不设，也就不核对。 |
| `TASKWRIGHT_LOG_DIR` | 任务服务 | 任务服务追加每日日志文件 `backend-<日期>.log` 的目录（缺省是用户数据目录下的 `logs/`）。 |
| `TASKWRIGHT_LANGFUSE_PLUGIN` | 任务服务、`scripts/tui.sh` | 可选的 Langfuse 插件所在的位置（见第 7 节）。 |
| `TASKWRIGHT_LANGFUSE_ENV_FILE` | 任务服务、`scripts/tui.sh`、observatory | 保存 Langfuse 地址与密钥的文件。 |
| `TASKWRIGHT_LANGFUSE_PROJECT_ID` | observatory | Langfuse 项目编号，用于生成直达链接。 |
| `TASKWRIGHT_SIM_MATERIALS_DIR` | simulator | 存放模拟用户画像所用材料的目录。 |
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

## 9 常见故障

**助手启动不起来。** 工作视图整页只读，输入框上方的提示条在「助手现在不可用：助手没有启动起来，」后面写明原因。PATH 里找不到 pi，或者 pi 脚本开头指定的解释器不存在时，写「找不到助手的程序（pi），请检查安装。」。系统拒绝启动时只写系统给的英文代号：文件没有执行权限时是「系统原因：EACCES」，命令行太长时（系统提示整份放在命令行里）是「系统原因：E2BIG」，打开的文件数、内存或进程数到了上限时是「系统原因：EMFILE」「ENFILE」「ENOMEM」或「EAGAIN」。启动配置或环境变量写错（系统提示文件、扩展、密钥文件不存在等）时照原样写出是哪一项。另有三种情形，提示条整句是固定的：助手的程序启动之后立刻退出时写「助手现在不可用：助手启动之后立刻退出了。请把这个页面的地址告诉管理员。」；启动之前任务服务没能建好归档目录、打开归档文件或备份并改写要续接的会话文件（没有写权限、磁盘满）时写「助手现在不可用：启动助手之前，任务服务没能写入它要用的文件，系统原因：EACCES。请把这个页面的地址告诉管理员。」，系统原因取不到时写「系统原因：未知」；其他没有预料到的错误写「助手现在不可用：助手没有启动起来。请把这个页面的地址告诉管理员。」。这几种情形下页面上不出现助手的程序写到错误输出里的原文，也不出现文件路径。系统给的原话（带程序的路径）与助手的程序写到错误输出里的原文写在后端日志里（「任务 <任务编号> 的助手没有启动起来：…」），也放在 `executor_unavailable` 错误的 `data.detail` 里。

**pi 没有可用的模型。** 如果 pi 根本启动不起来（例如启动配置写了一个 pi 不认识的模型），打开会话就会失败：界面提示「助手现在不可用：助手启动之后立刻退出了。请把这个页面的地址告诉管理员。」，执行者状态变为 `failed_to_start`，接口返回 `executor_unavailable`，pi 写到标准错误的最后几行在它的 `data.detail` 与后端日志里。如果 pi 启动了、但模型服务拒绝或不响应它的请求（凭据缺失或过期、端点没开），pi 会自动重试，界面提示模型服务暂时不可用、正在重试（一个代码为 `model_unavailable` 的 `problem` 事件）。用 `pi auth check --model <服务商/模型>` 与 `pi --list-models <关键词>` 判断属于哪一种，再按第 3 节修正凭据或模型名。

**去哪里看。**

- 任务服务把输出打印在启动它的那个终端里，同时把同样的内容追加到 `TASKWRIGHT_LOG_DIR` 下的 `backend-<日期>.log`（缺省是用户数据目录下的 `logs/`）。
- `<runs>/<task id>/pi-events/` 下，每启动一次 pi 就有一组文件：原始 pi 事件流（`<标签>-<时间>.jsonl`）、后端补记（`.backend.jsonl`，含 pi 的退出码与标准错误）、每一行的收到时刻（`.times.jsonl`）。格式见 [observatory/archive-format.md](../observatory/archive-format.md)。
- `<runs>/<task id>/pi-sessions/` 下是 pi 的会话文件，也就是对话本身。
- 观测台（见[用户手册第 7 节](user-guide.zh-CN.md#7-用观测台查看智能体做了什么)）把这些归档展示成页面，包括每次被拒的工具调用及其原因。

**写入反复被拒。** 一批操作里只要有一个不对，工具就整批拒绝，并逐条写明原因。原因可以在观测台的轮次视图里看到，也可以用 `python3 -m taskwright_observatory.dbshow <task dir>` 查看。

**在反向代理后面页面不再更新。** 事件流的响应缓冲没有关闭，见第 6 节。

## 10 桌面包

桌面包是给一个人在自己电脑上用的安装包：一个文件里装着 Node、任务服务、pi、网页界面，以及 pi 的检索工具要用的 rg 与 fd 两个程序，不需要另装 Node、Python 或 pi。Linux 有 `taskwright-x86_64.AppImage` 与 `taskwright-linux-x64` 两种，Windows 是 `taskwright-win-x64.exe`；构建方法见代码仓的 `release/README.md`。0.3 的桌面包还是过渡形态：没有桌面外壳，由服务自己打开系统浏览器。

### 10.1 启动

双击，或在终端里运行。启动时先看 8950 到 8959 端口上有没有一个已经在运行的桌面包：有就只打开浏览器，然后结束；没有就以 `--mode desktop --profile desktop --port 8950` 启动任务服务，只绑定 `127.0.0.1`，再用系统浏览器打开 `http://127.0.0.1:<端口>/`。命令行上追加的参数原样交给任务服务，并且优先于上面这些默认值，例如 `--host 0.0.0.0` 让同一网络里的其他电脑也能访问（这时请留意本文开头关于不要暴露到公网的提醒）。

单可执行文件（`taskwright-linux-x64` 与 Windows 的 exe）在每个版本第一次启动时，把内容解压到用户缓存目录（Linux 是 `~/.cache/taskwright/payload/`，Windows 是 `%LOCALAPPDATA%\Taskwright\cache\payload\`），以后再启动就不再解压。Windows 上双击 exe 会出现一个命令行窗口，它就是服务的状态窗口，显示地址与日志；在 Linux 上双击 AppImage 不出现窗口，日志只写到文件里（见第 10.2 节）。

### 10.2 数据与日志

任务目录与归档目录放在用户数据目录下：Linux 是 `~/.local/share/taskwright/tasks/` 与 `runs/`，Windows 是 `%LOCALAPPDATA%\Taskwright\tasks\` 与 `runs\`。日志写到同一目录下的 `logs/backend-<日期>.log`。设了环境变量 `TASKWRIGHT_DATA_DIR` 时，这三样一起放到它指定的目录下。备份方法同第 8 节。

### 10.3 退出

三种办法任选其一：在页面左下角（任务列表页、任务页）或右上角（工作视图）的「本机用户」菜单里点「退出服务」，确认之后退出；关掉服务的命令行窗口；在命令行窗口里按 Ctrl+C。三种办法都先通知打开着的页面（工作视图随即显示服务已退出、不再重连），再关掉各任务的 pi、删掉占用标记，然后退出。「本机用户」菜单只在本机打开的页面里有；从别的电脑打开的页面没有这个菜单。

### 10.4 配置模型服务

桌面包里不带任何密钥。模型服务的登记与凭据照旧从 pi 的配置目录读：Linux 是 `~/.pi/agent/`，Windows 是 `%USERPROFILE%\.pi\agent\`，设了环境变量 `PI_CODING_AGENT_DIR` 时以它为准。

桌面包默认使用的模型与开发用的启动配置相同（`openai-codex/gpt-6-luna`，见第 3.1 节）；已经用 pi 登录过 ChatGPT 的电脑不用再做任何设置。要换成别的模型，在 pi 的配置目录里放两个文件：`models.json` 登记模型服务；`settings.json` 用 `defaultProvider` 与 `defaultModel` 两项指定用哪一个（pi 的 `/model` 命令写的也是这两项）。桌面包启动 pi 时，这两项都有就用它们代替默认模型。放好文件之后重新启动桌面包。

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

桌面包启动后会检查它要用的模型有没有着落：`models.json` 里登记了这个服务商与模型，或者 `auth.json` 里有这个服务商（用 pi 登录过）。两样都没有时，页面顶部显示「还没有配置模型服务，助手无法工作」，「详情」里写明查过的两个文件在哪里。这项检查只读这两个文件；如果某个服务商的密钥只放在环境变量里（第 3.2 节），这里也会显示没有找到，但助手实际可以工作。

### 10.5 端口被占用时

8950 被别的程序占着时，任务服务依次试 8951 到 8959，用第一个空闲的端口，浏览器打开的地址随之改变。十个端口都被占时，启动失败，日志里写明原因。用环境变量 `TASKWRIGHT_PORT` 可以改起始端口。
