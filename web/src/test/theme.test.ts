// 界面风格（暖纸、素白）：没有选过时是暖纸；选了之后写到 html 的 data-theme 上并存在浏览器本地，再次打开沿用；
// 入口页 index.html 里先套风格的那一小段脚本与 model/theme.ts 用同一个键、得出同一个结果；
// styles.css 里两种风格的令牌块一一对应。
// 测试环境不计算样式表（测试配置里 css 关着），令牌块直接读样式表文件来比。

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import html from "../../index.html?raw";
import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY, applyTheme, currentTheme, readTheme, saveTheme } from "../model/theme";

const here = import.meta.url;
const GLOBAL_CSS = readFileSync(decodeURIComponent(new URL("../styles.css", here).pathname), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
/** index.html 里先套风格的那段脚本。 */
const bootScript = /<script data-purpose="theme">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
const onPage = () => document.documentElement.getAttribute("data-theme");

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("界面风格的选择", () => {
  it("两种风格是暖纸与素白，没有选过时是暖纸", () => {
    expect(THEMES.map((one) => `${one.key}:${one.label}`)).toEqual(["paper:暖纸", "plain:素白"]);
    expect(DEFAULT_THEME).toBe("paper");
    expect(readTheme()).toBe("paper");
    applyTheme(readTheme());
    expect(onPage()).toBe("paper");
  });

  it("选素白：html 的 data-theme 与浏览器本地存的都变成 plain，并通知用到颜色的地方", () => {
    applyTheme(readTheme());
    const heard = vi.fn();
    window.addEventListener("taskwright:theme", heard);
    saveTheme("plain");
    window.removeEventListener("taskwright:theme", heard);
    expect(onPage()).toBe("plain");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("plain");
    expect(currentTheme()).toBe("plain");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("再次打开沿用上次选的；选回暖纸也一样", () => {
    saveTheme("plain");
    document.documentElement.removeAttribute("data-theme"); // 相当于重新打开页面
    expect(readTheme()).toBe("plain");
    applyTheme(readTheme());
    expect(onPage()).toBe("plain");
    saveTheme("paper");
    document.documentElement.removeAttribute("data-theme");
    expect(readTheme()).toBe("paper");
  });

  it("存着认不得的值、或者浏览器不让读写时，照暖纸处理，页面照常", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "midnight");
    expect(readTheme()).toBe("paper");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readTheme()).toBe("paper");
    expect(() => saveTheme("plain")).not.toThrow();
    expect(onPage()).toBe("plain"); // 这一次照样生效
  });
});

describe("入口页里先套风格的脚本", () => {
  const boot = () => new Function(bootScript)();

  it("用的键与 model/theme.ts 相同", () => {
    expect(bootScript).toContain(`"${THEME_STORAGE_KEY}"`);
  });

  it("没有选过是暖纸，选过素白是素白，存着认不得的值是暖纸", () => {
    boot();
    expect(onPage()).toBe("paper");
    window.localStorage.setItem(THEME_STORAGE_KEY, "plain");
    boot();
    expect(onPage()).toBe("plain");
    window.localStorage.setItem(THEME_STORAGE_KEY, "midnight");
    boot();
    expect(onPage()).toBe("paper");
  });

  it("浏览器不让读时也是暖纸，不出错", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(boot).not.toThrow();
    expect(onPage()).toBe("paper");
  });

  it("排在页面脚本之前", () => {
    expect(html.indexOf('data-purpose="theme"')).toBeGreaterThan(0);
    expect(html.indexOf('data-purpose="theme"')).toBeLessThan(html.indexOf('type="module"'));
  });
});

describe("标题字体", () => {
  it("只有各页的一级标题、分区标题与工作视图顶栏的任务名用标题字体，别处都不用", () => {
    const sheets = [GLOBAL_CSS, ...["workview.css", "workview-extra.css", "settings.css", "task-page.css", "status.css", "issues.css", "pdf.css", "docx.css"]
      .map((name) => readFileSync(decodeURIComponent(new URL(`../styles/${name}`, here).pathname), "utf-8").replace(/\/\*[\s\S]*?\*\//g, ""))];
    const users = sheets.flatMap((css) => [...css.matchAll(/([^{}]+)\{[^{}]*var\(--font-title\)[^{}]*\}/g)].map((m) => m[1].trim()));
    expect(users).toEqual([".page-title h1, .tp-head h1, .tp-sec-h h2, .kbhead h2, .settings .dhead h2, .app .topbar .tname"]);
  });

  it("正文用正文字体", () => {
    expect(GLOBAL_CSS).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-body\)/);
  });
});

describe("两种风格的令牌块", () => {
  const block = (selector: string) => {
    const start = GLOBAL_CSS.indexOf(`${selector}{`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = GLOBAL_CSS.slice(start + selector.length + 1, GLOBAL_CSS.indexOf("}", start));
    return new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m): [string, string] => [m[1], m[2].trim()]));
  };
  const plain = block(':root, [data-theme="plain"]');
  const paper = block('[data-theme="paper"]');
  // 栏宽不属于配色，只在第一个块里给。
  const layout = (name: string) => name.startsWith("--w-");

  it("素白块在前，暖纸块在后（html 上写 paper 时后面的块生效）", () => {
    expect(GLOBAL_CSS.indexOf(':root, [data-theme="plain"]{')).toBeLessThan(GLOBAL_CSS.indexOf('[data-theme="paper"]{'));
  });

  it("两个块的令牌一一对应：素白有的配色与字体令牌，暖纸都给了值，反过来也一样", () => {
    const plainNames = [...plain.keys()].filter((name) => !layout(name)).sort();
    expect(plainNames.length).toBeGreaterThan(60);
    expect([...paper.keys()].sort()).toEqual(plainNames);
  });

  it("两套的取值各自独立：纸色、卡片色、墨色都不同；暖纸的标题用衬线字体，素白的标题与正文同一种", () => {
    for (const name of ["--paper", "--card", "--ink", "--line", "--amber", "--blue", "--ok"]) expect(paper.get(name)).not.toBe(plain.get(name));
    expect(paper.get("--paper")).toBe("#f7f5ef");
    expect(paper.get("--card")).toBe("#fffdf9");
    expect(paper.get("--ink")).toBe("#22272e");
    expect(plain.get("--paper")).toBe("#f3f3f3");
    expect(plain.get("--ink")).toBe("#0d0d0d");
    expect(plain.get("--font-title")).toBe("var(--font-body)");
    expect(paper.get("--font-title")).toMatch(/serif$/);
    expect(paper.get("--font-title")).toContain("Noto Serif CJK SC");
    expect(paper.get("--font-body")).toBe(plain.get("--font-body"));
  });
});
