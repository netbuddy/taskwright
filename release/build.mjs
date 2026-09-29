#!/usr/bin/env node
// Builds the desktop packages: a payload (launcher, backend, web files, pi, agent extension, rg and fd) and, from it,
// a Linux AppImage and single executables (Node SEA) for Linux and Windows. Node built-in modules only.
//
// Usage:
//   node release/build.mjs --out <dir> [options]
//
// Options:
//   --out <dir>           where the packages go (required; must be outside the repository)
//   --work <dir>          staging directory (default: <out>/work)
//   --cache <dir>         downloads: Node binaries, rg and fd, appimagetool (default: <out>/cache)
//   --targets <list>      linux-x64,win-x64 (default: both)
//   --formats <list>      appimage,sea (default: both; appimage is built for linux-x64 only)
//   --node-version <v>    Node version put into the packages (default 24.15.0)
//   --pi-dir <dir>        installed pi package (default: <npm root -g>/@earendil-works/pi-coding-agent)
//   --web-dist <dir>      a built web interface (default: build it now with the repository's vite)
//   --postject <path>     the postject executable, needed for sea. Install it outside the repository, e.g.
//                         `npm install --prefix <tools dir> postject@1.0.0-alpha.6`; never in this repository.
//   --appimagetool <path> appimagetool (default: download the continuous build into the cache)
//   --level <n>           zstd level of the single executable's payload (default 19)
//
// Nothing is written inside the repository. Do not run npm install or npm ci in the repository for this.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_VERSION = "0.85.1";
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// ---- arguments -------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--help" || name === "-h") usage();
    if (!name.startsWith("--") || i + 1 >= argv.length) usage(`unexpected argument ${name}`);
    options[name.slice(2)] = argv[++i];
  }
  if (!options.out) usage("--out is required");
  return options;
}

function usage(message) {
  if (message) console.error(`build.mjs: ${message}`);
  (message ? console.error : console.log)(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(4, 21).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(message ? 2 : 0);
}

function outsideRepo(dir, name) {
  const absolute = path.resolve(dir);
  const relative = path.relative(REPO, absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) usage(`${name} must be outside the repository: ${absolute}`);
  return absolute;
}

const log = (...parts) => console.log("build:", ...parts);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

// ---- files -----------------------------------------------------------------------------------------------

// Copy a tree; keep(relativePath, isDirectory) decides what goes in. Symbolic links are not followed.
function copyTree(src, dst, keep = () => true, relative = "") {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const child = path.join(src, name);
      if (!keep(childRelative, fs.lstatSync(child).isDirectory())) continue;
      copyTree(child, path.join(dst, name), keep, childRelative);
    }
    return;
  }
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, stat.mode & 0o777);
}

function listFiles(root, relative = "") {
  const out = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const rel = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, rel));
    if (stat.isDirectory()) out.push(...listFiles(root, rel));
    else if (stat.isFile()) out.push({ rel, size: stat.size, exec: (stat.mode & 0o111) !== 0 });
  }
  return out;
}

function treeSize(root) {
  return listFiles(root).reduce((sum, f) => sum + f.size, 0);
}

// ---- downloads -------------------------------------------------------------------------------------------

