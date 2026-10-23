/**
 * 数据包的四个接口：GET /tasks/<编号>/export 与 GET /knowledge/libraries/<库编号>/export 回一个 zip 下载；
 * POST /tasks/import 与 POST /knowledge/import 收 zip 的字节（边收边写进暂存目录），只收各自那种范围的包，查询参数 renumber=1 是改编号导入。
 * 超过上限答 too_large；数据升级还没有做完时四个接口都答 upgrade_pending。
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { insertMaterial } from "../../agent/src/lib/material_db.ts";
import { PACK_MAX_UPLOAD, PACK_UPLOAD_TOO_LARGE_TEXT, exportPack } from "../src/data_pack.ts";
import { UPGRADE_PENDING_TEXT, makeServer } from "../src/http.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { Service } from "../src/service.ts";
import { ServiceDb } from "../src/service_db.ts";
import { startService } from "../src/start.ts";
import { ROOT, captureConsole, keepGeneral, tempDir } from "./helpers.ts";
import { dataWith, facts, locations, put, putArchive, readPack, tree, withoutEvents } from "./pack_stack.ts";

captureConsole();

type Dict = Record<string, any>;
const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);

const start = (data: string, mode: "server" | "desktop" = "server") => startService({ port: 0, mode, host: "127.0.0.1", profile: "fake", ownProcess: false, data });
const getJson = async (port: number, path: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as Dict };
};
/** 把一段字节当请求体发给一个导入接口。 */
const postPack = async (port: number, path: string, data: Buffer) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: data });
  return { status: res.status, body: (await res.json()) as Dict };
};
/** 系统临时目录里导出时用的临时目录。 */
const exportScratch = () => readdirSync(tmpdir()).filter((name) => name.startsWith("taskwright-export-"));
const staged = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []).filter((name) => name.startsWith(".importing-"));

/** 一个任务（有材料与归档）与一个有一份文档的知识库。 */
async function sampleData() {
  const where = await dataWith(fresh("data"), ["甲"]);
  const [a] = where.ids;
  put(join(where.tasksDir, a, "inputs", "材料.md"), "读者凭借书证借书。\n");
  putArchive(where, a);
  keepGeneral(where.knowledgeDir);
  const store = new KnowledgeStore(where.knowledgeDir);
  const lib = store.create("售后规范");
  await store.upload(lib.id, "退款处理规范.md", Buffer.from("退款处理规范全文\n".repeat(30), "utf-8"), "standard");
  return { where, a, lib };
}

