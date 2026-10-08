/**
 * 条目导出 Word（src/export_docx.ts 与下载接口的 docx 一路）：导出每个条目最新的修订，已删除的不导出；按集合分段、集合名作标题 1，
 * 每个条目一行标题 2 加一张两列表；文本列表每项一段带序号，别的多值用顿号，空字段写「（空）」；带来源时末行是来源，一条一段；
 * 字体、表格样式、文件名；接口的各种拒绝。生成的文件用 jszip 解开看里面的 XML（docx 包自己就依赖 jszip）。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import JSZip from "jszip";
import { ApiError } from "../src/errors.ts";
import { DOCX_MISSING_TEXT, DOCX_TYPE, docxDisposition, docxFileName, docxRequest, exportItemsDocx, sourceLine, valueLines } from "../src/export_docx.ts";
import { dispatch } from "../src/http.ts";
import * as library from "../src/library.ts";
import { sourceEntries, sourcesText } from "../src/render.ts";
import { Service } from "../src/service.ts";
import { captureConsole, makeTypedTask, sqlRun, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "读者凭口令登录。" };
/** 三批：先加一条领域说明与两个用例，再加一条非功能需求，最后删掉那条非功能需求。 */
const BATCHES = [
  [
    { op: "add", collection: "领域说明", fields: { 标题: "口令", 内容: "读者登录时输入的一串字符", 类别: "术语" }, sources: [SOURCE] },
    { op: "add", collection: "功能用例", fields: { 用例名称: "登录", 用例功能: "读者登录系统。", 参与者: ["读者", "管理员"], 基本流程: ["输入口令", "系统核对口令"] },
      sources: [{ ...SOURCE, supports: [{ field: "用例功能" }] }, { kind: "助手补充", excerpt: "登录失败的处理材料没有写，按常识补充。", supports: [{ field: "基本流程", index: 1 }] }] },
    { op: "add", collection: "功能用例", fields: { 用例名称: "借出图书", 用例功能: "读者在服务台借出图书。", 参与者: ["读者"], 基本流程: ["管理员扫描借书证"] }, sources: [SOURCE] },
  ],
  [{ op: "add", collection: "非功能需求", fields: { 类别: "性能", 句式类型: "普遍型", 需求语句: "系统应在 2 秒内给出登录结果。" }, sources: [SOURCE] }],
  [{ op: "delete", item: "NFR-001", base_revision: 2 }],
];

let ws: string;
let lib: library.Library;
before(() => {
  ws = makeTypedTask(tmp, "srs-authoring", { "材料.md": "读者凭口令登录。管理员在服务台办理借还。" }, BATCHES);
  lib = library.libraryOf(ws);
});

/** 解开 .docx，返回正文与样式表两份 XML。 */
async function unpack(data: Buffer): Promise<{ document: string; styles: string }> {
  const zip = await JSZip.loadAsync(data);
  return { document: await zip.file("word/document.xml")!.async("string"), styles: await zip.file("word/styles.xml")!.async("string") };
}
const unescape = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
/** 一截 XML 里各段的文字。 */
const paragraphs = (xml: string) => [...xml.matchAll(/<w:p>.*?<\/w:p>|<w:p\/>/gs)].map((p) => [...p[0].matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((t) => unescape(t[1])).join(""));
/** 正文里某种标题样式的各段文字。 */
const headings = (xml: string, style: string) => [...xml.matchAll(/<w:p>.*?<\/w:p>/gs)].filter((p) => p[0].includes(`<w:pStyle w:val="${style}"/>`)).map((p) => paragraphs(p[0])[0]);
/** 正文里的各张表：每张表是各行，每行是 [左格各段, 右格各段]。 */
const tables = (xml: string) => [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)].map((t) =>
  [...t[0].matchAll(/<w:tr>.*?<\/w:tr>/gs)].map((r) => [...r[0].matchAll(/<w:tc>.*?<\/w:tc>/gs)].map((c) => paragraphs(c[0]))));
