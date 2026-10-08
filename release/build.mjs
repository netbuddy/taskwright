#!/usr/bin/env node
// Builds the desktop packages: a payload (launcher, backend, web files, pi, agent extension, rg and fd) and, from it,
// a Linux AppImage and single executables (Node SEA) for Linux and Windows. Node built-in modules only; the web
// interface and the backend's diagram check engine are bundled with the repository's vite.
//
// Usage:
//   node release/build.mjs --out <dir> [options]
//
// Options:
//   --out <dir>           where the packages go (required; must be outside the repository)
//   --work <dir>          staging directory (default: <out>/work)
//   --cache <dir>         downloads: Node binaries, rg and fd, appimagetool, npm's cache for pi (default: <out>/cache)
//   --targets <list>      linux-x64,win-x64 (default: both)
//   --formats <list>      appimage,sea (default: both; appimage is built for linux-x64 only)
//   --node-version <v>    Node version put into the packages (default 24.15.0)
//   --pi-dir <dir>        an installed pi package to pack instead (default: install the pi that release/pi pins,
//                         from its lock file, into the staging directory); its version must be the pinned one
//   --web-dist <dir>      a built web interface (default: build it now with the repository's vite)
//   --postject <path>     the postject executable, needed for sea. Install it outside the repository, e.g.
//                         `npm install --prefix <tools dir> postject@1.0.0-alpha.6`; never in this repository.
//   --appimagetool <path> appimagetool (default: download the pinned release into the cache and check its checksum)
//   --level <n>           zstd level of the single executable's payload (default 19)
//
// Nothing is written inside the repository. Do not run npm install or npm ci in the repository for this: the
// build runs `npm ci` for pi in the staging directory, with its downloads kept under <cache>/npm.

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
const PI_PIN = path.join(HERE, "pi"); // package.json, package-lock.json and .npmrc: the pi that goes into the packages
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
  (message ? console.error : console.log)(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(5, 23).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
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

/** Downloads a pinned file into the cache (or takes the cached copy) and checks its SHA-256; a mismatch stops the build. */
async function pinned(url, file, sha256) {
  await download(url, file);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== sha256) throw new Error(`checksum mismatch for ${path.basename(file)}: ${actual}`);
  return file;
}

// ---- appimagetool and the AppImage runtime --------------------------------------------------------------------

// appimagetool builds the AppImage; the runtime is the small program at the front of every AppImage. Without
// --runtime-file, appimagetool downloads the latest runtime by itself, unchecked, so the build downloads a pinned
// runtime, checks it and hands it over. Versions are pinned; the SHA-256 values are the ones GitHub publishes for
// these release assets.
const APPIMAGETOOL = {
  version: "1.9.1",
  url: (v) => `https://github.com/AppImage/appimagetool/releases/download/${v}/appimagetool-x86_64.AppImage`,
  sha256: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
};
const APPIMAGE_RUNTIME = {
  version: "20251108",
  url: (v) => `https://github.com/AppImage/type2-runtime/releases/download/${v}/runtime-x86_64`,
  sha256: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
};

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

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// The pi version release/pi pins: an exact version in package.json, and the same one in the lock file.
function pinnedPi() {
  const version = readJson(path.join(PI_PIN, "package.json")).dependencies[PI_PACKAGE];
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`release/pi/package.json must pin ${PI_PACKAGE} to an exact version, found ${version}`);
  const lock = readJson(path.join(PI_PIN, "package-lock.json"));
  const locked = lock.packages[`node_modules/${PI_PACKAGE}`]?.version;
  if (locked !== version) throw new Error(`release/pi/package-lock.json has pi ${locked}, package.json pins ${version}; regenerate the lock file (release/pi/README.md)`);
  return { version, lock };
}

// The package directories under <root>/node_modules, nested ones included, as paths relative to <root>.
function installedPackages(root, relative = "node_modules") {
  const out = [];
  if (!fs.existsSync(path.join(root, relative))) return out;
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    if (name.startsWith(".")) continue;
    const names = name.startsWith("@") ? fs.readdirSync(path.join(root, relative, name)).sort().map((child) => `${name}/${child}`) : [name];
    for (const each of names) out.push(`${relative}/${each}`, ...installedPackages(root, `${relative}/${each}/node_modules`));
  }
  return out;
}

