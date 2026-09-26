// Prototype backend for the single-executable package. It stands in for the real task service while the
// packaging chain is worked out, and uses Node's built-in modules only.
//
// What it does:
//   - serves the web interface's static files (SPA fallback to index.html) and a fixed GET /api/v1/tasks;
//   - opens a SQLite database with node:sqlite in the user's data directory, writes one row and reads it back;
//   - starts pi the way the task service does (a child process in RPC mode that loads the agent extension),
//     asks it for its state and commands, then closes it; the result is at GET /api/v1/proto/selfcheck;
//   - opens the system browser once the server listens.
//
// Where things are: this file runs as <payload>/app/main.mjs, and every resource is found relative to the
// payload root (<payload>/web, <payload>/pi, <payload>/agent). The same payload runs from an AppImage (read-only,
// next to a plain node binary) and from a single executable (extracted to the user's cache directory first).
//
// Environment:
//   TASKWRIGHT_PORT          first port to try (default 8950); the next nine are tried when it is taken
//   TASKWRIGHT_HOST          address to bind (default 0.0.0.0)
//   TASKWRIGHT_DATA_DIR      where the database lives (default: the platform's user data directory)
//   TASKWRIGHT_CACHE_DIR     where an AppImage keeps its copy of the agent extension (default: the user cache directory)
//   TASKWRIGHT_NO_BROWSER=1  do not open a browser
//   TASKWRIGHT_OPEN_WITH     a command that is run with the URL instead of the platform's opener
//   TASKWRIGHT_HOLD_PI=1     keep the probed pi process running until the server stops (for memory measurements)

import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sea from "node:sea";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const APP = "taskwright-proto";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(ROOT, "web");
const PI_CLI = path.join(ROOT, "pi", "dist", "bundle", "cli.js");
const EXTENSION = path.join(ROOT, "agent", "src", "extension.ts");
const IS_SEA = sea.isSea();

function sinceStart(): number {
  return Math.round(performance.now());
}

function timing(mark: string): void {
  console.log(`[timing] ${mark}=${sinceStart()}ms`);
}

function cacheDir(): string {
  if (process.env.TASKWRIGHT_CACHE_DIR) return process.env.TASKWRIGHT_CACHE_DIR;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), APP, "payload");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", APP, "payload");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), APP, "payload");
}

function dataDir(): string {
  const configured = process.env.TASKWRIGHT_DATA_DIR;
  if (configured) return configured;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), APP);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", APP);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), APP);
}

// ---- SQLite ----------------------------------------------------------------------------------------------

type SqliteCheck = { ok: boolean; path: string; rows?: number; last?: unknown; error?: string };

function checkSqlite(dir: string): SqliteCheck {
  const file = path.join(dir, "proto.sqlite");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS boot (id INTEGER PRIMARY KEY, at TEXT NOT NULL, node TEXT NOT NULL, sea INTEGER NOT NULL)");
    db.prepare("INSERT INTO boot (at, node, sea) VALUES (?, ?, ?)").run(new Date().toISOString(), process.version, IS_SEA ? 1 : 0);
    const rows = (db.prepare("SELECT count(*) AS n FROM boot").get() as { n: number }).n;
    const last = db.prepare("SELECT id, at, node, sea FROM boot ORDER BY id DESC LIMIT 1").get();
    db.close();
    return { ok: true, path: file, rows, last };
  } catch (error) {
    return { ok: false, path: file, error: String(error) };
  }
}

// ---- pi --------------------------------------------------------------------------------------------------

