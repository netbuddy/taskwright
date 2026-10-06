/**
 * 知识库：知识库的新建、改名、删除（通用知识库的三条限制、删除知识库后任务自动不再选用），文档上传的检查（类型、20 MB、同名、同内容、种类），
 * Word 文档生成投影，文档的删除与读取，任务选用的知识库的读写与新任务的缺省值，没有配置知识库时的表现，以及各接口经 HTTP 的形状。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { dispatch, makeServer, serviceInfo } from "../src/http.ts";
import { GENERAL, KNOWLEDGE_MAX_UPLOAD, docDuplicateText, docNameTakenText } from "../src/knowledge.ts";
import { Service } from "../src/service.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function fresh(withKnowledge = true): Service {
  const root = join(tmp, `case-${++n}`);
  return new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, ...(withKnowledge ? { knowledgeDir: join(root, "knowledge") } : {}) });
}

function rejected(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("没有被拒绝");
}

type Dict = Record<string, any>;
async function call(service: Service, method: string, path: string, body: Dict | Buffer | null = null, headers: Dict = {}) {
  const raw = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const [p, q] = path.split("?");
  const query = Object.fromEntries(new URLSearchParams(q ?? ""));
  const reply = (await dispatch(service, { method, path: p, query, headers, body: raw, remote: "127.0.0.1" })) as Dict;
  const text = reply.body.toString("utf-8");
  return { status: reply.status as number, json: reply.headers["Content-Type"].startsWith("application/json") ? JSON.parse(text) : null, body: reply.body as Buffer };
}

function multipart(filename: string, data: Buffer, fields: Dict = {}): [Buffer, Dict] {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--B\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from("\r\n--B--\r\n"));
  return [Buffer.concat(parts), { "content-type": "multipart/form-data; boundary=B" }];
}

const newTask = (service: Service, name = "任务") => service.task(service.create({ task_type: "srs-authoring", task_name: name }).task_id);

test("服务第一次启动时建出通用知识库；再次启动不重建", async () => {
  const service = fresh();
  const libs = service.knowledge!.libraries();
  assert.deepEqual(libs.map((l) => [l.id, l.name]), [[GENERAL, "通用知识库"]]);
  assert.equal(existsSync(join(service.knowledge!.root, GENERAL, "files")), true);
  const again = new Service(service.tasksDir, service.runsDir, {}, { knowledgeDir: service.knowledge!.root });
  assert.deepEqual(again.knowledge!.libraries(), libs);
  await service.close();
});

test("已有的清单里通用知识库还叫旧名「通用库」：服务启动时改成「通用知识库」并写回文件；用户自己起的名字不动；不留下临时文件", async () => {
  const root = join(tmp, `case-${++n}`);
  const dir = join(root, "knowledge");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "libraries.json");
  const rows = [{ id: GENERAL, name: "通用库", created_at: "2026-09-29T10:00:00+08:00" }, { id: "lib-a1", name: "通用库（旧项目）", created_at: "2026-09-29T11:00:00+08:00" }];
  writeFileSync(file, JSON.stringify({ version: 1, libraries: rows }), "utf-8");
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, knowledgeDir: dir });
  const renamed = [{ ...rows[0], name: "通用知识库" }, rows[1]];
  assert.deepEqual(service.knowledge!.libraries(), renamed);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { version: 1, libraries: renamed });
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  // 用户把通用知识库以外的知识库叫作「通用库」不受影响；通用知识库的名字已经是新名时不再改写文件
  const before = readFileSync(file, "utf-8");
  const again = new Service(service.tasksDir, service.runsDir, {}, { knowledgeDir: dir });
  assert.equal(readFileSync(file, "utf-8"), before);
  assert.deepEqual(again.knowledge!.libraries(), renamed);
  await service.close();
});

test("已有的清单文件损坏（读不出来）：服务照常启动，不改那个文件；知识库的清单接口到用的时候才出错", async () => {
  const root = join(tmp, `case-${++n}`);
  const dir = join(root, "knowledge");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "libraries.json");
  writeFileSync(file, '{"version": 1, "libraries": [{"id": "general", "name": "通用库"', "utf-8");   // 写到一半的 JSON
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, knowledgeDir: dir });
  assert.equal(readFileSync(file, "utf-8"), '{"version": 1, "libraries": [{"id": "general", "name": "通用库"');
  assert.equal(existsSync(join(dir, GENERAL, "files")), true);
  assert.throws(() => service.knowledge!.libraries(), SyntaxError);
  // 任务的接口不受影响：照常新建任务，它选用通用知识库
  assert.deepEqual(service.taskPage(newTask(service)).knowledge_libraries, [GENERAL]);
  await service.close();
});

test("新建知识库：名字空或与已有的重名（只差大小写或首尾空白也算）返回 rejected；编号由产品生成", async () => {
  const service = fresh();
  const store = service.knowledge!;
  const lib = store.create("  行业规范 ");
  assert.match(lib.id, /^lib-[0-9a-f]{8}$/);
  assert.equal(lib.name, "行业规范");
  const blank = rejected(() => store.create("  "));
  assert.deepEqual([blank.code, blank.status, blank.message], ["rejected", 422, "知识库的名字不能是空的。"]);
  store.create("Acme 资料");
  assert.equal(rejected(() => store.create("acme 资料")).message, "已经有一个叫「Acme 资料」的知识库了。");
  assert.equal(rejected(() => store.create("通用知识库")).message, "已经有一个叫「通用知识库」的知识库了。");
  await service.close();
});

test("改名：可以改成只差大小写的自己；通用知识库不能改名；与别的知识库重名拒绝", async () => {
  const service = fresh();
  const store = service.knowledge!;
  const a = store.create("abc");
  store.create("甲");
  assert.equal(store.rename(a.id, "ABC").name, "ABC");
  assert.equal(rejected(() => store.rename(a.id, "甲")).message, "已经有一个叫「甲」的知识库了。");
  const general = rejected(() => store.rename(GENERAL, "别的名字"));
  assert.deepEqual([general.code, general.message], ["rejected", "通用知识库不能改名。"]);
  assert.equal(rejected(() => store.rename("lib-none", "x")).code, "not_found");
  await service.close();
});

test("删除知识库：文档一并删除，选用了它的任务自动不再选用并记一句说明；通用知识库不能删除", async () => {
  const service = fresh();
  const store = service.knowledge!;
  const lib = store.create("行业规范");
  store.upload(lib.id, "规范.md", Buffer.from("应当写明上限。"), "standard");
  const t = newTask(service);
  service.setTaskKnowledge(t, { libraries: [GENERAL, lib.id] });
  assert.deepEqual(service.removeLibrary(lib.id), { ok: true, id: lib.id });
  assert.equal(existsSync(join(store.root, lib.id)), false);
  assert.deepEqual(store.libraries().map((l) => l.id), [GENERAL]);
  const saved = JSON.parse(readFileSync(join(t.dir, "knowledge.json"), "utf-8"));
  assert.deepEqual(saved.libraries, [GENERAL]);
  assert.equal(saved.notes.length, 1);
  assert.equal(saved.notes[0].text, "知识库「行业规范」已经删除，这个任务不再选用它。");
  const general = rejected(() => service.removeLibrary(GENERAL));
  assert.deepEqual([general.code, general.message], ["rejected", "通用知识库不能删除。"]);
  await service.close();
});

test("上传文档：类型、20 MB、同名、同内容、种类五项检查；被拒绝时不留下文件", async () => {
  const service = fresh();
  const store = service.knowledge!;
  const files = () => readdirSync(store.filesDir(GENERAL)).sort();
  assert.equal(rejected(() => store.upload(GENERAL, "规范.pdf", Buffer.from("x"), "standard")).code, "unsupported_type");
  const big = rejected(() => store.upload(GENERAL, "大.md", Buffer.alloc(KNOWLEDGE_MAX_UPLOAD + 1, 0x41), "other"));
  assert.deepEqual([big.code, big.status, big.message], ["too_large", 413, "单个文件不能超过 20 MB。"]);
  const bad = rejected(() => store.upload(GENERAL, "术语.md", Buffer.from("x"), "dictionary"));
  assert.deepEqual([bad.code, bad.message], ["bad_request", "资料的种类只能是「规范」、「术语表」、「模板」、「以往的成果」、「其他」之一。"]);
  // 超过材料的 5 MB 但不超过 20 MB 的文件照常保存。
  const row = store.upload(GENERAL, "术语表.md", Buffer.alloc(6 * 1024 * 1024, 0x42), "glossary");
  assert.deepEqual([row.name, row.kind, row.bytes], ["术语表.md", "glossary", 6 * 1024 * 1024]);
  const twin = rejected(() => store.upload(GENERAL, "副本.txt", Buffer.alloc(6 * 1024 * 1024, 0x42), "other"));
  assert.deepEqual([twin.code, twin.message, twin.data], ["duplicate_content", docDuplicateText("术语表.md"), { name: "术语表.md" }]);
  assert.equal(twin.message, "这份文件与这个知识库里已有的文档《术语表.md》内容完全相同，没有重复保存。");
  const taken = rejected(() => store.upload(GENERAL, " 术语表.MD", Buffer.from("别的内容"), "other"));
  assert.deepEqual([taken.code, taken.message], ["name_taken", docNameTakenText("术语表.md")]);
  assert.equal(taken.message, "这个知识库里已经有一份叫《术语表.md》的文档，内容与这份不同。请给文件换一个名字再上传。");
  assert.deepEqual(files(), ["术语表.md"]);
  // 同内容只在同一个知识库里比：放进别的知识库照常保存。
  const other = store.create("以往的成果");
  assert.equal(store.upload(other.id, "术语表.md", Buffer.alloc(6 * 1024 * 1024, 0x42), "past_work").name, "术语表.md");
  await service.close();
});

test("Word 文档生成投影、分段清单与位置表；派生文件不列在文档清单里；删除文档时一起删掉", async () => {
  const service = fresh();
  const store = service.knowledge!;
  store.upload(GENERAL, "编写指南.docx", readFileSync(SAMPLE), "standard");
  const files = readdirSync(store.filesDir(GENERAL)).sort();
  for (const name of ["编写指南.docx", "编写指南.docx.md", "编写指南.docx.segments.json", "编写指南.docx.locations.json"]) assert.ok(files.includes(name), name);
  assert.deepEqual(store.documents(GENERAL).map((d) => d.name), ["编写指南.docx"]);
  assert.match(store.text(GENERAL, "编写指南.docx"), /\[p1\]/);
  const segments = JSON.parse(readFileSync(join(store.filesDir(GENERAL), "编写指南.docx.segments.json"), "utf-8"));
  assert.match(JSON.stringify(segments), /general\/files\/编写指南\.docx/);
  store.removeDocument(GENERAL, "编写指南.docx");
  assert.deepEqual(readdirSync(store.filesDir(GENERAL)), []);
  assert.deepEqual(store.documents(GENERAL), []);
  assert.equal(rejected(() => store.removeDocument(GENERAL, "编写指南.docx")).code, "not_found");
  await service.close();
});

test("不是合法 .docx 的 Word 文件：拒绝，文件与派生文件都不留下，也不进清单", async () => {
  const service = fresh();
  const store = service.knowledge!;
  assert.equal(rejected(() => store.upload(GENERAL, "坏.docx", Buffer.from("不是压缩包"), "other")).code, "unsupported_type");
  assert.deepEqual(readdirSync(store.filesDir(GENERAL)), []);
  assert.deepEqual(store.documents(GENERAL), []);
  await service.close();
});

test("任务选用的知识库：新任务写 [general]；没有文件的旧任务按通用知识库算；改选用时通用知识库总在最前；不存在的知识库返回 rejected", async () => {
  const service = fresh();
  const t = newTask(service);
  assert.deepEqual(JSON.parse(readFileSync(join(t.dir, "knowledge.json"), "utf-8")), { version: 1, libraries: [GENERAL], notes: [] });
  assert.deepEqual(service.taskPage(t).knowledge_libraries, [GENERAL]);
  unlinkSync(join(t.dir, "knowledge.json"));
  assert.deepEqual(service.taskPage(t).knowledge_libraries, [GENERAL]);
  assert.equal(existsSync(join(t.dir, "knowledge.json")), false, "只是读，不写文件");
  const lib = service.knowledge!.create("行业规范");
  assert.deepEqual(service.setTaskKnowledge(t, { libraries: [lib.id] }), { ok: true, libraries: [GENERAL, lib.id] });
  assert.deepEqual(service.taskPage(t).knowledge_libraries, [GENERAL, lib.id]);
  const unknown = rejected(() => service.setTaskKnowledge(t, { libraries: ["lib-none"] }));
  assert.deepEqual([unknown.code, unknown.message], ["rejected", "没有这个知识库：lib-none。"]);
  assert.equal(rejected(() => service.setTaskKnowledge(t, { libraries: "general" })).code, "bad_request");
  await service.close();
});

test("used_by_tasks 只数本服务接手的进行中任务", async () => {
  const service = fresh();
  const lib = service.knowledge!.create("行业规范");
  const a = newTask(service, "甲");
  const b = newTask(service, "乙");
  service.setTaskKnowledge(a, { libraries: [lib.id] });
  service.setTaskKnowledge(b, { libraries: [lib.id] });
  const count = () => Object.fromEntries(service.knowledgeOverview().map((l) => [l.id, l.used_by_tasks]));
  assert.deepEqual(count(), { [GENERAL]: 2, [lib.id]: 2 });
  // 把乙改成已放弃：不再算。
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(b.dir, "task.sqlite"));
  db.exec("UPDATE task SET status = '已放弃'");
  db.close();
  assert.deepEqual(count(), { [GENERAL]: 1, [lib.id]: 1 });
  await service.close();
});

test("没有配置知识库：服务信息里 capabilities.knowledge 为假、不给 knowledge_upload，知识库接口一律 not_found", async () => {
  const service = fresh(false);
  const info = serviceInfo(service);
  assert.equal(info.capabilities.knowledge, false);
  assert.equal("knowledge_upload" in info, false);
  for (const [method, path] of [["GET", "/api/v1/knowledge"], ["POST", "/api/v1/knowledge/libraries"], ["GET", "/api/v1/tasks/TASK-X/knowledge"]]) {
    const r = await call(service, method, path, method === "POST" ? { name: "x" } : null);
    assert.equal(r.json.error.code, "not_found", path);
  }
  const t = newTask(service);
  const r = await call(service, "GET", `/api/v1/tasks/${t.taskId}/knowledge`);
  assert.deepEqual([r.status, r.json.error.message], [404, "这个服务没有配置知识库。"]);
  await service.close();
});

test("经接口：新建、改名、上传（带种类）、清单、正文与原样内容、删除文档、删除知识库、任务的选用", async () => {
  const service = fresh();
  const info = serviceInfo(service);
  assert.equal(info.capabilities.knowledge, true);
  assert.deepEqual(info.knowledge_upload.max_bytes, 20 * 1024 * 1024);
  assert.deepEqual(info.knowledge_upload.kinds.map((k: Dict) => k.name), ["规范", "术语表", "模板", "以往的成果", "其他"]);

  const created = await call(service, "POST", "/api/v1/knowledge/libraries", { name: "行业规范" });
  const id = created.json.library.id;
  assert.equal((await call(service, "POST", "/api/v1/knowledge/libraries", { name: "行业规范" })).status, 422);
  assert.equal((await call(service, "POST", `/api/v1/knowledge/libraries/${id}`, { name: "国家标准" })).json.library.name, "国家标准");

  const [body, headers] = multipart("评审检查单.md", Buffer.from("# 检查单\n每条需求都要可验证。\n"), { kind: "template" });
  const up = await call(service, "POST", `/api/v1/knowledge/libraries/${id}/documents`, body, headers);
  assert.equal(up.status, 200);
  assert.deepEqual(Object.keys(up.json.document), ["name", "kind", "bytes", "uploaded_at"]);
  assert.deepEqual([up.json.document.name, up.json.document.kind], ["评审检查单.md", "template"]);
  const [noKind, h2] = multipart("别的.md", Buffer.from("别的"));
  assert.equal((await call(service, "POST", `/api/v1/knowledge/libraries/${id}/documents`, noKind, h2)).json.error.code, "bad_request");

  const t = newTask(service);
  assert.deepEqual((await call(service, "POST", `/api/v1/tasks/${t.taskId}/knowledge`, { libraries: [GENERAL, id] })).json, { ok: true, libraries: [GENERAL, id] });
  // embedding 是这个任务选用的知识库的换算情况：这里没有选嵌入模型，那一份文档还没有换算。
  assert.deepEqual((await call(service, "GET", `/api/v1/tasks/${t.taskId}/knowledge`)).json,
    { ok: true, libraries: [GENERAL, id], embedding: { model: null, ready: false, pending: 1 } });
  assert.deepEqual((await call(service, "GET", `/api/v1/tasks/${t.taskId}`)).json.knowledge_libraries, [GENERAL, id]);

  const all = (await call(service, "GET", "/api/v1/knowledge")).json;
  assert.deepEqual(all.libraries.map((l: Dict) => [l.name, l.used_by_tasks, l.documents.map((d: Dict) => d.name)]), [["通用知识库", 1, []], ["国家标准", 1, ["评审检查单.md"]]]);

  const content = await call(service, "GET", `/api/v1/knowledge/libraries/${id}/documents/content?name=${encodeURIComponent("评审检查单.md")}`);
  assert.deepEqual(content.json, { ok: true, name: "评审检查单.md", text: "# 检查单\n每条需求都要可验证。\n" });
  const raw = await call(service, "GET", `/api/v1/knowledge/libraries/${id}/documents/raw?name=${encodeURIComponent("评审检查单.md")}`);
  assert.equal(raw.body.toString("utf-8"), "# 检查单\n每条需求都要可验证。\n");
  const escape = await call(service, "GET", `/api/v1/knowledge/libraries/${id}/documents/content?name=${encodeURIComponent("../documents.json")}`);
  assert.deepEqual([escape.status, escape.json.error.code], [400, "bad_request"]);
  const otherLib = await call(service, "GET", `/api/v1/knowledge/libraries/${GENERAL}/documents/content?name=${encodeURIComponent(`../${id}/files/评审检查单.md`)}`);
  assert.equal(otherLib.json.error.code, "bad_request", "路径必须落在那个知识库的 files/ 里");

  assert.deepEqual((await call(service, "POST", `/api/v1/knowledge/libraries/${id}/documents/delete`, { name: "评审检查单.md" })).json, { ok: true });
  assert.deepEqual((await call(service, "POST", `/api/v1/knowledge/libraries/${id}/delete`)).json, { ok: true, id });
  assert.deepEqual((await call(service, "GET", `/api/v1/tasks/${t.taskId}/knowledge`)).json.libraries, [GENERAL]);
  assert.equal((await call(service, "POST", `/api/v1/knowledge/libraries/${GENERAL}/delete`)).status, 422);
  await service.close();
});

test("经 HTTP：超过 20 MB 的知识库上传不读请求体就以 too_large 拒绝；没有的知识库先报 not_found", async () => {
  const service = fresh();
  const server = makeServer(service).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const port = (server.address() as AddressInfo).port;
  const send = (path: string, length: number) => new Promise<{ status: number; body: string }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Length": String(length), "Content-Type": "multipart/form-data; boundary=B" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", fail);
    req.end();
  });
  try {
    const big = await send(`/api/v1/knowledge/libraries/${GENERAL}/documents`, 21 * 1024 * 1024);
    assert.deepEqual([big.status, JSON.parse(big.body).error.message], [413, "单个文件不能超过 20 MB。"]);
    const missing = await send("/api/v1/knowledge/libraries/lib-none/documents", 21 * 1024 * 1024);
    assert.deepEqual([missing.status, JSON.parse(missing.body).error.code], [404, "not_found"]);
  } finally {
    server.close();
    await service.close();
  }
});
