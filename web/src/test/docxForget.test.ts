// Word 材料的缓存在材料被删除或替换之后丢掉（forgetDocx）：下次要显示时重新读；丢掉时还没读完的那一次，读到的旧文件不进缓存。

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { api, ApiError } from "../api/client";
import { docxEntry, forgetDocx, resetDocxStore } from "../state/docxStore";

afterEach(() => { vi.restoreAllMocks(); resetDocxStore(); });

const PATH = "inputs/需求.docx";
const notFound = (message: string) => new ApiError("not_found", message, 404);

describe("forgetDocx", () => {
  it("丢掉之后再取这份材料会重新读；别的材料的缓存不动", async () => {
    const raw = vi.spyOn(api, "materialRaw").mockRejectedValue(notFound("读不到。"));
    vi.spyOn(api, "materialContent").mockResolvedValue({ path: PATH, text: "" });
    docxEntry("T1", PATH);
    docxEntry("T1", "inputs/别的.docx");
    await waitFor(() => expect(docxEntry("T1", PATH).status).toBe("error"));
    await waitFor(() => expect(docxEntry("T1", "inputs/别的.docx").status).toBe("error"));
    expect(raw).toHaveBeenCalledTimes(2);
    forgetDocx("T1", PATH);
    expect(docxEntry("T1", PATH).status).toBe("loading");
    expect(docxEntry("T1", "inputs/别的.docx").status).toBe("error");
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(3));
  });

  it("正在读的时候被丢掉：那一次读到的旧结果不进缓存，缓存里是之后重新读到的", async () => {
    let failOld: (error: unknown) => void = () => {};
    vi.spyOn(api, "materialContent").mockResolvedValue({ path: PATH, text: "" });
    vi.spyOn(api, "materialRaw")
      .mockImplementationOnce(() => new Promise((_, no) => { failOld = no; }))
      .mockRejectedValue(notFound("新文件读不到。"));
    docxEntry("T1", PATH); // 头一次读，还没有回来
    forgetDocx("T1", PATH);
    docxEntry("T1", PATH); // 重新读
    await waitFor(() => expect(docxEntry("T1", PATH).error).toBe("新文件读不到。"));
    failOld(notFound("旧文件读不到。"));
    await new Promise((ok) => setTimeout(ok, 20));
    expect(docxEntry("T1", PATH).error).toBe("新文件读不到。");
  });
});
