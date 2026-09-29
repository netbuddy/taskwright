// 评审通过时的说明：条目详情里评审不通过横幅的位置换成绿色的说明，评审页签里通过的那一行下面多一行。说明用程序记下的那句话；
// 能列出规则的三种情形（model/items.ts 的 passRules）：指纹相同并且条数对得上时给「看这 N 条规则」与清单；评审之后规则改过、
// 或条数对不上时不给链接、灰字说明；有一边没有指纹时只写说明。没有记下那句话时只写「评审通过。」。已保留、不通过时没有这一块（看旧修订时也没有，见条目详情）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Item, Review, ReviewBatch, Snapshot, Task } from "../api/types";
import { ItemDetail } from "../components/work/ItemDetail";
import { ReviewPanel } from "../components/work/ReviewPanel";
import { formatTime } from "../model/format";
import { initialWorkState, workReducer } from "../state/workState";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
afterEach(() => cleanup());

const AT = "2026-09-28T18:51:00+08:00";
const OK2 = "按 2 条规则逐条核对，没有发现问题。";

function task(items: Item[], hash: string | null = "h1"): Task {
  return {
    task_id: "TASK-1", task_name: "t", task_type: "t", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [{ name: "功能用例", prefix: "UC", needs_review: true, rules_hash: hash, fields: [
      { name: "用例名称", type: "文本", required: true, values: null }, { name: "约束规则", type: "文本列表", required: false, values: null }],
      review_rules: [{ id: "UC-R1", level: "必选", text: "用例粒度以参与者的一个目的为准。" }, { id: "UC-R12", level: "可选", text: "约束规则与流程里不举例。" }],
      rule_switches: { off: ["UC-R13", "UC-R9"], promote: [] },
      all_rules: [
        { id: "UC-R1", level: "必选", text: "用例粒度以参与者的一个目的为准。", state: "required" },
        { id: "UC-R9", level: "可选", text: "不写界面细节。", state: "off" },
        { id: "UC-R12", level: "可选", text: "约束规则与流程里不举例。", state: "optional" },
        { id: "UC-R13", level: "可选", text: "不用「等」。", state: "off" },
      ] }] },
    completion: null, items, latest_revision: 1, review_batches: [BATCH],
  };
}
const BATCH: ReviewBatch = { no: 1, batch_id: "b1", at: AT, started_by: "user", scope: "pending", items: [{ item_id: "UC-001", revision_no: 1 }],
  total: 1, passed: 1, failed: 0, unfinished: 0, problems: 0, advice: 0 };

function item(review: Partial<Review>, over: Partial<Item> = {}): Item {
  return {
    item_id: "UC-001", collection: "功能用例", title: "续借图书", revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
    fields: { 用例名称: "续借图书", 约束规则: ["每本书可以续借一次"] }, sources: [], waivers: [], confirmations: [], confirmation_stale: false,
    reviews: [{ revision_no: 1, verdict: "合规", reason: OK2, findings: [], at: AT, batch_id: "b1", rules_hash: "h1", seq: 5, ...review }], ...over,
  };
}

function detail(t: Task, one: Item) {
  render(<Wrap><ItemDetail task={t} item={one} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} onReview={vi.fn()} /></Wrap>);
}
function panel(t: Task) {
  render(<Wrap><ReviewPanel task={t} readOnly={false} writesOff={false} onReview={vi.fn()} submit={vi.fn(async () => null)} onOpenFinding={vi.fn()} onPrefill={vi.fn()} /></Wrap>);
  fireEvent.click(screen.getByTestId("batch-1-passed"));
}

