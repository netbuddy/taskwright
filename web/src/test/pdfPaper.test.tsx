// 材料区里的 PDF 材料（components/work/PdfPaper.tsx）：只画看得见的页、点来源滚到那一页并框出那一块、摘录逐字标出、
// 被引用的句子画底线、没有文字的页的提示、放大缩小、显示不出来时的说明。
// pdf.js 换成假的（jsdom 里没有画布，也起不了工作线程）：每页给几个带坐标的文字条目，文字层就是每个条目一个元素。
// 真的显示在浏览器里另行实测。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { api, ApiError } from "../api/client";
import type { Item } from "../api/types";
import type { LocateRequest } from "../components/work/MaterialPane";
import { NO_TEXT_PAGE, PDF_FALLBACK_NOTE, PDF_NOTES, PdfPaper, pdfCitations, pdfHit } from "../components/work/PdfPaper";
import * as pdf from "../model/pdf";
import { PAGE_GAP } from "../model/pdfView";
import { resetPdfStore } from "../state/pdfStore";

const PATH = "inputs/借阅管理办法.pdf";
const W = 595;
const H = 842;
/** 每页的文字条目：文字与它在 PDF 坐标里的起点。第 3 页文字层里的字与投影差一个字（日 / 天），第 4 页是扫描件。 */
const TEXT: Record<number, [string, number, number][]> = {
  1: [["借阅管理办法", 72, 750], ["读者凭借书证借书，", 72, 716], ["每本书可以续借一次。", 72, 700]],
  2: [["学生一次最多借 5 本，", 72, 756], ["借期都是 30 天。", 72, 716]],
  3: [["逾期的每本每日罚款一角。", 72, 750]],
  4: [],
  5: [["预约的图书保留 3 天。", 72, 750]],
};
const TABLE = {
  version: 1, rules_version: 1, 说明: "", source: PATH, engine: "pdfjs-dist 6.4.299", producer: "",
  pages: [
    { page: 1, width: W, height: H, rotate: 0, no_text: false, blocks: [{ block: 1, bbox: [72, 740, 520, 770] }, { block: 2, bbox: [72, 690, 520, 730] }] },
    { page: 2, width: W, height: H, rotate: 0, no_text: false, blocks: [{ block: 1, bbox: [72, 745, 520, 770] }, { block: 2, bbox: [72, 705, 520, 730] }] },
    { page: 3, width: W, height: H, rotate: 0, no_text: false, blocks: [{ block: 1, bbox: [72, 740, 520, 770] }] },
    { page: 4, width: W, height: H, rotate: 0, no_text: true, blocks: [] },
    { page: 5, width: W, height: H, rotate: 0, no_text: false, blocks: [{ block: 1, bbox: [72, 740, 520, 770] }] },
  ],
  headings: [],
};
const PROJECTION = ["<!--", "由 借阅管理办法.pdf 生成。", "-->", "", "[p1-1] 借阅管理办法", "", "[p1-2] 读者凭借书证借书，每本书可以续借一次。", "",
  "[p2-1] 学生一次最多借 5 本，", "", "[p2-2] 借期都是 30 天。", "", "[p3-1] 逾期的每本每天罚款一角。", "", "[p4-0] （这一页没有文字，可能是扫描件）", "", "[p5-1] 预约的图书保留 3 天。", ""].join("\n");

