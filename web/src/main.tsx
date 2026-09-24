import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyFontTier, readFontTier } from "./model/fontScale";
import "./styles.css";
import "./styles/workview.css";
import "./styles/workview-extra.css";
import "./styles/issues.css";

// 上次选的字号档位（存在浏览器本地）先套上，再画页面，免得先按中档画一遍再跳。
applyFontTier(readFontTier());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
