/**
 * 后端测试共用的夹具。写库一律经 agent 测试目录里的夹具脚本（子进程运行，内部调用真实的写入函数），
 * 后端的代码与测试都不导入写入函数。个别测试要在夹具库的副本上补几行（模拟旧库、补事件），
 * 用 sqlRun 在临时副本上直接执行 SQL，与服务端 Python 测试的做法相同；那只是测试夹具，不是产品代码的写入路径。
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "agent", "tests", "fixtures");

/** 与服务端测试同一份演示任务定义：用例、待定事项两个集合。 */
export const DEMO_DEFINITION = {
  任务名: "演示任务",
  交付物: {
    名称: "演示交付物", 文档模板: "docs/templates/demo.md", 每个条目附带: "来源",
    条目集合: [
      { 名称: "用例", 编号前缀: "UC", 字段: [{ 名: "名称", 类型: "文本", 必填: true }, { 名: "步骤", 类型: "文本列表", 必填: true }] },
      { 名称: "待定事项", 编号前缀: "TBD", 字段: [
        { 名: "事项", 类型: "文本", 必填: true },
        { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决"] },
        { 名: "关联条目", 类型: "条目引用", 必填: false }] },
    ],
  },
  完成条件: { 用例: ["至少一个条目"], 待定事项: ["没有状态为未解决的条目"] },
  执行方法: ".pi/skills/demo/SKILL.md",
  领域规矩: ["docs/domain-knowledge/demo.md"],
};

export function tempDir(prefix = "taskwright-backend-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function node(args: string[]): void {
  const done = spawnSync(process.execPath, args, { encoding: "utf-8" });
  if (done.status !== 0) throw new Error(`夹具脚本失败：${done.stderr}`);
}

/**
 * 演示任务目录。withDb 为真时库由夹具写出：修订 1 新增 UC-001（名称「申请退款」）与 TBD-001；修订 2 把 UC-001 改成
 * 「买家申请退款」、改 TBD-001、新增 UC-002；修订 3 删除 UC-002。事件 1 是创建任务，事件 2 到 4 是三次修订。
 */
export function makeWorkspace(root: string, name: string, withDb: boolean): string {
  const ws = join(root, name);
  mkdirSync(join(ws, "docs", "task-definitions"), { recursive: true });
  writeFileSync(join(ws, "docs", "task-definitions", "demo.json"), JSON.stringify(DEMO_DEFINITION), "utf-8");
  if (withDb) node([join(FIXTURES, "build_current_db.mts"), ws]);
  return ws;
}

/** 用真实任务类型的起始文件建一个任务目录，按几批操作各保存一次修订。 */
export function makeTypedTask(root: string, taskType: string, materials: Record<string, string>, batches: unknown[][]): string {
  const ws = join(root, "task");
  cpSync(join(ROOT, "task-types", taskType), ws, { recursive: true });
  mkdirSync(join(ws, "inputs"), { recursive: true });
  for (const [name, text] of Object.entries(materials)) writeFileSync(join(ws, "inputs", name), text, "utf-8");
  node([join(FIXTURES, "build_task_db.mts"), ws, `docs/task-definitions/${taskType}.json`, JSON.stringify(batches)]);
  return ws;
}

/** 把夹具目录复制一份，给要改库的测试用。 */
export function copyWorkspace(ws: string, to: string): string {
  cpSync(ws, to, { recursive: true });
  return to;
}

/** 在测试夹具库上直接执行几条 SQL（每条可带参数）。只用于临时副本。 */
export function sqlRun(ws: string, statements: [string, ...unknown[]][]): void {
  const db = new DatabaseSync(join(ws, "task.sqlite"));
  try {
    for (const [sql, ...params] of statements) db.prepare(sql).run(...(params as any[]));
  } finally {
    db.close();
  }
}

export function sqlGet(ws: string, sql: string, ...params: unknown[]): Record<string, any> | undefined {
  const db = new DatabaseSync(join(ws, "task.sqlite"), { readOnly: true });
  try {
    const row = db.prepare(sql).get(...(params as any[]));
    return row ? { ...row } : undefined;
  } finally {
    db.close();
  }
}
