# Packaging prototype

This directory holds a prototype of the windowless single-file package: one file that contains the Node runtime, the backend, pi and the web interface, starts the service and opens the system browser. The backend here is a stand-in (`proto/main.ts`) with just enough behavior to prove the packaging chain; it is replaced by the real backend once that runs on Node.

Nothing built here is committed. The packages go to a directory outside the repository.

## What is built

| File | What it is |
|---|---|
| `taskwright-proto-x86_64.AppImage` | Linux. An AppImage holding the official Node binary and the payload as plain files; nothing is extracted. |
| `taskwright-proto-linux-x64` | Linux. A Node single executable application (SEA) with the payload embedded; the payload is extracted to the user cache directory on the first start of each build. |
| `taskwright-proto-win-x64.exe` | Windows, built on Linux. The same single executable, made from the official `node.exe`. |

The payload is one directory: `app/main.mjs` (the backend), `web/` (the built web interface), `pi/` (the part of the installed pi package that pi loads at run time, about 14 MB of the 400 MB npm installs), `agent/` (the extension and its prompts) and `manifest.json`.

## Files

| File | Purpose |
|---|---|
| `build.mjs` | Builds the payload and the packages. Node built-in modules only; downloads Node binaries (checked against the official checksums) and appimagetool into a cache directory. |
| `proto/main.ts` | The stand-in backend: static files, `GET /api/v1/tasks`, a SQLite round trip with `node:sqlite`, a pi check (version, and RPC mode with the extension), opening the browser, one instance per user. |
| `proto/boot.cjs` | The single executable's embedded main script: extracts the payload once, or runs a script as plain Node would (this is how the backend starts pi). |
| `proto/measure.mjs` | Measures start time, time to the browser being opened, and memory, over several runs (Linux). |
| `appimage/` | The AppImage's entry script, desktop entry and icon. |

## Building

Requirements: Node 24, pi installed globally (`npm install -g @earendil-works/pi-coding-agent@0.85.1`), network access for the first build, and postject installed **outside** this repository:

```bash
npm install --prefix ~/.cache/taskwright-tools postject@1.0.0-alpha.6
node release/build.mjs --out /tmp/taskwright-package --postject ~/.cache/taskwright-tools/node_modules/.bin/postject
```

Do not run `npm install` or `npm ci` inside the repository for this. `--targets linux-x64` or `--formats appimage` builds a subset; `node release/build.mjs --help` lists every option.

## Running

```bash
/tmp/taskwright-package/taskwright-proto-x86_64.AppImage      # or taskwright-proto-linux-x64, or the .exe on Windows
```

The service listens on the first free port from 8950 to 8959 and opens `http://127.0.0.1:<port>/`. `GET /api/v1/proto/selfcheck` reports the SQLite and pi checks; `POST /api/v1/proto/quit` stops the service. Starting it again while it runs only opens the browser. Environment variables are listed at the top of `proto/main.ts`.

Measuring (Linux; the browser is replaced by a script that notes the time and loads the page):

```bash
node release/proto/measure.mjs --dir /tmp/taskwright-measure --runs 3 --hold-pi -- /tmp/taskwright-package/taskwright-proto-x86_64.AppImage
```
