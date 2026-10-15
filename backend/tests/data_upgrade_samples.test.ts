/**
 * 用格式 8 的代码自己写出来的样本任务目录（tests/fixtures/task_dirs/，由那里的 build.mjs 生成）验数据升级：
 * 每一份都升得到现在的格式，条目、修订、来源、工作项、会话与拒绝记录一条不少；升完服务能接手它、读得出内容，还能照常再存一次修订。
 * 样本只读不改：每例先把样本复制到临时的数据目录里再动。格式 8 之前的格式不再升级（见 agent/tests/schema.test.ts）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TABLE_NAMES, TASKS_ROOT_ENV, TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import { planUpgrade, reportText, runUpgrade } from "../src/data_upgrade.ts";
import * as library from "../src/library.ts";
import { Service } from "../src/service.ts";
import { readTaskJson } from "../src/task_json.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
const SAVE_MORE = join(ROOT, "agent", "tests", "fixtures", "save_more.mts");
/** 两份样本、各自的任务编号与名字。 */
const SAMPLE_TASKS = { "format-8-a": ["TASK-SAMPLE-8A", "图书借阅（样本甲）"], "format-8-b": ["TASK-SAMPLE-8B", "图书借阅（样本乙）"] } as const;
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 库里的几个数：修订、条目、来源、工作项、工作项的会话、拒绝记录各几条，表几张。只读。 */
function facts(taskDir: string) {
  const db = new DatabaseSync(join(taskDir, DB_NAME), { readOnly: true });
  try {
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    return {
      revisions: count("SELECT COUNT(*) AS n FROM revision"), items: count("SELECT COUNT(DISTINCT item_id) AS n FROM item_version"),
      sources: count("SELECT COUNT(*) AS n FROM item_source"), workItems: count("SELECT COUNT(*) AS n FROM activity_record"),
      sessions: count("SELECT COUNT(*) AS n FROM work_item_session"), rejections: count("SELECT COUNT(*) AS n FROM tool_rejection"),
      // SQLite 自己的表（记录号自增计数用的 sqlite_sequence）不算。
      tables: count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'"),
    };
  } finally {
    db.close();
  }
}

/** 把一份样本复制进一个新的数据目录，返回数据目录的几个位置与任务目录。 */
function dataWithSample(sample: keyof typeof SAMPLE_TASKS) {
  const dataDir = join(tmp, sample);
  const where = { dataDir, tasksDir: join(dataDir, "tasks"), knowledgeDir: null };
  const id = SAMPLE_TASKS[sample][0];
  const taskDir = join(where.tasksDir, id);
  mkdirSync(where.tasksDir, { recursive: true });
  cpSync(join(SAMPLES, sample), taskDir, { recursive: true });
  return { where, id, taskDir };
}

test("样本齐全：两份格式 8 的样本，每份有任务库、docs 与 inputs，没有归档与会话文件；库是格式 8", () => {
  assert.deepEqual(readdirSync(SAMPLES).filter((name) => name.startsWith("format-")).sort(), Object.keys(SAMPLE_TASKS));
  for (const sample of Object.keys(SAMPLE_TASKS)) {
    assert.deepEqual(readdirSync(join(SAMPLES, sample)).sort(), ["docs", "inputs", DB_NAME], sample);
    assert.equal(library.taskDbVersion(join(SAMPLES, sample)), 8, sample);
  }
});

