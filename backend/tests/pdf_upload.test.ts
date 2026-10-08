/**
 * 上传 PDF 材料：另起一次运行生成投影、分段清单与位置表，四个文件一起进材料目录；整份没有可读的文字、不是合法的 PDF、设了口令、
 * 到时限没有做完的都拒绝，材料目录里什么都不留、不发「新加了材料」的事件；材料清单把三个派生文件标成由这份 PDF 生成，
 * PDF 材料带页数、块数与没有文字的页；派生文件的名字是留用的；重内容与重名照别的材料一样拒绝；删除时四个文件一起删。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { RAW_TYPES, withAttachments } from "../src/http.ts";
import { GENERAL } from "../src/knowledge.ts";
import { PDF_RUN_DEFAULTS } from "../src/launch.ts";
import * as library from "../src/library.ts";
import { PDF_NO_TEXT, PdfUploadError, runPdfProjection } from "../src/pdf_upload.ts";
import { reservedNameText } from "../src/projection.ts";
import { Service, UPLOADING_DIR, UPLOAD_TYPES, unsupportedTypeText } from "../src/service.ts";
import { SEGMENT_DEFAULTS } from "../../agent/src/lib/segments.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "pdf");
const sample = (name: string) => readFileSync(join(SAMPLES, name));
/** 一份只有一页空白页的 PDF：整份一个块都没有。 */
const BLANK = Buffer.from([
  "%PDF-1.4", "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj", "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj", "trailer<</Root 1 0 R>>", "%%EOF", "",
].join("\n"), "latin1");

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

async function withTask(body: (service: Service, t: ReturnType<Service["task"]>) => Promise<void>, profile: Record<string, unknown> = {}) {
  const root = join(tmp, `case-${++n}`);
  const service = new Service(join(root, "tasks"), join(root, "runs"), profile, { port: 1, knowledgeDir: join(root, "knowledge") });
  try {
    await body(service, service.task(service.create({ task_type: "srs-authoring", task_name: "PDF 材料" }).task_id));
  } finally {
    await service.close();
  }
}

async function rejected(promise: unknown): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("没有被拒绝");
}

const files = (t: { dir: string }) => readdirSync(join(t.dir, "inputs")).sort();
/** 被拒之后什么都不留：材料目录是空的，临时目录不在了。 */
const nothingLeft = (t: { dir: string }) => assert.deepEqual([files(t), existsSync(join(t.dir, UPLOADING_DIR))], [[], false]);
async function addedEvents(t: ReturnType<Service["task"]>, body: () => Promise<unknown>) {
  const [sub] = t.hub.subscribe(null, null);
  await body();
  const out: Record<string, any>[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "material_added") out.push(item[2]);
  return out;
}

test("上传 PDF：四个文件一起进材料目录，清单标出派生文件并带页数、块数与没有文字的页；材料原文给投影；发一条事件", () => withTask(async (service, t) => {
  assert.ok(UPLOAD_TYPES.includes(".pdf"));
  assert.equal(unsupportedTypeText(), "只接受 .md、.txt、Word 的 .docx 与 PDF 文件。");
  assert.equal(RAW_TYPES[".pdf"], "application/pdf");
  const events = await addedEvents(t, async () => {
    assert.deepEqual(await service.upload(t, "办法.pdf", sample("multipage.pdf")), { ok: true, path: "inputs/办法.pdf" });
  });
  assert.deepEqual(files(t), ["办法.pdf", "办法.pdf.locations.json", "办法.pdf.md", "办法.pdf.segments.json"]);
  assert.equal(existsSync(join(t.dir, UPLOADING_DIR)), false, "临时目录用完就删");
  const rows = library.materials(t.dir, t.definition()) as Record<string, any>[];
  assert.deepEqual(rows.map((m) => [m.path, m.derived_from]), [["inputs/办法.pdf", null], ["inputs/办法.pdf.locations.json", "inputs/办法.pdf"],
    ["inputs/办法.pdf.md", "inputs/办法.pdf"], ["inputs/办法.pdf.segments.json", "inputs/办法.pdf"]]);
  const facts = rows[0].pdf;
  assert.deepEqual([facts.pages, facts.no_text_pages], [3, []]);
  assert.ok(facts.units > 3, `块数 ${facts.units}`);
  assert.ok(rows.slice(1).every((m) => !("pdf" in m)), "派生文件不带这一项");
  // 派生文件里记的是它在材料目录里的路径，不是临时目录里的。
  const projection = readFileSync(join(t.dir, "inputs", "办法.pdf.md"), "utf-8");
  assert.match(projection, /由 办法\.pdf 生成，供助手阅读。页数：3。/);
  assert.equal(JSON.parse(readFileSync(join(t.dir, "inputs", "办法.pdf.locations.json"), "utf-8")).source, "inputs/办法.pdf");
  assert.equal(JSON.parse(readFileSync(join(t.dir, "inputs", "办法.pdf.segments.json"), "utf-8")).projection, "inputs/办法.pdf.md");
  assert.doesNotMatch(projection + readFileSync(join(t.dir, "inputs", "办法.pdf.segments.json"), "utf-8"), /\.uploading/);
  assert.equal(service.materialText(join(t.dir, "inputs", "办法.pdf"), "inputs/办法.pdf"), projection);
  assert.deepEqual(events.map((e) => [e.path, e.pdf]), [["inputs/办法.pdf", facts]]);
  // 整份任务数据里的材料清单同样带着。
  const listed = service.taskPage(t).materials.find((m: Record<string, any>) => m.path === "inputs/办法.pdf") as Record<string, any>;
  assert.deepEqual(listed.pdf, facts);
}));