async function download(url, file) {
  if (fs.existsSync(file)) return file;
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${file}.part`, file);
  return file;
}

async function nodeBinary(cache, version, target) {
  const base = `https://nodejs.org/dist/v${version}`;
  const sums = fs.readFileSync(await download(`${base}/SHASUMS256.txt`, path.join(cache, `node-${version}-SHASUMS256.txt`)), "utf8");
  const verify = (file, name) => {
    const expected = sums.split("\n").find((line) => line.endsWith(`  ${name}`))?.split(" ")[0];
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (expected !== actual) throw new Error(`checksum mismatch for ${name}`);
  };
  if (target === "win-x64") {
    const file = await download(`${base}/win-x64/node.exe`, path.join(cache, `node-${version}-win-x64.exe`));
    verify(file, "win-x64/node.exe");
    return file;
  }
  const name = `node-v${version}-${target}.tar.xz`;
  const archive = await download(`${base}/${name}`, path.join(cache, name));
  const binary = path.join(cache, `node-${version}-${target}`);
  if (!fs.existsSync(binary)) {
    verify(archive, name);
    const dir = fs.mkdtempSync(path.join(cache, "unpack-"));
    execFileSync("tar", ["-xJf", archive, "-C", dir, `node-v${version}-${target}/bin/node`]);
    fs.renameSync(path.join(dir, `node-v${version}-${target}`, "bin", "node"), binary);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return binary;
}

// ---- rg and fd -------------------------------------------------------------------------------------------

// pi's grep and find tools run rg (ripgrep) and fd. pi looks for them in its configuration directory's bin/ and then
// on PATH, and downloads them from GitHub on first use when neither has them, which fails offline. The packages
// therefore carry both, and the launcher puts <root>/tools first on PATH. Versions are pinned; the SHA-256 values
// are ripgrep's published ones and, for fd (which publishes none), the values of the first download.
const TOOLS = {
  rg: {
    version: "15.2.0",
    url: (v, t) => `https://github.com/BurntSushi/ripgrep/releases/download/${v}/ripgrep-${v}-${t === "win-x64" ? "x86_64-pc-windows-msvc.zip" : "x86_64-unknown-linux-musl.tar.gz"}`,
    sha256: { "linux-x64": "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c", "win-x64": "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5" },
    licenses: ["COPYING", "LICENSE-MIT", "UNLICENSE"],
  },
  fd: {
    version: "10.5.0",
    url: (v, t) => `https://github.com/sharkdp/fd/releases/download/v${v}/fd-v${v}-${t === "win-x64" ? "x86_64-pc-windows-msvc.zip" : "x86_64-unknown-linux-musl.tar.gz"}`,
    sha256: { "linux-x64": "761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7", "win-x64": "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7" },
    licenses: ["LICENSE-MIT", "LICENSE-APACHE"],
  },
};

// The files of a zip archive whose last path part is in `wanted`, read with zlib only: enough for the two release archives.
function unzipNames(file, wanted) {
  const zip = fs.readFileSync(file);
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${file}: not a zip archive`);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const base = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8").split("/").pop();
    if (wanted.includes(base)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      out[base] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    }
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

// Put rg and fd, and their licence files prefixed with the tool's name, into <dir> for one target.
async function stageTools(cache, target, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const versions = {};
  for (const [tool, spec] of Object.entries(TOOLS)) {
    const url = spec.url(spec.version, target);
    const archive = await download(url, path.join(cache, path.basename(url)));
    const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (actual !== spec.sha256[target]) throw new Error(`checksum mismatch for ${path.basename(url)}: ${actual}`);
    const binary = target === "win-x64" ? `${tool}.exe` : tool;
    const wanted = [binary, ...spec.licenses];
    let files;
    if (archive.endsWith(".zip")) files = unzipNames(archive, wanted);
    else {
      const unpack = fs.mkdtempSync(path.join(cache, "unpack-"));
      execFileSync("tar", ["-xzf", archive, "-C", unpack]);
      files = {};
      for (const f of listFiles(unpack)) {
        const base = f.rel.split("/").pop();
        if (wanted.includes(base)) files[base] = fs.readFileSync(path.join(unpack, f.rel));
      }
      fs.rmSync(unpack, { recursive: true, force: true });
    }
    for (const name of wanted) if (!files[name]) throw new Error(`${path.basename(url)} has no ${name}`);
    fs.writeFileSync(path.join(dir, binary), files[binary], { mode: 0o755 });
    for (const name of spec.licenses) fs.writeFileSync(path.join(dir, `${tool}-${name}`), files[name]);
    versions[tool] = spec.version;
  }
  return versions;
}

// ---- payload ---------------------------------------------------------------------------------------------

const TARGETS = ["linux-x64", "win-x64"];

// pi as installed by npm is about 400 MB: every platform's esbuild (pi's bundle never imports it), the provider
// SDKs that the bundle already contains, type declarations and source maps. What pi loads at run time is its own
// dist/ (the bundle plus themes and the HTML export template) and three packages outside the bundle: chord,
// jiti (loads the TypeScript extension) and photon-node (image resizing, WebAssembly, so the same on every
// platform). The bundle answers the extension's imports of pi's packages and typebox itself. Nothing native is
// left, so the same pi goes into every target.
const PI_KEEP = ["package.json", "dist", "node_modules/@earendil-works/chord", "node_modules/jiti", "node_modules/@silvia-odwyer/photon-node"];

// Keep a listed path, everything under it, and the directories leading to it (without their other contents).
function piKeep(rel) {
  if (/\.(map|d\.ts|d\.mts|d\.cts)$/.test(rel)) return false;
  return PI_KEEP.some((kept) => rel === kept || rel.startsWith(`${kept}/`) || kept.startsWith(`${rel}/`));
}

// Relative import specifiers ending in .ts or .mts, in `from "…"`, `import "…"` and `import("…")`.
const TS_IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']+?)\.(m?)ts\2/g;

// The backend runs as JavaScript in the packages: every file it imports, starting from its two entry points, has
// its types removed with Node's stripTypeScriptTypes (the backend only uses erasable syntax) and its relative
// .ts/.mts imports rewritten to .js/.mjs. The files keep their places, so agent/src/lib/*.js lands next to the .ts
// files that pi loads through jiti. Returns the repository-relative paths written.
function stageBackend(payload) {
  const seen = new Set();
  const todo = ["backend/src/start.ts", "backend/src/main.mts"].map((rel) => path.join(REPO, rel));
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of fs.readFileSync(file, "utf8").matchAll(TS_IMPORT)) todo.push(path.resolve(path.dirname(file), `${m[3]}.${m[4]}ts`));
  }
  const written = [];
  for (const file of [...seen].sort()) {
    const rel = path.relative(REPO, file).split(path.sep).join("/");
    const js = stripTypeScriptTypes(fs.readFileSync(file, "utf8"), { mode: "strip" })
      .replace(TS_IMPORT, (_, before, quote, spec, m) => `${before}${quote}${spec}.${m}js${quote}`);
    const out = path.join(payload, rel.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, js);
    written.push(rel);
  }
  return written;
}

async function stagePayload({ work, cache, target, piDir, webDist, nodeVersion }) {
  const payload = path.join(work, target, "payload");
  fs.rmSync(payload, { recursive: true, force: true });
  fs.mkdirSync(path.join(payload, "app"), { recursive: true });

  // The payload repeats the repository's layout, so the backend finds its resources from <root> as in the repository.
  const launcher = fs.readFileSync(path.join(HERE, "app", "main.ts"), "utf8");
  fs.writeFileSync(path.join(payload, "app", "main.mjs"), stripTypeScriptTypes(launcher, { mode: "strip" }));
  const backendFiles = stageBackend(payload);
  fs.copyFileSync(path.join(REPO, "backend", "package.json"), path.join(payload, "backend", "package.json"));
  fs.copyFileSync(path.join(REPO, "agent", "package.json"), path.join(payload, "agent", "package.json"));
  copyTree(path.join(REPO, "agent", "src"), path.join(payload, "agent", "src"));
  copyTree(path.join(REPO, "agent", "prompts"), path.join(payload, "agent", "prompts"));
  copyTree(path.join(REPO, "task-types"), path.join(payload, "task-types"));
  // Only the profile the package starts with; the development and test profiles (dev.json, fake.json) stay out of it.
  fs.mkdirSync(path.join(payload, "backend", "profiles"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "backend", "profiles", "desktop.json"), path.join(payload, "backend", "profiles", "desktop.json"));
  copyTree(path.join(REPO, "backend", "prompts"), path.join(payload, "backend", "prompts"));
  const product = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  fs.writeFileSync(path.join(payload, "package.json"), JSON.stringify({ name: product.name, version: product.version, private: true }, null, 2) + "\n");
  copyTree(webDist, path.join(payload, "web"));
  copyTree(piDir, path.join(payload, "pi"), piKeep);
  const tools = await stageTools(cache, target, path.join(payload, "tools"));

  const piVersion = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8")).version;
  const manifest = { app: "taskwright", version: product.version, target, node: nodeVersion, pi: piVersion, ...tools, built_at: new Date().toISOString() };
  fs.writeFileSync(path.join(payload, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`${target} payload: ${mb(treeSize(payload))} (backend ${backendFiles.length} files, pi ${mb(treeSize(path.join(payload, "pi")))}, installed pi ${mb(treeSize(piDir))}, rg and fd ${mb(treeSize(path.join(payload, "tools")))})`);
  return { payload, manifest };
}

// [u32 index length][index JSON][file bytes...], compressed; read back by release/app/boot.cjs.
function packPayload(payload, level) {
  const files = listFiles(payload);
  const index = Buffer.from(JSON.stringify(files.map((f) => ({ p: f.rel, s: f.size, x: f.exec }))));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(index.length);
  const raw = Buffer.concat([head, index, ...files.map((f) => fs.readFileSync(path.join(payload, f.rel)))]);
  const started = Date.now();
  const packed = zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
  log(`packed ${files.length} files: ${mb(raw.length)} -> ${mb(packed.length)} (zstd ${level}, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
  return packed;
}

// ---- single executable -----------------------------------------------------------------------------------

async function buildSea({ work, out, cache, target, payload, manifest, nodeVersion, postject, level }) {
  if (!postject) usage("--postject is required for the sea format");
  const dir = path.join(work, target, "sea");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const packed = packPayload(payload, level);
  const id = `${manifest.version}-${crypto.createHash("sha256").update(packed).digest("hex").slice(0, 16)}`;
  fs.writeFileSync(path.join(dir, "payload.bin"), packed);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, id, compression: "zstd" }));
  fs.copyFileSync(path.join(HERE, "app", "boot.cjs"), path.join(dir, "boot.cjs"));
  // Without code cache and snapshot the blob does not depend on the platform, so one Linux node makes the blob
  // for every target; it must be the same Node version as the binary it goes into.
  fs.writeFileSync(path.join(dir, "sea-config.json"), JSON.stringify({
    main: "boot.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
    assets: { "manifest.json": "manifest.json", "payload.bin": "payload.bin" },
  }, null, 2));
  const hostNode = await nodeBinary(cache, nodeVersion, "linux-x64");
  execFileSync(hostNode, ["--experimental-sea-config", "sea-config.json"], { cwd: dir, stdio: "inherit" });
  const exe = path.join(out, `taskwright-${target}${target.startsWith("win") ? ".exe" : ""}`);
  fs.copyFileSync(await nodeBinary(cache, nodeVersion, target), exe);
  fs.chmodSync(exe, 0o755);
  execFileSync(postject, [exe, "NODE_SEA_BLOB", path.join(dir, "sea-prep.blob"), "--sentinel-fuse", SEA_FUSE], { stdio: "inherit" });
  log(`single executable ${exe}: ${mb(fs.statSync(exe).size)}`);
  return exe;
}

