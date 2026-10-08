// 图表组件（components/diagram）：文本画成图、画不出来时写明原因、点「导出 PNG」把当前这张图交给导出。
// jsdom 里 mermaid 量不了文字的大小、也没有画布，所以这里把 mermaid 包换成假的（画图）、把导出换成假的（只看交过去的东西）；
// 真的画图与导出在浏览器里另行实测。给 SVG 写宽高、定放大倍数、定文件名这三样不靠浏览器，直接测。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DIAGRAM_DRAWING_TEXT, DIAGRAM_EMPTY_TEXT, DIAGRAM_FAILED_TEXT, DiagramView, EXPORT_FAILED_TEXT, exportShrunkText } from "../components/diagram/DiagramView";
import * as diagram from "../components/diagram/mermaid";

const drawings = new Map<string, { resolve: (svg: string) => void; reject: (error: Error) => void }>();
const fakeRender = vi.fn((id: string, text: string) => new Promise<{ svg: string }>((resolve, reject) => {
  // 文本里写着「慢」的那一次不马上回答，由测试决定什么时候回答；写着「写错」的报错；别的马上画好。
  if (text.includes("慢")) drawings.set(text, { resolve: (svg) => resolve({ svg }), reject });
  else if (text.includes("写错")) reject(new Error("Parse error on line 2:\n...A[开始 --> B\n-----------^\nExpecting 'SQE', got 'SQS'"));
  else resolve({ svg: `<svg id="${id}" viewBox="0 0 120 60" width="100%" style="max-width: 120px;"><text>${text.split("\n")[1] ?? ""}</text></svg>` });
}));
const fakeInitialize = vi.fn();
vi.mock("mermaid", () => ({ default: { initialize: (...args: unknown[]) => fakeInitialize(...args), render: (id: string, text: string) => fakeRender(id, text) } }));
vi.mock("../components/diagram/mermaid", async (original) => ({ ...(await original<typeof diagram>()), exportPng: vi.fn(async () => ({ scale: 2 })) }));

const exportPng = vi.mocked(diagram.exportPng);
const GOOD = "flowchart TD\n  A[买家提交售后申请] --> B[售后专员审核]";
const BAD = "flowchart TD\n  写错 A[开始 --> B";

afterEach(() => { cleanup(); drawings.clear(); fakeRender.mockClear(); exportPng.mockReset(); exportPng.mockImplementation(async () => ({ scale: 2 })); });