// How pi's dependencies in piDir differ from the lock file: a package the lock file does not have, one that is
// missing (an optional package for another platform may be), or another version. The lock file was written with
// install-strategy=shallow, so every dependency is inside pi's own node_modules, as in a global install.
function piTreeDifferences(piDir, lock) {
  const prefix = `node_modules/${PI_PACKAGE}/`;
  const locked = new Map(Object.entries(lock.packages).filter(([key]) => key.startsWith(prefix)).map(([key, entry]) => [key.slice(prefix.length), entry]));
  const installed = installedPackages(piDir);
  const differences = [];
  for (const rel of installed) {
    const entry = locked.get(rel);
    const version = readJson(path.join(piDir, rel, "package.json")).version;
    if (!entry) differences.push(`${rel} ${version} is not in the lock file`);
    else if (entry.version !== version) differences.push(`${rel} is ${version}, the lock file has ${entry.version}`);
  }
  const present = new Set(installed);
  for (const [rel, entry] of locked) if (!present.has(rel) && !entry.optional) differences.push(`${rel} ${entry.version} is in the lock file but not installed`);
  return { differences, packages: installed.length };
}

// The packages PI_KEEP takes from pi's own node_modules, with their versions; an error when one is not there
// (npm's default layout puts them next to pi instead, where copying pi's directory would miss them).
function keptPiPackages(piDir) {
  const kept = {};
  for (const rel of PI_KEEP.filter((each) => each.startsWith("node_modules/"))) {
    const file = path.join(piDir, rel, "package.json");
    if (!fs.existsSync(file)) throw new Error(`${rel} is not inside ${piDir}; pi's dependencies must be in pi's own node_modules (install-strategy=shallow, or a global install)`);
    kept[rel.slice("node_modules/".length)] = readJson(file).version;
  }
  return kept;
}

// Install pi into <work>/pi-install exactly as release/pi/package-lock.json says. No install scripts run: the
// packages that have one (esbuild among them) do not go into the packages.
function installPi(work, cache) {
  const dir = path.join(work, "pi-install");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["package.json", "package-lock.json", ".npmrc"]) fs.copyFileSync(path.join(PI_PIN, name), path.join(dir, name));
  log(`installing pi from release/pi/package-lock.json into ${dir}`);
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(cache, "npm")], { cwd: dir, stdio: "inherit" });
  return path.join(dir, "node_modules", PI_PACKAGE);
}

// The pi to pack: the one --pi-dir names, or one installed now from the lock file. Its version must be the pinned
// one. An installed-now pi must match the lock file package by package; for --pi-dir the differences are printed.
function resolvePi({ work, cache, given }) {
  const { version, lock } = pinnedPi();
  const piDir = given ? path.resolve(given) : installPi(work, cache);
  const found = readJson(path.join(piDir, "package.json")).version;
  if (found !== version) throw new Error(`pi ${found} found in ${piDir}, release/pi pins ${version}`);
  const kept = keptPiPackages(piDir);
  const { differences, packages } = piTreeDifferences(piDir, lock);
  if (differences.length) {
    for (const line of differences) log(`${given ? "warning" : "error"}: ${line}`);
    if (!given) throw new Error(`the installed pi differs from release/pi/package-lock.json in ${differences.length} place(s)`);
  }
  log(`pi ${found}: ${packages} dependency packages, ${differences.length ? `${differences.length} not as in the lock file` : "all as in the lock file"}; packing ${Object.entries(kept).map(([name, v]) => `${name} ${v}`).join(", ")}`);
  return { piDir, kept };
}

// Relative import specifiers ending in .ts or .mts, in `from "…"`, `import "…"` and `import("…")`.
const TS_IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']+?)\.(m?)ts\2/g;