const expectApiError = async (run: () => unknown, pattern: RegExp) =>
  assert.rejects(async () => run(), (e: unknown) => e instanceof ApiError && e.code === "bad_request" && pattern.test(e.message));

test("三个条目跨两个集合：两个标题 1、三个标题 2、三张两列表，集合照任务定义的先后，条目按编号", async () => {
  // 交来的先后是乱的，文档里照集合与编号排。
  const file = await exportItemsDocx(lib, ["DN-001", "UC-002", "UC-001"], true, null, null, new Date(2026, 9, 8));
  assert.equal(file.data.subarray(0, 2).toString("latin1"), "PK");
  // 这个任务没有另起任务名，文件名里用任务类型定义里的名字。
  assert.equal(file.fileName, `${lib.definition["任务名"]}-条目-2026-10-08.docx`);
  const { document } = await unpack(file.data);
  assert.deepEqual(headings(document, "Heading1"), ["功能用例", "领域说明"]);
  assert.deepEqual(headings(document, "Heading2"), ["UC-001 登录", "UC-002 借出图书", "DN-001 口令"]);
  const all = tables(document);
  assert.equal(all.length, 3);
  for (const table of all) for (const row of table) assert.equal(row.length, 2);
  // 功能用例声明了 8 个字段，加一行来源；领域说明 4 个字段，加一行来源。字段照声明的先后。
  assert.deepEqual(all[0].map((row) => row[0][0]), ["用例名称", "用例功能", "参与者", "前置条件", "后置条件", "约束规则", "基本流程", "扩展流程", "来源"]);
  assert.deepEqual(all[2].map((row) => row[0][0]), ["标题", "内容", "类别", "关联条目", "来源"]);
});

test("字段值的写法：文本列表每项一段带序号，空字段写「（空）」；来源一条一段，写成「种类 · 出处：摘录」", async () => {
  const { document } = await unpack((await exportItemsDocx(lib, ["UC-001", "DN-001"], true)).data);
  const [useCase, note] = tables(document).map((table) => Object.fromEntries(table.map((row) => [row[0][0], row[1]])));
  assert.deepEqual(useCase["用例功能"], ["读者登录系统。"]);
  assert.deepEqual(useCase["参与者"], ["1. 读者", "2. 管理员"]);
  assert.deepEqual(useCase["基本流程"], ["1. 输入口令", "2. 系统核对口令"]);
  assert.deepEqual(useCase["扩展流程"], ["（空）"]);
  // 助手补充没有出处，只写种类与摘录（摘录是理由）。
  assert.deepEqual(useCase["来源"], ["文档原文 · inputs/材料.md：读者凭口令登录。", "助手补充：登录失败的处理材料没有写，按常识补充。"]);
  assert.deepEqual(note["关联条目"], ["（空）"]);
  assert.deepEqual(note["来源"], ["文档原文 · inputs/材料.md：读者凭口令登录。"]);
  assert.deepEqual(valueLines(["UC-001", "UC-002"], "条目引用"), ["UC-001、UC-002"]);
  assert.deepEqual(valueLines(["甲", "乙"], "枚举"), ["甲、乙"]);
  assert.deepEqual(valueLines("第一行\n\n第二行", "文本"), ["第一行", "第二行"]);
  assert.deepEqual([valueLines(null, "文本"), valueLines("", "文本"), valueLines([], "文本列表")], [["（空）"], ["（空）"], ["（空）"]]);
});

