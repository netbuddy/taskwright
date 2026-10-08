// PDF 材料的显示库怎样加载（model/pdf.ts）与位置表、原始字节怎样读取并缓存（state/pdfStore.ts）。
// pdf.js 换成假的（jsdom 里没有画布，也起不了工作线程）；真的显示在浏览器里另行实测。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { api, ApiError } from "../api/client";
import { loadPdfjs, openPdf, pdfAssetUrls } from "../model/pdf";
import { parsePdfLocations, resetPdfStore, usePdfBytes, usePdfLocations } from "../state/pdfStore";

const destroy = vi.fn(async () => {});
const getDocument = vi.fn((_source: Record<string, unknown>): { promise: Promise<unknown>; destroy: () => Promise<void> } => ({ promise: Promise.resolve({ numPages: 3 }), destroy }));
const options = { workerSrc: "" };
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ version: "6.4.299", GlobalWorkerOptions: options, getDocument: (source: Record<string, unknown>) => getDocument(source) }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min-abc.mjs" }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); getDocument.mockClear(); destroy.mockClear(); resetPdfStore(); });

const TABLE = { version: 1, rules_version: 1, 说明: "", source: "inputs/办法.pdf", engine: "pdfjs-dist 6.4.299", producer: "",
  pages: [{ page: 1, width: 595, height: 842, rotate: 0, no_text: false, blocks: [{ block: 1, bbox: [72, 700, 520, 760] }] }],
  headings: [{ page: 1, level: 1, title: "一、总则" }] };

