// 材料区显示 PDF 材料时的几样计算（model/pdfView.ts）：各页留多大、哪几页要画、适应宽度、一块换成屏幕上的位置、
// 文字层里哪些条目属于一块、一段文字落在哪几个条目的哪里、文字按要标的几截切开、选中的文字怎样整理。

import { describe, expect, it } from "vitest";
import {
  A4, PAGE_GAP, type LayerItem, clampScale, currentPage, findInBlock, findInItems, fitScale, itemsInBox, pageLayout, pageSizes, readingOrder, roughTop, screenBox,
  selectedPdfText, splitByMarks, visiblePages,
} from "../model/pdfView";

const at = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const page = (n: number, width = 595, height = 842) => ({ page: n, width, height, rotate: 0, no_text: false, blocks: [] });

describe("各页留多大、画哪几页", () => {
  it("各页的大小取位置表里记的；位置表没有、或者里面缺某一页时用第一页实际的大小，再没有就按 A4", () => {
    expect(pageSizes({ pages: [page(1), page(2, 842, 595)] }, 3)).toEqual([{ width: 595, height: 842 }, { width: 842, height: 595 }, A4]);
    expect(pageSizes(null, 2, { width: 612, height: 792 })).toEqual([{ width: 612, height: 792 }, { width: 612, height: 792 }]);
    expect(pageSizes({ pages: [page(1, 0, 0)] }, 1)).toEqual([A4]);
    expect(pageSizes(null, 0)).toEqual([]);
  });

  it("适应宽度按出现得最多的页宽来定：夹着一两页横放的宽页时不为它们把所有页缩小；量不到宽度时按原始大小", () => {
    const portrait = { width: 595, height: 842 };
    const landscape = { width: 842, height: 595 };
    expect(fitScale([portrait, portrait, landscape, portrait], 476)).toBe(0.8);
    expect(fitScale([landscape, landscape, portrait], 421)).toBe(0.5);
    // 一样多时取窄的。
    expect(fitScale([portrait, landscape], 595)).toBe(1);
    expect([fitScale([portrait], 0), fitScale([], 500)]).toEqual([1, 1]);
    // 有上下限，取到百分之一。
    expect([fitScale([portrait], 10), fitScale([portrait], 9000), clampScale(0.8349)]).toEqual([0.25, 4, 0.83]);
  });

  it("各页的上沿与高度：页与页之间隔一段，总高度不算最后一段间隔", () => {
    const layout = pageLayout([{ width: 595, height: 842 }, { width: 842, height: 595 }, { width: 595, height: 842 }], 0.5);
    expect(layout).toEqual({ tops: [0, 421 + PAGE_GAP, 421 + PAGE_GAP + 298 + PAGE_GAP], heights: [421, 298, 421], total: 421 + 298 + 421 + 2 * PAGE_GAP });
    expect(pageLayout([], 1)).toEqual({ tops: [], heights: [], total: 0 });
  });

  it("只画看得见的页，上下各多画一页；量不到看得见的高度时按只看得见上沿所在的那一页", () => {
    // 十页，每页高 800，间隔 12：第 n 页从 (n-1)*812 开始。
    const layout = pageLayout(Array.from({ length: 10 }, () => ({ width: 600, height: 800 })), 1);
    expect(visiblePages(layout, 0, 700)).toEqual({ first: 1, last: 2 });
    expect(visiblePages(layout, 0, 900)).toEqual({ first: 1, last: 3 });
    expect(visiblePages(layout, 3 * 812 + 100, 700)).toEqual({ first: 3, last: 5 });
    expect(visiblePages(layout, 3 * 812 + 700, 700)).toEqual({ first: 3, last: 6 });
    expect(visiblePages(layout, 9 * 812 + 50, 700)).toEqual({ first: 9, last: 10 });
    expect(visiblePages(layout, 4 * 812, 0)).toEqual({ first: 4, last: 6 });
    // 正好落在两页之间的间隔里、滚过了头、还没有页：都不出错。
    expect(visiblePages(layout, 805, 5)).toEqual({ first: 1, last: 3 });
    expect(visiblePages(layout, 99999, 700)).toEqual({ first: 9, last: 10 });
    expect(visiblePages(pageLayout([], 1), 0, 700)).toBeNull();
  });

  it("现在看的是第几页：看得见的那一段的正中间落在哪一页", () => {
    const layout = pageLayout(Array.from({ length: 3 }, () => ({ width: 600, height: 800 })), 1);
    expect([currentPage(layout, 0, 700), currentPage(layout, 500, 700), currentPage(layout, 1700, 700), currentPage(layout, 99999, 700)]).toEqual([1, 2, 3, 3]);
    expect([currentPage(layout, 799), currentPage(layout, 805), currentPage(pageLayout([], 1), 0)]).toEqual([1, 2, 1]);
  });
});

