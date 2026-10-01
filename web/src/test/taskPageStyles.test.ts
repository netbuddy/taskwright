// 任务页样式文件（styles/task-page.css）的两条规矩：颜色只引用 styles.css 里的变量，不直接写色值；类名一律以 tp- 开头，不与别的页面相混。
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

describe("任务页的样式文件", () => {
  it("不直接写色值：没有井号开头的十六进制颜色，也没有 rgb、hsl 写法", () => {
    expect(rules.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(rules.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? []).toEqual([]);
  });

  it("引用的每个变量都在 styles.css 的 :root 里定义过（集合卡自己的 --c 除外）", () => {
    const root = GLOBAL_CSS.slice(GLOBAL_CSS.indexOf(":root{"), GLOBAL_CSS.indexOf("}", GLOBAL_CSS.indexOf(":root{")));
    const defined = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    used.delete("--c");
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
    expect(defined.has("--text2")).toBe(true);
    expect(used.has("--text2")).toBe(true);
  });

  it("类名一律以 tp- 开头：每条规则的第一个选择器都从 .tp- 起", () => {
    const selectors = [...rules.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter((sel) => !/^\d|^from|^to/.test(sel));
    expect(selectors.length).toBeGreaterThan(40);
    expect(selectors.filter((sel) => !sel.split(",").every((one) => one.trim().startsWith(".tp-")))).toEqual([]);
  });
});
