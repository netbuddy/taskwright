// PDF 材料的来源（lib/pdf_source.ts）：从投影取各块、带对照的比较层规范化、摘录落在哪几块的第几个字到第几个字。

import assert from "node:assert/strict";
import { test } from "node:test";
import { comparablePdfText } from "../src/lib/pdf_normalize.ts";
import { PDF_SPAN_LIMIT, comparableWithMap, pdfProjectionUnits, pdfUnitIndex, pdfUnitsWith, placePdfExcerpt } from "../src/lib/pdf_source.ts";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
/** 「工」「日」「金」写成康熙部首字符，「风」写成部首补充字符（backend/tests/fixtures/pdf/quirks.pdf 里的四个）。 */
const RADICAL = { 工: cp(0x2f2f), 日: cp(0x2f47), 金: cp(0x2fa6), 风: cp(0x2edb) };

const PROJECTION = [
  "<!--",
  "由 办法.pdf 生成，供助手阅读。页数：3。块总数：7。",
  "[p9-9] 说明里的这一行不是块",
  "-->",
  "",
  "> （页眉页脚）借阅管理办法",
  "[p1-1] 第一条 读者凭借书证借书，",
  "",
  "[p1-2] 每次最多借五本；",
  "",
  "[p1-3] 借期三十天。",
  "",
  "> （页眉页脚）第 1 页",
  "[p2-1] 第二条 逾期不还的，每本每天收取滞纳金。",
  "",
  "[p2-0] （这一页没有文字，可能是扫描件）",
  "",
  "[p3-1] 第三条 本办法自发布之日起施行。",
  "没有定位符的行不是块",
].join("\n");

test("从投影取各块：说明注释、页眉页脚行、没有定位符的行不算；块号 0 的那一行在里面但不能作出处", () => {
  const units = pdfProjectionUnits(PROJECTION);
  assert.deepEqual(units.map((u) => [u.page, u.block, u.line]), [[1, 1, 7], [1, 2, 9], [1, 3, 11], [2, 1, 14], [2, 0, 16], [3, 1, 18]]);
  assert.equal(units[0].text, "第一条 读者凭借书证借书，");
  assert.deepEqual([pdfUnitIndex(units, 2, 1), pdfUnitIndex(units, 2, 0), pdfUnitIndex(units, 4, 1)], [3, -1, -1]);
});

test("带对照的规范化：结果与 comparablePdfText 逐字相同；每个码元指回原文的那一截", () => {
  const samples = [
    "平台应当在两个工作日内答复",
    `平台应当在两个${RADICAL.工}作${RADICAL.日}内答复，退款${RADICAL.金}额按原路退回，${RADICAL.风}险由平台承担。`,
    "汇 率 按 申 请 当 天 的 中 间 价 计 算",
    `a${cp(0xad)}b${cp(0x200b)}c　全角空格 ＡＢＣ１２３`,
    "the confir-\nmation of high-level ﬁles",
    `${cp(0x2e87)}在基本平面之外`,
    `cafe${cp(0x301)} 与 e${cp(0x301)}${cp(0x327)}`,
    `拆开写的谚文 ${cp(0x1100, 0x1161)}${cp(0x1102, 0x1161, 0x11ab)} 合成音节`,
    "",
    "   ",
  ];
  for (const original of samples) {
    const got = comparableWithMap(original);
    assert.equal(got.text, comparablePdfText(original), JSON.stringify(original));
    assert.deepEqual([got.start.length, got.end.length], [got.text.length, got.text.length], JSON.stringify(original));
    for (let k = 0; k < got.text.length; k++) {
      assert.ok(got.start[k] >= 0 && got.start[k] < got.end[k] && got.end[k] <= original.length, `${JSON.stringify(original)} 第 ${k} 个`);
      if (k > 0) assert.ok(got.start[k] >= got.start[k - 1] && got.end[k] >= got.end[k - 1], `${JSON.stringify(original)} 第 ${k} 个：位置不往回走`);
    }
  }
  // 部首字符换成了通用汉字，位置指回那个部首字符。
  const radical = comparableWithMap(`两个${RADICAL.工}作${RADICAL.日}`);
  assert.equal(radical.text, "两个工作日");
  assert.deepEqual([radical.start[2], radical.end[2], radical.start[4], radical.end[4]], [2, 3, 4, 5]);
  // 被撑开的字：空格不属于任何一截，字各指各的。
  const spaced = comparableWithMap("汇 率 按");
  assert.deepEqual([spaced.text, spaced.start, spaced.end], ["汇率按", [0, 2, 4], [1, 3, 5]]);
  // 一个字规范化成两个字（连字 ﬁ）：两个字指向同一截。
  const ligature = comparableWithMap("aﬁb");
  assert.deepEqual([ligature.text, ligature.start, ligature.end], ["afib", [0, 1, 1, 2], [1, 2, 2, 3]]);
  // 字后面跟着组合记号：合成一个字，指回连记号在内的那一截。
  const mark = comparableWithMap(`cafe${cp(0x301)}!`);
  assert.deepEqual([mark.text.length, mark.start[3], mark.end[3], mark.start[4]], [5, 3, 5, 5]);
  // 通用汉字在基本平面之外（占两个码元）：两个码元指回同一个部首字符。
  const astral = comparableWithMap(`${cp(0x2e87)}字`);
  assert.deepEqual([astral.text.length, astral.start, astral.end], [3, [0, 0, 1], [1, 1, 2]]);
  // 相邻两截合成一个字（拆开写的谚文字母）：走另一条算法，合成的字指回合成它的那几截。
  const hangul = comparableWithMap(`a${cp(0x1100, 0x1161)}b`);
  assert.deepEqual([hangul.text, hangul.start, hangul.end], [`a${cp(0xac00)}b`, [0, 1, 3], [1, 3, 4]]);
});