describe("一块在页上的位置", () => {
  it("PDF 坐标（原点在左下）的矩形换成页面上的位置：两个对角各换一次再摆正；页面旋转了也一样", () => {
    // 没有旋转、放大 2 倍、页高 842：屏幕上的 y 从上往下。
    const plain = (x: number, y: number) => [x * 2, (842 - y) * 2];
    expect(screenBox([72, 700, 520, 760], plain)).toEqual({ left: 144, top: 164, width: 896, height: 120 });
    // 旋转 90 度的页：换出来的两个角不是左上与右下。
    const rotated = (x: number, y: number) => [y, x];
    expect(screenBox([72, 700, 520, 760], rotated)).toEqual({ left: 700, top: 72, width: 60, height: 448 });
  });

  it("页面还没有画出来时按没有旋转估一块的上沿", () => {
    expect(roughTop([72, 700, 520, 760], { width: 595, height: 842 }, 0.5)).toBe(41);
    expect(roughTop([72, 700, 520, 900], { width: 595, height: 842 }, 1)).toBe(0);
  });
});

describe("文字层与一块的对应、逐字标出", () => {
  const item = (index: number, text: string, x: number, y: number): LayerItem => ({ index, text, x, y });
  // 两栏：左栏三行在 x=72，右栏两行在 x=320；文字层里的先后是一行一行横着来的（左、右、左、右、左）。
  const items = [
    item(0, "读者凭借书证借书，", 72, 700), item(1, "逾期的每本每天", 320, 700),
    item(2, "每本书可以续借一次。", 72, 684), item(3, "罚款一角。", 320, 684),
    item(4, "", 72, 668), item(5, "学生一次最多借 5 本。", 72, 652),
  ];

  it("起点落在矩形里的条目属于这一块（四边放宽一点），空的条目不算", () => {
    expect(itemsInBox(items, [70, 640, 300, 705]).map((one) => one.index)).toEqual([0, 2, 5]);
    expect(itemsInBox(items, [318, 680, 560, 705]).map((one) => one.index)).toEqual([1, 3]);
    expect(itemsInBox(items, [73.5, 640, 300, 705]).map((one) => one.index)).toEqual([0, 2, 5]);
    expect(itemsInBox(items, [80, 640, 300, 705])).toEqual([]);
  });

  it("按阅读的先后排：从上到下，同一行里从左到右", () => {
    expect(readingOrder([items[5], items[3], items[0], items[1], items[2]]).map((one) => one.index)).toEqual([0, 1, 2, 3, 5]);
    // 同一行里高低差一两点的仍算同一行。
    expect(readingOrder([item(9, "b", 200, 699), item(8, "a", 100, 701)]).map((one) => one.index)).toEqual([8, 9]);
  });

  it("一段文字落在哪几个条目的第几个字到第几个字：可以跨条目，各条目一截", () => {
    const left = itemsInBox(items, [70, 640, 300, 705]);
    expect(findInItems(left, "借书，每本书可以续借")).toEqual([{ index: 0, start: 6, end: 9 }, { index: 2, start: 0, end: 7 }]);
    expect(findInItems(left, "学生一次最多借 5 本。")).toEqual([{ index: 5, start: 0, end: 12 }]);
    expect(findInItems(left, "教师一次最多借 10 本")).toBeNull();
    expect(findInItems(left, "  ")).toBeNull();
  });

  it("两边都规范化再找：空白、连字符、全角半角、部首字符不比较，标的是原来的字", () => {
    // 文字层里「工」「日」是部首字符，字之间有空格；摘录是通用汉字、没有空格。
    const radical = [item(0, `平台应当在 2 个${at(0x2f2f)}作${at(0x2f47)}内答复`, 72, 700)];
    expect(findInItems(radical, "2个工作日内")).toEqual([{ index: 0, start: 6, end: 13 }]);
    expect(radical[0].text.slice(6, 13)).toBe(`2 个${at(0x2f2f)}作${at(0x2f47)}内`);
    // 行末断词：文字层里是 learn- 与 ing，摘录是 learning。
    const hyphen = [item(0, "deep residual learn-", 72, 700), item(1, "ing framework", 72, 686)];
    expect(findInItems(hyphen, "residual learning framework")).toEqual([{ index: 0, start: 5, end: 19 }, { index: 1, start: 0, end: 13 }]);
    // 全角与半角。
    expect(findInItems([item(0, "ＣＬＣ５ 分类法", 72, 700)], "CLC5分类法")).toEqual([{ index: 0, start: 0, end: 8 }]);
  });

  it("在一块里找：先照文字层里的先后，找不到再按阅读的先后排一遍", () => {
    // 文字层里的先后与版面相反（先下一行、后上一行）。
    const shuffled = [item(0, "每本书可以续借一次。", 72, 684), item(1, "读者凭借书证借书，", 72, 700)];
    expect(findInBlock(shuffled, [70, 680, 300, 705], "借书，每本书")).toEqual([{ index: 1, start: 6, end: 9 }, { index: 0, start: 0, end: 3 }]);
    expect(findInBlock(shuffled, [70, 680, 300, 705], "没有这句话")).toBeNull();
    // 矩形里没有条目。
    expect(findInBlock(shuffled, [400, 100, 500, 200], "读者")).toBeNull();
  });
});

