/**
 * 服务级库的数据模块：新建与再打开、格式版本与最近写它的产品版本、比程序新的拒绝、任务登记表的取存、升级失败的记与清；
 * 数据目录按什么次序定；服务启动时建出服务级库，只给 --tasks 时它落在任务目录的上一级、不落到用户数据目录。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { ENV_DATA_DIR, appVersion, dataDirectory, userDataDir } from "../src/paths.ts";
import { DATA_FORMAT, NewerDataDirectory, SERVICE_DB_NAME, ServiceDb, peekDataDirectory, serviceDbPath, type TaskEntry } from "../src/service_db.ts";
import { StartError, startService } from "../src/start.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(tmp, `data-${++n}`);

const entry = (id: string, more: Partial<TaskEntry> = {}): TaskEntry =>
  ({ task_id: id, name: `任务 ${id}`, owner: "local", status: "进行中", task_type: "srs-authoring", created_at: "2026-10-08T12:00:00Z", dir: id, ...more });

test("新建：数据目录不在就建出来，两张表都在，格式版本与写它的产品版本记下；再打开不重建，产品版本改成这一次的", () => {
  const dir = fresh();
  assert.equal(peekDataDirectory(dir), null, "还没有服务级库");
  const db = ServiceDb.open(dir, "0.5.0");
  assert.equal(db.meta("data_format"), String(DATA_FORMAT));
  assert.equal(db.meta("last_written_by"), "0.5.0");
  db.putTask(entry("TASK-1"));
  db.close();
  db.close(); // 重复关不出错
  assert.deepEqual(peekDataDirectory(dir), { data_format: DATA_FORMAT, last_written_by: "0.5.0" });
  const again = ServiceDb.open(dir, "0.5.1");
  assert.equal(again.meta("last_written_by"), "0.5.1");
  assert.deepEqual(again.tasks().map((t) => t.task_id), ["TASK-1"], "先前登记的还在");
  again.close();
});

test("比这个程序新的数据目录：打开被拒并带出写它的产品版本，库原样不动", () => {
  const dir = fresh();
  ServiceDb.open(dir, "0.6.0").close();
  const raw = new DatabaseSync(serviceDbPath(dir));
  raw.exec(`PRAGMA user_version = ${DATA_FORMAT + 1}`);
  raw.close();
  assert.throws(() => ServiceDb.open(dir, "0.5.0"), (error: Error) => error instanceof NewerDataDirectory && error.writtenBy === "0.6.0");
  assert.deepEqual(peekDataDirectory(dir), { data_format: DATA_FORMAT + 1, last_written_by: "0.6.0" }, "被拒之后写它的产品版本没有被改成旧的");
});

test("任务登记表：登记、再登记是改写、按编号与按目录取、列出时按编号排", () => {
  const db = ServiceDb.open(fresh(), "0.5.0");
  try {
    db.putTask(entry("TASK-B"));
    db.putTask(entry("TASK-A", { name: null, status: null, task_type: null, created_at: null }));
    db.putTask(entry("TASK-B", { name: "改过的名字", status: "已完成" }));
    assert.deepEqual(db.tasks().map((t) => [t.task_id, t.name, t.status]), [["TASK-A", null, null], ["TASK-B", "改过的名字", "已完成"]]);
    assert.deepEqual(db.task("TASK-B"), { ...entry("TASK-B", { name: "改过的名字", status: "已完成" }), upgrade_failed_at: null, upgrade_error: null });
    assert.equal(db.taskByDir("TASK-A")?.task_id, "TASK-A");
    assert.equal(db.task("没有的"), null);
    assert.equal(db.taskByDir("没有的"), null);
  } finally {
    db.close();
  }
});

test("升级失败：按目录记下时刻与原因，再登记不冲掉，升级成了清掉；没有登记过的目录先按目录名记一行，登记时并成一行", () => {
  const db = ServiceDb.open(fresh(), "0.5.0");
  try {
    db.putTask(entry("TASK-1"));
    db.markUpgradeFailed("TASK-1", "2026-10-08T12:00:00Z", "读不出任务库");
    db.putTask(entry("TASK-1", { name: "换了名字" }));
    assert.deepEqual([db.task("TASK-1")?.name, db.task("TASK-1")?.upgrade_failed_at, db.task("TASK-1")?.upgrade_error], ["换了名字", "2026-10-08T12:00:00Z", "读不出任务库"]);
    db.clearUpgradeFailed("TASK-1");
    assert.deepEqual([db.task("TASK-1")?.upgrade_failed_at, db.task("TASK-1")?.upgrade_error], [null, null]);
    // 目录名与任务编号不同、升级失败时还读不出编号的任务。
    db.markUpgradeFailed("复制来的目录", "2026-10-08T13:00:00Z", "库是坏的");
    assert.deepEqual(db.taskByDir("复制来的目录"), { task_id: "复制来的目录", name: null, owner: "local", status: null, task_type: null, created_at: null,
      dir: "复制来的目录", upgrade_failed_at: "2026-10-08T13:00:00Z", upgrade_error: "库是坏的" });
    db.putTask(entry("TASK-9", { dir: "复制来的目录" }));
    assert.deepEqual(db.tasks().map((t) => t.task_id), ["TASK-1", "TASK-9"], "这个目录只留一行");
    assert.equal(db.task("TASK-9")?.upgrade_error, "库是坏的", "先前记的失败带过来");
  } finally {
    db.close();
  }
});

test("数据目录的定法：先看给的，再看环境变量，再看任务目录的上一级，最后才是用户数据目录", () => {
  const env = { [ENV_DATA_DIR]: "/srv/env-data" };
  assert.equal(dataDirectory("/srv/given", "/srv/x/tasks", env), "/srv/given");
  assert.equal(dataDirectory(null, "/srv/x/tasks", env), "/srv/env-data");
  assert.equal(dataDirectory(null, "/srv/x/tasks", {}), "/srv/x");
  assert.equal(dataDirectory(null, null, {}), userDataDir());
});

test("服务启动时建出服务级库：只给 --tasks 时落在任务目录的上一级；给了 --data 时落在那里，三个目录也在它下面", async () => {
  const root = fresh();
  const one = await startService({ port: 0, mode: "server", host: "127.0.0.1", profile: "fake", ownProcess: false,
    tasks: join(root, "tasks"), runs: join(root, "runs"), knowledge: join(root, "knowledge") });
  try {
    assert.equal(one.dataDir, root);
    assert.ok(existsSync(join(root, SERVICE_DB_NAME)));
    assert.equal(one.service.registry?.meta("last_written_by"), appVersion());
  } finally {
    await one.stop();
  }
  const data = fresh();
  const two = await startService({ port: 0, mode: "server", host: "127.0.0.1", profile: "fake", ownProcess: false, data });
  try {
    assert.deepEqual([two.dataDir, two.tasksDir, two.runsDir, two.knowledgeDir], [data, join(data, "tasks"), join(data, "runs"), join(data, "knowledge")]);
    assert.ok(readdirSync(data).includes(SERVICE_DB_NAME));
  } finally {
    await two.stop();
  }
});

test("数据目录比这个程序新：服务不启动，说明是哪个版本写的", async () => {
  const data = fresh();
  mkdirSync(data, { recursive: true });
  ServiceDb.open(data, "0.9.0").close();
  const raw = new DatabaseSync(serviceDbPath(data));
  raw.exec(`PRAGMA user_version = ${DATA_FORMAT + 1}`);
  raw.close();
  await assert.rejects(startService({ port: 0, mode: "server", host: "127.0.0.1", profile: "fake", ownProcess: false, data }),
    (error: Error) => error instanceof StartError && /这份数据由 0\.9\.0 写入，请用 0\.9\.0 或更新的版本打开。/.test(error.message));
});
