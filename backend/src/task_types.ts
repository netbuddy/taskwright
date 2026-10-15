/**
 * 任务类型落在用户数据目录里：数据目录下 task-types/ 放每种任务类型的当前版（一个子目录一种，键是目录名），
 * 建任务从这里复制。产品自带的那一份（安装包里的 task-types/，见 paths.ts 的 TASK_TYPES_DIR）只用于播种，以后也用于恢复出厂。
 *
 * 播种：服务启动时，产品自带的每种任务类型，用户目录里还没有的整个复制过去；已经有的一律不动，安装包升级带来的新版
 * 不自动跟上（恢复出厂与更新到最新另有入口）。根上的 manifest.json 记每种类型播种时的来源版本（任务定义里的「版本」）、
 * 播种时刻与产品版本，以后据此判断产品自带的是不是更新了。
 * 只认有新格式任务定义（docs/task-definitions/<键>.json 里写了「任务名」）的目录，别的目录不播种、也不列。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clock from "./clock.ts";
import { TASK_TYPES_DIR } from "./paths.ts";
import { byCodePoint } from "./library.ts";

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
    seeded.push(key);
  }
  writeFileSync(join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return seeded;
}
