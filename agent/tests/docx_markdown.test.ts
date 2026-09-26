// Word 材料的 Markdown 投影（lib/docx_markdown.ts 与命令行入口 cli/docx_projection.mts）：段落号与计数脚本逐段一致；
// 标题、自动编号、列表、表格（合并单元格、一格多段、嵌在格里的小表格）、图片、文本框、图表占位各一例；投影解析两种格式都认。
// 夹具是 examples/library-lending/requirements-styled.docx；特定结构用 helpers.ts 的 makeDocx 现造。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { docxProjection, formatNumber } from "../src/lib/docx_markdown.ts";
import { projectionParagraphs } from "../src/lib/docx_source.ts";
import { SAMPLE, SAMPLE_DOCX, legacyProjection, makeDocx, projection } from "./helpers.ts";
import { paragraphsOf, readZipEntry } from "../../scripts/docx_paragraphs.mjs";

const squeeze = (s: string) => s.replace(/\s+/g, "");
const lineOf = (md: string, anchor: string) => md.split("\n").find((l) => l.includes(`${anchor} `) || l.endsWith(anchor)) ?? "";
const CLI = join(import.meta.dirname, "../src/cli/docx_projection.mts");
const FIXTURE = join(import.meta.dirname, "../../web/src/test/fixtures/requirements-styled.docx.md");

test("样本：段落总数 114，逐段正文与计数脚本、0.2 纯文本投影一致；空段落不写", () => {
  const md = projection();
  assert.match(md, /^<!--\n由 requirements-styled\.docx 生成，供助手阅读。段落总数：114。/);
  const got = projectionParagraphs(md);
  const legacy = projectionParagraphs(legacyProjection());
  const xml = readZipEntry(readFileSync(SAMPLE), "word/document.xml").toString("utf8");
  const expected = (paragraphsOf(xml) as { n: number; text: string }[]).map((p) => p.text);
  assert.equal(got.length, 114);
  assert.deepEqual(got.map(squeeze), expected.map(squeeze));
  assert.deepEqual(got.map(squeeze), legacy.map(squeeze));
  // 第 84 段是空段落：不写，段落号照数（前后两段是 83 与 85）
  assert.doesNotMatch(md, /\[p84\]/);
  assert.equal(got[83], "");
});

test("前端测试用的投影夹具与生成结果逐字一致（改了投影写法要重新生成夹具）", () => {
  assert.equal(readFileSync(FIXTURE, "utf-8"), projection());
});

test("标题写 # 与自动编号；列表项：项目符号写「- 」，「1.」直接当标记，别的编号写在「- 」后面，下一级缩进", () => {
  const md = projection();
  assert.equal(lineOf(md, "[p6]"), "# 1 [p6] 概述");
  assert.equal(lineOf(md, "[p24]"), "## 2.2 [p24] 借书流程");
  assert.equal(lineOf(md, "[p75]"), "### 3.1.1 [p75] 逾期罚款");
  assert.equal(lineOf(md, "[p17]"), "- [p17] 学生");
  assert.equal(lineOf(md, "[p18]"), "   - [p18] 本科生：凭学生证办理借书证");
  assert.equal(lineOf(md, "[p25]"), "1. [p25] 读者在自助借还机或服务台刷借书证。");
  assert.equal(lineOf(md, "[p28]"), "   - 3.1 [p28] 名下有逾期未还图书的，不能再借；");
  // 第二组编号重新从 1 数
  assert.equal(lineOf(md, "[p111]"), "1. [p111] 寒暑假期间的借期另行规定。");
  // 封面的「标题」样式没有大纲级别，按普通段落写
  assert.equal(lineOf(md, "[p1]"), "[p1] 学校图书馆借还书系统需求说明");
  // 编号不算正文
  assert.equal(projectionParagraphs(md)[27], "名下有逾期未还图书的，不能再借；");
});

