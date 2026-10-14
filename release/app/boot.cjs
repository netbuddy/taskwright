// Bootloader of the single executable (Node SEA). It is the embedded main script, so it must be CommonJS and
// may use Node's built-in modules only.
//
// Two ways it runs:
//   1. TASKWRIGHT_RUN_SCRIPT is set: behave like `node <script> <args>`. The backend starts pi this way, because
//      running the executable itself would start the embedded program again, not pi.
//   2. Otherwise: make sure the payload (launcher, backend, web files, pi, agent, rg and fd) is extracted into the
//      cache directory (<root>/cache/payload/<build>), then load <payload>/app/main.mjs (the launcher). Extraction happens once per payload id; a directory is only
//      used after a marker file says it is complete, and it is written under a temporary name first.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const sea = require("node:sea");
const { pathToFileURL } = require("node:url");

function fail(error) {
  console.error(error);
  process.exit(70);
}

// The same cache directory as the launcher's (release/app/main.ts and backend/src/desktop_dirs.ts): TASKWRIGHT_CACHE_DIR,
// otherwise cache/ under the root, the data directory (--data on the command line, TASKWRIGHT_DATA_DIR, or the user
// data directory of backend/src/paths.ts). payload/ is under it. The launcher gets the same directory through
// TASKWRIGHT_CACHE_DIR, which is set here, and removes the payload of older builds once the service can start.
function cacheDir() {
  if (process.env.TASKWRIGHT_CACHE_DIR) return process.env.TASKWRIGHT_CACHE_DIR;
  const args = process.argv.slice(2);
  let data = process.env.TASKWRIGHT_DATA_DIR || "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && i + 1 < args.length) data = args[i + 1];
    else if (args[i].startsWith("--data=")) data = args[i].slice("--data=".length);
  }
  const root = data ? path.resolve(data)
    : process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Taskwright")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Taskwright")
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "taskwright");
  return path.join(root, "cache");
}

// Payload asset layout (written by release/build.mjs): compressed [u32 index length][index JSON][file bytes...];
// the index lists {p: relative path with forward slashes, s: size, x: executable} in the order of the bytes.
function extract(manifest, target) {
  const packed = Buffer.from(sea.getRawAsset("payload.bin"));
  const raw = manifest.compression === "zstd" ? zlib.zstdDecompressSync(packed) : zlib.gunzipSync(packed);
  const indexLength = raw.readUInt32LE(0);
  const index = JSON.parse(raw.subarray(4, 4 + indexLength).toString("utf8"));
  const temporary = `${target}.tmp-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  let offset = 4 + indexLength;
  const made = new Set();
  for (const entry of index) {
    const file = path.join(temporary, ...entry.p.split("/"));
    const dir = path.dirname(file);
    if (!made.has(dir)) { fs.mkdirSync(dir, { recursive: true }); made.add(dir); }
    fs.writeFileSync(file, raw.subarray(offset, offset + entry.s), { mode: entry.x ? 0o755 : 0o644 });
    offset += entry.s;
  }
  fs.writeFileSync(path.join(temporary, ".complete"), manifest.id);
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    // Another start extracted the same payload at the same time; use theirs.
    fs.rmSync(temporary, { recursive: true, force: true });
    if (!fs.existsSync(path.join(target, ".complete"))) throw error;
  }
}

const script = process.env.TASKWRIGHT_RUN_SCRIPT;
if (script) {
  delete process.env.TASKWRIGHT_RUN_SCRIPT;
  // In a single executable process.argv[1] repeats the executable; replace it by the script, as node would.
  process.argv = [process.argv[0], script, ...process.argv.slice(2)];
  import(pathToFileURL(script).href).catch(fail);
} else {
  try {
    const manifest = JSON.parse(sea.getAsset("manifest.json", "utf8"));
    const cache = cacheDir();
    process.env.TASKWRIGHT_CACHE_DIR = cache;
    const target = path.join(cache, "payload", manifest.id);
    if (!fs.existsSync(path.join(target, ".complete"))) {
      const started = performance.now();
      console.log(`First start of this build: extracting to ${target}`);
      extract(manifest, target);
      console.log(`[timing] extracted_in=${Math.round(performance.now() - started)}ms`);
    }
    import(pathToFileURL(path.join(target, "app", "main.mjs")).href).catch(fail);
  } catch (error) {
    fail(error);
  }
}