test("部分页没有文字的 PDF 收下，清单写明是哪几页；整份没有可读文字的拒绝，什么都不留", () => withTask(async (service, t) => {
  await service.upload(t, "登记表.pdf", sample("scanned.pdf"));
  const [row] = library.materials(t.dir, t.definition()) as Record<string, any>[];
  assert.deepEqual([row.pdf.pages, row.pdf.no_text_pages], [3, [2, 3]]);
  assert.match(readFileSync(join(t.dir, "inputs", "登记表.pdf.md"), "utf-8"), /\[p3-0\] （这一页没有文字，可能是扫描件）/);
  service.deleteMaterial(t, "inputs/登记表.pdf");
  const events = await addedEvents(t, async () => {
    const e = await rejected(service.upload(t, "空白.pdf", BLANK));
    assert.deepEqual([e.code, e.message], ["unsupported_type", PDF_NO_TEXT]);
  });
  assert.equal(PDF_NO_TEXT, "这份 PDF 没有可读的文字（可能是扫描件），本版不支持。");
  assert.deepEqual(events, []);
  nothingLeft(t);
}));

test("不是合法的 PDF、设了口令的、到时限没有做完的：拒绝并说明，什么都不留", () => withTask(async (service, t) => {
  const broken = await rejected(service.upload(t, "坏的.pdf", Buffer.from("这不是一份 PDF")));
  assert.equal(broken.code, "unsupported_type");
  assert.match(broken.message, /PDF/);
  nothingLeft(t);
  const locked = await rejected(service.upload(t, "加密.pdf", sample("locked.pdf")));
  assert.equal(locked.code, "unsupported_type");
  assert.match(locked.message, /口令/);
  nothingLeft(t);
}));

test("解析的上限从启动配置来：超过页数上限的说明页数；到时限的说明用了多久、读到第几页，与没有文字的拒绝是两句话", async () => {
  await withTask(async (service, t) => {
    const e = await rejected(service.upload(t, "办法.pdf", sample("multipage.pdf")));
    assert.deepEqual([e.code, e.message], ["unsupported_type", "这份 PDF 有 3 页，超过上限 2 页。"]);
    nothingLeft(t);
  }, { "PDF 解析": { max_pages: 2 } });
  // 解析库自己的时限（每读完一页检查一次）。
  await withTask(async (service, t) => {
    const e = await rejected(service.upload(t, "办法.pdf", sample("multipage.pdf")));
    assert.equal(e.code, "unsupported_type");
    assert.match(e.message, /^解析用了 [\d.]+ 秒仍没有完成（共 3 页，第 1 页还没有读完），这份文件太复杂，本版不支持。$/);
    assert.notEqual(e.message, PDF_NO_TEXT);
    nothingLeft(t);
  }, { "PDF 解析": { max_seconds: 0.000001 } });
  // 外面强行停下：那一次运行还没有来得及做完。
  await withTask(async (service, t) => {
    const e = await rejected(service.upload(t, "办法.pdf", sample("multipage.pdf")));
    assert.equal(e.code, "unsupported_type");
    assert.match(e.message, /^解析用了 [\d.]+ 秒仍没有完成(（.*）)?，这份文件太复杂，本版不支持。$/);
    nothingLeft(t);
  }, { "PDF 解析": { stop_after_seconds: 0.001 } });
});