test("摘录落在哪里：块内、同一页里往后接块、跨页、找不到；给出每块原文里的起止", () => {
  const units = pdfProjectionUnits(PROJECTION);
  const slices = (place: ReturnType<typeof placePdfExcerpt>) => ("ranges" in place ? place.ranges.map((r) => [r.page, r.block, units[r.index].text.slice(r.start, r.end)]) : []);
  // 块内；摘录里的空白与原文不同不要紧。
  const inside = placePdfExcerpt(units, 1, 1, "读者凭 借书证");
  assert.deepEqual([inside.kind, slices(inside)], ["in", [[1, 1, "读者凭借书证"]]]);
  // 从出处那一块开始，接到同一页后面的两块。
  const span = placePdfExcerpt(units, 1, 1, "借书，每次最多借五本；借期三十天");
  assert.deepEqual([span.kind, slices(span)], ["span", [[1, 1, "借书，"], [1, 2, "每次最多借五本；"], [1, 3, "借期三十天"]]]);
  // 摘录不是从出处那一块开始的：找不到。
  assert.equal(placePdfExcerpt(units, 1, 1, "每次最多借五本").kind, "miss");
  // 接上下一页才找得到：跨页。
  assert.equal(placePdfExcerpt(units, 1, 3, "借期三十天。第二条").kind, "cross_page");
  // 改了一个字、块不存在、块号 0、摘录是空的：都找不到。
  assert.equal(placePdfExcerpt(units, 1, 1, "读者凭借阅证借书").kind, "miss");
  assert.equal(placePdfExcerpt(units, 5, 1, "读者").kind, "miss");
  assert.equal(placePdfExcerpt(units, 2, 0, "这一页没有文字").kind, "miss");
  assert.equal(placePdfExcerpt(units, 1, 1, " \n ").kind, "miss");
  // 摘录在别的哪几块：只列能从那一块开始、不跨页的。
  assert.deepEqual(pdfUnitsWith(units, "借期三十天"), [{ page: 1, block: 3 }]);
  assert.deepEqual(pdfUnitsWith(units, "条"), [{ page: 1, block: 1 }, { page: 2, block: 1 }, { page: 3, block: 1 }]);
  assert.deepEqual(pdfUnitsWith(units, "没有这句话"), []);
});

test("摘录落在哪里：原文是部首字符、字被撑开时，起止指回原文里的那几个字", () => {
  const text = `平台应当在两个${RADICAL.工}作${RADICAL.日}内答复， 退 款 ${RADICAL.金} 额 按 原 路 退 回`;
  const units = pdfProjectionUnits(`[p1-1] ${text}`);
  const place = placePdfExcerpt(units, 1, 1, "两个工作日内答复，退款金额");
  assert.equal(place.kind, "in");
  const [range] = (place as { ranges: { start: number; end: number }[] }).ranges;
  assert.equal(text.slice(range.start, range.end), `两个${RADICAL.工}作${RADICAL.日}内答复， 退 款 ${RADICAL.金} 额`);
});

test(`往后最多接 ${PDF_SPAN_LIMIT} 块：接第 ${PDF_SPAN_LIMIT + 1} 块才对得上的找不到`, () => {
  const lines = Array.from({ length: PDF_SPAN_LIMIT + 2 }, (_, i) => `[p1-${i + 1}] 第${"一二三四五六七八"[i]}句。`);
  const units = pdfProjectionUnits(lines.join("\n\n"));
  const through = (count: number) => Array.from({ length: count }, (_, i) => `第${"一二三四五六七八"[i]}句。`).join("");
  assert.equal(placePdfExcerpt(units, 1, 1, through(PDF_SPAN_LIMIT + 1)).kind, "span");
  assert.equal(placePdfExcerpt(units, 1, 1, through(PDF_SPAN_LIMIT + 2)).kind, "miss");
});
