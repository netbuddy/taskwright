// 选中原文之后浮动横条的位置（barPosition）：第一行上方放得下就放在上方，放不下改到选区下方；跨行时对着第一行选中部分的中间；
// 不超出材料区的左右边界；选区整个滚出可见范围时藏起来。rem 取 16，间隙 0.4rem＝6.4 像素，离边界 0.3rem＝4.8 像素。
import { describe, expect, it } from "vitest";
import { barPosition } from "../components/work/SelectionBar";

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
const WRAP = box(100, 50, 400, 600);
const VIEW = box(100, 50, 400, 600);
const BAR = { width: 200, height: 40 };

describe("浮动横条的位置", () => {
  it("第一行上方放得下：放在第一行上方，对着第一行选中部分的中间", () => {
    const p = barPosition([box(250, 300, 100, 20)], WRAP, VIEW, BAR, 16);
    expect(p).toEqual({ top: 300 - 50 - 40 - 6.4, left: 250 + 50 - 100 - 100, out: false });
  });

  it("选区靠近顶部、上方放不下：放在选区下方", () => {
    const p = barPosition([box(250, 70, 100, 20)], WRAP, VIEW, BAR, 16);
    expect(p.top).toBeCloseTo(70 + 20 - 50 + 6.4);
  });

  it("跨了几行：放在第一行上方，对着第一行选中部分的中间；上方放不下时放在最后一行下方", () => {
    const lines = [box(400, 300, 80, 20), box(110, 320, 380, 20), box(110, 340, 50, 20)];
    const p = barPosition(lines, WRAP, VIEW, BAR, 16);
    expect(p.top).toBeCloseTo(300 - 50 - 40 - 6.4);
    expect(p.left).toBeCloseTo(Math.min(400 + 40 - 100 - 100, 400 - 200 - 4.8));
    const high = barPosition([box(400, 60, 80, 20), box(110, 80, 380, 20), box(110, 100, 50, 20)], WRAP, VIEW, BAR, 16);
    expect(high.top).toBeCloseTo(120 - 50 + 6.4);
  });

  it("不超出左右边界：靠左的往右收，靠右的往左收", () => {
    expect(barPosition([box(102, 300, 10, 20)], WRAP, VIEW, BAR, 16).left).toBeCloseTo(4.8);
    expect(barPosition([box(490, 300, 8, 20)], WRAP, VIEW, BAR, 16).left).toBeCloseTo(400 - 200 - 4.8);
  });

  it("选区整个滚出可见范围（在上面或下面）：out 为真；露出一部分时不算", () => {
    expect(barPosition([box(250, 10, 100, 20)], WRAP, VIEW, BAR, 16).out).toBe(true);
    expect(barPosition([box(250, 700, 100, 20)], WRAP, VIEW, BAR, 16).out).toBe(true);
    expect(barPosition([box(250, 40, 100, 20)], WRAP, VIEW, BAR, 16).out).toBe(false);
  });
});
