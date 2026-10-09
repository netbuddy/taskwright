// 出自知识库文档的来源：标签、出处的写法、文档不在知识库里时的样子，以及点出处打开的只读对话框。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Item, KnowledgeLibrary, Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { KnowledgeDocModal } from "../components/work/KnowledgeDocModal";
import { KnowledgeContext } from "../state/knowledge";
import { excerptSpan, knowledgePlace } from "../model/knowledge";
import { ApiError, api } from "../api/client";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
Element.prototype.scrollTo ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);

const src = (locator: string, excerpt: string) => ({ kind: "文档原文", locator, excerpt, supports: [] });
const TERM = src("knowledge/general/术语.md", "原路退回：把钱退到买家付款时用的那个账户。");
const WORD = src("knowledge/lib-a1/规范.docx#p12", "退款在 3 个工作日内到账。");

const doc = (name: string) => ({ name, kind: "glossary" as const, bytes: 10, uploaded_at: "" });
const LIBRARIES: KnowledgeLibrary[] = [
  { id: "general", name: "通用知识库", created_at: "", used_by_tasks: 1, documents: [doc("术语.md")] },
  { id: "lib-a1", name: "行业规范", created_at: "", used_by_tasks: 1, documents: [doc("规范.docx")] },
];

function task(sources: unknown[]): Task {
  const item = {
    item_id: "UC-001", collection: "功能用例", title: "退款", revision_no: 1, revisions: [1], revision_by: "executor", revision_at: "",
    reviews: [], confirmations: [], confirmation_stale: false, sources, fields: { 用例名称: "退款" },
  } as unknown as Item;
  return {
    task_id: "TASK-K", task_name: "来源", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [{ name: "功能用例", prefix: "UC", needs_review: false, fields: [{ name: "用例名称", type: "文本", required: true, values: null }] }] },
    completion: null, items: [item],
  } as unknown as Task;
}

/** 打开 UC-001 的条目详情；libraries 是知识库清单（null 表示还没有取到）。 */
function OpenItem({ sources, libraries, onLocate }: { sources: unknown[]; libraries: KnowledgeLibrary[] | null; onLocate?: (excerpt: string, locator: string) => void }) {
  const [selected, setSelected] = useState<string | null>("UC-001");
  return (
    <Wrap><div className="app">
      <KnowledgeContext.Provider value={libraries}>
        <ItemsPanel task={task(sources)} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={selected} onSelect={setSelected}
          submit={vi.fn(async () => null)} onGenerateDoc={() => {}} onLocate={onLocate} />
      </KnowledgeContext.Provider>
    </div></Wrap>
  );
}

const boxes = () => [...screen.getByTestId("item-detail").querySelectorAll<HTMLElement>(".srcbox")];

