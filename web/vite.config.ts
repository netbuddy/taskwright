// 开发服务器与测试的配置。
//
// 端口与后端地址都由环境变量给，代码里不写死：
//   TASKWRIGHT_WEB_PORT      开发服务器端口，缺省 5680。
//   TASKWRIGHT_API_TARGET    后端地址，/api 开头的请求代理到这里；缺省是本机的任务服务（http://127.0.0.1:8790，与 scripts/dev.sh
//                            起后端时的缺省端口相同）。后端没有起来时，页面显示连不上服务的提示。
// 服务绑 0.0.0.0，同一网段的其他机器也能打开。
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.TASKWRIGHT_WEB_PORT || 5680);
const target = process.env.TASKWRIGHT_API_TARGET || "http://127.0.0.1:8790";

export default defineConfig({
  plugins: [react()],
  // Word 文件当作静态资源：测试里以 ?inline 引入样本 .docx。
  assetsInclude: ["**/*.docx"],
  server: {
    host: "0.0.0.0",
    port,
    strictPort: true,
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
