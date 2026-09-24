/** 创建任务的命令行入口：建出任务（发起方 user、操作编号），第二次拒绝，参数不对时拒绝；结果是一行 JSON。 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFINITION_PATH, count, makeWorkspace, query } from "./helpers.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "create_task.mts");

function run(...args: string[]) {
  const done = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });
  return { code: done.status, reply: JSON.parse(done.stdout.trim().split("\n").at(-1) ?? "{}") };
}

test("建出任务：一行 JSON 结果，任务行与事件的发起方是 user、编号是操作编号、会话编号为空", () => {
  const dir = makeWorkspace();
  const { code, reply } = run("--dir", dir, "--definition", DEFINITION_PATH, "--op-id", "ui-op-5", "--name", "登录模块", "--tag", "账户");
  assert.equal(code, 0);
  assert.deepEqual(reply, { ok: true, task_id: "TASK-001", task_name: "登录模块", task_type: "演示任务", domain_tag: "账户", event_seq: 1 });
  assert.deepEqual({ ...query<any>(dir, "SELECT session_id, call_id FROM task")[0] }, { session_id: "", call_id: "ui-op-5" });
  assert.deepEqual({ ...query<any>(dir, "SELECT actor, call_id FROM event")[0] }, { actor: "user", call_id: "ui-op-5" });
});

test("第二次拒绝：一库一任务，退出码 1，库里不多任何行", () => {
  const dir = makeWorkspace();
  run("--dir", dir, "--definition", DEFINITION_PATH, "--op-id", "ui-op-1");
  const { code, reply } = run("--dir", dir, "--definition", DEFINITION_PATH, "--op-id", "ui-op-2");
  assert.equal(code, 1);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /这个任务目录的库里已经有任务了：任务编号是 TASK-001/);
  assert.equal(count(dir, "task"), 1);
  assert.equal(count(dir, "event"), 1);
});

test("参数不对时拒绝：缺参数、操作编号不以 ui- 开头", () => {
  const dir = makeWorkspace();
  assert.match(run("--dir", dir).reply.error, /缺少参数：--definition、--op-id/);
  const bad = run("--dir", dir, "--definition", DEFINITION_PATH, "--op-id", "call-1");
  assert.equal(bad.code, 1);
  assert.match(bad.reply.error, /--op-id 应当是后端生成的操作编号，以 ui- 开头/);
});

test("任务编号可以由后端交进来；写法不对时拒绝", () => {
  const dir = makeWorkspace();
  const { reply } = run("--dir", dir, "--definition", DEFINITION_PATH, "--op-id", "ui-op-1", "--task-id", "TASK-20260921-7F3A");
  assert.equal(reply.task_id, "TASK-20260921-7F3A");
  const other = makeWorkspace();
  const bad = run("--dir", other, "--definition", DEFINITION_PATH, "--op-id", "ui-op-1", "--task-id", "task/../x");
  assert.equal(bad.code, 1);
  assert.match(bad.reply.error, /任务编号「task\/\.\.\/x」的写法不对/);
});
