// PDF 材料被删除或替换之后，先前读过的位置表、原始字节与投影不作数了（state/pdfStore.ts 的 forgetPdf）：
// 丢掉之后再要就重新读；读到一半被丢掉的，读回来的旧结果不写进缓存。工作视图收到材料被删、新增的事件时丢。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import type { StreamHandlers } from "../api/events";
import { forgetPdf, pdfBytesEntry, pdfLocationsEntry, pdfUnitsEntry, resetPdfStore, usePdfBytes } from "../state/pdfStore";
import { useWorkView } from "../state/useWorkView";

let handlers: StreamHandlers | null = null;
vi.mock("../api/events", () => ({
  openEventStream: (_url: string, _last: () => number | null, h: StreamHandlers) => { handlers = h; return () => {}; },
}));

const PATH = "inputs/办法.pdf";
const table = (title: string) => JSON.stringify({ version: 1, pages: [], headings: [{ page: 1, level: 1, title }] });
type Content = Awaited<ReturnType<typeof api.materialContent>>;

afterEach(() => { cleanup(); vi.restoreAllMocks(); resetPdfStore(); handlers = null; });

describe("丢掉一份 PDF 材料的缓存", () => {
  it("丢掉之后三样都重新读，读到的是新文件；别的材料、别的任务的缓存不动", async () => {
    let version = "旧";
    const content = vi.spyOn(api, "materialContent").mockImplementation(async (_task, path) =>
      ({ text: path.endsWith(".locations.json") ? table(`${version}的目录`) : `[p1-1] ${version}的正文` }) as Content);
    const raw = vi.spyOn(api, "materialRaw").mockImplementation(async () => new TextEncoder().encode(version).buffer as ArrayBuffer);
    pdfLocationsEntry("TASK-1", PATH); pdfUnitsEntry("TASK-1", PATH); pdfBytesEntry("TASK-1", PATH);
    pdfBytesEntry("TASK-1", "inputs/别的.pdf"); pdfBytesEntry("TASK-2", PATH);
    await waitFor(() => expect(pdfUnitsEntry("TASK-1", PATH).status).toBe("ready"));
    await waitFor(() => expect(pdfBytesEntry("TASK-2", PATH).status).toBe("ready"));
    expect(pdfLocationsEntry("TASK-1", PATH).locations?.headings[0].title).toBe("旧的目录");
    const other = pdfBytesEntry("TASK-1", "inputs/别的.pdf");
    const elsewhere = pdfBytesEntry("TASK-2", PATH);
    expect([content.mock.calls.length, raw.mock.calls.length]).toEqual([2, 3]);

    version = "新";
    forgetPdf("TASK-1", PATH);
    expect(pdfLocationsEntry("TASK-1", PATH).status).toBe("loading");
    expect(pdfUnitsEntry("TASK-1", PATH).status).toBe("loading");
    expect(pdfBytesEntry("TASK-1", PATH).status).toBe("loading");
    await waitFor(() => expect(pdfUnitsEntry("TASK-1", PATH).status).toBe("ready"));
    await waitFor(() => expect(pdfBytesEntry("TASK-1", PATH).status).toBe("ready"));
    expect(pdfLocationsEntry("TASK-1", PATH).locations?.headings[0].title).toBe("新的目录");
    expect(pdfUnitsEntry("TASK-1", PATH).units?.[0].text).toBe("新的正文");
    expect(new TextDecoder().decode(pdfBytesEntry("TASK-1", PATH).bytes)).toBe("新");
    expect(pdfBytesEntry("TASK-1", "inputs/别的.pdf")).toBe(other);
    expect(pdfBytesEntry("TASK-2", PATH)).toBe(elsewhere);
    expect([content.mock.calls.length, raw.mock.calls.length]).toEqual([4, 4]);
  });

  it("读到一半被丢掉：读回来的旧文件不写进缓存，也不顶掉后来重新读到的新文件", async () => {
    const pending: ((bytes: ArrayBuffer) => void)[] = [];
    vi.spyOn(api, "materialRaw").mockImplementation(() => new Promise((ok) => { pending.push(ok); }));
    const view = renderHook(() => usePdfBytes("TASK-1", PATH));
    expect(view.result.current?.status).toBe("loading");
    forgetPdf("TASK-1", PATH);
    // 旧的那一次读回来了：缓存里没有它的位置，丢弃。
    await act(async () => { pending[0](new TextEncoder().encode("旧").buffer as ArrayBuffer); });
    view.rerender();
    expect(pending.length).toBe(2);
    expect(view.result.current?.status).toBe("loading");
    await act(async () => { pending[1](new TextEncoder().encode("新").buffer as ArrayBuffer); });
    await waitFor(() => expect(view.result.current?.status).toBe("ready"));
    expect(new TextDecoder().decode(view.result.current?.bytes)).toBe("新");
  });
});

describe("工作视图收到材料的事件时丢缓存", () => {
  const cached = async () => {
    vi.spyOn(api, "materialRaw").mockResolvedValue(new ArrayBuffer(4));
    const first = pdfBytesEntry("TASK-1", PATH);
    await waitFor(() => expect(pdfBytesEntry("TASK-1", PATH).status).toBe("ready"));
    expect(first.status).toBe("loading");
    return pdfBytesEntry("TASK-1", PATH);
  };
  const emit = (event: string, data: unknown) => act(async () => { handlers!.onMessage({ event, data } as Parameters<StreamHandlers["onMessage"]>[0]); });

  it("材料被删掉（material_removed）：丢掉那一份；事件里带着替换成的新文件时，新文件那一份也丢", async () => {
    const before = await cached();
    renderHook(() => useWorkView("TASK-1", "S-1"));
    await emit("problem", { session_id: null, at: "", path: PATH });
    expect(pdfBytesEntry("TASK-1", PATH)).toBe(before);
    await emit("material_removed", { session_id: null, at: "", path: "inputs/旧名.pdf", replaced_by: PATH });
    expect(pdfBytesEntry("TASK-1", PATH)).not.toBe(before);
    const again = pdfBytesEntry("TASK-1", PATH);
    await emit("material_removed", { session_id: null, at: "", path: PATH });
    expect(pdfBytesEntry("TASK-1", PATH)).not.toBe(again);
  });

  it("新来了一份材料（material_added）：同一个路径上先前读过的那一份丢掉；它替换掉的那一份也丢", async () => {
    const before = await cached();
    renderHook(() => useWorkView("TASK-1", "S-1"));
    await emit("material_added", { session_id: null, at: "", path: "inputs/新名.pdf", bytes: 1, modified_at: "", replaces: PATH });
    expect(pdfBytesEntry("TASK-1", PATH)).not.toBe(before);
    const again = pdfBytesEntry("TASK-1", PATH);
    await emit("material_added", { session_id: null, at: "", path: PATH, bytes: 1, modified_at: "" });
    expect(pdfBytesEntry("TASK-1", PATH)).not.toBe(again);
  });
});
