// 评审门禁的界面：条目区的评审按钮与灰化、进度与结果（全站提示条）、字段旁的问题与建议两色和条文展开、
// 徽标写法、完成条件面板里评审一条的两组与按钮，以及工作视图状态对三种评审事件的消费。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Completion, Item, Snapshot, Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ItemDetail } from "../components/work/ItemDetail";
import { ItemStatus } from "../components/work/ItemStatus";
import { CompletionPanel } from "../components/CompletionPanel";
import { initialWorkState, workReducer, type ReviewRun } from "../state/workState";
import { ToastProvider } from "../components/Toasts";
import { useReviewToast } from "../components/work/workToasts";
import { failedReview, pendingReview } from "../model/items";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
afterEach(() => { cleanup(); vi.useRealTimers(); });
const noop = () => {};

const RULES = [
  { id: "UC-R7", level: "必选", text: "基本流程每一步写明谁做了什么，主语是参与者或系统，按先后排列。" },
  { id: "UC-R13", level: "可选", text: "步骤里不用「等」「相关」「必要的」这类无法验证的词。" },
];

function item(over: Partial<Item> & Pick<Item, "item_id">): Item {
  return {
    collection: "功能用例", title: "归还图书", revision_no: 3, revision_by: "executor", revision_at: "", revisions: [3],
    fields: { 用例名称: "归还图书", 基本流程: ["读者出示借书证", "核对借阅记录等"] }, sources: [], reviews: [],
    confirmations: [{ revision_no: 3, accepted: true, basis: "viewed" }], confirmation_stale: false, ...over,
  };
}

const PROBLEM = { rule_id: "UC-R7", level: "必选", field: "基本流程", index: 1, problem: "第 2 步没有主语。", suggestion: "写明是系统核对。" };
const ADVICE = { rule_id: "UC-R13", level: "可选", field: "基本流程", index: 1, problem: "第 2 步用了「等」。", suggestion: "列出核对哪几项。" };

const FAILED = item({ item_id: "UC-003", reviews: [{ revision_no: 3, verdict: "不合规", findings: [PROBLEM, ADVICE], at: "2026-09-24T10:12:00+08:00" }] });
const PASSED_WITH_ADVICE = item({ item_id: "UC-002", reviews: [{ revision_no: 3, verdict: "合规", findings: [ADVICE] }] });
const PENDING_A = item({ item_id: "UC-004" });
const PENDING_B = item({ item_id: "UC-005" });
const TBD = item({ item_id: "TBD-001", collection: "问题", title: "借期", fields: { 事项: "借期", 状态: "未解决" }, confirmations: [] });

function task(items: Item[], over: Partial<Task> = {}): Task {
  return {
    task_id: "TASK-001", task_name: "图书借阅", task_type: "软件需求规格说明编制", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "功能用例", prefix: "UC", needs_review: true, review_rules: RULES, fields: [
        { name: "用例名称", type: "文本", required: true, values: null },
        { name: "基本流程", type: "文本列表", required: true, values: null }] },
      { name: "问题", prefix: "TBD", needs_review: false, review_rules: null, fields: [
        { name: "事项", type: "文本", required: true, values: null },
        { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] }] }] },
    completion: null, items, latest_revision: 3, ...over,
  };
}

function panel(props: Partial<Parameters<typeof ItemsPanel>[0]> = {}) {
  const onReview = vi.fn();
  render(<Wrap><ItemsPanel task={task([FAILED, PASSED_WITH_ADVICE, PENDING_A, PENDING_B, TBD])} readOnly={false} recentlyChanged={[]}
    pendingItems={new Set()} selected={null} onSelect={noop} submit={vi.fn(async () => null)} onGenerateDoc={noop} onReview={onReview} {...props} /></Wrap>);
  return onReview;
}

