/**
 * 写库前核对任务库在本服务的任务根目录之下（TASKWRIGHT_TASKS_ROOT）：之下放行；不在之下（包括经符号链接指到别处）拒绝，
 * 什么都不写；没有传根目录时不核对。保存修订与界面操作都经同一处（withTaskDatabase）。
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { OutsideTasksRoot, TASKS_ROOT_ENV } from "../src/lib/schema.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace, query } from "./helpers.ts";

const add = { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] }] };

function withRoot<T>(root: string | undefined, body: () => T): T {
  const saved = process.env[TASKS_ROOT_ENV];
  if (root === undefined) delete process.env[TASKS_ROOT_ENV];
  else process.env[TASKS_ROOT_ENV] = root;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env[TASKS_ROOT_ENV];
    else process.env[TASKS_ROOT_ENV] = saved;
  }
}

/** 在一个新的任务根目录下放一个建好任务的任务目录，返回（根目录, 任务目录）。 */
function rootWithTask(): [string, string] {
  const root = mkdtempSync(join(tmpdir(), "taskwright-root-"));
  const source = makeWorkspace();
  const dir = join(root, "TASK-A");
  cpSync(source, dir, { recursive: true });
  withRoot(undefined, () => createTask(callIn(dir), { definition_path: DEFINITION_PATH }));
  return [root, dir];
}

test("任务库在任务根目录之下：保存修订照常写入", () => {
  const [root, dir] = rootWithTask();
  withRoot(root, () => saveRevision(callIn(dir), add));
  assert.equal(query(dir, "SELECT COUNT(*) AS n FROM item")[0].n, 1);
});

test("任务库不在任务根目录之下：保存修订与界面操作都拒绝，说明是哪个库、哪个任务目录，什么都不写", () => {
  const [, dir] = rootWithTask();
  const otherRoot = mkdtempSync(join(tmpdir(), "taskwright-other-root-"));
  assert.throws(() => withRoot(otherRoot, () => saveRevision(callIn(dir), add)),
    (e: Error) => e instanceof OutsideTasksRoot && e.message.includes(`${dir}/task.sqlite`) && e.message.includes("不在本服务的任务目录") && e.message.endsWith("拒绝写入。"));
  assert.throws(() => withRoot(otherRoot, () => runUserOperation({ workspaceDir: dir, sessionId: "s" },
    { op_id: "ui-op-x", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] })), /拒绝写入/);
  assert.equal(query(dir, "SELECT COUNT(*) AS n FROM item")[0].n, 0);
});

test("经符号链接放进任务根目录、实际在别处的任务目录也拒绝", () => {
  const [, dir] = rootWithTask();
  const root = mkdtempSync(join(tmpdir(), "taskwright-link-root-"));
  mkdirSync(root, { recursive: true });
  symlinkSync(dir, join(root, "TASK-LINK"));
  assert.throws(() => withRoot(root, () => saveRevision(callIn(join(root, "TASK-LINK")), add)), OutsideTasksRoot);
});

test("没有传任务根目录时不核对", () => {
  const [, dir] = rootWithTask();
  withRoot(undefined, () => saveRevision(callIn(dir), add));
  assert.equal(query(dir, "SELECT COUNT(*) AS n FROM item")[0].n, 1);
});
