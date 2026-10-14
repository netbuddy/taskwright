/**
 * 数据升级模块：只读地看出要升级什么；升级之前的备份（任务库的副本是完整的）；任务一个一个升并补写 task.json、记进登记表；
 * 一个任务没有做成不挡别的，记下原因，下次启动不再自动重试、明说要重试时再试；备份不成就一个都不动；报告与进度。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASK_DB_VERSION, TASK_JSON } from "../../agent/src/lib/schema.ts";
import { type UpgradeProgress, planUpgrade, reportText, runUpgrade, upgradeNeeded } from "../src/data_upgrade.ts";
import * as library from "../src/library.ts";
import { LOCK_NAME } from "../src/occupancy.ts";
import { ENV_SETTINGS_FILE } from "../src/product_settings.ts";
import { Service } from "../src/service.ts";
import { DATA_FORMAT, SERVICE_DB_NAME, ServiceDb, serviceDbPath } from "../src/service_db.ts";
import { readTaskJson } from "../src/task_json.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

type Data = { dataDir: string; tasksDir: string; knowledgeDir: string };

/** 一个新的数据目录，里面按 names 建几个任务（现在的格式），返回各任务的编号。 */
async function dataWith(names: string[]): Promise<Data & { ids: string[] }> {
  const dataDir = join(tmp, `data-${++n}`);
  const where = { dataDir, tasksDir: join(dataDir, "tasks"), knowledgeDir: join(dataDir, "knowledge") };
  const service = new Service(where.tasksDir, join(dataDir, "runs"), {}, { port: 1, knowledgeDir: where.knowledgeDir });
  const ids = names.map((name) => service.create({ task_type: "srs-authoring", task_name: name }).task_id as string);
  await service.close();
  return { ...where, ids };
}

/** 把一个任务变成上一版留下的样子：库没有编过版本号，没有 task.json。extra 是另外执行的 SQL（用来做一个升不了的库）。 */
function makeOld(where: Data, id: string, extra = ""): void {
  const db = new DatabaseSync(join(where.tasksDir, id, DB_NAME));
  db.exec(`${extra}; PRAGMA user_version = 0`);
  db.close();
  rmSync(join(where.tasksDir, id, TASK_JSON), { force: true });
}

const version = (where: Data, id: string) => library.taskDbVersion(join(where.tasksDir, id));

test("看：全新的数据目录没有要升级的，什么都不建；有上一版的任务、现在的任务、更新的任务与最早格式的任务时各归各类", async () => {
  const empty = { dataDir: join(tmp, "never"), tasksDir: join(tmp, "never", "tasks"), knowledgeDir: null };
  const none = planUpgrade(empty);
  assert.deepEqual([none.service.state, none.tasks, none.failed, none.newer, upgradeNeeded(none)], ["missing", [], [], [], false]);
  assert.equal(existsSync(empty.dataDir), false, "只看不建");

  const where = await dataWith(["旧甲", "旧乙", "现在的", "更新的", "最早的"]);
  const [a, b, , newer, ancient] = where.ids;
  makeOld(where, a);
  makeOld(where, b);
  makeOld(where, ancient, "ALTER TABLE item_version ADD COLUMN version_no INTEGER");
  const raw = new DatabaseSync(join(where.tasksDir, newer, DB_NAME));
  raw.exec(`PRAGMA user_version = ${TASK_DB_VERSION + 1}`);
  raw.close();
  writeFileSync(join(where.tasksDir, newer, TASK_JSON), JSON.stringify({ upgraded_by_version: "0.8.0" }), "utf-8");
  const plan = planUpgrade(where);
  assert.equal(plan.service.state, "missing");
  assert.deepEqual(plan.tasks.map((t) => [t.dir, t.task_id, t.name, t.version]).sort(), [[a, a, "旧甲", 0], [b, b, "旧乙", 0]].sort());
  assert.deepEqual(plan.newer.map((t) => [t.dir, t.written_by]), [[newer, "0.8.0"]]);
  assert.deepEqual(plan.failed, []);
  assert.equal(upgradeNeeded(plan), true);
  assert.deepEqual([version(where, a), existsSync(serviceDbPath(where.dataDir)), existsSync(join(where.dataDir, "backups"))], [0, false, false], "看完什么都没有变");
});

