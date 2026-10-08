# Deployment

This page covers everything from a fresh machine to running services: dependencies, installation, connecting a model, starting the services, ports, environment variables, a production build, optional Langfuse tracing, data and backups, common problems, and the desktop packages that need no installation (section 10). How to use the running system is in the [user guide](user-guide.md).

This version is meant for a single machine or a trusted local network. There is no authentication yet; do not expose the service to the internet.

## 1 Dependencies

| What | Version | Used by |
|---|---|---|
| Node.js | 24 or newer (uses the built-in `node:sqlite`) | task service, agent, web build, simulator tools and driver |
| Python | 3.12 or newer | observatory, simulator driver |
| pi coding agent | `@earendil-works/pi-coding-agent` 1.0.4 | runs the executor and the simulated user |
| A model reachable from pi | any provider pi supports (see section 3) | the executor |

The task service runs directly on Node.js and has two third-party packages of its own: docx, used when chosen items are exported as a Word file, and pdfjs-dist, which prepares PDF materials for 0.4.3 and is not used yet. To check the Mermaid text of a diagram it uses the mermaid package installed for the pages. `make install` installs all three. The observatory needs only the Python standard library. Running the tests needs pytest, which comes with the `[test]` extra of the `observatory` package.

## 2 Installation

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.4
git clone https://github.com/netbuddy/taskwright.git && cd taskwright
python3 -m venv .venv && . .venv/bin/activate
make install
```

`make install` runs `npm ci` (npm workspaces: agent, web, sim) and `python3 -m pip install -e 'observatory[test]'`. If you do not want pytest, run `npm ci` and `python3 -m pip install -e observatory` instead.

The observatory and the simulator driver run `python3` from your `PATH` and need the `observatory` package installed above, so activate the virtual environment (`. .venv/bin/activate` in the repository root) in every new terminal before you start them. Otherwise they stop with a `ModuleNotFoundError` for `taskwright_observatory`. The simulator does not need the `server` package; it starts the task service and the simulated user's pi through Node.js, so Node.js and pi must be on `PATH` as well. The task service, `scripts/dev.sh` and `scripts/tui.sh` run on Node.js and do not need the virtual environment. The example script `examples/library-lending/run.sh` is the exception: it needs only `curl` and a `python3`.

## 3 Connecting a model

Taskwright does not talk to a model itself. pi does, and the executor uses the model pi was started with. The model is set in the startup profile `backend/profiles/dev.json`:

```json
"model": "openai/gpt-6-luna",
"thinking": "medium",
```

A model name is written as `provider/model`. To use another model, either edit `model` in `dev.json`, or copy the file to `backend/profiles/<name>.json`, edit the copy, and pass `--profile <name>` to the task service or to `scripts/tui.sh`. File paths in a profile (`system_prompt_file`, `platform_skill` and the `path` of an extension that comes with the repository) are relative to the repository root; an absolute path is used as it is. `pi --list-models [search]` lists the models pi knows, with their provider names. `pi auth check --provider <provider>` (or `--model <provider/model>`) checks whether pi has usable credentials before you start the service; it prints `ready` when they are usable.

pi keeps its credentials and custom models under `~/.pi/agent/` (`auth.json` and `models.json`; the environment variable `PI_CODING_AGENT_DIR` moves that directory). The task service starts pi with the service's own environment, so environment variables set in the shell that starts the service reach pi.

Model services can also be set up in the web interface, through the endpoints in section 10 of the [API reference](api.md). The task service then adds its own entries, named `taskwright-…`, to `models.json` and `auth.json`, and leaves everything else in them as it is; before each change it saves a copy next to the file (`<file>.taskwright-backup-<time>`; the five most recent are kept). A language model chosen there takes precedence over the startup profile and, for the desktop package, over pi's `settings.json`. It is used from the next session opened or created, including a session opened again after the change; a session in progress keeps its model. The choice is kept in the product's settings file: `settings.json` in the user data directory (on Linux `$XDG_DATA_HOME/taskwright/`, by default `.local/share/taskwright/` in the home directory), or the file named by `TASKWRIGHT_SETTINGS_FILE`. The file holds no keys.

There are three ways to connect a model.

**No automatic network access.** All startup profiles set `flags.offline`, so the task service starts pi with `--offline`: pi does not go to the network by itself. It does not fetch a newer catalog of models, does not check for a new version, and does not download the search tools rg and fd when they are missing. Requests to the model service are not affected. Two things follow. The assistant's `grep` and `find` tools need rg and fd: the desktop package brings them, and on a machine set up by hand the simplest way is to run `pi` once on the command line, without `--offline`, and let it download them. And pi's catalog of models does not renew itself: with a ChatGPT subscription, press 更新模型目录 ("update the model catalog") in the Codex subscription's details on the settings page, or run `pi update --models`. To let pi use the network by itself again, set `offline` to `false` in the profile.

### 3.1 The default: a ChatGPT (Codex) subscription

The default profile uses `openai/gpt-6-luna`, which needs a ChatGPT Plus or Pro subscription signed in through pi:

```bash
pi                 # start pi's interactive mode once, in any directory
/login             # inside pi: choose OpenAI, then sign in with the ChatGPT subscription as prompted
```

The token is saved in `~/.pi/agent/auth.json` and refreshed automatically. Check it with `pi auth check --provider openai`. Earlier versions of pi had another sign-in entry, listed as OpenAI Codex (legacy), which keeps its login under `openai-codex`; Taskwright no longer uses it, so a computer signed in only there must sign in once through the entry above. The task service starts pi in RPC mode, which cannot sign in, so do this once beforehand as the same operating-system user that runs the service.

### 3.2 A provider API key (OpenAI, Anthropic and others)

Either set the provider's environment variable before starting the service, or store the key in `~/.pi/agent/auth.json` (running `/login` in pi and choosing an API-key provider writes the same file):

```bash
export OPENAI_API_KEY=...        # model names like openai/<model id>
export ANTHROPIC_API_KEY=...     # model names like anthropic/<model id>
```

```json
{
  "openai":    { "type": "api_key", "key": "..." },
  "anthropic": { "type": "api_key", "key": "..." }
}
```

Other providers use their own variables (for example `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`); `pi --help` lists them, and pi's [providers documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md) gives the `auth.json` key for each. A key in `auth.json` takes priority over the environment variable. Then set `model` in the profile, for example `"anthropic/<model id>"`, using a name that `pi --list-models anthropic` shows.

### 3.3 A local OpenAI-compatible endpoint (Ollama, llama.cpp)

Register the endpoint as a custom provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [ { "id": "<model name as the server knows it>" } ]
    }
  }
}
```

