// 知识库页面「试一试」里一个命中的位置怎样写：Word 文档写段，PDF 文档写页与块，别的写行。
import { describe, expect, it } from "vitest";
import { searchPlaceText } from "../model/knowledge";

const none = { first_paragraph: null, last_paragraph: null, first_line: null, last_line: null };

describe("按意思查到的片段在文档的哪里", () => {
  it("PDF 文档写第几页第几块，几块时写起止；片段不跨页", () => {
    expect(searchPlaceText({ ...none, first_unit: { page: 3, block: 2 }, last_unit: { page: 3, block: 2 } })).toBe("第 3 页第 2 块");
    expect(searchPlaceText({ ...none, first_unit: { page: 3, block: 2 }, last_unit: { page: 3, block: 4 } })).toBe("第 3 页第 2 到 4 块");
  });
  it("Word 文档与别的文档照旧；更早的任务服务不给页与块时不出错", () => {
    expect(searchPlaceText({ ...none, first_paragraph: 75, last_paragraph: 78, first_unit: null, last_unit: null })).toBe("第 75 到 78 段");
    expect(searchPlaceText({ ...none, first_line: 7, last_line: 7 })).toBe("第 7 行");
    expect(searchPlaceText(none)).toBe("");
  });
});