// pi loads the TypeScript extension through jiti, which caches the compiled code under a key that includes the
// file's path. An AppImage is mounted at a new random path on every start, so that cache would never be hit and
// every pi start would compile the extension again (about 1 s and 150 MB more). From an AppImage the agent
// directory is therefore copied once per build to a stable place in the user's cache directory. A single
// executable already runs from a stable place (its extracted payload).
function extensionEntry(): string {
  if (!process.env.APPIMAGE) return EXTENSION;
  const manifest = fs.readFileSync(path.join(ROOT, "manifest.json"));
  const id = crypto.createHash("sha256").update(manifest).digest("hex").slice(0, 16);
  const stable = path.join(cacheDir(), `agent-${id}`);
  if (!fs.existsSync(path.join(stable, ".complete"))) {
    const temporary = `${stable}.tmp-${process.pid}`;
    fs.cpSync(path.join(ROOT, "agent"), temporary, { recursive: true });
    fs.writeFileSync(path.join(temporary, ".complete"), id);
    try { fs.renameSync(temporary, stable); } catch { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  return path.join(stable, path.relative(path.join(ROOT, "agent"), EXTENSION));
}

// A single executable is the Node runtime itself, but running it starts the embedded program, not a script.
// The bootloader therefore runs the script named in TASKWRIGHT_RUN_SCRIPT as plain Node would. With a plain
// node binary (AppImage, development) the script is simply the first argument.
function spawnNodeScript(script: string, args: string[], options: { cwd: string }): ChildProcess {
  if (IS_SEA) {
    return spawn(process.execPath, args, {
      cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, TASKWRIGHT_RUN_SCRIPT: script },
    });
  }
  return spawn(process.execPath, [script, ...args], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

type PiVersion = { ok: boolean; version?: string; ms: number; error?: string };
type PiRpc = { ok: boolean; ms: number; model?: string | null; commands?: string[]; exit?: number | null; error?: string; stderr?: string };

function piVersion(cwd: string): Promise<PiVersion> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawnNodeScript(PI_CLI, ["--version"], { cwd });
    let out = "", err = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    child.stdin!.end();
    child.on("error", (error) => resolve({ ok: false, ms: Date.now() - started, error: String(error) }));
    child.on("exit", (code) => resolve(code === 0
      ? { ok: true, version: out.trim(), ms: Date.now() - started }
      : { ok: false, ms: Date.now() - started, error: `exit ${code}: ${err.trim().slice(-500)}` }));
  });
}

let heldPi: ChildProcess | null = null;

// Start pi in RPC mode with the agent extension, ask for its state and commands, then close its input so it
// exits. No model is contacted (--offline, and neither command starts a turn).
function piRpc(dir: string): Promise<PiRpc> {
  const started = Date.now();
  const workspace = path.join(dir, "workspace");
  const sessions = path.join(dir, "pi-sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--offline", "--session-dir", sessions, "-e", extensionEntry()];
  const hold = process.env.TASKWRIGHT_HOLD_PI === "1";
  return new Promise((resolve) => {
    const child = spawnNodeScript(PI_CLI, args, { cwd: workspace });
    let buffer = "", err = "", settled = false;
    const responses: Record<string, any> = {};
    const finish = (result: PiRpc) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, ms: Date.now() - started, error: "no answer within 30 s", stderr: err.slice(-800) }); }, 30_000);
    const summary = (exit: number | null): PiRpc => {
      const state = responses.get_state, commands = responses.get_commands;
      return {
        ok: Boolean(state?.success && commands?.success), ms: Date.now() - started, exit,
        model: state?.data?.model?.id ?? null,
        commands: (commands?.data?.commands || []).map((c: any) => `${c.source}:${c.name}`),
        stderr: err.slice(-800),
      };
    };
    child.stdout!.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === "response") responses[message.command] = message;
        } catch { /* not a JSON line */ }
        if (responses.get_state && responses.get_commands) {
          if (hold) { heldPi = child; finish(summary(null)); } else child.stdin!.end();
        }
      }
    });
    child.stderr!.on("data", (d) => (err += d));
    child.on("error", (error) => finish({ ok: false, ms: Date.now() - started, error: String(error) }));
    child.on("exit", (code) => finish(summary(code)));
    child.stdin!.write(JSON.stringify({ id: "1", type: "get_state" }) + "\n");
    child.stdin!.write(JSON.stringify({ id: "2", type: "get_commands" }) + "\n");
  });
}

// ---- HTTP ------------------------------------------------------------------------------------------------

const TASKS = {
  ok: true,
  tasks: [{
    task_id: "TASK-PROTO-0001", task_name: "Packaging prototype", task_type: "srs", domain_tag: "prototype",
    status: "in_progress", item_count: 0, completion_met: 0, completion_total: 0, completion_unmet: 0,
    last_active_at: "2026-01-01T00:00:00Z", session_count: 0, supported: true,
  }],
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 1);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function sendStatic(res: http.ServerResponse, urlPath: string): void {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, "");
  let file = path.resolve(WEB_DIR, relative);
  if (!file.startsWith(WEB_DIR)) return sendJson(res, 400, { ok: false, error: { code: "bad_request" } });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, "index.html");
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(file).pipe(res);
}

