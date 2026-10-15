/**
 * 任务类型落在用户数据目录里：数据目录下 task-types/ 放每种任务类型的当前版（一个子目录一种，键是目录名），
 * 建任务从这里复制。产品自带的那一份（安装包里的 task-types/，见 paths.ts 的 TASK_TYPES_DIR）只用于播种，以后也用于恢复出厂。
 *
 * 播种：服务启动时，产品自带的每种任务类型，用户目录里还没有的整个复制过去；已经有的一律不动，安装包升级带来的新版
 * 不自动跟上（恢复出厂与更新到最新另有入口）。根上的 manifest.json 记每种类型播种时的来源版本（任务定义里的「版本」）、
 * 播种时刻与产品版本，以后据此判断产品自带的是不是更新了。
 * 只认有新格式任务定义（docs/task-definitions/<键>.json 里写了「任务名」）的目录，别的目录不播种、也不列。
 *
 * 修订：每种任务类型的每个修订存一份完整目录，在 task-types/.revisions/<键>/<修订号>/；播种那一刻是修订 1。
 * 改一种任务类型（saveTaskTypeRevision）与回退到某个修订（restoreTaskTypeRevision）都先在暂存目录里做好、核对任务定义
 * 仍然读得通，再换上当前版，并另存一个新的修订；回退也是一个新的修订，不删任何修订。修订号以目录为准（已有的最大号加一），
 * 服务级库的 task_type_revision 表记每个修订的经过（时刻、谁改的、一句说明、改到的文件与摘要值，见 service_db.ts）；
 * 没有服务级库时（只测目录的单元测试）只存目录。
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { loadDefinition } from "../../agent/src/lib/definition.ts";
import * as clock from "./clock.ts";
import { TASK_TYPES_DIR } from "./paths.ts";
import { byCodePoint } from "./library.ts";
import type { ServiceDb, TaskTypeFileChange, TaskTypeRevision } from "./service_db.ts";

/** 用户数据目录下放任务类型的子目录名。 */
export const TASK_TYPES_DIRNAME = "task-types";
/** 播种记录的文件名，在 task-types/ 的根上。 */
export const MANIFEST_NAME = "manifest.json";

/** 一种任务类型播种时记下的：来源版本（产品自带那一份任务定义里的「版本」，没有写是 null）、播种时刻、播种它的产品版本。 */
export interface SeededType {
  source_version: number | null;
  seeded_at: string;
  product_version: string;
}

export interface Manifest {
  types: Record<string, SeededType>;
}

/** 数据目录下放任务类型的目录。 */
export function taskTypesRoot(dataDir: string): string {
  return join(dataDir, TASK_TYPES_DIRNAME);
}

/** 一种任务类型的任务定义文件（相对它的目录）。 */
export function definitionFileOf(key: string): string {
  return join("docs", "task-definitions", `${key}.json`);
}

/** 一个任务类型目录的任务名与版本；没有新格式任务定义（读不出、或者没写「任务名」）时是 null。 */
export function typeInfo(root: string, key: string): { name: string; version: number | null } | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, key, definitionFileOf(key)), "utf-8"));
    const name = raw?.["任务名"];
    if (typeof name !== "string" || !name) return null;
    return { name, version: Number.isInteger(raw["版本"]) ? raw["版本"] : null };
  } catch {
    return null;
  }
}

/** root 下的任务类型（键按码位排），每种带任务名；目录不存在时是空的。以点开头的目录不算。 */
export function listTaskTypes(root: string): { task_type: string; name: string }[] {
  if (!existsSync(root)) return [];
  const out: { task_type: string; name: string }[] = [];
  for (const key of readdirSync(root).sort(byCodePoint)) {
    if (key.startsWith(".") || !statSync(join(root, key)).isDirectory()) continue;
    const info = typeInfo(root, key);
    if (info) out.push({ task_type: key, name: info.name });
  }
  return out;
}

/** 读播种记录；没有或者读不懂时当作还没有播种过任何一种。 */
export function readManifest(root: string): Manifest {
  try {
    const raw = JSON.parse(readFileSync(join(root, MANIFEST_NAME), "utf-8"));
    return { types: raw && typeof raw.types === "object" && raw.types ? raw.types : {} };
  } catch {
    return { types: {} };
  }
}

/**
 * 播种：shipped（缺省是产品自带的 task-types/）里的每种任务类型，dataDir 下 task-types/ 里还没有的，整个复制过去，
 * manifest.json 记下来源版本、时刻与产品版本；已经有的不动。复制先进一个暂存目录再改名，复制到一半出错不留下半份。
 * 返回这一次播种了哪几种（按码位排）。
 */