const rendered = vi.fn();
/** 为 true 时画页不会自己画完（模拟画得慢），只有被取消时才结束。 */
let slowRender = false;
/** 为 true 时每一页都画不出来（模拟浏览器太旧，pdf.js 画到一半报错）。 */
let brokenRender = false;
const closed = vi.fn();
class FakeTextLayer {
  textDivs: HTMLElement[] = [];
  textContentItemsStr: string[] = [];
  private source: { items: { str: string }[] };
  private container: HTMLElement;
  constructor(options: { textContentSource: { items: { str: string }[] }; container: HTMLElement }) {
    this.source = options.textContentSource;
    this.container = options.container;
  }
  async render() {
    for (const item of this.source.items) {
      const span = document.createElement("span");
      span.textContent = item.str;
      this.container.append(span);
      this.textDivs.push(span);
      this.textContentItemsStr.push(item.str);
    }
  }
}
const fakeDoc = (pages = 5) => ({
  numPages: pages,
  getPage: async (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: W * scale, height: H * scale, scale, convertToViewportPoint: (x: number, y: number) => [x * scale, (H - y) * scale] }),
    render: (options: { viewport: { scale: number } }) => {
      rendered(n, options.viewport.scale);
      let fail: (reason: Error) => void = () => {};
      const promise = brokenRender ? Promise.reject(new TypeError("getOrInsertComputed is not a function"))
        : slowRender ? new Promise<void>((_ok, no) => { fail = no; }) : Promise.resolve();
      return { promise, cancel: () => fail(new Error("Rendering cancelled")) };
    },
    getTextContent: async () => ({ items: (TEXT[n] ?? []).map(([str, x, y]) => ({ str, transform: [1, 0, 0, 1, x, y] })) }),
  }),
});

const source = (locator: string, excerpt: string) => ({ kind: "文档原文", locator, excerpt, supports: [] });
const item = (id: string, sources: ReturnType<typeof source>[]): Item => ({
  item_id: id, collection: "功能用例", title: id, revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
  fields: {}, sources, reviews: [], waivers: [], confirmations: [], confirmation_stale: false,
} as unknown as Item);
const ITEMS = [
  item("UC-001", [source(`${PATH}#p1-2`, "读者凭借书证借书，每本书可以续借一次。"), source("inputs/别的.pdf#p1-1", "不相干")]),
  item("UC-002", [source(`${PATH}#p1-2`, "读者凭借书证借书，每本书可以续借一次。"), source(`${PATH}#p5-1`, "图书保留 3 天")]),
  item("UC-003", [source(`${PATH}#p5-1`, "这句话材料里没有")]),
];

type Props = Partial<Parameters<typeof PdfPaper>[0]>;
function Host(props: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  return <div className="doc-b" ref={scroller} data-testid="scroller"><PdfPaper taskId="TASK-1" path={PATH} items={[]} locate={null} scrollRef={scroller} {...props} /></div>;
}
const drawnPages = () => [...document.querySelectorAll<HTMLElement>(".pdf-page")].filter((page) => page.querySelector(".pdf-drawn canvas")).map((page) => Number(page.dataset.pdfPage));
const scrollTo = async (top: number) => {
  const pane = screen.getByTestId("scroller");
  pane.scrollTop = top;
  await act(async () => { fireEvent.scroll(pane); });
};
const locateAt = (locator: string, excerpt: string, nonce = 1): LocateRequest => ({ locator, excerpt, nonce });
const opened = async (props: Props = {}) => {
  const view = render(<Host {...props} />);
  await screen.findByTestId("pdf-pages");
  await waitFor(() => expect(drawnPages().length).toBeGreaterThan(0));
  return view;
};

beforeEach(() => {
  // 材料区给页面留 619 像素宽（两边各留 12，正好放下原始大小的一页），看得见 700 像素高。
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(W + 24);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D);
  // jsdom 不排版，元素在屏幕上的位置都是 0。部件靠「各页所在的那一层的上沿」减「滚动容器的上沿」知道滚到了哪里，
  // 所以这里照浏览器的样子给：滚动容器不动，各页那一层的上沿随滚动往上走。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.testid === "pdf-pages" ? -(this.closest<HTMLElement>(".doc-b")?.scrollTop ?? 0) : 0;
    return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(pdf, "loadPdfjs").mockResolvedValue({ TextLayer: FakeTextLayer } as unknown as Awaited<ReturnType<typeof pdf.loadPdfjs>>);
  vi.spyOn(pdf, "openPdf").mockImplementation(async () => ({ doc: fakeDoc() as unknown as pdf.OpenedPdf["doc"], close: closed }));
  vi.spyOn(api, "materialRaw").mockResolvedValue(new ArrayBuffer(8));
  vi.spyOn(api, "materialContent").mockImplementation(async (_task, path) =>
    ({ text: path.endsWith(".locations.json") ? JSON.stringify(TABLE) : PROJECTION }) as Awaited<ReturnType<typeof api.materialContent>>);
  pdfHit.fadeMs = 60;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); rendered.mockClear(); closed.mockClear(); resetPdfStore(); slowRender = false; brokenRender = false; });

