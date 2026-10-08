// pdf.js 的字符映射表、标准字体等文件怎样带进页面产物（web/pdfjs_assets.mjs，vite 的构建插件）：
// 带哪些文件、缺了报错、开发服务器上一个地址对应哪个文件。插件文件在 src 之外、是给 Node 用的，这里按它在磁盘上的位置加载
// （测试从 web 目录运行；页面的类型检查里没有 Node 的类型，所以当前目录经 globalThis 取）。

import { describe, expect, it } from "vitest";

type AssetFile = { name: string; file: string };
type Assets = {
  PDFJS_ASSET_BASE: string;
  pdfjsDir: () => string;
  pdfjsAssetFiles: (dir?: string) => AssetFile[];
  pdfjsAssetFor: (url: string, files: AssetFile[]) => AssetFile | null;
  pdfjsAssets: () => { name: string; generateBundle: (this: { emitFile: (file: { type: string; fileName: string; source: Uint8Array }) => void }) => void };
};
const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const load = async (): Promise<Assets> => (await import(/* @vite-ignore */ `file://${cwd}/pdfjs_assets.mjs`)) as Assets;

describe("pdf.js 的资源文件带进页面产物", () => {
  it("带上字符映射表、标准字体、颜色配置的整个目录，解图片用的五个文件与各自的许可证；表单脚本用的那一组不带", async () => {
    const { pdfjsAssetFiles } = await load();
    // 每个文件都放在「版本号/」下面：换了 pdf.js 的版本地址跟着变，浏览器不会拿缓存的旧文件配新的库。
    const all = pdfjsAssetFiles().map((one) => one.name);
    expect(all.every((name) => name.startsWith("6.4.299/"))).toBe(true);
    const names = all.map((name) => name.slice("6.4.299/".length));
    const under = (dir: string) => names.filter((name) => name.startsWith(`${dir}/`));
    expect(names[0]).toBe("LICENSE");
    expect(under("cmaps").length).toBe(169);
    expect(under("cmaps")).toEqual(expect.arrayContaining(["cmaps/UniGB-UCS2-H.bcmap", "cmaps/Adobe-GB1-UCS2.bcmap", "cmaps/LICENSE"]));
    expect(under("standard_fonts").length).toBe(16);
    expect(under("standard_fonts")).toEqual(expect.arrayContaining(["standard_fonts/LiberationSans-Regular.ttf", "standard_fonts/FoxitSerif.pfb", "standard_fonts/LICENSE_FOXIT", "standard_fonts/LICENSE_LIBERATION"]));
    expect(under("iccs")).toEqual(["iccs/CGATS001Compat-v2-micro.icc", "iccs/LICENSE"]);
    expect(under("wasm")).toEqual(["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm", "jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js",
      "LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_QCMS", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_QCMS"].map((name) => `wasm/${name}`));
    expect(names.some((name) => name.includes("quickjs"))).toBe(false);
    expect(new Set(names).size).toBe(names.length);
  });

  it("目录里缺了要带的文件就报错，不悄悄少带", async () => {
    const { pdfjsAssetFiles } = await load();
    expect(() => pdfjsAssetFiles("/没有这个目录")).toThrow();
  });

  it("构建时每个文件原样写进产物的 pdfjs/ 目录", async () => {
    const { pdfjsAssets, pdfjsAssetFiles } = await load();
    const emitted: { type: string; fileName: string; source: Uint8Array }[] = [];
    pdfjsAssets().generateBundle.call({ emitFile: (file) => { emitted.push(file); } });
    expect(emitted.map((one) => one.fileName)).toEqual(pdfjsAssetFiles().map((one) => `pdfjs/${one.name}`));
    expect(emitted.every((one) => one.type === "asset" && one.source.byteLength > 0)).toBe(true);
    const total = emitted.reduce((sum, one) => sum + one.source.byteLength, 0);
    // 合计三兆多：字符映射表约 1.7 MB、标准字体约 0.8 MB、解图片的文件约 1.05 MB。
    expect(total).toBeGreaterThan(3_000_000);
    expect(total).toBeLessThan(4_500_000);
  });

  it("开发服务器上的地址：清单里的文件给得出，清单之外的、往上跳目录的、别的前缀的都不给", async () => {
    const { pdfjsAssetFor, pdfjsAssetFiles } = await load();
    const files = pdfjsAssetFiles();
    expect(pdfjsAssetFor("/pdfjs/6.4.299/cmaps/UniGB-UCS2-H.bcmap", files)?.name).toBe("6.4.299/cmaps/UniGB-UCS2-H.bcmap");
    expect(pdfjsAssetFor("/pdfjs/6.4.299/wasm/openjpeg.wasm?v=1", files)?.file.endsWith("/wasm/openjpeg.wasm")).toBe(true);
    for (const url of ["/pdfjs/6.4.299/wasm/quickjs-eval.wasm", "/pdfjs/6.4.299/../package.json", "/pdfjs/6.4.299/cmaps/%2e%2e/package.json", "/pdfjs/6.4.299/cmaps/",
      "/pdfjs/cmaps/UniGB-UCS2-H.bcmap", "/pdfjs/6.4.298/cmaps/UniGB-UCS2-H.bcmap", "/assets/x.js", "/pdfjs"]) {
      expect(pdfjsAssetFor(url, files), url).toBeNull();
    }
  });
});
