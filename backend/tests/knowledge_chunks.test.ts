/**
 * 知识库文档切成片段（src/knowledge_chunks.ts）：Word 文档按分段清单的块、块内照投影的行接，表格一行算一个单位；Markdown 按标题与空行；纯文本只按空行；
 * 超过上限的一段先在句末切、找不到句末就在上限处切；全是空白的段不成片段；送去换算的文字是标题一行加正文。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { docxProjection } from "../../agent/src/lib/docx_markdown.ts";
import { projectionParagraphs, tableCells } from "../../agent/src/lib/docx_source.ts";
import { SEGMENT_DEFAULTS, buildSegments } from "../../agent/src/lib/segments.ts";
import {
  CHUNK_MAX_CHARS, CHUNK_RULES, type Chunk, chunkDocument, chunkInput, chunkMarkdown, chunkPlain, chunkRulesVersion, chunkWord, documentKind, pieceText, splitLong,
  splitLongRanges, tableCellRanges,
} from "../src/knowledge_chunks.ts";
import { ROOT } from "./helpers.ts";

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
const size = (text: string) => Array.from(text).length;
/** 片段的位置与标题，写成一行好比较。 */
const lines = (chunks: Chunk[]) => chunks.map((c) => [c.index, c.heading, c.first_line, c.last_line, c.text]);

test("Word 文档：片段不跨块，带所在块的标题与起止段落号；有文字的段落一段不少、一段不重，正文里没有段落号记号", () => {
  const projection = docxProjection(readFileSync(SAMPLE), "general/files/x.docx").markdown;
  const blocks = buildSegments(projection, SEGMENT_DEFAULTS, "", "").blocks;
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i + 1));
  // 示例文档每块都不到 800 字，所以正好一块一个片段。
  assert.deepEqual(chunks.map((c) => [c.heading, c.first_paragraph, c.last_paragraph]), blocks.map((b) => [b.heading, b.first_paragraph, b.last_paragraph]));
  // 片段的行数：块里有文字的段落各一行，表格的一行算一行（表头下面的分隔行不算）。
  const paragraphs = projectionParagraphs(projection);
  const numbered = projection.replace(/<!--[\s\S]*?-->/g, "").split("\n").flatMap((line) => {
    const m = /\[p(\d+)\]/.exec(line);
    if (!m || line.startsWith(">")) return [];
    return line.startsWith("|") || paragraphs[Number(m[1]) - 1].trim() ? [Number(m[1])] : [];
  });
  assert.deepEqual(chunks.map((c) => c.text.split("\n").length), blocks.map((b) => numbered.filter((n) => n >= b.first_paragraph && n <= b.last_paragraph).length));
  // 有文字的段落一段不少：每一段的文字都在片段的正文里。
  const whole = chunks.map((c) => c.text).join("\n");
  for (const [i, text] of paragraphs.entries()) if (text.trim()) assert.ok(whole.includes(text.trim()), `第 ${i + 1} 段不在片段里：${text}`);
  for (const c of chunks) {
    assert.ok(size(c.text) <= CHUNK_MAX_CHARS);
    assert.deepEqual([c.first_line, c.last_line], [null, null]);
    assert.doesNotMatch(c.text, /\[p\d+\]/);
  }
  assert.equal(chunks[1].text.split("\n")[0], "概述");
  assert.match(chunks[1].text, /我们学校图书馆现在用纸质登记簿记录借还/);
  // 上限调小之后，一块切成几个片段：标题相同，段落号首尾相接，仍然不跨块。
  const small = chunkWord(projection, { ...SEGMENT_DEFAULTS, max_paragraphs: 1000, min_paragraphs: 1, heading_depth: 1 });
  assert.ok(small.length >= 5);
  for (const c of small) assert.ok(c.first_paragraph! <= c.last_paragraph!);
});

test("Word 文档：一块的字数超过上限时切成几个片段，每个都不超过上限，段落号首尾相接", () => {
  const paragraph = (n: number) => `[p${n}] ${"借".repeat(299)}。`;
  const projection = ["<!--", "段落总数：7。", "-->", "", "# 1 [p1] 规则", "", ...[2, 3, 4, 5, 6, 7].flatMap((n) => [paragraph(n), ""])].join("\n");
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  // 标题 2 个字，每段 300 个字：标题加两段是 2 + 1 + 300 + 1 + 300 = 604，再加一段就超过 800。
  assert.deepEqual(chunks.map((c) => [c.heading, c.first_paragraph, c.last_paragraph, size(c.text)]),
    [["1 规则", 1, 3, 604], ["1 规则", 4, 5, 601], ["1 规则", 6, 7, 601]]);
});