test("升级：每个任务升到现在的格式并补写 task.json、记进登记表；升级之前的备份里是旧的库、设置文件与知识库清单；报告写进文件；进度一项一项报", async () => {
  const where = await dataWith(["借阅系统", "退货流程"]);
  for (const id of where.ids) makeOld(where, id);
  const settings = join(where.dataDir, "my-settings.json");
  writeFileSync(settings, '{"version": 2}\n', "utf-8");
  const seen: UpgradeProgress[] = [];
  const { report, registry } = await runUpgrade(planUpgrade(where), { productVersion: "0.5.0", now: () => new Date(2026, 9, 8, 14, 5, 9),
    env: { [ENV_SETTINGS_FILE]: settings }, onProgress: (p) => seen.push({ ...p }) });
  try {
    assert.deepEqual([report.fatal, report.service, report.succeeded, report.failed, report.tasks.map((t) => [t.dir, t.from, t.to, t.ok, t.error])],
      [null, "created", 2, 0, [...where.ids].sort().map((id) => [id, 0, TASK_DB_VERSION, true, null])]);
    for (const [i, id] of where.ids.entries()) {
      assert.equal(version(where, id), TASK_DB_VERSION);
      const meta = readTaskJson(join(where.tasksDir, id))!;
      assert.deepEqual([meta.created_by_version, meta.task_type, meta.owner, meta.upgraded_by_version], [null, "srs-authoring", "local", "0.5.0"]);
      assert.ok(meta.created_at && meta.upgraded_at, "建立时刻取自任务库，升级时刻是这一次");
      assert.deepEqual([registry!.task(id)?.name, registry!.task(id)?.status, registry!.task(id)?.task_type, registry!.task(id)?.upgrade_error], [["借阅系统", "退货流程"][i], null, "srs-authoring", null]);
    }
    assert.deepEqual([registry!.meta("data_format"), registry!.meta("last_written_by")], [String(DATA_FORMAT), "0.5.0"]);
    // 备份：目录名是时刻加旧产品版本（上一版没有服务级库，写 pre-0.5）。
    const backup = join(where.dataDir, "backups", "20261008-140509-pre-0.5");
    assert.equal(report.backup?.dir, backup);
    assert.deepEqual(readdirSync(backup).sort(), ["knowledge", "my-settings.json", "tasks"]);
    assert.deepEqual(readdirSync(join(backup, "knowledge")), ["libraries.json"]);
    for (const id of where.ids) {
      assert.deepEqual(readdirSync(join(backup, "tasks", id)), [DB_NAME], "上一版的任务没有 task.json，备份里只有库");
      assert.equal(library.taskDbVersion(join(backup, "tasks", id)), 0, "备份的是升级之前的库");
    }
    assert.equal(report.backup?.files, 4);
    assert.ok(report.backup!.bytes > 0);
    // 报告：写进数据目录的 logs/，内容就是给人看的那一段。
    assert.equal(report.file, join(where.dataDir, "logs", "upgrade-20261008-140509.txt"));
    const text = readFileSync(report.file!, "utf-8");
    assert.equal(text, reportText(report));
    assert.match(text, /^数据升级报告（0\.5\.0）\n数据目录：.*\n任务目录：.*\n开始：.*结束：.*\n升级之前的备份：.*20261008-140509-pre-0\.5（4 个文件，/);
    assert.match(text, new RegExp(`任务 ${where.ids[0]}「借阅系统」：格式 0 升到 ${TASK_DB_VERSION}，成功，用了 \\d+ 毫秒`));
    assert.match(text, /合计：2 个任务，成功 2 个，没有做成 0 个。\n$/);
    // 报告写明这一次扫的是哪个任务目录。
    assert.ok(text.includes(`\n任务目录：${where.tasksDir}\n`), text);
    // 进度：一共四项（备份、数据目录、两个任务），做完的数一步步加到头，最后一条没有「正在做」。
    assert.deepEqual(seen.map((p) => [p.total, p.done]), [[4, 0], [4, 1], [4, 2], [4, 3], [4, 4]]);
    assert.deepEqual([seen[0].current, seen[1].current, seen[4].current], ["正在备份", "正在准备数据目录", null]);
    assert.match(seen[2].current!, /^正在升级任务「/);
  } finally {
    registry?.close();
  }
  const again = planUpgrade(where);
  assert.deepEqual([again.service.state, again.tasks, upgradeNeeded(again)], ["current", [], false], "升完再看，没有要升级的");
});

