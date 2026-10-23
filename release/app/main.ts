// Launcher of the desktop packages (single executable and AppImage). It is the host layer: it recognizes a
// running instance, prepares the environment for pi, starts the task service in this same process and opens the
// browser. Everything else is the backend's (backend/src/start.ts). Node built-in modules only.
//
// Where things are: this file runs as <root>/app/main.mjs, and the payload repeats the repository's layout, so the
// backend finds its resources from <root> exactly as it does in the repository: <root>/backend/src, <root>/agent,
// <root>/task-types, <root>/backend/profiles and prompts, <root>/web, <root>/pi and <root>/tools.
//
// Order of work:
//   1. From the first port on, ask GET /api/v1/service; if a desktop-mode Taskwright answers, only open the browser.
//   2. Everything goes under one root, the data directory (--data, TASKWRIGHT_DATA_DIR, or the backend's user data
//      directory; see backend/src/desktop_dirs.ts): point PI_CODING_AGENT_DIR at <root>/pi, Taskwright's own pi
//      configuration directory (on the first start copy models.json, auth.json and settings.json from ~/.pi/agent when
//      <root>/pi has neither), and keep the program's cache in <root>/cache. Set TASKWRIGHT_PI_ENTRY to the bundled pi;
//      put the bundled rg and fd (pi's grep and find) first on PATH; from an AppImage, copy agent/ once per build to
//      <root>/cache/agent-<build> and set TASKWRIGHT_AGENT_DIR (see agentDir); then remove the cache of older builds.
//   3. Start the service with --mode desktop --profile desktop --port <first port> --web <root>/web, then the user's
//      own arguments, which win (for example --host 0.0.0.0).
//   4. Open the browser on the actual port. The console window stays as the status window: closing it stops the service.
//
// Subcommands (no service is started; see backend/src/desktop_launch.ts):
//   data …                    the backend's data command (upgrade, export, import)
//   service status|stop|restart [--data <dir>]   look at, stop or restart the service of a data directory by its process file
//   observatory [--pack <file> | --runs <dir> --workspaces <dir>] [--port 8770]   the observatory, run with this machine's
//                             Python 3.9 or later (TASKWRIGHT_PYTHON, python3, python; on Windows also py -3); the browser opens on it
//
// Environment:
//   TASKWRIGHT_PORT          first port to try (default 8950); the next nine are tried when it is taken
//   TASKWRIGHT_DATA_DIR      the root: tasks, archives, the knowledge base, logs, settings, pi/ and cache/ (default: the backend's user data directory)
//   TASKWRIGHT_CACHE_DIR     where an AppImage keeps its copy of agent/ and a single executable its payload (default: <root>/cache)
//   PI_CODING_AGENT_DIR      pi's configuration directory (default: <root>/pi)
//   TASKWRIGHT_NO_BROWSER=1  do not open a browser
//   TASKWRIGHT_OPEN_WITH     a command that is run with the URL instead of the platform's opener
//   TASKWRIGHT_PYTHON        the Python interpreter of the observatory subcommand
//
// Set here for the service: TASKWRIGHT_RELAUNCH, the command that restarts it (`service restart`): the AppImage file
// or the single executable itself with the user's arguments, because the node inside a mounted AppImage goes away
// with the mount and a single executable repeats itself in process.argv.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const APP = "taskwright";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI_ENTRY = path.join(ROOT, "pi", "dist", "bundle", "cli.js");
const TOOLS_DIR = path.join(ROOT, "tools");

function timing(mark: string): void {
  console.log(`[timing] ${mark}=${Math.round(performance.now())}ms`);
}

