/**
 * 用各个旧版本自己写出来的样本任务目录（tests/fixtures/task_dirs/，由那里的 build.mjs 生成）验数据升级：
 * 每一份都升得到现在的格式，条目、修订、来源一条不少，来源的种类是现在的名字；升完服务能接手它、读得出内容，还能照常再存一次修订。
 * 样本只读不改：每例先把样本复制到临时的数据目录里再动。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASKS_ROOT_ENV, TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import { planUpgrade, runUpgrade } from "../src/data_upgrade.ts";
import * as library from "../src/library.ts";
import { Service } from "../src/service.ts";
import { readTaskJson } from "../src/task_json.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
const SAVE_MORE = join(ROOT, "agent", "tests", "fixtures", "save_more.mts");
const VERSIONS = ["0.4.0", "0.4.1", "0.4.2", "0.4.3"];
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

test("样本齐全：四个版本各一份，每份有任务库、docs 与 inputs，没有归档与会话文件", () => {
  assert.deepEqual(readdirSync(SAMPLES).filter((name) => /^\d/.test(name)).sort(), VERSIONS);
  for (const version of VERSIONS) assert.deepEqual(readdirSync(join(SAMPLES, version)).sort(), ["docs", "inputs", DB_NAME], version);
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
      assert.equal(now.tables, 16);
      assert.deepEqual([readTaskJson(taskDir)?.created_by_version, readTaskJson(taskDir)?.task_type, readTaskJson(taskDir)?.upgraded_by_version], [null, "srs-authoring", "0.5.0"]);
      assert.equal(library.taskDbVersion(join(report.backup!.dir, "tasks", id)), 0, "备份里是升级之前的库");

      // 服务接手它：列表里是能打开的任务，任务页读得出条目与材料。
      const service = new Service(where.tasksDir, join(dataDir, "runs"), {}, { port: 1, registry });
      try {
        assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.task_name, t.status, t.supported, t.item_count]), [[id, "图书借阅（样本）", "进行中", true, 4]]);
        const page = service.taskPage(service.task(id)) as Record<string, any>;
        assert.deepEqual(page.materials.map((m: any) => m.path), ["inputs/材料.md"]);
        assert.deepEqual(page.task_type_versions, { copied: null, current: 1 }, "上一版建的任务没有记任务类型说明是第几版");
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