test("一个任务没有做成不挡别的：原因记进报告与登记表；下次看时它不在要升级的里面；明说重试时再试，做成了就清掉记的原因", async () => {
  const where = await dataWith(["好的", "被占着的", "升不了的"]);
  const [good, busy, broken] = where.ids;
  makeOld(where, good);
  makeOld(where, busy);
  makeOld(where, broken, "ALTER TABLE task DROP COLUMN domain_tag");
  // 别的、还活着的服务写的占用标记：进程号用本测试的父进程（活着，又不是本进程）。
  writeFileSync(join(where.tasksDir, busy, LOCK_NAME), JSON.stringify({ port: 8950, pid: process.ppid, host: hostname(), mode: "server" }), "utf-8");
  const first = await runUpgrade(planUpgrade(where), { productVersion: "0.5.0" });
  const outcome = (id: string, report = first.report) => report.tasks.find((t) => t.dir === id)!;
  try {
    assert.deepEqual([first.report.fatal, first.report.succeeded, first.report.failed], [null, 1, 2]);
    assert.deepEqual([outcome(good).ok, outcome(busy).error, outcome(busy).to], [true, "任务正在被另一个服务使用", 0]);
    assert.match(outcome(broken).error!, /较早的格式.*domain_tag/);
    assert.deepEqual([version(where, good), version(where, busy), version(where, broken)], [TASK_DB_VERSION, 0, 0]);
    assert.equal(first.registry!.taskByDir(busy)?.upgrade_error, "任务正在被另一个服务使用");
    assert.match(reportText(first.report), /没有升级成（任务正在被另一个服务使用）/);
    assert.match(reportText(first.report), /合计：3 个任务，成功 1 个，没有做成 2 个。\n没有做成的任务原样没动；要回到升级之前，把备份里的文件复制回去：/);
  } finally {
    first.registry?.close();
  }
  const plan = planUpgrade(where);
  assert.deepEqual([plan.tasks, plan.failed.map((t) => t.dir).sort(), upgradeNeeded(plan)], [[], [busy, broken].sort(), false], "记着失败的不再算要升级的");
  const idle = await runUpgrade(plan, { productVersion: "0.5.0" });
  idle.registry?.close();
  assert.deepEqual(idle.report.tasks, [], "不明说重试就不动它们");
  // 占用的服务退了：明说重试。
  rmSync(join(where.tasksDir, busy, LOCK_NAME));
  const second = await runUpgrade(planUpgrade(where), { productVersion: "0.5.0", retryFailed: true });
  try {
    assert.deepEqual([outcome(busy, second.report).ok, outcome(broken, second.report).ok], [true, false]);
    assert.deepEqual([second.registry!.taskByDir(busy)?.upgrade_error, version(where, busy)], [null, TASK_DB_VERSION]);
    assert.ok(second.registry!.taskByDir(broken)?.upgrade_error);
  } finally {
    second.registry?.close();
  }
});

test("备份不成就不升级：一个任务都不动，服务级库也不建，报告写明原因", async () => {
  const where = await dataWith(["甲"]);
  makeOld(where, where.ids[0]);
  writeFileSync(join(where.dataDir, "backups"), "这里本该是一个目录", "utf-8");
  const { report, registry } = await runUpgrade(planUpgrade(where), { productVersion: "0.5.0" });
  assert.equal(registry, null);
  assert.match(report.fatal!, /^升级之前的备份没有做成，所以没有升级：/);
  assert.deepEqual([report.tasks, report.backup, report.service], [[], null, null]);
  assert.deepEqual([version(where, where.ids[0]), existsSync(join(where.dataDir, SERVICE_DB_NAME))], [0, false]);
  assert.match(reportText(report), /\n没有升级：升级之前的备份没有做成/);
});

test("数据目录比这个程序新：不升级，说明是哪个版本写的", async () => {
  const where = await dataWith(["甲"]);
  makeOld(where, where.ids[0]);
  ServiceDb.open(where.dataDir, "0.9.0").close();
  const raw = new DatabaseSync(serviceDbPath(where.dataDir));
  raw.exec(`PRAGMA user_version = ${DATA_FORMAT + 1}`);
  raw.close();
  const plan = planUpgrade(where);
  assert.deepEqual([plan.service.state, plan.service.written_by], ["newer", "0.9.0"]);
  const { report, registry } = await runUpgrade(plan, { productVersion: "0.5.0" });
  assert.equal(registry, null);
  assert.equal(report.fatal, "这份数据由 0.9.0 写入，请用 0.9.0 或更新的版本打开。");
  assert.equal(version(where, where.ids[0]), 0);
});

test("任务库的备份是完整的：别的连接开着、最新的改动还只在日志文件里时，副本里也有", async () => {
  const where = await dataWith(["甲"]);
  const taskDir = join(where.tasksDir, where.ids[0]);
  const writer = new DatabaseSync(join(taskDir, DB_NAME));
  try {
    writer.exec("CREATE TABLE just_written (x); INSERT INTO just_written VALUES (1), (2), (3)");
    assert.ok(existsSync(join(taskDir, `${DB_NAME}-wal`)), "改动还在日志文件里");
    const target = join(where.dataDir, "copy", DB_NAME);
    mkdirSync(join(where.dataDir, "copy"), { recursive: true });
    const bytes = await library.backupTaskDb(taskDir, target);
    assert.ok(bytes > 0);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM just_written").get() as { n: number }).n, 3);
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n, 1);
    } finally {
      copy.close();
    }
  } finally {
    writer.close();
  }
});