describe("画图", () => {
  it("文本画成图放进页面，按钮可以点；mermaid 只设一次，用 strict 并且不让它往页面里塞报错图", async () => {
    render(<DiagramView text={GOOD} />);
    expect(screen.getByTestId("diagram-drawing")).toHaveTextContent(DIAGRAM_DRAWING_TEXT);
    expect(screen.getByTestId("diagram-export")).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("diagram-svg").querySelector("svg")).not.toBeNull());
    expect(screen.getByTestId("diagram-svg")).toHaveTextContent("A[买家提交售后申请] --> B[售后专员审核]");
    expect(screen.getByTestId("diagram-export")).toBeEnabled();
    expect(fakeInitialize).toHaveBeenCalledTimes(1);
    expect(fakeInitialize).toHaveBeenCalledWith({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true });
  });

  it("画不出来时写明原因（mermaid 的原话），不显示图，按钮不能点", async () => {
    render(<DiagramView text={BAD} />);
    const error = await screen.findByTestId("diagram-error");
    expect(error).toHaveTextContent(DIAGRAM_FAILED_TEXT);
    expect(error).toHaveTextContent("Parse error on line 2:");
    expect(error).toHaveTextContent("Expecting 'SQE', got 'SQS'");
    expect(screen.queryByTestId("diagram-svg")).toBeNull();
    expect(screen.getByTestId("diagram-export")).toBeDisabled();
  });

  it("没有文本时不画，写一句说明", () => {
    render(<DiagramView text={"  \n"} />);
    expect(screen.getByTestId("diagram-empty")).toHaveTextContent(DIAGRAM_EMPTY_TEXT);
    expect(fakeRender).not.toHaveBeenCalled();
    expect(screen.getByTestId("diagram-export")).toBeDisabled();
  });

  it("文本改了就重画；改错了只显示原因，不留着上一张图", async () => {
    const view = render(<DiagramView text={GOOD} />);
    await screen.findByTestId("diagram-svg");
    view.rerender(<DiagramView text={BAD} />);
    await screen.findByTestId("diagram-error");
    expect(screen.queryByTestId("diagram-svg")).toBeNull();
    view.rerender(<DiagramView text={"flowchart TD\n  C[财务发起退款]"} />);
    await waitFor(() => expect(screen.getByTestId("diagram-svg")).toHaveTextContent("C[财务发起退款]"));
  });

  it("先发出的一次后画好时，不盖掉后发出的那一次的结果", async () => {
    const slow = "flowchart TD\n  慢 A[旧文本]";
    const view = render(<DiagramView text={slow} />);
    await waitFor(() => expect(drawings.has(slow)).toBe(true));
    view.rerender(<DiagramView text={GOOD} />);
    await waitFor(() => expect(screen.getByTestId("diagram-svg")).toHaveTextContent("买家提交售后申请"));
    drawings.get(slow)!.resolve('<svg viewBox="0 0 10 10"><text>旧文本的图</text></svg>');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("diagram-svg")).toHaveTextContent("买家提交售后申请");
    expect(screen.getByTestId("diagram-svg")).not.toHaveTextContent("旧文本的图");
  });
});

describe("导出 PNG", () => {
  it("点按钮把当前这张图的 SVG 与文件名交给导出", async () => {
    render(<DiagramView text={GOOD} fileName="D-001 售后申请的流程" />);
    await screen.findByTestId("diagram-svg");
    fireEvent.click(screen.getByTestId("diagram-export"));
    await waitFor(() => expect(exportPng).toHaveBeenCalledTimes(1));
    const [svg, name] = exportPng.mock.calls[0];
    expect(svg).toContain("<svg");
    expect(svg).toContain("A[买家提交售后申请]");
    expect(name).toBe("D-001 售后申请的流程");
    await waitFor(() => expect(screen.getByTestId("diagram-export")).toBeEnabled());
    expect(screen.queryByTestId("diagram-note")).toBeNull();
  });

  it("没有导出成时写明原因；图太大、倍数降了时写明降到了几倍", async () => {
    render(<DiagramView text={GOOD} />);
    await screen.findByTestId("diagram-svg");
    exportPng.mockRejectedValueOnce(new Error("浏览器没有给出 PNG。"));
    fireEvent.click(screen.getByTestId("diagram-export"));
    expect(await screen.findByTestId("diagram-note")).toHaveTextContent(`${EXPORT_FAILED_TEXT}浏览器没有给出 PNG。`);
    // 按钮转圈的样子收起来之后才收得到下一次点击。
    await waitFor(() => expect(screen.getByTestId("diagram-export")).not.toHaveClass("ant-btn-loading"));
    exportPng.mockResolvedValueOnce({ scale: 1.25 });
    fireEvent.click(screen.getByTestId("diagram-export"));
    await waitFor(() => expect(screen.getByTestId("diagram-note")).toHaveTextContent(exportShrunkText(1.25)));
    expect(exportShrunkText(1.25)).toBe("这张图很大，导出的 PNG 只放大了 1.3 倍（平常是 2 倍）。");
    expect(exportShrunkText(0.44)).toBe("这张图很大，导出的 PNG 缩小到了原图的 0.4 倍，字可能看不清；把图拆成几张再导出。");
  });
});

