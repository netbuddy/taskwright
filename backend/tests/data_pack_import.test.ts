/**
 * 数据包的导入（src/data_pack.ts）：导出再导入到空的数据目录，内容逐项一致、修改时刻照原样；编号已经有任务在用时跳过或改编号；
 * 知识库不改编号的四种情形；整个包有一处不对就什么都不导入；一项出错不挡别的；暂存目录不被当成任务，遗留的在服务启动时清掉。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASKS_ROOT_ENV, TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import { IMPORTING_PREFIX, PACK_FORMAT, PACK_LIBRARIES, type PackLocations, exportPack, importPack, importText, sweepImportLeftovers } from "../src/data_pack.ts";
import { planUpgrade } from "../src/data_upgrade.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { rebaseSessionCwd } from "../src/pi_session.ts";
import { Service } from "../src/service.ts";
import { DATA_FORMAT, ServiceDb } from "../src/service_db.ts";
import { startService } from "../src/start.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";
import { dataWith, facts, locations, put, putArchive, repack, sha256, tree } from "./pack_stack.ts";

const logged = captureConsole();

const SAVE_MORE = join(ROOT, "agent", "tests", "fixtures", "save_more.mts");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);
const packFile = (name = "pack") => {
  const dir = fresh("out");
  mkdirSync(dir);
  return join(dir, `${name}.taskwright.zip`);
};

const MATERIAL = "# 图书借阅\n\n读者凭借书证借书。逾期不还的，按馆里的规定罚款。\n";
const MATERIAL_AT = Date.UTC(2026, 8, 19, 8, 30, 0);
const USE_CASE = [{ op: "add", collection: "功能用例",
  fields: { 用例名称: "缴纳罚款", 用例功能: "读者缴纳逾期罚款。", 参与者: ["读者"], 基本流程: ["读者查看罚款", "读者缴费"] },
  sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "逾期不还的，按馆里的规定罚款。", supports: [{ field: "用例功能" }] }] }];

const ANOTHER = [{ ...USE_CASE[0], fields: { ...USE_CASE[0].fields, 用例名称: "查询罚款", 用例功能: "读者查询逾期罚款。" } }];

/**
 * 经子进程调助手一侧真实的保存函数，在一个任务里存修订；返回各次存成的修订号。保存是按调用编号判重的：那个脚本头一组操作的
 * 调用编号总是同一个，所以对一个存过一次的任务再调，头一组得到的是原来那次修订（1），后一组才是新的一次。again 为真时带上后一组。
 */
function saveMore(where: PackLocations, id: string, again = false): number[] {
  const more = spawnSync(process.execPath, [SAVE_MORE, join(where.tasksDir, id), JSON.stringify(again ? [USE_CASE, ANOTHER] : [USE_CASE])],
    { encoding: "utf-8", env: { ...process.env, [TASKS_ROOT_ENV]: where.tasksDir } });
  assert.equal(more.status, 0, more.stderr);
  return JSON.parse(more.stdout);
}

/** 两个任务（甲有材料、一次修订与归档；乙没有对话过）、通用知识库里一份文档、另一个库里一份文档。 */
async function sampleData() {
  const where = await dataWith(fresh("data"), ["甲", "乙"]);
  const [a, b] = where.ids;
  put(join(where.tasksDir, a, "inputs", "材料.md"), MATERIAL, MATERIAL_AT);
  assert.deepEqual(saveMore(where, a), [1]);
  putArchive(where, a);
  mkdirSync(join(where.tasksDir, b, "inputs", "空目录"), { recursive: true });
  const store = new KnowledgeStore(where.knowledgeDir);
  await store.upload("general", "术语表.md", Buffer.from("借书证：读者在本馆借书的凭证。\n", "utf-8"), "glossary");
  const lib = store.create("售后规范");
  await store.upload(lib.id, "退款处理规范.md", Buffer.from("退款处理规范全文\n".repeat(30), "utf-8"), "standard");
  return { where, a, b, lib };
}

/** 起一个服务看这个数据目录（不带登记表），用完关掉。 */
async function withService<T>(where: PackLocations, body: (service: Service) => T | Promise<T>): Promise<T> {
  const service = new Service(where.tasksDir, where.runsDir, {}, { port: 1, knowledgeDir: where.knowledgeDir ?? undefined });
  try {
    return await body(service);
  } finally {
    await service.close();
  }
}

