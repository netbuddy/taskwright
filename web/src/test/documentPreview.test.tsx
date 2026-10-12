// 生成文档的预览：照分块结果排版——标题、段落、列表、表格、引用各是相应的元素；图当场画出来，画不出来时写明原因并显示文本。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DocumentPreview } from "../components/DocumentPreview";
import { blobBase64, figurePngs } from "../components/diagram/mermaid";

const fakeRender = vi.fn(async (id: string, text: string) => {
  if (text.includes("坏的")) throw new Error("Parse error on line 2");
  return { svg: `<svg id="${id}" viewBox="0 0 320 120" style="max-width: 320px;"><text>${text.split("\n")[0]}</text></svg>` };
});
vi.mock("mermaid", () => ({ default: { initialize: () => {}, render: (id: string, text: string) => fakeRender(id, text) } }));

afterEach(cleanup);

const DOC = [
  "# 图书馆借阅 软件需求规格说明", "", "> 本文档按交付物的修订 6 生成。", "",
  "## 目录", "", "- 1 概述与范围", "  - 1.1 本期范围", "- 2 角色", "",
  "## 2 角色", "", "有读者与馆员两种角色。 ［修订 6 · 未确认］", "",
  "**角色与用例对照**", "", "| 用例 | 读者 | 所属流程 |", "|---|---|---|", "| 自助借书 | 发起 | 3.1 自助借书 |", "",
  "### 3.1 自助借书 ［修订 2 · 已确认（已读）］", "", "**流程步骤**（D-004 自助借书的流程）", "",
  "```mermaid D-004", "flowchart TD", "  a --> b", "```", "",
  "**适用规则**", "", "1. 学生一次最多借 5 本。", "2. 【待定】待定：能不能借", "",
  "```mermaid D-009", "坏的", "```", "",
].join("\n");

describe("生成文档的预览", () => {
  it("标题、引用、列表、表格照排版显示，文字里看不到井号、竖线与星号", async () => {
    render(<DocumentPreview text={DOC} />);
    const view = screen.getByTestId("doc-preview");
    expect([...view.querySelectorAll("h1, h2, h3")].map((h) => `${h.tagName} ${h.textContent}`)).toEqual([
      "H1 图书馆借阅 软件需求规格说明", "H2 目录", "H2 2 角色", "H3 3.1 自助借书 ［修订 2 · 已确认（已读）］"]);
    expect(view.querySelector("blockquote")).toHaveTextContent("本文档按交付物的修订 6 生成。");
    // 目录：两层，下一层往里缩。
    const toc = view.querySelector("ul")!;
    expect([...toc.querySelectorAll("li")].map((li) => [li.textContent, li.style.marginLeft])).toEqual([["1 概述与范围", ""], ["1.1 本期范围", "1.4rem"], ["2 角色", ""]]);
    // 表格。
    expect([...view.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["用例", "读者", "所属流程"]);
    expect([...view.querySelectorAll("tbody td")].map((td) => td.textContent)).toEqual(["自助借书", "发起", "3.1 自助借书"]);
    // 有序列表与加粗。
    expect([...view.querySelector("ol")!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["学生一次最多借 5 本。", "【待定】待定：能不能借"]);
    expect([...view.querySelectorAll("p b")].map((b) => b.textContent)).toEqual(["角色与用例对照", "流程步骤", "适用规则"]);
    // 两张图的代码块不算在内时，文字里没有 Markdown 的记号。
    const words = [...view.querySelectorAll("h1, h2, h3, p, li, th, td, blockquote")].map((one) => one.textContent).join("\n");
    expect(words).not.toMatch(/^#|\*\*|^\|/m);
    await screen.findByTestId("doc-figure-D-004");
  });

  it("图当场画出来；画不出来的写明原因并显示它的文本，别的块照常", async () => {
    render(<DocumentPreview text={DOC} />);
    const drawn = screen.getByTestId("doc-figure-D-004");
    await vi.waitFor(() => expect(drawn).toHaveAttribute("data-drawn", "true"));
    const svg = drawn.querySelector("svg")!;
    expect(svg).toHaveTextContent("flowchart TD");
    // 写上了明确的宽高，mermaid 自己写的最大宽度去掉了，由样式限制不超过预览区。
    expect([svg.getAttribute("width"), svg.getAttribute("height"), svg.getAttribute("style")]).toEqual(["320", "120", null]);
    const bad = await screen.findByTestId("doc-figure-D-009");
    await vi.waitFor(() => expect(bad).toHaveClass("bad"));
    expect(bad).toHaveTextContent("这张图没有画出来：Parse error on line 2");
    expect(bad.querySelector("pre")).toHaveTextContent("坏的");
  });

  it("空文档没有块；换了文字就照新的排", () => {
    const view = render(<DocumentPreview text="" />);
    expect(screen.getByTestId("doc-preview").children).toHaveLength(0);
    view.rerender(<DocumentPreview text={"## 甲\n\n一段话。"} />);
    expect(screen.getByTestId("doc-preview").querySelector("h2")).toHaveTextContent("甲");
  });
});

describe("把文档里的图转成图片交给任务服务", () => {
  it("二进制数据写成 base64，长的也对", async () => {
    expect(await blobBase64(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]))).toBe("iVBORw==");
    const long = new Uint8Array(100_000).map((_, n) => n % 251);
    const text = await blobBase64(new Blob([long]));
    expect(Uint8Array.from(atob(text), (c) => c.charCodeAt(0))).toEqual(long);
  });

  it("画不出来的那一张不在结果里，不影响别的；一张都没有时是空的", async () => {
    // 画不出 SVG 的图只是跳过，不抛错。（把 SVG 转成 PNG 要真的浏览器画布，这里测不了，在浏览器走查里看。）
    expect(await figurePngs([{ diagram_id: "D-009", mermaid: "坏的" }, { diagram_id: "D-010", mermaid: "也是坏的" }])).toEqual([]);
    expect(await figurePngs([])).toEqual([]);
  });
});

