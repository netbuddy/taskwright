/**
 * 用各个旧版本自己写出来的样本任务目录（tests/fixtures/task_dirs/，由那里的 build.mjs 生成）验数据升级：
 * 每一份都升得到现在的格式，条目、修订、来源一条不少，来源的种类是现在的名字；升完服务能接手它、读得出内容，还能照常再存一次修订。
 * 样本只读不改：每例先把样本复制到临时的数据目录里再动。
 *
 * 0.5.0 的样本另验一件事：那一版的阶段记录升成活动记录之后，任务现在的阶段、最近一次移动与全部记录读出来与升级之前一样。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TABLE_NAMES, TASKS_ROOT_ENV, TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import * as clock from "../src/clock.ts";
import { planUpgrade, runUpgrade } from "../src/data_upgrade.ts";
import * as library from "../src/library.ts";
import { Service } from "../src/service.ts";
import { readTaskJson } from "../src/task_json.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
const SAVE_MORE = join(ROOT, "agent", "tests", "fixtures", "save_more.mts");
const VERSIONS = ["0.4.0", "0.4.1", "0.4.2", "0.4.3"];
/** 有工作阶段的那一版的样本：库是编过版本号的（格式版本 4），里面有四次阶段移动。 */
const STAGED = "0.5.0";
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 库里的几个数：修订、条目、来源各几条，来源各种类几条，表几张。只读。 */
function facts(taskDir: string) {
  const db = new DatabaseSync(join(taskDir, DB_NAME), { readOnly: true });
  try {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      revisions: count("SELECT COUNT(*) AS n FROM revision"), items: count("SELECT COUNT(DISTINCT item_id) AS n FROM item_version"),
      sources: count("SELECT COUNT(*) AS n FROM item_source"),
      kinds: Object.fromEntries((db.prepare("SELECT kind, COUNT(*) AS n FROM item_source GROUP BY kind").all() as { kind: string; n: number }[]).map((r) => [r.kind, r.n])),
      tables: count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'"),
    };
  } finally {
    db.close();
  }
}

test("样本齐全：五个版本各一份，每份有任务库、docs 与 inputs，没有归档与会话文件", () => {
  assert.deepEqual(readdirSync(SAMPLES).filter((name) => /^\d/.test(name)).sort(), [...VERSIONS, STAGED]);
  for (const version of [...VERSIONS, STAGED]) assert.deepEqual(readdirSync(join(SAMPLES, version)).sort(), ["docs", "inputs", DB_NAME], version);
});