describe("导出用到的三样计算", () => {
  it("给 SVG 写上明确的宽高：取 viewBox 的大小，去掉 max-width", () => {
    const sized = diagram.sizedSvg('<svg viewBox="0 0 462.5 929.2" width="100%" style="max-width: 462.5px;"><text>买家</text></svg>');
    expect([sized.width, sized.height]).toEqual([463, 930]);
    expect(sized.text).toContain('width="463"');
    expect(sized.text).toContain('height="930"');
    expect(sized.text).not.toContain("max-width");
    expect(sized.text).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(sized.text).toContain("买家");
    // 没有 viewBox 时取 width、height 属性；都没有时给一个固定的大小。
    expect(diagram.sizedSvg('<svg width="300" height="120"></svg>')).toMatchObject({ width: 300, height: 120 });
    expect(diagram.sizedSvg("<svg></svg>")).toMatchObject({ width: 800, height: 600 });
  });

  it("平常放大 2 倍；放大后超过画布上限的图，降到正好放得下", () => {
    expect(diagram.pngScale(463, 930)).toBe(2);
    expect(diagram.pngScale(4000, 4000)).toBe(2);
    const wide = diagram.pngScale(12000, 300);
    expect(wide).toBeCloseTo(diagram.CANVAS_MAX_SIDE / 12000, 6);
    expect(12000 * wide).toBeLessThanOrEqual(diagram.CANVAS_MAX_SIDE);
    const big = diagram.pngScale(6000, 6000);
    expect(big).toBeLessThan(2);
    expect(6000 * big * 6000 * big).toBeLessThanOrEqual(diagram.CANVAS_MAX_AREA + 1);
  });

  it("文件名：去掉不能用的字符，加 .png；空的时候叫「图」", () => {
    expect(diagram.pngFileName("D-001 售后申请的流程")).toBe("D-001 售后申请的流程.png");
    expect(diagram.pngFileName('退款/换货: "流程"?')).toBe("退款_换货_ _流程_.png");
    expect(diagram.pngFileName("  ")).toBe("图.png");
    expect(diagram.pngFileName("..隐藏")).toBe("隐藏.png");
  });
});

