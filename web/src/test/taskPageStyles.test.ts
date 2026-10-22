// 任务起点页样式文件（styles/task-page.css）的几条规矩：颜色只引用 styles.css 里的变量，不直接写色值；类名一律以 tp- 开头，不与别的页面相混；
// 琥珀色只表示「还差」；按钮与小标签用工作视图已有的样式，这里不另写。
// 测试环境不计算样式表（测试配置里 css 关着，?raw 引入也读不到内容），这里直接读样式表文件。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// 基准地址先放进变量：Vite 会把 new URL(模板, import.meta.url) 这种写法改写成按目录匹配，子目录里的文件就读不到了。
const here = import.meta.url;
const read = (name: string) => readFileSync(decodeURIComponent(new URL(`../${name}`, here).pathname), "utf-8");
const TASK_PAGE_CSS = read("styles/task-page.css");
const GLOBAL_CSS = read("styles.css");

/** 去掉注释之后的样式正文。 */
const rules = TASK_PAGE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("任务起点页的样式文件", () => {
  it("不直接写色值：没有井号开头的十六进制颜色，也没有 rgb、hsl 写法", () => {
    expect(rules.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(rules.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? []).toEqual([]);
  });

  it("引用的每个变量都在 styles.css 的第一个令牌块里定义过", () => {
    const start = GLOBAL_CSS.indexOf(":root, [data-theme=\"plain\"]{");
    expect(start).toBeGreaterThanOrEqual(0);
    const root = GLOBAL_CSS.slice(start, GLOBAL_CSS.indexOf("\n}", start));
    const defined = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
    expect(defined.has("--text2")).toBe(true);
    expect(used.has("--text2")).toBe(true);
  });

  it("琥珀色只给缺前提的那一句：别的说明是灰色；靛蓝只给助手正在产出的格子、正在进行的卡片与产出的小标签", () => {
    const selectorsWith = (token: string) => [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[2].includes(`var(--${token})`)).map((m) => m[1].trim());
    expect(selectorsWith("amber")).toEqual([".tp-need"]);
    const declarations = (selector: string) => [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1].split(",").some((one) => one.trim() === selector)).map((m) => m[2].trim());
    expect(declarations(".tp-quiet")).toEqual(["font-size: 0.857rem; color: var(--mut);"]);
    expect(selectorsWith("ai-line").sort()).toEqual([".tp-act.now", ".tp-cell.hot", ".tp-rw .l span.w"]);
  });

  it("这一页不另写按钮与小标签的样子：只给按钮的字色，与输入页主按钮「启动某项」大一档的尺寸；小标签只摆位置（活动卡标题上的、会话名旁的）", () => {
    const buttonRules = [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\.btn\b/.test(m[1])).map((m) => [m[1].trim(), m[2].trim()]);
    expect(buttonRules).toEqual([
      [".tp-page .btn", "color: var(--ink);"], [".tp-page .btn.pri", "color: var(--on-ink);"], [".tp-in-go .btn", "font-size: 1rem; padding: 0.429rem 1.143rem;"]]);
    expect([...rules.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim()).filter((selector) => /\.chip\b/.test(selector))).toEqual([".tp-act .t .chip", ".tp-srow .sfirst .chip"]);
  });

  it("类名一律以 tp- 开头：每条规则的第一个选择器都从 .tp- 起", () => {
    const selectors = [...rules.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter((sel) => !/^\d|^from|^to/.test(sel));
    expect(selectors.length).toBeGreaterThan(40);
    expect(selectors.filter((sel) => !sel.split(",").every((one) => one.trim().startsWith(".tp-")))).toEqual([]);
  });
});
