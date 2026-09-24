// 字号三档与根字号。根字号随视口流动，三档的 clamp 写在 styles.css；这里只切换 html 的类、
// 把选择存在浏览器本地（读写失败时照中档处理，页面照常显示），并提供按根字号换算的几样宽度判断。

import { useEffect, useState } from "react";

export type FontTier = "s" | "m" | "l";

export const FONT_TIERS: { key: FontTier; label: string }[] = [
  { key: "s", label: "小" },
  { key: "m", label: "中" },
  { key: "l", label: "大" },
];

const CLASS: Record<FontTier, string | null> = { s: "fs-s", m: null, l: "fs-l" };
const STORAGE_KEY = "taskwright.fontTier";

export function readFontTier(): FontTier {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "s" || v === "l" ? v : "m";
  } catch {
    return "m";
  }
}

export function applyFontTier(tier: FontTier): void {
  const root = document.documentElement;
  root.classList.remove("fs-s", "fs-l");
  const cls = CLASS[tier];
  if (cls) root.classList.add(cls);
  window.dispatchEvent(new Event("taskwright:font-tier"));
}

export function saveFontTier(tier: FontTier): void {
  applyFontTier(tier);
  try {
    window.localStorage.setItem(STORAGE_KEY, tier);
  } catch {
    // 浏览器不让存（隐私模式之类）：这一次照样生效，下次打开回到中档
  }
}

/** 根字号的像素数。宽度判断一律除以它换算成 rem 再比较，不用固定像素断点。 */
export function rootPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** 视口宽度不到 100rem 时文档栏默认收起。 */
export function narrowViewport(): boolean {
  return window.innerWidth / rootPx() < 100;
}

/** 跟着窗口大小与字号档位变化的根字号像素数（给 Ant Design 的字号令牌用）。 */
export function useRootPx(): number {
  const [px, setPx] = useState(rootPx);
  useEffect(() => {
    const update = () => setPx(rootPx());
    window.addEventListener("resize", update);
    window.addEventListener("taskwright:font-tier", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("taskwright:font-tier", update);
    };
  }, []);
  return px;
}
