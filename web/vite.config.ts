// 开发服务器与测试的配置。
//
// 端口与后端地址都由环境变量给，代码里不写死：
//   TASKWRIGHT_WEB_PORT      开发服务器端口，缺省 5680。
//   TASKWRIGHT_API_TARGET    后端地址，/api 开头的请求代理到这里；缺省是本机的任务服务（http://127.0.0.1:8790，与 scripts/dev.sh
//                            起后端时的缺省端口相同）。后端没有起来时，页面显示连不上服务的提示。
// 服务绑 0.0.0.0，同一网段的其他机器也能打开。
import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { pdfjsAssets, pdfjsDir } from "./pdfjs_assets.mjs";

const port = Number(process.env.TASKWRIGHT_WEB_PORT || 5680);
const target = process.env.TASKWRIGHT_API_TARGET || "http://127.0.0.1:8790";

export default defineConfig({
  // pdfjsAssets：把 pdf.js 显示 PDF 材料时要另外取的字符映射表、标准字体等文件带进产物的 pdfjs/ 目录，开发服务器上也提供（pdfjs_assets.mjs）。
  plugins: [react(), pdfjsAssets()],
  // 支持的浏览器下限：Chrome 或 Edge 125、Firefox 128、Safari 18（pdf.js 的 legacy 构建官方支持的下限；入口页 index.html 里
  // 有一段检查，太旧的浏览器显示一句话）。构建时把比这更新的语法降到这几个版本能读的写法；它只管语法，不补方法。
  build: { target: ["chrome125", "edge125", "firefox128", "safari18"] },
  // Word 文件当作静态资源：测试里以 ?inline 引入样本 .docx。
  assetsInclude: ["**/*.docx"],
  server: {
    host: "0.0.0.0",
    port,
    strictPort: true,
    // 允许读的目录：仓库本身，加 pdfjs-dist 实际所在的目录。页面按地址导入 pdf.js 的工作线程文件（?url）；并行的工作树里
    // node_modules 是逐包链到主检出的，这个文件的真实位置在仓库目录之外，不列出来就会被拒绝（开发服务器与测试都是）。
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(pdfjsDir())] },
    proxy: {
      // 事件流是长连接：关掉代理超时，免得 SSE 被中途切断。
      // xfwd 让代理加上 X-Forwarded-For，写明页面是从哪台电脑打开的（代理到后端的连接都来自本机）；任务服务现在不凭它做判断，留着无害。
      "/api": { target, changeOrigin: true, timeout: 0, proxyTimeout: 0, xfwd: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
