/**
 * 整份生成文档写成 Word（src/export_document_docx.ts 与下载接口里 whole 为真的那一路）：照与预览相同的那批块写——
 * 标题的层次、段落与加粗、列表的层次与序号、表格、引用；页面交来的图片嵌进去，没有交来的写一句说明加 Mermaid 文本；
 * 接口对图片的各种拒绝。生成的文件用 jszip 解开看里面的 XML。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import JSZip from "jszip";
import { ApiError } from "../src/errors.ts";
import { FIGURE_MAX_WIDTH, MAX_IMAGES, documentDocx, documentFileName, imagesOf, noImageText } from "../src/export_document_docx.ts";
import { DOCX_MISSING_TEXT, DOCX_TYPE } from "../src/export_docx.ts";
import { dispatch } from "../src/http.ts";
import * as library from "../src/library.ts";
import { Service } from "../src/service.ts";
import { captureConsole, makeTypedTask, sqlRun, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 一张最小的 PNG（1×1 像素）。 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const unescape = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
const paragraphXml = (xml: string) => [...xml.matchAll(/<w:p>.*?<\/w:p>|<w:p\/>/gs)].map((p) => p[0]);
const textOf = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/gs)].map((t) => unescape(t[1])).join("");
const styled = (xml: string, style: string) => paragraphXml(xml).filter((p) => p.includes(`<w:pStyle w:val="${style}"/>`)).map(textOf);
async function unpack(data: Buffer) {
  const zip = await JSZip.loadAsync(data);
  return { document: await zip.file("word/document.xml")!.async("string"), files: Object.keys(zip.files) };
}

const DOC = [
  "# 图书馆借阅 软件需求规格说明", "", "> 本文档按交付物的修订 6 生成。", "",
  "## 目录", "", "- 1 概述与范围", "  - 1.1 本期范围", "- 2 角色", "",
  "## 1 概述与范围", "", "第一段。\n第二行 **重点**。", "",
  "### 1.1 本期范围 ［修订 1 · 未确认］", "", "**适用规则**", "", "1. 学生一次最多借 5 本。", "2. 【待定】待定：能不能借", "",
  "- 借还更省事", "  - 决定：只在自助机上办", "  - 第二个决定", "- 第二个目标", "",
  "## 2 角色", "", "| 用例 | 读者 | 所属流程 |", "|---|---|---|", "| 自助借书 | 发起 | 3.1 自助借书 |", "| a \\| b | — |", "",
  "**流程步骤**（D-004 自助借书的流程）", "", "```mermaid D-004", "flowchart TD", "  a --> b", "```", "",
  "```mermaid D-009", "stateDiagram-v2", "  [*] --> 有效", "```", "",
].join("\n");

test("照块写：一个井号是文档标题，二、三个井号是标题 1、标题 2；「目录」之后的第一个标题 1 另起一页；段落里的换行与加粗留着", async () => {
  const { document } = await unpack(await documentDocx(DOC, new Map(), "图书馆借阅"));
  assert.deepEqual(styled(document, "Title"), ["图书馆借阅 软件需求规格说明"]);
  assert.deepEqual(styled(document, "Heading1"), ["目录", "1 概述与范围", "2 角色"]);
  assert.deepEqual(styled(document, "Heading2"), ["1.1 本期范围 ［修订 1 · 未确认］"]);
  // 另起一页的只有「1 概述与范围」。
  const broken = paragraphXml(document).filter((p) => p.includes("<w:pageBreakBefore/>")).map(textOf);
  assert.deepEqual(broken, ["1 概述与范围"]);
  // 段落：换行处是一个换行符，加粗的那一截带着加粗。
  const para = paragraphXml(document).find((p) => textOf(p).startsWith("第一段。"))!;
  assert.equal(textOf(para), "第一段。第二行 重点。");
  assert.match(para, /<w:br\/>/);
  assert.match(para, /<w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t[^>]*>重点<\/w:t><\/w:r>/);
  // 引用是一段斜体。
  assert.match(paragraphXml(document).find((p) => textOf(p).startsWith("本文档按交付物"))!, /<w:i\/>/);
});

test("列表：无序的前面是圆点，有序的前面是序号；下一层往里缩，回到上一层时序号接着数", async () => {
  const { document } = await unpack(await documentDocx(DOC, new Map(), "x"));
  const lines = paragraphXml(document).map((p) => [textOf(p), /<w:ind w:left="(\d+)"/.exec(p)?.[1] ?? ""]);
  const at = (text: string) => lines.find(([words]) => words === text)!;
  assert.deepEqual([at("• 1 概述与范围")[1], at("• 1.1 本期范围")[1], at("• 2 角色")[1]], ["360", "720", "360"]);
  assert.deepEqual([at("1. 学生一次最多借 5 本。")[1], at("2. 【待定】待定：能不能借")[1]], ["360", "360"]);
  assert.deepEqual([at("• 借还更省事")[1], at("• 决定：只在自助机上办")[1], at("• 第二个决定")[1], at("• 第二个目标")[1]], ["360", "720", "720", "360"]);
});

test("表格：表头一行加粗，格子里转义的竖线还原，少的格子补空", async () => {
  const { document } = await unpack(await documentDocx(DOC, new Map(), "x"));
  const table = /<w:tbl>.*?<\/w:tbl>/s.exec(document)![0];
  const rows = [...table.matchAll(/<w:tr>.*?<\/w:tr>/gs)].map((r) => [...r[0].matchAll(/<w:tc>.*?<\/w:tc>/gs)].map((c) => textOf(c[0])));
  assert.deepEqual(rows, [["用例", "读者", "所属流程"], ["自助借书", "发起", "3.1 自助借书"], ["a | b", "—", ""]]);
  assert.match(table, /<w:tblStyle w:val="TableGrid"\/>/);
  const head = /<w:tr>.*?<\/w:tr>/s.exec(table)![0];
  assert.match(head, /<w:tblHeader\/>/);
  assert.match(head, /<w:b\/>/);
});

test("图：页面交来图片的嵌进文件，宽度不超过版心；没有交来的写一句说明，后面是 Mermaid 文本", async () => {
  const images = new Map([["D-004", { data: PNG, width: 1152, height: 400 }]]);
  const { document, files } = await unpack(await documentDocx(DOC, images, "x"));
  // 嵌了一张图片：媒体文件一个，正文里一处图。宽度从 1152 缩到版心的 576，高度同比例缩到 200（以 EMU 计，每像素 9525）。
  assert.equal(files.filter((name) => name.startsWith("word/media/") && name.endsWith(".png")).length, 1);
  assert.equal([...document.matchAll(/<w:drawing>/g)].length, 1);
  assert.equal(FIGURE_MAX_WIDTH, 576);
  assert.match(document, new RegExp(`<wp:extent cx="${576 * 9525}" cy="${200 * 9525}"/>`));
  // 没有交来图片的那一张：说明一句，接着是它的文本，一行一段。
  const words = paragraphXml(document).map(textOf);
  const at = words.indexOf(noImageText("D-009"));
  assert.ok(at > 0);
  assert.deepEqual(words.slice(at + 1, at + 3), ["stateDiagram-v2", "  [*] --> 有效"]);
  assert.match(noImageText("D-009"), /^（图 D-009 没有附上图片：从页面上的「生成文档」下载 Word 时图会画出来。下面是它的 Mermaid 文本。）$/);
  // 交来了图片的那一张不再写文本。
  assert.ok(!words.includes("flowchart TD"));
  // 一张图片都没有交来：两张图都写文本。
  const bare = paragraphXml((await unpack(await documentDocx(DOC, new Map(), "x"))).document).map(textOf);
  assert.ok(bare.includes("flowchart TD") && bare.includes(noImageText("D-004")));
});

test("请求里的图片：照着取；不是列表、缺项、不是 PNG、太多张都拒绝；文件名带任务名与修订号；docx 包没有装上时说明白", async () => {
  const good = imagesOf({ images: [{ diagram_id: "D-004", png: PNG.toString("base64"), width: 300, height: 150 }] });
  assert.deepEqual([[...good.keys()], good.get("D-004")!.width, good.get("D-004")!.data.equals(PNG)], [["D-004"], 300, true]);
  assert.equal(imagesOf({}).size, 0);
  const refused = (body: Dict, pattern: RegExp) => assert.throws(() => imagesOf(body), (e: unknown) => e instanceof ApiError && e.code === "bad_request" && pattern.test(e.message));
  refused({ images: "x" }, /images 要写图片的列表/);
  refused({ images: [{ diagram_id: "D-1", png: PNG.toString("base64"), width: 0, height: 10 }] }, /每一项要写 diagram_id、png/);
  refused({ images: [{ diagram_id: "D-1", png: Buffer.from("不是图片").toString("base64"), width: 10, height: 10 }] }, /D-1 的 png 不是一张 PNG 图片/);
  refused({ images: Array.from({ length: MAX_IMAGES + 1 }, (_, n) => ({ diagram_id: `D-${n}`, png: PNG.toString("base64"), width: 1, height: 1 })) }, /最多 80 张/);
  assert.deepEqual([documentFileName("图书馆/借阅", 6), documentFileName("", 2)], ["图书馆_借阅-修订6.docx", "任务-修订2.docx"]);
  await assert.rejects(documentDocx(DOC, new Map(), "x", async () => { throw new Error("Cannot find package 'docx'"); }),
    (e: unknown) => e instanceof ApiError && e.code === "internal" && e.message === DOCX_MISSING_TEXT);
});

test("下载接口：whole 为真时回整份文档的 Word 文件，章节次序与预览相同；可以按修订、按选中的条目；只能下载不能预览；不写 whole 仍是导出条目", async () => {
  const root = join(tmp, "service");
  const quote = "读者凭借书证借书。";
  const page = (fields: Dict) => ({ op: "add", collection: "总体分析", fields: { 状态: "在用", ...fields }, sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: quote }] });
  const dir = makeTypedTask(join(root, "tasks"), "srs-authoring", { "材料.md": quote }, [
    [page({ 标题: "借书", 标签: ["流程"], 它是什么: quote, 例子: [quote] }), page({ 标题: "读者", 标签: ["角色"], 它是什么: quote })],
    { diagram: { name: "借书的流程", kind: "flowchart", sources: [{ kind: "条目", locator: "OA-001" }], mermaid: 'flowchart TD\n  a(["OA-001 借书"]) --> b{"有没有借书证"}' }, said: "画一下" },
    { view: ["OA-001"] },
    [{ op: "add", collection: "功能用例", fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者刷借书证"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: quote }] }],
  ]);
  sqlRun(dir, [["UPDATE task SET task_name = ?", "图书馆借阅"]]);
  const taskId = library.libraryOf(dir).taskId;
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    const post = async (mode: string, body: Dict) => (await dispatch(service, { method: "POST", path: `/api/v1/tasks/${taskId}/documents/${mode}`, query: {}, headers: {},
      body: Buffer.from(JSON.stringify(body)), remote: "127.0.0.1" })) as { status: number; headers: Record<string, string>; body: Buffer };
    const message = (reply: { body: Buffer }) => JSON.parse(reply.body.toString("utf-8")).error.message as string;
    const preview = JSON.parse((await post("preview", {})).body.toString("utf-8")).text as string;
    const whole = await post("download", { format: "docx", whole: true, images: [{ diagram_id: "D-001", png: PNG.toString("base64"), width: 400, height: 200 }] });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["Content-Type"], DOCX_TYPE);
    assert.equal(whole.headers["Content-Disposition"], `attachment; filename="${taskId}-document.docx"; filename*=UTF-8''${encodeURIComponent("图书馆借阅-修订2.docx")}`);
    const { document, files } = await unpack(whole.body);
    // 标题 1 与预览里的二级标题是同一串。
    const previewHeads = [...preview.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(styled(document, "Heading1"), previewHeads);
    assert.deepEqual(previewHeads.slice(0, 4), ["目录", "1 概述与范围", "2 角色", "3 业务流程"]);
    assert.deepEqual(styled(document, "Title"), ["图书馆借阅 软件需求规格说明"]);
    assert.ok(styled(document, "Heading2").includes("3.1 借书 ［修订 1 · 已确认（已读）］"));
    assert.deepEqual(files.filter((name) => name.startsWith("word/media/") && !name.endsWith("/")).length, 1, files.join(" "));
    // 按修订 1 生成：那时还没有用例；文件名跟着修订号。只选一页：别的页不成节。
    const first = await post("download", { format: "docx", whole: true, revision_no: 1 });
    assert.match(first.headers["Content-Disposition"], new RegExp(encodeURIComponent("图书馆借阅-修订1.docx")));
    assert.ok(!styled((await unpack(first.body)).document, "Heading2").some((one) => one.startsWith("UC-001")));
    const some = await post("download", { format: "docx", whole: true, items: ["OA-002"] });
    assert.deepEqual(styled((await unpack(some.body)).document, "Heading2").map((one) => one.replace(/ ［.*$/, "")), ["2.1 读者"]);
    // 只能下载；图片写得不对时拒绝并说明。
    const noPreview = await post("preview", { format: "docx", whole: true });
    assert.deepEqual([noPreview.status, message(noPreview)], [400, "Word 文件只能下载，不能预览。"]);
    const bad = await post("download", { format: "docx", whole: true, images: [{ diagram_id: "D-001", png: "AAAA", width: 1, height: 1 }] });
    assert.deepEqual([bad.status, message(bad)], [400, "images 里 D-001 的 png 不是一张 PNG 图片。"]);
    // 不写 whole：仍是把选中的条目排成表的那一种，要写 items。
    const items = await post("download", { format: "docx", items: ["UC-001"] });
    assert.equal(items.status, 200);
    assert.match(items.headers["Content-Disposition"], /-items\.docx"/);
    assert.equal((await post("download", { format: "docx" })).status, 400);
  } finally {
    await service.close();
  }
});
