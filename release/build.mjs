#!/usr/bin/env node
// Builds the packaging prototype: a payload (prototype backend, web files, pi, agent extension) and, from it,
// a Linux AppImage and single executables (Node SEA) for Linux and Windows. Node built-in modules only.
//
// Usage:
//   node release/build.mjs --out <dir> [options]
//
// Options:
//   --out <dir>           where the packages go (required; must be outside the repository)
//   --work <dir>          staging directory (default: <out>/work)
//   --cache <dir>         downloads: Node binaries, appimagetool (default: <out>/cache)
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

function stagePayload({ work, target, piDir, webDist, nodeVersion }) {
  const payload = path.join(work, target, "payload");
  fs.rmSync(payload, { recursive: true, force: true });
  fs.mkdirSync(path.join(payload, "app"), { recursive: true });

  const source = fs.readFileSync(path.join(HERE, "proto", "main.ts"), "utf8");
  fs.writeFileSync(path.join(payload, "app", "main.mjs"), stripTypeScriptTypes(source, { mode: "strip" }));
  copyTree(webDist, path.join(payload, "web"));
  copyTree(piDir, path.join(payload, "pi"), piKeep);
  fs.mkdirSync(path.join(payload, "agent"));
  fs.copyFileSync(path.join(REPO, "agent", "package.json"), path.join(payload, "agent", "package.json"));
  copyTree(path.join(REPO, "agent", "src"), path.join(payload, "agent", "src"));
  copyTree(path.join(REPO, "agent", "prompts"), path.join(payload, "agent", "prompts"));

  const piVersion = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8")).version;
  const manifest = { app: "taskwright-proto", target, node: nodeVersion, pi: piVersion, built_at: new Date().toISOString() };
  fs.writeFileSync(path.join(payload, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`${target} payload: ${mb(treeSize(payload))} (pi ${mb(treeSize(path.join(payload, "pi")))}, installed pi ${mb(treeSize(piDir))})`);
  return { payload, manifest };
}

// [u32 index length][index JSON][file bytes...], compressed; read back by release/proto/boot.cjs.
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
  const id = `${manifest.pi}-${crypto.createHash("sha256").update(packed).digest("hex").slice(0, 16)}`;
  fs.writeFileSync(path.join(dir, "payload.bin"), packed);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, id, compression: "zstd" }));
  fs.copyFileSync(path.join(HERE, "proto", "boot.cjs"), path.join(dir, "boot.cjs"));
  // Without code cache and snapshot the blob does not depend on the platform, so one Linux node makes the blob
  // for every target; it must be the same Node version as the binary it goes into.
  fs.writeFileSync(path.join(dir, "sea-config.json"), JSON.stringify({
    main: "boot.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
    assets: { "manifest.json": "manifest.json", "payload.bin": "payload.bin" },
  }, null, 2));
  const hostNode = await nodeBinary(cache, nodeVersion, "linux-x64");
  execFileSync(hostNode, ["--experimental-sea-config", "sea-config.json"], { cwd: dir, stdio: "inherit" });
  const exe = path.join(out, `taskwright-proto-${target}${target.startsWith("win") ? ".exe" : ""}`);
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
  for (const name of ["AppRun", "taskwright-proto.desktop", "taskwright-proto.svg"]) {
    fs.copyFileSync(path.join(HERE, "appimage", name), path.join(appDir, name));
  }
  fs.chmodSync(path.join(appDir, "AppRun"), 0o755);
  fs.symlinkSync("taskwright-proto.svg", path.join(appDir, ".DirIcon"));

  const tool = appimagetool || await download(
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage",
    path.join(cache, "appimagetool-x86_64.AppImage"));
  fs.chmodSync(tool, 0o755);
  const image = path.join(out, "taskwright-proto-x86_64.AppImage");
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
    const { payload, manifest } = stagePayload({ work, target, piDir, webDist, nodeVersion });
    if (formats.includes("sea")) results.push(await buildSea({ work, out, cache, target, payload, manifest, nodeVersion, postject: options.postject, level }));
    if (formats.includes("appimage") && target === "linux-x64") results.push(await buildAppImage({ work, out, cache, payload, nodeVersion, appimagetool: options.appimagetool }));
  }
  for (const file of results) log(`done: ${file} (${mb(fs.statSync(file).size)})`);
}

main().catch((error) => { console.error(error); process.exit(1); });