const registerOf = (dataDir: string) => {
  const db = ServiceDb.read(dataDir);
  try {
    return db ? db.tasks().map((row) => [row.task_id, row.name, row.owner, row.status, row.task_type, row.dir]) : null;
  } finally {
    db?.close();
  }
};
const leftovers = (where: PackLocations) => [where.tasksDir, where.runsDir, where.knowledgeDir!].flatMap((dir) => (existsSync(dir) ? readdirSync(dir) : []).filter((name) => name.startsWith(".")));

test("往返：整套导出再导入到一个空的数据目录，任务、归档、知识库逐个文件相同，登记表与知识库清单相同，修改时刻照原样", async () => {
  const { where, a, b, lib } = await sampleData();
  const file = packFile("all");
  await exportPack(where, { scope: "all", to: file, productVersion: "0.5.0" });

  const target = locations(fresh("target"));
  const registry = ServiceDb.open(target.dataDir, "0.5.0");
  let report;
  try {
    report = await importPack(target, { file, registry, productVersion: "0.5.0" });
  } finally {
    registry.close();
  }
  assert.equal(report.fatal, null);
  assert.deepEqual(report.tasks.map((t) => [t.task_id, t.name, t.outcome, t.new_id, t.reason, t.notes]).sort(),
    [[a, "甲", "imported", null, null, []], [b, "乙", "imported", null, null, []]].sort());
  assert.deepEqual(report.libraries.map((x) => [x.id, x.outcome, x.new_name, x.reason]).sort(),
    [["general", "imported", null, null], [lib.id, "imported", null, null]].sort());
  assert.deepEqual([report.pack.scope, report.pack.product_version], ["all", "0.5.0"]);

  // 任务目录：除任务库之外逐个文件相同；任务库比四种条数（副本与原库内容相同，文件头不同）。
  const without = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([name]) => name !== DB_NAME));
  for (const id of [a, b]) {
    assert.deepEqual(without(tree(join(target.tasksDir, id))), without(tree(join(where.tasksDir, id))), id);
    assert.deepEqual(facts(join(target.tasksDir, id)), facts(join(where.tasksDir, id)), id);
  }
  assert.deepEqual([facts(join(target.tasksDir, a)).revisions, facts(join(target.tasksDir, a)).items, facts(join(target.tasksDir, a)).sources], [1, 1, 1]);
  assert.deepEqual(tree(join(target.runsDir, a)), tree(join(where.runsDir, a)));
  assert.equal(Object.keys(tree(join(target.runsDir, a))).length, 4);
  assert.equal(existsSync(join(target.runsDir, b)), false, "没有归档的任务不建空的归档目录");
  assert.ok(statSync(join(target.tasksDir, b, "inputs", "空目录")).isDirectory(), "空目录也带过来了");
  // 知识库：两个库的文件相同，清单里的条目相同。
  for (const id of ["general", lib.id]) assert.deepEqual(tree(join(target.knowledgeDir, id)), tree(join(where.knowledgeDir, id)), id);
  assert.deepEqual(new KnowledgeStore(target.knowledgeDir).libraries(), new KnowledgeStore(where.knowledgeDir).libraries());
  // 登记表：两行与原来的相同。
  assert.deepEqual(registerOf(target.dataDir), registerOf(where.dataDir));
  // 修改时刻照原样。
  assert.equal(Math.floor(statSync(join(target.tasksDir, a, "inputs", "材料.md")).mtimeMs), MATERIAL_AT);
  // 暂存目录都删了；报告写进了日志目录。
  assert.deepEqual(leftovers(target), []);
  assert.equal(readFileSync(report.file!, "utf-8"), importText(report));
  assert.match(importText(report), new RegExp(`任务 ${a}「甲」：已导入\\n`));
  assert.match(importText(report), /合计：导入了 2 个任务、2 个知识库；因为已经存在而跳过 0 项；没有做成 0 项。/);
  assert.doesNotMatch(importText(report), /manifest|schema|进程|\bpi\b/);

  // 服务接手导入的任务：读得出条目与材料；进入过对话的材料导入之后仍然不能删除（靠修改时刻照原样）。
  const deletable = (service: Service) => (service.taskPage(service.task(a)) as Record<string, any>).materials.map((m: any) => [m.path, m.deletable]);
  assert.deepEqual(await withService(where, deletable), [["inputs/材料.md", false]]);
  await withService(target, (service) => {
    assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.task_name, t.supported, t.item_count, t.session_count]).sort(), [[a, "甲", true, 1, 1], [b, "乙", true, 0, 0]].sort());
    assert.deepEqual(deletable(service), [["inputs/材料.md", false]]);
  });
  // 导入的任务照常再存一次修订。
  assert.deepEqual(saveMore(target, a, true), [1, 2]);
});

