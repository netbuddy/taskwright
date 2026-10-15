// 工作台「文档与版本」页签：生成文档与发布第 N 版两个按钮（发布不能点时说明为什么）、文档的编排一句、预览与两种下载、追溯一句。
// 版本表另在 versions.test.tsx 里测。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "../api/types";
import { api } from "../api/client";
import { DOCS_LEAD, DocsTab } from "../components/work/DocsTab";
import * as download from "../model/download";
import { arrangementLine, differenceLine, publishOff, traceLine } from "../model/docsPage";
import { change, overallTask } from "./fixtures/overallTask";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const met = (all: boolean) => ({ all_met: all, unmet_count: all ? 0 : 1, hints: [], conditions: [
  { collection: "功能用例", name: "a", met: true, state: "met", done: 0, total: 0, missing: [], note: "" },
  { collection: "功能用例", name: "b", met: all, state: all ? "met" : "unmet", done: 0, total: 0, missing: [], note: "" }] });
const ready = (over: Partial<Task> = {}) => overallTask({ completion: met(true), ...over } as unknown as Partial<Task>);
function tab(t: Task, props: Partial<Parameters<typeof DocsTab>[0]> = {}) {
  const calls = { generate: vi.fn(), publish: vi.fn(), revision: vi.fn() };
  render(<div className="app"><DocsTab task={t} readOnly={false} writesOff={false} onGenerate={calls.generate} onPublish={calls.publish} onShowRevision={calls.revision} {...props} /></div>);
  return calls;
}

describe("「文档与版本」页签", () => {
  it("页头两个按钮：「生成文档」打开对话框；「发布第 N 版」条件满足时可点，点了打开发布框；页上一句说明", () => {
    const calls = tab(ready());
    expect(screen.getByTestId("docs-tab")).toHaveTextContent(DOCS_LEAD);
    fireEvent.click(screen.getByTestId("docs-generate"));
    expect(screen.getByTestId("docs-publish")).toHaveTextContent("发布第 1 版");
    expect(screen.getByTestId("docs-publish")).toBeEnabled();
    fireEvent.click(screen.getByTestId("docs-publish"));
    expect([calls.generate.mock.calls.length, calls.publish.mock.calls.length]).toEqual([1, 1]);
  });

  it("发布不能点时灰着，悬停说明：完成条件没满足（满足几条）、与最近一版相同、助手在工作、助手不可用；没有发布这一样时不显示按钮", () => {
    expect(publishOff(overallTask({ completion: met(false) } as unknown as Partial<Task>), { readOnly: false, writesOff: false }))
      .toBe("完成条件还没有全部满足（现在满足 1 / 2 条，点上方汇总行可看各条）。");
    const same = ready({ versions: [{ version_no: 1, revision_no: 12, published_at: "", actor: "user", note: null, has_markdown: true, has_docx: true }] } as unknown as Partial<Task>);
    expect(publishOff(same, { readOnly: false, writesOff: false })).toBe("当前资产与第 1 版相同，没有可发布的改动。");
    expect(publishOff(ready(), { readOnly: false, writesOff: true })).toBe("助手正在工作，等它做完这一轮再发布。");
    expect(publishOff(ready(), { readOnly: true, writesOff: false })).toBe("助手现在不可用，不能发布。");
    tab(same);
    expect(screen.getByTestId("docs-publish")).toBeDisabled();
    expect(screen.getByTestId("docs-publish")).toHaveAttribute("title", "当前资产与第 1 版相同，没有可发布的改动。");
    expect(differenceLine(same)).toBe("当前资产与第 1 版相同。");
    cleanup();
    tab(ready(), { onPublish: undefined, publishError: "交付物在确认之后又改了。" });
    expect(screen.queryByTestId("docs-publish")).toBeNull();
    expect(screen.getByTestId("docs-publish-error")).toHaveTextContent("交付物在确认之后又改了。");
  });

  it("文档一块：编排一句（前七章照页面目录的章名，其后各集合各一章，最后追溯附录）；预览在页里展开最新修订的文档，再点收起；下载 Markdown 取最新修订", async () => {
    const t = ready();
    expect(arrangementLine(t)).toBe("按章编排：前七章是业务说明（1 概述与范围、2 角色、3 业务流程、4 业务对象、5 业务规则、6 业务目标、7 决策记录与待澄清事项）；其后是功能用例、问题各一章；最后是追溯附录。");
    const preview = vi.spyOn(api, "previewDocument").mockResolvedValue({ text: "# 图书馆借阅系统 软件需求规格说明\n\n正文。" });
    const blob = new Blob(["md"]);
    const fetched = vi.spyOn(api, "downloadDocument").mockResolvedValue(blob);
    const saved = vi.spyOn(download, "saveBlob").mockImplementation(() => {});
    tab(t);
    expect(screen.getByTestId("docs-arrangement")).toHaveTextContent("按章编排：前七章是业务说明");
    fireEvent.click(screen.getByTestId("docs-preview"));
    expect(await screen.findByTestId("docs-preview-body")).toHaveTextContent("正文。");
    expect(preview).toHaveBeenCalledWith("TASK-001", {});
    expect(screen.getByTestId("docs-preview")).toHaveTextContent("收起预览");
    fireEvent.click(screen.getByTestId("docs-preview"));
    expect(screen.queryByTestId("docs-preview-body")).toBeNull();
    fireEvent.click(screen.getByTestId("docs-download-md"));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(blob, "图书馆借阅系统-修订12.md"));
    expect(fetched).toHaveBeenCalledWith("TASK-001", {});
  });

  it("追溯一句：需求条目（问题条目不算）里几条可追溯到业务说明的节或图，例外点名；依据的节上挂着未解决的待澄清问题的另注一句", () => {
    const t = ready();
    const line = traceLine(t);
    expect(line).toMatch(/^3 条需求条目中 \d 条可追溯到业务说明的节或图/);
    change(t, "UC-001", (item) => { item.sources = []; });
    expect(traceLine(t)).toContain("例外：UC-001");
    tab(t);
    expect(screen.getByTestId("docs-trace")).toHaveTextContent("例外：UC-001");
  });
});