test("表格：一行写一行，表头下有分隔行；合并单元格写（同左）（同上）；一格多段用 <br>；嵌在格里的小表格拆开注明位置", () => {
  const md = projection();
  assert.match(md, /\n\| \[p36\] 读者类型 \| \[p37\] 一次最多（本） \| \[p38\] 借期（天） \| \[p39\] 可续借次数 \|\n\|---\|---\|---\|---\|\n/);
  assert.match(md, /\| \[p53\] 读者类型 \| \[p54\] 细分 \| \[p55\] 借期（天） \| （同左） \|/);
  assert.match(md, /\| （同上） \| （同上） \| \[p58\] 学期中 \| \[p59\] 寒暑假 \|/);
  assert.match(md, /\[p93\] 统计口径待定，先按以下两种情形测：<br>• \[p94\] 只借不还的连续操作；/);
  assert.match(md, /<br>（小表第 2 行第 2 列） \[p105\] 五年<br>/);
  const got = projectionParagraphs(md);
  assert.equal(got[104], "五年");
  assert.equal(got[93], "只借不还的连续操作；");
});

test("图片：写成链接、占所在段落的段落号，图片字节交给调用方；链接不算正文", () => {
  const out = docxProjection(readFileSync(SAMPLE), SAMPLE_DOCX);
  assert.equal(lineOf(out.markdown, "[p32]"), "[p32] ![图 1](inputs/requirements-styled.docx.media/image1.png)");
  assert.match(lineOf(out.markdown, "[p80]"), /^\[p80\] !\[图 2\]\(inputs\/requirements-styled\.docx\.media\/image2\.png\) 被借走的书可以预约。/);
  assert.deepEqual([...out.media.keys()], ["image1.png", "image2.png"]);
  assert.deepEqual(out.media.get("image1.png"), readZipEntry(readFileSync(SAMPLE), "word/media/image1.png"));
  const got = projectionParagraphs(out.markdown);
  assert.equal(got[31], "");
  assert.match(got[79], /^被借走的书可以预约。/);
});

test("文本框：写在所在段落下面的引用块里，没有段落号，也不进任何一段的正文", () => {
  const md = projection();
  assert.match(md, /\[p81\] 预约成功后[^\n]*\n\n> （文本框）说明：保留期从图书归还上架时起算，\n> 按自然日计，节假日不顺延。\n/);
  assert.ok(projectionParagraphs(md).every((p) => !p.includes("保留期从图书归还上架时起算")));
});

test("现造的文件：图表与 SmartArt 写占位；格子里的竖线转义；中文与字母编号；numId 为 0 不编号；文本框里的段落不计段落号", () => {
  const num = (id: number, lvl = 0) => `<w:pPr><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${id}"/></w:numPr></w:pPr>`;
  const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const graphic = (uri: string) => `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="x"/><a:graphic><a:graphicData uri="${uri}"/></a:graphic></wp:inline></w:drawing></w:r>`;
  const box = `<w:r><w:drawing><wp:anchor><a:graphic><a:graphicData uri="wps"><w:txbxContent><w:p>${run("框里的字")}</w:p></w:txbxContent></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
  const body = [
    `<w:p>${num(1)}${run("第一条")}</w:p>`,
    `<w:p>${num(1, 1)}${run("子项")}</w:p>`,
    `<w:p>${num(1)}${run("第二条")}</w:p>`,
    `<w:p>${num(0)}${run("不编号")}</w:p>`,
    `<w:p>${run("图表如下")}${graphic("http://schemas.openxmlformats.org/drawingml/2006/chart")}</w:p>`,
    `<w:p>${graphic("http://schemas.openxmlformats.org/drawingml/2006/diagram")}</w:p>`,
    `<w:p>${run("锚着文本框")}${box}</w:p>`,
    `<w:tbl><w:tr><w:tc><w:p>${run("a|b")}</w:p></w:tc><w:tc><w:p>${run("c")}</w:p></w:tc></w:tr></w:tbl>`,
  ].join("");
  const numbering = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="%1、"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%2)"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`;
  const out = docxProjection(makeDocx(body, { "word/numbering.xml": numbering }), "inputs/x.docx");
  const md = out.markdown;
  assert.equal(out.paragraphs, 9);
  assert.equal(lineOf(md, "[p1]"), "- 一、 [p1] 第一条");
  assert.equal(lineOf(md, "[p2]"), "   - (a) [p2] 子项");
  assert.equal(lineOf(md, "[p3]"), "- 二、 [p3] 第二条");
  assert.equal(lineOf(md, "[p4]"), "[p4] 不编号");
  assert.match(md, /\[p5\] 图表如下\n\n（这里有一个 Word 图表，投影里没有转出）\n/);
  assert.match(md, /\n（这里有一个 SmartArt 图示，投影里没有转出）\n/);
  assert.doesNotMatch(md, /\[p6\]/);
  assert.match(md, /\[p7\] 锚着文本框\n\n> （文本框）框里的字\n/);
  assert.match(md, /\| \[p8\] a\\\|b \| \[p9\] c \|/);
  const got = projectionParagraphs(md);
  assert.equal(got.length, 9);
  assert.equal(got[7], "a|b");
  assert.equal(got[6], "锚着文本框");
});

