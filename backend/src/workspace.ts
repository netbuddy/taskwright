/**
 * 建任务：建任务目录、放起始文件、经 agent 的 createTask 写任务记录。三步任何一步失败，整个创建失败，
 * 这次建出来的东西全部清掉，任务目录回到调用之前的样子。
 *
 * 写任务记录是后端唯一的一处写库，而且不在后端里写：在同一进程里调用 agent 侧的 createTask 核心函数
 * （与命令行入口 agent/src/cli/create_task.mts 调用的是同一个函数），发起方记「用户」，编号是这里生成的操作编号。
 * 任务类型就是仓库 task-types/ 下的目录名，任务定义固定在模板里的 docs/task-definitions/<任务类型>.json。
 */

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createTask } from "../../agent/src/lib/create_task.ts";
import { ACTOR_USER } from "../../agent/src/lib/db.ts";
import { OVERALL_COLLECTION } from "../../agent/src/lib/overall_analysis.ts";
import type { OverallTemplate } from "../../agent/src/lib/schema.ts";
import { byCodePoint } from "./library.ts";
import { TASK_TYPES_DIR } from "./paths.ts";

export const DEFAULT_TYPE = "srs-authoring";
/** 后端给用户操作生成的编号的前缀。 */
export const OPERATION_PREFIX = "ui-op-";
/** 起始文件目录顶层这几个文件是给人看的说明，不复制进任务目录。 */
const SKIPPED_TOP_LEVEL = new Set(["README.md"]);
/** pi 的项目设置文件在任务目录里的位置，与起始文件目录没带它时写进去的内容。 */
const PI_SETTINGS = join(".pi", "settings.json");
const DEFAULT_PI_SETTINGS = { followUpMode: "all" };

/** 建任务失败。消息是给人看的一句中文。 */
export class CreateTaskError extends Error {}

export function availableTemplates(): string[] {
  return readdirSync(TASK_TYPES_DIR).filter((name) => statSync(join(TASK_TYPES_DIR, name)).isDirectory()).sort(byCodePoint);
}

export function newOperationId(): string {
  return OPERATION_PREFIX + randomBytes(6).toString("hex");
}

export function definitionPathOf(taskType: string): string {
  return `docs/task-definitions/${taskType}.json`;
}

/**
 * 任务类型模板里「总体分析」那一节：数据升级给任务定义里缺这一集合的早先任务补上时用（agent/src/lib/schema.ts 的第 7 到 8 步）。
 * 按任务定义文件的路径认任务类型：路径的文件名就是任务类型（docs/task-definitions/<任务类型>.json）。模板里没有这一集合、
 * 找不到模板、模板读不出来时是 null，这时不补。
 */
export function overallTemplateFor(definitionPath: string): OverallTemplate | null {
  const type = basename(definitionPath).replace(/\.json$/, "");
  const file = join(TASK_TYPES_DIR, type, definitionPathOf(type));
  if (!type || !existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, any>;
    const collection = (raw["交付物"]?.["条目集合"] as Record<string, unknown>[] | undefined)?.find((one) => one["名称"] === OVERALL_COLLECTION);
    if (!collection) return null;
    return { collection, completion: raw["完成条件"]?.[OVERALL_COLLECTION] ?? null };
  } catch {
    return null;
  }
}

const isNonEmptyDir = (path: string) => existsSync(path) && readdirSync(path).length > 0;

/** 把起始文件目录复制成一个新任务目录：顶层的 README.md 不复制，补一个空的 inputs/，没带 pi 项目设置时写一份。 */
export function newWorkspace(target: string, source: string): string {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source).sort(byCodePoint)) {
    const from = join(source, name);
    const isDir = statSync(from).isDirectory();
    if (SKIPPED_TOP_LEVEL.has(name) && !isDir) continue;
    cpSync(from, join(target, name), { recursive: true, preserveTimestamps: true, dereference: true });
  }
  mkdirSync(join(target, "inputs"), { recursive: true });
  const settings = join(target, PI_SETTINGS);
  if (!existsSync(settings)) {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify(DEFAULT_PI_SETTINGS, null, 2) + "\n", "utf-8");
  }
  return target;
}

export interface CreatedTask {
  task_id: string;
  task_name: unknown;
  task_type: unknown;
  domain_tag: unknown;
  event_seq: unknown;
  操作编号: string;
  任务目录: string;
}

/** 建任务，返回任务编号、任务名、任务类型、领域标签、事件序号，另加任务目录与操作编号。 */
export function createTaskDir(targetDir: string, taskType = DEFAULT_TYPE, name: string | null = null, tag: string | null = null,
  taskId: string | null = null, opId: string | null = null): CreatedTask {
  const target = resolve(targetDir);
  const template = join(TASK_TYPES_DIR, taskType);
  if (!existsSync(template) || !statSync(template).isDirectory()) {
    throw new CreateTaskError(`没有「${taskType}」这种任务类型。可用的有：${availableTemplates().join("、")}。`);
  }
  if (isNonEmptyDir(target)) throw new CreateTaskError(`${target} 已经存在而且不是空的。一个目录只放一个任务，请换一个目录。`);
  const existed = existsSync(target);
  const op = opId ?? newOperationId();
  try {
    newWorkspace(target, template);
    let details: Record<string, unknown>;
    try {
      details = createTask(
        { workspaceDir: target, sessionId: "", callId: op, actor: ACTOR_USER },
        { definition_path: definitionPathOf(taskType), task_name: name || null, domain_tag: tag || null, task_id: taskId || null },
      ).details;
    } catch (error) {
      throw new CreateTaskError(`任务记录没有写成：${(error as Error).message}`);
    }
    return {
      task_id: details.task_id as string, task_name: details.task_name, task_type: details.task_type,
      domain_tag: details.domain_tag, event_seq: details.event_seq, 任务目录: target, 操作编号: op,
    };
  } catch (error) {
    clean(target, existed);
    throw error;
  }
}

/** 把这次建出来的东西清掉：目录是这次建的就整个删掉；原来就有的空目录，只清空里面。 */
function clean(target: string, existed: boolean): void {
  if (!existsSync(target)) return;
  if (!existed) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  for (const name of readdirSync(target)) rmSync(join(target, name), { recursive: true, force: true });
}
