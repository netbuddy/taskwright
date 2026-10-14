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
import { planUpgrade, reportText, runUpgrade } from "../src/data_upgrade.ts";
import * as library from "../src/library.ts";
import { Service } from "../src/service.ts";
import { readTaskJson } from "../src/task_json.ts";
import { taskStatus } from "../src/task_status.ts";
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
      // SQLite 自己的表（记录号自增计数用的 sqlite_sequence）不算。
      tables: count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'"),
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
      assert.deepEqual([report.fatal, report.tasks.map((t) => [t.dir, t.from, t.to, t.ok, t.error, t.notes])], [null, [[id, 0, TASK_DB_VERSION, true, null, ["补了总体分析集合", "保留了早期的领域说明集合"]]]]);
      // 早先的任务定义里没有「总体分析」：升级时照现在的任务类型模板补上，之后与新任务一样有阶段，任务状况不再是空的。
      assert.notEqual(taskStatus(taskDir), null);
      assert.match(reportText(report), /成功，用了 \d+ 毫秒；补了总体分析集合/);
      const now = facts(taskDir);
      assert.deepEqual([library.taskDbVersion(taskDir), now.revisions, now.items, now.sources], [TASK_DB_VERSION, 3, 4, 4]);
      assert.deepEqual(now.kinds, { 文档原文: 2, 助手补充: 1, 条目: 1 }, "来源的种类都是现在的名字");
      assert.equal(now.tables, TABLE_NAMES.length);
      assert.deepEqual([readTaskJson(taskDir)?.created_by_version, readTaskJson(taskDir)?.task_type, readTaskJson(taskDir)?.upgraded_by_version], [null, "srs-authoring", "0.5.0"]);
      assert.equal(library.taskDbVersion(join(report.backup!.dir, "tasks", id)), 0, "备份里是升级之前的库");

      // 服务接手它：列表里是能打开的任务，任务页读得出条目与材料。
      const service = new Service(where.tasksDir, join(dataDir, "runs"), {}, { port: 1, registry });
      try {
        assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.task_name, t.unavailable, t.supported, t.item_count]), [[id, "图书借阅（样本）", null, true, 4]]);
        const page = service.taskPage(service.task(id)) as Record<string, any>;
        assert.deepEqual(page.materials.map((m: any) => m.path), ["inputs/材料.md"]);
        assert.deepEqual(page.task_type_versions, { copied: null, current: 4 }, "上一版建的任务没有记任务类型说明是第几版");
      } finally {
        await service.close();
      }
    } finally {
      registry?.close();
    }

    // 再存一次修订：经子进程调助手一侧真实的保存函数，引用材料里的原话。补上「总体分析」之后这是有阶段的任务，
    // 不属于工作项的会话里只能立主题页、记问题，所以存的是一页业务说明（补上的集合确实能写）。
    const more = spawnSync(process.execPath, [SAVE_MORE, taskDir, JSON.stringify([[{ op: "add", collection: "总体分析",
      fields: { 标题: "罚款", 它是什么: "逾期不还的，按馆里的规定罚款。", 状态: "在用" },
      sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "逾期不还的，按馆里的规定罚款。" }] }]])],
      { encoding: "utf-8", env: { ...process.env, [TASKS_ROOT_ENV]: where.tasksDir } });
    assert.equal(more.status, 0, more.stderr);
    assert.deepEqual(JSON.parse(more.stdout), [4], "存成了修订 4");
    const after = facts(taskDir);
    assert.deepEqual([after.revisions, after.items, after.sources, library.taskDbVersion(taskDir)], [4, 5, 5, TASK_DB_VERSION]);
    assert.equal(existsSync(join(SAMPLES, version, `${DB_NAME}-wal`)), false, "仓里的样本没有被打开过");
  });
}

