/**
 * 助手用 read 读任务定义文件时，算出本会话该看到的视图文字（视图怎样生成见 lib/definition_view.ts，挂点在 hooks/definition_view.ts）。
 * 只在 node 里用：要读任务库与磁盘上的定义文件。
 *
 * 读的是不是任务定义文件，按真实路径与任务库 task 表的 definition_path 比。视图从磁盘上的原文件现算，不管这次 read 写了从第几行读、
 * 读几行，整份给视图；原文件不改。会话的位置与活动取 lib/context_assemble.ts 的 whereInWorkspace（与拼系统提示同一个判断），
 * 活动声明里的「读」与获准能力表取 lib/activity_def_read.ts。空闲的会话不在任何活动里，按读全部办：它可能被问到任何一类集合。
 *
 * 下面几种情形不换，返回 null，助手拿到的就是 read 原来的返回：读的不是任务定义文件；早先的任务（没有阶段）；
 * 任务库、定义文件或活动声明读不出来，或者定义文件不是合法的 JSON（这些由各自的校验去报，这里不替它们报）。
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { READ_ALL, type ReadKey } from "./activity_def.ts";
import { definitionsFor } from "./activity_def_read.ts";
import { whereInWorkspace } from "./context_assemble.ts";
import { databasePath } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import { definitionView } from "./definition_view.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { IDLE, type Position } from "./stage.ts";

/** 换上的视图与它是给哪个位置的（报进工具结果的 details 里）。 */
export interface DefinitionReadView {
  text: string;
  stage: Position;
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** 任务库里记的任务定义文件（真实路径）与执行方法的路径；任务库还没有或者没有任务时返回 null。 */
function taskDefinitionFile(workspaceDir: string): { path: string | null; skillPath: string } | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT definition_path, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      { definition_path: string; definition_text: string } | undefined;
    if (!task) return null;
    return { path: real(resolve(workspaceDir, task.definition_path)), skillPath: validateDefinition(JSON.parse(task.definition_text)).skillPath };
  } finally {
    db.close();
  }
}

/**
 * 读的这份文件（target 是已经解析好的真实路径）要是本任务的任务定义文件，返回本会话的视图文字；不换时返回 null。
 */
export function definitionReadView(workspaceDir: string, sessionId: string | null, target: string | null): DefinitionReadView | null {
  if (target === null) return null;
  try {
    const task = taskDefinitionFile(workspaceDir);
    if (task === null || task.path === null || task.path !== target) return null;
    const where = whereInWorkspace(workspaceDir, sessionId);
    if (where === null) return null;
    const defs = definitionsFor(workspaceDir, task.skillPath);
    // 会话的活动：活动记录里的标识符；找不到（早先的记录写的是阶段的键）时取这个阶段的代表活动（标识符与阶段键相同的那一项）。
    const activity = defs.activities.find((one) => one.key === where.activity) ?? defs.activities.find((one) => one.key === where.stage);
    const reads: readonly ReadKey[] = where.stage === IDLE ? [READ_ALL] : activity?.reads ?? [];
    const raw: unknown = JSON.parse(readFileSync(target, "utf-8"));
    // 哪几个集合可写按当前活动取（与系统提示、工具调用时的守卫同一个来源：allowedFor）；空闲时是 IDLE。
    const view = definitionView(raw, { stage: where.stage, reads, allowed: defs.allowedFor(where.activity ?? where.stage) });
    return { text: JSON.stringify(view, null, 2), stage: where.stage };
  } catch {
    return null;
  }
}