describe("条目区顶部的评审动作", () => {
  it("按钮写待评审的条数，点了发空列表（评全部待评审的）；汇总行写待评审与评审不通过各几条；问题集合不算", () => {
    const onReview = panel();
    const button = screen.getByTestId("review-all");
    expect(button).toHaveTextContent("评审 2 条待评审的条目");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onReview).toHaveBeenCalledWith([], "评审 2 条待评审的条目");
    expect(screen.getByTestId("progress")).toHaveTextContent("5 个条目 · 待评审 2 · 评审不通过 1 ·");
  });

  it("没有待评审的条目、助手工作中、上一批还在评时灰化，悬停写明原因", () => {
    render(<Wrap><ItemsPanel task={task([FAILED])} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null}
      onSelect={noop} submit={vi.fn(async () => null)} onGenerateDoc={noop} onReview={vi.fn()} /></Wrap>);
    expect(screen.getByTestId("review-all")).toBeDisabled();
    expect(screen.getByTestId("review-all")).toHaveAttribute("title", "没有待评审的条目。");
    cleanup();
    panel({ writesOff: true });
    expect(screen.getByTestId("review-all")).toBeDisabled();
    expect(screen.getByTestId("review-all").getAttribute("title")).toContain("助手正在工作");
    cleanup();
    panel({ review: { op_id: "ui-op-1", done: 1, total: 4, current: ["UC-004"], finished: null } });
    expect(screen.getByTestId("review-all").getAttribute("title")).toContain("上一批评审还在进行");
  });

  it("评审进度走提示条：进行中带进度与正在评的条目；评完原地换成成功，带「看评审页签」，4 秒后淡出", () => {
    vi.useFakeTimers();
    const onShow = vi.fn();
    const Probe = ({ review }: { review: ReviewRun | null }) => { useReviewToast(review, onShow); return null; };
    const view = (review: ReviewRun | null) => <Wrap><ToastProvider><Probe review={review} /></ToastProvider></Wrap>;
    const { rerender } = render(view({ op_id: "ui-op-1", done: 3, total: 12, current: ["UC-004"], finished: null }));
    expect(screen.getByTestId("toast-run")).toHaveTextContent("评审中 3/12");
    expect(screen.getByTestId("toast-run")).toHaveTextContent("UC-004 正在评审…（每条约十秒，可以继续做别的）");
    expect(screen.getByTestId("toast-run").querySelector(".bar i")).toHaveStyle({ width: "25%" });
    rerender(view({ op_id: "ui-op-1", done: 12, total: 12, current: [], finished: { passed: 9, failed: 2, unfinished: 1, error: null } }));
    expect(screen.queryByTestId("toast-run")).toBeNull();
    expect(screen.getAllByTestId(/^toast-/).filter((e) => e.classList.contains("tw-toast"))).toHaveLength(1);
    expect(screen.getByTestId("toast-ok")).toHaveTextContent("评审完了：9 条合规，2 条不合规，1 条没有评完（可以再评一次）。");
    fireEvent.click(screen.getByTestId("toast-action"));
    expect(onShow).toHaveBeenCalled();
    rerender(view({ op_id: "ui-op-2", done: 4, total: 4, current: [], finished: { passed: 0, failed: 0, unfinished: 4, error: "模型服务不可用。" } }));
    expect(screen.getByTestId("toast-bad")).toHaveTextContent("评审完了：0 条合规，0 条不合规，4 条没有评完（可以再评一次）。模型服务不可用。");
    act(() => { vi.advanceTimersByTime(20000); });
    expect(screen.getByTestId("toast-bad")).toBeInTheDocument();   // 失败停住
  });

  it("筛选有「评审通过」：评审通过（含只有建议的）的条目", () => {
    panel();
    fireEvent.click(screen.getByText("评审通过"));
    expect(screen.getByTestId("item-UC-002")).toBeInTheDocument();
    expect(screen.queryByTestId("item-UC-003")).toBeNull();
  });
});

describe("徽标与条目详情", () => {
  it("主徽标：评审通过又已读的不挂徽标；评审不通过 N 处（只数问题）、待评审各一枚，悬停写评审结论", () => {
    const t = task([]);
    render(<>
      <ItemStatus task={t} item={item({ item_id: "UC-001", reviews: [{ revision_no: 3, verdict: "合规", findings: [] }] })} />
      <ItemStatus task={t} item={PASSED_WITH_ADVICE} />
      <ItemStatus task={t} item={FAILED} />
      <ItemStatus task={t} item={PENDING_A} />
    </>);
    expect(screen.queryByTestId("state-UC-001")).toBeNull();
    expect(screen.queryByTestId("state-UC-002")).toBeNull();
    expect(screen.getByTestId("state-UC-003")).toHaveTextContent(/^评审不通过 1 处$/);
    expect(screen.getByTestId("state-UC-003")).toHaveClass("failed");
    expect(screen.getByTestId("state-UC-003").title).toContain("评审：不通过 1 处，还没处理");
    expect(screen.getByTestId("state-UC-004")).toHaveTextContent("待评审");
  });

  it("评审不通过：横幅写问题处数；问题红、建议琥珀；点规则编号展开条文；让助手照这条改预填输入框；评审这条只带这个条目", () => {
    const onPrefill = vi.fn();
    const onReview = vi.fn();
    const t = task([FAILED]);
    render(<Wrap><ItemDetail task={t} item={FAILED} def={t.definition.collections[0]} readOnly={false} pending={false}
      submit={vi.fn(async () => null)} onPrefill={onPrefill} onReview={onReview} /></Wrap>);
    expect(screen.getByTestId("review-banner")).toHaveTextContent("评审不通过：1 处问题未处理，标在下面对应的字段旁。");
    expect(screen.getByTestId("finding-problem")).toHaveTextContent("问题：第 2 项：第 2 步没有主语。 改法：写明是系统核对。 违反 UC-R7");
    expect(screen.getAllByTestId("finding-fate")[0]).toHaveTextContent(/^未处理让助手照这条改保留这种写法$/);   // 第二行：去向在前，链接在后
    expect(screen.getByTestId("finding-advice")).toHaveClass("advice");
    expect(screen.queryByTestId("clause-body")).toBeNull();
    fireEvent.click(screen.getByTestId("clause-UC-R7"));
    expect(screen.getByTestId("clause-body")).toHaveTextContent(/^UC-R7（必选）\s+基本流程每一步写明谁做了什么/);
    fireEvent.click(screen.getAllByTestId("fix-finding")[0]);
    expect(onPrefill).toHaveBeenCalledWith("请按评审发现改 UC-003 的基本流程第 2 项：第 2 步没有主语。");
    expect(screen.getByTestId("review-one")).toBeDisabled();   // 当前修订上已经评过：只能「仍要重评」
    expect(onReview).not.toHaveBeenCalled();
    expect(screen.getByTestId("review-records")).toHaveTextContent("评审记录：修订 3 · 不合规 1 处");
  });

  it("问题条目没有「评审这条」", () => {
    const t = task([TBD]);
    render(<Wrap><ItemDetail task={t} item={TBD} def={t.definition.collections[1]} readOnly={false} pending={false}
      submit={vi.fn(async () => null)} onReview={vi.fn()} /></Wrap>);
    expect(screen.queryByTestId("review-one")).toBeNull();
  });
});