type SelfCheck = { sqlite?: SqliteCheck; pi_version?: PiVersion; pi_rpc?: PiRpc };
const selfCheck: SelfCheck = {};
let selfCheckDone: Promise<void> | null = null;

function runPiChecks(dir: string): Promise<void> {
  selfCheckDone = (async () => {
    selfCheck.pi_version = await piVersion(dir);
    selfCheck.pi_rpc = await piRpc(dir);
    console.log(`pi ${selfCheck.pi_version.ok ? selfCheck.pi_version.version : "FAILED"}; RPC with extension ${selfCheck.pi_rpc.ok ? "ok" : "FAILED"} (${selfCheck.pi_rpc.ms} ms)`);
    if (!selfCheck.pi_rpc.ok) console.log(JSON.stringify(selfCheck.pi_rpc));
    timing("pi_checked");
  })();
  return selfCheckDone;
}

function makeServer(dir: string): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/api/v1/tasks" && req.method === "GET") return sendJson(res, 200, TASKS);
    if (url.pathname === "/api/v1/proto/ping") return sendJson(res, 200, { ok: true, app: APP, pid: process.pid });
    if (url.pathname === "/api/v1/proto/selfcheck") {
      if (url.searchParams.get("refresh") === "1" || !selfCheckDone) runPiChecks(dir);
      await selfCheckDone;
      return sendJson(res, 200, {
        ok: Boolean(selfCheck.sqlite?.ok && selfCheck.pi_version?.ok && selfCheck.pi_rpc?.ok),
        node: process.version, platform: `${process.platform}-${process.arch}`, sea: IS_SEA, root: ROOT, data_dir: dir,
        pid: process.pid, pi_pid: heldPi?.pid ?? null, ...selfCheck,
      });
    }
    if (url.pathname === "/api/v1/proto/quit" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      return shutdown();
    }
    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: { code: "not_found", message: "not part of the prototype" } });
    return sendStatic(res, url.pathname);
  });
}

// ---- browser -------------------------------------------------------------------------------------------

function openBrowser(url: string): void {
  if (process.env.TASKWRIGHT_NO_BROWSER === "1") return;
  const custom = process.env.TASKWRIGHT_OPEN_WITH;
  const [command, args] = custom ? [custom, [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => console.log(`Could not start ${command}; open ${url} yourself.`));
    child.unref();
    timing("browser_opened");
  } catch {
    console.log(`Could not start ${command}; open ${url} yourself.`);
  }
}

// ---- start -----------------------------------------------------------------------------------------------

// node:http rather than fetch: under wine, fetch could not connect to a local port that node:http reached.
function isOurs(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/v1/proto/ping", timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => { try { resolve(res.statusCode === 200 && JSON.parse(body).app === APP); } catch { resolve(false); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

function listen(server: http.Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
}

let server: http.Server | null = null;

function shutdown(): void {
  heldPi?.stdin?.end();
  server?.close();
  setTimeout(() => process.exit(0), 200).unref();
}

async function main(): Promise<void> {
  timing("main_entered");
  const first = Number(process.env.TASKWRIGHT_PORT || 8950);
  const host = process.env.TASKWRIGHT_HOST || "0.0.0.0";
  const dir = dataDir();

  // A second start while one is running only opens the browser on the running one.
  for (let port = first; port < first + 10; port++) {
    if (await isOurs(port)) {
      console.log(`${APP} is already running on port ${port}; opening the browser.`);
      openBrowser(`http://127.0.0.1:${port}/`);
      return;
    }
  }

  selfCheck.sqlite = checkSqlite(dir);
  console.log(`SQLite ${selfCheck.sqlite.ok ? `ok, ${selfCheck.sqlite.rows} row(s)` : `FAILED: ${selfCheck.sqlite.error}`} at ${selfCheck.sqlite.path}`);
  timing("sqlite_checked");

  server = makeServer(dir);
  let port = first;
  while (!(await listen(server, port, host))) {
    if (++port >= first + 10) throw new Error(`ports ${first} to ${first + 9} are all taken`);
  }
  const url = `http://127.0.0.1:${port}/`;
  console.log(`${APP} ${IS_SEA ? "(single executable)" : "(node)"} ${process.version} serving ${ROOT} on ${url}`);
  timing("listening");
  openBrowser(url);
  runPiChecks(dir);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((error) => { console.error(error); process.exit(1); });
