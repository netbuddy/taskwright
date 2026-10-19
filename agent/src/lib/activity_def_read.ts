/**
 * 读一个任务类型的全部活动与流程的声明（lib/activity_def.ts）。只读文件，不读库。
 *
 * 活动在任务 skill 目录下的 activities/<标识符>.md，流程在 flows/<标识符>.md。任务目录里的 skill 是建任务时从任务类型复制来的；
 * 早先建的任务、或者数据目录里早先播种的任务类型复制出来的任务，skill 目录里没有 activities/，这时回退读产品自带的任务类型里
 * 同一相对路径下的那一份（BUILTIN_TASK_TYPES_DIR 下哪个任务类型目录里有这份 skill 就读哪个），并在结果里写明回退了。
 *
 * 校验：每份文件的声明合规；六个阶段各恰好有一项活动算作它（stage 一栏），另有一项只能由用户发起的「发布」（键 publish）；
 * 流程的各步只能写这个任务类型里的活动。任何一处不对都抛错（DefinitionHeadError），调用方据此不出活动目录、拼不成系统提示。
 * 进程里按目录记着上一次读的结果与各份文件的修改时刻和大小，文件没变就不重读。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ActivityDef, DefinitionHeadError, type FlowDef, PUBLISH, parseActivityDef, parseFlowDef } from "./activity_def.ts";
import { STAGES } from "./stage.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** 产品自带的任务类型所在的目录（与后端 backend/src/paths.ts 的 TASK_TYPES_DIR 是同一个）。 */
export const BUILTIN_TASK_TYPES_DIR = join(REPO_ROOT, "task-types");
export const ACTIVITIES_SUBDIR = "activities";
export const FLOWS_SUBDIR = "flows";

/** 一个任务类型的全部活动与流程的声明。 */
export interface Definitions {
  /** 先是六个阶段各自的那一项（按阶段的先后），再是发布，再是别的（按标识符）。 */
  activities: ActivityDef[];
  /** 按标识符。 */
  flows: FlowDef[];
  /** 读的是哪个 skill 目录（绝对路径），与它是不是回退到产品自带的那一份。 */
  dir: string;
  fallback: boolean;
}

/** 一个目录里的 .md 文件名，按名字排；目录不在时是空的。 */
function mdFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md").sort();
  } catch {
    return [];
  }
}

/** 读一个 skill 目录下的全部声明，不用记着的结果。fallback 只是记进结果里。 */
export function readDefinitions(dir: string, fallback = false): Definitions {
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      throw new DefinitionHeadError(`定义文件读不出来：${path}`);
    }
  };
  const activityFiles = mdFiles(join(dir, ACTIVITIES_SUBDIR));
  if (activityFiles.length === 0) throw new DefinitionHeadError(`任务类型里没有活动的定义：${join(dir, ACTIVITIES_SUBDIR)}`);
  const all = activityFiles.map((name) => parseActivityDef(read(join(dir, ACTIVITIES_SUBDIR, name)), name.slice(0, -3), `${ACTIVITIES_SUBDIR}/${name}`));
  for (const stage of STAGES) {
    const found = all.filter((one) => one.stage === stage);
    if (found.length > 1) throw new DefinitionHeadError(`任务类型里有几项活动都算作「${stage}」这个阶段：${found.map((one) => one.key).join("、")}。`);
  }
  const ordered: ActivityDef[] = STAGES.map((stage) => {
    const found = all.find((one) => one.stage === stage);
    if (!found) throw new DefinitionHeadError(`任务类型里没有算作「${stage}」这个阶段的活动。`);
    return found;
  });
  const publish = all.find((one) => one.key === PUBLISH);
  if (!publish || publish.mode !== "user_only") throw new DefinitionHeadError(`任务类型里没有只能由用户发起的「${PUBLISH}」这项活动。`);
  ordered.push(publish);
  ordered.push(...all.filter((one) => !ordered.includes(one)));
  const keys = ordered.map((one) => one.key);
  const flows = mdFiles(join(dir, FLOWS_SUBDIR)).map((name) => parseFlowDef(read(join(dir, FLOWS_SUBDIR, name)), name.slice(0, -3), `${FLOWS_SUBDIR}/${name}`, keys));
  return { activities: ordered, flows, dir, fallback };
}

/**
 * 一份任务 skill 的目录该从哪里读声明：它自己有 activities/ 就读它；没有就找产品自带的任务类型里同一相对路径
 * （relativeSkillDir，相对任务目录，也就是相对任务类型目录）的那一份。都没有时返回 null。
 */
export function definitionsDir(skillDir: string, relativeSkillDir: string): { dir: string; fallback: boolean } | null {
  if (existsSync(join(skillDir, ACTIVITIES_SUBDIR))) return { dir: skillDir, fallback: false };
  let types: string[] = [];
  try {
    types = readdirSync(BUILTIN_TASK_TYPES_DIR).sort();
  } catch {
    return null;
  }
  for (const type of types) {
    const candidate = join(BUILTIN_TASK_TYPES_DIR, type, relativeSkillDir);
    if (existsSync(join(candidate, ACTIVITIES_SUBDIR))) return { dir: candidate, fallback: true };
  }
  return null;
}

/** 一个目录下声明文件的指纹：文件清单与各份的修改时刻和大小。 */
function stampOf(dir: string): string {
  return [ACTIVITIES_SUBDIR, FLOWS_SUBDIR].flatMap((sub) => mdFiles(join(dir, sub)).map((name) => {
    const found = statSync(join(dir, sub, name), { throwIfNoEntry: false });
    return `${sub}/${name}:${found ? `${found.mtimeMs}:${found.size}` : "-"}`;
  })).join("|");
}

const remembered = new Map<string, { stamp: string; value: Definitions }>();

/**
 * 一个任务的活动与流程的声明。workspaceDir 是任务目录，skillPath 是任务定义里的「执行方法」（SKILL.md 相对任务目录的路径）。
 * 任务目录里的 skill 没有 activities/ 时回退读产品自带的（见文件头）；哪里都没有就抛错。文件没变时用记着的那一份。
 */
export function definitionsFor(workspaceDir: string, skillPath: string): Definitions {
  const skillDir = dirname(resolve(workspaceDir, skillPath));
  const where = definitionsDir(skillDir, relative(resolve(workspaceDir), skillDir));
  if (where === null) throw new DefinitionHeadError(`任务目录与产品自带的任务类型里都没有这份 skill 的活动定义：${skillPath}`);
  const stamp = stampOf(where.dir);
  const last = remembered.get(where.dir);
  // 同一个目录可能直接读、也可能是别的任务回退来读：是不是回退按这一次算，不随记着的那一份。
  if (last && last.stamp === stamp) return { ...last.value, fallback: where.fallback };
  const value = readDefinitions(where.dir, where.fallback);
  remembered.set(where.dir, { stamp, value });
  return value;
}