describe("完成条件面板里的评审一条", () => {
  const completion: Completion = { all_met: false, unmet_count: 1, conditions: [
    { collection: "功能用例", name: "每个条目评审通过", met: false, state: "unmet", done: 1, total: 4, missing: ["UC-003", "UC-004", "UC-005"], note: "UC-004、UC-005 还没评审；UC-003 评审不合规。" },
  ] };
  const items = [FAILED, PASSED_WITH_ADVICE, PENDING_A, PENDING_B];

  it("分两组写待评审与评审不通过；「评审这 N 条」评待评审的，「打开 X」打开不通过的；不再有评审工具还没有的说法", () => {
    const onReview = vi.fn();
    const onOpen = vi.fn();
    render(<CompletionPanel completion={completion} status="进行中" items={items} onReview={onReview} onOpen={onOpen} />);
    expect(screen.getByTestId("cond-review")).toHaveTextContent("每个条目评审通过：还差 3 条，UC-004、UC-005 待评审；UC-003 评审不通过。");
    fireEvent.click(screen.getByTestId("cond-review-these"));
    expect(onReview).toHaveBeenCalledWith([PENDING_A, PENDING_B]);
    expect(screen.getByTestId("cond-review-these")).toHaveTextContent("评审这 2 条");
    fireEvent.click(screen.getByTestId("cond-open-UC-003"));
    expect(onOpen).toHaveBeenCalledWith("UC-003");
    cleanup();
    render(<CompletionPanel completion={{ ...completion, all_met: false }} status="已完成" items={items} />);
    expect(screen.queryByText(/评审工具还没有/)).toBeNull();
    expect(screen.queryByTestId("cond-review-these")).toBeNull();
  });

  it("按钮灰化时带原因", () => {
    render(<CompletionPanel completion={completion} items={items} onReview={vi.fn()} reviewOff="助手正在工作，结束之后才能发起评审。" />);
    expect(screen.getByTestId("cond-review-these")).toBeDisabled();
  });
});

describe("工作视图状态消费评审事件", () => {
  it("review_progress 与 review_finished 更新进度；review_unfinished 不造成序号缺口", () => {
    const snapshot = { seq: 10, generated_at: "", executor: { state: "idle", text: "", active_session: "S" }, session: null,
      task: task([PENDING_A, PENDING_B]), materials: [], conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null } as Snapshot;
    let s = workReducer(initialWorkState("S"), { type: "snapshot", snapshot });
    s = workReducer(s, { type: "sse", event: "review_progress", data: { seq: 11, op_id: "ui-op-1", done: 0, total: 2, current: ["UC-004", "UC-005"], item_id: null } });
    expect(s.review).toEqual({ op_id: "ui-op-1", done: 0, total: 2, current: ["UC-004", "UC-005"], finished: null });
    s = workReducer(s, { type: "sse", event: "review_recorded", data: { seq: 12, item_id: "UC-004", revision_no: 3, verdict: "合规", findings: [], at: "" } });
    s = workReducer(s, { type: "sse", event: "review_unfinished", data: { seq: 13, item_id: "UC-005", revision_no: 3, reason: "超时" } });
    s = workReducer(s, { type: "sse", event: "review_finished", data: { seq: 14, op_id: "ui-op-1", total: 2, passed: 1, failed: 0, unfinished: 1, results: [], error: null } });
    expect(s.phase).toBe("ready");
    expect(s.seq).toBe(14);
    expect(s.review?.finished).toEqual({ passed: 1, failed: 0, unfinished: 1, error: null });
    expect(pendingReview(s.task!).map((i) => i.item_id)).toEqual(["UC-005"]);
    expect(failedReview(s.task!)).toEqual([]);
  });
});
