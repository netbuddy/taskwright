/**
 * 旧格式的数据包：用格式 8 的代码写出来的样本任务目录（tests/fixtures/task_dirs/）打成包——旧包是
 * 现在的程序从一个还没有升级的数据目录导出的。导入时先在暂存位置里升级再进位，内容一条不少；「数据包升级」把旧包升成新包；
 * 升不了的任务不挡别的；比这个程序新的包，导入与数据包升级都拒绝。样本只读不改：每例先复制到临时的数据目录里。
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import { PACK_FORMAT, PackError, exportPack, importPack, importText, upgradePack, upgradePackText } from "../src/data_pack.ts";
import { Service } from "../src/service.ts";
import { ServiceDb } from "../src/service_db.ts";
import { readTaskJson } from "../src/task_json.ts";
import { ROOT, asFormat8, captureConsole, tempDir } from "./helpers.ts";
import { dataWith, facts, locations, readPack, repack } from "./pack_stack.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
/** 两份格式 8 的样本（tests/fixtures/task_dirs/）与各自的任务编号、名字。 */
const VERSIONS = ["format-8-a", "format-8-b"];
const SAMPLE_TASKS: Record<string, [string, string]> = { "format-8-a": ["TASK-SAMPLE-8A", "图书借阅（样本甲）"], "format-8-b": ["TASK-SAMPLE-8B", "图书借阅（样本乙）"] };
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);
const packFile = (name: string) => {
  const dir = fresh("out");
  mkdirSync(dir);
  return join(dir, `${name}.taskwright.zip`);
};
const idOf = (sample: string) => SAMPLE_TASKS[sample][0];
const nameOf = (sample: string) => SAMPLE_TASKS[sample][1];

/** 一个还没有升级的数据目录，里面是 versions 这几份样本（任务目录用样本名作名字），整套导出成一个包。 */
async function oldPack(versions: string[]): Promise<string> {
  const where = locations(fresh("old"));
  mkdirSync(where.tasksDir, { recursive: true });
  for (const version of versions) cpSync(join(SAMPLES, version), join(where.tasksDir, version), { recursive: true });
  const file = packFile("old");
  await exportPack(where, { scope: "all", to: file, productVersion: "0.5.0" });
  return file;
}

for (const version of VERSIONS) {
  test(`${version} 打成的旧包：导入时先升级再进位，条目、修订、来源一条不少，服务接手得了`, async () => {
    const id = idOf(version);
    const file = await oldPack([version]);
    assert.deepEqual(readPack(file).manifest.tasks.map((t) => [t.task_id, t.dir, t.task_db_version]), [[id, version, 8]], "包里是格式 8 的任务库");

    const target = locations(fresh("target"));
    const registry = ServiceDb.open(target.dataDir, "0.5.0");
    try {
      const report = await importPack(target, { file, registry, productVersion: "0.5.0" });
      assert.equal(report.fatal, null);
      assert.deepEqual(report.tasks.map((t) => [t.task_id, t.outcome, t.upgraded_from, t.reason]), [[id, "imported", 8, null]]);
      assert.match(importText(report), new RegExp(`任务 ${id}「${nameOf(version)}」：已导入，导入之前先把它的数据从格式 8 升到了现在的格式\\n`));
      const now = facts(join(target.tasksDir, id));
      assert.deepEqual([now.task_id, now.version, now.revisions, now.items, now.sources], [id, TASK_DB_VERSION, 1, 1, 1]);
      // 升级时补写了 task.json；登记表里有它；升级用的服务级库、报告与暂存目录都没有留在目标里。
      assert.deepEqual([readTaskJson(join(target.tasksDir, id))?.task_type, readTaskJson(join(target.tasksDir, id))?.upgraded_by_version], ["srs-authoring", "0.5.0"]);
      assert.deepEqual(registry.tasks().map((t) => [t.task_id, t.name, t.owner, t.task_type, t.dir]), [[id, nameOf(version), "local", "srs-authoring", id]]);
      assert.deepEqual(readdirSync(target.tasksDir), [id]);
      assert.equal(existsSync(join(target.dataDir, "backups")), false, "导入时的升级不在目标数据目录里留备份");

      const service = new Service(target.tasksDir, target.runsDir, {}, { port: 1, registry: null });
      try {
        assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.task_name, t.unavailable, t.supported, t.item_count]), [[id, nameOf(version), null, true, 1]]);
        assert.deepEqual((service.taskPage(service.task(id)) as Record<string, any>).materials.map((m: any) => m.path), ["inputs/材料.md"]);
      } finally {
        await service.close();
      }
    } finally {
      registry.close();
    }
    assert.equal(existsSync(join(SAMPLES, version, `${DB_NAME}-wal`)), false, "仓里的样本没有被打开过");
  });
}

