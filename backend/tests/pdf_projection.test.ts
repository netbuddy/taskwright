/**
 * PDF 材料的投影（src/pdf_projection.ts）：各样本解析出的块、页眉页脚、没有文字的页、书签目录、位置表与分段清单；
 * 文字层的毛病（部首字符、撑开的字距、行末的连字符）经整理与比较之后对得上原文；读不了的文件与三个上限；写三个文件与失败时的清理。
 *
 * 样本在 tests/fixtures/pdf/，由那里的 build_fixtures.py 生成，样本里的文字同时写在 expected.json 里。
 * 测试用的 pdf.js 是仓库依赖里的 pdfjs-dist；这里不带画页面用的原生模块，与安装包里的情形相同。
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { PDF_LOCATION_RULES_VERSION, pdfBlockBox, pdfChapterOf } from "../../agent/src/lib/pdf_locations.ts";
import { comparablePdfText } from "../../agent/src/lib/pdf_normalize.ts";
import { type PdfSegmentList, pdfProjectionUnits } from "../../agent/src/lib/pdf_segments.ts";
import { NO_TEXT_LINE, PDFJS_VERSION, PDF_LIMITS, PdfProjectionError, pdfProjection, writePdfProjection, tooSlowText } from "../src/pdf_projection.ts";
import { ROOT, tempDir } from "./helpers.ts";

const FIXTURES = join(ROOT, "backend", "tests", "fixtures", "pdf");
const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf-8"));
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const sample = (name: string) => readFileSync(join(FIXTURES, `${name}.pdf`));
const project = (name: string) => pdfProjection(sample(name), `inputs/${name}.pdf`);
/** 投影里带定位符的各行，写成「页-块 文字」。 */
const unitLines = (markdown: string) => pdfProjectionUnits(markdown).map((u) => `${u.page}-${u.block} ${u.text}`);
const headLines = (markdown: string) => markdown.split("\n").filter((line) => line.startsWith("> （页眉页脚）"));

test("多页中文（不嵌入字体）：每个段落正好是一块，标题单独一块，页眉页脚不占块号", async () => {
  const result = await project("multipage");
  const want: string[] = [];
  expected.multipage.pages.forEach((page: { heading: string; paragraphs: string[] }, k: number) => {
    [page.heading, ...page.paragraphs].forEach((text, b) => want.push(`${k + 1}-${b + 1} ${text}`));
  });
  assert.deepEqual(unitLines(result.markdown), want);
  assert.deepEqual([result.pages, result.units, result.no_text_pages], [3, want.length, []]);
  assert.equal(result.chars, [...want.map((line) => line.slice(line.indexOf(" ") + 1)), ...headLines(result.markdown).map((line) => line.slice("> （页眉页脚）".length))].join("").replace(/\s+/g, "").length);
  // 每页一行页眉、一行页脚，没有定位符
  assert.deepEqual(headLines(result.markdown), [1, 2, 3].flatMap((n) => [`> （页眉页脚）${expected.multipage.header}`, `> （页眉页脚）第 ${n} 页`]));
});

