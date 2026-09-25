// Word 材料在材料区按页显示：渲染与段落号回填、分页修补、派生表（页 · 章节 · 位置）、四种定位结果、宽表格横向滚动、来源标签。
// 夹具是 examples/library-lending/requirements-styled.docx；段落的标准答案由 scripts/docx_paragraphs.mjs 按同一条计数规则抽出来，
// 后端的文本投影与它逐行一致（server 的测试核对）。页、章节、位置的期望值是局部原型 v2 走查时核对过的。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import JSZip from "jszip";
import { api } from "../api/client";
import type { Item } from "../api/types";
import { MaterialPane } from "../components/work/MaterialPane";
import { SourceTag } from "../components/work/ItemDetail";
import { polish, renderDocx, tableOf, whereOf, type RenderedDocx } from "../model/docx";
import { resetDocxStore, TaskIdContext } from "../state/docxStore";
// 仓库脚本 docx_paragraphs.mjs 的抽取函数作标准答案（它的类型声明在同目录的 .d.mts）
import { paragraphsOf, tableLabel, type Paragraph } from "../../../scripts/docx_paragraphs.mjs";
import SAMPLE_DATA_URL from "../../../examples/library-lending/requirements-styled.docx?inline";

const SAMPLE = Uint8Array.from(atob(SAMPLE_DATA_URL.slice(SAMPLE_DATA_URL.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const PATH = "inputs/requirements-styled.docx";
const expectedOf = async (bytes: Uint8Array): Promise<Paragraph[]> =>
  paragraphsOf(await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string"));
let expectedSample: Paragraph[] = [];
beforeAll(async () => { expectedSample = await expectedOf(SAMPLE); });
const squeeze = (s: string) => s.replace(/\s+/g, "");
const projection = () =>
  expectedSample.map((p) => `[第 ${p.n} 段${p.table ? " · " + tableLabel(p.table) : ""}] ${p.text.replace(/[\r\n]/g, " ")}`).join("\n");

async function rendered(bytes: Uint8Array = SAMPLE): Promise<RenderedDocx> {
  const host = document.createElement("div");
  document.body.append(host);
  return renderDocx(bytes, host);
}

/** 在第 n 段的第 k 个文字块前插一个分页标记（Word 在一段中间换页时就是这样写的）。 */
async function withMarkInside(n: number, k: number): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(SAMPLE);
  const xml = await zip.file("word/document.xml")!.async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const counted = [...doc.getElementsByTagNameNS(W, "p")].filter((p) => {
    for (let a = p.parentNode; a; a = a.parentNode) if ((a as Element).localName === "txbxContent") return false;
    return true;
  });
  const runs = [...counted[n - 1].getElementsByTagNameNS(W, "r")].filter((r) => r.getElementsByTagNameNS(W, "t").length);
  const mark = doc.createElementNS(W, "w:r");
  mark.appendChild(doc.createElementNS(W, "w:lastRenderedPageBreak"));
  runs[k].parentNode!.insertBefore(mark, runs[k]);
  zip.file("word/document.xml", new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: "uint8array" });
}

afterEach(() => { cleanup(); document.body.innerHTML = ""; resetDocxStore(); vi.restoreAllMocks(); });

// jsdom 里渲染一份 Word 要几秒（派生表在页面外渲染一次，材料区显示再渲染一次），等待的时限放宽。
const SLOW = { timeout: 20_000 };
vi.setConfig({ testTimeout: 40_000 });

describe("渲染与分页修补", () => {
  it("样本 114 段的段落号与文字和抽取脚本逐段一致；分成 5 页，没有空页", async () => {
    const r = await rendered();
    const t = tableOf(r);
    const want = expectedSample;
    expect(r.paras.length - 1).toBe(114);
    for (const p of want) expect([p.n, t.texts[p.n]]).toEqual([p.n, squeeze(p.text)]);
    expect(t.pages).toBe(5);
    expect(r.marks).toBe(4);
    // 标记在段首时 docx-preview 留下的空前一半已去掉：每段只剩一个元素
    expect(r.paras.filter((els) => els && els.length > 1)).toEqual([]);
  });

  it("后面的节沿用前一节的页眉页脚，页码域是真页码，注释只列一次、引用号是 1", async () => {
    const r = await rendered();
    const pages = [...r.root.querySelectorAll("section.docx")];
    expect(pages.map((s) => s.querySelector("header")?.textContent)).toEqual(Array(5).fill("学校图书馆借还书系统需求说明（示例材料）"));
    expect(pages.map((s) => s.querySelector("footer")?.textContent)).toEqual([1, 2, 3, 4, 5].map((i) => `第 ${i} 页，共 5 页`));
    expect([...r.root.querySelectorAll(".tw-noteref")].map((e) => e.textContent)).toEqual(["1", "1"]);
    expect(r.root.querySelectorAll("section.docx > ol > li").length).toBe(2);
  });

  it("第 8 段中间插一个分页标记：这一段被拆到第 2、3 页，两半都认作第 8 段，其余段落号不错开", async () => {
    const bytes = await withMarkInside(8, 2);
    const r = await rendered(bytes);
    const t = tableOf(r);
    expect(r.paras[8].length).toBe(2);
    expect(t.parts[8].map((p) => p.page)).toEqual([2, 3]);
    const want = await expectedOf(bytes);
    for (const p of want) expect(t.texts[p.n]).toBe(squeeze(p.text));
    expect(t.pages).toBe(6);
    // 摘录落在后一半时，页写后一半所在的那一页
    const tail = squeeze(want[7].text).slice(-8);
    expect(whereOf(t, 8, tail)[0]).toBe("第 3 页");
    expect(whereOf(t, 8, squeeze(want[7].text).slice(0, 6))[0]).toBe("第 2 页");
  });

  it("文件里没有分页标记时不写「第几页」", async () => {
    const zip = await JSZip.loadAsync(SAMPLE);
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", xml.replaceAll("<w:lastRenderedPageBreak/>", ""));
    const t = tableOf(await rendered(await zip.generateAsync({ type: "uint8array" })));
    expect(t.marks).toBe(0);
    expect(whereOf(t, 76, "逾期的每本每天罚款一角")).toEqual(["3.1.1 逾期罚款", expect.stringMatching(/^页[上中下]$/)]);
  });

  it("顶层表格都套在可横向滚动的框里（比材料区宽的表格出滚动条，不缩放）", async () => {
    const r = await rendered();
    polish(r.root);
    expect(r.root.querySelectorAll(".tw-tablewrap > table").length).toBe(3);
    expect(r.root.querySelectorAll("section.docx > article > table").length).toBe(0);
  });
});

describe("派生表：页 · 章节 · 位置", () => {
  it("四个来源与原型 v2 走查时核对过的值一致", async () => {
    const t = tableOf(await rendered());
    expect(whereOf(t, 76, "逾期的每本每天罚款一角，罚款最多不超过这本书的定价。")).toEqual(["第 3 页", "3.1.1 逾期罚款", "页下"]);
    expect(whereOf(t, 37, "名下有逾期未还图书的，不能再借")).toEqual(["第 3 页", "2.3 借阅上限", "页上"]);
    expect(whereOf(t, 111, "寒暑假期间的借期另行规定。罚款的缴纳方式待定。")).toEqual(["第 5 页", "5 待定事项", "页下"]);
    expect(whereOf(t, 91, "系统要能每分钟处理至少 100 笔借还")).toEqual(["第 5 页", "4 非功能需求", "页上"]);
    // 封面上的段落之前没有标题：不写章节
    expect(whereOf(t, 2)).toEqual(["第 1 页", expect.stringMatching(/^页[上中下]$/)]);
  });
});

describe("材料区的四种定位结果", () => {
  const materials = [{ path: PATH, bytes: 1, modified_at: "" }, { path: `${PATH}.txt`, bytes: 1, modified_at: "" }];
  const item = (id: string, locator: string, excerpt: string): Item => ({
    item_id: id, collection: "用例", title: id, revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
    fields: {}, sources: [{ kind: "文档原文", locator, excerpt }], reviews: [], confirmations: [], confirmation_stale: false,
  } as unknown as Item);
  const items = [
    item("UC-001", `${PATH}#p76`, "逾期的每本每天罚款一角，罚款最多不超过这本书的定价。"),
    item("NFR-001", `${PATH}#p91`, "系统要能每分钟处理至少 100 笔借还"),
  ];
  const mockApi = () => {
    vi.spyOn(api, "materialRaw").mockResolvedValue(SAMPLE.slice().buffer);
    vi.spyOn(api, "materialContent").mockResolvedValue({ path: PATH, text: projection() });
  };
  const pane = (locate: { excerpt: string; locator: string; nonce: number } | null) =>
    <MaterialPane taskId="TASK-D" materials={materials} items={items} locate={locate} />;

  it("投影不单独列出；被引用的句子画底线，顶部写被几个条目引用；段内找到时高亮那几个字", async () => {
    mockApi();
    const { rerender } = render(pane(null));
    await waitFor(() => expect(document.querySelectorAll(".cited").length).toBe(2), SLOW);
    expect(screen.queryByTestId("material-select")).toBeNull();
    expect(screen.getByText("被 2 个条目引用过")).toBeInTheDocument();
    expect(screen.getByText(/Word 文件按原版式分页显示/)).toBeInTheDocument();
    rerender(pane({ excerpt: "逾期的每本每天罚款一角，罚款最多不超过这本书的定价。", locator: `${PATH}#p76`, nonce: 1 }));
    await waitFor(() => expect(squeeze(document.querySelector("mark.hit")?.textContent ?? "")).toBe("逾期的每本每天罚款一角，罚款最多不超过这本书的定价。"), SLOW);
    expect(screen.queryByTestId("locate-note")).toBeNull();
  });

  it("跨段：这几段整段标出，提示「这段引用跨越了多个段落，已整段标出。」", async () => {
    mockApi();
    render(pane({ excerpt: "寒暑假期间的借期另行规定。罚款的缴纳方式待定。", locator: `${PATH}#p111`, nonce: 1 }));
    await waitFor(() => expect(document.querySelectorAll("p.hitpara").length).toBe(2), SLOW);
    expect(screen.getByTestId("locate-note")).toHaveTextContent("这段引用跨越了多个段落，已整段标出。");
  });

  it("找不到：提示用页 · 章节 · 位置写，不写段落号", async () => {
    mockApi();
    render(pane({ excerpt: "名下有逾期未还图书的，不能再借", locator: `${PATH}#p37`, nonce: 1 }));
    expect(await screen.findByTestId("locate-note", {}, SLOW)).toHaveTextContent("没有在第 3 页 · 2.3 借阅上限 · 页上附近找到这段原文。");
    expect(document.querySelector("mark.hit")).toBeNull();
    expect(document.body.textContent).not.toMatch(/第 \d+ 段/);
  });

  it("表格单元格：照样段内高亮", async () => {
    mockApi();
    render(pane({ excerpt: "系统要能每分钟处理至少 100 笔借还", locator: `${PATH}#p91`, nonce: 1 }));
    await waitFor(() => expect(document.querySelector("mark.hit")?.closest("td")).toBeTruthy(), SLOW);
    expect(squeeze(document.querySelector("mark.hit")!.textContent!)).toBe("系统要能每分钟处理至少100笔借还");
  });
});

describe("条目区的来源标签", () => {
  it("写成「文件名 · 第几页 · 章节 · 页上中下」；悬停提示带表格位置；没算出来之前只写文件名", async () => {
    vi.spyOn(api, "materialRaw").mockResolvedValue(SAMPLE.slice().buffer);
    vi.spyOn(api, "materialContent").mockResolvedValue({ path: PATH, text: projection() });
    render(
      <TaskIdContext.Provider value="TASK-D">
        <SourceTag source={{ kind: "文档原文", locator: `${PATH}#p91`, excerpt: "系统要能每分钟处理至少 100 笔借还" }} />
      </TaskIdContext.Provider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("❝ requirements-styled.docx");
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("❝ requirements-styled.docx · 第 5 页 · 4 非功能需求 · 页上"), SLOW);
    expect(screen.getByRole("button").title).toBe("材料原文：「系统要能每分钟处理至少 100 笔借还」（表 3 第 2 行第 2 列）。点一下，材料区滚到这里。");
    expect(screen.getByRole("button").textContent).not.toMatch(/段/);
  });
});
