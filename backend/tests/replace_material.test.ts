/**
 * 替换材料：用另一个文件换掉一份还没有进入对话的材料。旧文件连同由它生成的文件都没有了，新文件照上传的规矩收下
 * （Word 材料重新生成派生文件），名字与类型可以不同；先发 material_removed（带 replaced_by）再发 material_added（带 replaces）。
 * 前提与删除相同：已经进入对话的材料、助手正在工作时、任务已结束时、派生文件的路径一律拒绝。
 * 新文件没有存成（类型不符、超过上限、与别的材料重名或重内容、不是合法的 Word 文件）时旧文件原样还在，一条事件也不发。
 * 新文件是 PDF 时上传要等另起的一次运行生成派生文件：等的这段时间旧材料在暂放目录里，不在材料清单里。
 * 会话文件在这里直接写出来，不起助手。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { crc32 } from "node:zlib";
import { ApiError } from "../src/errors.ts";
import { dispatch, makeServer } from "../src/http.ts";
import { ENTERED_CONVERSATION_REPLACE_TEXT, MAX_UPLOAD, REPLACING_DIR, SAME_AS_REPLACED_TEXT, Service, TOO_LARGE_TEXT, unsupportedTypeText } from "../src/service.ts";
import { ROOT, captureConsole, sqlRun, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

type TaskOf = ReturnType<Service["task"]>;

async function withTask(body: (service: Service, t: TaskOf) => Promise<void> | void) {
  const root = join(tmp, `case-${++n}`);
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    await body(service, service.task(service.create({ task_type: "srs-authoring", task_name: "替换材料" }).task_id));
  } finally {
    await service.close();
  }
}

async function rejected(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("没有被拒绝");
}

/** 一份只有几段文字的 .docx（不压缩的 zip，只含 word/document.xml）。 */
function smallDocx(...paragraphs: string[]): Buffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  const data = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`, "utf8");
  const name = Buffer.from("word/document.xml", "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

const files = (t: { dir: string }) => readdirSync(join(t.dir, "inputs")).sort();
const read = (t: { dir: string }, name: string) => readFileSync(join(t.dir, "inputs", name), "utf-8");

/** 把订阅里已经到的事件全读出来，只留材料的两种，写成 [事件名, 数据去掉时刻]。 */
async function materialEvents(sub: { get(ms: number): Promise<unknown> }) {
  const out: [string, Record<string, unknown>][] = [];
  for (let item = await sub.get(10) as any; item; item = await sub.get(10) as any) {
    if (item[0] !== "material_added" && item[0] !== "material_removed") continue;
    const { at: _, ...data } = item[2];
    out.push([item[0], data]);
  }
  return out;
}

/** 每个文件的大小与修改时刻（子目录只记名字）：用来核对「原样还在」。 */
function stamps(t: { dir: string }) {
  return files(t).map((name) => {
    const st = statSync(join(t.dir, "inputs", name), { bigint: true });
    return st.isFile() ? `${name}:${st.size}:${st.mtimeNs}` : `${name}/`;
  });
}

/** 在任务的会话目录里写一条会话文件：开始时刻 start，之后在 messages 的每个时刻各有一条用户消息。 */
function writeSession(t: TaskOf, id: string, start: Date, messages: Date[] = []): void {
  const dir = t.executor.sessions.dir;
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session", id, timestamp: start.toISOString() },
    ...messages.map((at, i) => ({ type: "message", id: `${id}-m${i + 1}`, timestamp: at.toISOString(), message: { role: "user", content: "请整理。" } })),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

const at = (text: string) => new Date(text);
const leftover = (t: { dir: string }) => existsSync(join(t.dir, REPLACING_DIR));

test("用同名的另一份文件替换：内容是新的，先发 material_removed（带 replaced_by）再发 material_added（带 replaces），暂放目录不留", () => withTask(async (service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  service.upload(t, "补充.md", Buffer.from("补充说明。"));
  const [sub] = t.hub.subscribe(null, null);
  const reply = await service.replaceMaterial(t, "inputs/需求.md", "需求.md", Buffer.from("买家可以在七天内申请退货。"), "S1");
  assert.deepEqual(reply, { ok: true, path: "inputs/需求.md", replaced: "inputs/需求.md" });
  assert.deepEqual(files(t), ["补充.md", "需求.md"]);
  assert.equal(read(t, "需求.md"), "买家可以在七天内申请退货。");
  const st = statSync(join(t.dir, "inputs", "需求.md"), { bigint: true });
  assert.deepEqual(await materialEvents(sub), [
    ["material_removed", { session_id: "S1", path: "inputs/需求.md", replaced_by: "inputs/需求.md" }],
    ["material_added", { session_id: "S1", path: "inputs/需求.md", bytes: Number(st.size), modified_at: service.taskPage(t).materials.find((m: any) => m.path === "inputs/需求.md")!.modified_at, replaces: "inputs/需求.md" }],
  ]);
  assert.equal(leftover(t), false);
}));

test("替换 Word 材料：旧的投影、分段清单、位置表与图片目录都没有了，按新文件重新生成", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  assert.ok(files(t).includes("需求.docx.media"), "样本带图片，旧材料有图片目录");
  const oldProjection = read(t, "需求.docx.md");
  await service.replaceMaterial(t, "inputs/需求.docx", "需求.docx", smallDocx("新的第一段。", "新的第二段。"));
  assert.deepEqual(files(t), ["需求.docx", "需求.docx.locations.json", "需求.docx.md", "需求.docx.segments.json"]);
  const projection = read(t, "需求.docx.md");
  assert.notEqual(projection, oldProjection);
  assert.match(projection, /新的第一段。/);
  assert.match(read(t, "需求.docx.segments.json"), /inputs\/需求\.docx/);
  assert.deepEqual(service.taskPage(t).materials.filter((m: any) => m.derived_from === null).map((m: any) => [m.path, m.deletable]), [["inputs/需求.docx", true]]);
  assert.equal(leftover(t), false);
}));

test("改名与换类型：用一份 Markdown 替换 Word 材料，旧名下的文件一个不留，新文件按新名存；反过来换成 Word 材料时生成派生文件", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const [sub] = t.hub.subscribe(null, null);
  assert.deepEqual(await service.replaceMaterial(t, "inputs/需求.docx", "需求第二版.md", Buffer.from("# 第二版\n买家可以申请退货。\n")),
    { ok: true, path: "inputs/需求第二版.md", replaced: "inputs/需求.docx" });
  assert.deepEqual(files(t), ["需求第二版.md"]);
  const events = await materialEvents(sub);
  assert.deepEqual(events.map(([name, data]) => [name, data.path, data.replaced_by ?? data.replaces]), [
    ["material_removed", "inputs/需求.docx", "inputs/需求第二版.md"],
    ["material_added", "inputs/需求第二版.md", "inputs/需求.docx"],
  ]);
  await service.replaceMaterial(t, "inputs/需求第二版.md", "需求第三版.docx", smallDocx("第三版。"));
  assert.deepEqual(files(t), ["需求第三版.docx", "需求第三版.docx.locations.json", "需求第三版.docx.md", "需求第三版.docx.segments.json"]);
}));

test("0.2 的纯文本投影也随旧的 Word 材料一起换掉", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", smallDocx("旧的。"));
  writeFileSync(join(t.dir, "inputs", "需求.docx.txt"), "[第 1 段] 旧的。\n", "utf-8");
  await service.replaceMaterial(t, "inputs/需求.docx", "说明.md", Buffer.from("新的。"));
  assert.deepEqual(files(t), ["说明.md"]);
}));

test("新文件与被替换的那份内容完全相同：不换，说明写明没有替换，什么都不动", () => withTask(async (service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  const before = stamps(t);
  const [sub] = t.hub.subscribe(null, null);
  const same = await rejected(service.replaceMaterial(t, "inputs/需求.md", "换个名字.md", Buffer.from("买家可以申请退货。")));
  assert.deepEqual([same.code, same.message, same.data.path], ["duplicate_content", "新文件与这份材料内容完全相同，没有替换。", "inputs/需求.md"]);
  assert.equal(same.message, SAME_AS_REPLACED_TEXT);
  assert.deepEqual(stamps(t), before);
  assert.deepEqual(await materialEvents(sub), []);
}));

test("新文件没有存成时旧材料原样还在、不发事件：类型不符、超过上限、留用的名字、与别的材料重名或重内容、不是合法的 Word 文件", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  service.upload(t, "补充.md", Buffer.from("补充说明。"));
  const before = stamps(t);
  const [sub] = t.hub.subscribe(null, null);
  const attempt = (name: string, data: Buffer) => rejected(service.replaceMaterial(t, "inputs/需求.docx", name, data));
  const wrongType = await attempt("需求.xlsx", Buffer.from("x"));
  assert.deepEqual([wrongType.code, wrongType.message], ["unsupported_type", unsupportedTypeText()]);
  const tooLarge = await attempt("需求.md", Buffer.alloc(MAX_UPLOAD + 1));
  assert.deepEqual([tooLarge.code, tooLarge.message], ["too_large", TOO_LARGE_TEXT]);
  assert.equal((await attempt("别的.docx.md", Buffer.from("x"))).code, "bad_request");
  assert.equal((await attempt("a/b.md", Buffer.from("x"))).code, "bad_request");
  const nameTaken = await attempt("补充.md", Buffer.from("另一份补充。"));
  assert.deepEqual([nameTaken.code, nameTaken.data.path], ["name_taken", "inputs/补充.md"]);
  const sameContent = await attempt("又一份.md", Buffer.from("补充说明。"));
  assert.deepEqual([sameContent.code, sameContent.data.path], ["duplicate_content", "inputs/补充.md"]);
  const notWord = await attempt("需求.docx", Buffer.from("这不是 Word 文件"));
  assert.equal(notWord.code, "unsupported_type");
  assert.match(notWord.message, /请用 Word 另存为 \.docx 后再上传。$/);
  assert.deepEqual(stamps(t), before);
  assert.deepEqual(await materialEvents(sub), []);
  assert.equal(leftover(t), false);
  // 旧材料照旧可以看、可以再换
  assert.deepEqual(service.taskPage(t).materials.filter((m: any) => m.derived_from === null).map((m: any) => m.path), ["inputs/补充.md", "inputs/需求.docx"]);
  await service.replaceMaterial(t, "inputs/需求.docx", "需求.md", Buffer.from("换成功了。"));
  assert.deepEqual(files(t), ["补充.md", "需求.md"]);
}));

test("已经进入对话的材料不能替换：说明请用户上传一份新材料并告诉助手以新的为准，文件原样还在", () => withTask(async (service, t) => {
  const { path } = service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  const uploaded = at("2026-09-30T10:00:00.000Z");
  utimesSync(join(t.dir, path), uploaded, uploaded);
  writeSession(t, "S1", at("2026-09-30T10:05:00.000Z"), [at("2026-09-30T10:05:30.000Z")]);
  const before = stamps(t);
  const refused = await rejected(service.replaceMaterial(t, path, "需求.md", Buffer.from("新的内容。")));
  assert.deepEqual([refused.code, refused.status, refused.message],
    ["rejected", 422, "这份材料已经进入了对话，不能替换；请上传一份新材料，并告诉助手以新的为准。"]);
  assert.equal(refused.message, ENTERED_CONVERSATION_REPLACE_TEXT);
  assert.deepEqual(refused.data, { path, reasons: [ENTERED_CONVERSATION_REPLACE_TEXT] });
  assert.deepEqual(stamps(t), before);
}));

test("替换上来的文件从替换那一刻算起：此前的会话活动不算它进入了对话，之后有会话活动才算", () => withTask(async (service, t) => {
  writeSession(t, "S1", at("2026-09-30T09:00:00.000Z"), [at("2026-09-30T09:01:00.000Z")]);
  const { path } = service.upload(t, "需求.md", Buffer.from("旧的。"));
  await service.replaceMaterial(t, path, "需求.md", Buffer.from("新的。"));
  assert.deepEqual(service.taskPage(t).materials.map((m: any) => [m.path, m.deletable]), [[path, true]]);
  writeSession(t, "S1", at("2026-09-30T09:00:00.000Z"), [at("2026-09-30T09:01:00.000Z"), new Date(Date.now() + 1000)]);
  assert.deepEqual(service.taskPage(t).materials.map((m: any) => [m.path, m.deletable]), [[path, false]]);
  assert.equal((await rejected(service.replaceMaterial(t, path, "需求.md", Buffer.from("更新的。")))).code, "rejected");
  assert.equal(read(t, "需求.md"), "新的。");
}));

test("派生文件的路径、材料目录之外的路径、不存在的材料、助手正在工作、任务已结束：一律拒绝，什么都不动", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const before = stamps(t);
  const data = Buffer.from("新的。");
  const derived = await rejected(service.replaceMaterial(t, "inputs/需求.docx.md", "新.md", data));
  assert.deepEqual([derived.code, derived.message], ["bad_request", "这是由别的材料生成的文件，不能单独替换。"]);
  assert.equal((await rejected(service.replaceMaterial(t, "task.sqlite", "新.md", data))).code, "bad_request");
  assert.equal((await rejected(service.replaceMaterial(t, "", "新.md", data))).code, "bad_request");
  assert.equal((await rejected(service.replaceMaterial(t, "inputs/没有.md", "新.md", data))).code, "not_found");
  t.executor.state = "working";
  try {
    const busy = await rejected(service.replaceMaterial(t, "inputs/需求.docx", "新.md", data));
    assert.deepEqual([busy.code, busy.status, busy.message, busy.data.reason], ["session_busy", 409, "助手正在工作，结束后才能替换材料。", "working"]);
  } finally {
    t.executor.state = "not_started";
  }
  sqlRun(t.dir, [["UPDATE task SET status = '已完成'"]]);
  assert.equal((await rejected(service.replaceMaterial(t, "inputs/需求.docx", "新.md", data))).code, "task_closed");
  assert.deepEqual(stamps(t), before);
}));

// ───────────── PDF 材料 ─────────────

const PDF = readFileSync(join(ROOT, "backend", "tests", "fixtures", "pdf", "multipage.pdf"));

test("把 Word 材料替换成 PDF：旧名下的文件一个不留，PDF 连同投影、分段清单与位置表都在，两条事件的先后与字段照旧", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const [sub] = t.hub.subscribe(null, null);
  assert.deepEqual(await service.replaceMaterial(t, "inputs/需求.docx", "办法.pdf", PDF, "S1"), { ok: true, path: "inputs/办法.pdf", replaced: "inputs/需求.docx" });
  assert.deepEqual(files(t), ["办法.pdf", "办法.pdf.locations.json", "办法.pdf.md", "办法.pdf.segments.json"]);
  const events = await materialEvents(sub);
  assert.deepEqual(events.map(([name, data]) => [name, data.path, data.replaced_by ?? data.replaces]), [
    ["material_removed", "inputs/需求.docx", "inputs/办法.pdf"],
    ["material_added", "inputs/办法.pdf", "inputs/需求.docx"],
  ]);
  assert.ok(events[1][1].pdf, "PDF 材料的 material_added 照旧带 pdf 一项");
  assert.deepEqual(readdirSync(t.dir).filter((name) => name.startsWith(".replacing") || name.startsWith(".uploading")), []);
}));

test("把 PDF 材料替换成别的文件：PDF 的投影、分段清单与位置表随它一起换掉", () => withTask(async (service, t) => {
  await service.upload(t, "办法.pdf", PDF);
  service.upload(t, "补充.md", Buffer.from("补充说明。"));
  await service.replaceMaterial(t, "inputs/办法.pdf", "办法.md", Buffer.from("# 办法\n读者凭借书证借书。\n"));
  assert.deepEqual(files(t), ["办法.md", "补充.md"]);
}));

test("替换成一份读不出来的 PDF：旧材料原样还在，不发事件，两个临时目录都不留", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const before = stamps(t);
  const [sub] = t.hub.subscribe(null, null);
  const broken = await rejected(service.replaceMaterial(t, "inputs/需求.docx", "坏的.pdf", Buffer.from("这不是一份 PDF")));
  assert.equal(broken.code, "unsupported_type");
  assert.deepEqual(stamps(t), before);
  assert.deepEqual(await materialEvents(sub), []);
  assert.deepEqual(readdirSync(t.dir).filter((name) => name.startsWith(".replacing") || name.startsWith(".uploading")), []);
}));

test("PDF 还在生成派生文件的时候：旧材料在暂放目录里、不在材料清单里；生成好了清单里是新材料", () => withTask(async (service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  const pending = service.replaceMaterial(t, "inputs/需求.md", "办法.pdf", PDF);
  assert.deepEqual(service.taskPage(t).materials.map((m: any) => m.path), []);
  assert.equal(leftover(t), true);
  assert.equal((await rejected(service.replaceMaterial(t, "inputs/需求.md", "又一份.md", Buffer.from("x")))).code, "not_found");
  await pending;
  assert.deepEqual(service.taskPage(t).materials.filter((m: any) => m.derived_from === null).map((m: any) => m.path), ["inputs/办法.pdf"]);
  assert.equal(leftover(t), false);
}));

function multipart(filename: string, data: Buffer): [Buffer, Record<string, string>] {
  const head = Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return [Buffer.concat([head, data, Buffer.from("\r\n--B--\r\n")]), { "content-type": "multipart/form-data; boundary=B" }];
}

test("经接口 POST …/materials/replace?path=…：新文件照上传的格式放在请求体里；被拒绝时回的是接口约定的错误体", () => withTask(async (service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  const call = async (path: string, name: string, data: Buffer) => {
    const [body, headers] = multipart(name, data);
    return (await dispatch(service, { method: "POST", path: `/api/v1/tasks/${t.taskId}/materials/replace`, query: { path }, headers, body })) as any;
  };
  const ok = await call("inputs/需求.md", "需求第二版.md", Buffer.from("买家可以在七天内申请退货。"));
  assert.deepEqual([ok.status, JSON.parse(ok.body.toString())], [200, { ok: true, path: "inputs/需求第二版.md", replaced: "inputs/需求.md" }]);
  assert.deepEqual(files(t), ["需求第二版.md"]);
  const missing = await call("inputs/需求.md", "又一版.md", Buffer.from("x"));
  assert.deepEqual([missing.status, JSON.parse(missing.body.toString()).error.code], [404, "not_found"]);
  const noPath = await call("", "又一版.md", Buffer.from("x"));
  assert.deepEqual([noPath.status, JSON.parse(noPath.body.toString()).error.code], [400, "bad_request"]);
  assert.deepEqual(files(t), ["需求第二版.md"]);
}));

test("经 HTTP：超过上限的替换请求不读请求体就以 too_large 拒绝；没有的任务先报 not_found", () => withTask(async (service, t) => {
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
    // 请求体一个字节也不发：服务要是等着读它，就一直不回答，这里两秒之后算失败。
    req.setTimeout(2000, () => req.destroy(new Error("服务在等请求体，没有先拒绝")));
    req.end();
  });
  try {
    const big = await send(`/api/v1/tasks/${t.taskId}/materials/replace?path=inputs/a.md`, 6 * 1024 * 1024);
    assert.deepEqual([big.status, JSON.parse(big.body).error.message], [413, TOO_LARGE_TEXT]);
    const missing = await send("/api/v1/tasks/T-none/materials/replace?path=inputs/a.md", 6 * 1024 * 1024);
    assert.equal(JSON.parse(missing.body).error.code === "too_large", false);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
}));