describe("评审通过时的说明", () => {
  it("条目详情：绿色说明用记下的原文，第二行写评审的时刻与修订；点「看这 2 条规则」展开清单，末尾写另有几条已经关闭，再点收起", () => {
    const one = item({});
    detail(task([one]), one);
    const note = screen.getByTestId("pass-note");
    expect(note).toHaveClass("sw-pass");
    expect(note).toHaveTextContent(`评审通过：${OK2}`);
    expect(note).toHaveTextContent(`评审于 ${formatTime(AT)}，修订 1`);
    expect(screen.queryByTestId("review-banner")).toBeNull();
    const link = screen.getByTestId("pass-rules-link");
    expect(link).toHaveTextContent("看这 2 条规则 ▸");
    expect(screen.queryByTestId("pass-rules")).toBeNull();
    fireEvent.click(link);
    const list = screen.getByTestId("pass-rules");
    expect(list).toHaveTextContent("UC-R1用例粒度以参与者的一个目的为准。必选");
    expect(list).toHaveTextContent("UC-R12约束规则与流程里不举例。可选");
    expect(list).not.toHaveTextContent("UC-R13");
    expect(list).toHaveTextContent("另有 2 条规则已经关闭，这次没有核对。");
    expect(link).toHaveTextContent("收起这 2 条规则 ▴");
    fireEvent.click(link);
    expect(screen.queryByTestId("pass-rules")).toBeNull();
  });

  it("没有关闭的规则时不写「另有几条」", () => {
    const t = task([item({})]);
    t.definition.collections[0].all_rules = t.definition.collections[0].all_rules!.filter((r) => r.state !== "off");
    detail(t, t.items[0]);
    fireEvent.click(screen.getByTestId("pass-rules-link"));
    expect(screen.getByTestId("pass-rules")).not.toHaveTextContent("另有");
  });

  it("通过但带着建议：说明用记下的原文，建议照旧标在字段旁", () => {
    const one = item({ reason: "按 2 条规则逐条核对：问题 0 处，建议 1 条。",
      findings: [{ rule_id: "UC-R12", level: "可选", field: "约束规则", index: null, problem: "举了例子。", suggestion: null }] });
    detail(task([one]), one);
    expect(screen.getByTestId("pass-note")).toHaveTextContent("评审通过：按 2 条规则逐条核对：问题 0 处，建议 1 条。");
    expect(screen.getByText(/举了例子/)).toBeInTheDocument();
  });

  it("记下的条数与现在生效的规则条数对不上：不列清单，按规则改过说明", () => {
    const one = item({ reason: "按 14 条规则逐条核对，没有发现问题。" });
    detail(task([one]), one);
    expect(screen.getByTestId("pass-note")).toHaveTextContent("评审通过：按 14 条规则逐条核对，没有发现问题。");
    expect(screen.queryByTestId("pass-rules-link")).toBeNull();
    expect(screen.getByTestId("pass-rules-changed")).toHaveTextContent("评审之后规则改过，这里列不出当时核对的规则。");
  });

  it("有一边没有指纹（没有规则文件的集合、早期记录）：只写说明，不给链接，不写灰字", () => {
    for (const [record, now] of [[null, "h1"], ["h1", null], [null, null]] as const) {
      const one = item({ rules_hash: record, reason: "按 1 条规则逐条核对，没有发现问题。" });
      detail(task([one], now), one);
      expect(screen.getByTestId("pass-note")).toHaveTextContent("评审通过：按 1 条规则逐条核对，没有发现问题。");
      expect(screen.queryByTestId("pass-rules-link")).toBeNull();
      expect(screen.queryByTestId("pass-rules-changed")).toBeNull();
      cleanup();
    }
  });

  it("没有记下那句话（早期数据）：只写「评审通过。」，不给链接", () => {
    const one = item({ reason: undefined });
    detail(task([one]), one);
    expect(screen.getByTestId("pass-note").firstChild).toHaveTextContent(/^评审通过。$/);
    expect(screen.queryByTestId("pass-rules-link")).toBeNull();
  });

  it("评审不通过、已保留写法时没有这一块", () => {
    const failed = item({ verdict: "不合规", reason: "按 2 条规则逐条核对：问题 1 处，建议 0 条。",
      findings: [{ rule_id: "UC-R1", level: "必选", field: "用例名称", index: null, problem: "粒度不对。", suggestion: "拆开。" }] });
    detail(task([failed]), failed);
    expect(screen.queryByTestId("pass-note")).toBeNull();
    cleanup();
    const kept = { ...failed, waivers: [{ revision_no: 1, reason: "原话如此", source: "detail", revoked: false, seq: 9 }] };
    detail(task([kept]), kept);
    expect(screen.queryByTestId("pass-note")).toBeNull();
  });

  it("评审页签：通过的那一行下面一行说明与链接，不写时刻与修订；评审之后规则改过的写灰字、不给链接", () => {
    const one = item({});
    panel(task([one]));
    const row = screen.getByTestId("pass-note");
    expect(row).toHaveClass("sw-pass-row");
    expect(row).toHaveTextContent(`评审通过：${OK2}看这 2 条规则 ▸`);
    expect(row).not.toHaveTextContent("评审于");
    fireEvent.click(within(row).getByTestId("pass-rules-link"));
    expect(within(row).getByTestId("pass-rules")).toHaveTextContent("另有 2 条规则已经关闭，这次没有核对。");
    cleanup();
    panel(task([one], "h2"));
    expect(screen.getByTestId("pass-note")).toHaveTextContent(`评审通过：${OK2}`);
    expect(screen.queryByTestId("pass-rules-link")).toBeNull();
    expect(screen.getByTestId("pass-rules-changed")).toHaveTextContent("评审之后规则改过，这里列不出当时核对的规则。");
  });

  it("评审事件里的那句话记进条目的评审记录", () => {
    const t = task([{ ...item({}), reviews: [] }]);
    const snapshot = { seq: 10, generated_at: "", executor: { state: "idle", text: "", active_session: "S" }, session: null, task: t, materials: [],
      conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null } as Snapshot;
    let s = workReducer(initialWorkState("S"), { type: "snapshot", snapshot });
    s = workReducer(s, { type: "sse", event: "review_recorded", data: { seq: 11, at: AT, task_id: "TASK-1", item_id: "UC-001", revision_no: 1, verdict: "合规",
      reason: OK2, findings: [], batch_id: "b1", rules_hash: "h1", completion: null } });
    expect(s.task!.items[0].reviews[0].reason).toBe(OK2);
  });
});