for (const version of VERSIONS) {
  test(`${version} 建的任务：升到现在的格式，内容一条不少；服务接手得了，还能再存一次修订`, async () => {
    const dataDir = join(tmp, version);
    const where = { dataDir, tasksDir: join(dataDir, "tasks"), knowledgeDir: null };
    const id = `TASK-SAMPLE-${version.replaceAll(".", "")}`;
    const taskDir = join(where.tasksDir, id);
    mkdirSync(where.tasksDir, { recursive: true });
    cpSync(join(SAMPLES, version), taskDir, { recursive: true });
    const before = facts(taskDir);
    assert.deepEqual([library.taskDbVersion(taskDir), before.revisions, before.items, before.sources], [0, 3, 4, 4], "样本是没有编过版本号的库：三次修订、四个条目、四条来源");
    const renamed = version >= "0.4.2";
    assert.deepEqual(before.kinds, renamed ? { 文档原文: 2, 助手补充: 1, 条目: 1 } : { 文档原文: 2, 执行者补充: 1, 领域说明: 1 }, "样本里是那个版本自己的种类名");

    const plan = planUpgrade(where);
    assert.deepEqual(plan.tasks.map((t) => [t.dir, t.task_id, t.name, t.version]), [[id, id, "图书借阅（样本）", 0]]);
    const { report, registry } = await runUpgrade(plan, { productVersion: "0.5.0" });
    try {
      assert.deepEqual([report.fatal, report.tasks.map((t) => [t.dir, t.from, t.to, t.ok, t.error])], [null, [[id, 0, TASK_DB_VERSION, true, null]]]);
      const now = facts(taskDir);
      assert.deepEqual([library.taskDbVersion(taskDir), now.revisions, now.items, now.sources], [TASK_DB_VERSION, 3, 4, 4]);
      assert.deepEqual(now.kinds, { 文档原文: 2, 助手补充: 1, 条目: 1 }, "来源的种类都是现在的名字");
      assert.equal(now.tables, TABLE_NAMES.length);
      assert.deepEqual([readTaskJson(taskDir)?.created_by_version, readTaskJson(taskDir)?.task_type, readTaskJson(taskDir)?.upgraded_by_version], [null, "srs-authoring", "0.5.0"]);
      assert.equal(library.taskDbVersion(join(report.backup!.dir, "tasks", id)), 0, "备份里是升级之前的库");

      // 服务接手它：列表里是能打开的任务，任务页读得出条目与材料。
      const service = new Service(where.tasksDir, join(dataDir, "runs"), {}, { port: 1, registry });
      try {
        assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.task_name, t.status, t.supported, t.item_count]), [[id, "图书借阅（样本）", "进行中", true, 4]]);
        const page = service.taskPage(service.task(id)) as Record<string, any>;
        assert.deepEqual(page.materials.map((m: any) => m.path), ["inputs/材料.md"]);
        assert.deepEqual(page.task_type_versions, { copied: null, current: 4 }, "上一版建的任务没有记任务类型说明是第几版");
      } finally {
        await service.close();
      }
    } finally {
      registry?.close();
    }

    // 再存一次修订：经子进程调助手一侧真实的保存函数，引用材料里的原话与先前的领域说明。
    const more = spawnSync(process.execPath, [SAVE_MORE, taskDir, JSON.stringify([[{ op: "add", collection: "功能用例",
      fields: { 用例名称: "缴纳罚款", 用例功能: "读者缴纳逾期罚款。", 参与者: ["读者"], 基本流程: ["读者查看罚款", "读者缴费"] },
      sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "逾期不还的，按馆里的规定罚款。", supports: [{ field: "用例功能" }] },
        { kind: "条目", locator: "DN-001", excerpt: "借书证是读者在本馆借书的凭证。", supports: [{ field: "用例名称" }] }] }]])],
      { encoding: "utf-8", env: { ...process.env, [TASKS_ROOT_ENV]: where.tasksDir } });
    assert.equal(more.status, 0, more.stderr);
    assert.deepEqual(JSON.parse(more.stdout), [4], "存成了修订 4");
    const after = facts(taskDir);
    assert.deepEqual([after.revisions, after.items, after.sources, library.taskDbVersion(taskDir)], [4, 5, 6, TASK_DB_VERSION]);
    assert.equal(existsSync(join(SAMPLES, version, `${DB_NAME}-wal`)), false, "仓里的样本没有被打开过");
  });
}