For a llama.cpp `llama-server`, add a provider with a name of your choice (for example `llamacpp`) in the same way and use its OpenAI-compatible address, by default `http://127.0.0.1:8080/v1`. The `apiKey` value is a placeholder when the server does not check keys; pi still needs some value before it treats the model as available. Then set `model` in the profile to `"ollama/<model name>"` (or `"llamacpp/<model name>"`). Field meanings (`contextWindow`, `maxTokens`, `reasoning`, the `compat` flags) are in pi's [custom models documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md). pi also has a dedicated llama.cpp router provider configured with `/login llama.cpp`; see pi's [llama.cpp documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/llama-cpp.md).

Taskwright relies on the model calling tools reliably: every reply goes through the `reply` tool, and every save goes through `save_revision` with structured arguments. A small local model may keep producing rejected calls; the observatory shows how often that happens.

## 4 Starting the services

| Service | Command | Default port |
|---|---|---|
| Task service (HTTP/SSE API) | `node backend/src/main.mts --tasks <dir> --runs <dir> [--knowledge <dir>] --port <port> [--mode desktop\|server] [--host <address>] [--profile <name>] [--web <dir>]` | none, give one |
| Web interface (development server) | `TASKWRIGHT_API_TARGET=http://127.0.0.1:<api port> npm run dev -w web` | 5680 (`TASKWRIGHT_WEB_PORT`) |
| Both at once | `scripts/dev.sh` (or `make dev`) | API 8790, web 5680 |
| Both at once, on the fake model with a demo task | `scripts/dev.sh --demo` | API 8790, web 5680 |
| Observatory | `python3 -m taskwright_observatory --runs <archive dir> --workspaces <tasks dir>` | 8770 |