test("编号已经有任务在用：缺省跳过并写明；改编号导入后两个任务并存，新编号的任务服务接手得了、能再存修订，归档原样", async () => {
  const { where, a } = await sampleData();
  const file = packFile(a);
  await exportPack(where, { scope: "task", taskId: a, to: file });
  const before = tree(where.tasksDir);

  const registry = ServiceDb.open(where.dataDir, "0.5.0");
  try {
    const skipped = await importPack(where, { file, registry });
    assert.deepEqual(skipped.tasks.map((t) => [t.task_id, t.outcome, t.new_id]), [[a, "skipped", null]]);
    assert.match(importText(skipped), new RegExp(`任务 ${a}「甲」：没有导入（已经有编号是 ${a} 的任务；要让两个任务并存，请用「改编号导入」）`));
    assert.deepEqual(tree(where.tasksDir), before, "跳过时数据目录原样");
    assert.deepEqual(leftovers(where), []);

    const report = await importPack(where, { file, registry, onConflict: "renumber" });
    const [row] = report.tasks;
    assert.deepEqual([row.task_id, row.outcome, row.reason], [a, "imported", null]);
    const id = row.new_id!;
    assert.match(id, /^TASK-\d{8}-[0-9A-F]{4}$/);
    assert.notEqual(id, a);
    assert.match(importText(report), new RegExp(`任务 ${a}「甲」：已导入，编号改成了 ${id}（原来的编号已经有任务在用）`));

    // 任务库里是新编号，条数与原来的相同；原来的任务没有动。
    assert.deepEqual(facts(join(where.tasksDir, id)), { ...facts(join(where.tasksDir, a)), task_id: id });
    assert.deepEqual(Object.fromEntries(Object.entries(tree(where.tasksDir)).filter(([name]) => name.startsWith(`${a}/`))), Object.fromEntries(Object.entries(before).filter(([name]) => name.startsWith(`${a}/`))));
    // 归档按新编号放，内容原样：会话文件第一行记的还是原来的任务目录。
    assert.deepEqual(tree(join(where.runsDir, id)), tree(join(where.runsDir, a)));
    const session = join(where.runsDir, id, "pi-sessions", "service", readdirSync(join(where.runsDir, id, "pi-sessions", "service"))[0]);
    assert.equal(JSON.parse(readFileSync(session, "utf-8").split("\n")[0]).cwd, join(where.tasksDir, a));
    // 登记表里两行。
    assert.deepEqual(registry.tasks().filter((t) => t.name === "甲").map((t) => [t.task_id, t.dir]).sort(), [[a, a], [id, id]].sort());

    // 服务接手它：任务目录与归档目录都是新编号的，会话列得出来。
    await withService(where, (service) => {
      const task = service.task(id);
      assert.deepEqual([task.dir, task.executor.sessions.dir], [join(where.tasksDir, id), join(where.runsDir, id, "pi-sessions", "service")]);
      assert.deepEqual(service.listTasks().filter((t) => t.task_name === "甲").map((t) => [t.task_id, t.supported, t.item_count, t.session_count]).sort(),
        [[a, true, 1, 1], [id, true, 1, 1]].sort());
    });
    // 续接这条会话之前服务会核对第一行并改成现在的任务目录（这里直接调那个核对，不起助手）。
    assert.equal(rebaseSessionCwd(session, join(where.tasksDir, id))?.[0], join(where.tasksDir, a));
    assert.equal(JSON.parse(readFileSync(session, "utf-8").split("\n")[0]).cwd, join(where.tasksDir, id));
    // 新编号的任务照常再存一次修订，原来的任务不受影响。
    assert.deepEqual(saveMore(where, id, true), [1, 2]);
    assert.deepEqual([facts(join(where.tasksDir, id)).revisions, facts(join(where.tasksDir, a)).revisions], [2, 1]);
  } finally {
    registry.close();
  }
});