describe("条目详情里出自知识库文档的来源", () => {
  it("标签写「知识库」并用紫红样式，出处写「知识库名 / 文档名」，Word 文档再写第几段；材料来源照旧是蓝色的「材料原文」、出处可点", () => {
    render(<OpenItem sources={[TERM, WORD, src("inputs/说明.md", "买家可以退货。")]} libraries={LIBRARIES} />);
    const [term, word, material] = boxes();
    expect(term.querySelector(".chip")!.className).toBe("chip src kb");
    expect(term.querySelector(".chip")!.textContent).toBe("知识库");
    expect(within(term).getByTestId("kb-source").textContent).toBe("出处：通用知识库 / 术语.md（点一下看原文）");
    expect(within(word).getByTestId("kb-source").textContent).toBe("出处：行业规范 / 规范.docx · 第 12 段（点一下看原文）");
    expect(term.textContent).not.toMatch(/knowledge\//);
    // 材料来源照旧：蓝色的「材料原文」，出处可点。
    expect(material.querySelector(".chip")!.className).toBe("chip src");
    expect(material.querySelector(".chip")!.textContent).toBe("材料原文");
    expect(within(material).getByText("出处：说明.md（点一下看原文）").getAttribute("role")).toBe("button");
  });

  it("点出处时把摘录与出处交出去（由工作视图打开那份文档）", () => {
    const onLocate = vi.fn();
    render(<OpenItem sources={[WORD]} libraries={LIBRARIES} onLocate={onLocate} />);
    fireEvent.click(screen.getByTestId("kb-source"));
    expect(onLocate).toHaveBeenCalledWith("退款在 3 个工作日内到账。", "knowledge/lib-a1/规范.docx#p12");
  });

  it("文档已经不在那个知识库的清单里：出处不可点，旁边灰字「这份文档已经不在知识库里」；知识库本身不在了时出处写它的编号", () => {
    const onLocate = vi.fn();
    render(<OpenItem sources={[src("knowledge/general/旧术语.md", "旧的说法。"), src("knowledge/lib-gone/规范.md", "旧的规范。")]} libraries={LIBRARIES} onLocate={onLocate} />);
    const [removed, noLibrary] = boxes();
    expect(removed.querySelector(".chip")!.className).toBe("chip src kb");
    expect(removed.querySelector(".evi.off")!.textContent).toBe("出处：通用知识库 / 旧术语.md");
    expect(within(removed).getByTestId("kb-doc-gone").textContent).toBe("这份文档已经不在知识库里");
    expect(noLibrary.querySelector(".evi.off")!.textContent).toBe("出处：lib-gone / 规范.md");
    expect(within(noLibrary).getByTestId("kb-doc-gone")).toBeTruthy();
    expect(screen.queryByTestId("kb-source")).toBeNull();
    fireEvent.click(removed.querySelector(".evi.off")!);
    expect(onLocate).not.toHaveBeenCalled();
    expect(removed.textContent).toContain("「旧的说法。」");   // 来源本身照旧列出
  });

  it("服务没有知识库（清单是空的）时一律写「这份文档已经不在知识库里」；清单还没有取到时不判断，出处写编号", () => {
    const { unmount } = render(<OpenItem sources={[TERM]} libraries={[]} />);
    expect(screen.getByTestId("kb-doc-gone")).toBeTruthy();
    unmount();
    render(<OpenItem sources={[TERM]} libraries={null} />);
    expect(screen.queryByTestId("kb-doc-gone")).toBeNull();
    expect(screen.getByTestId("kb-source").textContent).toBe("出处：general / 术语.md（点一下看原文）");
  });
});

describe("出处的写法与摘录在正文里的位置", () => {
  it("knowledgePlace：编号换成名字；写法不对的出处原样写出并算作不在", () => {
    expect(knowledgePlace("knowledge/lib-a1/规范.docx#p12", LIBRARIES)).toEqual(
      { library: "lib-a1", name: "规范.docx", paragraph: 12, title: "行业规范 / 规范.docx", label: "行业规范 / 规范.docx · 第 12 段", gone: false });
    // PDF 文档的出处带页与块：标签写到页。
    expect(knowledgePlace("knowledge/lib-a1/办法.pdf#p3-12", LIBRARIES).label).toBe("行业规范 / 办法.pdf · 第 3 页");
    expect(knowledgePlace("knowledge/lib-a1/办法.pdf", LIBRARIES).label).toBe("行业规范 / 办法.pdf");
    expect(knowledgePlace("knowledge/general/术语.md", LIBRARIES).gone).toBe(false);
    expect(knowledgePlace("knowledge/general/没有.md", LIBRARIES).gone).toBe(true);
    expect(knowledgePlace("knowledge/坏的写法", LIBRARIES)).toEqual({ library: "", name: "knowledge/坏的写法", paragraph: null, title: "knowledge/坏的写法", label: "knowledge/坏的写法", gone: true });
  });

  it("excerptSpan：文本文档取摘录第一次出现的位置；Word 文档先在段落号那一行里找，行里找不到取整行；都找不到为 null", () => {
    const text = "[p1] 退款在 3 个工作日内到账。\n[p2] 逾期不退。退款在 3 个工作日内到账。\n";
    expect(excerptSpan("甲乙丙丁", "丙", null)).toEqual([2, 3]);
    expect(excerptSpan("甲乙丙丁", "戊", null)).toBeNull();
    const second = text.indexOf("[p2]");
    expect(excerptSpan(text, "退款在 3 个工作日内到账。", 2)).toEqual([text.indexOf("退款", second), text.length - 1]);
    expect(excerptSpan(text, "这句不在这一段", 2)).toEqual([second, text.length - 1]);
    expect(excerptSpan(text, "逾期不退。", 9)).toEqual([text.indexOf("逾期不退。"), text.indexOf("逾期不退。") + 5]);
  });
});

describe("点知识库来源的出处打开的只读对话框", () => {
  const open = (locator: string, excerpt: string) =>
    render(<Wrap><KnowledgeDocModal request={{ locator, excerpt }} libraries={LIBRARIES} onClose={() => {}} /></Wrap>);

  it("标题是「知识库名 / 文档名」，正文取那份文档的文字，摘录高亮", async () => {
    const documentText = vi.spyOn(api, "documentText").mockResolvedValue({ name: "术语.md", text: "# 退款术语\n\n原路退回：把钱退到买家付款时用的那个账户。\n部分退款：只退一部分。\n" });
    open(TERM.locator, TERM.excerpt);
    expect(await screen.findByText("通用知识库 / 术语.md")).toBeTruthy();
    expect(documentText).toHaveBeenCalledWith("general", "术语.md");
    const body = await screen.findByTestId("kb-doc");
    await screen.findByText("原路退回：把钱退到买家付款时用的那个账户。", { selector: "mark.hit" });
    expect(body.querySelector(".kbdoc-text")!.textContent).toContain("部分退款：只退一部分。");
    expect(screen.queryByTestId("kb-doc-miss")).toBeNull();
  });

  it("Word 文档按段落号找到那一段再高亮摘录；正文里没有这段原文时写一句说明并照样显示全文", async () => {
    vi.spyOn(api, "documentText").mockResolvedValue({ name: "规范.docx", text: "[p11] 退款须审核。\n[p12] 审核通过后，退款在 3 个工作日内到账。\n" });
    const { unmount } = open(WORD.locator, WORD.excerpt);
    expect(await screen.findByText("行业规范 / 规范.docx")).toBeTruthy();
    expect((await screen.findByText("退款在 3 个工作日内到账。", { selector: "mark.hit" })).textContent).toBe("退款在 3 个工作日内到账。");
    unmount();
    open("knowledge/general/术语.md", "正文里没有的一句话。");
    expect((await screen.findByTestId("kb-doc-miss")).textContent).toBe("没有在这份文档里找到这段原文，下面是文档的全文。");
    expect(screen.getByTestId("kb-doc").querySelector(".kbdoc-text")!.textContent).toContain("[p11] 退款须审核。");
  });

  it("出处拆不出知识库编号与文档名时写「这份文档的正文没有读到。」，不去读、也不停在「正在读这份文档。」", async () => {
    const documentText = vi.spyOn(api, "documentText");
    open("knowledge/坏的写法", "一句话");
    expect((await screen.findByTestId("kb-doc-error")).textContent).toBe("这份文档的正文没有读到。");
    expect(screen.getByTestId("kb-doc").textContent).not.toContain("正在读这份文档。");
    expect(documentText).not.toHaveBeenCalled();
  });

  it("文档读不到时显示后端给的那句话", async () => {
    vi.spyOn(api, "documentText").mockRejectedValue(new ApiError("not_found", "这个知识库里没有《术语.md》。", 404));
    open(TERM.locator, TERM.excerpt);
    expect((await screen.findByTestId("kb-doc-error")).textContent).toBe("这个知识库里没有《术语.md》。");
  });
});
