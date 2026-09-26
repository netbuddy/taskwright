// 材料区 Word 材料的「按章节看引用」：每一节被几个条目引用的算法、收起与展开、没有引用的一节灰显、点一节跳到那一节的第一段；
// 分段清单读不到时整栏不显示。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Item } from "../api/types";
import { api } from "../api/client";
import { SectionList } from "../components/work/SectionList";
import { parseSegments, sectionRows, type SegmentList } from "../model/segments";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PATH = "inputs/x.docx";
const LIST: SegmentList = {
  version: 1,
  blocks: [
    { index: 1, heading: null, first_paragraph: 1, last_paragraph: 5, paragraphs: 5 },
    { index: 2, heading: "1 概述", first_paragraph: 6, last_paragraph: 9, paragraphs: 4 },
    { index: 3, heading: "1.1 范围；1.2 术语", first_paragraph: 10, last_paragraph: 14, paragraphs: 5 },
  ],
};
const item = (id: string, sources: { kind?: string; locator: string }[]) =>
  ({ item_id: id, sources: sources.map((s) => ({ kind: s.kind ?? "文档原文", locator: s.locator, excerpt: "摘录" })) }) as unknown as Item;
const ITEMS = [
  // UC-001 两条来源都在第 2 节，只算一个条目；UC-002 在第 2、3 节各算一个；别的文件、别的种类、不带段落号的不算。
  item("UC-001", [{ locator: `${PATH}#p6` }, { locator: `${PATH}#p9` }]),
  item("UC-002", [{ locator: `${PATH}#p7` }, { locator: `${PATH}#p12` }]),
  item("UC-003", [{ locator: "inputs/别的.docx#p3" }, { kind: "用户的话", locator: `${PATH}#p2` }, { locator: PATH }]),
];

describe("每一节被几个条目引用", () => {
  it("按条目的「文档原文」来源的段落号落到节里，一个条目在一节里只算一个", () => {
    expect(sectionRows(LIST, ITEMS, PATH).map((r) => [r.index, r.first, r.last, r.items])).toEqual([[1, 1, 5, 0], [2, 6, 9, 2], [3, 10, 14, 1]]);
  });
  it("不是分段清单的文字当作没有清单", () => {
    expect(parseSegments("[p1] 不是 JSON")).toBeNull();
    expect(parseSegments('{"blocks": "x"}')).toBeNull();
    expect(parseSegments(JSON.stringify(LIST))?.blocks).toHaveLength(3);
  });
});

describe("按章节看引用", () => {
  it("默认收起只写一行小结；展开后逐节列出，没有条目引用的一节灰显；点一节跳到那一节的第一段", async () => {
    const content = vi.spyOn(api, "materialContent").mockResolvedValue({ path: `${PATH}.segments.json`, text: JSON.stringify(LIST) });
    const onJump = vi.fn();
    render(<div className="app"><SectionList taskId="TASK-001" path={PATH} items={ITEMS} onJump={onJump} /></div>);
    const toggle = await screen.findByTestId("sections-toggle");
    expect(content).toHaveBeenCalledWith("TASK-001", "inputs/x.docx.segments.json");
    expect(toggle.textContent).toBe("▸按章节看引用：3 节里 2 节有条目引用，1 节还没有");
    expect(screen.queryAllByTestId("section-row")).toHaveLength(0);
    fireEvent.click(toggle);
    const rows = screen.getAllByTestId("section-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "开头（第一个标题之前）还没有条目引用这一段第 1–5 段",
      "1 概述被 2 个条目引用第 6–9 段",
      "1.1 范围；1.2 术语被 1 个条目引用第 10–14 段",
    ]);
    expect(rows.map((r) => r.classList.contains("none"))).toEqual([true, false, false]);
    fireEvent.click(rows[2]);
    expect(onJump).toHaveBeenCalledWith(10);
    expect(document.body.textContent).not.toMatch(/投影|覆盖|派生/);
  });
  it("分段清单读不到或不是清单时整栏不显示", async () => {
    const content = vi.spyOn(api, "materialContent").mockRejectedValue(new Error("没有这份材料"));
    const { container } = render(<SectionList taskId="TASK-001" path={PATH} items={ITEMS} onJump={() => {}} />);
    await waitFor(() => expect(content).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
