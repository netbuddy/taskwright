// 评审页签与评审的生命周期：页签渲染与发现状态三种（未处理、已在修订 N 改、已保留）、只看未处理、保留与撤销、规则开关、
// 对话区一句提示、「仍要重评」确认、规则改了之后回到待评审、完成条件三类、工作视图状态消费四种新事件。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Completion, Item, ReviewBatch, Snapshot, Task, UiActionNoted } from "../api/types";
import { ReviewPanel } from "../components/work/ReviewPanel";
import { ItemDetail } from "../components/work/ItemDetail";
import { CompletionPanel } from "../components/CompletionPanel";
import { Conversation } from "../components/work/Conversation";
import { initialWorkState, workReducer } from "../state/workState";
import { findingStatus, needsRereview, openProblems, pendingReview, reviewState } from "../model/items";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
afterEach(() => cleanup());
const noop = () => {};

const P = (id: string, text: string) => ({ rule_id: id, level: "必选", field: "基本流程", index: 1, problem: text, suggestion: "写明主语。" });
const A = (id: string, text: string) => ({ rule_id: id, level: "可选", field: "约束规则", index: null, problem: text, suggestion: null });
const H = "h1";

function item(over: Partial<Item> & Pick<Item, "item_id">): Item {
  return {
    collection: "功能用例", title: over.item_id, revision_no: 6, revision_by: "executor", revision_at: "", revisions: [6],
    fields: { 用例名称: over.item_id, 基本流程: ["一", "二"], 约束规则: ["三"] }, sources: [], reviews: [], waivers: [],
    confirmations: [{ revision_no: 6, accepted: true, basis: "viewed" }], confirmation_stale: false, ...over,
  };
}

const BATCH3: ReviewBatch = { no: 3, batch_id: "ui-op-3", at: "2026-09-24T10:12:00+08:00", started_by: "user", scope: "pending",
  items: [{ item_id: "CON-002", revision_no: 6 }, { item_id: "UC-003", revision_no: 15 }, { item_id: "UC-004", revision_no: 6 }, { item_id: "UC-001", revision_no: 6 }],
  total: 4, passed: 1, failed: 3, unfinished: 0, problems: 3, advice: 1 };
const BATCH2: ReviewBatch = { ...BATCH3, no: 2, batch_id: "ui-op-2", started_by: "executor", scope: "named", items: [{ item_id: "UC-001", revision_no: 6 }],
  total: 1, passed: 1, failed: 0, problems: 0, advice: 0 };

// CON-002：修订 6 不合规，修订 8 改过并合规 → 已在修订 8 改；UC-003：修订 15 不合规、有保留 → 已保留；UC-001 合规。
const CON2 = item({ item_id: "CON-002", collection: "功能用例", revision_no: 8, revisions: [6, 8], reviews: [
  { revision_no: 6, verdict: "不合规", findings: [P("EARS-R7", "比较方向不一致。"), A("EARS-R9", "描述的是功能。")], batch_id: "ui-op-3", rules_hash: H },
  { revision_no: 8, verdict: "合规", findings: [], batch_id: "ui-op-4", rules_hash: H }] });
const UC3 = item({ item_id: "UC-003", revision_no: 15, revisions: [15], reviews: [
  { revision_no: 15, verdict: "不合规", findings: [P("UC-R13", "第 2 步用了「等」。")], batch_id: "ui-op-3", rules_hash: H }],
  waivers: [{ revision_no: 15, reason: "材料原话如此", source: "panel", revoked: false }] });
const UC4 = item({ item_id: "UC-004", reviews: [{ revision_no: 6, verdict: "不合规", findings: [P("UC-R7", "第 2 步没有主语。")], batch_id: "ui-op-3", rules_hash: H }] });
const UC1 = item({ item_id: "UC-001", reviews: [{ revision_no: 6, verdict: "合规", findings: [A("UC-R12", "举了例子。")], batch_id: "ui-op-3", rules_hash: H }] });

