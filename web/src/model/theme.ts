// 界面风格：暖纸与素白两种，各是 styles.css 开头的一个令牌块。这里只管当前用哪一种：写到 html 的 data-theme 上、
// 把选择存在浏览器本地（读写失败时照缺省的暖纸处理，页面照常显示），并在切换时通知用到颜色的地方重算
// （App.tsx 里 Ant Design 的主题令牌）。入口页 index.html 里另有一小段脚本在样式生效之前先套一次，用的是同一个键。

import { useEffect, useState } from "react";

export type Theme = "paper" | "plain";

export const THEMES: { key: Theme; label: string; note: string }[] = [
  { key: "paper", label: "暖纸", note: "米色纸面，标题用衬线字体" },
  { key: "plain", label: "素白", note: "黑白灰，标题与正文同一种字体" },
];

export const DEFAULT_THEME: Theme = "paper";
export const THEME_STORAGE_KEY = "taskwright.theme";
const EVENT = "taskwright:theme";

export function readTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "plain" ? "plain" : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event(EVENT));
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 浏览器不让存（隐私模式之类）：这一次照样生效，下次打开回到暖纸
  }
}

/** 页面上现在套着的风格（html 的 data-theme）；还没有套过时按存着的选择算。 */
export function currentTheme(): Theme {
  const on = document.documentElement.dataset.theme;
  return on === "plain" || on === "paper" ? on : readTheme();
}

/** 跟着切换变化的当前风格。 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const update = () => setTheme(currentTheme());
    window.addEventListener(EVENT, update);
    return () => window.removeEventListener(EVENT, update);
  }, []);
  return theme;
}
