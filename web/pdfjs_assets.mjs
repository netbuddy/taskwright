// 把 pdf.js 显示 PDF 时要另外取的几组文件带进页面产物：字符映射表（cmaps）、标准字体（standard_fonts）、
// 颜色配置（iccs）与解图片用的几个文件（wasm）。它们不是代码，vite 不会自己带上；页面把它们放在「pdfjs/」目录下，
// pdf.js 按地址去取（web/src/components/pdf/pdfjs.ts）。
//
// 少了会怎样：没有字符映射表，不嵌入字体的中文 PDF 显示不出字，而且页面不报错；没有标准字体，没有嵌入字体的西文显示不对；
// 没有解图片的文件，用 JBIG2 或 JPEG 2000 压缩的图片（扫描件常用）画不出来。
//
// 构建时把这些文件原样写进产物的「pdfjs/版本号/」目录，开发服务器上把这个前缀的请求指到 node_modules 里的同一批文件。
// 目录名里带 pdf.js 的版本号：这些文件的名字里没有内容摘要，浏览器会照常缓存；换了 pdf.js 的版本，地址跟着变，
// 就不会拿旧版本的文件配新版本的库。页面按它加载到的库的版本号拼同一个地址。
// 只带清单里列出的文件：wasm 目录里给表单脚本用的那一组（quickjs）页面用不到，不带。各组自带的许可证文件一并带上，
// pdf.js 自己的许可证放在这个目录下的 LICENSE。

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** 这些文件在页面产物里放在哪个目录下（也是开发服务器上的地址前缀）；它下面还有一层版本号。 */
export const PDFJS_ASSET_BASE = "pdfjs";
/** 整个目录都带的三组。 */
export const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts", "iccs"];
/** wasm 目录里要带的：解 JBIG2、JPEG 2000 图片与换算颜色的三个文件，浏览器不支持时的两个替代脚本，以及它们的许可证。 */
export const PDFJS_WASM_FILES = [
  "jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm", "jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js",
  "LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_QCMS", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_QCMS",
];

const TYPES = { ".wasm": "application/wasm", ".js": "text/javascript; charset=utf-8" };

/** 装着 pdfjs-dist 的目录。 */
export function pdfjsDir() {
  return path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
}

/** 装着的 pdfjs-dist 的版本号。 */
export function pdfjsVersion(dir = pdfjsDir()) {
  return String(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version);
}

/**
 * 要带的全部文件：name 是它在 pdfjs/ 目录下的相对路径（以版本号开头），file 是它在磁盘上的位置。
 * 缺了任何一个就报错，不悄悄少带。
 */
export function pdfjsAssetFiles(dir = pdfjsDir()) {
  const version = pdfjsVersion(dir);
  const out = [{ name: `${version}/LICENSE`, file: path.join(dir, "LICENSE") }];
  for (const sub of PDFJS_ASSET_DIRS) {
    for (const name of fs.readdirSync(path.join(dir, sub)).sort()) out.push({ name: `${version}/${sub}/${name}`, file: path.join(dir, sub, name) });
  }
  for (const name of PDFJS_WASM_FILES) out.push({ name: `${version}/wasm/${name}`, file: path.join(dir, "wasm", name) });
  for (const one of out) if (!fs.statSync(one.file, { throwIfNoEntry: false })?.isFile()) throw new Error(`pdfjs-dist 里没有 ${one.name}（${one.file}）`);
  return out;
}

/** 开发服务器上一个请求地址对应的文件；不是清单里的文件时为 null（不按路径去拼，所以不会读到清单之外的文件）。 */
export function pdfjsAssetFor(url, files) {
  const pathname = decodeURIComponent(String(url).split(/[?#]/)[0]);
  const prefix = `/${PDFJS_ASSET_BASE}/`;
  if (!pathname.startsWith(prefix)) return null;
  return files.find((one) => one.name === pathname.slice(prefix.length)) ?? null;
}

/** vite 插件：构建时把文件写进产物，开发时提供同样的地址。 */
export function pdfjsAssets() {
  let files = null;
  const all = () => (files ??= pdfjsAssetFiles());
  return {
    name: "taskwright-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(`/${PDFJS_ASSET_BASE}/`)) return next();
        const hit = pdfjsAssetFor(req.url, all());
        if (!hit) { res.statusCode = 404; res.end("没有这个文件"); return; }
        res.setHeader("Content-Type", TYPES[path.extname(hit.name)] ?? "application/octet-stream");
        fs.createReadStream(hit.file).pipe(res);
      });
    },
    generateBundle() {
      for (const one of all()) this.emitFile({ type: "asset", fileName: `${PDFJS_ASSET_BASE}/${one.name}`, source: fs.readFileSync(one.file) });
    },
  };
}
