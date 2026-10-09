// PDF 材料接进页面的几处：材料区（文件名一行的页数与无文字页、说明、目录、把定位与跳转交给显示部件、选中文字的整理）、
// 目录（有书签目录与没有两种）、条目详情里的来源标签（「第 N 页 · 章节」）、任务页材料卡上的页数。
// 显示部件本身在 pdfPaper.test.tsx 里测；这里把它换成一个记下收到什么的替身。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode, RefObject } from "react";
import { api, ApiError } from "../api/client";
import { MaterialPane, PDF_HINT, type LocateRequest } from "../components/work/MaterialPane";
import { MaterialsCard, pdfSummary } from "../components/task/MaterialsCard";
import { PdfOutline } from "../components/work/PdfOutline";
import { ToastProvider } from "../components/Toasts";
import { pdfUploadingText } from "../model/upload";
import { chapterOfPage, headingOfPage } from "../model/pdfView";
import { resetPdfStore } from "../state/pdfStore";
import { ItemsPanel } from "../components/work/ItemsPanel";
import type { Item, Material, Task } from "../api/types";

type PaperProps = { path: string; locate: LocateRequest | null; jump?: { page: number; nonce: number } | null;
  paperRef?: RefObject<HTMLDivElement | null>; onMouseUp?: () => void;
  onPage?: (page: number, count: number) => void; onNote?: (text: string | null) => void; onCitedCount?: (n: number) => void; onUnavailable?: (off: boolean) => void };
const paper = vi.fn((_props: PaperProps) => null);
vi.mock("../components/work/PdfPaper", () => ({
  PdfPaper: (props: PaperProps) => {
    paper(props);
    return (
      <div data-testid="pdf-paper-stub" ref={props.paperRef} onMouseUp={props.onMouseUp}>
        <button type="button" onClick={() => props.onPage?.(3, 5)}>到第 3 页</button>
        <button type="button" onClick={() => props.onNote?.("没有在第 2 页框出的这一块里找到这段原文。")}>写一句</button>
        <button type="button" onClick={() => props.onCitedCount?.(2)}>两个条目引用</button>
        <button type="button" onClick={() => props.onUnavailable?.(true)}>显示不出来</button>
        <span id="pdf-line">读者凭借书证借书，{"\n"}每本书可以续借一次。</span>
      </div>
    );
  },
}));

Element.prototype.scrollTo ??= function () {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><div className="app">{children}</div></AntApp></ConfigProvider>
);
const PDF = "inputs/借阅管理办法.pdf";
/** 一个任务，里面一个条目，带给定的来源；条目详情开着。 */
function OpenItem({ sources }: { sources: unknown[] }) {
  const item = { item_id: "UC-001", collection: "功能用例", title: "借阅图书", revision_no: 1, revisions: [1], revision_by: "executor", revision_at: "",
    reviews: [], confirmations: [], confirmation_stale: false, sources, fields: { 用例名称: "借阅图书" } } as unknown as Item;
  const task = { task_id: "TASK-S", task_name: "来源", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [{ name: "功能用例", prefix: "UC", needs_review: false, fields: [{ name: "用例名称", type: "文本", required: true, values: null }] }] },
    completion: null, items: [item] } as unknown as Task;
  return <Wrap><ItemsPanel task={task} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected="UC-001" onSelect={() => {}}
    submit={vi.fn(async () => null)} onGenerateDoc={() => {}} /></Wrap>;
}
const page = (n: number, noText = false) => ({ page: n, width: 595, height: 842, rotate: 0, no_text: noText, blocks: [] });
const table = (headings: { page: number; level: number; title: string }[], pages = 5) => ({
  version: 1, rules_version: 1, 说明: "", source: PDF, engine: "", producer: "", pages: Array.from({ length: pages }, (_, i) => page(i + 1, i === 3)), headings,
});
const HEADINGS = [{ page: 1, level: 1, title: "一、总则" }, { page: 2, level: 1, title: "二、借阅规则" }, { page: 2, level: 2, title: "（一）借阅数量" }, { page: 4, level: 1, title: "三、逾期" }];
const material = (path: string, over: Partial<Material> = {}): Material => ({ path, bytes: 1000, modified_at: "", derived_from: null, ...over });
const MATERIALS = [
  material(PDF, { pdf: { pages: 5, units: 12, no_text_pages: [4] } }),
  material(`${PDF}.md`, { derived_from: PDF }), material(`${PDF}.locations.json`, { derived_from: PDF }), material(`${PDF}.segments.json`, { derived_from: PDF }),
  material("inputs/说明.md"),
];
const serve = (headings = HEADINGS) => vi.spyOn(api, "materialContent").mockImplementation(async (_task, path) => {
  if (path.endsWith(".pdf.locations.json")) return { text: JSON.stringify(table(headings)) } as Awaited<ReturnType<typeof api.materialContent>>;
  return { text: "读者可以借书。" } as Awaited<ReturnType<typeof api.materialContent>>;
});