describe("看板：拖动、滚轮与四个按钮", () => {
  /** 看板的大小（jsdom 里量不到，这里给定）与它在页面上的位置。 */
  const stageIs = (width: number, height: number, left = 0, top = 0) => {
    const spies = [
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width),
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height),
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }),
    ];
    return () => spies.forEach((spy) => spy.mockRestore());
  };
  const drawnView = async (text = GOOD) => {
    const view = render(<DiagramView text={text} />);
    await waitFor(() => expect(screen.getByTestId("diagram-svg").querySelector("svg")).not.toBeNull());
    return view;
  };
  const transform = () => screen.getByTestId("diagram-svg").style.transform;
  const percent = () => screen.getByTestId("diagram-zoom-now").textContent;

  it("图按原始大小放在看板里，放得下就居中；四个按钮以看板中心为锚改比例或重新摆放，旁边写现在是百分之几", async () => {
    const restore = stageIs(600, 400);
    await drawnView();
    const box = screen.getByTestId("diagram-svg");
    const svg = box.querySelector("svg")!;
    // SVG 写上了原始的宽高（120×60），放大缩小靠外面那一层的变换。
    expect([svg.getAttribute("width"), svg.getAttribute("height"), svg.getAttribute("style")]).toEqual(["120", "60", null]);
    expect([box.style.width, box.style.height, box.style.transformOrigin]).toEqual(["120px", "60px", "0 0"]);
    expect(screen.getByTestId("diagram-stage").style.overflow).toBe("hidden");
    expect([transform(), percent()]).toEqual(["translate(240px, 170px) scale(1)", "100%"]);
    fireEvent.click(screen.getByTestId("diagram-zoom-in"));
    expect([transform(), percent()]).toEqual(["translate(225px, 163px) scale(1.25)", "125%"]);
    fireEvent.click(screen.getByTestId("diagram-zoom-out"));
    fireEvent.click(screen.getByTestId("diagram-zoom-out"));
    expect([transform(), percent()]).toEqual(["translate(252px, 176px) scale(0.8)", "80%"]);
    // 适应宽度：比例到了上限 4 倍，重新摆放。
    fireEvent.click(screen.getByTestId("diagram-zoom-fit"));
    expect([transform(), percent()]).toEqual(["translate(60px, 80px) scale(4)", "400%"]);
    fireEvent.click(screen.getByTestId("diagram-zoom-actual"));
    expect([transform(), percent()]).toEqual(["translate(240px, 170px) scale(1)", "100%"]);
    restore();
  });

  it("按住左键拖动是平移：移动与松开在整个窗口上都算，松开之后不再跟着动；右键不拖；比例不变", async () => {
    const restore = stageIs(600, 400);
    await drawnView();
    const stage = screen.getByTestId("diagram-stage");
    expect(stage.style.cursor).toBe("grab");
    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100 });
    expect(stage.style.cursor).toBe("grabbing");
    fireEvent.pointerMove(window, { clientX: 130, clientY: 80 });
    expect(transform()).toBe("translate(270px, 150px) scale(1)");
    // 鼠标移到看板外面也接着拖。
    fireEvent.pointerMove(window, { clientX: -500, clientY: 900 });
    expect(transform()).toBe("translate(-360px, 970px) scale(1)");
    fireEvent.pointerUp(window);
    expect(stage.style.cursor).toBe("grab");
    fireEvent.pointerMove(window, { clientX: 0, clientY: 0 });
    expect(transform()).toBe("translate(-360px, 970px) scale(1)");
    fireEvent.pointerDown(stage, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 });
    expect([transform(), percent(), stage.style.cursor]).toEqual(["translate(-360px, 970px) scale(1)", "100%", "grab"]);
    restore();
  });

  it("滚轮放大缩小，光标底下的那一处图不动；页面不跟着滚；比例有上下限", async () => {
    const restore = stageIs(600, 400, 100, 50);
    await drawnView();
    const stage = screen.getByTestId("diagram-stage");
    const parsed = () => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(transform())!; return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) }; };
    /** 看板上 (px, py) 这一点底下是图上的哪一处。 */
    const under = (px: number, py: number) => { const v = parsed(); return [Math.round((px - v.x) / v.zoom), Math.round((py - v.y) / v.zoom)]; };
    // 光标在页面上的 (150, 70)，也就是看板上的 (50, 20)。
    const before = under(50, 20);
    const up = createEvent.wheel(stage, { deltaY: -100, clientX: 150, clientY: 70 });
    fireEvent(stage, up);
    expect(up.defaultPrevented).toBe(true);
    expect([transform(), percent()]).toEqual(["translate(259px, 185px) scale(1.1)", "110%"]);
    expect(under(50, 20)).toEqual(before);
    fireEvent.wheel(stage, { deltaY: 100, clientX: 150, clientY: 70 });
    expect([percent(), under(50, 20)]).toEqual(["100%", before]);
    for (let i = 0; i < 30; i++) fireEvent.wheel(stage, { deltaY: 100, clientX: 150, clientY: 70 });
    expect(percent()).toBe("25%");
    for (let i = 0; i < 60; i++) fireEvent.wheel(stage, { deltaY: -100, clientX: 150, clientY: 70 });
    expect(percent()).toBe("400%");
    restore();
  });

  it("一打开时比看板宽的图缩到看板的宽度，但最多缩到一半；用户动过视图之后文本再变也不改视图", async () => {
    let restore = stageIs(100, 400);
    const first = await drawnView();
    expect([transform(), percent()]).toEqual(["translate(8px, 175px) scale(0.83)", "83%"]);
    first.unmount();
    restore();
    restore = stageIs(30, 400);
    const second = await drawnView();
    expect([transform(), percent()]).toEqual(["translate(8px, 185px) scale(0.5)", "50%"]);
    // 「适应宽度」是用户自己要的，可以缩到一半以下（到下限 25%）。
    fireEvent.click(screen.getByTestId("diagram-zoom-fit"));
    expect(percent()).toBe("25%");
    const kept = transform();
    second.rerender(<DiagramView text={`${GOOD}\n  B --> C[退款]`} />);
    await waitFor(() => expect(fakeRender.mock.calls.some((call) => String(call[1]).includes("退款"))).toBe(true));
    await waitFor(() => expect(screen.getByTestId("diagram-svg").querySelector("svg")).not.toBeNull());
    expect([transform(), percent()]).toEqual([kept, "25%"]);
    restore();
  });

  it("导出 PNG 不受视图影响：放大、拖动之后导出的仍是画出来的原图（由导出按原始大小的 2 倍画）", async () => {
    const restore = stageIs(600, 400);
    await drawnView();
    fireEvent.click(screen.getByTestId("diagram-zoom-in"));
    fireEvent.click(screen.getByTestId("diagram-zoom-in"));
    fireEvent.pointerDown(screen.getByTestId("diagram-stage"), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(window);
    expect(percent()).toBe("156%");
    fireEvent.click(screen.getByTestId("diagram-export"));
    await waitFor(() => expect(exportPng).toHaveBeenCalledTimes(1));
    // 交给导出的是 mermaid 画出来的那份 SVG，没有带看板里的比例与平移。
    const handed = exportPng.mock.calls[0][0];
    expect(handed).toContain('viewBox="0 0 120 60" width="100%"');
    expect(handed).not.toMatch(/scale\(|translate\(/);
    expect(diagram.sizedSvg(handed)).toMatchObject({ width: 120, height: 60 });
    expect(diagram.pngScale(120, 60)).toBe(2);
    restore();
  });

  it("视图的几样计算：一打开的比例、适应宽度、放大缩小一档、摆进看板、以一点为锚换比例（有上下限）", () => {
    expect([diagram.initialZoom(300, 600), diagram.initialZoom(600, 300), diagram.initialZoom(3000, 300), diagram.initialZoom(300, 0), diagram.initialZoom(400, 300)]).toEqual([1, 0.5, 0.5, 1, 0.75]);
    expect([diagram.fitZoom(3000, 300), diagram.fitZoom(600, 300), diagram.fitZoom(10, 300), diagram.fitZoom(300, 0)]).toEqual([0.25, 0.5, 4, 1]);
    expect([diagram.stepZoom(1, 1), diagram.stepZoom(1, -1), diagram.stepZoom(4, 1), diagram.stepZoom(0.25, -1)]).toEqual([1.25, 0.8, 4, 0.25]);
    expect([diagram.MIN_ZOOM, diagram.MAX_ZOOM]).toEqual([0.25, 4]);
    // 放得下的方向居中，放不下的方向从边上开始；量不到看板时都从边上开始。
    expect(diagram.placed({ width: 200, height: 100 }, { width: 600, height: 400 }, 1)).toEqual({ zoom: 1, x: 200, y: 150 });
    expect(diagram.placed({ width: 2000, height: 100 }, { width: 600, height: 400 }, 0.5)).toEqual({ zoom: 0.5, x: 8, y: 175 });
    expect(diagram.placed({ width: 200, height: 100 }, { width: 0, height: 0 }, 1)).toEqual({ zoom: 1, x: 8, y: 8 });
    // 新的平移 = p − (新比例 / 旧比例) × (p − 旧的平移)。
    expect(diagram.zoomAt({ zoom: 1, x: 100, y: 40 }, 2, 300, 200)).toEqual({ zoom: 2, x: -100, y: -120 });
    const same = { zoom: 4, x: 5, y: 6 };
    expect(diagram.zoomAt(same, 8, 0, 0)).toBe(same);
  });

  it("给了现在不能导出的原因：「导出 PNG」灰掉，悬停显示这句话", async () => {
    render(<DiagramView text={GOOD} exportOff="文本有没保存的改动" />);
    await waitFor(() => expect(screen.getByTestId("diagram-svg").querySelector("svg")).not.toBeNull());
    expect(screen.getByTestId("diagram-export")).toBeDisabled();
    expect(screen.getByTestId("diagram-export").getAttribute("title")).toBe("文本有没保存的改动");
  });
});
