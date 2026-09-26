// Launcher of the desktop packages (single executable and AppImage). It is the host layer: it recognizes a
// running instance, prepares the environment for pi, starts the task service in this same process and opens the
// browser. Everything else is the backend's (backend/src/start.ts). Node built-in modules only.
//
// Where things are: this file runs as <root>/app/main.mjs, and the payload repeats the repository's layout, so the
// backend finds its resources from <root> exactly as it does in the repository: <root>/backend/src, <root>/agent,
// <root>/task-types, <root>/server/taskwright_server/profiles and prompts, <root>/web, <root>/pi and <root>/tools.
//
// Order of work:
//   1. From the first port on, ask GET /api/v1/service; if a desktop-mode Taskwright answers, only open the browser.
//   2. Set TASKWRIGHT_PI_ENTRY to the bundled pi; put the bundled rg and fd (pi's grep and find) first on PATH;
//      from an AppImage, copy agent/ once per build to a fixed place and set TASKWRIGHT_AGENT_DIR (see agentDir).
//   3. Start the service with --mode desktop --profile desktop --port <first port> --web <root>/web, then the user's
//      own arguments, which win (for example --host 0.0.0.0).
//   4. Open the browser on the actual port. The console window stays as the status window: closing it stops the service.
//
// Environment:
//   TASKWRIGHT_PORT          first port to try (default 8950); the next nine are tried when it is taken
//   TASKWRIGHT_DATA_DIR      where tasks, archives and logs go (default: the backend's user data directory)
//   TASKWRIGHT_CACHE_DIR     where an AppImage keeps its copy of agent/ (default: the user cache directory)
//   TASKWRIGHT_NO_BROWSER=1  do not open a browser
//   TASKWRIGHT_OPEN_WITH     a command that is run with the URL instead of the platform's opener

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

function cacheDir(): string {
  if (process.env.TASKWRIGHT_CACHE_DIR) return process.env.TASKWRIGHT_CACHE_DIR;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Taskwright", "cache");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "Taskwright");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), APP);
}

// pi loads the TypeScript extension through jiti, whose compile cache is keyed by the file's path. An AppImage is
// mounted at a new random path on every start, so from an AppImage agent/ is copied once per build to a fixed place
// in the user's cache directory, and the backend finds the extension and the platform skill there. A single
// executable already runs from a fixed place (its extracted payload).
function agentDir(): string | null {
  if (!process.env.APPIMAGE) return null;
  const manifest = fs.readFileSync(path.join(ROOT, "manifest.json"));
  const id = crypto.createHash("sha256").update(manifest).digest("hex").slice(0, 16);
  const stable = path.join(cacheDir(), `agent-${id}`);
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

type Options = { port: string; mode: string; profile: string; web: string; host?: string; tasks?: string; runs?: string };

// The package's defaults, then the user's own arguments, which win. Unknown arguments are refused with a sentence.
function options(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" }, host: { type: "string" }, mode: { type: "string" }, profile: { type: "string" },
      web: { type: "string" }, tasks: { type: "string" }, runs: { type: "string" },
    },
    strict: true,
  });
  const data = process.env.TASKWRIGHT_DATA_DIR;
  return {
    port: process.env.TASKWRIGHT_PORT || "8950", mode: "desktop", profile: "desktop", web: path.join(ROOT, "web"),
    ...(data ? { tasks: path.join(data, "tasks"), runs: path.join(data, "runs") } : {}),
    ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)),
  } as Options;
}

async function main(): Promise<void> {
  timing("main_entered");
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

  process.env.TASKWRIGHT_PI_ENTRY ||= PI_ENTRY;
  if (process.env.TASKWRIGHT_DATA_DIR) process.env.TASKWRIGHT_LOG_DIR ||= path.join(process.env.TASKWRIGHT_DATA_DIR, "logs");
  if (fs.existsSync(TOOLS_DIR)) process.env.PATH = `${TOOLS_DIR}${path.delimiter}${process.env.PATH ?? ""}`;
  const agent = agentDir();
  if (agent) process.env.TASKWRIGHT_AGENT_DIR = agent;

  const { startService } = await import(pathToFileURL(path.join(ROOT, "backend", "src", "start.js")).href);
  let started;
  try {
    started = await startService({
      port: first, mode: chosen.mode, host: chosen.host, profile: chosen.profile, web: chosen.web, tasks: chosen.tasks, runs: chosen.runs,
    });
  } catch (error) {
    console.error(`服务没有起来：${(error as Error).message}`);
    process.exit(1);
  }
  timing("listening");
  const url = `http://127.0.0.1:${started.port}/`;
  console.log("");
  console.log(`Taskwright 已启动：${url}`);
  console.log(`数据在 ${path.dirname(started.tasksDir)}。关闭这个窗口或按 Ctrl+C 即退出服务；也可以在页面上点「退出服务」。`);
  console.log("");
  openBrowser(url);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
