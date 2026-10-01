// 评审计数三处一致：条目区的汇总行、任务页的交付物看板、条目区的筛选，对同一个任务给出的评审通过、评审不通过（不含保留的）、
// 已保留写法三个数各自相同；集合卡上的那行数字与悬停提示里的说明。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { Item, Task, TaskDetail } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { TaskPage } from "../pages/TaskPage";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const noop = () => {};

const PROBLEM = { rule_id: "UC-R7", level: "必选", field: "用例名称", index: null, problem: "没有写目的。", suggestion: "写明目的。" };
const ok = { revision_no: 2, verdict: "合规", findings: [], rules_hash: "h1", seq: 5 };
const bad = { revision_no: 2, verdict: "不合规", findings: [PROBLEM], rules_hash: "h1", seq: 5 };
const waiver = { revision_no: 2, reason: null, source: "panel", revoked: false, seq: 9 };

function item(id: string, over: Partial<Item> = {}): Item {
  return {
    item_id: id, collection: "功能用例", title: id, revision_no: 2, revision_by: "executor", revision_at: "", revisions: [2],
    fields: { 用例名称: id }, sources: [], reviews: [], waivers: [], confirmations: [{ revision_no: 2, accepted: true, basis: "viewed" }],
    confirmation_stale: false, ...over,
  };
}

function task(items: Item[]): Task {
  return {
    task_id: "TASK-C", task_name: "计数", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "功能用例", prefix: "UC", needs_review: true, rules_hash: "h1", review_rules: [{ id: "UC-R7", level: "必选", text: "写明目的。" }],
        fields: [{ name: "用例名称", type: "文本", required: true, values: null }] },
      { name: "问题", prefix: "TBD", needs_review: false, review_rules: null, fields: [
        { name: "事项", type: "文本", required: true, values: null },
        { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] }] }] },
    completion: null, items, latest_revision: 2,
  };
}

// 通过 2、不通过 1、保留 2（其中一条撤销过又保留）、撤销了保留的 1（算不通过）、待评审 1、旧规则下的 1（算待评审）。
const MIXED = [
  item("UC-001", { reviews: [ok] }), item("UC-002", { reviews: [ok] }),
  item("UC-003", { reviews: [bad] }),
  item("UC-004", { reviews: [bad], waivers: [waiver] }),
  item("UC-005", { reviews: [bad], waivers: [{ ...waiver, revoked: true }, { ...waiver, seq: 12 }] }),
  item("UC-006", { reviews: [bad], waivers: [{ ...waiver, revoked: true }] }),
  item("UC-007"),
  item("UC-008", { reviews: [{ ...ok, rules_hash: "h0" }] }),
  item("TBD-001", { collection: "问题", fields: { 事项: "借期", 状态: "用户决定保留" } }),
];
const EXPECTED = { passed: 2, failed: 2, kept: 2, pending: 2 };

function summary(t: Task) {
  render(<Wrap><ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={noop}
    submit={vi.fn(async () => null)} onGenerateDoc={noop} onReview={vi.fn()} /></Wrap>);
  const text = screen.getByTestId("progress").textContent ?? "";
  const n = (re: RegExp) => Number(text.match(re)?.[1] ?? 0);
  const listed = (label: string) => {
    fireEvent.click(within(screen.getByTestId("items-panel")).getByText(label, { selector: ".filt" }));
    return screen.queryAllByTestId(/^item-UC-/).length;
  };
  const out = {
    text,
    summary: { pending: n(/待评审 (\d+)/), failed: n(/评审不通过 (\d+)/), kept: n(/已保留写法 (\d+)/) },
    filters: { pending: listed("待评审"), failed: listed("评审不通过"), kept: listed("已保留写法"), passed: listed("评审通过") },
  };
  cleanup();
  return out;
}

async function board(t: Task) {
  vi.spyOn(api, "getTask").mockResolvedValue({ ...t, sessions: [], materials: [] } as unknown as TaskDetail);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockRejectedValue(new Error("没有这个接口"));
  render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-C" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  const card = await screen.findByTestId("board-功能用例");
  // 卡上只有一行数字，详细的说明在悬停提示里：两处合起来看。
  const line = card.textContent ?? "";
  const text = `${line} ${card.getAttribute("title") ?? ""}`;
  return { card, text, passed: Number(line.match(/评审通过 (\d+)\//)?.[1]), kept: Number(line.match(/已保留写法 (\d+)/)?.[1] ?? 0) };
}

describe("评审计数三处一致", () => {
  it("汇总行、看板、筛选给出的评审通过、评审不通过、已保留写法各自相同", async () => {
    const t = task(MIXED);
    const s = summary(t);
    expect(s.summary).toEqual({ pending: EXPECTED.pending, failed: EXPECTED.failed, kept: EXPECTED.kept });
    expect(s.filters).toEqual(EXPECTED);
    const b = await board(t);
    expect(b.passed).toBe(s.filters.passed);
    expect(b.kept).toBe(s.filters.kept);
    expect(b.text).toContain(`评审通过 ${EXPECTED.passed}/8`);
    expect(b.text).toContain(`${EXPECTED.passed} 个在当前所在的修订上评审通过，${EXPECTED.kept} 个评审不通过但你保留了写法（按你的决定算通过）`);
  });

  it("有保留了写法的条目时集合卡写出已保留写法的个数；没有保留的条目时不写这一项", async () => {
    const t = task([item("UC-001", { reviews: [ok] }), item("UC-004", { reviews: [bad], waivers: [waiver] })]);
    expect(summary(t).text).toContain("评审不通过 0 · 已保留写法 1 ·");
    let b = await board(t);
    expect(b.text).toContain("评审通过 1/2");
    expect(b.kept).toBe(1);
    cleanup(); vi.restoreAllMocks();
    const plain = task([item("UC-001", { reviews: [ok] })]);
    expect(summary(plain).text).not.toContain("已保留写法");
    b = await board(plain);
    expect(b.text).toContain("评审通过 1/1");
    expect(b.text).toContain("这 1 个条目里，1 个在当前所在的修订上评审通过，你已经看过其中 1 个。");
    expect(b.text).not.toContain("已保留写法");
  });
});