test("不带来源时表里没有来源一行；条目没有来源时写「（无）」", async () => {
  const { document } = await unpack((await exportItemsDocx(lib, ["UC-001", "DN-001"], false)).data);
  const labels = tables(document).flatMap((table) => table.map((row) => row[0][0]));
  assert.ok(!labels.includes("来源"));
  assert.ok(!document.includes("读者凭口令登录。"));
  // 把 UC-002 的来源从读到的数据里拿掉，看没有来源时的写法。
  const db = library.openRo(ws)!;
  let data;
  try {
    data = library.readAll(db);
  } finally {
    db.close();
  }
  for (const key of [...data.sources!.keys()]) if (key.startsWith("UC-002")) data.sources!.delete(key);
  const bare = await unpack((await exportItemsDocx(new library.Library(data), ["UC-002"], true)).data);
  assert.deepEqual(tables(bare.document)[0].at(-1), [["来源"], ["（无）"]]);
});

test("各种来源的叫法与生成文档相同：知识库写知识库名与文档名，用户的话写会话里第几句，依据另一个条目写它所在的集合名与条目编号，Word 材料不写段落号", () => {
  const db = library.openRo(ws)!;
  let data;
  try {
    data = library.readAll(db);
  } finally {
    db.close();
  }
  const key = [...data.sources!.keys()].find((k) => k.startsWith("UC-002"))!;
  const row = (kind: string, locator: string, excerpt: string) => ({ ...data.sources!.get(key)![0], 种类: kind, 出处: locator, 摘录: excerpt, 支持: [] });
  data.sources!.set(key, [
    row("文档原文", "knowledge/lib-1a2b3c4d/借阅规范.docx#p12", "逾期每册每天罚款 0.5 元"),
    row("文档原文", "knowledge/lib-gone/旧规范.md", "已经不在的知识库"),
    row("用户的话", "sess-1#m-7", "金额大的要主管复核"),
    row("条目", "DN-001", "读者登录时输入的一串字符"),
    row("条目", "UC-001", "读者登录系统。"),
    row("条目", "UC-404", "找不到的条目"),
    row("文档原文", "inputs/需求.docx#p37", "读者凭借书证借书"),
    row("助手补充", "助手补充", ""),
  ]);
  const changed = new library.Library(data);
  const revision = changed.currentRevision("UC-002")!;
  const names = (id: string) => (id === "lib-1a2b3c4d" ? "公司规范" : null);
  const words = (locator: string) => (locator === "sess-1#m-7" ? "会话「第一次整理」里用户的第 2 句话" : null);
  assert.deepEqual(sourceEntries(changed, "UC-002", revision, words, names).map(sourceLine), [
    "知识库 · 公司规范 / 借阅规范.docx 第 12 段：逾期每册每天罚款 0.5 元",
    "知识库 · lib-gone / 旧规范.md：已经不在的知识库",
    "用户的话 · 会话「第一次整理」里用户的第 2 句话：金额大的要主管复核",
    "领域说明 · DN-001：读者登录时输入的一串字符",
    "功能用例 · UC-001：读者登录系统。",
    "条目 · UC-404：找不到的条目",
    "文档原文 · inputs/需求.docx：读者凭借书证借书",
    "助手补充",
  ]);
  // 与生成文档里连成一句的写法对着看：种类与出处是同一套叫法。
  assert.equal(sourcesText(changed, "UC-002", revision, words, names),
    "知识库，出处 公司规范 / 借阅规范.docx 第 12 段（「逾期每册每天罚款 0.5 元」）；知识库，出处 lib-gone / 旧规范.md（「已经不在的知识库」）；"
    + "用户的话，出处 会话「第一次整理」里用户的第 2 句话（「金额大的要主管复核」）；领域说明 DN-001（「读者登录时输入的一串字符」）；"
    + "功能用例 UC-001（「读者登录系统。」）；条目 UC-404（「找不到的条目」）；"
    + "文档原文，出处 inputs/需求.docx（「读者凭借书证借书」）；助手补充");
});

