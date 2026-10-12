import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyFontTier, readFontTier } from "./model/fontScale";
import { applyTheme, readTheme } from "./model/theme";
import "./styles.css";
import "./styles/workview.css";
import "./styles/workview-extra.css";
import "./styles/proposal.css";
import "./styles/issues.css";
import "./styles/status.css";
import "./styles/docx.css";
import "./styles/pdf.css";
import "./styles/overall.css";
import "./styles/stage.css";

// 浏览器太旧时入口页（index.html）里的检查已经在页面上写了一句话，这里就不画页面了。
if (!(window as { __taskwrightUnsupportedBrowser?: boolean }).__taskwrightUnsupportedBrowser) {
  // 上次选的字号档位与界面风格（都存在浏览器本地）先套上，再画页面，免得先按缺省的画一遍再跳。
  // 界面风格在入口页 index.html 里已经先套过一次（那一次赶在样式生效之前），这里再套一次是为了两处一致。
  applyFontTier(readFontTier());
  applyTheme(readTheme());

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