// ---- AppImage --------------------------------------------------------------------------------------------

async function buildAppImage({ work, out, cache, payload, nodeVersion, appimagetool }) {
  const appDir = path.join(work, "linux-x64", "AppDir");
  fs.rmSync(appDir, { recursive: true, force: true });
  const lib = path.join(appDir, "usr", "lib", "taskwright");
  copyTree(payload, lib);
  fs.mkdirSync(path.join(lib, "bin"));
  fs.copyFileSync(await nodeBinary(cache, nodeVersion, "linux-x64"), path.join(lib, "bin", "node"));
  fs.chmodSync(path.join(lib, "bin", "node"), 0o755);
  for (const name of ["AppRun", "taskwright.desktop", "taskwright.svg"]) {
    fs.copyFileSync(path.join(HERE, "appimage", name), path.join(appDir, name));
  }
  fs.chmodSync(path.join(appDir, "AppRun"), 0o755);
  fs.symlinkSync("taskwright.svg", path.join(appDir, ".DirIcon"));

  const tool = appimagetool || await download(
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage",
    path.join(cache, "appimagetool-x86_64.AppImage"));
  fs.chmodSync(tool, 0o755);
  const image = path.join(out, "taskwright-x86_64.AppImage");
  fs.rmSync(image, { force: true });
  // Extract-and-run: appimagetool is itself an AppImage, and this way building does not need FUSE.
  execFileSync(tool, ["--no-appstream", appDir, image], { stdio: "inherit", env: { ...process.env, ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" } });
  log(`AppImage ${image}: ${mb(fs.statSync(image).size)} (AppDir ${mb(treeSize(appDir))})`);
  return image;
}

// ---- main ------------------------------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = outsideRepo(options.out, "--out");
  const work = outsideRepo(options.work || path.join(out, "work"), "--work");
  const cache = outsideRepo(options.cache || path.join(out, "cache"), "--cache");
  const targets = (options.targets || "linux-x64,win-x64").split(",");
  const formats = (options.formats || "appimage,sea").split(",");
  const nodeVersion = options["node-version"] || "24.15.0";
  const level = Number(options.level || 19);
  for (const target of targets) if (!TARGETS.includes(target)) usage(`unknown target ${target}`);
  for (const dir of [out, work, cache]) fs.mkdirSync(dir, { recursive: true });

  const piDir = options["pi-dir"] || path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), PI_PACKAGE);
  const piVersion = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8")).version;
  if (piVersion !== PI_VERSION) log(`warning: pi ${piVersion} found, this release pins ${PI_VERSION}`);

  let webDist = options["web-dist"];
  if (!webDist) {
    webDist = path.join(work, "web-dist");
    const vite = path.join(REPO, "node_modules", ".bin", "vite");
    execFileSync(vite, ["build", "--outDir", webDist, "--emptyOutDir"], { cwd: path.join(REPO, "web"), stdio: "inherit" });
  }

  const results = [];
  for (const target of targets) {
    const { payload, manifest } = await stagePayload({ work, cache, target, piDir, webDist, nodeVersion });
    if (formats.includes("sea")) results.push(await buildSea({ work, out, cache, target, payload, manifest, nodeVersion, postject: options.postject, level }));
    if (formats.includes("appimage") && target === "linux-x64") results.push(await buildAppImage({ work, out, cache, payload, nodeVersion, appimagetool: options.appimagetool }));
  }
  for (const file of results) log(`done: ${file} (${mb(fs.statSync(file).size)})`);
}

main().catch((error) => { console.error(error); process.exit(1); });