test("导出接口：任务与知识库各回一个 zip 下载，里面是范围对应的数据包；没有这个编号是 not_found；临时文件发完就删", async () => {
  const { where, a, lib } = await sampleData();
  const started = await start(where.dataDir);
  try {
    const { port } = started;
    const info = await getJson(port, "/api/v1/service");
    assert.deepEqual(info.body.pack_upload, { max_bytes: 1024 * 1024 * 1024, too_large_text: "在这里导入的数据包不能超过 1 GB。更大的数据包请用命令行导入。" });

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${a}/export`);
    const data = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([res.status, res.headers.get("content-type"), res.headers.get("content-disposition"), res.headers.get("content-length")],
      [200, "application/zip", `attachment; filename="${a}.taskwright.zip"`, String(data.length)]);
    const file = join(fresh("got"), "task.zip");
    put(file, data);
    const pack = readPack(file);
    // 导出的服务自己占着这个任务；助手没有在工作。
    assert.deepEqual([pack.manifest.scope, pack.manifest.tasks.map((t) => [t.task_id, t.name, t.in_use, t.assistant_working]), pack.manifest.libraries], ["task", [[a, "甲", true, false]], []]);
    // 缺省不带材料：材料目录只是空目录；with_materials=1 才带。
    assert.ok(!pack.names.some((name) => name.startsWith(`tasks/${a}/inputs/`)) && pack.names.some((name) => name.startsWith(`runs/${a}/pi-sessions/`)));
    assert.deepEqual([pack.manifest.with_materials, pack.manifest.empty_dirs.includes(`tasks/${a}/inputs`)], [false, true]);
    const full = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${a}/export?with_materials=1`);
    const fullFile = join(fresh("got"), "task-full.zip");
    put(fullFile, Buffer.from(await full.arrayBuffer()));
    assert.deepEqual([readPack(fullFile).manifest.with_materials, readPack(fullFile).names.includes(`tasks/${a}/inputs/材料.md`)], [true, true]);
    assert.ok(!pack.names.some((name) => name.includes("service.lock")));

    const got = await fetch(`http://127.0.0.1:${port}/api/v1/knowledge/libraries/${lib.id}/export`);
    const libFile = join(fresh("got"), "lib.zip");
    put(libFile, Buffer.from(await got.arrayBuffer()));
    assert.deepEqual([got.status, got.headers.get("content-disposition")], [200, `attachment; filename="${lib.id}.taskwright.zip"`]);
    assert.deepEqual([readPack(libFile).manifest.scope, readPack(libFile).manifest.libraries.map((x) => [x.id, x.name])], ["library", [[lib.id, "售后规范"]]]);
    // 知识库也缺省不带文档，只带文档清单；with_materials=1 才带。
    assert.deepEqual([readPack(libFile).manifest.with_materials, readPack(libFile).names.filter((name) => name.includes("/files/"))], [false, []]);
    assert.deepEqual(readPack(libFile).manifest.libraries[0].documents!.map((one) => one.name), ["退款处理规范.md"]);
    const libFull = await fetch(`http://127.0.0.1:${port}/api/v1/knowledge/libraries/${lib.id}/export?with_materials=1`);
    const libFullFile = join(fresh("got"), "lib-full.zip");
    put(libFullFile, Buffer.from(await libFull.arrayBuffer()));
    assert.ok(readPack(libFullFile).names.includes(`knowledge/${lib.id}/files/退款处理规范.md`));

    const none = await getJson(port, "/api/v1/tasks/TASK-NOPE/export");
    assert.deepEqual([none.status, none.body.error.code], [404, "not_found"]);
    const noLibrary = await getJson(port, "/api/v1/knowledge/libraries/lib-00000000/export");
    assert.deepEqual([noLibrary.status, noLibrary.body.error.code], [404, "not_found"]);
    assert.deepEqual(exportScratch(), [], "导出用的临时文件都删了");
  } finally {
    await started.stop();
  }
});

