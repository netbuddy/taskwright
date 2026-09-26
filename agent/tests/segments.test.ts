// Word 材料的分段清单（lib/segments.ts）：按标题分块、太小的并入、太大的切开、起止行号；清单文件的读取与按参数重算；
// 引用情况在 task_status.test.ts 里连同任务现状消息一起测。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectionParagraphs } from "../src/lib/docx_source.ts";
import {
  SEGMENT_DEFAULTS, SEGMENTS_ENV, buildSegments, envSegmentParams, paramsDigest, readSegments, segmentParams,
} from "../src/lib/segments.ts";

const FIXTURE = join(import.meta.dirname, "../../web/src/test/fixtures/requirements-styled.docx.md");
const TEXT = readFileSync(FIXTURE, "utf-8");
const shape = (list: ReturnType<typeof buildSegments>) =>
  list.blocks.map((b) => [b.index, b.first_paragraph, b.last_paragraph, b.first_line, b.last_line, b.paragraphs, b.heading]);

/** 现造一份投影：几段正文，标题行用 # 写。 */
function projection(lines: string[], total: number): string {
  return `<!--\n由 x.docx 生成，供助手阅读。段落总数：${total}。\n-->\n\n${lines.join("\n\n")}\n`;
}

test("样本按默认参数分成 11 块：标题作块界，太小的块并入下一块、标题相连，块首尾相接覆盖全部段落", () => {
  const list = buildSegments(TEXT, SEGMENT_DEFAULTS, "inputs/x.docx", "inputs/x.docx.md");
  assert.equal(list.version, 1);
  assert.equal(list.params_digest, paramsDigest(SEGMENT_DEFAULTS));
  assert.deepEqual([list.source, list.projection, list.paragraphs], ["inputs/x.docx", "inputs/x.docx.md", 114]);
  assert.deepEqual(shape(list), [
    [1, 1, 5, 10, 18, 5, null],
    [2, 6, 9, 20, 26, 4, "1 概述"],
    [3, 10, 14, 28, 36, 5, "1.1 范围；1.2 术语"],
    [4, 15, 23, 38, 48, 9, "2 读者与借阅规则；2.1 读者类型"],
    [5, 24, 33, 50, 63, 9, "2.2 借书流程"],
    [6, 34, 71, 65, 82, 35, "2.3 借阅上限"],
    [7, 72, 74, 84, 88, 3, "3 归还、罚款与预约；3.1 归还"],
    [8, 75, 78, 90, 96, 4, "3.1.1 逾期罚款；3.1.2 损坏与丢失"],
    [9, 79, 81, 98, 105, 3, "3.2 预约"],
    [10, 82, 109, 107, 119, 26, "3.3 到期提醒；4 非功能需求"],
    [11, 110, 114, 121, 127, 5, "5 待定事项"],
  ]);
  // 块的段数只数有文字的段，合起来等于全文有文字的段数；字数是各段文字的字数之和。
  const paragraphs = projectionParagraphs(TEXT);
  assert.equal(list.blocks.reduce((sum, b) => sum + b.paragraphs, 0), paragraphs.filter((p) => p.trim()).length);
  assert.equal(list.blocks.reduce((sum, b) => sum + b.chars, 0), paragraphs.reduce((sum, p) => sum + [...p].length, 0));
  // 起止行号：块的第一行是它第一段所在的行。
  const lines = TEXT.split("\n");
  assert.ok(lines[20 - 1].startsWith("# 1 [p6] 概述"));
  assert.ok(lines[65 - 1].startsWith("## 2.3 [p34] 借阅上限"));
});

test("参数：标题级别改成 1 时只按一级标题切；段数下限改成 1 时不合并", () => {
  const top = buildSegments(TEXT, { ...SEGMENT_DEFAULTS, heading_depth: 1 }, "inputs/x.docx", "inputs/x.docx.md");
  assert.deepEqual(top.blocks.map((b) => b.heading), [null, "1 概述", "2 读者与借阅规则", "3 归还、罚款与预约", "4 非功能需求", "5 待定事项"]);
  const loose = buildSegments(TEXT, { ...SEGMENT_DEFAULTS, min_paragraphs: 1 }, "inputs/x.docx", "inputs/x.docx.md");
  assert.equal(loose.blocks.length, 16);
  assert.notEqual(top.params_digest, loose.params_digest);
});

