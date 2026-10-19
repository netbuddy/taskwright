/**
 * 任务的数据格式与登记：建任务时写 task.json 并记进登记表；服务接手已有的任务时补记；数据格式与这个程序对不上的任务不接手，
 * 列表里写明是哪一种（需要升级、需要处理、需要更新的程序）与原因，打开它的请求被拒；格式对上之后下一次扫描接手。
 */

import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASK_DB_VERSION, TASK_JSON } from "../../agent/src/lib/schema.ts";
import { ApiError } from "../src/errors.ts";
import * as library from "../src/library.ts";
import { LOCK_NAME } from "../src/occupancy.ts";
import { appVersion } from "../src/paths.ts";
import { type Mode, Service, taskTypeVersion } from "../src/service.ts";
import { ServiceDb } from "../src/service_db.ts";
import { readTaskJson } from "../src/task_json.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** 一个数据目录上的服务；registry 为假时没有服务级库。 */
function serviceOn(root: string, { registry = true, mode = "server" as Mode } = {}): Service {
  return new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, mode, registry: registry ? ServiceDb.open(root, appVersion()) : null });
}
const fresh = () => join(tmp, `case-${++n}`);

/** 直接改库文件自己的格式版本（模拟上一版建的库、或者更新的版本写的库）。 */
function setVersion(taskDir: string, version: number): void {
  const db = new DatabaseSync(join(taskDir, DB_NAME));
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("没有被拒绝");
}

test("建任务：任务目录里写 task.json，任务库是现在的格式版本，登记表里有这一行", async () => {
  const root = fresh();
  const service = serviceOn(root);
  try {
    const id = service.create({ task_type: "requirements-engineering", task_name: "借阅系统" }).task_id as string;
    const dir = join(root, "tasks", id);
    const meta = readTaskJson(dir)!;
    assert.deepEqual({ ...meta, created_at: "T" }, { created_by_version: appVersion(), task_type: "requirements-engineering", task_type_version: taskTypeVersion("requirements-engineering"),
      task_type_revision: 1, owner: "local", created_at: "T", upgraded_by_version: null, upgraded_at: null });
    assert.ok(meta.created_at, "建立时刻写了");
    assert.equal(library.taskDbVersion(dir), TASK_DB_VERSION);
    const row = service.registry!.task(id)!;
    assert.deepEqual([row.name, row.owner, row.status, row.task_type, row.dir, row.upgrade_error], ["借阅系统", "local", null, "requirements-engineering", id, null]);
    assert.ok(row.created_at);
    // 任务页给出任务类型说明的两个版本：建任务时复制进来的与产品自带的现在这一版。
    assert.deepEqual((service.taskPage(service.task(id)) as Record<string, any>).task_type_versions, { copied: 5, current: 5 });
    assert.equal(taskTypeVersion("requirements-engineering"), 5);
    assert.equal(taskTypeVersion("没有这种类型"), null);
  } finally {
    await service.close();
  }
});

test("接手已有的任务时补记进登记表；没有服务级库的服务照常工作、不记", async () => {
  const root = fresh();
  const plain = serviceOn(root, { registry: false });
  const id = plain.create({ task_type: "requirements-engineering", task_name: "先建的" }).task_id as string;
  assert.equal(plain.registry, null);
  assert.deepEqual(plain.listTasks().map((t) => t.task_id), [id]);
  await plain.close();
  const service = serviceOn(root);
  try {
    assert.equal(service.registry!.task(id), null, "还没有扫描");
    assert.deepEqual(service.listTasks().map((t) => t.task_id), [id]);
    assert.deepEqual([service.registry!.task(id)?.name, service.registry!.task(id)?.task_type], ["先建的", "requirements-engineering"]);
  } finally {
    await service.close();
  }
});

