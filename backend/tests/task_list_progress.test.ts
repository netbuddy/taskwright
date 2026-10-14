/**
 * 任务列表每行的进展（service.listTasks）：流程工作项在第几站（没有流程工作项时为 null）、工作项个数、未了结的阻断下游的问题有几条
 * （写条目那一段「没有未了结的阻断下游的问题」那盏灯列出的条目）。页面据此写「需求分析 · 第 4 站写条目 · 2 个工作项 · 2 条阻断」，
 * 不再逐个任务去请求任务状况。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Service } from "../src/service.ts";
import { sqlRun, tempDir } from "./helpers.ts";
import { DEFINITION, SOURCE, build } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 带总体分析的演示任务定义，再加一个有「是否阻断下游」字段的问题集合，照产品的任务类型。 */
const WITH_BLOCKING = { ...DEFINITION, 交付物: { ...DEFINITION.交付物, 条目集合: [...DEFINITION.交付物.条目集合, {
  名称: "问题", 编号前缀: "Q", 字段: [
    { 名: "事项", 类型: "文本", 必填: true }, { 名: "种类", 类型: "枚举", 必填: true, 取值: ["待澄清", "待定"] },
    { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决", "用户决定保留"] },
    { 名: "是否阻断下游", 类型: "枚举", 必填: false, 取值: ["阻断下游", "不阻断"] }, { 名: "何时回看", 类型: "文本", 必填: false }],
}] } };
const question = (subject: string, status: string, blocking: string) =>
  ({ op: "add", collection: "问题", fields: { 事项: subject, 种类: "待澄清", 状态: status, 是否阻断下游: blocking, ...(blocking === "不阻断" ? { 何时回看: "评审确认时" } : {}) }, sources: [SOURCE] });

test("进展：流程工作项在写条目（第 4 站）、两个工作项、两条未了结的阻断问题；没有工作项的任务流程为 null、个数为 0、阻断为 0", async () => {
  const tasks = join(tmp, "tasks");
  mkdirSync(tasks, { recursive: true });
  // 夹具一建好任务就由用户移到写条目：有了一个需求分析的流程工作项。三条问题里两条未了结而阻断下游，一条不阻断。
  const busy = build(tasks, "busy", WITH_BLOCKING, [[question("借期多长", "未解决", "阻断下游"), question("能否续借", "未解决", "阻断下游"),
    question("罚款怎么算", "未解决", "不阻断")]]);
  // 另有一个单项活动的工作项（直接改库）。
  sqlRun(busy, [["INSERT INTO activity_record (task_id, session_id, call_id, actor, activity, node, flow, reason, started_at, started_seq, scope) " +
    "SELECT task_id, 's2', 'ui-op-alone', 'user', 'clarifying', NULL, NULL, '', '2026-10-11T10:00:00', 9000, NULL FROM task"]]);
  const service = new Service(tasks, join(tmp, "runs"), {}, { port: 1, registry: null });
  try {
    const empty = service.create({ task_type: "srs-authoring", task_name: "空任务" }).task_id;
    const rows = Object.fromEntries(service.listTasks().map((one) => [one.task_name === "空任务" ? "empty" : "busy", one]));
    assert.deepEqual([rows.busy.flow, rows.busy.work_item_count, rows.busy.blocking_count],
      [{ name: "需求分析", node: "writing", node_name: "写条目", ordinal: 4 }, 2, 2]);
    assert.deepEqual([rows.empty.task_id, rows.empty.flow, rows.empty.work_item_count, rows.empty.blocking_count], [empty, null, 0, 0]);
  } finally {
    await service.close();
  }
});