function task(items: Item[], over: Partial<Task> = {}): Task {
  return {
    task_id: "TASK-1", task_name: "t", task_type: "t", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [{ name: "功能用例", prefix: "UC", needs_review: true, rules_hash: H, fields: [
      { name: "用例名称", type: "文本", required: true, values: null }, { name: "基本流程", type: "文本列表", required: true, values: null },
      { name: "约束规则", type: "文本列表", required: false, values: null }],
      review_rules: [{ id: "UC-R7", level: "必选", text: "每一步写明谁做了什么。" }],
      rule_switches: { off: ["UC-R13"], promote: [] },
      all_rules: [
        { id: "UC-R7", level: "必选", text: "每一步写明谁做了什么。", state: "required" },
        { id: "UC-R12", level: "可选", text: "不举例。", state: "optional" },
        { id: "UC-R13", level: "可选", text: "不用「等」。", state: "off" },
      ] }] },
    completion: null, items, latest_revision: 15, review_batches: [BATCH2, BATCH3], ...over,
  };
}

function panel(t: Task, props: Partial<Parameters<typeof ReviewPanel>[0]> = {}) {
  const submit = vi.fn(async () => null);
  const onReview = vi.fn();
  const onPrefill = vi.fn();
  const onOpenFinding = vi.fn();
  render(<Wrap><ReviewPanel task={t} readOnly={false} writesOff={false} onReview={onReview} submit={submit} onOpenFinding={onOpenFinding}
    onPrefill={onPrefill} {...props} /></Wrap>);
  return { submit, onReview, onPrefill, onOpenFinding };
}

describe("评审页签", () => {
  it("顶部计数、第几次评审的卡片（最新展开、早先的变淡）、发现状态三种、合规的折成一行", () => {
    panel(task([CON2, UC3, UC4, UC1]));
    expect(screen.getByTestId("review-panel")).toHaveTextContent("2 次评审 · 未处理的问题 1 处");
    const card = screen.getByTestId("batch-3");
    expect(card).toHaveTextContent("第 3 次评审");
    expect(card).toHaveTextContent("由你发起 · 4 条");
    expect(card).toHaveTextContent("问题 3 处 · 建议 1 条");
    const con = within(card).getByTestId("batch-3-item-CON-002");
    expect(within(con).getAllByTestId("rv-status")[0]).toHaveTextContent("已在修订 8 改");
    expect(within(card).getByTestId("batch-3-item-UC-003")).toHaveTextContent("已保留：材料原话如此");
    expect(within(card).getByTestId("batch-3-item-UC-004")).toHaveTextContent("未处理");
    expect(within(card).getByTestId("batch-3-passed")).toHaveTextContent("UC-001 1 条合规（其中 1 条有建议）");
    expect(screen.getByTestId("batch-2")).toHaveClass("old");
    expect(screen.getByTestId("batch-2")).toHaveTextContent("由助手发起（你在对话里要求）");
    expect(within(screen.getByTestId("batch-2")).queryByTestId("batch-2-passed")).toBeNull();   // 早先的折起
  });

  it("只看未处理：已改、已保留的条目不列；「保留 X 现在的写法」只出现在未处理的条目旁，带理由发 waive_review", async () => {
    const { submit, onPrefill } = panel(task([CON2, UC3, UC4, UC1]));
    expect(screen.queryByTestId("keep-CON-002")).toBeNull();
    expect(screen.queryByTestId("keep-UC-003")).toBeNull();
    fireEvent.change(screen.getByTestId("keep-reason-UC-004"), { target: { value: "材料原话" } });
    fireEvent.click(screen.getByTestId("keep-UC-004"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: "waive_review", targets: [{ item_id: "UC-004", base_revision: 6 }],
      fields: { reason: "材料原话", source: "panel" }, notify_executor: false }, "保留 UC-004 现在的写法"));
    fireEvent.click(screen.getByTestId("fix-UC-004"));
    expect(onPrefill).toHaveBeenCalledWith("请按第 3 次评审的发现改 UC-004：第 2 步没有主语。");
    fireEvent.click(screen.getByTestId("review-only-open"));
    expect(screen.queryByTestId("batch-3-item-CON-002")).toBeNull();
    expect(screen.queryByTestId("batch-3-item-UC-003")).toBeNull();
    expect(screen.getByTestId("batch-3-item-UC-004")).toBeInTheDocument();
  });

  it("点规则编号展开条文；点发现打开条目并指到字段", () => {
    const { onOpenFinding } = panel(task([UC4]));
    fireEvent.click(within(screen.getByTestId("batch-3-item-UC-004")).getByTestId("rv-clause-UC-R7"));
    expect(screen.getByTestId("batch-3-item-UC-004")).toHaveTextContent("UC-R7（必选） 每一步写明谁做了什么。");
    fireEvent.click(within(screen.getByTestId("batch-3-item-UC-004")).getByText(/第 2 步没有主语/));
    expect(onOpenFinding).toHaveBeenCalledWith("UC-004", "基本流程");
  });

  it("规则区：必选的锁住；可选的开关发 set_review_rules，点「可选」升为必选，已关闭的可以打开", async () => {
    const { submit } = panel(task([UC4]));
    fireEvent.click(screen.getByTestId("rule-switch-UC-R7"));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByTestId("rule-level-UC-R7")).toHaveTextContent("必选");
    fireEvent.click(screen.getByTestId("rule-switch-UC-R12"));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith({ kind: "set_review_rules", targets: [],
      fields: { collection: "功能用例", off: ["UC-R13", "UC-R12"], promote: [] }, notify_executor: false }, "关闭规则 UC-R12"));
    fireEvent.click(screen.getByTestId("rule-level-UC-R12"));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { collection: "功能用例", off: ["UC-R13"], promote: ["UC-R12"] } }), "把 UC-R12 升为必选"));
    expect(screen.getByTestId("rule-level-UC-R13")).toHaveTextContent("已关闭");
    fireEvent.click(screen.getByTestId("rule-switch-UC-R13"));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { collection: "功能用例", off: [], promote: [] } }), "打开规则 UC-R13"));
  });

  it("规则改了（指纹变了）：顶部提示几条需要重评，条目回到待评审", () => {
    const t = task([UC4, UC1]);
    const changed = { ...t, definition: { collections: [{ ...t.definition.collections[0], rules_hash: "h2" }] } };
    expect(pendingReview(changed).map((i) => i.item_id)).toEqual(["UC-004", "UC-001"]);
    expect(needsRereview(changed)).toHaveLength(2);
    panel(changed);
    expect(screen.getByTestId("rules-changed")).toHaveTextContent("规则改了，2 条需要重评。");
    expect(screen.getByTestId("review-panel-all")).toHaveTextContent("评审 2 条待评审的条目");
  });
});