- `--tasks` is where task directories are created (one directory per task, named by task id); `--runs` is where each task's raw pi events and session files are archived (`<runs>/<task id>/pi-events/` and `pi-sessions/`). `--knowledge` is the root of the knowledge base: the libraries of reference documents that tasks use (section 11 of the API description). When they are left out, all three go to the user data directory (`~/.local/share/taskwright/` on Linux), as `tasks/`, `runs/` and `knowledge/`.
- All services bind `0.0.0.0` by default (`--host` changes it). The one exception is the task service started with `--mode desktop`, which binds `127.0.0.1` by default.
- The task service takes a run mode, `--mode desktop|server` (default `server`). `server` is for a shared server: it binds `0.0.0.0` by default and has no exit endpoint. `desktop` is for one person on one computer: it binds `127.0.0.1` by default and adds `POST /api/v1/service/exit`, which accepts requests from this machine only. `--host` overrides the default address in both modes. Both modes log the same way: to standard output and to a daily file under `TASKWRIGHT_LOG_DIR` (default: `logs/` in the user data directory). See section 9 of the API description for `GET /api/v1/service` and the exit endpoint. Only pages opened on the same computer are offered the exit; the service tells this from the request's source address, so do not put a desktop-mode service behind a reverse proxy (the service would see the proxy's address).
- **Anyone who can open the pages can change the model configuration.** Until signing in is added, anyone who can reach this address can change the model configuration in the web interface, including replacing API keys and removing model services. Deploy a task service started with `--mode server` only on a trusted internal network.
- If the port given to the task service is taken, it tries the following ports, up to 10 in all, and exits with an error when all are taken. Given `--port 0`, it lets the system pick a free port. The port it actually uses is printed in the log, written to each task's occupancy mark and returned by `GET /api/v1/service`.
- `scripts/dev.sh` starts the task service on `TASKWRIGHT_API_PORT` (default 8790) and points the web development server at the port the task service actually reports, so a taken port does not send the web interface to some other service. With `--demo` the task service runs on the fake model endpoint (`backend/fake_model/`) with the launch profile `fake`, keeps its tasks, archives and knowledge base in a temporary directory that is removed on exit, and `examples/library-lending/run.sh` creates a demo task with the example material and a few items; no model service or key is needed, but pi must be on `PATH`.
- Given `--web <dir>` (for example the built `web/dist`), the task service serves the web interface itself: GET requests that do not start with `/api/` are answered from that directory, and paths it does not have get the start page. Then neither the reverse proxy of section 6 nor the development server is needed.
- Started with `--mode desktop`, the task service reads `defaultProvider` and `defaultModel` from `settings.json` in pi's configuration directory before starting pi, and when both are present uses them instead of the profile's model (see section 10.4); with `--mode server` it does not read that file.
- Stop services with Ctrl+C or by process id; the task service shuts down the same way on SIGHUP (when its terminal or Windows console window is closed), and closes each task's pi process on the way out.

## 5 Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `TASKWRIGHT_RUNS_DIR` | `scripts/tui.sh`, observatory, `scripts/dev.sh` | Archive directory when none is given on the command line (default `./runs`). |
| `TASKWRIGHT_WEB_PORT` | web dev server | Port (default 5680). |
| `TASKWRIGHT_API_TARGET` | web dev server | Where `/api` is proxied (default: the local task service, `http://127.0.0.1:8790`, the port `scripts/dev.sh` starts it on). |
| `TASKWRIGHT_TASKS_DIR`, `TASKWRIGHT_API_PORT` | `scripts/dev.sh` | Task directory root and API port. |
| `TASKWRIGHT_KNOWLEDGE_DIR` | `scripts/dev.sh` | Knowledge base root (default `./knowledge`). |
| `TASKWRIGHT_TASKS_ROOT` | agent | Set by the service when it starts pi: the task root. Writes to a task database outside it are refused. Not set when the agent code runs on its own (command-line tools, tests); then it is not checked. |
| `TASKWRIGHT_LOG_DIR` | task service | Where the task service appends its daily log file `backend-<date>.log` (default: `logs/` in the user data directory). |
| `TASKWRIGHT_LANGFUSE_PLUGIN` | task service, `scripts/tui.sh` | Location of the optional Langfuse plugin (see section 7). |
| `TASKWRIGHT_LANGFUSE_ENV_FILE` | task service, `scripts/tui.sh`, observatory | File holding the Langfuse address and keys. |
| `TASKWRIGHT_LANGFUSE_PROJECT_ID` | observatory | Langfuse project id, for deep links. |
| `TASKWRIGHT_SIM_MATERIALS_DIR` | simulator | Directory holding the persona's materials. |
| `TASKWRIGHT_SETTINGS_FILE` | task service | The product's settings file: the models chosen and the model services registered in the web interface (default: `settings.json` in the user data directory). Point it at a temporary file for tests and trial setups. |
| provider variables such as `OPENAI_API_KEY` | pi | Model credentials; see section 3.2. |