// pi loads the TypeScript extension through jiti, whose compile cache is keyed by the file's path. An AppImage is
// mounted at a new random path on every start, so from an AppImage agent/ is copied once per build to a fixed place
// in the cache directory, and the backend finds the extension and the platform skill there. A single
// executable already runs from a fixed place (its extracted payload).
function agentDir(cache: string): string | null {
  if (!process.env.APPIMAGE) return null;
  const manifest = fs.readFileSync(path.join(ROOT, "manifest.json"));
  const id = crypto.createHash("sha256").update(manifest).digest("hex").slice(0, 16);
  const stable = path.join(cache, `agent-${id}`);
  if (!fs.existsSync(path.join(stable, ".complete"))) {
    const temporary = `${stable}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(stable), { recursive: true });
    fs.cpSync(path.join(ROOT, "agent"), temporary, { recursive: true });
    fs.writeFileSync(path.join(temporary, ".complete"), id);
    try { fs.renameSync(temporary, stable); } catch { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  return stable;
}

function openBrowser(url: string): void {
  if (process.env.TASKWRIGHT_NO_BROWSER === "1") return;
  const custom = process.env.TASKWRIGHT_OPEN_WITH;
  const [command, args] = custom ? [custom, [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => console.log(`没能打开浏览器（${command}），请自己在浏览器里打开 ${url}`));
    child.unref();
    timing("browser_opened");
  } catch {
    console.log(`没能打开浏览器（${command}），请自己在浏览器里打开 ${url}`);
  }
}

// node:http rather than fetch: under wine, fetch could not connect to a local port that node:http reached.
function runningInstance(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/v1/service", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const info = JSON.parse(body);
          resolve(res.statusCode === 200 && info.app === APP && info.mode === "desktop");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

type Options = { port: string; mode: string; profile: string; web: string; host?: string; data?: string; tasks?: string; runs?: string; knowledge?: string; debug?: boolean };

// The package's defaults, then the user's own arguments, which win. Unknown arguments are refused with a sentence.
function options(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" }, host: { type: "string" }, mode: { type: "string" }, profile: { type: "string" },
      web: { type: "string" }, data: { type: "string" }, tasks: { type: "string" }, runs: { type: "string" }, knowledge: { type: "string" },
      // --debug: the backend's debug mode (a prompt directory in the settings, and the debugging requests). Off unless given.
      debug: { type: "boolean" },
    },
    strict: true,
  });
  const data = process.env.TASKWRIGHT_DATA_DIR;
  return {
    port: process.env.TASKWRIGHT_PORT || "8950", mode: "desktop", profile: "desktop", web: path.join(ROOT, "web"),
    ...(data ? { tasks: path.join(data, "tasks"), runs: path.join(data, "runs"), knowledge: path.join(data, "knowledge") } : {}),
    ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)),
  } as Options;
}

/** Whether this process is a Node single executable (SEA). */
function singleExecutable(): boolean {
  try {
    const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
    return Boolean(sea?.isSea?.());
  } catch {
    return false;
  }
}

// `taskwright observatory …`: find Python, run the observatory from the payload, open the browser once it answers,
// and pass Ctrl+C on to it. The exit code is the observatory's.
async function observatory(args: string[]): Promise<number> {
  const { findPython, observatoryLaunch } = await import(pathToFileURL(path.join(ROOT, "backend", "src", "desktop_launch.js")).href);
  const python = findPython(process.env, process.platform);
  if (python.error) {
    console.error(python.error);
    return 2;
  }
  const run = observatoryLaunch(python, ROOT, args, process.env, singleExecutable(), process.execPath);
  const child = spawn(run.command, run.args, { env: run.env, stdio: "inherit", windowsHide: false });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (error) => { console.error(`观测台没有起来：${error.message}`); resolve(1); });
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) process.on(signal, () => child.kill(signal));
  let done = false;
  void exited.then(() => (done = true));
  for (let end = Date.now() + 30_000; !done && Date.now() < end; await new Promise((ok) => setTimeout(ok, 300))) {
    const up = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: run.port, path: "/api/overview", timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
    });
    if (up) {
      openBrowser(`http://127.0.0.1:${run.port}/`);
      break;
    }
  }
  return exited;
}