beforeEach(() => { paper.mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetPdfStore(); });

describe("目录", () => {
  it("一页属于目录的哪一项：没有书签指向这一页时接着前面最近的一项；正好一个时取它；不止一个时分不出来，不取", () => {
    // 第 2 页上有两个书签（二、借阅规则 与 （一）借阅数量）：第 2 页分不出；第 3 页接着前面最近的一项，是准的。
    expect([1, 2, 3, 4, 9].map((n) => headingOfPage(HEADINGS, n))).toEqual([0, -1, 2, 3, 3]);
    expect([headingOfPage([], 3), headingOfPage([{ page: 3 }], 2)]).toEqual([-1, -1]);
    expect([1, 2, 3, 4].map((n) => chapterOfPage(HEADINGS, n))).toEqual(["一、总则", null, "（一）借阅数量", "三、逾期"]);
    expect(chapterOfPage([{ page: 1, title: "" }], 1)).toBeNull();
  });

  it("有书签目录：默认收起，写有几项；点开逐项列出标题与页，下一级缩进，现在看的那一项标出来；点一项跳到那一页", async () => {
    serve();
    const onJump = vi.fn();
    render(<Wrap><PdfOutline taskId="TASK-1" path={PDF} page={3} pages={5} onJump={onJump} /></Wrap>);
    const toggle = await screen.findByTestId("pdf-toc-toggle");
    expect(toggle.textContent).toBe("▸目录：4 项（点开按章节跳转）");
    expect(screen.queryByTestId("pdf-toc-list")).toBeNull();
    fireEvent.click(toggle);
    const rows = screen.getAllByTestId("pdf-toc-row");
    expect(rows.map((row) => row.textContent)).toEqual(["一、总则第 1 页", "二、借阅规则第 2 页", "（一）借阅数量第 2 页", "三、逾期第 4 页"]);
    expect(rows.map((row) => row.style.paddingLeft)).toEqual(["1.8rem", "1.8rem", "3rem", "1.8rem"]);
    expect(rows.map((row) => row.classList.contains("cur"))).toEqual([false, false, true, false]);
    expect(screen.queryByTestId("pdf-toc-none")).toBeNull();
    fireEvent.click(rows[3]);
    expect(onJump).toHaveBeenCalledWith(4);
  });

  it("现在看的那一页上有不止一个书签时，目录里哪一项都不标", async () => {
    serve();
    render(<Wrap><PdfOutline taskId="TASK-1" path={PDF} page={2} pages={5} onJump={() => {}} /></Wrap>);
    fireEvent.click(await screen.findByTestId("pdf-toc-toggle"));
    expect(screen.getAllByTestId("pdf-toc-row").map((row) => row.classList.contains("cur"))).toEqual([false, false, false, false]);
  });

  it("没有书签目录：写「这份文件没有目录」，按页列，点一页跳过去", async () => {
    serve([]);
    const onJump = vi.fn();
    render(<Wrap><PdfOutline taskId="TASK-1" path={PDF} page={2} pages={5} onJump={onJump} /></Wrap>);
    const toggle = await screen.findByTestId("pdf-toc-toggle");
    expect(toggle.textContent).toBe("▸这份文件没有目录，可以按页跳转（共 5 页）");
    fireEvent.click(toggle);
    expect(screen.getByTestId("pdf-toc-none").textContent).toBe("这份文件没有目录");
    const rows = screen.getAllByTestId("pdf-toc-row");
    expect(rows.map((row) => row.textContent)).toEqual(["第 1 页", "第 2 页", "第 3 页", "第 4 页", "第 5 页"]);
    expect(rows.map((row) => row.classList.contains("cur"))).toEqual([false, true, false, false, false]);
    fireEvent.click(rows[4]);
    expect(onJump).toHaveBeenCalledWith(5);
  });

  it("位置表读不到时整栏不显示", async () => {
    const content = vi.spyOn(api, "materialContent").mockRejectedValue(new ApiError("not_found", "没有这个文件。", 404));
    render(<Wrap><PdfOutline taskId="TASK-1" path={PDF} page={1} pages={5} onJump={() => {}} /></Wrap>);
    await waitFor(() => expect(content).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("pdf-toc")).toBeNull());
  });
});