## 6 Production build of the web interface

Run `npm run build -w web` and serve `web/dist/` behind a reverse proxy that forwards `/api` to the task service, or instead give the task service `--web web/dist` and skip the proxy (see section 4). Disable response buffering for `/api/v1/tasks/*/events` (it is a Server-Sent Events stream) and raise the read timeout. Set the proxy's own request body limit to at least the upload limit plus some room for the multipart wrapping (for nginx, `client_max_body_size 6m;`; its default is 1 MB); otherwise a larger upload is refused by the proxy with its own error page instead of the task service's message. Without HTTP/2, a browser allows only about six connections per host, so keep to four open task pages per browser.

## 7 Optional: Langfuse tracing

Tracing is optional; everything works without it. It uses the official pi observability plugin, **pi-observability-plugin**, pinned in this release to commit `2509b35` of its repository.

1. Check out the plugin at that commit and set `TASKWRIGHT_LANGFUSE_PLUGIN` to its directory (the directory must contain `src/index.ts`).
2. Put the connection details in a file outside the repository, one `NAME=value` per line, and point `TASKWRIGHT_LANGFUSE_ENV_FILE` at it:

   ```
   LANGFUSE_BASE_URL=https://<your Langfuse host>
   LANGFUSE_PUBLIC_KEY=<public key>
   LANGFUSE_SECRET_KEY=<secret key>
   TASKWRIGHT_LANGFUSE_PROJECT_ID=<project id>
   ```

   Make the file readable only by you (`chmod 600`). Keys reach pi only through environment variables, never on a command line, where other users of the machine could see them in the process list.
3. The environment tag defaults to the profile's `langfuse.environment`; set `LANGFUSE_TRACING_ENVIRONMENT` to override it for a run.

## 8 Data and backups

Each task directory holds `task.sqlite` plus, in WAL mode, `task.sqlite-wal` and `task.sqlite-shm`. Copy all three together, or stop the pi process for that task and run a checkpoint first:

```bash
python3 -c "import sqlite3; sqlite3.connect('<task dir>/task.sqlite').execute('PRAGMA wal_checkpoint(TRUNCATE)')"
```

After a checkpoint, `task.sqlite` alone is complete. The conversation itself is not in the database; it lives in pi's session files under `<runs>/<task id>/pi-sessions/`, so back those up too if you want to keep the conversations.

**One service per task.** A running service writes `service.lock` (its port, process id, start time and host name) into every task directory it serves and removes it when it stops. Another service that finds a lock naming a live process on the same host (or any lock from another host) does not serve that task: it lists it as 占用中 ("in use") with the port of the service that has it, and refuses to open it. A lock whose process is gone is left over from a crash and is replaced, with a line in the log. To look at a lock: `cat <task dir>/service.lock`.

**Copying or moving task data.** Every path inside a task directory is relative, so a task directory can be moved or copied. pi's session files record the task directory they were started in; when a service resumes such a session and the recorded directory is not its own task directory, it rewrites that first line to its own directory (keeping the original file next to it as `….cwd-<time>.bak`) and logs 会话文件记的工作目录是 X，已按本服务的任务目录 Y 续接. The service also passes its task root to pi (`TASKWRIGHT_TASKS_ROOT`), and every write refuses a task database outside it. A copied service therefore never writes into the original task data. Stop the original service before starting one on a copy, or the copy is listed as in use.

**Knowledge base.** The knowledge root holds `libraries.json`, and for each library a directory with `documents.json` and the document files in `files/` (with the projection files beside Word documents). Back up the whole directory. The JSON files are always replaced whole (written to a temporary file and renamed), so a copy taken while the service runs holds either the old or the new list; a document uploaded at that moment may be in `files/` without being in the list yet. Which libraries a task uses is in `knowledge.json` in the task directory, so it is backed up with the task.

## 9 Common problems

