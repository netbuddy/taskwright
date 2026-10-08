# Desktop packages

This directory builds the windowless desktop packages: one file that contains the Node runtime, the task service, pi, the web interface and the two search programs pi uses. Starting it starts the service on this computer, bound to 127.0.0.1, and opens the system browser. It is the transitional package of 0.3; the desktop shell comes later.

Nothing built here is committed. The packages go to a directory outside the repository.

## What is built

| File | What it is |
|---|---|
| `taskwright-x86_64.AppImage` | Linux. An AppImage holding the official Node binary and the payload as plain files; nothing is extracted. |
| `taskwright-linux-x64` | Linux. A Node single executable application (SEA) with the payload embedded; the payload is extracted to the user cache directory on the first start of each build. |
| `taskwright-win-x64.exe` | Windows, built on Linux. The same single executable, made from the official `node.exe`. |

The payload repeats the repository's layout, so the backend finds its resources exactly as it does in the repository:

| Path in the payload | What it is |
|---|---|
| `app/main.mjs` | The launcher (`app/main.ts` with its types removed). |
| `backend/src/*.js`, `backend/package.json` | The task service. Every file it imports has its types removed and its `.ts` imports rewritten to `.js`; the backend's tests, comparison scripts and fake model endpoint are left out. |
| `agent/` | The pi extension and its prompts (`src/`, `prompts/`, `package.json`). The library files the backend imports are there twice: `.ts` for pi, which loads the extension through jiti, and `.js` for the backend. |
| `task-types/` | The task type templates. |
| `backend/vendor/mermaid/` | The diagram check engine: `backend/src/diagram_engine.mjs` bundled with the mermaid package into files Node loads without `node_modules`, reduced to the files the five kinds of diagram use (about 1 MB), and in `licenses/` the licence files of mermaid and of the packages whose code is in those files, listed in `licenses/PACKAGES.txt` (a package that ships no licence file and states MIT in its `package.json` gets the standard MIT text, written from that file). In the repository this directory does not exist and the backend loads mermaid from `node_modules`. |
| `backend/vendor/docx/` | The [docx](https://github.com/dolanmiu/docx) package (9.9.0, MIT), with which the backend writes the Word file of exported items: `backend/src/docx_lib.mjs` bundled with docx and what it imports into one file (about 0.5 MB), and in `licenses/` the licence files of the packages whose code is in it, listed in `licenses/PACKAGES.txt`. In the repository the backend loads docx from `node_modules`. |
| `backend/profiles/desktop.json`, `backend/prompts/` | The launch profile the packages start with (the development and test profiles are left out) and the executor's system prompt. |
| `web/` | The built web interface, served by the backend (`--web`). |
| `pi/` | The part of the installed pi package that pi loads at run time, about 15 MB of the 400 MB npm installs. |
| `tools/` | rg (ripgrep) and fd for the target platform, with their licence files. |
| `package.json`, `manifest.json` | The product name and version; what went into this build. |

## Files

| File | Purpose |
|---|---|
| `build.mjs` | Builds the payload and the packages. Node built-in modules only; downloads Node binaries, rg, fd, appimagetool and the AppImage runtime into a cache directory, each a pinned version checked against its checksum; appimagetool is given the checked runtime, so it downloads nothing by itself. |
| `diagram/` | For the diagram check engine: `vite.config.mjs` bundles it, `prune.mjs` finds the files it loads for the sample texts in `samples.mjs`, so that `build.mjs` can remove the rest, and checks the reduced bundle against the same samples; the build fails when a sample no longer gives the result it should. The bundle also records which source files went into each file it writes, from which `build.mjs` finds the packages whose licence files to ship. |
| `docx/` | For the docx package: `vite.config.mjs` bundles it, `check.mjs` writes a small Word document with the bundle; the build fails when that does not work. |
| `pi/` | Pins the pi that goes into the packages: `package.json` with one exact version, `package-lock.json` with every dependency and its checksum, and the npm settings both are used with. `build.mjs` installs pi from it; `pi/README.md` says how to upgrade. |
| `app/main.ts` | The launcher: recognizes a running instance, sets up pi, rg and fd, starts the service in the same process and opens the browser. |
| `app/boot.cjs` | The single executable's embedded main script: extracts the payload once, or runs a script as plain Node would (this is how the backend starts pi). |
| `measure.mjs` | Measures start time, time to the browser being opened, and memory, over several runs (Linux). |
| `appimage/` | The AppImage's entry script, desktop entry and icon. |

## Building

Requirements: Node 24 with npm, network access for the first build, and postject installed **outside** this repository:

```bash
npm install --prefix ~/.cache/taskwright-tools postject@1.0.0-alpha.6
node release/build.mjs --out /tmp/taskwright-package --postject ~/.cache/taskwright-tools/node_modules/.bin/postject
```

The build installs pi by itself. It copies `release/pi/package.json`, `package-lock.json` and `.npmrc` into the staging directory and runs `npm ci --omit=dev --ignore-scripts` there, so every build packs the pi version and the dependencies the lock file names; npm's downloads are kept under the cache directory. The build stops when the installed pi is not the pinned version, when a dependency differs from the lock file, or when the packages it keeps are not inside pi's own `node_modules/`. A globally installed pi is neither needed nor used. `--pi-dir <dir>` packs an already installed pi instead: its version must be the pinned one, and where its dependencies differ from the lock file the build prints warnings. `manifest.json` in the package records the pi version and the versions of the pi dependencies that were packed.

Do not run `npm install` or `npm ci` inside the repository for this. `--targets linux-x64` or `--formats appimage` builds a subset; `node release/build.mjs --help` lists every option.

## Running

```bash
/tmp/taskwright-package/taskwright-x86_64.AppImage      # or taskwright-linux-x64, or the .exe on Windows
```

The launcher starts the service with `--mode desktop --profile desktop --port 8950 --web <payload>/web`; arguments given on the command line are passed on and win, for example `--host 0.0.0.0`. The service listens on the first free port from 8950 to 8959 and the browser opens `http://127.0.0.1:<port>/`. Starting the package again while it runs only opens the browser. The service stops when its console window is closed, on Ctrl+C, or with the exit command in the page's user menu.

Data (tasks, archives, logs) goes to the user data directory (`~/.local/share/taskwright` on Linux, `%LOCALAPPDATA%\Taskwright` on Windows). The model service comes from pi's configuration directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`); the package contains no keys. Setting up a model service is described in the deployment guide.

Environment variables read by the launcher: `TASKWRIGHT_PORT` (first port), `TASKWRIGHT_DATA_DIR` (tasks, archives and logs in one directory), `TASKWRIGHT_CACHE_DIR` (the extracted payload and the AppImage's copy of `agent/`), `TASKWRIGHT_NO_BROWSER=1`, `TASKWRIGHT_OPEN_WITH` (a command run with the URL instead of the browser).

Measuring (Linux; the browser is replaced by a script that notes the time and loads the page):

```bash
node release/measure.mjs --dir /tmp/taskwright-measure --runs 3 --with-pi -- /tmp/taskwright-package/taskwright-x86_64.AppImage
```

## rg and fd

pi's `grep` and `find` tools run [ripgrep](https://github.com/BurntSushi/ripgrep) and [fd](https://github.com/sharkdp/fd). pi looks for them in its configuration directory's `bin/`, then on `PATH`, and downloads them from GitHub on first use if neither has them, which fails without network access. The packages carry both (ripgrep 15.2.0 and fd 10.5.0, the official release builds for each platform) in `tools/`, and the launcher puts that directory first on `PATH` for the service and pi.

Licences: ripgrep is dual-licensed under the MIT licence and the Unlicense; fd is dual-licensed under the MIT licence and the Apache License 2.0. Their licence files are shipped next to the programs in `tools/` (`rg-COPYING`, `rg-LICENSE-MIT`, `rg-UNLICENSE`, `fd-LICENSE-MIT`, `fd-LICENSE-APACHE`).