test("0.5.0 建的任务：阶段记录升成一个需求分析的工作项，那条旧会话属于它；现在的阶段、最近一次移动与每一次移动读出来与升级之前一样；服务接手得了，还能再换一站", async () => {
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
  ], "样本里是四次移动，最后退回了澄清；那一版的流程键是 initial");

  const plan = planUpgrade(where);
  assert.deepEqual(plan.tasks.map((t) => [t.dir, t.task_id, t.version]), [[id, id, 4]]);
  const { report, registry } = await runUpgrade(plan, { productVersion: "0.6.0" });
  try {
    assert.deepEqual([report.fatal, report.tasks.map((t) => [t.dir, t.from, t.to, t.ok, t.error])], [null, [[id, 4, TASK_DB_VERSION, true, null]]]);
    assert.equal(library.taskDbVersion(taskDir), TASK_DB_VERSION);
    assert.equal(library.taskDbVersion(join(report.backup!.dir, "tasks", id)), 4, "备份里是升级之前的库");

    const db = new DatabaseSync(join(taskDir, DB_NAME), { readOnly: true });
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'").all() as { name: string }[]).map((row) => row.name);
      assert.deepEqual([names.length, names.includes("activity_record"), names.includes("stage_record")], [TABLE_NAMES.length, true, false]);
      // 四条阶段记录都在需求分析里：并成一个工作项。编号、会话、调用编号、由谁、理由、启动的时刻与序号是最早那一次移动的；
      // 现在的活动与所在的一站是最晚那一次移到的；流程键改写成 analysis；没有结束的两列。
      const rows = db.prepare("SELECT * FROM activity_record ORDER BY started_seq").all().map((row) => ({ ...row }));
      const first = before[0], latest = before.at(-1)!;
      assert.deepEqual(rows, [{
        record_id: first.record_id, task_id: id, session_id: first.session_id, run_id: first.run_id, call_id: first.call_id, actor: first.actor,
        activity: latest.stage, node: latest.stage, flow: "analysis", reason: first.reason, started_at: first.created_at, started_seq: first.event_seq, scope: null,
      }]);
      // 那条旧会话挂在这个工作项上。
      assert.deepEqual(db.prepare("SELECT session_id, record_id, attached_at FROM work_item_session").all().map((row) => ({ ...row })),
        [{ session_id: "session-sample", record_id: first.record_id, attached_at: latest.created_at }]);
      assert.deepEqual(db.prepare("SELECT seq, name, payload, actor, at FROM event ORDER BY seq").all().map((row) => ({ ...row })), eventsBefore, "事件一条不动");
    } finally {
      db.close();
    }

    // 在那条旧会话里读出来与升级之前一样：现在在澄清，最近一次是用户移的（取自早先的移动事件）；调试页签的记录逐条相同，都是换站。
    const last = before.at(-1)!;
    const stage = library.stageView(taskDir, "session-sample")!;
    assert.deepEqual([stage.current, stage.moved_by, stage.reason, stage.flow, stage.work_item?.name, stage.work_item?.record_id],
      ["clarifying", "user", "借期还没有问清楚。", "analysis", "需求分析", before[0].record_id]);
    const eventAt = new Map((eventsBefore as { seq: number; at: string }[]).map((one) => [Number(one.seq), one.at]));
    assert.equal(stage.moved_at, clock.fromLocalText(eventAt.get(Number(last.event_seq))!));
    assert.deepEqual(library.stageDebugView(taskDir).records, before.map((r) => ({
      from: r.from_stage, to: r.stage, actor: r.actor, reason: r.reason, run_id: r.run_id, session_id: r.session_id, at: clock.fromLocalText(eventAt.get(Number(r.event_seq))!), flow: "analysis",
      kind: "move", record_id: null,
    })));
    // 别的会话不属于这个工作项：空闲。
    assert.equal(library.stageView(taskDir, "sess-new")!.current, "idle");

    const service = new Service(where.tasksDir, join(dataDir, "runs"), {}, { port: 1, registry });
    try {
      assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.unavailable, t.supported]), [[id, null, true]]);
      // 任务详情不属于哪条会话：任务一级没有「现在的阶段」，按自由讨论的会话算是空闲；工作项在任务状况里列着。
      const page = service.taskPage(service.task(id)) as Record<string, any>;
      assert.equal(page.stage.current, "idle");
    } finally {
      await service.close();
    }
  } finally {
    registry?.close();
  }

  // 升级之后在那条旧会话里再换一站：经子进程调助手一侧真实的用户操作（移到整理建模）。接在后面，工作项还是那一个。
  const more = spawnSync(process.execPath, [SAVE_MORE, taskDir, JSON.stringify([{ stage: "整理建模" }]), "session-sample"],
    { encoding: "utf-8", env: { ...process.env, [TASKS_ROOT_ENV]: where.tasksDir } });
  assert.equal(more.status, 0, more.stderr);
  const records = library.stageDebugView(taskDir).records;
  assert.deepEqual(records.map((r) => [r.from, r.to]), [...before.map((r) => [r.from_stage, r.stage]), ["clarifying", "modeling"]]);
  assert.deepEqual([library.stageView(taskDir, "session-sample")!.current, records.at(-1)!.kind, records.at(-1)!.record_id], ["modeling", "move", before[0].record_id]);
  assert.equal(existsSync(join(SAMPLES, STAGED, `${DB_NAME}-wal`)), false, "仓里的样本没有被打开过");
});