test("编号格式", () => {
  assert.deepEqual([1, 12, 20, 21].map((n) => formatNumber(n, "chineseCounting")), ["一", "十二", "二十", "二十一"]);
  assert.deepEqual([4, 9].map((n) => formatNumber(n, "upperRoman")), ["IV", "IX"]);
  assert.equal(formatNumber(3, "decimalEnclosedCircle"), "③");
  assert.equal(formatNumber(27, "lowerLetter"), "aa");
  assert.equal(formatNumber(5, "ideographTraditional"), "戊");
  assert.equal(formatNumber(7, "somethingElse"), "7");
});

test("不是 .docx：抛错，消息是给人看的中文", () => {
  assert.throws(() => docxProjection(Buffer.from("not a zip"), "inputs/x.docx"), /不是 Word 文件（\.docx），或者文件已损坏/);
  assert.throws(() => docxProjection(makeDocx("").subarray(0, 40), "inputs/x.docx"), /不是 Word 文件/);
});

test("0.2 的纯文本投影照旧可解析：段数与各段文字", () => {
  const got = projectionParagraphs(legacyProjection());
  assert.equal(got.length, 114);
  assert.equal(got[75], "逾期的每本每天罚款一角，罚款最多不超过这本书的定价。罚款怎样缴纳待定。");
});

test("命令行入口：写投影、图片目录与分段清单（参数经 --segments-json 给）；--print 只给全文不写文件；坏文件与坏参数退出码 1 并给中文原因", () => {
  const dir = mkdtempSync(join(tmpdir(), "docx-cli-"));
  const docx = join(dir, "需求.docx");
  writeFileSync(docx, readFileSync(SAMPLE));
  const run = (...args: string[]) => {
    const done = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });
    return { code: done.status, out: JSON.parse(done.stdout.trim().split("\n").at(-1)!) };
  };
  const printed = run("--docx", docx, "--rel", "inputs/需求.docx", "--print");
  assert.equal(printed.code, 0);
  assert.equal(printed.out.paragraphs, 114);
  assert.match(printed.out.markdown, /出处写 inputs\/需求\.docx#p段落号/);
  assert.equal(existsSync(`${docx}.md`), false);
  const written = run("--docx", docx, "--rel", "inputs/需求.docx");
  assert.deepEqual(written.out, { ok: true, projection: `${docx}.md`, segments: `${docx}.segments.json`, paragraphs: 114, images: 2 });
  const segments = JSON.parse(readFileSync(`${docx}.segments.json`, "utf-8"));
  assert.deepEqual([segments.source, segments.projection, segments.blocks.length], ["inputs/需求.docx", "inputs/需求.docx.md", 11]);
  run("--docx", docx, "--rel", "inputs/需求.docx", "--segments-json", '{"heading_depth":1}');
  assert.equal(JSON.parse(readFileSync(`${docx}.segments.json`, "utf-8")).blocks.length, 6);
  assert.deepEqual(run("--docx", docx, "--rel", "inputs/需求.docx", "--segments-json", '{"max_paragraphs":0}').out,
    { ok: false, error: "分段参数 max_paragraphs 应当是正整数，现在是 0" });
  assert.equal(readFileSync(`${docx}.md`, "utf-8"), printed.out.markdown);
  assert.ok(existsSync(join(`${docx}.media`, "image2.png")));
  writeFileSync(join(dir, "坏.docx"), "x");
  const bad = run("--docx", join(dir, "坏.docx"), "--rel", "inputs/坏.docx");
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.out, { ok: false, error: "不是 Word 文件（.docx），或者文件已损坏" });
  assert.equal(run("--rel", "x").code, 1);
});
