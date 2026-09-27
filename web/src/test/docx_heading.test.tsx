// 材料区推导章节用的标题级别（与投影共用 agent 的 lib/docx_heading.ts）：三份小 Word 文件逐段的标题级别，
// 与 agent/tests/docx_heading.test.ts 里投影的 # 级数是同一组期望值；来源标签里的章节取这一段之前最近的标题。
// 夹具由 agent/tests/fixtures/build_heading_docx.mts 生成，内容是中性文字。

import { afterEach, describe, expect, it } from "vitest";
import { renderDocx, tableOf, whereOf, type DocxTable } from "../model/docx";
import BY_NAME from "./fixtures/headings-by-name.docx?inline";
import INHERITED from "./fixtures/headings-inherited.docx?inline";
import BODY_LEVEL from "./fixtures/headings-body-level.docx?inline";

const bytesOf = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));

async function table(url: string): Promise<DocxTable> {
  const host = document.createElement("div");
  document.body.append(host);
  return tableOf(await renderDocx(bytesOf(url), host));
}

/** 逐段的标题：段落号 → 级别（1 是一级，与投影里 # 的个数相同）。 */
const headingsOf = (t: DocxTable) =>
  Object.fromEntries(t.info.flatMap((i, n) => (i?.heading != null ? [[n, i.heading + 1]] : [])));

afterEach(() => { document.body.innerHTML = ""; });

describe("标题级别与章节", () => {
  it("只靠样式名的标题认作一级、二级、三级；名为 Heading、Table Heading、Title 的不是标题；章节取之前最近的标题", async () => {
    const t = await table(BY_NAME);
    expect(headingsOf(t)).toEqual({ 2: 1, 5: 2, 7: 3, 9: 1 });
    expect(t.info[2]?.title).toBe("1 概述");
    expect(whereOf(t, 1)).not.toContain("1 概述");
    expect(whereOf(t, 4)).toContain("1 概述");
    expect(whereOf(t, 8)).toContain("1.1.1 例外");
    // 「2 日常养护」只靠样式名：它下面的段落（含名为 Heading 的段落、表格里的段落）都归它
    for (const n of [10, 11, 12, 15, 16]) expect(whereOf(t, n)).toContain("2 日常养护");
  });

  it("大纲级别写在被继承的上级样式里也认；段落自身的大纲级别先于样式", async () => {
    const t = await table(INHERITED);
    expect(headingsOf(t)).toEqual({ 1: 1, 3: 2, 5: 2, 7: 3 });
    expect(whereOf(t, 6)).toContain("1.2 夏季");
    expect(whereOf(t, 9)).toContain("1.2.1 防暑");
  });

  it("大纲级别写成 9 的段落不是标题，它下面的段落仍归前一个标题", async () => {
    const t = await table(BODY_LEVEL);
    expect(headingsOf(t)).toEqual({ 1: 1, 7: 1 });
    for (const n of [3, 4, 5, 6]) expect(whereOf(t, n)).toContain("1 总则");
    expect(whereOf(t, 8)).toContain("2 附则");
  });
});