test("多页中文：投影开头的说明写明页数、块总数与出处的写法；块与块之间空一行", async () => {
  const { markdown, units } = await project("multipage");
  const lines = markdown.split("\n");
  assert.equal(lines[0], "<!--");
  assert.equal(lines[1], `由 multipage.pdf 生成，供助手阅读。页数：3。块总数：${units}。`);
  assert.ok(markdown.includes("出处写 inputs/multipage.pdf#p页-块（例如 inputs/multipage.pdf#p3-7）"));
  const end = lines.indexOf("-->");
  assert.ok(end > 1);
  const body = lines.slice(end + 1);
  body.forEach((line, i) => assert.equal(line === "", i % 2 === 0, `说明之后第 ${i + 1} 行：空行与有字的行应当一行隔一行`));
  assert.ok(!/^#/m.test(body.join("\n")), "不按字号猜标题，投影里不写 #");
});

test("多页中文：位置表记每页的宽高与每块的矩形，书签目录记成章节", async () => {
  const { locations } = await project("multipage");
  assert.deepEqual([locations.rules_version, locations.source, locations.engine], [PDF_LOCATION_RULES_VERSION, "inputs/multipage.pdf", `pdfjs-dist ${PDFJS_VERSION}`]);
  assert.ok(locations.producer.startsWith("ReportLab"));
  assert.deepEqual(locations.pages.map((p) => [p.page, p.width, p.height, p.rotate, p.no_text, p.blocks.length]), [
    [1, 595.3, 841.9, 0, false, 3], [2, 595.3, 841.9, 0, false, 4], [3, 595.3, 841.9, 0, false, 3],
  ]);
  // 第 1 页第 2 块是一个三行的段落：首行缩进两个字，后面的行从左边 72 点起，排到 504 点；基线在 700、680、660
  const [left, bottom, right, top] = pdfBlockBox(locations, 1, 2)!;
  assert.ok(Math.abs(left - 72) < 0.5 && Math.abs(right - 504) < 0.5, `左右是 ${left}、${right}`);
  assert.ok(bottom > 650 && bottom < 660 && top > 705 && top < 715, `上下是 ${top}、${bottom}`);
  // 书签目录
  assert.deepEqual(locations.headings, expected.multipage.pages.flatMap((page: { bookmarks: [number, string][] }, k: number) =>
    page.bookmarks.map(([level, title]) => ({ page: k + 1, level, title }))));
  assert.equal(pdfChapterOf(locations, 1), "第一章 总则");
  assert.equal(pdfChapterOf(locations, 3), "第三章 归还");
});

test("两栏：先左栏后右栏；从左栏底排到右栏顶的段落分成两块，接起来是原来的话", async () => {
  const { markdown } = await project("two-column");
  const t = expected.two_column;
  assert.deepEqual(unitLines(markdown), [`1-1 ${t.title}`, `1-2 ${t.a}`, `1-3 ${t.b1}`, `1-4 ${t.b2}`, `1-5 ${t.c}`]);
});

test("表格：一行是一块，各格之间隔两个空格，不分列", async () => {
  const { markdown } = await project("table");
  const t = expected.table;
  assert.deepEqual(unitLines(markdown), [`1-1 ${t.before}`, ...t.rows.map((row: string[], k: number) => `1-${k + 2} ${row.join("  ")}`), `1-6 ${t.after}`]);
});

test("没有文字的页：写一行块号为 0 的说明，位置表里标出来；只有页眉的页也算", async () => {
  const result = await project("scanned");
  assert.deepEqual(result.no_text_pages, [2, 3]);
  assert.deepEqual(unitLines(result.markdown), [`1-1 ${expected.scanned.text}`, `2-0 ${NO_TEXT_LINE}`, `3-0 ${NO_TEXT_LINE}`]);
  assert.equal(result.units, 1);
  assert.deepEqual(result.locations.pages.map((p) => [p.no_text, p.blocks.length]), [[false, 1], [true, 0], [true, 0]]);
  // 三页里有两页带同一行页眉，够三分之二，算页眉
  assert.deepEqual(headLines(result.markdown), [`> （页眉页脚）${expected.scanned.header}`, `> （页眉页脚）${expected.scanned.header}`]);
});

test("文字层的毛病：部首字符在投影里已经换成通用汉字，撑开的字距里的空格已经去掉", async () => {
  const { markdown } = await project("quirks");
  assert.deepEqual(unitLines(markdown), [`1-1 ${expected.quirks.radicals}`, `1-2 ${expected.quirks.spaced}`]);
  for (const code of Object.values(expected.quirks.radical_code_points) as number[]) assert.ok(!markdown.includes(String.fromCodePoint(code)));
});

test("英文：左对齐不排满的段落仍是一块，三段分得开；行末的连字符留在投影里，比较时对得上原文", async () => {
  const { markdown } = await project("english");
  const t = expected.english;
  const blocks = pdfProjectionUnits(markdown).map((u) => u.text);
  assert.deepEqual(blocks, [t.first_lines.join(" "), t.second, t.third]);
  const [whole, head, tail] = t.hyphenated;
  assert.ok(blocks[0].includes(`${head} ${tail}`) && !blocks[0].includes(whole), "投影里保留断词的写法，不替读者把词接回去");
  assert.equal(comparablePdfText(blocks[0]), comparablePdfText(t.first));
});

test("由 Word 文件转出的 PDF（嵌入字体的子集）：文字读得全，补充平面的字也在，书签目录读得到", async () => {
  const result = await project("from-word");
  assert.ok(result.locations.producer.startsWith("LibreOffice"));
  const texts = pdfProjectionUnits(result.markdown).map((u) => u.text);
  for (const phrase of ["总则的正文。", "适用范围的正文。", "章下一节的正文。"]) assert.ok(texts.includes(phrase), `应当有一块正好是「${phrase}」`);
  assert.ok(result.markdown.includes(String.fromCodePoint(0x2000b)), "补充平面的字 U+2000B");
  assert.deepEqual(result.locations.headings.slice(0, 2), [{ page: 1, level: 1, title: "1 总则" }, { page: 1, level: 2, title: "1.1 适用范围" }]);
});

test("同一份文件解析两次，投影与位置表逐字相同", async () => {
  const [a, b] = [await project("multipage"), await project("multipage")];
  assert.equal(a.markdown, b.markdown);
  assert.deepEqual(a.locations, b.locations);
});

test("读不了的文件：设了口令的、不是 PDF 的，各给一句说明", async () => {
  await assert.rejects(project("locked"), (e: unknown) => e instanceof PdfProjectionError && e.message === "这份 PDF 设了打开口令，读不了");
  await assert.rejects(pdfProjection(Buffer.from("这不是一份 PDF。"), "inputs/x.pdf"), (e: unknown) => e instanceof PdfProjectionError && e.message === "不是 PDF 文件，或者文件已损坏");
  await assert.rejects(pdfProjection(Buffer.alloc(0), "inputs/x.pdf"), PdfProjectionError);
});

test("三个上限：页数、字数、用时，超过任何一个都停下并说明", async () => {
  assert.deepEqual(PDF_LIMITS, { pages: 1000, chars: 3_000_000, seconds: 60 });
  const data = sample("multipage");
  await assert.rejects(pdfProjection(data, "inputs/x.pdf", { ...PDF_LIMITS, pages: 2 }), (e: unknown) => e instanceof PdfProjectionError && e.message === "这份 PDF 有 3 页，超过上限 2 页");
  await assert.rejects(pdfProjection(data, "inputs/x.pdf", { ...PDF_LIMITS, chars: 200 }), (e: unknown) => e instanceof PdfProjectionError && e.message === "这份 PDF 的文字超过上限 200 字，在第 2 页停下了");
  await assert.rejects(pdfProjection(data, "inputs/x.pdf", { ...PDF_LIMITS, seconds: 0 }), (e: unknown) => e instanceof PdfProjectionError && /^解析用了 [\d.]+ 秒仍没有完成（共 3 页，第 1 页还没有读完），这份文件太复杂，本版不支持$/.test(e.message));
  // 到时限的那句话：用了多久、读到第几页、一共几页；每读完一页报一次进度。
  assert.equal(tooSlowText(60_400, 420, 1000), "解析用了 60 秒仍没有完成（已读到第 420 页，共 1000 页），这份文件太复杂，本版不支持");
  assert.equal(tooSlowText(2_340, null, null), "解析用了 2.3 秒仍没有完成，这份文件太复杂，本版不支持");
  const seen: [number, number][] = [];
  await pdfProjection(data, "inputs/x.pdf", PDF_LIMITS, (read, total) => seen.push([read, total]));
  assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]]);
  // 正好等于上限的不算超过
  assert.equal((await pdfProjection(data, "inputs/x.pdf", { ...PDF_LIMITS, pages: 3 })).pages, 3);
});

