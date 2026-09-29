// 出错说明的强制折行：材料区读取出错、文档预览出错、Word 原版式预览出错三处用 .busy-note，
// 与输入框上方的提示条（.busybar）一样设 overflow-wrap:anywhere，很长的不带空格的串在框内折行，不被右边缘截掉。
// 测试环境不计算样式表（测试配置里 css 关着，?raw 引入也读不到内容），这里直接读样式表文件里的规则。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// 基准地址先放进变量：Vite 会把 new URL(模板, import.meta.url) 这种写法改写成按目录匹配，子目录里的文件就读不到了。
const here = import.meta.url;
const read = (name: string) => readFileSync(decodeURIComponent(new URL(`../${name}`, here).pathname), "utf-8");
const styles = read("styles.css");
const workview = read("styles/workview.css");

const rule = (css: string, selector: string) => {
  const at = css.split("\n").find((line) => line.startsWith(`${selector} {`) || line.startsWith(`${selector}{`));
  return at ?? "";
};

describe("出错说明的折行", () => {
  it(".busy-note 与 .busybar 都设了 overflow-wrap:anywhere", () => {
    expect(rule(styles, ".busy-note")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(workview).toMatch(/\.app \.busybar\{[^}]*overflow-wrap:anywhere/);
  });
});