describe("发现状态派生与计数", () => {
  it("已在修订 N 改、已保留、未处理；撤销保留之后回到未处理；未处理的问题数只数问题", () => {
    expect(findingStatus(CON2, CON2.reviews[0])).toEqual({ kind: "fixed", revision: 8 });
    expect(findingStatus(UC3, UC3.reviews[0])).toEqual({ kind: "kept", reason: "材料原话如此" });
    expect(findingStatus(UC4, UC4.reviews[0])).toEqual({ kind: "open" });
    const revoked = { ...UC3, waivers: [{ ...UC3.waivers![0], revoked: true }] };
    expect(findingStatus(revoked, revoked.reviews[0])).toEqual({ kind: "open" });
    expect(openProblems(task([CON2, UC3, UC4, UC1]))).toBe(1);
    const s = reviewState(UC3, task([UC3]));
    expect(s.state === "failed" && s.kept?.reason).toBe("材料原话如此");
  });
});

describe("条目详情", () => {
  it("发现旁写状态与第几次评审；「保留这种写法」带理由发 waive_review（来源 detail）；评过的条目「评审这条」灰化，「仍要重评」确认后带 force", async () => {
    const t = task([UC4]);
    const submit = vi.fn(async () => null);
    const onReview = vi.fn();
    render(<Wrap><ItemDetail task={t} item={UC4} def={t.definition.collections[0]} readOnly={false} pending={false} submit={submit} onReview={onReview} /></Wrap>);
    expect(screen.getByTestId("finding-status")).toHaveTextContent("未处理 · 第 3 次评审");
    fireEvent.click(screen.getByTestId("keep-finding"));
    fireEvent.change(screen.getByTestId("keep-finding-reason"), { target: { value: "先照抄" } });
    fireEvent.click(screen.getByTestId("keep-finding-ok"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: "waive_review", targets: [{ item_id: "UC-004", base_revision: 6 }],
      fields: { reason: "先照抄", source: "detail" }, notify_executor: false }, "保留 UC-004 现在的写法"));
    expect(screen.getByTestId("review-one")).toBeDisabled();
    expect(screen.getByTestId("review-one").getAttribute("title")).toContain("已经评过（第 3 次评审），内容和规则都没变");
    fireEvent.click(screen.getByTestId("review-again"));
    fireEvent.click(await screen.findByText("再评一次"));
    expect(onReview).toHaveBeenCalledWith(true);
  });

  it("保留之后横幅改为琥珀色，写理由，「撤销保留」发 unwaive_review", async () => {
    const t = task([UC3]);
    const submit = vi.fn(async () => null);
    render(<Wrap><ItemDetail task={t} item={UC3} def={t.definition.collections[0]} readOnly={false} pending={false} submit={submit} /></Wrap>);
    expect(screen.getByTestId("kept-banner")).toHaveTextContent("你保留了现在的写法（修订 15）：材料原话如此");
    expect(screen.queryByTestId("review-banner")).toBeNull();
    fireEvent.click(screen.getByTestId("unwaive"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: "unwaive_review", targets: [{ item_id: "UC-003", base_revision: 15 }], notify_executor: false },
      "撤销对 UC-003 的保留"));
  });
});

