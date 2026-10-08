// 图表组件（components/diagram）：文本画成图、画不出来时写明原因、点「导出 PNG」把当前这张图交给导出。
// jsdom 里 mermaid 量不了文字的大小、也没有画布，所以这里把 mermaid 包换成假的（画图）、把导出换成假的（只看交过去的东西）；
// 真的画图与导出在浏览器里另行实测。给 SVG 写宽高、定放大倍数、定文件名这三样不靠浏览器，直接测。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