test("知识库不改编号：没有同编号的照常导入；同编号而空的导入到它的位置上；同编号而有文档的跳过；重名的加「（导入）」", async () => {
  const { where, lib } = await sampleData();
  const file = packFile("all");
  await exportPack(where, { scope: "all", to: file });

  // 目标里：通用知识库有一份文档；有一个与包里的库重名的库；包里那个库的编号在目标里是一个空库。
  const target = locations(fresh("target"));
  const store = new KnowledgeStore(target.knowledgeDir);
  store.ensure();
  await store.upload("general", "本地的.md", Buffer.from("本地的文档\n", "utf-8"), "other");
  const same = store.create("售后规范");
  mkdirSync(join(target.knowledgeDir, lib.id, "files"), { recursive: true });
  writeFileSync(join(target.knowledgeDir, "libraries.json"), JSON.stringify({ version: 1, libraries: [...store.libraries(), { id: lib.id, name: "占位的空库", created_at: "2026-10-01T00:00:00+00:00" }] }));

  const report = await importPack(target, { file, onConflict: "renumber" });
  assert.deepEqual(report.libraries.map((x) => [x.id, x.outcome, x.new_name]).sort(), [["general", "skipped", null], [lib.id, "imported", "售后规范（导入）"]].sort());
  assert.equal(report.libraries.find((x) => x.id === "general")!.reason, "通用知识库已经存在而且里面有文档，包里通用知识库的 1 份文档没有导入；需要的话请在知识库页面把这些文档另行上传");
  assert.deepEqual(store.libraries().map((x) => [x.id, x.name]), [["general", "通用知识库"], [same.id, "售后规范"], [lib.id, "售后规范（导入）"]]);
  assert.deepEqual(tree(join(target.knowledgeDir, lib.id)), tree(join(where.knowledgeDir, lib.id)));
  assert.deepEqual(Object.keys(tree(join(target.knowledgeDir, "general"))).sort(), ["documents.json", "files/本地的.md"], "已有文档的通用知识库原样");
  assert.match(importText(report), /知识库 general「通用知识库」：没有导入（通用知识库已经存在而且里面有文档/);
  assert.match(importText(report), new RegExp(`知识库 ${lib.id}「售后规范」：已导入，名字与已有的知识库相同，改成了「售后规范（导入）」`));
  assert.match(importText(report), /「改编号导入」只对任务起作用。/);

  // 再导入一次：这个库现在有文档了，跳过；又一个数据目录里再重名一次，加序号。
  const again = await importPack(target, { file });
  assert.deepEqual(again.libraries.map((x) => [x.id, x.outcome]).sort(), [["general", "skipped"], [lib.id, "skipped"]].sort());
  assert.match(again.libraries.find((x) => x.id === lib.id)!.reason!, new RegExp(`已经有编号是 ${lib.id} 的知识库而且里面有文档，包里这个库的 1 份文档没有导入`));
  const third = locations(fresh("target"));
  const other = new KnowledgeStore(third.knowledgeDir);
  other.ensure();
  other.create("售后规范");
  other.create("售后规范（导入）");
  const numbered = await importPack(third, { file: await libraryPack(where, lib.id) });
  assert.deepEqual(numbered.libraries.map((x) => [x.id, x.outcome, x.new_name]), [[lib.id, "imported", "售后规范（导入）2"]]);
  // 全新的数据目录：通用知识库是空的，包里的通用知识库导入到它的位置上，名字不变。
  assert.deepEqual(Object.keys(tree(join(third.knowledgeDir, "general"))), []);
  const whole = await importPack(locations(fresh("target")), { file });
  assert.deepEqual(whole.libraries.map((x) => [x.id, x.outcome, x.new_name]).sort(), [["general", "imported", null], [lib.id, "imported", null]].sort());
  assert.deepEqual(Object.keys(tree(join(whole.data_dir, "knowledge", "general"))).sort(), ["documents.json", "files/术语表.md"]);
});

async function libraryPack(where: PackLocations, id: string): Promise<string> {
  const file = packFile(id);
  await exportPack(where, { scope: "library", libraryId: id, to: file });
  return file;
}