describe("材料区里的 PDF 材料", () => {
  it("下拉框里只列用户放进来的文件；PDF 交给显示部件，文件名一行写页数与有几页没有可读的文字，下面是说明与目录", async () => {
    const content = serve();
    render(<Wrap><MaterialPane taskId="TASK-1" materials={MATERIALS} /></Wrap>);
    expect([...screen.getByTestId("material-select").querySelectorAll("option")].map((o) => o.textContent)).toEqual(["借阅管理办法.pdf", "说明.md"]);
    expect(screen.getByTestId("pdf-paper-stub")).toBeTruthy();
    expect(paper.mock.calls[0][0].path).toBe(PDF);
    expect(screen.getByTestId("pdf-pages-chip").textContent).toBe("5 页");
    expect(screen.getByTestId("pdf-notext-chip").textContent).toBe("其中 1 页没有可读的文字");
    expect(screen.getByTestId("pdf-hint").textContent).toBe(PDF_HINT);
    expect(PDF_HINT).toBe("PDF 材料按原样分页显示。PDF 里的表格按行读取，不分格。");
    expect((await screen.findByTestId("pdf-toc-toggle")).textContent).toContain("目录：4 项");
    // 材料区自己不去读 PDF 的文字（那是显示部件与读取缓存的事），只为目录读了位置表。
    expect(content.mock.calls.map((call) => call[1])).toEqual([`${PDF}.locations.json`]);
    expect(screen.queryByTestId("paper")).toBeNull();
    // 显示部件报上来的：被几个条目引用、定位时的一句话。
    fireEvent.click(screen.getByText("两个条目引用"));
    expect(screen.getByText("被 2 个条目引用过")).toBeTruthy();
    fireEvent.click(screen.getByText("写一句"));
    expect(screen.getByTestId("locate-note").textContent).toBe("没有在第 2 页框出的这一块里找到这段原文。");
  });

  it("材料清单里没有页数时（旧数据），页数与没有文字的页数从位置表里数；都读出了文字就不写后半句", async () => {
    serve();
    const view = render(<Wrap><MaterialPane taskId="TASK-1" materials={[material(PDF)]} /></Wrap>);
    expect((await screen.findByTestId("pdf-pages-chip")).textContent).toBe("5 页");
    expect(screen.getByTestId("pdf-notext-chip").textContent).toBe("其中 1 页没有可读的文字");
    view.unmount();
    render(<Wrap><MaterialPane taskId="TASK-1" materials={[material(PDF, { pdf: { pages: 2, units: 9, no_text_pages: [] } })]} /></Wrap>);
    expect(screen.getByTestId("pdf-pages-chip").textContent).toBe("2 页");
    expect(screen.queryByTestId("pdf-notext-chip")).toBeNull();
  });

  it("目录里点一项：把那一页交给显示部件；显示部件报现在看第几页，目录里那一项标出来", async () => {
    serve();
    render(<Wrap><MaterialPane taskId="TASK-1" materials={MATERIALS} /></Wrap>);
    fireEvent.click(await screen.findByTestId("pdf-toc-toggle"));
    fireEvent.click(screen.getAllByTestId("pdf-toc-row")[3]);
    expect(paper.mock.lastCall![0].jump).toEqual({ page: 4, nonce: 1 });
    fireEvent.click(screen.getAllByTestId("pdf-toc-row")[0]);
    expect(paper.mock.lastCall![0].jump).toEqual({ page: 1, nonce: 2 });
    fireEvent.click(screen.getByText("到第 3 页"));
    expect(screen.getAllByTestId("pdf-toc-row").map((row) => row.classList.contains("cur"))).toEqual([false, false, true, false]);
  });

  it("点来源：出处是「路径#p页-块」时切到那份 PDF，把定位请求交给显示部件；出处是别的材料的不交给它", async () => {
    serve();
    const first: LocateRequest = { locator: `${PDF}#p2-3`, excerpt: "学生一次最多借 5 本", nonce: 1 };
    const view = render(<Wrap><MaterialPane taskId="TASK-1" materials={[MATERIALS[4], ...MATERIALS.slice(0, 4)]} locate={null} /></Wrap>);
    // 一打开显示的是清单里的第一份（文本材料）。
    await screen.findByTestId("paper");
    expect(screen.queryByTestId("pdf-paper-stub")).toBeNull();
    view.rerender(<Wrap><MaterialPane taskId="TASK-1" materials={[MATERIALS[4], ...MATERIALS.slice(0, 4)]} locate={first} /></Wrap>);
    await screen.findByTestId("pdf-paper-stub");
    expect((screen.getByTestId("material-select") as HTMLSelectElement).value).toBe(PDF);
    expect(paper.mock.lastCall![0].locate).toEqual(first);
    // 文本材料那一套「找到就高亮、找不到就提示」不用在 PDF 上。
    expect(screen.queryByTestId("locate-miss")).toBeNull();
  });

  it("选中的文字跨行时整理成一段话再发给助手；显示不出来时收起说明与目录", async () => {
    serve();
    const onSend = vi.fn();
    render(<Wrap><MaterialPane taskId="TASK-1" materials={MATERIALS} onSend={onSend} /></Wrap>);
    await screen.findByTestId("pdf-toc");
    // 在显示部件里选中两行字：浏览器给的文字里带着换行。
    const line = document.getElementById("pdf-line")!;
    const range = document.createRange();
    range.selectNodeContents(line);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(String(window.getSelection())).toContain("\n");
    fireEvent.mouseUp(screen.getByTestId("pdf-paper-stub"));
    fireEvent.click(await screen.findByText("据此新建条目"));
    expect(onSend).toHaveBeenCalledWith(`请根据材料 ${PDF} 里的这段原文新建条目：「读者凭借书证借书，每本书可以续借一次。」`);
    fireEvent.click(screen.getByText("显示不出来"));
    expect(screen.queryByTestId("pdf-hint")).toBeNull();
    expect(screen.queryByTestId("pdf-toc")).toBeNull();
  });
});