/** 手写一份投影：开头的说明里写段落总数，后面是给的各行。 */
const projectionOf = (total: number, body: string[]) => ["<!--", `段落总数：${total}。`, "-->", "", ...body].join("\n");

test("Word 表格：一行写成带竖线的一行，表头下面的分隔行不要，表的行结构留在片段里；一格里的几段用一个空格接起来，合并格与嵌在格里的小表格照投影的写法；正文里没有段落号记号、<br> 与图片链接", () => {
  const projection = docxProjection(readFileSync(SAMPLE), "general/files/x.docx").markdown;
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  const limits = chunks.find((c) => c.heading === "2.3 借阅上限")!;
  assert.deepEqual([limits.first_paragraph, limits.last_paragraph], [34, 71]);
  assert.equal(limits.text, [
    "借阅上限",
    "表 1 是各类读者的借阅上限。",
    "| 读者类型 | 一次最多（本） | 借期（天） | 可续借次数 |",
    "| 学生 | 5 | 30 | 1 |",
    "| 教师 | 10 | 30 | 1 |",
    "| 校外读者 | — | — | — |",
    "表 2 按学期与假期列出借期；同一类读者的几种情形合并在一格里。",
    "| 读者类型 | 细分 | 借期（天） | （同左） |",
    "| （同上） | （同上） | 学期中 | 寒暑假 |",
    "| 学生 | 本科生 | 30 | 另行规定 |",
    "| （同上） | 研究生 | 30 | 另行规定 |",
    "| 教职工 | 在编与外聘教师 | 30 | 60 |",
  ].join("\n"));
  const requirements = chunks.find((c) => c.text.includes("| 类别 | 要求 | 说明 |"))!;
  const rows = requirements.text.split("\n").filter((line) => line.startsWith("|"));
  assert.equal(rows.length, 4);
  // 一格里有几段、带列表：用一个空格接起来
  assert.equal(rows[1], "| 性能 | 开学第一周是借还高峰，系统要能每分钟处理至少 100 笔借还。 | 「处理」指从扫描条码到打印凭条完成。 统计口径待定，先按以下两种情形测： • 只借不还的连续操作； • 借还交替的混合操作。 |");
  // 嵌在格里的小表格：照投影拆开写在外层的格里
  assert.match(rows[3], /^\| 数据 \| .* \| 各类记录的保存期限： （小表第 1 行第 1 列） 记录 （小表第 1 行第 2 列） 保存期限 （小表第 2 行第 1 列） 借阅记录 /);
  for (const c of chunks) assert.doesNotMatch(c.text, /\[p\d+\]|<br>|!\[|\|-/);
});

test("Word 表格切到两个片段：一行不拆开；后面的片段开头重复这张表的表头行，表头行算进上限、不改起止段落号；片段的段落号首尾相接", () => {
  // 一张 20 行的表，每行两格共 2 段、约 100 个字；表前表后各有一段。
  const row = (k: number) => `| [p${3 + 2 * k}] 第 ${k} 行 | [p${4 + 2 * k}] ${"借".repeat(90)} |`;
  const projection = projectionOf(46, [
    "# 1 [p1] 规则", "", "[p2] 下面是各行的说明。", "",
    "| [p3] 名称 | [p4] 说明 |", "|---|---|", ...Array.from({ length: 20 }, (_, i) => row(i + 1)), "",
    "[p45] 表后的一段。", "", "[p46] 最后一段。",
  ]);
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  assert.ok(chunks.length >= 3);
  const header = "| 名称 | 说明 |";
  const dataRows = chunks.flatMap((c) => c.text.split("\n").filter((line) => line.startsWith("| 第 ")));
  assert.deepEqual(dataRows, Array.from({ length: 20 }, (_, i) => `| 第 ${i + 1} 行 | ${"借".repeat(90)} |`), "各行整行都在，一行不少、一行不重");
  for (const [i, c] of chunks.entries()) {
    assert.ok(size(c.text) <= CHUNK_MAX_CHARS, `第 ${i + 1} 个片段 ${size(c.text)} 个字`);
    const lines = c.text.split("\n");
    assert.equal(lines.filter((line) => line === header).length, 1, "每个片段里表头行正好一行");
    // 第一个片段的表头行在表前的两段后面；后面的片段从表的中间开始，表头行在最前面
    assert.equal(lines.indexOf(header), i === 0 ? 2 : 0);
    if (i > 0) {
      assert.equal(c.first_paragraph, chunks[i - 1].last_paragraph! + 1, "段落号首尾相接");
      // 起始段落号是这个片段头一行数据的，不是表头行的
      assert.equal(c.first_paragraph, 3 + 2 * Number(/第 (\d+) 行/.exec(lines[1])![1]));
    }
  }
  assert.deepEqual([chunks[0].first_paragraph, chunks.at(-1)!.last_paragraph], [1, 46]);
  assert.ok(chunks.at(-1)!.text.endsWith("表后的一段。\n最后一段。"));
});

test("超过上限的一行表格：在格与格之间切开，每片仍是带竖线的一行，位置取这一片里各格的段落号；单独一格就超过上限时那一格在句末的标点后面切；各片前面加表头行，放不下的不加", () => {
  const long = "读者凭借书证借书。".repeat(60);   // 540 个字
  const huge = "字".repeat(2000);
  const header = "| 甲 | 乙 | 丙 |";              // 13 个字
  const projection = projectionOf(9, [
    "# 1 [p1] 规则", "",
    "| [p2] 甲 | [p3] 乙 | [p4] 丙 |", "|---|---|---|",
    `| [p5] ${long} | [p6] ${long} | [p7] 短 |`,
    `| [p8] ${huge} | [p9] 尾 |`,
  ]);
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  assert.deepEqual(chunks.map((c) => [c.first_paragraph, c.last_paragraph, c.text.split("\n").map(size)]), [
    [1, 4, [2, 13]],             // 标题与表头行
    [5, 5, [13, 544]],           // 表头行，| 第一格 |
    [6, 7, [13, 548]],           // 表头行，| 第二格 | 短 |
    [8, 8, [800]], [8, 8, [800]],   // 超过上限的那一格切成三片；前两片正好到上限，放不下表头行
    [8, 8, [13, 412]],
    [9, 9, [13, 5]],             // 表头行，| 尾 |
  ]);
  assert.equal(chunks[1].text, `${header}\n| ${long} |`);
  assert.equal(chunks[2].text, `${header}\n| ${long} | 短 |`);
  for (const c of chunks.slice(3, 5)) assert.match(c.text, /^\| 字{796} \|$/);
  assert.equal(chunks[6].text, `${header}\n| 尾 |`);
  for (const c of chunks) assert.ok(size(c.text) <= CHUNK_MAX_CHARS);
});

test("表格里没有段落号的行（全是合并格）位置沿用上一行的末段；格里的图片链接、只有图片的段落、文本框的引用块与没有段落号的占位行都不进正文", () => {
  // 表头行 18 个字；下面这一行 780 个字：接在第一个片段后面超过上限，连表头行另起一个片段是 799 个字，放得下。
  const wide = "借".repeat(764);
  const projection = projectionOf(11, [
    "# 1 [p1] 规则", "",
    "| [p2] 类型 | [p3] 借期 | （同左） |", "|---|---|---|",
    `| [p4] 学生 ![图 1](x.docx.media/image1.png) | [p5] ${wide} | （同左） |`,
    "| （同上） | （同上） | （同上） |",
    "| [p9] 教师 | [p10] 60 | （同左） |", "",
    "[p11] ![图 2](x.docx.media/image2.png)", "",
    "> （文本框）框里的字没有段落号。", "",
    "（这里有一张图表，没有段落号。）",
  ]);
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  assert.deepEqual(chunks.map((c) => [c.first_paragraph, c.last_paragraph, c.text.split("\n")]), [
    [1, 3, ["规则", "| 类型 | 借期 | （同左） |"]],
    // 这一行加上前面的超过上限，另起一个片段，开头重复表头行
    [4, 5, ["| 类型 | 借期 | （同左） |", `| 学生 | ${wide} | （同左） |`]],
    // 全是合并格的一行没有段落号：位置沿用上一行的末段（第 5 段）
    [5, 10, ["| 类型 | 借期 | （同左） |", "| （同上） | （同上） | （同上） |", "| 教师 | 60 | （同左） |"]],
  ]);
});

test("文档的种类看扩展名；切法的版本每种各记各的，Word 文档的是 2，Markdown 与纯文本的是 1", () => {
  assert.deepEqual(["规范.docx", "规范.DOCX", "规则.md", "说明.txt", "没有扩展名", "表.docx.md"].map(documentKind), ["word", "word", "markdown", "plain", "plain", "markdown"]);
  assert.deepEqual(CHUNK_RULES, { word: 2, markdown: 1, plain: 1 });
  assert.deepEqual([chunkRulesVersion("规范.docx"), chunkRulesVersion("规则.md"), chunkRulesVersion("说明.txt")], [2, 1, 1]);
});

test("超过上限的一段：先在句末的标点后面切；上限的后一半里没有句末的标点就在上限处切；各片位置相同", () => {
  const sentence = "读者凭借书证借书。";   // 9 个字
  const long = sentence.repeat(200);       // 1800 个字
  const pieces = splitLong(long);
  assert.equal(pieces.join(""), long);
  assert.deepEqual(pieces.map(size), [792, 792, 216]);
  for (const piece of pieces) assert.ok(piece.endsWith("。"));
  assert.deepEqual(splitLong("字".repeat(2000)).map(size), [800, 800, 400]);
  // 正好等于上限的不切。
  assert.deepEqual(splitLong("字".repeat(800)).map(size), [800]);
  const chunks = chunkPlain(`开头一段。\n\n${long}\n\n结尾一段。`);
  assert.deepEqual(chunks.map((c) => [c.first_line, c.last_line, size(c.text)]), [[1, 1, 5], [3, 3, 792], [3, 3, 792], [3, 3, 216], [5, 5, 5]]);
});

test("Markdown：标题开始一个小节，标题逐级连起来；空行分段，段落接到上限为止；位置是行号", () => {
  const text = [
    "开头的说明。",          // 1
    "",                      // 2
    "# 退款",                // 3
    "",                      // 4
    "七天之内可以退款。",    // 5
    "第二行接着写。",        // 6
    "",                      // 7
    "超过七天的不退。",      // 8
    "",                      // 9
    "## 时限 ##",            // 10
    "收到货之日起算。",      // 11
    "### 例外",              // 12
    "定制商品不退。",        // 13
    "# 运费",                // 14
    "运费由卖家出。",        // 15
  ].join("\n");
  assert.deepEqual(lines(chunkMarkdown(text)), [
    [1, null, 1, 1, "开头的说明。"],
    [2, "退款", 5, 8, "七天之内可以退款。\n第二行接着写。\n超过七天的不退。"],
    [3, "退款 / 时限", 11, 11, "收到货之日起算。"],
    [4, "退款 / 时限 / 例外", 13, 13, "定制商品不退。"],
    [5, "运费", 15, 15, "运费由卖家出。"],
  ]);
  // 标题跳级时，中间缺的那一级不写。
  assert.deepEqual(lines(chunkMarkdown("# 甲\n### 丙\n正文")), [[1, "甲", 1, 1, "甲"], [2, "甲 / 丙", 3, 3, "正文"]]);
});

test("Markdown：代码围栏里的 # 不算标题，围栏里的空行不分段；小节里除了标题没有别的字时，标题自己算一个片段", () => {
  const text = ["# 用法", "", "```sh", "# 这是注释，不是标题", "", "run --all", "```", "", "## 术语甲", "## 术语乙", "", "乙的解释。"].join("\n");
  assert.deepEqual(lines(chunkMarkdown(text)), [
    [1, "用法", 3, 7, "```sh\n# 这是注释，不是标题\n\nrun --all\n```"],
    [2, "用法 / 术语甲", 9, 9, "术语甲"],
    [3, "用法 / 术语乙", 12, 12, "乙的解释。"],
  ]);
});

test("纯文本：没有标题，以 # 开头的行也是正文；只按空行分段", () => {
  assert.deepEqual(lines(chunkPlain("# 不是标题\n第二行\n\n\n另一段")), [[1, null, 1, 5, "# 不是标题\n第二行\n另一段"]]);
});

test("全是空白的段不成片段：没有文字的文档切出来是零个片段", () => {
  assert.deepEqual(chunkPlain(""), []);
  assert.deepEqual(chunkPlain("  \n\n\t\n　\n"), []);
  assert.deepEqual(chunkMarkdown("\n\n   \n"), []);
  assert.deepEqual(chunkWord("<!--\n段落总数：3。\n-->\n", SEGMENT_DEFAULTS), []);
  assert.deepEqual(lines(chunkPlain("\n\n   \n有字\n \n")), [[1, null, 4, 4, "有字"]]);
});

test("按扩展名选切法；送去换算的文字是标题一行加正文，没有标题或者正文本来就以标题开头时只送正文", () => {
  const text = "# 退款\n七天之内可以退款。";
  assert.deepEqual(chunkDocument("规则.MD", text, SEGMENT_DEFAULTS).map((c) => c.heading), ["退款"]);
  assert.deepEqual(chunkDocument("规则.txt", text, SEGMENT_DEFAULTS).map((c) => c.heading), [null]);
  assert.equal(chunkInput({ heading: "退款", text: "七天之内可以退款。" }), "退款\n七天之内可以退款。");
  assert.equal(chunkInput({ heading: null, text: "七天之内可以退款。" }), "七天之内可以退款。");
  assert.equal(chunkInput({ heading: "术语甲", text: "术语甲" }), "术语甲");
});

// ───────────── 片段在源文字里的位置 ─────────────

/** 片段的各截读成文字。 */
const pieceTexts = (chunk: Chunk, source: string) => chunk.pieces.map((piece) => pieceText(source, piece));

test("Markdown 与纯文本的位置：片段在源文字里的那一段就是原文，连段与段之间的空行；各截接起来是片段的正文；小节与块的编号", () => {
  const source = "开头一段。\n\n# 退款\n\n第 1 条 七天内可以退。  \n\n\n第 2 条 运费由卖家出。\n\n## 时限\n\n# 只有标题\n";
  const chunks = chunkMarkdown(source);
  assert.deepEqual(chunks.map((c) => [c.block, c.heading, source.slice(c.start_offset, c.end_offset)]), [
    [0, null, "开头一段。"],
    [1, "退款", "第 1 条 七天内可以退。  \n\n\n第 2 条 运费由卖家出。"],
    // 小节里除了标题没有别的字：位置是标题的文字本身。
    [2, "退款 / 时限", "时限"],
    [3, "只有标题", "只有标题"],
  ]);
  for (const c of chunks) {
    assert.equal(pieceTexts(c, source).join("\n"), c.text);
    assert.deepEqual([c.start_offset, c.end_offset], [c.pieces[0].start, c.pieces.at(-1)!.end]);
    assert.equal("partial" in c || "rows" in c || "header" in c, false);
    for (const piece of c.pieces) assert.equal("paragraph" in piece, false);
  }
  // 一行行尾的空白留在第一截里（去首尾空白只去整段的两头），所以这一截与片段正文的第一行相同。
  assert.deepEqual(pieceTexts(chunks[1], source), ["第 1 条 七天内可以退。", "第 2 条 运费由卖家出。"]);
  // 纯文本：块的编号恒为 0；整段两头的空白不在位置里。
  const plain = "  缩进的一行  \n# 不是标题\n\n\n另一段\n";
  const got = chunkPlain(plain);
  assert.deepEqual(got.map((c) => [c.block, plain.slice(c.start_offset, c.end_offset)]), [[0, "缩进的一行  \n# 不是标题\n\n\n另一段"]]);
  assert.deepEqual(pieceTexts(got[0], plain), ["缩进的一行  \n# 不是标题", "另一段"]);
});

test("超过上限的一段切出来的各截各有自己的位置：按位置读出来就是这一截，位置互不重叠，都标着是一截；字的位置按 UTF-16 码元算", () => {
  // 每句 100 个字（99 个字加一个句号），一共 20 句；中间夹着占两个码元的字。
  const sentence = (i: number) => `${i % 2 ? "借" : "𠮷"}`.repeat(99) + "。";
  const long = Array.from({ length: 20 }, (_, i) => sentence(i)).join("");
  const source = `前言\n\n${long}\n\n结尾\n`;
  const chunks = chunkPlain(source);
  const pieces = chunks.filter((c) => c.partial);
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map((c) => [c.first_line, c.last_line, size(c.text)]), [[3, 3, 800], [3, 3, 800], [3, 3, 400]]);
  for (const c of pieces) {
    assert.equal(c.pieces.length, 1);
    assert.equal(source.slice(c.start_offset, c.end_offset), c.text);
    assert.deepEqual([c.pieces[0].start, c.pieces[0].end], [c.start_offset, c.end_offset]);
  }
  for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i].start_offset, pieces[i - 1].end_offset);
  assert.equal(pieces.map((c) => c.text).join(""), long);
  // 不是切出来的片段没有这个标记。
  assert.deepEqual(chunks.filter((c) => !c.partial).map((c) => c.text), ["前言", "结尾"]);
  // 切的时候去掉了每截两头的空白：位置跟着缩进去。
  const spaced = `${"甲".repeat(799)}。  ${"乙".repeat(10)}`;
  assert.deepEqual(splitLongRanges(spaced).map((one) => [one.text, spaced.slice(one.start, one.end)]), [[`${"甲".repeat(799)}。`, `${"甲".repeat(799)}。`], ["乙".repeat(10), "乙".repeat(10)]]);
  assert.deepEqual(splitLongRanges(spaced).map((one) => one.text), splitLong(spaced));
});

