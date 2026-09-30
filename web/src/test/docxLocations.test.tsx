// 位置表（后端上传时写的「文件名.docx.locations.json」，格式与章节查法在 agent 的 lib/docx_locations.ts）与页面：
// 1. 分页标记的个数：位置表的 page_marks 与页面在排版库解析树上数出的 marks 相同（全部样例）；
// 2. 来源标签的章节查位置表：非十进制编号的标题在标签上带编号（例如「一.1 章下的一节」）；
//    位置表的标题与投影的标题行是否逐段相同，在 agent/tests/docx_locations.test.ts 里核对（两者出自同一个函数）。
// 位置表夹具由 agent/tests/fixtures/build_location_docx.mts 生成并存在 fixtures/ 下，agent 的测试核对存着的与现算的相同。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import type { LocationFile } from "../../../agent/src/lib/docx_locations";
import { SourceBox } from "../components/work/ItemDetail";
import { renderDocx, tableOf, type DocxTable } from "../model/docx";
import { resetDocxStore, TaskIdContext } from "../state/docxStore";
import SAMPLE from "../../../examples/library-lending/requirements-styled.docx?inline";
import BY_NAME from "./fixtures/headings-by-name.docx?inline";
import INHERITED from "./fixtures/headings-inherited.docx?inline";
import BODY_LEVEL from "./fixtures/headings-body-level.docx?inline";
import NUMBERING from "./fixtures/loc-numbering.docx?inline";
import STYLE_NO_LEVEL from "./fixtures/loc-style-no-level.docx?inline";
import HIDDEN from "./fixtures/loc-hidden.docx?inline";
import SAMPLE_TABLE from "./fixtures/requirements-styled.docx.locations.json";
import BY_NAME_TABLE from "./fixtures/headings-by-name.docx.locations.json";
import INHERITED_TABLE from "./fixtures/headings-inherited.docx.locations.json";
import BODY_LEVEL_TABLE from "./fixtures/headings-body-level.docx.locations.json";
import NUMBERING_TABLE from "./fixtures/loc-numbering.docx.locations.json";
import NUMBERING_TABLE_TEXT from "./fixtures/loc-numbering.docx.locations.json?raw";
import STYLE_NO_LEVEL_TABLE from "./fixtures/loc-style-no-level.docx.locations.json";
import HIDDEN_TABLE from "./fixtures/loc-hidden.docx.locations.json";

const bytesOf = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const SLOW = { timeout: 30_000 };

afterEach(() => { cleanup(); document.body.innerHTML = ""; resetDocxStore(); vi.restoreAllMocks(); });

async function pageTable(url: string): Promise<DocxTable> {
  const host = document.createElement("div");
  document.body.append(host);
  return tableOf(await renderDocx(bytesOf(url), host));
}

describe("分页标记的个数：位置表与页面相同", () => {
  const cases: [string, string, LocationFile][] = [
    ["主样例 requirements-styled.docx", SAMPLE, SAMPLE_TABLE as LocationFile],
    ["headings-by-name.docx", BY_NAME, BY_NAME_TABLE as LocationFile],
    ["headings-inherited.docx", INHERITED, INHERITED_TABLE as LocationFile],
    ["headings-body-level.docx", BODY_LEVEL, BODY_LEVEL_TABLE as LocationFile],
    ["loc-numbering.docx", NUMBERING, NUMBERING_TABLE as LocationFile],
    ["loc-style-no-level.docx", STYLE_NO_LEVEL, STYLE_NO_LEVEL_TABLE as LocationFile],
    ["loc-hidden.docx", HIDDEN, HIDDEN_TABLE as LocationFile],
  ];
  for (const [name, url, table] of cases) {
    it(name, SLOW, async () => {
      expect(table.page_marks).toBe((await pageTable(url)).marks);
    });
  }
});

describe("来源出处的章节查位置表", () => {
  it("非十进制编号的标题在出处里带编号：中文数字一章下的一节写成「一.1 章下的一节」", SLOW, async () => {
    const path = "inputs/loc-numbering.docx";
    vi.spyOn(api, "materialRaw").mockResolvedValue(bytesOf(NUMBERING).slice().buffer);
    vi.spyOn(api, "materialContent").mockImplementation(async (_t, p) => ({ path: p, text: p.endsWith(".locations.json") ? NUMBERING_TABLE_TEXT : "" }));
    render(
      <TaskIdContext.Provider value="TASK-N">
        <SourceBox source={{ kind: "文档原文", locator: `${path}#p7`, excerpt: "章下一节的正文。" }} />
      </TaskIdContext.Provider>,
    );
    // 这份样例没有分页标记，不写页码。
    await waitFor(() => expect(screen.getByRole("button").textContent).toMatch(/^出处：loc-numbering\.docx · 一\.1 章下的一节 · 页[上中下]（点一下看原文）$/), SLOW);
  });
});