test("导入接口：收下一个任务的包并让服务接手它；再发一次跳过；renumber=1 改编号导入；范围不对、不是数据包答 rejected；知识库的接口同理", async () => {
  const { where, a, lib } = await sampleData();
  const dir = fresh("packs");
  mkdirSync(dir);
  const taskPack = join(dir, "task.zip");
  const libraryPack = join(dir, "library.zip");
  const allPack = join(dir, "all.zip");
  await exportPack(where, { scope: "task", taskId: a, to: taskPack, withMaterials: true });
  await exportPack(where, { scope: "library", libraryId: lib.id, to: libraryPack, withMaterials: true });
  await exportPack(where, { scope: "all", to: allPack, withMaterials: true });
  const read = (file: string) => readFileSync(file);

  const target = locations(fresh("target"));
  const started = await start(target.dataDir);
  try {
    const { port } = started;
    const first = await postPack(port, "/api/v1/tasks/import", read(taskPack));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const report = first.body.report as Dict;
    assert.deepEqual([first.body.ok, report.fatal, report.pack.file, report.pack.scope, report.tasks.map((t: Dict) => [t.task_id, t.outcome, t.new_id])],
      [true, null, "上传的数据包", "task", [[a, "imported", null]]]);
    assert.match(report.text, new RegExp(`数据包：上传的数据包（由 .* 导出于 .*，范围：一个任务）\\n[^]*任务 ${a}「甲」：已导入\\n`));
    assert.doesNotMatch(report.text, /\.importing-|upload\.zip/, "报告里不写暂存文件的路径");
    // 服务已经接手：列表里有它，任务页读得出材料，登记表里有它；归档与原来的相同；暂存目录删了。
    const list = await getJson(port, "/api/v1/tasks");
    assert.deepEqual(list.body.tasks.map((t: Dict) => [t.task_id, t.task_name, t.supported, t.session_count]), [[a, "甲", true, 1]]);
    assert.deepEqual((await getJson(port, `/api/v1/tasks/${a}`)).body.materials.map((m: Dict) => m.path), ["inputs/材料.md"]);
    assert.deepEqual(started.service.registry!.tasks().map((t) => [t.task_id, t.dir]), [[a, a]]);
    // 缺省不带事件归档：导入之后的归档是原来的对话记录那一部分。
    assert.deepEqual(tree(join(target.runsDir, a)), withoutEvents(tree(join(where.runsDir, a))));
    assert.deepEqual(facts(join(target.tasksDir, a)), facts(join(where.tasksDir, a)));
    assert.deepEqual([staged(target.tasksDir), staged(target.runsDir), staged(target.knowledgeDir)], [[], [], []]);
    assert.ok(readdirSync(join(target.dataDir, "logs")).some((name) => /^import-\d{8}-\d{6}\.txt$/.test(name)), "报告写进了数据目录的日志目录");

    const again = await postPack(port, "/api/v1/tasks/import", read(taskPack));
    assert.deepEqual([again.status, again.body.report.tasks.map((t: Dict) => t.outcome)], [200, ["skipped"]]);
    const renumbered = await postPack(port, "/api/v1/tasks/import?renumber=1", read(taskPack));
    const id = renumbered.body.report.tasks[0].new_id as string;
    assert.match(id, /^TASK-\d{8}-[0-9A-F]{4}$/);
    assert.deepEqual((await getJson(port, "/api/v1/tasks")).body.tasks.map((t: Dict) => t.task_id).sort(), [a, id].sort());
    assert.equal((await getJson(port, `/api/v1/tasks/${id}`)).body.task_id, id);

    // 范围不对的包、不是数据包的内容：整个不导入，答 rejected，报告在 data 里。
    for (const [path, pack, pattern] of [
      ["/api/v1/tasks/import", libraryPack, /这里只能导入范围是一个任务的数据包，这个包的范围是一个知识库。/],
      ["/api/v1/tasks/import", allPack, /这个包的范围是整套。范围是整套的包请用命令行导入。/],
      ["/api/v1/knowledge/import", taskPack, /这里只能导入范围是一个知识库的数据包/],
    ] as const) {
      const refused = await postPack(port, path, read(pack));
      assert.deepEqual([refused.status, refused.body.ok, refused.body.error.code], [422, false, "rejected"], path);
      assert.match(refused.body.error.message, pattern);
      assert.equal(refused.body.error.data.report.fatal, refused.body.error.message);
    }
    const garbage = await postPack(port, "/api/v1/tasks/import", Buffer.from("这只是一段文字".repeat(50)));
    assert.deepEqual([garbage.status, garbage.body.error.code], [422, "rejected"]);
    assert.match(garbage.body.error.message, /这个文件不是数据包，或者已经损坏/);

    const library = await postPack(port, "/api/v1/knowledge/import", read(libraryPack));
    assert.deepEqual([library.status, library.body.report.libraries.map((x: Dict) => [x.id, x.outcome])], [200, [[lib.id, "imported"]]]);
    assert.ok((await getJson(port, "/api/v1/knowledge")).body.libraries.some((x: Dict) => x.id === lib.id && x.name === "售后规范"));
    assert.deepEqual([staged(target.tasksDir), staged(target.knowledgeDir)], [[], []]);
  } finally {
    await started.stop();
  }
});

test("导入接口的上限：请求头里写的长度超过上限时不收请求体；没有写长度而实际收到的超过上限时停下；都答 too_large，不留暂存目录", async () => {
  const where = locations(fresh("limit"));
  const service = new Service(where.tasksDir, where.runsDir, {}, { port: 1, knowledgeDir: where.knowledgeDir, registry: ServiceDb.open(where.dataDir, "0.5.0") });
  const server = makeServer(service, { packMaxUpload: 1000 });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  /** 用 node:http 发一个请求：declared 是请求头里写的长度（null 时不写长度、分块发），body 是实际发的内容。 */
  const send = (path: string, declared: number | null, body: Buffer | null) => new Promise<{ status: number; body: Dict }>((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: declared === null ? {} : { "Content-Length": String(declared) } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" || error.code === "EPIPE" ? undefined : fail(error)));
    if (body) req.end(body);
    else req.flushHeaders();
  });
  try {
    for (const path of ["/api/v1/tasks/import", "/api/v1/knowledge/import"]) {
      const declared = await send(path, PACK_MAX_UPLOAD + 1, null);
      assert.deepEqual([declared.status, declared.body.error.code, declared.body.error.message], [413, "too_large", PACK_UPLOAD_TOO_LARGE_TEXT], path);
      const streamed = await send(path, null, Buffer.alloc(200_000, 7));
      assert.deepEqual([streamed.status, streamed.body.error.code], [413, "too_large"], path);
    }
    // 在上限之内的照常收下（内容不是数据包，所以被拒绝的原因是这个）。
    const small = await send("/api/v1/tasks/import", null, Buffer.alloc(500, 7));
    assert.deepEqual([small.status, small.body.error.code], [422, "rejected"]);
    assert.deepEqual([staged(where.tasksDir), staged(where.knowledgeDir)], [[], []]);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    await service.close();
  }
});

