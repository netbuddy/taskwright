// 完成条件的三种状态：集合为空的条件显示「暂无条目」，不算已满足；标题只说还差几项。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Completion } from "../api/types";
import { CompletionPanel } from "../components/CompletionPanel";
import { completionHeadline, conditionState, unmetCount } from "../model/items";

afterEach(cleanup);

const EMPTY_DELIVERABLE: Completion = {
  all_met: false, unmet_count: 1,
  conditions: [
    { collection: "功能用例", name: "至少一个条目", met: false, state: "unmet", done: 0, total: 0, missing: [], note: "现在一个条目也没有。" },
    { collection: "功能用例", name: "每个条目用户确认", met: true, state: "empty", done: 0, total: 0, missing: [], note: "这个集合现在没有条目，这一条暂不需要核对。" },
    { collection: "约束", name: "每个条目用户确认", met: true, state: "empty", done: 0, total: 0, missing: [], note: "这个集合现在没有条目，这一条暂不需要核对。" },
  ],
};

describe("完成条件的三种状态", () => {
  it("空交付物：标题是还差 1 项，不写「满足了几条」；空集合的条件显示暂无条目", () => {
    render(<CompletionPanel completion={EMPTY_DELIVERABLE} status="进行中" />);
    expect(screen.getByText(/要完成任务，还差 1 项。/)).toBeTruthy();
    expect(screen.queryByText(/满足了/)).toBeNull();
    expect(screen.getAllByTestId("cond-empty")).toHaveLength(2);
    expect(screen.getAllByTestId("cond-unmet")).toHaveLength(1);
    expect(screen.getAllByText(/这个集合现在没有条目，暂不需要核对。/)).toHaveLength(2);
  });

  it("旧后端没有 state 时按 met 推断；都满足时标题写都已满足", () => {
    expect(conditionState({ collection: "c", name: "n", met: true, done: 1, total: 1, missing: [], note: "" })).toBe("met");
    const all: Completion = { all_met: true, conditions: [
      { collection: "c", name: "n", met: true, state: "met", done: 1, total: 1, missing: [], note: "" }] };
    expect(unmetCount(all)).toBe(0);
    expect(completionHeadline(all)).toBe("完成条件都已满足。");
  });
});