**The assistant cannot be started.** The work view turns read-only and the note above the input box says why, after 助手现在不可用：助手没有启动起来，. When pi is not on `PATH`, or the interpreter its script names is missing, it says 找不到助手的程序（pi），请检查安装。. When the system refuses to start it, it gives only the system's error code: 系统原因：EACCES when the file is not executable, 系统原因：E2BIG when the command line is too long (it carries the whole system prompt), 系统原因：EMFILE, ENFILE, ENOMEM or EAGAIN when the machine is out of open files, memory or processes. A mistake in the startup profile or in an environment variable (a missing system prompt file, extension or key file) is named as it is. In three more cases the whole note is fixed: when the assistant's program exits right after starting, it reads 助手现在不可用：助手启动之后立刻退出了。请把这个页面的地址告诉管理员。 ("the assistant exited right after it started; tell your administrator the address of this page"); when the task service cannot create the archive directory, open the archive files or back up and rewrite the session file it is resuming (no write permission, disk full), it reads 助手现在不可用：启动助手之前，任务服务没能写入它要用的文件，系统原因：EACCES。请把这个页面的地址告诉管理员。 ("before starting the assistant, the task service could not write the files it needs, system reason: EACCES"), with 系统原因：未知 ("unknown") when there is no code; any other unexpected error reads 助手现在不可用：助手没有启动起来。请把这个页面的地址告诉管理员。 ("the assistant did not start"). In these cases the page shows neither what the assistant's program wrote to its error output nor any file path. The system's own message, with the path of the program, and what the assistant's program wrote to its error output are in the backend log (任务 <task> 的助手没有启动起来：…) and in `data.detail` of the `executor_unavailable` error.

**pi has no usable model.** If pi cannot start at all (for example the profile names a model pi does not know), opening a session fails: the interface reports 助手现在不可用：助手启动之后立刻退出了。请把这个页面的地址告诉管理员。, the executor state becomes `failed_to_start`, and the API returns `executor_unavailable`; the last lines pi wrote to standard error are in its `data.detail` and in the backend log. If pi starts but the model service rejects or does not answer its requests (missing or expired credentials, an endpoint that is down), pi retries and the interface shows that the model service is temporarily unavailable and is being retried (a `problem` event with code `model_unavailable`). Run `pi auth check --model <provider/model>` and `pi --list-models <search>` to find out which case you are in, then fix the credentials or the model name as described in section 3.

**Where to look.**