test("Word 文档的位置：每一截提取出来与核对摘录用的段文字相同（带图片链接的段、表格里带转义竖线的格也一样）；表格的各行各格记段落号，合并格记占位；块的编号是分段清单的块序号", () => {
  const projection = projectionOf(10, [
    "# 1 [p1] 规则", "",
    "[p2] 普通的一段。", "",
    "| [p3] 类型 | [p4] 上限<br>[p5] （本） |",
    "|---|---|",
    "| [p6] 学生 | [p7] 5 |",
    "| （同上） | [p8] 含 \\| 竖线 |",
    "|  | [p9] 前一格是空的 |", "",
    "[p10] 带图 ![图](media/a.png) 的一段", "",
  ]);
  const paragraphs = projectionParagraphs(projection);
  const [chunk, ...rest] = chunkWord(projection, SEGMENT_DEFAULTS);
  assert.equal(rest.length, 0);
  assert.equal(chunk.block, buildSegments(projection, SEGMENT_DEFAULTS, "", "").blocks[0].index);
  assert.deepEqual(chunk.pieces.map((piece) => piece.paragraph), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const piece of chunk.pieces) assert.equal(pieceText(projection, piece), paragraphs[piece.paragraph! - 1], `第 ${piece.paragraph} 段`);
  assert.equal(pieceText(projection, chunk.pieces[7]), "含 | 竖线");
  assert.equal(pieceText(projection, chunk.pieces[9]), "带图 的一段");
  // 表格里的段带 cell，不在表格里的不带。
  assert.deepEqual(chunk.pieces.map((piece) => piece.cell === true), [false, false, true, true, true, true, true, true, true, false]);
  assert.deepEqual(chunk.rows, [[[3], [4, 5]], [[6], [7]], ["（同上）", [8]], ["", [9]]]);
  assert.equal("header" in chunk, false);
  // 片段的起止盖住它的每一截。
  assert.ok(chunk.pieces.every((piece) => piece.start >= chunk.start_offset && piece.end <= chunk.end_offset));
  // 没有表格的片段没有 rows。
  const plainOnly = chunkWord(projectionOf(2, ["# 1 [p1] 规则", "", "[p2] 一段。", ""]), SEGMENT_DEFAULTS);
  assert.equal("rows" in plainOnly[0], false);
});

