// 材料区 Word 与 PDF 输入资料的「分段去向」：每一节被哪些条目引用的算法（Word 按段落号、PDF 按页）、收起与展开、栏头的汇总、
// 没有引用的一节标「未提取」并灰显、点编号打开条目、点一节跳到那一节的开头；分段清单读不到时整栏不显示。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Item } from "../api/types";
import { api } from "../api/client";
import { SectionList } from "../components/work/SectionList";
import { parseSegments, sectionRows, type SegmentList } from "../model/segments";
import { settled } from "./settled";

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
  // UC-010 两条来源都在第 2 节，只列一次；OA-001 是业务说明页，与条目混排、按编号排序；UC-002 在第 2、3 节各列一次；
  // 别的文件、别的种类、不带段落号的不算。
  item("UC-010", [{ locator: `${PATH}#p6` }, { locator: `${PATH}#p9` }]),
  item("UC-002", [{ locator: `${PATH}#p7` }, { locator: `${PATH}#p12` }]),
  item("OA-001", [{ locator: `${PATH}#p8` }]),
  item("UC-003", [{ locator: "inputs/别的.docx#p3" }, { kind: "用户的话", locator: `${PATH}#p2` }, { locator: PATH }]),
];

const PDF = "inputs/y.pdf";
const PDF_LIST = {
  version: 1,
  blocks: [
    { index: 1, heading: "第一章 总则", first_page: 1, last_page: 2, units: 6 },
    { index: 2, heading: "第二章 借阅", first_page: 3, last_page: 3, units: 4 },
    { index: 3, heading: "第三章 罚则", first_page: 4, last_page: 6, units: 9 },
  ],
} as SegmentList;
const PDF_ITEMS = [
  // 按出处 [p页-块] 的页落到节里：UC-001 在第 1 节与第 3 节；FR-002 在第 1 节；第 2 节没有；Word 的写法、不带页的不算。
  item("UC-001", [{ locator: `${PDF}#p2-3` }, { locator: `${PDF}#p5-1` }]),
  item("FR-002", [{ locator: `${PDF}#p1-1` }, { locator: `${PDF}` }, { locator: `${PATH}#p3` }]),
];

describe("每一节的去向", () => {
  it("Word：按条目的「文档原文」来源的段落号落到节里，编号去重并按编号排序，页与条目混排", () => {
    expect(sectionRows(LIST, ITEMS, PATH).map((r) => [r.index, r.first, r.last, r.unit, r.cited])).toEqual([
      [1, 1, 5, "段", []], [2, 6, 9, "段", ["OA-001", "UC-002", "UC-010"]], [3, 10, 14, "段", ["UC-002"]],
    ]);
  });
  it("PDF：按出处里的页落到节里，行写页范围", () => {
    expect(sectionRows(PDF_LIST, PDF_ITEMS, PDF).map((r) => [r.index, r.first, r.last, r.unit, r.cited])).toEqual([
      [1, 1, 2, "页", ["FR-002", "UC-001"]], [2, 3, 3, "页", []], [3, 4, 6, "页", ["UC-001"]],
    ]);
  });
  it("不是分段清单的文字当作没有清单", () => {
    expect(parseSegments("[p1] 不是 JSON")).toBeNull();
    expect(parseSegments('{"blocks": "x"}')).toBeNull();
    expect(parseSegments(JSON.stringify(LIST))?.blocks).toHaveLength(3);
    expect(parseSegments(JSON.stringify(PDF_LIST))?.blocks).toHaveLength(3);
  });
});

describe("分段去向", () => {
  it("默认收起只写一行汇总；展开后逐节列出编号，没有引用的一节标「未提取」并灰显；点编号打开条目，点一节跳到那一节的第一段", async () => {
    const content = vi.spyOn(api, "materialContent").mockResolvedValue({ path: `${PATH}.segments.json`, text: JSON.stringify(LIST) });
    const onJump = vi.fn();
    const onOpenItem = vi.fn();
    render(<div className="app"><SectionList taskId="TASK-001" path={PATH} items={ITEMS} onJump={onJump} onOpenItem={onOpenItem} /></div>);
    const toggle = await screen.findByTestId("sections-toggle");
    expect(content).toHaveBeenCalledWith("TASK-001", "inputs/x.docx.segments.json");
    expect(toggle.textContent).toBe("▸分段去向：3 节，1 节未提取");
    expect(screen.queryAllByTestId("section-row")).toHaveLength(0);
    fireEvent.click(toggle);
    const rows = screen.getAllByTestId("section-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "开头（第一个标题之前）未提取第 1–5 段",
      "1 概述第 6–9 段OA-001、UC-002、UC-010",
      "1.1 范围；1.2 术语第 10–14 段UC-002",
    ]);
    expect(rows.map((r) => r.classList.contains("none"))).toEqual([true, false, false]);
    fireEvent.click(screen.getAllByTestId("section-item")[0]);
    expect(onOpenItem).toHaveBeenCalledWith("OA-001");
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.click(rows[2]);
    expect(onJump).toHaveBeenCalledWith(10);
    expect(document.body.textContent).not.toMatch(/投影|覆盖|派生/);
  });
  it("PDF：读 x.pdf.segments.json，行写页范围；每一节都有引用时栏头写「都有去向」，点一节跳到那一节的第一页", async () => {
    const content = vi.spyOn(api, "materialContent").mockResolvedValue({ path: `${PDF}.segments.json`, text: JSON.stringify(PDF_LIST) });
    const onJump = vi.fn();
    const items = [...PDF_ITEMS, item("UC-004", [{ locator: `${PDF}#p3-2` }])];
    render(<div className="app"><SectionList taskId="TASK-001" path={PDF} items={items} onJump={onJump} /></div>);
    const toggle = await screen.findByTestId("sections-toggle");
    expect(content).toHaveBeenCalledWith("TASK-001", "inputs/y.pdf.segments.json");
    expect(toggle.textContent).toBe("▸分段去向：3 节，都有去向");
    fireEvent.click(toggle);
    expect(screen.getAllByTestId("section-row").map((r) => r.textContent)).toEqual([
      "第一章 总则第 1–2 页FR-002、UC-001",
      "第二章 借阅第 3 页UC-004",
      "第三章 罚则第 4–6 页UC-001",
    ]);
    fireEvent.click(screen.getAllByTestId("section-row")[2]);
    expect(onJump).toHaveBeenCalledWith(4);
  });
  it("分段清单读不到或不是清单时整栏不显示", async () => {
    const content = vi.spyOn(api, "materialContent").mockRejectedValue(new Error("没有这份输入资料"));
    const { container } = render(<SectionList taskId="TASK-001" path={PATH} items={ITEMS} onJump={() => {}} />);
    // 读的过程中这一栏本来就是空的；只等「被调用」，断言在读失败之前就成立。等这次失败处理完再看。
    await settled(content);
    expect(container.textContent).toBe("");
  });
});