- The task service prints to the terminal it was started in and appends the same lines to `backend-<date>.log` under `TASKWRIGHT_LOG_DIR` (default: `logs/` in the user data directory).
- `<runs>/<task id>/pi-events/` holds, for every start of pi, the raw pi event stream (`<label>-<time>.jsonl`), the backend's own notes such as pi's exit code and standard error (`.backend.jsonl`), and the arrival time of each line (`.times.jsonl`). The format is described in [observatory/archive-format.md](../observatory/archive-format.md).
- `<runs>/<task id>/pi-sessions/` holds pi's session files, that is, the conversation.
- The observatory ([user guide, section 7](user-guide.md#7-see-what-the-assistant-did-the-observatory)) shows the same archives as pages, including every rejected tool call and its reason.

**A write keeps being rejected.** A tool rejects the whole batch when one operation is wrong, and says exactly why. The reason is visible in the observatory's turn view and in `python3 -m taskwright_observatory.dbshow <task dir>`.

**The page stops updating behind a proxy.** Response buffering is on for the event stream; see section 6.

## 10 Desktop packages

The desktop packages are for one person on one computer: a single file holds Node, the task service, pi, the web interface and rg and fd, the two programs pi's search tools use, so nothing else (Node, Python, pi) needs to be installed. The pi in the package is 1.0.4; its version and the versions of its dependencies are pinned by the lock file in the repository's `release/pi/`, so every build packs the same ones. Linux has `taskwright-x86_64.AppImage` and `taskwright-linux-x64`; Windows has `taskwright-win-x64.exe`. How to build them is in the repository's `release/README.md`. In 0.3 the desktop package is transitional: there is no desktop shell, and the service opens the system browser itself.

### 10.1 Starting

Double-click the file or run it from a terminal. It first checks ports 8950 to 8959 for a desktop package that is already running: if it finds one, it only opens the browser and ends. Otherwise it starts the task service with `--mode desktop --profile desktop --port 8950`, bound to `127.0.0.1`, and opens `http://127.0.0.1:<port>/` in the system browser. Arguments added on the command line are passed on to the task service and win over these defaults; for example `--host 0.0.0.0` lets other computers on the same network reach it (mind the warning at the top of this page about the internet).

A single executable (`taskwright-linux-x64` and the Windows exe) extracts its contents to the user cache directory on the first start of each version (`~/.cache/taskwright/payload/` on Linux, `%LOCALAPPDATA%\Taskwright\cache\payload\` on Windows) and does not extract again later. On Windows, double-clicking the exe opens a console window; that window is the service's status window and shows the address and the log. Double-clicking the AppImage on Linux opens no window; the log goes to a file only (see section 10.2).

### 10.2 Data and logs

Task directories, archives and the knowledge base are kept in the user data directory: `~/.local/share/taskwright/tasks/`, `runs/` and `knowledge/` on Linux, `%LOCALAPPDATA%\Taskwright\tasks\`, `runs\` and `knowledge\` on Windows. The log is written to `logs/backend-<date>.log` in the same directory. When the environment variable `TASKWRIGHT_DATA_DIR` is set, all four go under the directory it names. Back them up as described in section 8.

### 10.3 Stopping

Any one of three ways: choose 退出服务 ("stop the service") in the 本机用户 ("local user") menu, at the bottom left of the task list and task pages or the top right of the work view, and confirm; close the service's console window; or press Ctrl+C in that window. Each way first tells the open pages (work views then show that the service has stopped and no longer reconnect), then closes each task's pi and removes the occupancy marks before the service exits. The 本机用户 menu is only there on pages opened on the same computer; pages opened from another computer do not have it.

### 10.4 Setting up a model service

The desktop package contains no keys. Model services and their credentials are read, as always, from pi's configuration directory: `~/.pi/agent/` on Linux, `%USERPROFILE%\.pi\agent\` on Windows, or the directory named by `PI_CODING_AGENT_DIR`.

The desktop package ships without a default model. On first start the page says at the top that no language model is chosen; press 去配置模型 ("set up the model"), add a model service under 模型 on the settings page and choose a model (for a ChatGPT subscription, sign in first as in section 3.1). After upgrading from an earlier version, choose the model there once as well. Instead of choosing on the page, you can put two files in pi's configuration directory: `models.json` registers the model service, and `settings.json` names the one to use with `defaultProvider` and `defaultModel` (the same two settings pi's `/model` command writes). When both are present, the desktop package starts pi with that model. Restart the desktop package after placing the files. A language model chosen in the web interface (section 3) takes precedence over these two settings.

Example 1: llama.cpp (or another OpenAI-compatible endpoint) on this computer. `models.json`:

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [ { "id": "<model name on the server>" } ]
    }
  }
}
```

`settings.json`:

```json
{ "defaultProvider": "local", "defaultModel": "<model name on the server>" }
```

Example 2: an online model service with an OpenAI-compatible API. `models.json`:

```json
{
  "providers": {
    "online": {
      "baseUrl": "https://<the provider's API address>/v1",
      "api": "openai-completions",
      "apiKey": "<your key>",
      "models": [ { "id": "<model id>" } ]
    }
  }
}
```

`settings.json`:

```json
{ "defaultProvider": "online", "defaultModel": "<model id>" }
```

When `models.json` holds a key, make it readable only by you. The fields are explained in section 3.3 and in pi's custom model documentation.

On start the desktop package checks that the model it will use is set up: `models.json` registers that provider and model, or `auth.json` has that provider (pi has been logged in to it). When neither holds, or when no model is named at all, the page shows 还没有选定语言模型，助手现在不能工作。 ("no language model is chosen yet; the assistant cannot work") at the top, and its 详情 ("details") gives the reason; with no model named, the assistant is not started. The check reads only these two files; if a provider's key is only in an environment variable (section 3.2), the notice appears although the assistant can in fact work.

### 10.5 When the port is taken

If another program holds 8950, the task service tries 8951 to 8959 and uses the first free port; the address the browser opens changes with it. When all ten are taken, it does not start and says why in the log. The environment variable `TASKWRIGHT_PORT` changes the first port.

[中文版](deployment.zh-CN.md)