test("Word 表格切到两个片段：后面的片段记下重复的表头行（它自己的段落号范围、各格与各段的位置），表头不算进片段的各截与起止段落号", () => {
  const row = (n: number) => `| [p${n}] ${"甲".repeat(180)} | [p${n + 1}] ${"乙".repeat(180)} |`;
  const projection = projectionOf(12, ["# 1 [p1] 表", "", "| [p2] 名称 | [p3] 说明 |", "|---|---|", row(4), row(6), row(8), row(10), ""]);
  const paragraphs = projectionParagraphs(projection);
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  assert.ok(chunks.length >= 2);
  assert.equal("header" in chunks[0], false);
  for (const c of chunks.slice(1)) {
    assert.ok(c.text.startsWith("| 名称 | 说明 |\n"));
    assert.deepEqual([c.header!.first_paragraph, c.header!.last_paragraph, c.header!.cells], [2, 3, [[2], [3]]]);
    assert.deepEqual(c.header!.pieces.map((piece) => [piece.paragraph, pieceText(projection, piece)]), [[2, "名称"], [3, "说明"]]);
    // 表头的段不在片段自己的各截里，片段的起止段落号也不含它。
    assert.ok(c.pieces.every((piece) => piece.paragraph! >= c.first_paragraph! && piece.paragraph! <= c.last_paragraph!));
    assert.ok(c.first_paragraph! > 3);
    assert.equal(c.rows!.length, c.text.split("\n").length - 1);
  }
  for (const c of chunks) for (const piece of c.pieces) assert.equal(pieceText(projection, piece), paragraphs[piece.paragraph! - 1]);
});

