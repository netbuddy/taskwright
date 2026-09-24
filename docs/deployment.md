# Deployment

This page covers everything from a fresh machine to running services: dependencies, installation, connecting a model, starting the services, ports, environment variables, a production build, optional Langfuse tracing, data and backups, and common problems. How to use the running system is in the [user guide](user-guide.md).

This version is meant for a single machine or a trusted local network. There is no authentication yet; do not expose the service to the internet.

## 1 Dependencies

| What | Version | Used by |
|---|---|---|
| Node.js | 24 or newer (uses the built-in `node:sqlite`) | agent, web build, simulator tools |
| Python | 3.12 or newer | server, observatory, simulator driver |
| pi coding agent | `@earendil-works/pi-coding-agent` 0.85.1 | runs the executor and the simulated user |
| A model reachable from pi | any provider pi supports (see section 3) | the executor |

Running Taskwright needs only the Python standard library. Running the tests needs pytest, which comes with the `[test]` extra of the `observatory` and `server` packages.

## 2 Installation

```bash
npm install -g @earendil-works/pi-coding-agent@0.85.1
git clone https://github.com/netbuddy/taskwright.git && cd taskwright
python3 -m venv .venv && . .venv/bin/activate
make install
```

`make install` runs `npm ci` (npm workspaces: agent, web, sim) and `python3 -m pip install -e 'observatory[test]' -e 'server[test]'`. If you do not want pytest, run `npm ci` and `python3 -m pip install -e observatory -e server` instead.

The task service, `scripts/dev.sh`, the terminal client, the TUI and the observatory all run `python3` from your `PATH` and need the packages installed above, so activate the virtual environment (`. .venv/bin/activate` in the repository root) in every new terminal before you start any of them. Otherwise they stop with a `ModuleNotFoundError` for `taskwright_server` or `taskwright_observatory`. The example script `examples/library-lending/run.sh` is the exception: it needs only `curl` and a `python3`.

## 3 Connecting a model

Taskwright does not talk to a model itself. pi does, and the executor uses the model pi was started with. The model is set in the startup profile `server/taskwright_server/profiles/dev.json`:

```json
"model": "openai-codex/gpt-6-luna",
"thinking": "medium",
```

A model name is written as `provider/model`. To use another model, either edit `model` in `dev.json`, or copy the file to `profiles/<name>.json`, edit the copy, and pass `--profile <name>` to the task service, the terminal client or the TUI. `pi --list-models [search]` lists the models pi knows, with their provider names. `pi auth check --provider <provider>` (or `--model <provider/model>`) checks whether pi has usable credentials before you start the service; it prints `ready` when they are usable.

pi keeps its credentials and custom models under `~/.pi/agent/` (`auth.json` and `models.json`; the environment variable `PI_CODING_AGENT_DIR` moves that directory). The task service starts pi with the service's own environment, so environment variables set in the shell that starts the service reach pi.

There are three ways to connect a model.

### 3.1 The default: a ChatGPT (Codex) subscription

The default profile uses `openai-codex/gpt-6-luna`, which needs a ChatGPT Plus or Pro subscription signed in through pi:

```bash
pi                 # start pi's interactive mode once, in any directory
/login             # inside pi: choose "ChatGPT Plus/Pro (Codex)" and finish the sign-in in the browser
```

The token is saved in `~/.pi/agent/auth.json` and refreshed automatically. Check it with `pi auth check --provider openai-codex`. The task service starts pi in RPC mode, which cannot sign in, so do this once beforehand as the same operating-system user that runs the service.

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
| Task service (HTTP/SSE API) | `python3 -m taskwright_server.service --tasks <dir> --runs <dir> --port <port> [--profile <name>]` | none, give one |
| Web interface (development server) | `TASKWRIGHT_API_TARGET=http://127.0.0.1:<api port> npm run dev -w web` | 5680 (`TASKWRIGHT_WEB_PORT`) |
| Both at once | `scripts/dev.sh` (or `make dev`) | API 8790, web 5680 |
| Observatory | `python3 -m taskwright_observatory --runs <archive dir> --workspaces <tasks dir>` | 8770 |