test("0.5.0 建的任务：阶段记录升成活动记录，现在的阶段、最近一次移动与全部记录读出来与升级之前一样；服务接手得了，还能再移一次", async () => {
  const dataDir = join(tmp, STAGED);
  const where = { dataDir, tasksDir: join(dataDir, "tasks"), knowledgeDir: null };
  const id = "TASK-SAMPLE-050";
  const taskDir = join(where.tasksDir, id);
  mkdirSync(where.tasksDir, { recursive: true });
  cpSync(join(SAMPLES, STAGED), taskDir, { recursive: true });

  // 升级之前：直接读那一版的阶段记录表，所属流程取自移动事件（那一版就是这样读的）。
  assert.equal(library.taskDbVersion(taskDir), 4, "样本是格式版本 4 的库");
  const old = new DatabaseSync(join(taskDir, DB_NAME), { readOnly: true });
  let before: Record<string, any>[], eventsBefore: unknown[];
  try {
    before = old.prepare(
      "SELECT r.record_id, r.from_stage, r.stage, r.actor, r.reason, r.run_id, r.session_id, r.call_id, r.event_seq, r.created_at, json_extract(e.payload, '$.flow') AS flow " +
        "FROM stage_record r JOIN event e ON e.seq = r.event_seq ORDER BY r.event_seq",
    ).all().map((row) => ({ ...row }));
    eventsBefore = old.prepare("SELECT seq, name, payload, actor, at FROM event ORDER BY seq").all().map((row) => ({ ...row }));
  } finally {
    old.close();
  }
  assert.deepEqual(before.map((r) => [r.from_stage, r.stage, r.actor, r.reason, r.flow]), [
    ["reading", "clarifying", "user", "用户在卡片上选了「进入澄清」", "initial"],
    ["clarifying", "modeling", "user", "用户在卡片上选了「进入整理建模」", "initial"],
    ["modeling", "writing", "user", "用户在卡片上选了「开始写条目」", "initial"],
    ["writing", "clarifying", "user", "借期还没有问清楚。", "initial"],
  ], "样本里是四次移动，最后退回了澄清");

  const plan = planUpgrade(where);
  assert.deepEqual(plan.tasks.map((t) => [t.dir, t.task_id, t.version]), [[id, id, 4]]);
  const { report, registry } = await runUpgrade(plan, { productVersion: "0.6.0" });
  try {
    assert.deepEqual([report.fatal, report.tasks.map((t) => [t.dir, t.from, t.to, t.ok, t.error])], [null, [[id, 4, TASK_DB_VERSION, true, null]]]);
    assert.equal(library.taskDbVersion(taskDir), TASK_DB_VERSION);
    assert.equal(library.taskDbVersion(join(report.backup!.dir, "tasks", id)), 4, "备份里是升级之前的库");

    const db = new DatabaseSync(join(taskDir, DB_NAME), { readOnly: true });
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
      assert.deepEqual([names.length, names.includes("activity_record"), names.includes("stage_record")], [TABLE_NAMES.length, true, false]);
      // 每条阶段记录成了一条活动记录：编号、会话、调用编号、由谁、理由照抄；活动与节点是移到的那个阶段；开始的时刻与序号是那次移动的；
      // 前一条在后一条的时刻结束，最后一条还在进行。
      const rows = db.prepare("SELECT * FROM activity_record ORDER BY started_seq").all().map((row) => ({ ...row }));
      assert.deepEqual(rows, before.map((r, index) => ({
        record_id: r.record_id, task_id: id, session_id: r.session_id, run_id: r.run_id, call_id: r.call_id, actor: r.actor, activity: r.stage, node: r.stage, flow: r.flow,
        reason: r.reason, started_at: r.created_at, ended_at: before[index + 1]?.created_at ?? null, started_seq: r.event_seq, ended_seq: before[index + 1]?.event_seq ?? null,
      })));
      assert.deepEqual(db.prepare("SELECT seq, name, payload, actor, at FROM event ORDER BY seq").all().map((row) => ({ ...row })), eventsBefore, "事件一条不动");
    } finally {
      db.close();
    }

    // 读出来与升级之前一样：现在在澄清，最近一次是用户移的；调试页签的记录逐条相同。
    const last = before.at(-1)!;
    const stage = library.stageView(taskDir)!;
    assert.deepEqual([stage.current, stage.moved_by, stage.moved_at, stage.reason, stage.flow],
      ["clarifying", "user", clock.fromLocalText(last.created_at), "借期还没有问清楚。", "initial"]);
    assert.deepEqual(library.stageDebugView(taskDir).records, before.map((r) => ({
      from: r.from_stage, to: r.stage, actor: r.actor, reason: r.reason, run_id: r.run_id, session_id: r.session_id, at: clock.fromLocalText(r.created_at), flow: r.flow,
    })));

    const service = new Service(where.tasksDir, join(dataDir, "runs"), {}, { port: 1, registry });
    try {
      assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.status, t.supported]), [[id, "进行中", true]]);
      const page = service.taskPage(service.task(id)) as Record<string, any>;
      assert.equal(page.stage.current, "clarifying");
    } finally {
      await service.close();
    }
  } finally {
    registry?.close();
  }

  // 升级之后再移一次：经子进程调助手一侧真实的用户操作（移到整理建模）。接在后面，退回澄清的那一条随之结束。
  const more = spawnSync(process.execPath, [SAVE_MORE, taskDir, JSON.stringify([{ stage: "整理建模" }])],
    { encoding: "utf-8", env: { ...process.env, [TASKS_ROOT_ENV]: where.tasksDir } });
  assert.equal(more.status, 0, more.stderr);
  const records = library.stageDebugView(taskDir).records;
  assert.deepEqual(records.map((r) => [r.from, r.to]), [...before.map((r) => [r.from_stage, r.stage]), ["clarifying", "modeling"]]);
  assert.equal(library.stageView(taskDir)!.current, "modeling");
  assert.equal(existsSync(join(SAMPLES, STAGED, `${DB_NAME}-wal`)), false, "仓里的样本没有被打开过");
});
