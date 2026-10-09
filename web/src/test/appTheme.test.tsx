// Ant Design 的主题令牌从当前界面风格的 CSS 变量里读（App.tsx 的 themeTokens）：读得到的对到各自的令牌，读不到的不传；
// 切换界面风格时重读一次。测试环境不加载样式表，这里把变量直接写在 html 上。

import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { themeTokens } from "../App";
import { saveTheme, useTheme } from "../model/theme";

const root = document.documentElement;
const setVars = (vars: Record<string, string>) => { for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value); };

afterEach(() => {
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("Ant Design 的令牌取自界面风格", () => {
  it("样式表没有加载时一项都不传", () => {
    expect(themeTokens()).toEqual({});
  });

  it("读得到的变量对到各自的令牌，前后的空白去掉", () => {
    setVars({ "--ink": " #22272e", "--mut": "#8a919b", "--line2": "#e6e1d6", "--line": "#efebe2", "--paper": "#f7f5ef", "--card": "#fffdf9",
      "--sel": "#f3efe6", "--blue": "#2d5d8f", "--ok": "#2f6f5e", "--amber": "#b7791f", "--gap": "#a23b32", "--on-ink": "#fffdf9", "--font-body": "sans-serif" });
    expect(themeTokens()).toEqual({
      colorTextBase: "#22272e", colorBgBase: "#fffdf9", colorPrimary: "#22272e", colorTextLightSolid: "#fffdf9", colorText: "#22272e", colorTextSecondary: "#8a919b", colorTextTertiary: "#8a919b",
      colorBorder: "#e6e1d6", colorBorderSecondary: "#efebe2", colorBgLayout: "#f7f5ef", colorBgContainer: "#fffdf9", colorBgElevated: "#fffdf9",
      colorFillSecondary: "#f3efe6", colorLink: "#2d5d8f", colorSuccess: "#2f6f5e", colorWarning: "#b7791f", colorError: "#a23b32", colorInfo: "#2d5d8f",
      fontFamily: "sans-serif",
    });
  });

  it("切换界面风格时重读一次，别的时候不重读", () => {
    let reads = 0;
    function Probe() {
      const style = useTheme();
      // 与 App.tsx 里同样的写法：风格的键是「该重读了」的信号。
      const colours = useMemo(() => { reads += 1; return themeTokens(); }, [style]);
      return <span data-testid="ink">{colours.colorPrimary ?? "没有"}</span>;
    }
    setVars({ "--ink": "#22272e" });
    const view = render(<Probe />);
    expect(screen.getByTestId("ink")).toHaveTextContent("#22272e");
    const first = reads;
    view.rerender(<Probe />);
    expect(reads).toBe(first);
    act(() => { setVars({ "--ink": "#0d0d0d" }); saveTheme("plain"); });
    expect(screen.getByTestId("ink")).toHaveTextContent("#0d0d0d");
    expect(reads).toBe(first + 1);
  });
});
