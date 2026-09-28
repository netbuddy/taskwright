// 位置表（后端上传时写的「文件名.docx.locations.json」，规则在 agent 的 lib/docx_locations.ts）与页面现有推导（model/docx.ts 的
// renderDocx、tableOf、whereOf，在模拟浏览器里用排版库画）逐段比较章节部分：分页标记的个数、每段的标题级别、标题文字、来源标签里的章节。
// 页码与页内位置暂不比较（位置表暂不写它们）。
// 位置表由 agent/tests/fixtures/build_location_docx.mts 生成并存在 fixtures/ 下，agent 的测试核对存着的与现算的相同。
//
// 标题文字两边的数法不同：位置表按投影的数法（认 w:startOverride、法律式编号 w:isLgl，样式里没写级别按第 0 级），只带十进制编号；
// 页面现有的数法不完整。在页面数法不完整的段落上，下面把两边各自的值都写出来，差别算页面的已知缺陷，第二段页面改为查表时消失。

import { afterEach, describe, expect, it } from "vitest";
import { chapterOf, type LocationFile } from "../../../agent/src/lib/docx_locations";
import { renderDocx, tableOf, whereOf, type DocxTable } from "../model/docx";
import SAMPLE from "../../../examples/library-lending/requirements-styled.docx?inline";
import BY_NAME from "./fixtures/headings-by-name.docx?inline";
import INHERITED from "./fixtures/headings-inherited.docx?inline";
import BODY_LEVEL from "./fixtures/headings-body-level.docx?inline";
import NUMBERING from "./fixtures/loc-numbering.docx?inline";
import STYLE_NO_LEVEL from "./fixtures/loc-style-no-level.docx?inline";
import HIDDEN from "./fixtures/loc-hidden.docx?inline";
import SAMPLE_TABLE from "./fixtures/requirements-styled.docx.locations.json";
import BY_NAME_TABLE from "./fixtures/headings-by-name.docx.locations.json";
import INHERITED_TABLE from "./fixtures/headings-inherited.docx.locations.json";
import BODY_LEVEL_TABLE from "./fixtures/headings-body-level.docx.locations.json";
import NUMBERING_TABLE from "./fixtures/loc-numbering.docx.locations.json";
import STYLE_NO_LEVEL_TABLE from "./fixtures/loc-style-no-level.docx.locations.json";
import HIDDEN_TABLE from "./fixtures/loc-hidden.docx.locations.json";

const bytesOf = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const SLOW = { timeout: 30_000 };

afterEach(() => { document.body.innerHTML = ""; });

async function pageTable(url: string): Promise<DocxTable> {
  const host = document.createElement("div");
  document.body.append(host);
  return tableOf(await renderDocx(bytesOf(url), host));
}

/** 页面每段的标题：段落号 → [级别（1 是一级）, 标题文字]。 */
const pageHeadings = (t: DocxTable) =>
  Object.fromEntries(t.info.flatMap((i, n) => (i?.heading != null ? [[n, [i.heading + 1, i.title] as [number, string]]] : [])));
/** 位置表每段的标题：段落号 → [级别, 标题文字]。 */
const tableHeadings = (l: LocationFile) => Object.fromEntries(l.headings.map((h) => [h.paragraph, [h.level, h.title] as [number, string]]));
/** 页面 whereOf 给出的三段里的章节那一段（去掉「第几页」与「页上中下」）；没有时为 null。 */
const pageChapter = (t: DocxTable, n: number) => whereOf(t, n).filter((s) => !/^第 \d+ 页$/.test(s) && !/^页[上中下]$/.test(s))[0] ?? null;
/** 有文字的段落号（页面）。 */
const textParagraphs = (t: DocxTable) => t.texts.flatMap((s, n) => (s ? [n] : []));

/** 两边段落号相同的样例：分页标记个数、标题级别与文字、每个有文字的段的章节，逐段相同。 */
async function sameEverywhere(url: string, table: LocationFile) {
  const t = await pageTable(url);
  expect(table.page_marks).toBe(t.marks);
  expect(tableHeadings(table)).toEqual(pageHeadings(t));
  const paragraphs = textParagraphs(t);
  expect(paragraphs.length).toBeGreaterThan(0);
  for (const n of paragraphs) expect([n, chapterOf(table, n)]).toEqual([n, pageChapter(t, n)]);
}

describe("位置表与页面现有推导：章节部分逐段相同", () => {
  it("主样例 requirements-styled.docx", SLOW, () => sameEverywhere(SAMPLE, SAMPLE_TABLE as LocationFile));
  it("标题样例：只靠样式名", SLOW, () => sameEverywhere(BY_NAME, BY_NAME_TABLE as LocationFile));
  it("标题样例：大纲级别写在上级样式里", SLOW, () => sameEverywhere(INHERITED, INHERITED_TABLE as LocationFile));
  it("标题样例：大纲级别写成 9", SLOW, () => sameEverywhere(BODY_LEVEL, BODY_LEVEL_TABLE as LocationFile));
});