test("写三个文件：投影、分段清单、位置表都在 PDF 旁边，分段清单按书签目录分段", async () => {
  const dir = join(tmp, "write", "inputs");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "办法.pdf");
  copyFileSync(join(FIXTURES, "multipage.pdf"), pdf);
  const written = await writePdfProjection(pdf, "inputs/办法.pdf");
  assert.deepEqual([written.projection, written.segments, written.locations], [`${pdf}.md`, `${pdf}.segments.json`, `${pdf}.locations.json`]);
  assert.deepEqual(readdirSync(dir).sort(), ["办法.pdf", "办法.pdf.locations.json", "办法.pdf.md", "办法.pdf.segments.json"]);
  const markdown = readFileSync(written.projection, "utf-8");
  assert.equal(markdown, (await pdfProjection(readFileSync(pdf), "inputs/办法.pdf")).markdown);
  const list = JSON.parse(readFileSync(written.segments, "utf-8")) as PdfSegmentList;
  assert.deepEqual([list.source, list.projection, list.pages, list.units], ["inputs/办法.pdf", "inputs/办法.pdf.md", 3, written.units]);
  assert.deepEqual(list.blocks.map((b) => [b.heading, b.first_page, b.last_page, b.units]), [
    ["第一章 总则", 1, 1, 3], ["第二章 借阅；第一节 期限", 2, 2, 4], ["第三章 归还", 3, 3, 3],
  ]);
  const lines = markdown.split("\n");
  assert.ok(lines[list.blocks[1].first_line - 1].startsWith("[p2-1] "));
  assert.ok(lines[list.blocks[2].last_line - 1].startsWith("[p3-3] "));
  const table = JSON.parse(readFileSync(written.locations, "utf-8"));
  assert.equal(table.source, "inputs/办法.pdf");
  assert.equal(table.pages.length, 3);
});

test("写到一半失败：已经写下的清掉，不留半套文件", async () => {
  const dir = join(tmp, "half", "inputs");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "x.pdf");
  copyFileSync(join(FIXTURES, "table.pdf"), pdf);
  mkdirSync(`${pdf}.segments.json`); // 分段清单该在的位置上是一个目录，写不进去
  await assert.rejects(writePdfProjection(pdf, "inputs/x.pdf"), (e: unknown) => e instanceof PdfProjectionError && e.message.startsWith("分段清单没有写成："));
  assert.ok(!existsSync(`${pdf}.md`), "投影应当已经清掉");
  assert.ok(!existsSync(`${pdf}.locations.json`));
  await assert.rejects(writePdfProjection(join(dir, "没有这个文件.pdf"), "inputs/没有这个文件.pdf"), (e: unknown) => e instanceof PdfProjectionError && e.message.startsWith("读不到文件 "));
});
