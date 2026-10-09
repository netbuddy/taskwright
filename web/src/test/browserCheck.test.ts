// 浏览器太旧时入口页写一句话、不画页面（index.html 里的一段普通脚本，加 src/main.tsx 开头的判断）。
// 这里把那段脚本从 index.html 里取出来，在缺这样那样的环境里各跑一遍。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../../index.html?raw";

const TOO_OLD = "这个浏览器版本太旧，请更新到两年内的版本（Chrome 或 Edge 125、Firefox 128、Safari 18 以上）。";
type Flagged = { __taskwrightUnsupportedBrowser?: boolean };
/** index.html 里那段检查的脚本（没有 src、也不是 module 的那一个 script）。 */
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
/** CSS.supports 认得的写法；从里面去掉一样就是「这个浏览器没有它」。 */
const MODERN = ["selector(:has(a))", "color|color-mix(in srgb, red, blue)", "container-type|inline-size"];
const cssWith = (known: string[]) => ({ supports: (...args: string[]) => known.includes(args.join("|")) });

function run(env: { css?: unknown; hasOwn?: boolean; clone?: boolean } = {}) {
  vi.stubGlobal("CSS", "css" in env ? env.css : cssWith(MODERN));
  vi.stubGlobal("structuredClone", env.clone === false ? undefined : (value: unknown) => value);
  // 「没有 Object.hasOwn」不能真的把它从环境里拿掉（jsdom 与测试框架自己都要用），改成让那段脚本看到一个没有它的 Object。
  new Function("Object", script)(env.hasOwn === false ? {} : Object);
  return { flagged: (window as Flagged).__taskwrightUnsupportedBrowser === true, text: document.getElementById("root")!.textContent };
}

beforeEach(() => { document.body.innerHTML = '<div id="root"></div>'; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); delete (window as Flagged).__taskwrightUnsupportedBrowser; });

describe("入口页的浏览器检查", () => {
  it("那段脚本排在页面脚本之前，只用很旧的写法（太旧的浏览器读不了页面脚本，它也得能跑）", () => {
    expect(script).toContain("__taskwrightUnsupportedBrowser");
    expect(html.indexOf("<script>")).toBeGreaterThan(html.indexOf('<div id="root">'));
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('<script type="module"'));
    expect(script).not.toMatch(/=>|\bconst\b|\blet\b|`|\?\.|\?\?/);
  });

  it("几样都有：什么也不做", () => {
    expect(run()).toEqual({ flagged: false, text: "" });
  });

  it("缺任何一样（Object.hasOwn、structuredClone、CSS.supports 本身、:has()、color-mix()、容器查询）：写那句话并记下不画页面", () => {
    const cases: Parameters<typeof run>[0][] = [
      { hasOwn: false }, { clone: false }, { css: undefined }, { css: {} }, { css: { supports: () => { throw new Error("不认识的写法"); } } },
      ...MODERN.map((gone) => ({ css: cssWith(MODERN.filter((one) => one !== gone)) })),
    ];
    for (const env of cases) {
      document.body.innerHTML = '<div id="root"></div>';
      delete (window as Flagged).__taskwrightUnsupportedBrowser;
      vi.restoreAllMocks();
      expect(run(env)).toEqual({ flagged: true, text: TOO_OLD });
    }
  });
});

describe("页面入口看到检查没有过就不画页面", () => {
  const createRoot = vi.fn(() => ({ render: vi.fn() }));
  beforeEach(() => {
    createRoot.mockClear();
    vi.doMock("react-dom/client", () => ({ createRoot }));
    vi.doMock("../App", () => ({ App: () => null }));
  });
  afterEach(() => { vi.doUnmock("react-dom/client"); vi.doUnmock("../App"); });

  it("检查没有过：不画，那句话留在页面上", async () => {
    run({ clone: false });
    await import("../main");
    expect(createRoot).not.toHaveBeenCalled();
    expect(document.getElementById("root")!.textContent).toBe(TOO_OLD);
  });

  it("检查过了：照常画", async () => {
    run();
    await import("../main");
    expect(createRoot).toHaveBeenCalledTimes(1);
  });
});
