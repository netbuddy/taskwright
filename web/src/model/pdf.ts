// PDF 材料的显示库 pdf.js：用到时才加载，打开一份 PDF。
//
// pdf.js 很大（主库四百多 KB，解析用的工作线程文件一兆多），所以第一次显示 PDF 材料时才加载（import()），
// 构建时它们各成单独的文件，不进页面一打开就要取的那个脚本。工作线程（web worker，浏览器里的后台线程）的文件
// 用 vite 的 ?url 导入：得到的只是它在产物里的地址（一个字符串），交给 pdf.js 去起线程，文件本身到那时才取。
// 这个地址要在文件开头静态导入：写成 import() 时，开发服务器给的是文件本身而不是地址，pdf.js 会报工作线程的地址不对。
//
// 字符映射表、标准字体、颜色配置与解图片用的文件不是代码，由构建插件带进产物的「pdfjs/版本号/」目录（web/pdfjs_assets.mjs）。
// 交给 pdf.js 的必须是完整地址：写成相对地址时，工作线程会按它自己所在的目录去找，取不到；取不到字符映射表时
// 不嵌入字体的中文显示不出字，而且页面不报错。地址里的版本号取自加载到的库，所以库与这些文件总是同一个版本。
//
// 主库与工作线程文件都用 pdfjs-dist 的 legacy 构建（给旧一些的浏览器用的那一套，任务服务用的也是它）。标准构建直接调用
// 很新的方法（例如 Map.prototype.getOrInsertComputed），没有这些方法的浏览器里一页也画不出来；legacy 构建自带这些方法的
// 替代实现，浏览器自己有就用浏览器的。两个文件必须同是 legacy：主库跑在页面里，工作线程文件跑在后台线程里，各补各的。

import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

type Pdfjs = typeof import("pdfjs-dist");

let loading: Promise<Pdfjs> | null = null;

/** 第一次用到时加载 pdf.js 并告诉它工作线程文件在哪里；没有加载成时下一次再试。 */
export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  });
  loading.catch(() => { loading = null; });
  return loading;
}

/**
 * pdf.js 另外要取的几组文件的地址，都是完整地址。version 是 pdf.js 的版本号；base 是页面的根地址，
 * 不给时取页面现在的地址加构建时定的根路径。
 */
export function pdfAssetUrls(version: string, base: string = new URL(import.meta.env.BASE_URL, document.baseURI).href) {
  const root = new URL(`pdfjs/${version}/`, base).href;
  return { cMapUrl: `${root}cmaps/`, cMapPacked: true, standardFontDataUrl: `${root}standard_fonts/`, wasmUrl: `${root}wasm/`, iccUrl: `${root}iccs/` };
}

/** 打开了的一份 PDF：doc 是 pdf.js 的文件对象；不用了要调 close，把它在工作线程里占的东西放掉。 */
export interface OpenedPdf { doc: PDFDocumentProxy; close: () => void }

/**
 * 打开一份 PDF。bytes 是文件的原始字节；交给 pdf.js 的是它的一份副本（pdf.js 会把收到的字节转交给工作线程，
 * 转交之后原来那一份就空了，而原始字节在缓存里还要再用）。打不开时抛出错误，message 是 pdf.js 的原话。
 */
export async function openPdf(bytes: ArrayBuffer): Promise<OpenedPdf> {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)), ...pdfAssetUrls(lib.version) });
  try {
    return { doc: await task.promise, close: () => { void task.destroy(); } };
  } catch (error) {
    void task.destroy();
    throw error;
  }
}
