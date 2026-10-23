/**
 * 数据包的导出（src/data_pack.ts）：三个范围；清单文件与包里的条目对得上、摘要与修改时刻照原文件；任务库是完整的副本；
 * 不该带的文件不带；读不出编号的目录、符号链接写进「没有带」；还没有升级的数据目录也能导出；目标文件已经在时不覆盖。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import { insertMaterial } from "../../agent/src/lib/material_db.ts";
import { MANIFEST_NAME, PACK_FORMAT, PACK_LIBRARIES, PACK_REGISTER, PackError, README_NAME, SETTINGS_EXCERPT_NAME, diagnosticPackName, exportPack, exportText, upgradePack, upgradePackText } from "../src/data_pack.ts";
import { settingsExcerpt } from "../src/product_settings.ts";
import { PDFJS_VERSION } from "../src/pdf_projection.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { LOCK_NAME } from "../src/occupancy.ts";
import { DATA_FORMAT } from "../src/service_db.ts";
import { ROOT, captureConsole, keepGeneral, tempDir } from "./helpers.ts";
import { dataWith, facts, locations, put, putArchive, readPack, sha256 } from "./pack_stack.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);

async function failure(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body();
  } catch (error) {
    return error as Error;
  }
  throw new Error("本来应当报错");
}

/** 两个任务（甲有材料与归档，乙没有对话过）与一个有一份文档的知识库。 */
async function sampleData() {
  const where = await dataWith(fresh("data"), ["甲", "乙"]);
  const [a, b] = where.ids;
  const materialAt = Date.UTC(2026, 8, 19, 8, 30, 0);
  put(join(where.tasksDir, a, "inputs", "售后退款 业务说明.md"), "退款须在七天内处理完毕。\n".repeat(40), materialAt);
  put(join(where.tasksDir, a, "inputs", "图.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), materialAt);
  const archive = putArchive(where, a);
  keepGeneral(where.knowledgeDir);
  const store = new KnowledgeStore(where.knowledgeDir);
  const lib = store.create("售后规范");
  await store.upload(lib.id, "退款处理规范.md", Buffer.from("退款处理规范全文\n".repeat(30), "utf-8"), "standard");
  return { where, a, b, lib, archive, materialAt };
}

test("整套导出：清单文件记着版本、范围、任务与知识库；包里的条目与文件清单一一对应，摘要与修改时刻照原文件", async () => {
  const { where, a, b, lib, archive, materialAt } = await sampleData();
  // 不该带的：占用标记（一个已经不在的服务留下的）、上传到一半的暂存目录、临时文件、任务库旁边的日志文件。
  writeFileSync(join(where.tasksDir, a, LOCK_NAME), JSON.stringify({ port: 1, pid: 999_999_999, host: hostname() }));
  put(join(where.tasksDir, a, ".uploading", "half.docx"), "半截");
  put(join(where.tasksDir, a, "inputs", "half.md.123.tmp"), "半截");
  put(join(where.tasksDir, a, `${DB_NAME}-wal`), "");
  mkdirSync(join(where.tasksDir, b, "inputs", "空目录"), { recursive: true });

  const to = join(fresh("out"), "all.taskwright.zip");
  mkdirSync(join(to, ".."), { recursive: true });
  // 带上事件归档：这一例核对归档原样进包（缺省不带事件归档的情形见 data_pack_events.test.ts）。
  const result = await exportPack(where, { withMaterials: true, scope: "all", to, productVersion: "0.5.0", withEvents: true });
  assert.deepEqual([result.file, result.bytes, result.scope, result.skipped], [to, statSync(to).size, "all", []]);
  assert.deepEqual(readdirSync(join(to, "..")), ["all.taskwright.zip"], "没有留下临时文件");

  const { manifest, names, content } = readPack(to);
  assert.deepEqual([manifest.pack_format, manifest.product_version, manifest.data_format, manifest.task_db_version, manifest.scope],
    [PACK_FORMAT, "0.5.0", DATA_FORMAT, TASK_DB_VERSION, "all"]);
  assert.match(manifest.exported_at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(manifest.tasks.map((t) => [t.task_id, t.name, t.owner, t.dir, t.task_db_version, t.in_use, t.assistant_working]).sort(),
    [[a, "甲", "local", a, TASK_DB_VERSION, false, false], [b, "乙", "local", b, TASK_DB_VERSION, false, false]].sort());
  assert.deepEqual(manifest.libraries.map((one) => [one.id, one.name]).sort(), [["general", "通用知识库"], [lib.id, "售后规范"]].sort());
  // 包里的条目就是文件清单里的那些，一个不多一个不少；清单文件是最后一个条目。
  // 另有一份给人看的说明.txt，不在文件清单里。
  assert.deepEqual(names.filter((name) => name !== README_NAME).sort(), manifest.files.map((f) => f.path).sort());
  assert.ok(names.includes(README_NAME));
  assert.equal(result.files, manifest.files.length);
  for (const file of manifest.files) assert.deepEqual([content(file.path).length, sha256(content(file.path))], [file.bytes, file.sha256], file.path);
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));

  // 任务甲：任务库、材料、task.json、选用的知识库、建任务时放进来的设置与方法说明、归档的四个文件。
  const material = byPath.get(`tasks/${a}/inputs/售后退款 业务说明.md`)!;
  assert.deepEqual([material.sha256, material.mtime_ms], [sha256(readFileSync(join(where.tasksDir, a, "inputs", "售后退款 业务说明.md"))), materialAt]);
  for (const path of [`tasks/${a}/${DB_NAME}`, `tasks/${a}/task.json`, `tasks/${a}/knowledge.json`, `tasks/${a}/.pi/settings.json`, `tasks/${a}/inputs/图.png`,
    `tasks/${a}/docs/task-definitions/requirements-engineering.json`, ...archive.map((one) => `runs/${a}/${one}`)]) assert.ok(byPath.has(path), path);
  assert.equal(byPath.get(`runs/${a}/${archive[0]}`)!.sha256, sha256(readFileSync(join(where.runsDir, a, archive[0]))), "归档原样");
  const left = manifest.files.map((f) => f.path).filter((path) => /service\.lock|\.uploading|\.tmp$|-wal$|-shm$/.test(path));
  assert.deepEqual(left, [], "占用标记、暂存目录、临时文件与日志文件不带");
  // 任务乙没有归档；它的空目录记在清单文件里。
  assert.deepEqual(manifest.files.filter((f) => f.path.startsWith(`runs/${b}/`)), []);
  assert.ok(manifest.empty_dirs.includes(`tasks/${b}/inputs/空目录`));
  const counted = (prefix: string) => manifest.files.filter((f) => f.path.startsWith(prefix)).length;
  assert.deepEqual(manifest.tasks.map((t) => [t.task_id, t.files]).sort(), [[a, counted(`tasks/${a}/`) + 4], [b, counted(`tasks/${b}/`)]].sort());

  // 知识库：文档与文档清单；知识库清单里的两条；任务登记表里的两行，目录记成编号。
  assert.ok(byPath.has(`knowledge/${lib.id}/files/退款处理规范.md`) && byPath.has(`knowledge/${lib.id}/documents.json`));
  assert.deepEqual(JSON.parse(content(PACK_LIBRARIES).toString("utf-8")).libraries.map((one: any) => one.id).sort(), ["general", lib.id].sort());
  const register = JSON.parse(content(PACK_REGISTER).toString("utf-8")).tasks as Record<string, unknown>[];
  assert.deepEqual(register.map((row) => [row.task_id, row.name, row.owner, row.status, row.task_type, row.dir]).sort(),
    [[a, "甲", "local", null, "requirements-engineering", a], [b, "乙", "local", null, "requirements-engineering", b]].sort());

  // 包里的任务库与原库内容相同（条数相同），而且只是一个文件。
  const copyDir = fresh("db");
  put(join(copyDir, DB_NAME), content(`tasks/${a}/${DB_NAME}`));
  assert.deepEqual(facts(copyDir), facts(join(where.tasksDir, a)));

  // 给人看的那几行。
  const text = exportText(result);
  assert.match(text, new RegExp(`数据包已经写好：.*all\\.taskwright\\.zip（${result.files} 个文件，`));
  assert.match(text, new RegExp(`任务 ${a}「甲」：\\d+ 个文件\\n`));
  assert.match(text, /知识库 general「通用知识库」：\d+ 个文件/);
  assert.match(text, /请妥善保管。产品设置、模型配置与密钥不在包里。/);
  assert.doesNotMatch(text, /manifest|schema|进程|pi\b/);

  // 原数据没有动：导出之后任务目录里没有多出文件。
  assert.deepEqual(readdirSync(join(where.tasksDir, b)).filter((name) => !name.startsWith(DB_NAME)).sort(), [".pi", "docs", "inputs", "knowledge.json", "task.json"].sort());

  if (spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0) {
    const check = spawnSync("unzip", ["-t", to], { encoding: "utf-8" });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
});

test("任务库的副本是完整的：导出时另有连接开着、最新的改动还只在日志文件里，包里的库照样有它", async () => {
  const where = await dataWith(fresh("data"), ["写着的"]);
  const [id] = where.ids;
  const writing = new DatabaseSync(join(where.tasksDir, id, DB_NAME));
  try {
    writing.exec("PRAGMA journal_mode = WAL; CREATE TABLE just_written (n INTEGER); INSERT INTO just_written VALUES (42)");
    const to = join(fresh("out"), "one.taskwright.zip");
    mkdirSync(join(to, ".."), { recursive: true });
    await exportPack(where, { scope: "task", taskId: id, to });
    const copyDir = fresh("db");
    put(join(copyDir, DB_NAME), readPack(to).content(`tasks/${id}/${DB_NAME}`));
    const copy = new DatabaseSync(join(copyDir, DB_NAME), { readOnly: true });
    try {
      assert.deepEqual({ ...(copy.prepare("SELECT n FROM just_written").get() as object) }, { n: 42 });
    } finally {
      copy.close();
    }
  } finally {
    writing.close();
  }
});

test("一个任务、一个知识库：只带它自己的；没有这个编号时拒绝；目标文件已经在时不覆盖", async () => {
  const { where, a, b, lib } = await sampleData();
  const dir = fresh("out");
  mkdirSync(dir);

  const one = await exportPack(where, { scope: "task", taskId: a, to: join(dir, `${a}.taskwright.zip`) });
  const task = readPack(one.file);
  assert.deepEqual([task.manifest.scope, task.manifest.tasks.map((t) => t.task_id), task.manifest.libraries], ["task", [a], []]);
  assert.ok(task.names.every((name) => name.startsWith(`tasks/${a}/`) || name.startsWith(`runs/${a}/`) || name === PACK_REGISTER || name === README_NAME), "别的任务与知识库都不在包里");
  assert.ok(!task.names.includes(PACK_LIBRARIES));

  const two = await exportPack(where, { scope: "library", libraryId: lib.id, to: join(dir, `${lib.id}.taskwright.zip`) });
  const pack = readPack(two.file);
  assert.deepEqual([pack.manifest.scope, pack.manifest.tasks, pack.manifest.libraries.map((x) => x.id)], ["library", [], [lib.id]]);
  assert.ok(pack.names.every((name) => name.startsWith(`knowledge/${lib.id}/`) || name === PACK_LIBRARIES || name === README_NAME));
  assert.deepEqual(JSON.parse(pack.content(PACK_LIBRARIES).toString("utf-8")).libraries.map((x: any) => [x.id, x.name]), [[lib.id, "售后规范"]]);

  const missing = await failure(() => exportPack(where, { scope: "task", taskId: "TASK-NOPE", to: join(dir, "x.zip") }));
  assert.ok(missing instanceof PackError && missing.code === "not_found");
  assert.match(missing.message, /没有任务 TASK-NOPE/);
  const noLibrary = await failure(() => exportPack(where, { scope: "library", libraryId: "lib-00000000", to: join(dir, "y.zip") }));
  assert.ok(noLibrary instanceof PackError && noLibrary.code === "not_found");

  const before = readFileSync(one.file);
  const taken = await failure(() => exportPack(where, { scope: "task", taskId: b, to: one.file }));
  assert.ok(taken instanceof PackError && taken.code === "exists");
  assert.deepEqual(readFileSync(one.file), before, "已有的文件原样");
  assert.deepEqual(readdirSync(dir).sort(), [`${a}.taskwright.zip`, `${lib.id}.taskwright.zip`].sort(), "失败的几次都没有留下文件");
});

test("还没有升级的数据目录也能导出：目录名与编号不同的任务按编号进包，清单文件记着原目录名与旧的格式版本", async () => {
  const where = locations(fresh("old"));
  mkdirSync(where.tasksDir, { recursive: true });
  cpSync(join(SAMPLES, "format-8-b"), join(where.tasksDir, "format-8-b"), { recursive: true });
  const to = join(fresh("out"), "old.taskwright.zip");
  mkdirSync(join(to, ".."), { recursive: true });
  const result = await exportPack(where, { withMaterials: true, scope: "all", to });
  const { manifest, names, content } = readPack(to);
  assert.deepEqual([manifest.data_format, manifest.task_db_version, manifest.libraries], [0, TASK_DB_VERSION, []]);
  assert.deepEqual(manifest.tasks.map((t) => [t.task_id, t.name, t.dir, t.task_db_version, t.owner]), [["TASK-SAMPLE-8B", "图书借阅（样本乙）", "format-8-b", 8, "local"]]);
  assert.ok(names.includes(`tasks/TASK-SAMPLE-8B/${DB_NAME}`) && names.includes("tasks/TASK-SAMPLE-8B/inputs/材料.md"));
  assert.deepEqual(JSON.parse(content(PACK_REGISTER).toString("utf-8")).tasks.map((row: any) => [row.task_id, row.owner, row.task_type, row.dir]),
    [["TASK-SAMPLE-8B", "local", "srs-authoring", "TASK-SAMPLE-8B"]]);
  assert.equal(existsSync(join(where.dataDir, "service.sqlite")), false, "导出不建服务级库");
  assert.deepEqual(result.skipped, []);
});

test("正在使用的任务照样导出，清单文件记着；读不出编号的目录、同一个编号的另一个目录、符号链接写进「没有带」", async () => {
  const where = await dataWith(fresh("data"), ["在用的"]);
  const [id] = where.ids;
  // 另一个活着的服务占着它（用本测试进程的父进程当那个服务）。
  writeFileSync(join(where.tasksDir, id, LOCK_NAME), JSON.stringify({ port: 8950, pid: process.ppid, host: hostname() }));
  put(join(where.tasksDir, "broken", DB_NAME), "这不是一个数据库");
  cpSync(join(where.tasksDir, id), join(where.tasksDir, "zz-copy"), { recursive: true });
  symlinkSync(join(where.tasksDir, id, "task.json"), join(where.tasksDir, id, "inputs", "link.json"));
  const to = join(fresh("out"), "busy.taskwright.zip");
  mkdirSync(join(to, ".."), { recursive: true });
  const result = await exportPack(where, { withMaterials: true, scope: "all", to, working: (taskId) => taskId === id });
  assert.deepEqual(result.tasks.map((t) => [t.task_id, t.in_use, t.assistant_working]), [[id, true, true]]);
  assert.deepEqual(result.skipped.map((one) => [one.what, one.reason]).sort(), [
    ["任务目录 broken", "读不出任务编号，没有带"],
    ["任务目录 zz-copy", `与前面的任务目录是同一个任务编号 ${id}，没有带`],
    [`任务 ${id}/inputs/link.json`, "不是普通文件（例如符号链接），没有带"],
  ].sort());
  assert.match(exportText(result), /导出时助手正在这个任务里工作/);
  assert.match(exportText({ ...result, tasks: result.tasks.map((t) => ({ ...t, assistant_working: false })) }), /导出时这个任务正在使用/);
  assert.match(exportText(result), /没有带：任务目录 broken（读不出任务编号，没有带）/);
  assert.ok(!readPack(to).names.some((name) => name.endsWith(MANIFEST_NAME) || name.includes("link.json")));
});

test("一个空的数据目录：包里只有清单文件与说明", async () => {
  const where = locations(fresh("empty"));
  const to = join(fresh("out"), "empty.taskwright.zip");
  mkdirSync(join(to, ".."), { recursive: true });
  const result = await exportPack(where, { scope: "all", to });
  assert.deepEqual([result.files, result.tasks, result.libraries], [0, [], []]);
  assert.deepEqual(readPack(to).names, [README_NAME]);
  assert.match(exportText(result), /包里只有清单文件/);
  assert.equal(existsSync(where.dataDir), false, "导出不建数据目录");
});

/** 一个空的输出目录。 */
const outDir = () => {
  const dir = fresh("out");
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** 一个任务：材料表里记着一份 PDF（旁边有它的文字版、分段清单、位置表）与一份 Markdown；一个有一份文档的知识库。 */
async function materialData() {
  const where = await dataWith(fresh("data"), ["甲"]);
  const [a] = where.ids;
  const task = join(where.tasksDir, a);
  put(join(task, "inputs", "规格.pdf"), "%PDF-1.4 假的 PDF\n");
  put(join(task, "inputs", "规格.pdf.md"), "[p1-1] 第一页\n");
  put(join(task, "inputs", "规格.pdf.segments.json"), JSON.stringify({ version: 1, blocks: [{ index: 1 }, { index: 2 }] }));
  put(join(task, "inputs", "规格.pdf.locations.json"), "{}\n");
  put(join(task, "inputs", "纪要.md"), "会上定了三件事。\n");
  insertMaterial(task, "inputs/规格.pdf", { slot: "spec", role: "既有规格说明" });
  insertMaterial(task, "inputs/纪要.md", { slot: "evidence", role: "证据" });
  const store = new KnowledgeStore(where.knowledgeDir);
  const lib = store.create("售后规范");
  await store.upload(lib.id, "退款处理规范.md", Buffer.from("退款处理规范全文\n", "utf-8"), "standard");
  return { where, a, task, lib };
}

test("缺省导出不带材料与知识库文档：inputs 与 files 下没有文件，只记成空目录；清单文件写 with_materials 为假、材料清单、文档清单与规则版本", async () => {
  const { where, a, task, lib } = await materialData();
  const to = join(outDir(), "all.taskwright.zip");
  const result = await exportPack(where, { scope: "all", to, segmentParams: { heading_depth: 2, max_paragraphs: 200, min_paragraphs: 4 } });
  const { manifest, names } = readPack(to);
  assert.equal(result.with_materials, false);
  assert.deepEqual(names.filter((one) => one.startsWith(`tasks/${a}/inputs/`) || one.startsWith(`knowledge/${lib.id}/files/`)), []);
  assert.ok(names.includes(`knowledge/${lib.id}/documents.json`) && names.includes(`tasks/${a}/knowledge.json`));
  assert.ok(manifest.empty_dirs.includes(`tasks/${a}/inputs`) && manifest.empty_dirs.includes(`knowledge/${lib.id}/files`));
  assert.equal(manifest.with_materials, false);
  const file = (rel: string) => readFileSync(join(task, rel));
  const print = (rel: string) => ({ path: rel, bytes: file(rel).length, sha256: sha256(file(rel)) });
  assert.deepEqual(manifest.tasks[0].materials!.map(({ added_at, ...rest }) => (assert.match(added_at, /^\d{4}-\d\d-\d\dT/), rest)), [
    { ...print("inputs/规格.pdf"), slot: "spec", role: "既有规格说明", segments: 2,
      derived: [print("inputs/规格.pdf.md"), print("inputs/规格.pdf.segments.json"), print("inputs/规格.pdf.locations.json")] },
    { ...print("inputs/纪要.md"), slot: "evidence", role: "证据", segments: null, derived: [] },
  ]);
  assert.deepEqual(manifest.projection, {
    pdf_location_rules_version: 2, pdf_locations_format_version: 1, pdfjs_version: PDFJS_VERSION, segment_params: { heading_depth: 2, max_paragraphs: 200, min_paragraphs: 4 },
  });
  const docs = new KnowledgeStore(where.knowledgeDir).documents(lib.id);
  assert.deepEqual(manifest.libraries.find((one) => one.id === lib.id)!.documents, docs.map(({ name, kind, bytes, sha256: digest, uploaded_at }) => ({ name, kind, bytes, sha256: digest, uploaded_at })));
  assert.match(exportText(result), /材料与知识库的原件不在包里（要带上它们，导出时加 --with-materials）/);
});

test("选了带材料（withMaterials）：inputs 与 files 下的文件都在包里，两张清单照样写、内容与缺省导出的一样", async () => {
  const { where, a, lib } = await materialData();
  const bare = join(outDir(), "bare.taskwright.zip");
  const full = join(outDir(), "full.taskwright.zip");
  await exportPack(where, { scope: "all", to: bare });
  await exportPack(where, { scope: "all", to: full, withMaterials: true });
  const one = readPack(bare).manifest;
  const two = readPack(full);
  assert.equal(two.manifest.with_materials, true);
  for (const name of ["规格.pdf", "规格.pdf.md", "规格.pdf.segments.json", "规格.pdf.locations.json", "纪要.md"]) assert.ok(two.names.includes(`tasks/${a}/inputs/${name}`), name);
  assert.ok(two.names.includes(`knowledge/${lib.id}/files/退款处理规范.md`));
  assert.deepEqual(two.manifest.tasks[0].materials, one.tasks[0].materials);
  assert.deepEqual(two.manifest.libraries.map((x) => x.documents), one.libraries.map((x) => x.documents));
  assert.equal(two.manifest.empty_dirs.includes(`tasks/${a}/inputs`), false);
});

test("从不带材料的包升级出的包：材料清单的指纹与规则版本照原包抄，不因为文件不在而丢", async () => {
  const { where, a } = await materialData();
  const bare = join(outDir(), "bare.taskwright.zip");
  await exportPack(where, { scope: "task", taskId: a, to: bare, segmentParams: { heading_depth: 2, max_paragraphs: 200, min_paragraphs: 4 } });
  const upgraded = join(outDir(), "upgraded.taskwright.zip");
  await upgradePack(bare, upgraded);
  const before = readPack(bare).manifest;
  const after = readPack(upgraded).manifest;
  assert.equal(after.with_materials, false);
  assert.deepEqual(after.tasks[0].materials, before.tasks[0].materials);
  assert.deepEqual(after.projection, before.projection);
});

/** 数据目录下的设置文件：一个语言模型服务（多写了 api_key、status 这类诊断包不该带的键），选中了它的一个模型。 */
function putSettings(dataDir: string, agentDir: string): void {
  put(join(dataDir, "settings.json"), JSON.stringify({
    version: 2, uploads: { material_mb: 10 }, debug: true,
    pi_dirs: {
      [resolve(agentDir)]: {
        selection: { language: { provider: "taskwright-deepseek", model: "deepseek-chat" }, embedding: null },
        providers: {
          "taskwright-deepseek": {
            kind: "deepseek", purpose: "language", name: "深度求索", base_url: "https://api.example.com/v1", api_key: "sk-secret-value",
            models_fetched_at: "2026-10-01T00:00:00", status: { checked_at: "x", ok: true, message: "Authorization 通过" },
            models: [{ id: "deepseek-chat", enabled: true, context_window: 65536, context_source: "service" }],
          },
        },
      },
    },
  }));
}

/** 诊断包要的事实：一个有材料、有归档（含事件归档）的任务，数据目录下有设置文件与几份后端日志。 */
async function diagnosticData() {
  const made = await materialData();
  putArchive(made.where, made.a);
  const agentDir = join(made.where.dataDir, "pi-agent");
  putSettings(made.where.dataDir, agentDir);
  const settings = settingsExcerpt(agentDir, {}, made.where.dataDir);
  return { ...made, agentDir, settings };
}

test("诊断包：固定带事件归档、不带材料原件（不看 withEvents 与 withMaterials），另带设置摘录；清单文件的 diagnostic 一节；说明写明是诊断包", async () => {
  const { where, a, settings } = await diagnosticData();
  const to = join(outDir(), diagnosticPackName(a, new Date(2026, 9, 22, 9, 5)));
  assert.equal(basename(to), `diag-${a}-20261022-0905.taskwright.zip`);
  const launchModel = { model: "deepseek-flash", provider: "deepseek", from: "启动配置" };
  const result = await exportPack(where, { scope: "task", taskId: a, to, withEvents: false, withMaterials: true, diagnostic: { settings, logsDir: join(where.dataDir, "logs"), launchModel } });
  const { manifest, names, content } = readPack(to);
  assert.deepEqual([manifest.with_events, manifest.with_materials], [true, false]);
  assert.ok(names.some((one) => one.startsWith(`runs/${a}/pi-events/`)) && names.some((one) => one.startsWith(`runs/${a}/pi-sessions/`)));
  assert.deepEqual(names.filter((one) => one.startsWith(`tasks/${a}/inputs/`)), []);
  assert.ok(names.includes(SETTINGS_EXCERPT_NAME) && manifest.files.some((one) => one.path === SETTINGS_EXCERPT_NAME));
  assert.deepEqual(manifest.diagnostic, {
    purpose: "full", granularity: "task", session_id: null, product_version: manifest.product_version, task_db_version: manifest.task_db_version,
    model: { model: "deepseek-chat", provider: "深度求索" }, launch_model: launchModel, log_range: null,
  }, "数据目录里没有后端日志时 log_range 是 null");
  // 设置摘录只有版本、选中的模型与各模型服务的五项；全文里没有 key 这个词。
  const excerpt = content(SETTINGS_EXCERPT_NAME).toString("utf-8");
  assert.deepEqual(JSON.parse(excerpt), {
    version: 2, selection: { language: { provider: "taskwright-deepseek", model: "deepseek-chat" }, embedding: null },
    providers: { "taskwright-deepseek": { kind: "deepseek", purpose: "language", name: "深度求索", base_url: "https://api.example.com/v1",
      models: [{ id: "deepseek-chat", enabled: true, context_window: 65536, context_source: "service" }] } },
  });
  assert.doesNotMatch(excerpt, /key/i);
  // 整个包里没有密钥一类的字样。
  for (const name of names) assert.doesNotMatch(content(name).toString("latin1") + content(name).toString("utf-8"), /api_key|apiKey|Authorization|sk-secret-value/, name);
  const readme = content(README_NAME).toString("utf-8");
  assert.ok(readme.startsWith("这是诊断包，用来排查问题，不用来恢复任务。\n"), readme);
  for (const part of ["运行轨迹", "对话记录", "任务库", "后端日志：这个数据目录里没有", "设置摘录", "输入资料清单", "输入资料与知识库的原件和文字版", "密钥", "包里含对话全文与条目摘录，请妥善保管。", "语言模型：deepseek-flash（deepseek，取自启动配置）"]) {
    assert.ok(readme.includes(part), part);
  }
  assert.deepEqual(result.diagnostic, { logs: 0, redacted: false });
  assert.match(exportText(result), /^诊断包已经写好：.*\n[^]*这个数据目录里没有任务建立以来写过的后端日志，只带了设置摘录。\n包里含对话全文与条目摘录，请妥善保管。/);
});

test("诊断包的后端日志：文件名日期不晚于导出那天、最后修改不早于任务建立时刻的整份带上，原名放在 logs/ 下；log_range 写任务建立到导出", async () => {
  const { where, a, settings } = await diagnosticData();
  const logs = join(where.dataDir, "logs");
  // 任务建立的时刻：任务库 task 表的 started_at（本机时间，不带时区）。
  const db = new DatabaseSync(join(where.tasksDir, a, DB_NAME), { readOnly: true });
  const started = new Date(String((db.prepare("SELECT started_at FROM task").get() as { started_at: string }).started_at)).getTime();
  db.close();
  const day = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date();
  // 早就停了的进程：最后一次写在任务建立之前，不带。
  put(join(logs, "backend-20260101.log"), "早先的日志\n", started - 3_600_000);
  // 任务建立之前起的进程，任务建立之后还在写：带。
  put(join(logs, "backend-20260102.log"), "跨天还在写的日志\n", started + 1000);
  // 今天起的进程：带。
  put(join(logs, `backend-${day(now)}.log`), "今天的日志\n", now.getTime());
  // 日期在导出之后的（时钟不对）与别的文件：不带。
  put(join(logs, "backend-29991231.log"), "将来的\n", now.getTime());
  put(join(logs, "import-20261022-181534.txt"), "导入报告\n", now.getTime());
  const to = join(outDir(), "diag.taskwright.zip");
  await exportPack(where, { scope: "task", taskId: a, to, diagnostic: { settings, logsDir: join(where.dataDir, "logs") } });
  const { manifest, names, content } = readPack(to);
  assert.deepEqual(names.filter((one) => one.startsWith("logs/")).sort(), ["logs/backend-20260102.log", `logs/backend-${day(now)}.log`].sort());
  assert.equal(content("logs/backend-20260102.log").toString("utf-8"), "跨天还在写的日志\n");
  assert.equal(manifest.diagnostic!.log_range!.to, manifest.exported_at);
  assert.ok(manifest.diagnostic!.log_range!.from.startsWith(String(new Date(started).getFullYear())));
  assert.match(content(README_NAME).toString("utf-8"), /- 后端日志：任务建立（.*）以来写过的后端日志文件，整份（logs\/）。/);
});

test("诊断包里没有给实际用的模型（命令行导出）时 launch_model 是 null，说明里写设置里选定的那个；升级诊断包时说只保留数据包部分", async () => {
  const { where, a, settings } = await diagnosticData();
  const to = join(outDir(), "diag.taskwright.zip");
  await exportPack(where, { scope: "task", taskId: a, to, diagnostic: { settings, logsDir: join(where.dataDir, "logs") } });
  const { manifest, content } = readPack(to);
  assert.deepEqual([manifest.diagnostic!.model, manifest.diagnostic!.launch_model], [{ model: "deepseek-chat", provider: "深度求索" }, null]);
  assert.match(content(README_NAME).toString("utf-8"), /语言模型：deepseek-chat（深度求索，设置里选定的）/);
  const upgraded = join(outDir(), "upgraded.taskwright.zip");
  const result = await upgradePack(to, upgraded);
  assert.equal(result.was_diagnostic, true);
  assert.match(upgradePackText(result), /^数据包升级（原来的包由 .* 导出）\n这是诊断包，升级后只保留数据包部分\n/);
  assert.equal(readPack(upgraded).manifest.diagnostic, undefined);
  assert.equal(readPack(upgraded).names.includes(SETTINGS_EXCERPT_NAME), false);
});

test("诊断包只能按一个任务导出", async () => {
  const { where, settings } = await diagnosticData();
  const error = await failure(() => exportPack(where, { scope: "all", to: join(outDir(), "x.zip"), diagnostic: { settings, logsDir: join(where.dataDir, "logs") } }));
  assert.ok(error instanceof PackError && error.code === "refused" && error.message === "诊断包只能按一个任务导出。", String(error));
});