describe("完成条件与对话区", () => {
  it("完成条件评审一条三类分开写，保留的注明计入通过", () => {
    const completion: Completion = { all_met: false, unmet_count: 1, conditions: [
      { collection: "功能用例", name: "每个条目评审通过", met: false, state: "unmet", done: 2, total: 4, missing: ["UC-004", "UC-005"], note: "" }] };
    const UC5 = item({ item_id: "UC-005" });
    const t = task([UC1, UC3, UC4, UC5]);
    render(<CompletionPanel completion={completion} items={t.items} task={t} onReview={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByTestId("cond-review")).toHaveTextContent("还差 2 条，UC-005 待评审；UC-004 评审不通过；UC-003 评审不通过但你保留了，计入通过。");
  });

  it("评审结束在对话区只写一句结论，「看评审页签」切过去", () => {
    const onShow = vi.fn();
    const note: UiActionNoted = { type: "ui_action_noted", message_id: "m1", at: "", text: "界面操作……", event_seq: 9, undoable: false,
      kind: "request_review", review: { total: 16, passed: 12, failed: 4, unfinished: 0, problems: 5, advice: 3 } };
    render(<Wrap><Conversation messages={[note]} currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
      handlers={{} as never} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop} hasEarlier={false} onLoadEarlier={noop}
      revisionOf={() => null} attachments={[]} onShowReviews={onShow} /></Wrap>);
    expect(screen.getByTestId("review-done")).toHaveTextContent("评审完成：12 条合规、4 条不合规（问题 5 处、建议 3 条）。看评审页签 ›");
    fireEvent.click(screen.getByTestId("show-reviews"));
    expect(onShow).toHaveBeenCalled();
  });
});

describe("工作视图状态消费四种新事件", () => {
  it("review_batch 加进批次；review_waived 与 review_unwaived 改保留；review_rules_changed 换上规则与指纹", () => {
    const snapshot = { seq: 10, generated_at: "", executor: { state: "idle", text: "", active_session: "S" }, session: null,
      task: task([UC4], { review_batches: [] }), materials: [], conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null } as Snapshot;
    let s = workReducer(initialWorkState("S"), { type: "snapshot", snapshot });
    s = workReducer(s, { type: "sse", event: "review_batch", data: { ...BATCH3, seq: 11, task_id: "TASK-1", completion: null } });
    expect(s.task!.review_batches!.map((b) => b.no)).toEqual([3]);
    s = workReducer(s, { type: "sse", event: "review_waived", data: { seq: 12, at: "", task_id: "TASK-1", items: [{ item_id: "UC-004", revision_no: 6 }], reason: "r", source: "panel" } });
    expect(reviewState(s.task!.items[0], s.task!)).toMatchObject({ state: "failed", kept: { reason: "r" } });
    s = workReducer(s, { type: "sse", event: "review_unwaived", data: { seq: 13, at: "", task_id: "TASK-1", items: [{ item_id: "UC-004", revision_no: 6 }] } });
    expect(reviewState(s.task!.items[0], s.task!)).toMatchObject({ state: "failed", kept: null });
    s = workReducer(s, { type: "sse", event: "review_rules_changed", data: { seq: 14, at: "", task_id: "TASK-1", collection: "功能用例", off: ["UC-R12"], promote: [],
      rules_hash: "h2", rule_switches: { off: ["UC-R12"], promote: [] } } });
    expect(s.seq).toBe(14);
    expect(s.task!.definition.collections[0].rules_hash).toBe("h2");
    expect(reviewState(s.task!.items[0], s.task!).state).toBe("pending");
  });
});
