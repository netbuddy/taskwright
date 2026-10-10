/**
 * 带「总体分析」集合的测试任务：演示任务定义加这个集合（字段照产品的任务类型），经子进程里助手一侧真实的保存函数建库。
 * 快照与文档渲染两份测试共用。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_DEFINITION, ROOT, sqlGet, sqlRun } from "./helpers.ts";

const BUILD = join(ROOT, "agent", "tests", "fixtures", "build_task_db.mts");
const USER_OPS = join(ROOT, "agent", "tests", "fixtures", "user_ops.mts");
export const MATERIAL = "读者对在架的书办预约。只有在架的书才能预约取书。\n";
export const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "读者对在架的书办预约。" };
export const SUPPLEMENT = (supports: unknown[]) => ({ kind: "助手补充", excerpt: "高校图书馆常见的做法，等用户确认。", supports });

/** 演示任务定义加一个总体分析集合（字段照产品的任务类型）。 */
export const DEFINITION = {
  ...DEMO_DEFINITION,
  交付物: { ...DEMO_DEFINITION.交付物, 条目集合: [...DEMO_DEFINITION.交付物.条目集合, {
    名称: "总体分析", 编号前缀: "OA", 界面: { 右侧栏页签: true, 分组字段: "标签", 靠前的组: ["概念"] },
    字段: [
      { 名: "标题", 类型: "文本", 必填: true }, { 名: "别名", 类型: "文本列表", 必填: false }, { 名: "它是什么", 类型: "文本", 必填: true },
      { 名: "例子", 类型: "文本列表", 必填: false }, { 名: "已经定下的", 类型: "文本列表", 必填: false },
      { 名: "标签", 类型: "文本列表", 必填: false, 取值: ["概念", "角色", "流程", "场景", "目标", "范围", "假设", "决定"] },
      { 名: "上级主题", 类型: "条目引用", 必填: false, 只许本集合: true, 至多一个: true },
      { 名: "状态", 类型: "枚举", 必填: true, 取值: ["在用", "已废弃"] },
      { 名: "改看", 类型: "条目引用", 必填: false, 只许本集合: true, 至多一个: true },
    ],
  }] },
  完成条件: { ...DEMO_DEFINITION.完成条件, 总体分析: ["每个条目用户确认"] },
};

/**
 * 建一个任务目录并按几批保存。任务一建好就由用户移到写条目阶段（夹具里的 { stage }，早先建的任务没有阶段、这一步什么都不做），
 * 这样各批里助手可以直接写别的集合的条目；这里的测试测的不是工作阶段。
 */
export function build(root: string, name: string, definition: unknown, batches: unknown[]): string {
  const ws = join(root, name);
  mkdirSync(join(ws, "docs", "task-definitions"), { recursive: true });
  mkdirSync(join(ws, "inputs"), { recursive: true });
  writeFileSync(join(ws, "docs", "task-definitions", "demo.json"), JSON.stringify(definition), "utf-8");
  writeFileSync(join(ws, "inputs", "材料.md"), MATERIAL, "utf-8");
  const done = spawnSync(process.execPath, [BUILD, ws, "docs/task-definitions/demo.json", JSON.stringify([{ stage: "写条目" }, ...batches])], { encoding: "utf-8" });
  assert.equal(done.status, 0, done.stderr);
  return ws;
}

/** 记一条用户在某个条目的某次修订上的确认（已读）。 */
export function confirm(ws: string, itemId: string, revisionNo: number): void {
  const taskId = sqlGet(ws, "SELECT task_id FROM task")!.task_id;
  const seq = Number(sqlGet(ws, "SELECT MAX(seq) AS seq FROM event")!.seq);
  const id = Number(sqlGet(ws, "SELECT COALESCE(MAX(judgement_id), 0) + 1 AS id FROM judgement")!.id);
  sqlRun(ws, [
    ["INSERT INTO judgement (judgement_id, task_id, basis, call_id, event_seq, created_at) VALUES (?, ?, ?, ?, ?, '2026-10-09 10:00:00')", id, taskId, JSON.stringify([{ 依据: "已读", 操作编号: `ui-op-${id}` }]), `ui-op-${id}`, seq],
    ["INSERT INTO judgement_item (judgement_id, task_id, item_id, revision_no, attitude, event_seq) VALUES (?, ?, ?, ?, '接受', ?)", id, taskId, itemId, revisionNo, seq],
  ]);
}

/** 经子进程里助手一侧真实的界面操作函数，做几次用户的界面操作（改字段、标为已读）；返回各次产生的修订号。 */
let opNo = 0;
export function userOps(ws: string, requests: Record<string, unknown>[]): (number | null)[] {
  const numbered = requests.map((one) => ({ op_id: `ui-op-fixture-${++opNo}`, ...one }));
  const done = spawnSync(process.execPath, [USER_OPS, ws, JSON.stringify(numbered)], { encoding: "utf-8" });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
}

/** 一页合格的主题（贴了标签、有例子、不待核实）：有了它，助手才能往别的集合里新增条目。它的文字里没有别的页的词。 */
export const READY = { op: "add", collection: "总体分析",
  fields: { 标题: "馆藏范围", 它是什么: "本馆全部可以外借的纸质图书。", 例子: ["《算法导论》在三楼科技书库。"], 标签: ["范围"], 状态: "在用" }, sources: [SOURCE] };

export const page = (fields: Record<string, unknown>, sources: unknown[] = [SOURCE]) =>
  ({ op: "add", collection: "总体分析", fields: { 它是什么: "读者对在架的书办预约。", 状态: "在用", ...fields }, sources });
