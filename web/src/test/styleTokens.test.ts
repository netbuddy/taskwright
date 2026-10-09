// 配色只有一个来源：styles.css 开头的令牌块。别的地方（styles.css 的其余部分、styles/ 下的每个样式文件）一律引用令牌，
// 不直接写色值。这样换一种界面风格只要换令牌块，不会留下换不掉的灰白斑块。
// 测试环境不计算样式表（测试配置里 css 关着），这里直接读样式表文件。

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// 基准地址先放进变量：Vite 会把 new URL(模板, import.meta.url) 这种写法改写成按目录匹配，子目录里的文件就读不到了。
const here = import.meta.url;
const pathOf = (name: string) => decodeURIComponent(new URL(`../${name}`, here).pathname);
const read = (name: string) => readFileSync(pathOf(name), "utf-8");
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** styles.css 里令牌块结束的位置：最后一个令牌块的右花括号之后。令牌块是只含「--名字: 值」声明的规则。 */
function afterTokenBlocks(css: string): number {
  let end = 0;
  for (const m of css.matchAll(/[^{}]+\{([^{}]*)\}/g)) {
    const declarations = m[1].split(";").map((one) => one.trim()).filter(Boolean);
    if (declarations.length === 0 || !declarations.every((one) => one.startsWith("--"))) break;
    end = m.index + m[0].length;
  }
  return end;
}

const GLOBAL = withoutComments(read("styles.css"));
const SHEETS: [string, string][] = [
  ["styles.css（令牌块之后）", GLOBAL.slice(afterTokenBlocks(GLOBAL))],
  ...readdirSync(pathOf("styles")).filter((name) => name.endsWith(".css")).sort()
    .map((name): [string, string] => [`styles/${name}`, withoutComments(read(`styles/${name}`))]),
];
const literals = (css: string) => [...(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []), ...(css.match(/\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g) ?? [])];

describe("样式文件里的颜色", () => {
  it("styles.css 开头确实有令牌块，读到了 styles/ 下的每个样式文件", () => {
    expect(afterTokenBlocks(GLOBAL)).toBeGreaterThan(0);
    expect(GLOBAL.slice(0, afterTokenBlocks(GLOBAL))).toContain("--ink:");
    expect(SHEETS.map(([name]) => name)).toEqual(expect.arrayContaining(["styles/workview.css", "styles/workview-extra.css", "styles/settings.css", "styles/pdf.css"]));
  });

  it("除了 styles.css 的令牌块，哪个样式文件都不直接写色值：没有十六进制颜色，也没有 rgb、hsl 写法", () => {
    const found = SHEETS.flatMap(([name, css]) => literals(css).map((one) => `${name}: ${one}`));
    expect(found).toEqual([]);
  });

  it("引用的每个颜色令牌都在令牌块里定义过", () => {
    const blocks = GLOBAL.slice(0, afterTokenBlocks(GLOBAL));
    const defined = new Set([...blocks.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    // 这几个不是配色令牌：组件在自己的规则里定义、当场使用的局部变量。
    const local = new Set(SHEETS.flatMap(([, css]) => [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])));
    const used = new Set(SHEETS.flatMap(([, css]) => [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])));
    // 这两个不是颜色：--total-scale-factor 由 pdf.js 在页面上设；--mono 没有定义，用的地方都带着后备字体。
    const notColours = new Set(["--total-scale-factor", "--mono"]);
    expect([...used].filter((name) => !defined.has(name) && !local.has(name) && !notColours.has(name))).toEqual([]);
  });
});