describe("文字按要标的几截切开", () => {
  it("没有标的、被引用的、高亮的各成一段，接起来是原来的文字", () => {
    const pieces = splitByMarks("读者凭借书证借书，每本书可以续借一次。", [{ start: 0, end: 9, items: ["UC-001"] }, { start: 12, end: 16, hit: true }]);
    expect(pieces).toEqual([{ text: "读者凭借书证借书，", items: ["UC-001"] }, { text: "每本书" }, { text: "可以续借", hit: true }, { text: "一次。" }]);
    expect(pieces.map((one) => one.text).join("")).toBe("读者凭借书证借书，每本书可以续借一次。");
    expect(splitByMarks("没有标的", [])).toEqual([{ text: "没有标的" }]);
  });

  it("重叠时高亮优先，被盖住的引用只留露出来的部分；越界的截到文字的两头；空的不算", () => {
    expect(splitByMarks("0123456789", [{ start: 2, end: 8, items: ["UC-001"] }, { start: 4, end: 6, hit: true }])).toEqual([
      { text: "01" }, { text: "23", items: ["UC-001"] }, { text: "45", hit: true }, { text: "67", items: ["UC-001"] }, { text: "89" }]);
    // 两条引用重叠：先开始的算，后一条只留没被盖住的。
    expect(splitByMarks("0123456789", [{ start: 3, end: 7, items: ["UC-002"] }, { start: 1, end: 5, items: ["UC-001"] }])).toEqual([
      { text: "0" }, { text: "1234", items: ["UC-001"] }, { text: "56", items: ["UC-002"] }, { text: "789" }]);
    expect(splitByMarks("abc", [{ start: -5, end: 99, hit: true }, { start: 1, end: 1, items: ["UC-001"] }])).toEqual([{ text: "abc", hit: true }]);
  });
});

describe("选中的文字", () => {
  it("跨行选中时把换行换成空格，中日韩字符之间的空格去掉，西文单词之间的留着", () => {
    expect(selectedPdfText("读者凭借书证借书，\n每本书可以续借一次。\n")).toBe("读者凭借书证借书，每本书可以续借一次。");
    expect(selectedPdfText("deep residual\n  learning  framework")).toBe("deep residual learning framework");
    expect(selectedPdfText("借期\n30 天，CLC5\n分类法")).toBe("借期 30 天，CLC5 分类法");
    expect(selectedPdfText("  \n ")).toBe("");
  });
});