// The backend runs as JavaScript in the packages: every file it imports, starting from its two entry points, has
// its types removed with Node's stripTypeScriptTypes (the backend only uses erasable syntax) and its relative
// .ts/.mts imports rewritten to .js/.mjs. The files keep their places, so agent/src/lib/*.js lands next to the .ts
// files that pi loads through jiti. Returns the repository-relative paths written.
//
// Two more starting points besides the entry points: diagram_validate.ts, which nothing imports yet, and
// diagram_worker.ts, which diagram_validate.ts starts as a thread by its file name, not with an import.
function stageBackend(payload) {
  const seen = new Set();
  const todo = ["backend/src/start.ts", "backend/src/main.mts", "backend/src/diagram_validate.ts", "backend/src/diagram_worker.ts"].map((rel) => path.join(REPO, rel));
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

// The backend checks Mermaid texts with mermaid, an npm package; the packages carry no node_modules. So the check
// engine (backend/src/diagram_engine.mjs) is bundled with mermaid into files for Node, reduced to the files the
// five kinds of diagram load (release/diagram/prune.mjs), and checked again after that. In the payload it lies in
// backend/vendor/mermaid/, where backend/src/diagram_validate.ts looks for it first.
// The files it keeps hold code of mermaid and of the packages mermaid uses, so their licence files go with them, as
// rg's and fd's do: <dir>/licenses/<package>-<file> for every licence file a package ships, and PACKAGES.txt with
// each package's name, version and licence. A package that ships no licence file but states "MIT" in its
// package.json gets <package>-LICENSE with the standard MIT text, the copyright line taken from package.json.
function buildDiagramEngine(work) {
  const dir = path.join(work, "diagram-engine");
  const vite = path.join(REPO, "node_modules", ".bin", "vite");
  execFileSync(vite, ["build", "--config", path.join(HERE, "diagram", "vite.config.mjs"), "--outDir", dir, "--emptyOutDir"], { cwd: REPO, stdio: "inherit" });
  const prune = path.join(HERE, "diagram", "prune.mjs");
  const modules = readJson(path.join(dir, "modules.json")); // written by the vite configuration: output file -> the source files in it
  const all = listFiles(dir).filter((file) => file.rel !== "modules.json");
  fs.rmSync(path.join(dir, "modules.json"));
  const used = new Set(JSON.parse(execFileSync(process.execPath, [prune, "trace", dir], { encoding: "utf8" })));
  for (const file of all) if (!used.has(file.rel)) fs.rmSync(path.join(dir, file.rel));
  execFileSync(process.execPath, [prune, "check", dir], { stdio: "inherit" });
  const size = treeSize(dir);
  const packages = stageDiagramLicences(dir, [...used].flatMap((file) => modules[file] ?? []));
  log(`diagram check engine: ${used.size} of ${all.length} files kept, ${mb(size)} of ${mb(all.reduce((sum, f) => sum + f.size, 0))}; licence files of ${packages} packages`);
  return dir;
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// The MIT licence for a package that ships no licence file: who holds the copyright is taken from the author
// field of its package.json, and the file says so.
function mitFromManifest(manifest) {
  const author = typeof manifest.author === "string" ? manifest.author : [manifest.author?.name, manifest.author?.email && `<${manifest.author.email}>`].filter(Boolean).join(" ");
  const holder = author ? `${author} (${manifest.name})` : `the authors of ${manifest.name}`;
  return `${manifest.name} ${manifest.version}\n\nThis package ships no licence file. Its package.json states the licence "MIT"${author ? ` and the author "${author}"` : ""};\n`
    + `the text below is the standard MIT licence with the copyright line written from those two fields.\n\nMIT License\n\nCopyright (c) ${holder}\n\n${MIT_TEXT}`;
}

// sources: the source files bundled into the kept files. Returns the number of npm packages they come from.
function stageDiagramLicences(dir, sources) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const packages = new Map();
  for (const source of sources) {
    const at = source.lastIndexOf(marker);
    if (at < 0) continue; // the repository's own file, or the bundler's helper
    const parts = source.slice(at + marker.length).split(path.sep);
    const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    packages.set(name, path.join(source.slice(0, at + marker.length), name));
  }
  const out = path.join(dir, "licenses");
  fs.mkdirSync(out, { recursive: true });
  const lines = ["The diagram check engine (../diagram_engine.mjs and ../assets/) contains code of these npm packages.", "Name, version, licence, and the licence files copied here from the package:", ""];
  for (const name of [...packages.keys()].sort()) {
    const from = packages.get(name);
    const manifest = readJson(path.join(from, "package.json"));
    const files = fs.readdirSync(from).filter((file) => /^(licen[sc]e|copying|notice)/i.test(file) && fs.statSync(path.join(from, file)).isFile()).sort();
    const copies = files.map((file) => `${name.replace("/", "__")}-${file}`);
    files.forEach((file, i) => fs.copyFileSync(path.join(from, file), path.join(out, copies[i])));
    let listed = copies.join(", ");
    if (!copies.length && manifest.license === "MIT") {
      const written = `${name.replace("/", "__")}-LICENSE`;
      fs.writeFileSync(path.join(out, written), mitFromManifest(manifest));
      listed = `${written} (the package ships no licence file; written from its package.json)`;
    } else if (!copies.length) {
      listed = "the package ships no licence file";
      log(`warning: ${name} ${manifest.version} ships no licence file and its licence is not MIT; nothing was written for it`);
    }
    lines.push(`${name} ${manifest.version}, ${typeof manifest.license === "string" ? manifest.license : "licence not stated in package.json"}: ${listed}`);
  }
  fs.writeFileSync(path.join(out, "PACKAGES.txt"), lines.join("\n") + "\n");
  return packages.size;
}

async function stagePayload({ work, cache, target, piDir, piPackages, webDist, diagramEngine, nodeVersion }) {
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
  copyTree(diagramEngine, path.join(payload, "backend", "vendor", "mermaid"));
  const product = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  fs.writeFileSync(path.join(payload, "package.json"), JSON.stringify({ name: product.name, version: product.version, private: true }, null, 2) + "\n");
  copyTree(webDist, path.join(payload, "web"));
  copyTree(piDir, path.join(payload, "pi"), piKeep);
  const tools = await stageTools(cache, target, path.join(payload, "tools"));

  const piVersion = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8")).version;
  const manifest = { app: "taskwright", version: product.version, target, node: nodeVersion, pi: piVersion, pi_packages: piPackages, ...tools, built_at: new Date().toISOString() };
  fs.writeFileSync(path.join(payload, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`${target} payload: ${mb(treeSize(payload))} (backend ${backendFiles.length} files, diagram check engine ${mb(treeSize(path.join(payload, "backend", "vendor", "mermaid")))}, pi ${mb(treeSize(path.join(payload, "pi")))}, installed pi ${mb(treeSize(piDir))}, rg and fd ${mb(treeSize(path.join(payload, "tools")))})`);
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

  const tool = appimagetool || await pinned(APPIMAGETOOL.url(APPIMAGETOOL.version),
    path.join(cache, `appimagetool-${APPIMAGETOOL.version}-x86_64.AppImage`), APPIMAGETOOL.sha256);
  const runtime = await pinned(APPIMAGE_RUNTIME.url(APPIMAGE_RUNTIME.version),
    path.join(cache, `appimage-runtime-${APPIMAGE_RUNTIME.version}-x86_64`), APPIMAGE_RUNTIME.sha256);
  fs.chmodSync(tool, 0o755);
  const image = path.join(out, "taskwright-x86_64.AppImage");
  fs.rmSync(image, { force: true });
  // Extract-and-run: appimagetool is itself an AppImage, and this way building does not need FUSE.
  execFileSync(tool, ["--no-appstream", "--runtime-file", runtime, appDir, image], { stdio: "inherit", env: { ...process.env, ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" } });
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

  const { piDir, kept: piPackages } = resolvePi({ work, cache, given: options["pi-dir"] });

  let webDist = options["web-dist"];
  if (!webDist) {
    webDist = path.join(work, "web-dist");
    const vite = path.join(REPO, "node_modules", ".bin", "vite");
    execFileSync(vite, ["build", "--outDir", webDist, "--emptyOutDir"], { cwd: path.join(REPO, "web"), stdio: "inherit" });
  }

  const diagramEngine = buildDiagramEngine(work);

  const results = [];
  for (const target of targets) {
    const { payload, manifest } = await stagePayload({ work, cache, target, piDir, piPackages, webDist, diagramEngine, nodeVersion });
    if (formats.includes("sea")) results.push(await buildSea({ work, out, cache, target, payload, manifest, nodeVersion, postject: options.postject, level }));
    if (formats.includes("appimage") && target === "linux-x64") results.push(await buildAppImage({ work, out, cache, payload, nodeVersion, appimagetool: options.appimagetool }));
  }
  for (const file of results) log(`done: ${file} (${mb(fs.statSync(file).size)})`);
}

main().catch((error) => { console.error(error); process.exit(1); });