async function main(): Promise<void> {
  timing("main_entered");
  // `taskwright data upgrade | export | import ...`: no service is started and no browser is opened. The backend's
  // data command does the work (upgrade: look at the data directory, back it up, upgrade what an earlier version
  // left there and print the report; export and import: write and read a data pack; upgrade --pack: upgrade a pack
  // into a new pack); its return value is the exit code. This comes before the look for a running instance: upgrade
  // and import themselves refuse to work on a data directory that a running service is using.
  if (process.argv[2] === "data") {
    const { dataCommand } = await import(pathToFileURL(path.join(ROOT, "backend", "src", "data_command.js")).href);
    process.exit(await dataCommand(process.argv.slice(3)));
  }
  // `taskwright service status|stop|restart`: the backend's service command, by the data directory's process file.
  if (process.argv[2] === "service") {
    const { serviceCommand } = await import(pathToFileURL(path.join(ROOT, "backend", "src", "service_command.js")).href);
    process.exit(await serviceCommand(process.argv.slice(3)));
  }
  if (process.argv[2] === "observatory") process.exit(await observatory(process.argv.slice(3)));
  let chosen: Options;
  try {
    // In a single executable process.argv[1] repeats the executable; with node it is this script. Either way the
    // user's arguments start at index 2.
    chosen = options(process.argv.slice(2));
  } catch (error) {
    console.error(`参数不对：${(error as Error).message}`);
    process.exit(2);
  }
  const first = Number(chosen.port);

  for (let port = first; port < first + 10; port++) {
    if (await runningInstance(port)) {
      console.log(`Taskwright 已经在运行（端口 ${port}），这次只打开浏览器。`);
      openBrowser(`http://127.0.0.1:${port}/`);
      return;
    }
  }

  // A pi entry given from outside is kept, unless the file is gone: a restart brings back the variables of the
  // previous start (see the process file), and an AppImage's earlier mount point no longer exists.
  const givenEntry = process.env.TASKWRIGHT_PI_ENTRY;
  if (!givenEntry || !fs.existsSync(givenEntry)) process.env.TASKWRIGHT_PI_ENTRY = PI_ENTRY;
  const backendLaunch = await import(pathToFileURL(path.join(ROOT, "backend", "src", "desktop_launch.js")).href);
  const relaunch = backendLaunch.relaunchCommand(process.argv, process.env, singleExecutable(), process.execPath);
  if (relaunch) process.env.TASKWRIGHT_RELAUNCH = JSON.stringify(relaunch);
  // The root: the data directory when one is named (--data wins over the environment variable), otherwise the
  // backend's user data directory. When one is named, the logs and the product settings go there too.
  const backend = (name: string) => import(pathToFileURL(path.join(ROOT, "backend", "src", name)).href);
  const { userDataDir } = await backend("paths.js");
  const { adoptPiConfig, desktopLayout, pruneOldBuilds } = await backend("desktop_dirs.js");
  const dataRoot = chosen.data ?? process.env.TASKWRIGHT_DATA_DIR;
  const layout = desktopLayout(dataRoot ?? userDataDir());
  if (dataRoot) {
    process.env.TASKWRIGHT_LOG_DIR ||= path.join(layout.root, "logs");
    process.env.TASKWRIGHT_SETTINGS_FILE ||= path.join(layout.root, "settings.json");
  }
  // What happened before the service started is printed once it has: then it also goes into the service's log file.
  const notes: string[] = [];
  if (!layout.piGiven) {
    process.env.PI_CODING_AGENT_DIR = layout.pi;
    fs.mkdirSync(layout.pi, { recursive: true });
    const legacy = path.join(os.homedir(), ".pi", "agent");
    try {
      const copied = await adoptPiConfig(layout.pi, legacy);
      if (copied) {
        notes.push(`已从本机 pi 的配置 ${copied.from} 复制 ${copied.files.join("、")} 到 ${layout.pi}；之后 Taskwright 只用它自己的这一份，不再读写 ${legacy}。`);
        if (copied.skipped.length) notes.push(`本机 pi 里别的模型服务登记没有复制：${copied.skipped.join("、")}。要在 Taskwright 里用它们，请在设置页面的「模型」一栏里添加。`);
      }
    } catch (error) {
      notes.push(`没能从本机 pi 的配置 ${legacy} 复制：${(error as Error).message}`);
    }
  }
  process.env.TASKWRIGHT_CACHE_DIR = layout.cache;
  // Every Node process started from here (pi among them) also trusts the root certificates in the operating system's
  // store, so model services with a self-signed or company certificate work once its root is installed there. The
  // service in this process does the same on its own at run time (backend/src/system_ca.ts).
  process.env.NODE_USE_SYSTEM_CA ||= "1";
  if (fs.existsSync(TOOLS_DIR)) process.env.PATH = `${TOOLS_DIR}${path.delimiter}${process.env.PATH ?? ""}`;
  const agent = agentDir(layout.cache);
  if (agent) process.env.TASKWRIGHT_AGENT_DIR = agent;
  // The cache of older builds: a single executable runs from <cache>/payload/<build>, an AppImage uses <cache>/agent-<build>.
  const inPayload = path.basename(path.dirname(ROOT)) === "payload" && path.resolve(path.dirname(path.dirname(ROOT))) === layout.cache;
  const removed = pruneOldBuilds(layout.cache, { payload: inPayload ? path.basename(ROOT) : null, agent: agent ? path.basename(agent) : null });
  if (removed.length) notes.push(`删掉了旧构建的程序内容：${removed.map((one: string) => path.join(layout.cache, one)).join("、")}。`);

  const { startService } = await import(pathToFileURL(path.join(ROOT, "backend", "src", "start.js")).href);
  let started;
  try {
    started = await startService({
      port: first, mode: chosen.mode, host: chosen.host, profile: chosen.profile, web: chosen.web, data: chosen.data, tasks: chosen.tasks, runs: chosen.runs, knowledge: chosen.knowledge,
      debug: chosen.debug === true,
    });
  } catch (error) {
    console.error(`服务没有起来：${(error as Error).message}`);
    process.exit(1);
  }
  timing("listening");
  const url = `http://127.0.0.1:${started.port}/`;
  console.log("");
  console.log(`Taskwright 已启动：${url}`);
  console.log(`数据在 ${started.dataDir}。关闭这个窗口或按 Ctrl+C 即退出服务；也可以在页面上点「退出服务」。`);
  for (const note of notes) console.log(note);
  console.log("");
  openBrowser(url);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