test("格式早于 8 的任务：不接手、不升级，列表里是「旧格式」并写明格式号，打开被拒，库没有被改", async () => {
  const root = fresh();
  const first = serviceOn(root);
  const id = first.create({ task_type: "requirements-engineering", task_name: "太早的任务" }).task_id as string;
  await first.close();
  const dir = join(root, "tasks", id);
  setVersion(dir, 5);
  const service = serviceOn(root);
  try {
    const listed = service.listTasks();
    assert.deepEqual(listed.map((t) => [t.task_id, t.unavailable, t.supported]), [[id, "旧格式", false]]);
    assert.match(listed[0].note!, /^这个任务库的格式是 5（0\.5 建的），本版本只能打开格式 8 及以后的任务库/);
    assert.equal(refusal(() => service.task(id)).code, "task_unavailable");
    assert.equal(library.taskDbVersion(dir), 5);
  } finally {
    await service.close();
  }
});

test("上一版建的任务（库是格式 8）：不接手、不占用，列表里是「需要升级」并写明怎样做，打开被拒；升级失败过的是「需要处理」并写原因", async () => {
  const root = fresh();
  const first = serviceOn(root);
  const id = first.create({ task_type: "requirements-engineering", task_name: "旧任务" }).task_id as string;
  await first.close();
  const dir = join(root, "tasks", id);
  setVersion(dir, 8);
  assert.equal(existsSync(join(dir, LOCK_NAME)), false, "先前的服务收尾时删了占用标记");
  for (const [mode, how] of [["server", "请停下服务后运行 taskwright data upgrade。"], ["desktop", "重新启动程序后升级。"]] as const) {
    const service = serviceOn(root, { mode });
    try {
      const listed = service.listTasks();
      assert.deepEqual(listed.map((t) => [t.task_id, t.task_name, t.unavailable, t.supported, t.note]),
        [[id, "旧任务", "需要升级", false, `这个任务是上一版建的，数据还没有升级。${how}`]]);
      const refused = refusal(() => service.task(id));
      assert.deepEqual([refused.code, refused.status, refused.message, (refused.data as any).status], ["task_unavailable", 409, listed[0].note, "需要升级"]);
      assert.equal(existsSync(join(dir, LOCK_NAME)), false, "没有接手就不写占用标记");
      assert.equal(library.taskDbVersion(dir), 8, "只读地看，库没有被改");
    } finally {
      await service.close();
    }
  }
  const service = serviceOn(root);
  try {
    service.registry!.markUpgradeFailed(id, "2026-10-08T12:00:00Z", "任务库读不出来");
    assert.deepEqual(service.listTasks().map((t) => [t.unavailable, t.note]), [["需要处理", "这个任务的数据升级没有做成：任务库读不出来"]]);
    assert.equal((refusal(() => service.task(id)).data as any).status, "需要处理");
    // 格式对上之后（升级做成了），下一次扫描就接手。
    setVersion(dir, TASK_DB_VERSION);
    assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.unavailable, t.supported]), [[id, null, true]]);
    assert.equal(service.task(id).taskId, id);
  } finally {
    await service.close();
  }
});

test("更新的版本写的任务：不接手，列表里是「需要更新的程序」，话里写出是哪个版本写的；task.json 读不到时不写版本", async () => {
  const root = fresh();
  const first = serviceOn(root);
  const id = first.create({ task_type: "requirements-engineering", task_name: "新任务" }).task_id as string;
  await first.close();
  const dir = join(root, "tasks", id);
  setVersion(dir, TASK_DB_VERSION + 1);
  writeFileSync(join(dir, TASK_JSON), JSON.stringify({ created_by_version: "0.5.0", upgraded_by_version: "0.7.0" }), "utf-8");
  const service = serviceOn(root);
  try {
    assert.deepEqual(service.listTasks().map((t) => [t.unavailable, t.supported, t.note]), [["需要更新的程序", false, "这份数据由 0.7.0 写入，请用 0.7.0 或更新的版本打开。"]]);
    rmSync(join(dir, TASK_JSON));
    assert.deepEqual(service.listTasks().map((t) => t.note), ["这份数据由更新的版本写入，请用更新的版本打开。"]);
    assert.equal(refusal(() => service.task(id)).code, "task_unavailable");
  } finally {
    await service.close();
  }
});