export function seedTaskTypes(dataDir: string, productVersion: string, shipped: string = TASK_TYPES_DIR): string[] {
  const root = taskTypesRoot(dataDir);
  const wanted = listTaskTypes(shipped).filter((one) => !existsSync(join(root, one.task_type)));
  if (!wanted.length) return [];
  mkdirSync(root, { recursive: true });
  const manifest = readManifest(root);
  const seeded: string[] = [];
  for (const { task_type: key } of wanted) {
    const staging = join(root, `.${key}.seeding-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      cpSync(join(shipped, key), staging, { recursive: true, dereference: true });
      renameSync(staging, join(root, key));
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    manifest.types[key] = { source_version: typeInfo(shipped, key)?.version ?? null, seeded_at: clock.now(), product_version: productVersion };
    keepRevision(dataDir, key, 1);
    seeded.push(key);
  }
  writeFileSync(join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return seeded;
}

// ───────────── 修订 ─────────────

/** 放修订的目录名，在 task-types/ 的根上；以点开头，不算一种任务类型。 */
export const REVISIONS_DIRNAME = ".revisions";

/** 一种任务类型的修订放在哪里。 */
export function revisionsDir(dataDir: string, key: string): string {
  return join(taskTypesRoot(dataDir), REVISIONS_DIRNAME, key);
}

/** 一种任务类型已经存了哪几个修订（修订号，从小到大）。 */
export function revisionNumbers(dataDir: string, key: string): number[] {
  const dir = revisionsDir(dataDir, key);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^[1-9]\d*$/.test(name)).map(Number).sort((a, b) => a - b);
}

/** 一个目录里的每份文件（相对路径一律用 / 分隔）与内容的摘要值。 */
function fileDigests(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string) => {
    for (const one of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, one.name);
      if (one.isDirectory()) walk(full);
      else if (one.isFile()) out.set(relative(dir, full).split(sep).join("/"), createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** 两次的文件比一比：新加、改了、删了的，按路径排。 */
function changesBetween(before: Map<string, string>, after: Map<string, string>): TaskTypeFileChange[] {
  const out: TaskTypeFileChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(byCodePoint)) {
    const was = before.get(path);
    const now = after.get(path);
    if (was === undefined && now !== undefined) out.push({ path, change: "added", digest: now });
    else if (was !== undefined && now === undefined) out.push({ path, change: "removed", digest: null });
    else if (was !== now) out.push({ path, change: "changed", digest: now! });
  }
  return out;
}

/** 把当前版整份存成第 no 个修订（先进暂存目录再改名）。已经有这个修订时不动。 */
function keepRevision(dataDir: string, key: string, no: number): void {
  const target = join(revisionsDir(dataDir, key), String(no));
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.saving-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(join(taskTypesRoot(dataDir), key), staging, { recursive: true });
  renameSync(staging, target);
}

/** 改一种任务类型时用的暂存目录：在 task-types/ 根上、以点开头（中途出错留下的不会被当作一种任务类型）。 */
function scratchDir(dataDir: string, key: string, tag: string): string {
  return join(taskTypesRoot(dataDir), `.${key}.${tag}-${process.pid}`);
}

/** 改任务类型时出的错（类型不在、路径写得不对、任务定义改坏了、要回退的修订不在）。消息是给人看的一句中文。 */
export class TaskTypeError extends Error {}

/** 一份文件在任务类型目录里的相对路径：不许是绝对路径、不许跑出目录，统一用 / 分隔。 */
function safeRelative(path: string): string {
  const norm = normalize(path).split(sep).join("/");
  if (!path || isAbsolute(path) || norm === "." || norm.startsWith("../") || norm === "..") throw new TaskTypeError(`文件路径「${path}」不对：要写相对任务类型目录、不跑出这个目录的路径。`);
  return norm;
}

/** 在暂存目录里做好的一版换成当前版：任务定义要读得通；旧的当前版先挪开，换上之后删掉。 */
function swapIn(dataDir: string, key: string, staging: string): void {
  try {
    loadDefinition(staging, definitionFileOf(key));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new TaskTypeError(`改后的任务定义读不通，什么都没有改：${(error as Error).message}`);
  }
  const current = join(taskTypesRoot(dataDir), key);
  const old = scratchDir(dataDir, key, "old");
  rmSync(old, { recursive: true, force: true });
  renameSync(current, old);
  renameSync(staging, current);
  rmSync(old, { recursive: true, force: true });
}

/** 修订之前：类型要在；一个修订都没有存过的（例如手工放进来的）先把现在的样子存成修订 1。返回现在最新的修订号。 */
function prepare(dataDir: string, registry: ServiceDb | null, key: string, actor: string): number {
  if (!typeInfo(taskTypesRoot(dataDir), key)) throw new TaskTypeError(`没有「${key}」这种任务类型。`);
  const numbers = revisionNumbers(dataDir, key);
  if (numbers.length) return numbers[numbers.length - 1];
  keepRevision(dataDir, key, 1);
  const files = [...fileDigests(join(taskTypesRoot(dataDir), key))].map(([path, digest]) => ({ path, change: "added" as const, digest }));
  registry?.putTaskTypeRevision({ task_type: key, revision_no: 1, at: clock.now(), actor, note: "改动之前的样子", files });
  return 1;
}

/**
 * 改一种任务类型：changes 是相对任务类型目录的路径到新内容（写 null 是删掉这份文件）。先在暂存目录里改、核对任务定义读得通，
 * 再换上当前版，并存成一个新的修订、在服务级库里记下经过。什么都没有改到时不记新修订，返回 null；否则返回新的修订号。
 */
export function saveTaskTypeRevision(dataDir: string, registry: ServiceDb | null, key: string, changes: Record<string, string | null>,
  actor: string, note: string): number | null {
  const latest = prepare(dataDir, registry, key, actor);
  const current = join(taskTypesRoot(dataDir), key);
  const staging = scratchDir(dataDir, key, "editing");
  rmSync(staging, { recursive: true, force: true });
  cpSync(current, staging, { recursive: true });
  try {
    for (const [path, content] of Object.entries(changes)) {
      const target = join(staging, safeRelative(path));
      if (content === null) {
        if (existsSync(target)) unlinkSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf-8");
      }
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const files = changesBetween(fileDigests(current), fileDigests(staging));
  if (!files.length) {
    rmSync(staging, { recursive: true, force: true });
    return null;
  }
  swapIn(dataDir, key, staging);
  const no = latest + 1;
  keepRevision(dataDir, key, no);
  registry?.putTaskTypeRevision({ task_type: key, revision_no: no, at: clock.now(), actor, note, files });
  return no;
}

/**
 * 回退到某个修订：把那个修订的整份内容换成当前版，另存成一个新的修订（说明写回退到第几个修订），不删任何修订。
 * 与当前版一样时不记新修订，返回 null；那个修订不在时报错。
 */
export function restoreTaskTypeRevision(dataDir: string, registry: ServiceDb | null, key: string, revisionNo: number, actor: string): number | null {
  const latest = prepare(dataDir, registry, key, actor);
  const source = join(revisionsDir(dataDir, key), String(revisionNo));
  if (!Number.isInteger(revisionNo) || !existsSync(source)) throw new TaskTypeError(`「${key}」没有修订 ${revisionNo}。`);
  const current = join(taskTypesRoot(dataDir), key);
  const files = changesBetween(fileDigests(current), fileDigests(source));
  if (!files.length) return null;
  const staging = scratchDir(dataDir, key, "restoring");
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  swapIn(dataDir, key, staging);
  const no = latest + 1;
  keepRevision(dataDir, key, no);
  registry?.putTaskTypeRevision({ task_type: key, revision_no: no, at: clock.now(), actor, note: `回退到修订 ${revisionNo}`, files });
  return no;
}

/**
 * 播种时还没有服务级库（例如数据要先升级）的，修订 1 只存了目录：有了服务级库之后补记它的经过。已经记过的不动。
 * 时刻取 manifest.json 里的播种时刻，说明写从产品自带的第几版播种。
 */
export function recordSeedRevisions(dataDir: string, registry: ServiceDb): void {
  const root = taskTypesRoot(dataDir);
  const manifest = readManifest(root);
  for (const { task_type: key } of listTaskTypes(root)) {
    if (!revisionNumbers(dataDir, key).includes(1) || registry.taskTypeRevisions(key).some((one) => one.revision_no === 1)) continue;
    const seeded = manifest.types[key];
    const files = [...fileDigests(join(revisionsDir(dataDir, key), "1"))].map(([path, digest]) => ({ path, change: "added" as const, digest }));
    const from = seeded?.source_version != null ? `从产品自带的第 ${seeded.source_version} 版播种` : "从产品自带的那一份播种";
    registry.putTaskTypeRevision({ task_type: key, revision_no: 1, at: seeded?.seeded_at ?? clock.now(), actor: "system", note: from, files });
  }
}