test("任务选用的知识库不在目标数据目录里：照常导入，报告里写一句", async () => {
  const { where, a, lib } = await sampleData();
  writeFileSync(join(where.tasksDir, a, "knowledge.json"), JSON.stringify({ version: 1, libraries: ["general", lib.id], notes: [] }));
  const file = packFile(a);
  await exportPack(where, { scope: "task", taskId: a, to: file });
  const target = locations(fresh("target"));
  const report = await importPack(target, { file });
  assert.deepEqual(report.tasks.map((t) => [t.outcome, t.notes]), [["imported", [`这个任务选用的知识库 ${lib.id} 不在这个数据目录里。`]]]);
  assert.match(importText(report), new RegExp(`\\n  这个任务选用的知识库 ${lib.id} 不在这个数据目录里。\\n`));
  assert.deepEqual(JSON.parse(readFileSync(join(target.tasksDir, a, "knowledge.json"), "utf-8")).libraries, ["general", lib.id], "选用的记录不改");
  assert.equal(registerOf(target.dataDir), null, "没有给登记表时不建服务级库");
});

test("整个包有一处不对就什么都不导入：不是数据包、比这个程序新、文件与清单文件对不上、校验值不符、路径不该有、范围不对", async () => {
  const { where, a } = await sampleData();
  const good = packFile("good");
  await exportPack(where, { scope: "all", to: good, productVersion: "9.9.9" });
  const target = locations(fresh("target"));
  const refused = async (file: string, pattern: RegExp, options: { only?: "task" | "library" } = {}) => {
    const report = await importPack(target, { file, ...options });
    assert.match(report.fatal ?? "", pattern, file);
    assert.deepEqual([report.tasks, report.libraries], [[], []]);
    assert.match(importText(report), /\n没有导入：/);
    // 目标数据目录里除了报告什么都没有：没有任务、没有知识库、没有留下暂存目录。
    for (const dir of [target.tasksDir, target.runsDir, target.knowledgeDir]) assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], dir);
  };
  const made = async (name: string, change: Parameters<typeof repack>[2]) => {
    const file = packFile(name);
    await repack(good, file, change);
    return file;
  };

  const text = packFile("text");
  writeFileSync(text, "这只是一段文字".repeat(20));
  await refused(text, /这个文件不是数据包，或者已经损坏/);
  await refused(join(tmp, "nowhere.zip"), /没有这个文件/);
  await refused(await made("no-manifest", (manifest) => Object.assign(manifest, { files: null })), /清单文件不对：没有任务、知识库或文件的清单/);

  const newer = /这个数据包比这个程序新。这份数据由 9\.9\.9 写入，请用 9\.9\.9 或更新的版本打开。/;
  await refused(await made("newer-pack", (manifest) => (manifest.pack_format = PACK_FORMAT + 1)), newer);
  await refused(await made("newer-data", (manifest) => (manifest.data_format = DATA_FORMAT + 1)), newer);
  await refused(await made("newer-task", (manifest) => (manifest.tasks[0].task_db_version = TASK_DB_VERSION + 1)), newer);

  await refused(await made("extra", (_, contents) => contents.set(`tasks/${a}/inputs/多出来的.md`, Buffer.from("x"))), /对不上：多了 tasks\/.*多出来的\.md/);
  await refused(await made("missing", (_, contents) => contents.delete(`tasks/${a}/inputs/材料.md`)), /对不上：少了 tasks\/.*材料\.md/);
  await refused(await made("length", (_, contents) => contents.set(`tasks/${a}/inputs/材料.md`, Buffer.from("短了"))), /材料\.md 的长度不同/);
  // 长度相同、内容不同：解出来的摘要与清单文件记的不符。
  await refused(await made("checksum", (_, contents) => contents.set(`tasks/${a}/inputs/材料.md`, Buffer.from(MATERIAL.replace("罚款", "奖励"), "utf-8"))),
    /文件 tasks\/.*材料\.md 与清单文件记的校验值不符。整个包没有导入。/);
  for (const path of ["etc/passwd", `tasks/${a}/../../outside.txt`, "tasks/TASK-OTHER/x.md", `tasks/${a}`, "/tasks/x/y", `runs/${a}/a\\b`, "service/other.json"]) {
    await refused(await made("path", (manifest) => manifest.files.push({ path, bytes: 1, sha256: sha256("x"), mtime_ms: 0 })), /数据包里有不该有的路径/);
  }
  await refused(await made("bad-id", (manifest) => (manifest.tasks[0].task_id = "../evil")), /任务清单里有一项写得不对/);
  await refused(await made("bad-library", (manifest) => (manifest.libraries[0].id = "../evil")), /知识库清单里有一项写得不对/);
  await refused(good, /这里只能导入范围是一个任务的数据包，这个包的范围是整套。范围是整套的包请用命令行导入。/, { only: "task" });
  await refused(good, /这里只能导入范围是一个知识库的数据包/, { only: "library" });
});

