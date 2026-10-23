/**
 * 删除任务（POST /api/v1/tasks/{任务编号}/delete，service.deleteTask）：助手正在工作时拒绝，请先停止助手，什么都不动；
 * 否则删掉任务目录与它的会话归档目录，任务列表与登记表里都不再有它，之后再打开说没有这个任务；服务日志记一行时刻、任务编号、任务名与请求来自哪里。
 * 不要求先导出。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { dispatch } from "../src/http.ts";
import { Service } from "../src/service.ts";
import { ServiceDb } from "../src/service_db.ts";
import { appVersion } from "../src/paths.ts";
import { captureConsole, tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const logs = captureConsole();
let n = 0;

function setup() {
  const root = join(tmp, `case-${++n}`);
  const registry = ServiceDb.open(root, appVersion());
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, registry });
  const taskId = service.create({ task_type: "requirements-engineering", task_name: "一次性的任务" }).task_id;
  const t = service.task(taskId);
  // 会话归档目录：runs 下以任务编号命名的目录（这里放一份假的会话文件就够）。
  mkdirSync(join(root, "runs", taskId, "pi-sessions"), { recursive: true });
  writeFileSync(join(root, "runs", taskId, "pi-sessions", "a.jsonl"), "{}\n");
  const remove = async () => {
    const reply = await dispatch(service, { method: "POST", path: `/api/v1/tasks/${taskId}/delete`, query: {}, headers: { "user-agent": "测试浏览器" }, body: Buffer.alloc(0), remote: "203.0.113.9" });
    return { status: reply.status, body: JSON.parse(reply.body.toString("utf-8")) };
  };
  return { root, registry, service, taskId, t, remove };
}

test("助手正在工作：拒绝，写明请先停止助手；任务目录、会话归档、列表与登记表都不动，日志里没有删除的记录", async () => {
  const { root, registry, service, taskId, t, remove } = setup();
  try {
    t.executor.state = "working";
    const refused = await remove();
    assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message], [409, "session_busy", "助手正在工作，请先停止助手，再删除这个任务实例。"]);
    t.executor.state = "not_started";
    assert.ok(existsSync(t.dir) && existsSync(join(root, "runs", taskId)));
    assert.deepEqual(service.listTasks().map((one) => one.task_id), [taskId]);
    assert.equal(registry.task(taskId)?.task_id, taskId);
    assert.equal(logs.some((line) => line.startsWith("删除任务") && line.includes(taskId)), false);
  } finally {
    await service.close();
  }
});

test("成功：删掉任务目录与会话归档，列表与登记表里都没有它，再打开说没有这个任务；日志记时刻、任务编号、任务名与来源；别的任务不受影响", async () => {
  const { root, registry, service, taskId, t, remove } = setup();
  const other = service.create({ task_type: "requirements-engineering", task_name: "留着的任务" }).task_id;
  try {
    const done = await remove();
    assert.deepEqual([done.status, done.body], [200, { ok: true, task_id: taskId }]);
    assert.deepEqual([existsSync(t.dir), existsSync(join(root, "runs", taskId))], [false, false]);
    assert.deepEqual(service.listTasks().map((one) => one.task_id), [other]);
    assert.equal(registry.task(taskId), null);
    assert.equal(registry.task(other)?.task_id, other);
    const gone = await dispatch(service, { method: "GET", path: `/api/v1/tasks/${taskId}`, query: {}, headers: {}, body: Buffer.alloc(0) });
    assert.equal(JSON.parse(gone.body.toString("utf-8")).error.code, "not_found");
    const line = logs.find((one) => one.startsWith("删除任务") && one.includes(taskId))!;
    assert.match(line, new RegExp(`^删除任务：时刻 \\d{4}-\\d\\d-\\d\\dT[^，]+，任务 ${taskId}「一次性的任务」，来自 203\\.0\\.113\\.9，测试浏览器。$`));
  } finally {
    await service.close();
  }
});