test("没有标题的材料整份一块；超过段数上限按段数切开；最后一块不够时并入前一块", () => {
  const flat = projection(Array.from({ length: 10 }, (_, i) => `[p${i + 1}] 第 ${i + 1} 段`), 10);
  assert.deepEqual(shape(buildSegments(flat, SEGMENT_DEFAULTS, "a", "b")), [[1, 1, 10, 5, 23, 10, null]]);
  assert.deepEqual(shape(buildSegments(flat, { ...SEGMENT_DEFAULTS, max_paragraphs: 4, min_paragraphs: 1 }, "a", "b")),
    [[1, 1, 4, 5, 11, 4, null], [2, 5, 8, 13, 19, 4, null], [3, 9, 10, 21, 23, 2, null]]);
  const tail = projection(["# [p1] 一", "[p2] 甲", "[p3] 乙", "[p4] 丙", "# [p5] 二", "[p6] 丁"], 6);
  assert.deepEqual(shape(buildSegments(tail, SEGMENT_DEFAULTS, "a", "b")), [[1, 1, 6, 5, 15, 6, "一；二"]]);
});

test("空段落占段落号但不算段数；文本框行算在所在的块里", () => {
  const text = projection(["# [p1] 一", "[p2] 甲", "[p4] 乙", "> （文本框）框里的字", "## [p5] 二", "[p6] 丙", "[p7] 丁"], 7);
  assert.deepEqual(shape(buildSegments(text, SEGMENT_DEFAULTS, "a", "b")), [[1, 1, 4, 5, 11, 3, "一"], [2, 5, 7, 13, 17, 3, "二"]]);
});

test("0.2 的纯文本投影也能分块（没有标题，整份一块）", () => {
  const legacy = "[第 1 段] 甲\n[第 2 段 · 表 1 行 1 列 1] 乙\n[第 3 段] 丙\n";
  assert.deepEqual(shape(buildSegments(legacy, SEGMENT_DEFAULTS, "a", "b")), [[1, 1, 3, 1, 3, 3, null]]);
});

test("读清单：不在就算好写回；参数摘要一致就用文件里的；参数变了重算并覆盖；纯文本投影只算不写；投影读不到是 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "segments-"));
  try {
    const md = join(dir, "x.docx.md");
    const file = join(dir, "x.docx.segments.json");
    writeFileSync(md, TEXT);
    const first = readSegments(md, SEGMENT_DEFAULTS, "inputs/x.docx", "inputs/x.docx.md")!;
    assert.equal(first.blocks.length, 11);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), first);
    // 摘要一致时用文件里的（这里改掉一个标题来辨认）。
    writeFileSync(file, JSON.stringify({ ...first, blocks: [{ ...first.blocks[0], heading: "文件里的" }, ...first.blocks.slice(1)] }));
    assert.equal(readSegments(md, SEGMENT_DEFAULTS, "inputs/x.docx", "inputs/x.docx.md")!.blocks[0].heading, "文件里的");
    const changed = readSegments(md, { ...SEGMENT_DEFAULTS, heading_depth: 1 }, "inputs/x.docx", "inputs/x.docx.md")!;
    assert.equal(changed.blocks.length, 6);
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).params_digest, paramsDigest({ ...SEGMENT_DEFAULTS, heading_depth: 1 }));
    writeFileSync(file, "坏了");
    assert.equal(readSegments(md, SEGMENT_DEFAULTS, "inputs/x.docx", "inputs/x.docx.md")!.blocks.length, 11);
    const txt = join(dir, "y.docx.txt");
    writeFileSync(txt, "[第 1 段] 甲\n[第 2 段] 乙\n");
    assert.equal(readSegments(txt, SEGMENT_DEFAULTS, "inputs/y.docx", "inputs/y.docx.txt")!.blocks.length, 1);
    assert.equal(existsSync(join(dir, "y.docx.segments.json")), false);
    assert.equal(readSegments(join(dir, "z.docx.md"), SEGMENT_DEFAULTS, "a", "b"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("分段参数：缺项用默认值，写错时报清楚；环境变量没设或写错时用默认值", () => {
  assert.deepEqual(segmentParams(undefined), SEGMENT_DEFAULTS);
  assert.deepEqual(segmentParams('{"max_paragraphs":50}'), { ...SEGMENT_DEFAULTS, max_paragraphs: 50 });
  assert.throws(() => segmentParams('{"min_paragraphs":0}'), /min_paragraphs 应当是正整数/);
  assert.throws(() => segmentParams("{"), /不是合法的 JSON/);
  assert.deepEqual(envSegmentParams({ [SEGMENTS_ENV]: '{"heading_depth":2}' }), { ...SEGMENT_DEFAULTS, heading_depth: 2 });
  assert.deepEqual(envSegmentParams({ [SEGMENTS_ENV]: "坏了" }), SEGMENT_DEFAULTS);
  assert.deepEqual(envSegmentParams({}), SEGMENT_DEFAULTS);
});