describe("加载 pdf.js 与打开一份 PDF", () => {
  it("第一次用到时加载，告诉它工作线程文件在哪里；再用不重复加载", async () => {
    const first = await loadPdfjs();
    expect(options.workerSrc).toBe("/assets/pdf.worker.min-abc.mjs");
    expect(await loadPdfjs()).toBe(first);
  });

  it("另外要取的几组文件给的是完整地址，放在带版本号的目录下", () => {
    expect(pdfAssetUrls("6.4.299", "http://host:8940/")).toEqual({
      cMapUrl: "http://host:8940/pdfjs/6.4.299/cmaps/", cMapPacked: true, standardFontDataUrl: "http://host:8940/pdfjs/6.4.299/standard_fonts/",
      wasmUrl: "http://host:8940/pdfjs/6.4.299/wasm/", iccUrl: "http://host:8940/pdfjs/6.4.299/iccs/" });
    // 不给根地址时取页面现在的地址：仍然是完整地址。
    expect(pdfAssetUrls("6.4.299").cMapUrl).toBe(new URL("/pdfjs/6.4.299/cmaps/", document.baseURI).href);
    expect(pdfAssetUrls("6.4.299").cMapUrl).toMatch(/^https?:\/\//);
  });

  it("打开时交给 pdf.js 的是字节的副本与那几组文件的地址；缓存里的原始字节原样留着", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45]).buffer;
    const opened = await openPdf(bytes);
    expect(opened.doc).toEqual({ numPages: 3 });
    // 不用了调 close：把这份文件在工作线程里占的东西放掉。
    expect(destroy).not.toHaveBeenCalled();
    opened.close();
    expect(destroy).toHaveBeenCalledTimes(1);
    const source = getDocument.mock.calls[0][0] as { data: Uint8Array; cMapUrl: string; cMapPacked: boolean; standardFontDataUrl: string; wasmUrl: string; iccUrl: string };
    expect([...source.data]).toEqual([37, 80, 68, 70, 45]);
    expect(source.data.buffer).not.toBe(bytes);
    expect(bytes.byteLength).toBe(5);
    expect([source.cMapPacked, source.cMapUrl.endsWith("/pdfjs/6.4.299/cmaps/"), source.standardFontDataUrl.endsWith("/pdfjs/6.4.299/standard_fonts/"),
      source.wasmUrl.endsWith("/pdfjs/6.4.299/wasm/"), source.iccUrl.endsWith("/pdfjs/6.4.299/iccs/")]).toEqual([true, true, true, true, true]);
  });

  it("打不开时把 pdf.js 的错误原样抛出，并把这一次打开占的东西放掉", async () => {
    getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error("Invalid PDF structure.")), destroy });
    await expect(openPdf(new ArrayBuffer(3))).rejects.toThrow("Invalid PDF structure.");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("位置表与原始字节的读取", () => {
  it("位置表按「材料路径加 .locations.json」读一次并缓存；两个地方同时要也只读一次", async () => {
    const content = vi.spyOn(api, "materialContent").mockResolvedValue({ text: JSON.stringify(TABLE) } as Awaited<ReturnType<typeof api.materialContent>>);
    const one = renderHook(() => usePdfLocations("TASK-1", "inputs/办法.pdf"));
    const two = renderHook(() => usePdfLocations("TASK-1", "inputs/办法.pdf"));
    expect(one.result.current).toEqual({ status: "loading", locations: null });
    await waitFor(() => expect(one.result.current?.status).toBe("ready"));
    expect(one.result.current?.locations?.headings).toEqual([{ page: 1, level: 1, title: "一、总则" }]);
    expect(two.result.current).toBe(one.result.current);
    expect(content.mock.calls).toEqual([["TASK-1", "inputs/办法.pdf.locations.json"]]);
    // 没有给任务或路径时不读。
    expect(renderHook(() => usePdfLocations("TASK-1", null)).result.current).toBeNull();
    expect(content).toHaveBeenCalledTimes(1);
  });

  it("位置表读不到、不是合法的位置表：算读完了，位置表为 null", async () => {
    vi.spyOn(api, "materialContent").mockRejectedValueOnce(new ApiError("not_found", "没有这个文件。", 404)).mockResolvedValueOnce({ text: "{\"pages\": 3}" } as Awaited<ReturnType<typeof api.materialContent>>);
    const missing = renderHook(() => usePdfLocations("TASK-1", "inputs/甲.pdf"));
    const broken = renderHook(() => usePdfLocations("TASK-1", "inputs/乙.pdf"));
    await waitFor(() => expect([missing.result.current?.status, broken.result.current?.status]).toEqual(["ready", "ready"]));
    expect([missing.result.current?.locations, broken.result.current?.locations]).toEqual([null, null]);
    expect([parsePdfLocations("不是 JSON"), parsePdfLocations("null"), parsePdfLocations("{\"pages\": [], \"headings\": []}")]).toEqual([null, null, { pages: [], headings: [] }]);
  });

  it("原始字节读一次并缓存；不同的任务、不同的材料各读各的；读不到时记下任务服务给的说明", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const raw = vi.spyOn(api, "materialRaw").mockImplementation(async (_task, path) => {
      if (path.includes("坏")) throw new ApiError("not_found", "材料目录里没有这份文件。", 404);
      return data;
    });
    const good = renderHook(() => usePdfBytes("TASK-1", "inputs/办法.pdf"));
    const again = renderHook(() => usePdfBytes("TASK-1", "inputs/办法.pdf"));
    const other = renderHook(() => usePdfBytes("TASK-2", "inputs/办法.pdf"));
    const bad = renderHook(() => usePdfBytes("TASK-1", "inputs/坏.pdf"));
    expect(good.result.current).toEqual({ status: "loading" });
    await waitFor(() => expect([good.result.current?.status, other.result.current?.status, bad.result.current?.status]).toEqual(["ready", "ready", "error"]));
    expect(good.result.current?.bytes).toBe(data);
    expect(again.result.current).toBe(good.result.current);
    expect(bad.result.current).toEqual({ status: "error", error: "材料目录里没有这份文件。" });
    expect(raw.mock.calls).toEqual([["TASK-1", "inputs/办法.pdf"], ["TASK-2", "inputs/办法.pdf"], ["TASK-1", "inputs/坏.pdf"]]);
  });
});
