// 材料区来源标签里的章节查位置表（后端上传时写的 x.docx.locations.json，与投影的标题行出自同一个函数，标题级别规则见
// agent 的 lib/docx_heading.ts）：三份小 Word 文件的标题级别与 agent/tests/docx_heading.test.ts 里投影的 # 级数是同一组期望值；
// 章节取这一段（含）之前最近的标题。位置表夹具由 agent/tests/fixtures/build_location_docx.mts 生成，内容是中性文字。

import { describe, expect, it } from "vitest";
import { chapterOf, type LocationFile } from "../../../agent/src/lib/docx_locations";
import BY_NAME from "./fixtures/headings-by-name.docx.locations.json";
import INHERITED from "./fixtures/headings-inherited.docx.locations.json";
import BODY_LEVEL from "./fixtures/headings-body-level.docx.locations.json";

/** 逐段的标题：段落号 → 级别（1 是一级，与投影里 # 的个数相同）。 */
const headingsOf = (t: LocationFile) => Object.fromEntries(t.headings.map((h) => [h.paragraph, h.level]));

describe("标题级别与章节", () => {
  it("只靠样式名的标题认作一级、二级、三级；名为 Heading、Table Heading、Title 的不是标题；章节取之前最近的标题", () => {
    const t = BY_NAME as LocationFile;
    expect(headingsOf(t)).toEqual({ 2: 1, 5: 2, 7: 3, 9: 1 });
    expect(t.headings[0].title).toBe("1 概述");
    expect(chapterOf(t, 1)).toBeNull();
    expect(chapterOf(t, 4)).toBe("1 概述");
    expect(chapterOf(t, 8)).toBe("1.1.1 例外");
    // 「2 日常养护」只靠样式名：它下面的段落（含名为 Heading 的段落、表格里的段落）都归它
    for (const n of [10, 11, 12, 15, 16]) expect(chapterOf(t, n)).toBe("2 日常养护");
  });

  it("大纲级别写在被继承的上级样式里也认；段落自身的大纲级别先于样式", () => {
    const t = INHERITED as LocationFile;
    expect(headingsOf(t)).toEqual({ 1: 1, 3: 2, 5: 2, 7: 3 });
    expect(chapterOf(t, 6)).toBe("1.2 夏季");
    expect(chapterOf(t, 9)).toBe("1.2.1 防暑");
  });

  it("大纲级别写成 9 的段落不是标题，它下面的段落仍归前一个标题", () => {
    const t = BODY_LEVEL as LocationFile;
    expect(headingsOf(t)).toEqual({ 1: 1, 7: 1 });
    for (const n of [3, 4, 5, 6]) expect(chapterOf(t, n)).toBe("1 总则");
    expect(chapterOf(t, 8)).toBe("2 附则");
  });
});