test("一个任务没有导入成不挡别的：它的任务库与清单文件对不上，另一个照常导入，它什么都没有留下", async () => {
  const { where, a, b } = await sampleData();
  const good = packFile("good");
  await exportPack(where, { scope: "all", to: good });
  // 把乙的任务库换成甲的（清单文件里的摘要与长度跟着改，包本身是自洽的）。
  const file = packFile("swapped");
  await repack(good, file, (manifest, contents) => {
    const db = contents.get(`tasks/${a}/${DB_NAME}`)!;
    contents.set(`tasks/${b}/${DB_NAME}`, db);
    Object.assign(manifest.files.find((f) => f.path === `tasks/${b}/${DB_NAME}`)!, { bytes: db.length, sha256: sha256(db) });
  });
  const target = locations(fresh("target"));
  const report = await importPack(target, { file });
  assert.equal(report.fatal, null);
  assert.deepEqual(report.tasks.map((t) => [t.task_id, t.outcome, t.reason]).sort(), [[a, "imported", null], [b, "failed", "数据包里这个任务的任务库与清单文件对不上"]].sort());
  assert.deepEqual(readdirSync(target.tasksDir), [a]);
  assert.match(importText(report), new RegExp(`任务 ${b}「乙」：没有导入成（数据包里这个任务的任务库与清单文件对不上）`));
  assert.match(importText(report), /没有做成 1 项。/);
});

test("暂存目录不被当成任务；上一次导入没有做完留下的暂存目录在服务启动时清掉，别的名字不碰", async () => {
  const { where, a } = await sampleData();
  // 造出导入到一半的样子：三个根目录下各一个暂存目录，任务的那个里面有一个完整的任务目录。
  const name = `${IMPORTING_PREFIX}20261009-101500-abc123`;
  const half = join(where.tasksDir, name, "tasks", "TASK-HALF");
  mkdirSync(join(half, ".."), { recursive: true });
  spawnSync("cp", ["-r", join(where.tasksDir, a), half]);
  mkdirSync(join(where.runsDir, name, "TASK-HALF"), { recursive: true });
  mkdirSync(join(where.knowledgeDir, name, "lib-00000000"), { recursive: true });
  await withService(where, (service) => assert.ok(!service.listTasks().some((t) => String(t.task_id).includes("HALF") || String(t.task_id).startsWith("."))));
  assert.deepEqual(planUpgrade(where).tasks, []);

  // 名字像而不是目录的、名字不是这个开头的，都不碰。
  writeFileSync(join(where.tasksDir, `${IMPORTING_PREFIX}file`), "x");
  mkdirSync(join(where.tasksDir, ".other"));
  const copy = { ...where };
  assert.deepEqual(sweepImportLeftovers(copy).sort(), [join(where.tasksDir, name), join(where.runsDir, name), join(where.knowledgeDir, name)].sort());
  assert.deepEqual(readdirSync(where.tasksDir).filter((one) => one.startsWith(".")).sort(), [`${IMPORTING_PREFIX}file`, ".other"].sort());
  assert.ok(existsSync(join(where.tasksDir, a, DB_NAME)));
  assert.deepEqual(sweepImportLeftovers(copy), []);

  // 服务启动时做这一步，并在日志里写一句。
  mkdirSync(join(where.runsDir, name));
  const started = await startService({ port: 0, mode: "server", host: "127.0.0.1", profile: "fake", ownProcess: false, data: where.dataDir });
  try {
    assert.equal(existsSync(join(where.runsDir, name)), false);
    assert.ok(logged.some((line) => line.includes("清掉了上一次导入数据包没有做完留下的暂存目录") && line.includes(name)));
  } finally {
    await started.stop();
  }
});
