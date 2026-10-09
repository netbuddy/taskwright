// 页面用的是 pdf.js 的 legacy 构建（model/pdf.ts）：浏览器没有 Map.prototype.getOrInsertComputed 这类很新的方法时也要能画。
// 标准构建直接调用这些方法，在没有它们的浏览器里一页也画不出来（报 getOrInsertComputed is not a function）。
// 这里把这几个方法从运行环境里删掉，再用页面自己的加载函数加载真的 pdf.js，打开一份一页的 PDF，走一遍画一页之前
// 必经的两步（取这一页、取可选内容的配置——出错的正是这一步）并读出文字。画布上的绘制 jsdom 里做不了，在浏览器里另行核对。

import { expect, it } from "vitest";
import { loadPdfjs } from "../model/pdf";

/** 一份最小的 PDF：一页，上面一行字。 */
function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const NEW_METHODS = ["getOrInsert", "getOrInsertComputed"] as const;
type Upsert = Record<(typeof NEW_METHODS)[number], unknown>;

it("运行环境没有 getOrInsert、getOrInsertComputed 时，页面加载到的 pdf.js 自己补上它们，照样能打开文件、取到一页与它的可选内容配置", async () => {
  const upsert = () => NEW_METHODS.map((name) => typeof (Map.prototype as unknown as Upsert)[name]);
  const strip = () => { for (const proto of [Map.prototype, WeakMap.prototype] as unknown as Upsert[]) for (const name of NEW_METHODS) delete proto[name]; };
  strip();
  expect(upsert()).toEqual(["undefined", "undefined"]);

  // 解析库（浏览器里它跑在后台线程，那里的方法要靠它自己补）：加载之后这两个方法有了。
  // @ts-expect-error pdfjs-dist 没有给这个文件写类型声明
  const worker: unknown = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  expect(upsert()).toEqual(["function", "function"]);

  // 再删一遍，轮到主库（跑在页面里）：用页面自己的加载函数加载，之后这两个方法也有了。
  strip();
  const lib = await loadPdfjs();
  expect(upsert()).toEqual(["function", "function"]);
  // 工作线程文件也是 legacy 的那一份。
  expect(String(lib.GlobalWorkerOptions.workerSrc)).toMatch(/legacy\/build\/pdf\.worker\.min/);
  // jsdom 里起不了后台线程：把解析库直接交给 pdf.js，让它在同一个线程里跑（pdf.js 自己的做法）。
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;

  const task = lib.getDocument({ data: tinyPdf("Hello PDF"), useSystemFonts: false, disableFontFace: true });
  try {
    const doc = await task.promise;
    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1);
    expect(page.getViewport({ scale: 1 }).width).toBe(595);
    // 画一页时 pdf.js 先取可选内容的配置；标准构建在没有 getOrInsertComputed 的环境里就倒在这一步。
    expect(await doc.getOptionalContentConfig({ intent: "display" })).toBeTruthy();
    const content = await page.getTextContent();
    expect(content.items.map((item) => ("str" in item ? item.str : "")).join("")).toBe("Hello PDF");
  } finally {
    await task.destroy();
  }
});