test("另起的那一次运行：结果里有页数与块数；命令行入口不在时说明没有做成", async () => {
  const dir = join(tmp, `run-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "表.pdf"), sample("table.pdf"));
  const parsed = await runPdfProjection(join(dir, "表.pdf"), "inputs/表.pdf", { heading_depth: 2, min_paragraphs: 5, max_paragraphs: 40 });
  assert.deepEqual([parsed.pages, parsed.no_text_pages], [1, []]);
  assert.ok(parsed.units >= 3 && parsed.chars > 0);
  await assert.rejects(runPdfProjection(join(dir, "表.pdf"), "inputs/表.pdf", SEGMENT_DEFAULTS, PDF_RUN_DEFAULTS, join(dir, "没有这个入口.mjs")),
    (error: unknown) => error instanceof PdfUploadError && /没有做成/.test((error as Error).message));
});

test("派生文件的名字是留用的；重内容、重名照别的材料一样拒绝；两个请求同时上传同一份只存下一份", () => withTask(async (service, t) => {
  for (const name of ["x.pdf.md", "x.PDF.segments.json", "x.pdf.locations.json"]) {
    const e = await rejected((async () => service.upload(t, name, Buffer.from("x")))());
    assert.equal(e.message, name.endsWith(".md") ? reservedNameText("材料") : unsupportedTypeText(), name);
  }
  const both = await Promise.allSettled([service.upload(t, "办法.pdf", sample("multipage.pdf")), service.upload(t, "办法（副本）.pdf", sample("multipage.pdf"))]);
  assert.deepEqual(both.map((one) => one.status).sort(), ["fulfilled", "rejected"]);
  const refused = both.find((one) => one.status === "rejected") as PromiseRejectedResult;
  assert.equal((refused.reason as ApiError).code, "duplicate_content");
  assert.equal(files(t).filter((name) => name.endsWith(".pdf")).length, 1);
  assert.equal(files(t).length, 4);
  assert.equal(existsSync(join(t.dir, UPLOADING_DIR)), false);
  const kept = files(t).find((name) => name.endsWith(".pdf"))!;
  assert.equal((await rejected(service.upload(t, "又一份.pdf", sample("multipage.pdf")))).code, "duplicate_content");
  assert.equal((await rejected(service.upload(t, kept, sample("table.pdf")))).code, "name_taken");
  assert.equal(files(t).length, 4);
}));

test("删除 PDF 材料：投影、分段清单与位置表一起删；派生文件不能单独删", () => withTask(async (service, t) => {
  await service.upload(t, "表.pdf", sample("table.pdf"));
  const e = await rejected((async () => service.deleteMaterial(t, "inputs/表.pdf.md"))());
  assert.deepEqual([e.code, e.message], ["bad_request", "这是由别的材料生成的文件，不能单独删除。"]);
  assert.deepEqual(service.deleteMaterial(t, "inputs/表.pdf"), { ok: true, path: "inputs/表.pdf" });
  assert.deepEqual(files(t), []);
}));

test("用户附了 PDF 材料：给助手的那句话写明读哪份投影、出处怎么写", () => {
  assert.equal(withAttachments("看看这份", ["inputs/办法.pdf"]),
    "看看这份\n（我上传了材料：inputs/办法.pdf；其中 PDF 文件请读同名的 .md 投影（inputs/办法.pdf.md），引用时出处写 PDF 文件加页与块，例如 inputs/办法.pdf#p3-2）");
  assert.equal(withAttachments("看看", ["inputs/a.docx", "inputs/b.pdf", "inputs/c.md"]),
    "看看\n（我上传了材料：inputs/a.docx、inputs/b.pdf、inputs/c.md；其中 Word 文件请读同名的 .md 投影（inputs/a.docx.md），引用时出处写 Word 文件加段落号；"
    + "PDF 文件请读同名的 .md 投影（inputs/b.pdf.md），引用时出处写 PDF 文件加页与块，例如 inputs/b.pdf#p3-2）");
  assert.equal(withAttachments("看看", ["inputs/c.md"]), "看看\n（我上传了材料：inputs/c.md）");
});

test("知识库上传 PDF 文档：同样四个文件一起进文档目录、整份没有文字的拒绝、派生文件名留用、重内容拒绝、删除时一起删、读正文给投影", () => withTask(async (service) => {
  const store = service.knowledge!;
  const listed = () => readdirSync(store.filesDir(GENERAL)).sort();
  const row = await service.uploadDocument(GENERAL, "办法.pdf", sample("multipage.pdf"), "standard");
  assert.deepEqual([row.name, row.kind], ["办法.pdf", "standard"]);
  assert.deepEqual(listed(), ["办法.pdf", "办法.pdf.locations.json", "办法.pdf.md", "办法.pdf.segments.json"]);
  assert.deepEqual(store.documents(GENERAL).map((one) => one.name), ["办法.pdf"], "清单里只有文档本身");
  assert.equal(existsSync(join(store.filesDir(GENERAL), "..", UPLOADING_DIR)), false);
  const projection = readFileSync(join(store.filesDir(GENERAL), "办法.pdf.md"), "utf-8");
  assert.equal(store.text(GENERAL, "办法.pdf"), projection);
  assert.equal(JSON.parse(readFileSync(join(store.filesDir(GENERAL), "办法.pdf.locations.json"), "utf-8")).source, `${GENERAL}/files/办法.pdf`);
  const blank = await rejected(service.uploadDocument(GENERAL, "空白.pdf", BLANK, "other"));
  assert.deepEqual([blank.code, blank.message], ["unsupported_type", PDF_NO_TEXT]);
  assert.equal((await rejected(service.uploadDocument(GENERAL, "又一份.pdf", sample("multipage.pdf"), "other"))).code, "duplicate_content");
  const reserved = await rejected(service.uploadDocument(GENERAL, "x.pdf.md", Buffer.from("x"), "other"));
  assert.deepEqual([reserved.code, reserved.message], ["bad_request", reservedNameText("文档")]);
  assert.equal(listed().length, 4);
  assert.deepEqual(store.documents(GENERAL).length, 1);
  service.removeDocument(GENERAL, "办法.pdf");
  assert.deepEqual(listed(), []);
}));