test("数据包升级：两份格式 8 的样本在一个旧包里，升成一个新包；新包里都是现在的格式，导入时不用再升级；原来的包不动", async () => {
  const file = await oldPack(VERSIONS);
  const before = readFileSync(file);
  const to = packFile("new");
  const result = await upgradePack(file, to, { productVersion: "0.5.0" });
  assert.deepEqual(result.tasks.map((t) => [t.dir, t.from, t.to, t.ok]), VERSIONS.map((v) => [idOf(v), 8, TASK_DB_VERSION, true]));
  assert.deepEqual([result.from_version, result.written.file, result.written.tasks.length], ["0.5.0", to, 2]);
  assert.deepEqual(readFileSync(file), before, "原来的包原样");

  const { manifest, names } = readPack(to);
  assert.deepEqual([manifest.pack_format, manifest.scope, manifest.tasks.map((t) => [t.task_id, t.task_db_version])], [PACK_FORMAT, "all", VERSIONS.map((v) => [idOf(v), TASK_DB_VERSION])]);
  assert.ok(VERSIONS.every((v) => names.includes(`tasks/${idOf(v)}/task.json`) && names.includes(`tasks/${idOf(v)}/inputs/材料.md`)));
  assert.ok(!names.some((name) => name.includes("backups") || name.includes("service.sqlite") || name.startsWith("logs/")), "升级时用的东西不进新包");

  const text = upgradePackText(result);
  assert.match(text, new RegExp(`^数据包升级（原来的包由 0\\.5\\.0 导出）\\n任务 TASK-SAMPLE-8A「图书借阅（样本甲）」：格式 8 升到 ${TASK_DB_VERSION}，成功\\n`));
  assert.match(text, /数据包已经写好：.*new\.taskwright\.zip/);

  const target = locations(fresh("target"));
  const report = await importPack(target, { file: to });
  assert.deepEqual(report.tasks.map((t) => [t.task_id, t.outcome, t.upgraded_from]), VERSIONS.map((v) => [idOf(v), "imported", null]));
  for (const v of VERSIONS) assert.deepEqual([facts(join(target.tasksDir, idOf(v))).version, facts(join(target.tasksDir, idOf(v))).items], [TASK_DB_VERSION, 1]);

  // 已经是现在格式的包再升一次：没有要升级的，照样写出新包。
  const again = await upgradePack(to, packFile("again"));
  assert.deepEqual(again.tasks, []);
  assert.match(upgradePackText(again), /任务：没有要升级的，新的包与原来的内容相同/);
  // 目标文件已经在：不覆盖。
  await assert.rejects(() => upgradePack(file, to), (error: unknown) => error instanceof PackError && error.code === "exists");
});

test("旧包里有一个升不了的任务：它没有导入成并写明原因，别的照常升级、导入；数据包升级把它原样带进新包", async () => {
  // 一个现在格式的数据目录里的两个任务，各自退回上一版的样子；其中一个再弄成升不了的。
  const where = await dataWith(fresh("data"), ["升得了", "升不了"]);
  const [good, broken] = where.ids;
  for (const id of [good, broken]) asFormat8(join(where.tasksDir, id));
  // 升不了的那一个没有工具拒绝表：8 升 9 那一步给它加列加不成。
  const db = new DatabaseSync(join(where.tasksDir, broken, DB_NAME));
  db.exec("DROP TABLE tool_rejection");
  db.close();
  const file = packFile("mixed");
  await exportPack(where, { scope: "all", to: file });
  const target = locations(fresh("target"));
  const report = await importPack(target, { file });
  assert.equal(report.fatal, null);
  const byId = new Map(report.tasks.map((t) => [t.task_id, t]));
  assert.deepEqual([byId.get(good)!.outcome, byId.get(good)!.upgraded_from], ["imported", 8]);
  assert.deepEqual([byId.get(broken)!.outcome, byId.get(broken)!.upgraded_from], ["failed", null]);
  assert.match(byId.get(broken)!.reason!, /^这个任务的数据是上一版的格式，升级没有做成：.*no such table: tool_rejection/);
  assert.deepEqual(readdirSync(target.tasksDir), [good]);

  const to = packFile("upgraded");
  const result = await upgradePack(file, to);
  assert.deepEqual(result.tasks.map((t) => [t.dir, t.ok]).sort(), [[good, true], [broken, false]].sort());
  assert.deepEqual(readPack(to).manifest.tasks.map((t) => [t.task_id, t.task_db_version]).sort(), [[good, TASK_DB_VERSION], [broken, 8]].sort());
  assert.match(upgradePackText(result), new RegExp(`任务 ${broken}「升不了」：格式 8，没有升级成（.*），原样带进了新的包`));
});

test("比这个程序新的包：导入与数据包升级都拒绝，话里写着是哪个版本写的", async () => {
  const where = await dataWith(fresh("data"), ["新的"]);
  const good = packFile("good");
  await exportPack(where, { scope: "all", to: good, productVersion: "0.7.0" });
  const newer = packFile("newer");
  await repack(good, newer, (manifest) => (manifest.tasks[0].task_db_version = TASK_DB_VERSION + 1));
  const sentence = /这个数据包比这个程序新。这份数据由 0\.7\.0 写入，请用 0\.7\.0 或更新的版本打开。/;
  assert.match((await importPack(locations(fresh("target")), { file: newer })).fatal ?? "", sentence);
  const to = packFile("to");
  await assert.rejects(() => upgradePack(newer, to), (error: unknown) => error instanceof PackError && error.code === "refused" && sentence.test(error.message));
  assert.equal(existsSync(to), false);
});