describe("只画看得见的页", () => {
  it("每一页都先留同样大小的位置，一打开只画看得见的页与它下面一页；滚过去才画别的，滚走的收掉", async () => {
    const onPage = vi.fn();
    await opened({ onPage });
    const pages = [...document.querySelectorAll<HTMLElement>(".pdf-page")];
    expect(pages.length).toBe(5);
    expect(pages.map((page) => [page.style.top, page.style.width, page.style.height])).toEqual(
      [0, 1, 2, 3, 4].map((i) => [`${i * (H + PAGE_GAP)}px`, `${W}px`, `${H}px`]));
    expect(screen.getByTestId("pdf-pages").style.height).toBe(`${5 * H + 4 * PAGE_GAP}px`);
    await waitFor(() => expect(drawnPages()).toEqual([1, 2]));
    expect(screen.getByTestId("pdf-page-now").textContent).toBe("第 1 / 5 页");
    expect(onPage).toHaveBeenLastCalledWith(1, 5);
    // 画的是画布加文字层，文字层里每个文字条目一个元素。
    const first = screen.getByTestId("pdf-page-1");
    expect([...first.querySelectorAll(".textLayer span")].map((span) => span.textContent)).toEqual(["借阅管理办法", "读者凭借书证借书，", "每本书可以续借一次。"]);
    expect(rendered.mock.calls).toEqual([[1, 1], [2, 1]]);
    // 滚到第 3 页：画第 2、3、4 页，第 1 页收掉。
    await scrollTo(2 * (H + PAGE_GAP));
    await waitFor(() => expect(drawnPages()).toEqual([2, 3, 4]));
    expect(first.querySelector(".pdf-drawn")!.childElementCount).toBe(0);
    expect(screen.getByTestId("pdf-page-now").textContent).toBe("第 3 / 5 页");
    expect(onPage).toHaveBeenLastCalledWith(3, 5);
    // 滚到最后：只留第 4、5 页。
    await scrollTo(4 * (H + PAGE_GAP));
    await waitFor(() => expect(drawnPages()).toEqual([4, 5]));
  });

  it("一页还没画完就滚走了：取消这一次，页里那张没画完的画布也收掉，不算出错", async () => {
    slowRender = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await opened();
    await waitFor(() => expect(drawnPages()).toEqual([1, 2]));
    await scrollTo(4 * (H + PAGE_GAP));
    await waitFor(() => expect(drawnPages()).toEqual([4, 5]));
    expect(screen.getByTestId("pdf-page-1").querySelector(".pdf-drawn")!.childElementCount).toBe(0);
    // 滚回去：重新开始画。
    await scrollTo(0);
    await waitFor(() => expect(drawnPages()).toEqual([1, 2]));
    expect(rendered.mock.calls.map(([n]) => n)).toEqual([1, 2, 4, 5, 1, 2]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("位置表读不到时，各页按第一页实际的大小留位置，照样显示", async () => {
    vi.mocked(api.materialContent).mockImplementation(async (_task, path) => {
      if (path.endsWith(".locations.json")) throw new ApiError("not_found", "没有这个文件。", 404);
      return { text: PROJECTION } as Awaited<ReturnType<typeof api.materialContent>>;
    });
    await opened();
    expect([...document.querySelectorAll<HTMLElement>(".pdf-page")].map((page) => page.style.height)).toEqual(Array(5).fill(`${H}px`));
    expect(document.querySelector("[data-testid^=pdf-notext-]")).toBeNull();
  });

  it("换文件、卸下时把打开的文件关掉", async () => {
    const view = await opened();
    expect(closed).not.toHaveBeenCalled();
    view.unmount();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("放大、缩小与适应宽度", () => {
  it("一打开按材料区的宽度适应；放大缩小之后各页的位置与大小跟着变，看得见的页按新的比例重画；再点适应宽度回去", async () => {
    await opened();
    expect(screen.getByTestId("pdf-zoom-now").textContent).toBe("100%");
    expect(screen.getByTestId("pdf-zoom-fit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("pdf-zoom-in"));
    expect(screen.getByTestId("pdf-zoom-now").textContent).toBe("125%");
    const first = screen.getByTestId("pdf-page-1");
    expect([first.style.width, first.style.height]).toEqual([`${Math.round(W * 1.25)}px`, `${Math.round(H * 1.25)}px`]);
    await waitFor(() => expect(rendered.mock.calls.some(([n, scale]) => n === 1 && scale === 1.25)).toBe(true));
    fireEvent.click(screen.getByTestId("pdf-zoom-out"));
    fireEvent.click(screen.getByTestId("pdf-zoom-out"));
    expect(screen.getByTestId("pdf-zoom-now").textContent).toBe("80%");
    expect(screen.getByTestId("pdf-zoom-fit")).toBeEnabled();
    fireEvent.click(screen.getByTestId("pdf-zoom-fit"));
    expect(screen.getByTestId("pdf-zoom-now").textContent).toBe("100%");
    await waitFor(() => expect(drawnPages()).toEqual([1, 2]));
  });
});

describe("点来源：滚到那一页、框出那一块、摘录逐字标出", () => {
  it("摘录在出处那一块之内：滚到那一页的那一块附近，框的位置由 PDF 坐标换算，摘录在文字层里逐字标出；过一会儿高亮褪掉、框留着", async () => {
    const onNote = vi.fn();
    const view = await opened({ onNote });
    view.rerender(<Host onNote={onNote} locate={locateAt(`${PATH}#p5-1`, "图书保留 3 天")} />);
    const frame = await screen.findByTestId("pdf-blockbox-5-1");
    // 第 5 页的上沿加这一块在页上的上沿（842 − 770 = 72），再往上让出看得见的高度的三分之一。
    expect(screen.getByTestId("scroller").scrollTop).toBeCloseTo(4 * (H + PAGE_GAP) + 72 - 700 / 3, 3);
    // 矩形 [72, 740, 520, 770] 在页上是左 72、上 72、宽 448、高 30；框四边各放宽 3。
    expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual(["69px", "69px", "454px", "36px"]);
    const page = screen.getByTestId("pdf-page-5");
    await waitFor(() => expect([...page.querySelectorAll("mark.hit")].map((mark) => mark.textContent)).toEqual(["图书保留 3 天"]));
    expect(page.querySelector(".textLayer span")!.textContent).toBe("预约的图书保留 3 天。");
    expect(onNote).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(page.querySelector("mark.hit")).toBeNull());
    expect(screen.getByTestId("pdf-blockbox-5-1")).toBeTruthy();
    expect(page.querySelector(".textLayer span")!.textContent).toBe("预约的图书保留 3 天。");
  });

  it("摘录从出处那一块接到了后面的块：几块都框出来，各自标出自己那一截，顶部写明一共几块", async () => {
    const onNote = vi.fn();
    const view = await opened({ onNote });
    view.rerender(<Host onNote={onNote} locate={locateAt(`${PATH}#p2-1`, "最多借 5 本，借期都是 30 天")} />);
    await screen.findByTestId("pdf-blockbox-2-1");
    expect(screen.getByTestId("pdf-blockbox-2-2")).toBeTruthy();
    await waitFor(() => expect([...screen.getByTestId("pdf-page-2").querySelectorAll("mark.hit")].map((mark) => mark.textContent)).toEqual(["最多借 5 本，", "借期都是 30 天"]));
    expect(onNote).toHaveBeenLastCalledWith(PDF_NOTES.span(2, 2));
    expect(PDF_NOTES.span(2, 2)).toBe("这段摘录从第 2 页框出的第一块接到了后面，一共 2 块，都框出来了。");
  });

  it("找不到、跨了页、没有这一块、文字层对不上：各写一句，能框的照样框，不乱标", async () => {
    const onNote = vi.fn();
    const view = await opened({ onNote });
    // 这一块里没有这段话：框出这一块，写一句，不标字。
    view.rerender(<Host onNote={onNote} locate={locateAt(`${PATH}#p1-2`, "教师一次最多借 10 本", 1)} />);
    await screen.findByTestId("pdf-blockbox-1-2");
    expect(onNote).toHaveBeenLastCalledWith("没有在第 1 页框出的这一块里找到这段原文。");
    expect(document.querySelector("mark.hit")).toBeNull();
    // 接到了下一页才找得到：只框开始的那一块。
    view.rerender(<Host onNote={onNote} locate={locateAt(`${PATH}#p2-2`, "借期都是 30 天。逾期的每本每天罚款一角。", 2)} />);
    await screen.findByTestId("pdf-blockbox-2-2");
    expect(onNote).toHaveBeenLastCalledWith("这段摘录跨了页，只框出了它在第 2 页开始的那一块。");
    // 位置表里没有这一块、页码超出了：不滚动，写一句，原来的框留着。
    const before = screen.getByTestId("scroller").scrollTop;
    view.rerender(<Host onNote={onNote} locate={locateAt(`${PATH}#p2-9`, "随便", 3)} />);
    await waitFor(() => expect(onNote).toHaveBeenLastCalledWith("这份 PDF 里没有第 2 页的第 9 块。"));
    view.rerender(<Host onNote={onNote} locate={locateAt(`${PATH}#p9-1`, "随便", 4)} />);
    await waitFor(() => expect(onNote).toHaveBeenLastCalledWith("这份 PDF 里没有第 9 页的第 1 块。"));
    expect(screen.getByTestId("scroller").scrollTop).toBe(before);
    // 投影里找得到、页面的文字层里差一个字：框出这一块，说明没有逐字标出。
    view.rerender(<Host onNote={onNote} locate={locateAt(`${PATH}#p3-1`, "每天罚款一角", 5)} />);
    await screen.findByTestId("pdf-blockbox-3-1");
    await waitFor(() => expect(onNote).toHaveBeenLastCalledWith(PDF_NOTES.unmatched));
    expect(screen.getByTestId("pdf-page-3").querySelector("mark.hit")).toBeNull();
    expect(PDF_NOTES.unmatched).toBe("已经框出来源指的那一块；摘录的字在页面上对不上，没有逐字标出。");
  });

  it("出处没有写页与块时按摘录找它在哪一块；哪里都没有就写一句", async () => {
    const onNote = vi.fn();
    const view = await opened({ onNote });
    view.rerender(<Host onNote={onNote} locate={locateAt(PATH, "逾期的每本每天罚款一角", 1)} />);
    await screen.findByTestId("pdf-blockbox-3-1");
    view.rerender(<Host onNote={onNote} locate={locateAt(PATH, "材料里没有的话", 2)} />);
    await waitFor(() => expect(onNote).toHaveBeenLastCalledWith("没有在这份 PDF 里找到这段原文。"));
  });

  it("目录里点一项：滚到那一页的开头", async () => {
    const view = await opened();
    view.rerender(<Host jump={{ page: 4, nonce: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("scroller").scrollTop).toBe(3 * (H + PAGE_GAP)));
    view.rerender(<Host jump={{ page: 99, nonce: 2 }} />);
    expect(screen.getByTestId("scroller").scrollTop).toBe(3 * (H + PAGE_GAP));
  });
});

describe("被引用的句子与没有文字的页", () => {
  it("出处对得上这份材料的来源才算；每条给出页、块、摘录与条目", () => {
    expect(pdfCitations(ITEMS, PATH)).toEqual([
      { page: 1, block: 2, excerpt: "读者凭借书证借书，每本书可以续借一次。", itemId: "UC-001" },
      { page: 1, block: 2, excerpt: "读者凭借书证借书，每本书可以续借一次。", itemId: "UC-002" },
      { page: 5, block: 1, excerpt: "图书保留 3 天", itemId: "UC-002" },
      { page: 5, block: 1, excerpt: "这句话材料里没有", itemId: "UC-003" },
    ]);
    expect(pdfCitations(ITEMS, "inputs/别的.pdf").map((cite) => cite.itemId)).toEqual(["UC-001"]);
  });

  it("页面画出来时给被引用的句子画底线，几个条目引用同一句时合在一起；点一下打开引用它的条目；报告有几个条目的引用找得到", async () => {
    const onOpenItem = vi.fn();
    const onCitedCount = vi.fn();
    await opened({ items: ITEMS, onOpenItem, onCitedCount });
    const page = screen.getByTestId("pdf-page-1");
    await waitFor(() => expect(page.querySelectorAll(".textLayer .cited").length).toBe(2));
    const cited = [...page.querySelectorAll<HTMLElement>(".textLayer .cited")];
    expect(cited.map((span) => [span.textContent, span.dataset.items, span.title])).toEqual([
      ["读者凭借书证借书，", "UC-001 UC-002", "被 UC-001、UC-002 引用"], ["每本书可以续借一次。", "UC-001 UC-002", "被 UC-001、UC-002 引用"]]);
    // 标题那一行没有被引用，原样不动。
    expect(page.querySelector(".textLayer span")!.querySelector(".cited")).toBeNull();
    fireEvent.click(cited[0]);
    expect(onOpenItem).toHaveBeenCalledWith("UC-001");
    // UC-001、UC-002 的引用找得到，UC-003 的摘录材料里没有：两个。
    expect(onCitedCount).toHaveBeenLastCalledWith(2);
    // 滚到第 5 页，那里的引用到这时才画上。
    await scrollTo(4 * (H + PAGE_GAP));
    await waitFor(() => expect([...screen.getByTestId("pdf-page-5").querySelectorAll(".cited")].map((span) => span.textContent)).toEqual(["图书保留 3 天"]));
  });

  it("定位的高亮盖在底线上面；高亮褪掉之后底线回来", async () => {
    const view = await opened({ items: ITEMS });
    const page = screen.getByTestId("pdf-page-1");
    await waitFor(() => expect(page.querySelectorAll(".cited").length).toBe(2));
    view.rerender(<Host items={ITEMS} locate={locateAt(`${PATH}#p1-2`, "借书，每本书")} />);
    await waitFor(() => expect([...page.querySelectorAll("mark.hit")].map((mark) => mark.textContent)).toEqual(["借书，", "每本书"]));
    expect([...page.querySelectorAll(".cited")].map((span) => span.textContent)).toEqual(["读者凭借书证", "可以续借一次。"]);
    await waitFor(() => expect(page.querySelector("mark.hit")).toBeNull());
    expect([...page.querySelectorAll(".cited")].map((span) => span.textContent)).toEqual(["读者凭借书证借书，", "每本书可以续借一次。"]);
  });

  it("没有读出文字的页顶上有一条提示，别的页没有", async () => {
    await opened();
    expect(screen.getByTestId("pdf-notext-4").textContent).toBe(NO_TEXT_PAGE);
    expect(NO_TEXT_PAGE).toBe("这一页没有可读的文字（多半是扫描的图片），助手读不到这一页的内容，条目也不能引用它。");
    expect(document.querySelectorAll("[data-testid^=pdf-notext-]").length).toBe(1);
  });
});

describe("显示不出来", () => {
  it("读不到文件：显示任务服务给的说明，报告显示不出来，不走退路", async () => {
    vi.mocked(api.materialRaw).mockRejectedValueOnce(new ApiError("not_found", "材料目录里没有这份文件。", 404));
    const onUnavailable = vi.fn();
    render(<Host onUnavailable={onUnavailable} />);
    expect((await screen.findByTestId("pdf-error")).textContent).toBe("材料目录里没有这份文件。");
    expect(onUnavailable).toHaveBeenLastCalledWith(true);
    expect(screen.queryByTestId("pdf-fallback")).toBeNull();
  });
});

describe("退路：改用浏览器自带的查看器", () => {
  const RAW = `/api/v1/tasks/TASK-1/materials/raw?path=${encodeURIComponent(PATH)}`;
  const frame = () => screen.getByTestId("pdf-fallback-frame") as HTMLIFrameElement;

  it("读到了但 pdf.js 打不开：用 iframe 指向这份文件的真实地址，顶上写明只能按页显示；原因写进控制台，不给用户看", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pdf.openPdf).mockRejectedValueOnce(new Error("No password given"));
    const onUnavailable = vi.fn();
    render(<Host onUnavailable={onUnavailable} />);
    expect(screen.getByTestId("pdf-loading").textContent).toBe("正在读这份 PDF。");
    expect((await screen.findByTestId("pdf-fallback-note")).textContent).toBe(PDF_FALLBACK_NOTE);
    expect(PDF_FALLBACK_NOTE).toBe("这个浏览器里只能按页显示，不能标出摘录。");
    // 真实的接口地址（不是 blob 地址），一开始在第 1 页。
    expect(frame().getAttribute("src")).toBe(`${RAW}#page=1`);
    expect(screen.getByTestId("pdf-fallback").textContent).not.toContain("password");
    expect(logged).toHaveBeenCalledTimes(1);
    // 文件本身没有问题，不算「显示不出来」：材料区的说明与目录都留着。
    expect(onUnavailable).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("pdf-pages")).toBeNull();
  });

  it("有一页画不出来（浏览器太旧）：整份改走退路，不再接着画", async () => {
    brokenRender = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Host />);
    expect((await screen.findByTestId("pdf-fallback-note")).textContent).toBe(PDF_FALLBACK_NOTE);
    expect(frame().getAttribute("src")).toBe(`${RAW}#page=1`);
    expect(logged).toHaveBeenCalled();
    const calls = rendered.mock.calls.length;
    await new Promise((ok) => setTimeout(ok, 30));
    expect(rendered.mock.calls.length).toBe(calls);
  });

  it("浏览器给不出画布的绘图环境：同样走退路，不留一片空白", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Host />);
    expect((await screen.findByTestId("pdf-fallback-note")).textContent).toBe(PDF_FALLBACK_NOTE);
  });

  it("退路里点来源、点目录只跳到那一页：地址后面换成 #page=N，查看器重新装一遍；不框块、不写找不到之类的话", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pdf.openPdf).mockRejectedValue(new Error("打不开"));
    const onNote = vi.fn();
    const onPage = vi.fn();
    const view = render(<Host onNote={onNote} onPage={onPage} />);
    await screen.findByTestId("pdf-fallback");
    const first = frame();
    view.rerender(<Host onNote={onNote} onPage={onPage} locate={locateAt(`${PATH}#p3-1`, "逾期的每本每天罚款一角", 1)} />);
    await waitFor(() => expect(frame().getAttribute("src")).toBe(`${RAW}#page=3`));
    expect(frame()).not.toBe(first);
    expect(onNote).toHaveBeenLastCalledWith(null);
    expect(document.querySelector(".pdf-blockbox")).toBeNull();
    await waitFor(() => expect(onPage).toHaveBeenLastCalledWith(3, 5));
    // 同一页再点一次：也重新装一遍（查看器里可能已经翻到别处了）。
    const third = frame();
    view.rerender(<Host onNote={onNote} onPage={onPage} locate={locateAt(`${PATH}#p3-1`, "逾期的每本每天罚款一角", 2)} />);
    await waitFor(() => expect(frame()).not.toBe(third));
    expect(frame().getAttribute("src")).toBe(`${RAW}#page=3`);
    // 出处没有写页：按摘录找它在哪一页。
    view.rerender(<Host onNote={onNote} onPage={onPage} locate={locateAt(PATH, "预约的图书保留 3 天", 3)} />);
    await waitFor(() => expect(frame().getAttribute("src")).toBe(`${RAW}#page=5`));
    // 目录里点一项。
    view.rerender(<Host onNote={onNote} onPage={onPage} jump={{ page: 2, nonce: 1 }} />);
    await waitFor(() => expect(frame().getAttribute("src")).toBe(`${RAW}#page=2`));
    await waitFor(() => expect(onPage).toHaveBeenLastCalledWith(2, 5));
  });

  it("换一份文件：重新先用 pdf.js 试", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pdf.openPdf).mockRejectedValueOnce(new Error("打不开"));
    const view = render(<Host />);
    await screen.findByTestId("pdf-fallback");
    view.rerender(<Host path="inputs/另一份.pdf" />);
    await screen.findByTestId("pdf-pages");
    expect(screen.queryByTestId("pdf-fallback")).toBeNull();
  });
});