test("数据升级还没有做完时：导出与导入的四个接口都答 upgrade_pending，不收请求体、不留暂存目录", async () => {
  const data = fresh("pending");
  mkdirSync(join(data, "tasks"), { recursive: true });
  cpSync(join(SAMPLES, "format-8-b"), join(data, "tasks", "TASK-A"), { recursive: true });
  const started = await start(data, "desktop");
  try {
    const { port } = started;
    assert.equal((await getJson(port, "/api/v1/service")).body.upgrade_pending, true);
    for (const path of ["/api/v1/tasks/TASK-SAMPLE-8B/export", "/api/v1/knowledge/libraries/general/export"]) {
      const refused = await getJson(port, path);
      assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message], [503, "upgrade_pending", UPGRADE_PENDING_TEXT], path);
    }
    for (const path of ["/api/v1/tasks/import", "/api/v1/knowledge/import"]) {
      const refused = await postPack(port, path, Buffer.alloc(2000, 7));
      assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message], [503, "upgrade_pending", UPGRADE_PENDING_TEXT], path);
    }
    assert.deepEqual(staged(join(data, "tasks")), []);
    assert.deepEqual(readdirSync(join(data, "tasks")), ["TASK-A"]);
  } finally {
    await started.stop();
  }
});

test("导入不带材料的包：任务照常打开，材料表里的每份材料标 missing、大小 0、上传时间照原样；两个读材料的接口答 material_missing，不在材料表里的照旧 not_found", async () => {
  const where = await dataWith(fresh("data"), ["甲"]);
  const [a] = where.ids;
  const task = join(where.tasksDir, a);
  put(join(task, "inputs", "规格.pdf"), "%PDF-1.4 假的 PDF\n");
  put(join(task, "inputs", "规格.pdf.md"), "[p1-1] 第一页\n");
  insertMaterial(task, "inputs/规格.pdf", { slot: "spec", role: "既有规格说明" });
  const file = join(fresh("packs"), "bare.zip");
  mkdirSync(join(file, ".."), { recursive: true });
  await exportPack(where, { scope: "task", taskId: a, to: file });
  const addedAt = readPack(file).manifest.tasks[0].materials![0].added_at;

  const target = locations(fresh("target"));
  const started = await start(target.dataDir);
  try {
    const { port } = started;
    assert.equal((await postPack(port, "/api/v1/tasks/import", readFileSync(file))).status, 200);
    const page = await getJson(port, `/api/v1/tasks/${a}`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.materials.map((m: Dict) => [m.path, m.missing, m.bytes, m.modified_at, m.role, m.deletable]),
      [["inputs/规格.pdf", true, 0, addedAt, "既有规格说明", false]]);
    for (const kind of ["content", "raw"]) {
      const got = await getJson(port, `/api/v1/tasks/${a}/materials/${kind}?path=${encodeURIComponent("inputs/规格.pdf")}`);
      assert.deepEqual([got.status, got.body.error.code, got.body.error.message], [404, "material_missing", "文件缺失，请补齐：规格.pdf"], kind);
      const none = await getJson(port, `/api/v1/tasks/${a}/materials/${kind}?path=${encodeURIComponent("inputs/没有的.md")}`);
      assert.deepEqual([none.status, none.body.error.code], [404, "not_found"], kind);
    }
  } finally {
    await started.stop();
  }
});