describe("编号样例 loc-numbering.docx", () => {
  // 页面数法不完整的段落：段落号 → [位置表的标题文字, 页面的标题文字, 原因]。
  const KNOWN: Record<number, [string, string, string]> = {
    9: ["带项目符号的标题", "• 带项目符号的标题", "页面把项目符号的级别文字当作编号写进标题；位置规则只带十进制编号，项目符号不带"],
    15: ["7 起始值被覆盖成七的一章", "1 起始值被覆盖成七的一章", "页面不看 w:startOverride"],
    17: ["1.1 法律式编号的一节", "法律式编号的一节", "页面不看法律式编号 w:isLgl，上一级是罗马数字就不带编号"],
  };

  it("分页标记个数、标题级别逐段相同；标题文字除页面的已知缺陷之外逐段相同，缺陷处两边的值如下", SLOW, async () => {
    const t = await pageTable(NUMBERING);
    const table = NUMBERING_TABLE as LocationFile;
    expect(table.page_marks).toBe(t.marks);
    const page = pageHeadings(t);
    const ours = tableHeadings(table);
    expect(Object.keys(ours)).toEqual(Object.keys(page));
    for (const n of Object.keys(ours).map(Number)) {
      expect([n, ours[n][0]]).toEqual([n, page[n][0]]);
      if (KNOWN[n]) expect([n, ours[n][1], page[n][1]]).toEqual([n, KNOWN[n][0], KNOWN[n][1]]);
      else expect([n, ours[n][1]]).toEqual([n, page[n][1]]);
    }
    for (const n of textParagraphs(t)) {
      const m = [...Object.keys(ours).map(Number)].filter((k) => k <= n).pop();
      if (m !== undefined && KNOWN[m]) expect([n, chapterOf(table, n), pageChapter(t, n)]).toEqual([n, KNOWN[m][0], KNOWN[m][1]]);
      else expect([n, chapterOf(table, n)]).toEqual([n, pageChapter(t, n)]);
    }
  });
});

describe("编号写在样式里、样式没写级别 loc-style-no-level.docx", () => {
  it("位置表按第 0 级数出编号；页面现有的推导遇到这种文件出错（页面的已知缺陷），整份画不出来", SLOW, async () => {
    expect((STYLE_NO_LEVEL_TABLE as LocationFile).headings).toEqual([{ paragraph: 1, level: 2, title: "1 样式里没写级别的标题" }]);
    await expect(pageTable(STYLE_NO_LEVEL)).rejects.toThrow(RangeError);
  });
});

describe("排版库不画的段落 loc-hidden.docx", () => {
  // 后端段落 3、4 在 w:customXml 里，段落 7 在单元格的内容控件里，排版库不画；页面自己的段落号因此从第 3 段起比库里的少。
  const HIDDEN_PARAGRAPHS = [3, 4, 7];
  const toBackend = (pageN: number) => {
    let n = 0;
    for (let k = 0; k < pageN; k++) do n++; while (HIDDEN_PARAGRAPHS.includes(n));
    return n;
  };

  it("页面看不到的标题段位置表照记，它之后到下一个标题之前的段落，章节两边不同（已知的差别）；其余相同", SLOW, async () => {
    const t = await pageTable(HIDDEN);
    const table = HIDDEN_TABLE as LocationFile;
    expect(t.info.length - 1).toBe(table.paragraphs - HIDDEN_PARAGRAPHS.length);
    expect(Object.fromEntries(Object.entries(pageHeadings(t)).map(([n, v]) => [toBackend(Number(n)), v])))
      .toEqual(Object.fromEntries(Object.entries(tableHeadings(table)).filter(([n]) => !HIDDEN_PARAGRAPHS.includes(Number(n)))));
    const rows = textParagraphs(t).map((n) => [toBackend(n), chapterOf(table, toBackend(n)), pageChapter(t, n)]);
    expect(rows).toEqual([
      [1, "1 总则", "1 总则"],
      [2, "1 总则", "1 总则"],
      [5, "2 包在自定义标记里的一章", "1 总则"], // 位置表：之前最近的标题是自定义标记里的第 3 段；页面看不到它
      [6, "2 包在自定义标记里的一章", "1 总则"],
      [8, "2 包在自定义标记里的一章", "1 总则"],
      [9, "3 正文里内容控件中的一章", "3 正文里内容控件中的一章"],
      [10, "3 正文里内容控件中的一章", "3 正文里内容控件中的一章"],
    ]);
  });
});