- `--tasks` is where task directories are created (one directory per task, named by task id); `--runs` is where each task's raw pi events and session files are archived (`<runs>/<task id>/pi-events/` and `pi-sessions/`).
- All services bind `0.0.0.0` by default (`--host` changes it).
- Stop services with Ctrl+C or by process id; the task service closes each task's pi process on the way out.

## 5 Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `TASKWRIGHT_RUNS_DIR` | terminal client, TUI, observatory, `scripts/dev.sh` | Archive directory when none is given on the command line (default `./runs`). |
| `TASKWRIGHT_WEB_PORT` | web dev server | Port (default 5680). |
| `TASKWRIGHT_API_TARGET` | web dev server | Where `/api` is proxied (default: the mock server on 5681). |
| `TASKWRIGHT_TASKS_DIR`, `TASKWRIGHT_API_PORT` | `scripts/dev.sh` | Task directory root and API port. |
| `TASKWRIGHT_DEV_REVIEW_AS_MET` | agent | Set to `1` to treat "every item passed review" as met while the reviewer is not yet available. Off by default. |
| `TASKWRIGHT_LANGFUSE_PLUGIN` | server | Location of the optional Langfuse plugin (see section 7). |
| `TASKWRIGHT_LANGFUSE_ENV_FILE` | server, observatory | File holding the Langfuse address and keys. |
| `TASKWRIGHT_LANGFUSE_PROJECT_ID` | observatory | Langfuse project id, for deep links. |
| `TASKWRIGHT_SIM_MATERIALS_DIR` | simulator | Directory holding the persona's materials. |
| provider variables such as `OPENAI_API_KEY` | pi | Model credentials; see section 3.2. |

## 6 Production build of the web interface

Run `npm run build -w web` and serve `web/dist/` behind a reverse proxy that forwards `/api` to the task service. Disable response buffering for `/api/v1/tasks/*/events` (it is a Server-Sent Events stream) and raise the read timeout. Without HTTP/2, a browser allows only about six connections per host, so keep to four open task pages per browser.

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

## 9 Common problems

**pi has no usable model.** If pi cannot start at all (for example the profile names a model pi does not know), opening a session fails: the interface reports that the assistant is unavailable, the executor state becomes `failed_to_start`, and the API returns `executor_unavailable` with the last lines pi wrote to standard error. If pi starts but the model service rejects or does not answer its requests (missing or expired credentials, an endpoint that is down), pi retries and the interface shows that the model service is temporarily unavailable and is being retried (a `problem` event with code `model_unavailable`). Run `pi auth check --model <provider/model>` and `pi --list-models <search>` to find out which case you are in, then fix the credentials or the model name as described in section 3.

**Where to look.**

- The task service prints to the terminal it was started in.
- `<runs>/<task id>/pi-events/` holds, for every start of pi, the raw pi event stream (`<label>-<time>.jsonl`), the backend's own notes such as pi's exit code and standard error (`.backend.jsonl`), and the arrival time of each line (`.times.jsonl`). The format is described in [observatory/archive-format.md](../observatory/archive-format.md).
- `<runs>/<task id>/pi-sessions/` holds pi's session files, that is, the conversation.
- The observatory ([user guide, section 7](user-guide.md#7-see-what-the-assistant-did-the-observatory)) shows the same archives as pages, including every rejected tool call and its reason.

**A write keeps being rejected.** A tool rejects the whole batch when one operation is wrong, and says exactly why. The reason is visible in the observatory's turn view and in `python3 -m taskwright_observatory.dbshow <task dir>`.

**The page stops updating behind a proxy.** Response buffering is on for the event stream; see section 6.

[中文版](deployment.zh-CN.md)
