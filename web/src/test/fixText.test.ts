// 「让助手照这条改」预填的那句话：有改法时把改法写进去（问题描述有时与改法字面上方向相反，只写问题会让人以为要照字面改）；
// 没有改法时照原来的写法。条目详情与评审页签都用它。
import { describe, expect, it } from "vitest";
import type { Finding } from "../api/types";
import { fixText } from "../components/work/ItemDetail";

const finding = (over: Partial<Finding>): Finding =>
  ({ rule_id: "EARS-R1", level: "必选", field: "需求语句", index: null, problem: "一句话里有两个「应当」。", suggestion: null, ...over });

describe("让助手照这条改：预填的话", () => {
  it("有改法时改法在前、问题在后", () => {
    expect(fixText("NFR-001", finding({ suggestion: "拆成两条。" })))
      .toBe("请照评审建议的改法改 NFR-001 的需求语句：拆成两条。评审指出的问题是：一句话里有两个「应当」。");
    // 句末没有句号时补一个，两句不粘在一起
    expect(fixText("UC-003", finding({ field: "基本流程", index: 1, problem: "第 2 步没有主语", suggestion: "写明是系统核对" })))
      .toBe("请照评审建议的改法改 UC-003 的基本流程第 2 项：写明是系统核对。评审指出的问题是：第 2 步没有主语。");
  });

  it("没有改法时照原来的写法；列表字段写第几项", () => {
    expect(fixText("NFR-001", finding({}))).toBe("请按评审发现改 NFR-001 的需求语句：一句话里有两个「应当」。");
    expect(fixText("UC-003", finding({ field: "基本流程", index: 1, problem: "第 2 步没有主语。", suggestion: "" })))
      .toBe("请按评审发现改 UC-003 的基本流程第 2 项：第 2 步没有主语。");
  });
});