test("Word 文档里超过上限的一段：各截记自己的位置；段里夹着图片链接、在投影里找不到这一截的原样文字时记整段的位置。超过上限的一行表格：在格之间切出来的各片记各自的格，单独一格切出来的各截都记这一格的段", () => {
  const long = `${"借".repeat(799)}。${"还".repeat(300)}`;
  const projection = projectionOf(3, ["# 1 [p1] 规则", "", `[p2] ${long}`, "", `[p3] ${"借".repeat(500)} ![图](media/a.png) ${"还".repeat(500)}`, ""]);
  const paragraphs = projectionParagraphs(projection);
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  const second = chunks.filter((c) => c.first_paragraph === 2 && c.partial);
  assert.deepEqual(second.map((c) => size(c.text)), [800, 300]);
  for (const c of second) assert.deepEqual([pieceText(projection, c.pieces[0]), c.pieces[0].paragraph], [c.text, 2]);
  // 第 3 段夹着图片链接：切出来的两截都记整段，提取出来是整段的文字。
  const third = chunks.filter((c) => c.first_paragraph === 3);
  assert.equal(third.length, 2);
  for (const c of third) {
    assert.equal(c.partial, true);
    assert.equal(pieceText(projection, c.pieces[0]), paragraphs[2]);
    assert.ok(paragraphs[2].includes(c.text));
  }
  // 一行表格超过上限：在格之间切。
  const wide = projectionOf(5, ["# 1 [p1] 表", "", `| [p2] ${"甲".repeat(500)} | [p3] ${"乙".repeat(500)} | [p4] ${"丙".repeat(900)}<br>[p5] 尾 |`, ""]);
  const cut = chunkWord(wide, SEGMENT_DEFAULTS).filter((c) => c.rows);
  assert.deepEqual(cut.map((c) => [c.first_paragraph, c.last_paragraph, c.rows, c.partial === true, c.pieces.map((piece) => piece.paragraph)]), [
    [2, 2, [[[2]]], false, [2]],
    [3, 3, [[[3]]], false, [3]],
    // 单独一格超过上限：切出来的两截都记这一格的两段。
    [4, 5, [[[4, 5]]], true, [4, 5]],
    [4, 5, [[[4, 5]]], true, [4, 5]],
  ]);
});

test("表格一行拆成各格的办法与核对摘录时相同，另给每格的起点：转义的竖线不算分隔，两头的空白与竖线去掉", () => {
  for (const line of ["| [p1] 甲 | [p2] 乙 |", "|甲|乙|丙|", "  | 含 \\| 竖线 |  尾 |  ", "| （同左） |  | [p3] 丙<br>[p4] 丁 |", "| 末尾是转义的竖线 \\|", "||"]) {
    const got = tableCellRanges(line);
    assert.deepEqual(got.map((cell) => cell.text), tableCells(line), line);
    for (const cell of got) assert.equal(line.slice(cell.at, cell.at + cell.text.length), cell.text, line);
  }
});
