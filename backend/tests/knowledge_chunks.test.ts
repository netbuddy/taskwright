/**
 * 知识库文档切成片段（src/knowledge_chunks.ts）：Word 文档按分段清单的块、块内照投影的行接，表格一行算一个单位；Markdown 按标题与空行；纯文本只按空行；
 * 超过上限的一段先在句末切、找不到句末就在上限处切；全是空白的段不成片段；送去换算的文字是标题一行加正文。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { docxProjection } from "../../agent/src/lib/docx_markdown.ts";
import { projectionParagraphs } from "../../agent/src/lib/docx_source.ts";
import { SEGMENT_DEFAULTS, buildSegments } from "../../agent/src/lib/segments.ts";
import { CHUNK_MAX_CHARS, type Chunk, chunkDocument, chunkInput, chunkMarkdown, chunkPlain, chunkWord, splitLong } from "../src/knowledge_chunks.ts";
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
