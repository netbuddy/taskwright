#!/usr/bin/env node
// Measures a built package on Linux: time from start to the browser being opened, time until the page loads,
// the backend's own timing marks, and memory. Each run gets fresh data and cache directories under --dir, so a
// single executable extracts its payload every run (a first start); pass --keep-cache to measure later starts.
//
// Usage:
//   node release/proto/measure.mjs --dir <empty scratch dir> [--runs 3] [--keep-cache] [--hold-pi] -- <command...>
//
// The browser is replaced by a small script that notes the time and loads the page with curl.
// --hold-pi keeps the probed pi process running while memory is read, so its memory is included.
// Only processes started by this script are stopped.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 0) { console.error("usage: measure.mjs --dir <dir> [--runs N] [--keep-cache] [--hold-pi] -- <command...>"); process.exit(2); }
const flags = argv.slice(0, split), command = argv.slice(split + 1);
const option = (name, fallback) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : fallback; };
const dir = path.resolve(option("--dir"));
const runs = Number(option("--runs", 3));
const keepCache = flags.includes("--keep-cache"), holdPi = flags.includes("--hold-pi");
const port = Number(process.env.TASKWRIGHT_PORT || 8950);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function children() {
  const map = new Map();
  for (const pid of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!map.has(ppid)) map.set(ppid, []);
      map.get(ppid).push(Number(pid));
    } catch { /* gone */ }
  }
  return map;
}

function tree(root) {
  const map = children(), out = [], todo = [root];
  while (todo.length) { const pid = todo.pop(); out.push(pid); todo.push(...(map.get(pid) || [])); }
  return out;
}

function rssKb(pid) {
  try { return Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]); } catch { return 0; }
}

function name(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).map((a) => path.basename(a)).slice(0, 3).join(" "); } catch { return "?"; }
}

async function once(index) {
  const run = path.join(dir, `run-${index}`);
  fs.mkdirSync(run, { recursive: true });
  const opened = path.join(run, "opened.txt"), opener = path.join(run, "opener.sh");
  fs.writeFileSync(opener, `#!/bin/sh\ndate +%s%3N >> "${opened}"\ncurl -s -o /dev/null "$1" && date +%s%3N >> "${opened}"\n`, { mode: 0o755 });
  const cache = keepCache ? path.join(dir, "cache") : path.join(run, "cache");
  const env = { ...process.env, TASKWRIGHT_OPEN_WITH: opener, TASKWRIGHT_DATA_DIR: path.join(run, "data"), TASKWRIGHT_CACHE_DIR: cache, TASKWRIGHT_PORT: String(port) };
  if (holdPi) env.TASKWRIGHT_HOLD_PI = "1";
  const log = fs.openSync(path.join(run, "output.log"), "w");
  const started = Date.now();
  const child = spawn(command[0], command.slice(1), { cwd: run, env, stdio: ["ignore", log, log] });
  let exited = false;
  child.on("exit", () => (exited = true));

  let lines = [];
  for (let i = 0; i < 600 && !exited; i++) {   // up to 60 s for the pi check
    await sleep(100);
    lines = fs.readFileSync(path.join(run, "output.log"), "utf8").split("\n");
    if (lines.some((l) => l.includes("pi_checked="))) break;
  }
  await sleep(1000);                            // let the backend settle before reading memory
  const pids = tree(child.pid);
  const memory = pids.map((pid) => ({ pid, what: name(pid), rss_mb: +(rssKb(pid) / 1024).toFixed(1) })).filter((p) => p.rss_mb > 0);
  const marks = Object.fromEntries(lines.map((l) => l.match(/^\[timing\] (\w+)=(\d+)ms/)).filter(Boolean).map((m) => [m[1], Number(m[2])]));
  const times = fs.existsSync(opened) ? fs.readFileSync(opened, "utf8").trim().split("\n").map(Number) : [];

  await fetch(`http://127.0.0.1:${port}/api/v1/proto/quit`, { method: "POST" }).catch(() => {});
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  if (!exited) child.kill("SIGKILL");
  return {
    run: index,
    browser_opened_s: times[0] ? (times[0] - started) / 1000 : null,
    page_loaded_s: times[1] ? (times[1] - started) / 1000 : null,
    marks, memory, total_rss_mb: +memory.reduce((s, p) => s + p.rss_mb, 0).toFixed(1),
  };
}

const median = (values) => { const v = values.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

fs.mkdirSync(dir, { recursive: true });
const results = [];
for (let i = 1; i <= runs; i++) { const r = await once(i); results.push(r); console.log(JSON.stringify(r)); await sleep(500); }
console.log(JSON.stringify({
  command: command.join(" "), runs, keep_cache: keepCache, hold_pi: holdPi,
  median_browser_opened_s: median(results.map((r) => r.browser_opened_s)),
  median_page_loaded_s: median(results.map((r) => r.page_loaded_s)),
  median_total_rss_mb: median(results.map((r) => r.total_rss_mb)),
}));