for (const sample of Object.keys(SAMPLE_TASKS) as (keyof typeof SAMPLE_TASKS)[]) {
  test(`${sample}：升到现在的格式，内容一条不少，原有的拒绝记录原因码为空；服务接手得了，还能再存一次修订`, async () => {
    const { where, id, taskDir } = dataWithSample(sample);
    const withWorkItem = sample === "format-8-a";
    const before = facts(taskDir);
    assert.deepEqual([before.revisions, before.items, before.sources, before.workItems, before.sessions, before.rejections],
      [1, 1, 1, withWorkItem ? 1 : 0, withWorkItem ? 1 : 0, withWorkItem ? 1 : 0], "样本里有一次修订、一页主题；甲另有一个工作项、一条会话与一条拒绝记录");

    const plan = planUpgrade(where);
    assert.deepEqual(plan.tasks.map((t) => [t.dir, t.task_id, t.name, t.version]), [[id, id, SAMPLE_TASKS[sample][1], 8]]);
    const { report, registry } = await runUpgrade(plan, { productVersion: "0.6.0" });
    try {
      assert.deepEqual([report.fatal, report.tasks.map((t) => [t.dir, t.from, t.to, t.ok, t.error, t.notes])], [null, [[id, 8, TASK_DB_VERSION, true, null, ["任务类型改名为「需求工程」：docs/task-definitions/requirements-engineering.json"]]]]);
      assert.match(reportText(report), /成功，用了 \d+ 毫秒/);
      const now = facts(taskDir);
      assert.deepEqual({ ...now, tables: undefined }, { ...before, tables: undefined }, "条目、修订、来源、工作项、会话与拒绝记录一条不少");
      assert.deepEqual([library.taskDbVersion(taskDir), now.tables], [TASK_DB_VERSION, TABLE_NAMES.length]);
      const db = new DatabaseSync(join(taskDir, DB_NAME), { readOnly: true });
      try {
        assert.deepEqual(db.prepare("SELECT reason_code, reason_codes FROM tool_rejection").all().map((row) => ({ ...row })),
          withWorkItem ? [{ reason_code: null, reason_codes: null }] : []);
      } finally {
        db.close();
      }
      assert.equal(readTaskJson(taskDir)?.upgraded_by_version, "0.6.0");
      // 任务类型改名：任务目录里的任务定义文件与库里的定义路径、定义快照里的执行方法与任务名都换成「需求工程」。
      assert.deepEqual(readdirSync(join(taskDir, "docs", "task-definitions")), ["requirements-engineering.json"]);
      const definition = readFileSync(join(taskDir, "docs", "task-definitions", "requirements-engineering.json"), "utf-8");
      assert.match(definition, /"任务名": "需求工程"/);
      assert.match(definition, /"执行方法": "\.pi\/skills\/requirements-engineering\/SKILL\.md"/);
      const row = (() => {
        const db = new DatabaseSync(join(taskDir, DB_NAME), { readOnly: true });
        try {
          return db.prepare("SELECT definition_path, definition_text FROM task").get() as { definition_path: string; definition_text: string };
        } finally {
          db.close();
        }
      })();
      assert.equal(row.definition_path, "docs/task-definitions/requirements-engineering.json");
      assert.equal(row.definition_text, definition, "快照与改过的定义文件逐字相同");
      assert.equal(library.taskDbVersion(join(report.backup!.dir, "tasks", id)), 8, "备份里是升级之前的库");
      // 甲：在那条会话里工作项照旧在澄清；乙：没有工作项，会话空闲。
      assert.equal(library.stageView(taskDir, "session-sample")!.current, withWorkItem ? "clarifying" : "idle");

      const service = new Service(where.tasksDir, join(where.dataDir, "runs"), {}, { port: 1, registry });
      try {
        assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.task_name, t.unavailable, t.supported, t.item_count]), [[id, SAMPLE_TASKS[sample][1], null, true, 1]]);
        const page = service.taskPage(service.task(id)) as Record<string, any>;
        assert.deepEqual(page.materials.map((m: any) => m.path), ["inputs/材料.md"]);
      } finally {
        await service.close();
      }
    } finally {
      registry?.close();
    }

    // 再存一次修订：经子进程调助手一侧真实的保存函数，引用材料里的原话，存一页业务说明。
    const more = spawnSync(process.execPath, [SAVE_MORE, taskDir, JSON.stringify([[{ op: "add", collection: "总体分析",
      fields: { 标题: "罚款", 它是什么: "逾期不还的，按馆里的规定罚款。", 状态: "在用" },
      sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "逾期不还的，按馆里的规定罚款。" }] }]])],
      { encoding: "utf-8", env: { ...process.env, [TASKS_ROOT_ENV]: where.tasksDir } });
    assert.equal(more.status, 0, more.stderr);
    assert.deepEqual(JSON.parse(more.stdout), [2], "存成了修订 2");
    assert.deepEqual([facts(taskDir).revisions, facts(taskDir).items, library.taskDbVersion(taskDir)], [2, 2, TASK_DB_VERSION]);
    assert.equal(existsSync(join(SAMPLES, sample, `${DB_NAME}-wal`)), false, "仓里的样本没有被打开过");
  });
}