test("字体与样式：中文宋体、西文 Calibri；标题 1、标题 2 有定义；表格引用「网格型」而且文件里带着它的定义", async () => {
  const { document, styles } = await unpack((await exportItemsDocx(lib, ["UC-001", "UC-002", "DN-001"], true)).data);
  assert.match(styles, /<w:rFonts w:ascii="Calibri" w:cs="Calibri" w:eastAsia="宋体" w:hAnsi="Calibri"\/>/);
  for (const id of ["Heading1", "Heading2"]) assert.match(styles, new RegExp(`<w:style [^>]*w:styleId="${id}"`));
  assert.equal(document.split('<w:tblStyle w:val="TableGrid"/>').length - 1, 3);
  assert.match(styles, /<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"\/>/);
  assert.ok(document.includes("<w:tblBorders>"), "表上也写着框线");
});

test("已删除的条目不导出；选中的都删了、交付物里没有过的编号，都拒绝", async () => {
  const { document } = await unpack((await exportItemsDocx(lib, ["NFR-001", "UC-001"], true)).data);
  assert.deepEqual(headings(document, "Heading1"), ["功能用例"]);
  assert.deepEqual(headings(document, "Heading2"), ["UC-001 登录"]);
  await expectApiError(() => exportItemsDocx(lib, ["NFR-001"], true), /^选中的条目都已经删除，没有可以导出的。$/);
  await expectApiError(() => exportItemsDocx(lib, ["UC-001", "UC-009", "XX-1"], true), /^交付物里没有这些条目：UC-009、XX-1。$/);
});

test("导出的是最新的修订：条目改过之后导出的是改后的内容", async () => {
  const copy = makeTypedTask(join(tmp, "newer"), "srs-authoring", { "材料.md": "读者凭口令登录。" }, [
    [{ op: "add", collection: "功能用例", fields: { 用例名称: "登录", 用例功能: "旧的写法。", 参与者: ["读者"], 基本流程: ["输入口令"] }, sources: [SOURCE] }],
    [{ op: "update", item: "UC-001", base_revision: 1, fields: { 用例名称: "读者登录", 用例功能: "新的写法。" }, sources: [SOURCE] }],
  ]);
  const { document } = await unpack((await exportItemsDocx(library.libraryOf(copy), ["UC-001"], false)).data);
  assert.deepEqual(headings(document, "Heading2"), ["UC-001 读者登录"]);
  assert.ok(document.includes("新的写法。") && !document.includes("旧的写法。"));
});

test("docx 包加载不了时说明白是包没有装上，不说成请求写错", async () => {
  await assert.rejects(exportItemsDocx(lib, ["UC-001"], true, null, null, new Date(), () => Promise.reject(new Error("Cannot find package 'docx'"))),
    (e: unknown) => e instanceof ApiError && e.code === "internal" && e.status === 500 && e.message === DOCX_MISSING_TEXT && String(e.data.detail).includes("Cannot find package"));
  // 请求本身不对时先报请求的错，不去加载包。
  await expectApiError(() => exportItemsDocx(lib, ["UC-404"], true, null, null, new Date(), () => Promise.reject(new Error("不该走到这里"))), /^交付物里没有这些条目：UC-404。$/);
});

test("请求体与文件名", () => {
  assert.deepEqual(docxRequest({ format: "docx", items: ["UC-001", "UC-002", "UC-001"] }), [["UC-001", "UC-002"], true]);
  assert.deepEqual(docxRequest({ items: ["UC-001"], with_sources: false }), [["UC-001"], false]);
  for (const [body, pattern] of [
    [{}, /items 要写要导出的条目编号的列表，不能是空的/], [{ items: [] }, /不能是空的/], [{ items: "UC-001" }, /不能是空的/], [{ items: ["UC-001", 2] }, /不能是空的/],
    [{ items: ["UC-001"], with_sources: "yes" }, /with_sources 要写 true 或 false/],
    [{ items: ["UC-001"], revision_no: 2 }, /总是导出每个条目最新的修订，不能写 revision_no/],
  ] as [Dict, RegExp][]) {
    assert.throws(() => docxRequest(body), (e: unknown) => e instanceof ApiError && e.code === "bad_request" && pattern.test(e.message), JSON.stringify(body));
  }
  const day = new Date(2026, 9, 8);
  assert.equal(docxFileName("跨境售后退款", day), "跨境售后退款-条目-2026-10-08.docx");
  assert.equal(docxFileName('退款/换货: "流程"?', day), "退款_换货_ _流程_-条目-2026-10-08.docx");
  assert.equal(docxFileName("  ", day), "任务-条目-2026-10-08.docx");
  assert.equal(Array.from(docxFileName("长".repeat(200), day)).length, 60 + "-条目-2026-10-08.docx".length);
  assert.equal(docxDisposition("跨境售后退款-条目-2026-10-08.docx", "TASK-20261008-AB12"),
    `attachment; filename="TASK-20261008-AB12-items.docx"; filename*=UTF-8''${encodeURIComponent("跨境售后退款-条目-2026-10-08.docx")}`);
});

test("下载接口：format 写 docx 回 Word 文件与文件名；只能下载不能预览；别的格式拒绝；markdown 那一路照旧", async () => {
  // 后端不写库：任务与条目由夹具在任务根目录里建好，任务服务只读它；任务编号从这个任务的库里读。
  const root = join(tmp, "service");
  const dir = makeTypedTask(join(root, "tasks"), "srs-authoring", { "材料.md": "读者凭口令登录。" }, [[
    { op: "add", collection: "功能用例", fields: { 用例名称: "登录", 用例功能: "读者登录系统。", 参与者: ["读者"], 基本流程: ["输入口令"] }, sources: [{ kind: "助手补充", excerpt: "试验用。" }] },
  ]]);
  sqlRun(dir, [["UPDATE task SET task_name = ?", "图书馆借还"]]);   // 夹具不另起任务名，这里给它起一个
  const taskId = library.libraryOf(dir).taskId;
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    const post = async (mode: string, body: Dict) => {
      const reply = (await dispatch(service, { method: "POST", path: `/api/v1/tasks/${taskId}/documents/${mode}`, query: {}, headers: {}, body: Buffer.from(JSON.stringify(body)), remote: "127.0.0.1" })) as Dict;
      return reply as { status: number; headers: Record<string, string>; body: Buffer };
    };
    const message = (reply: { body: Buffer }) => JSON.parse(reply.body.toString("utf-8")).error.message as string;
    const good = await post("download", { format: "docx", items: ["UC-001"] });
    assert.equal(good.status, 200);
    assert.equal(good.headers["Content-Type"], DOCX_TYPE);
    assert.match(good.headers["Content-Disposition"], new RegExp(`^attachment; filename="${taskId}-items\\.docx"; filename\\*=UTF-8''${encodeURIComponent("图书馆借还-条目-")}\\d{4}-\\d{2}-\\d{2}\\.docx$`));
    assert.deepEqual(headings((await unpack(good.body)).document, "Heading2"), ["UC-001 登录"]);
    const preview = await post("preview", { format: "docx", items: ["UC-001"] });
    assert.deepEqual([preview.status, message(preview)], [400, "Word 文件只能下载，不能预览。"]);
    const pdf = await post("download", { format: "pdf" });
    assert.deepEqual([pdf.status, message(pdf)], [400, "format 要写 markdown 或 docx，不写是 markdown。"]);
    const none = await post("download", { format: "docx", items: [] });
    assert.deepEqual([none.status, message(none)], [400, "items 要写要导出的条目编号的列表，不能是空的。"]);
    const missing = await post("download", { format: "docx", items: ["UC-404"] });
    assert.deepEqual([missing.status, message(missing)], [400, "交付物里没有这些条目：UC-404。"]);
    // markdown：不写 format 照旧预览与下载。
    const md = await post("preview", {});
    assert.equal(md.status, 200);
    assert.ok(JSON.parse(md.body.toString("utf-8")).text.includes("登录"));
    const mdFile = await post("download", { format: "markdown" });
    assert.equal(mdFile.headers["Content-Type"], "text/markdown; charset=utf-8");
  } finally {
    await service.close();
  }
});