describe("来源标签与任务页材料卡", () => {
  it("来源出自 PDF 材料：写「文件名 · 第 N 页 · 章节」，页就是出处里的页", async () => {
    serve();
    render(<OpenItem sources={[{ kind: "文档原文", locator: `${PDF}#p3-2`, excerpt: "学生一次最多借 5 本。", supports: [] }]} />);
    await waitFor(() => expect(document.querySelector(".srcbox .evi")!.textContent).toBe("出处：借阅管理办法.pdf · 第 3 页 · （一）借阅数量（点一下看原文）"));
  });

  it("这一页上有不止一个书签时分不出这一块属于哪一项：只写到页", async () => {
    serve();
    render(<OpenItem sources={[{ kind: "文档原文", locator: `${PDF}#p2-1`, excerpt: "借阅规则。", supports: [] }]} />);
    await waitFor(() => expect(api.materialContent).toHaveBeenCalled());
    // 位置表读到之后标签仍然只到页（第 2 页上有「二、借阅规则」与「（一）借阅数量」两个书签）。
    await new Promise((ok) => setTimeout(ok, 30));
    expect(document.querySelector(".srcbox .evi")!.textContent).toBe("出处：借阅管理办法.pdf · 第 2 页（点一下看原文）");
  });

  it("文件没有书签目录、位置表读不到时只写到页", async () => {
    serve([]);
    render(<OpenItem sources={[{ kind: "文档原文", locator: `${PDF}#p3-2`, excerpt: "学生一次最多借 5 本。", supports: [] }]} />);
    await waitFor(() => expect(api.materialContent).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector(".srcbox .evi")!.textContent).toBe("出处：借阅管理办法.pdf · 第 3 页（点一下看原文）"));
  });

  it("上传 PDF 时先说一句「正在上传……要多等一会儿」，传完（或没有传成）这一句原地换成结果；别的文件不说", async () => {
    expect(pdfUploadingText("办法.PDF")).toBe("正在上传 办法.PDF。PDF 要先读出各页的文字，页数多的要多等一会儿。");
    expect([pdfUploadingText("说明.md"), pdfUploadingText("规范.docx")]).toEqual([null, null]);
    let finish: (value: { path: string }) => void = () => {};
    const sent = vi.spyOn(api, "uploadMaterial").mockImplementation(() => new Promise((ok) => { finish = ok; }));
    const onChanged = vi.fn();
    render(<Wrap><ToastProvider><MaterialsCard taskId="TASK-1" materials={[]} closed={false} info={null} onView={() => {}} onChanged={onChanged} /></ToastProvider></Wrap>);
    // 每传一次，上传框会换一个新的文件输入框，所以每次现找。
    const choose = (file: File) => fireEvent.change(document.querySelector("input[type=file]") as HTMLInputElement, { target: { files: [file] } });
    choose(new File(["%PDF"], "办法.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("正在上传 办法.pdf。PDF 要先读出各页的文字，页数多的要多等一会儿。")).toBeTruthy();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    finish({ path: "inputs/办法.pdf" });
    expect(await screen.findByText("已上传：inputs/办法.pdf")).toBeTruthy();
    expect(screen.queryByText(/^正在上传/)).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 没有传成：那一句同样换成任务服务给的话。
    sent.mockRejectedValueOnce(new ApiError("bad_request", "这份 PDF 打不开。", 400));
    choose(new File(["x"], "坏的.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("这份 PDF 打不开。")).toBeTruthy();
    expect(screen.queryByText(/^正在上传/)).toBeNull();
    // 文本材料：不说那一句。
    sent.mockResolvedValueOnce({ path: "inputs/说明.md" });
    choose(new File(["x"], "说明.md", { type: "text/markdown" }));
    expect(await screen.findByText("已上传：inputs/说明.md")).toBeTruthy();
    expect(screen.queryByText(/^正在上传/)).toBeNull();
  });

  it("任务页的材料卡：PDF 材料名字后面写页数，有没有读出文字的页时写有几页", () => {
    expect(pdfSummary({ pages: 12, no_text_pages: [] })).toBe("12 页");
    expect(pdfSummary({ pages: 12, no_text_pages: [3, 7] })).toBe("12 页，其中 2 页没有可读的文字");
    const onView = vi.fn();
    render(<Wrap><MaterialsCard taskId="TASK-1" materials={[MATERIALS[0], MATERIALS[4]]} closed={false} info={null} onView={onView} onChanged={() => {}} /></Wrap>);
    const rows = screen.getAllByTestId("material-row");
    expect(rows[0].querySelector("[data-testid=material-pdf]")!.textContent).toBe("5 页，其中 1 页没有可读的文字");
    expect(rows[1].querySelector("[data-testid=material-pdf]")).toBeNull();
    fireEvent.click(rows[0].querySelector("[data-testid=material-view]")!);
    expect(onView).toHaveBeenCalledWith(MATERIALS[0]);
  });
});
