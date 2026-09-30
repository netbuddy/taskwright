// 评审页签与评审的生命周期：页签的顶上一行五种现状、要处理的／建议／已经没事的／评审记录四块、保留与撤销、问题很多时的折叠、
// 评审进行中、规则面板与开关；发现状态派生、对话区一句提示、评过的条目不能再评、同一修订上有几条记录时以最后一条为准（早期数据）、规则改了之后回到待评审、完成条件三类、
// 工作视图状态消费四种新事件。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Completion, Item, ReviewBatch, Snapshot, Task, UiActionNoted } from "../api/types";
import { ReviewPanel } from "../components/work/ReviewPanel";
import { ItemDetail } from "../components/work/ItemDetail";
import { CompletionPanel } from "../components/CompletionPanel";
import { Conversation } from "../components/work/Conversation";
import { initialWorkState, workReducer, type ReviewRun } from "../state/workState";
import { BUSY_TEXT, failedReview, findingStatus, itemVerdict, needsRereview, openProblems, pendingReview, reviewState } from "../model/items";
import { batchSentence, findingWhere } from "../model/reviewTab";
import { formatTime } from "../model/format";

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
  // 固定数据：CON-002 修订 8 通过（修订 6 的问题已经改掉）；UC-003 不通过、已保留；UC-004 不通过（1 处问题）；UC-001 通过、带 1 条建议。
  const all = () => task([CON2, UC3, UC4, UC1]);
  const text = () => screen.getByTestId("review-panel").textContent ?? "";

  it("顶上一行：有问题要处理时写处数（与页签行上的个数同一个函数），不给按钮；页签里不出现合规、修订号、第几次评审、未处理、必选可选这些说法", () => {
    const t = all();
    panel(t);
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^有 1 处问题等你处理。$/);
    expect(screen.getByTestId("review-now").querySelector("em")).toHaveTextContent(String(openProblems(t)));
    expect(screen.queryByTestId("review-panel-all")).toBeNull();
    for (const key of ["advice", "done", "log"]) fireEvent.click(screen.getByTestId(`review-${key}-toggle`));
    expect(text()).not.toMatch(/合规|修订 \d|第 \d+ 次评审|未处理|必选|可选|只看/);
  });

  it("顶上一行：有还没评审的条目时写个数并给唯一的主按钮，点了评审全部待评审的；同时有问题时两句都写，先写还没评审的", () => {
    const fresh = item({ item_id: "UC-008", reviews: [] });
    const { onReview } = panel(task([fresh, UC4]));
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^1 个条目还没有评审。有 1 处问题等你处理。$/);
    fireEvent.click(screen.getByTestId("review-panel-all"));
    expect(screen.getByTestId("review-panel-all")).toHaveTextContent(/^评审这 1 个条目$/);
    expect(onReview).toHaveBeenCalledWith([], "评审 1 个条目");
    cleanup();
    panel(task([fresh]), { writesOff: true });
    expect(screen.getByTestId("review-panel-all")).toBeDisabled();
    expect(screen.getByTestId("review-panel-all")).toHaveAttribute("title", "助手正在工作，结束之后才能发起评审。");
  });

  it("顶上一行：评审正在进行时写评完几个，按钮灰掉写「正在评审」，下面一条进度线；评完之后不再写", () => {
    const fresh = item({ item_id: "UC-008", reviews: [] });
    const running = { op_id: "op-1", done: 2, total: 5, current: ["UC-008"], finished: null };
    panel(task([fresh]), { review: running });
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^正在评审，已经评完 2 个，共 5 个。$/);
    expect(screen.getByTestId("review-panel-all")).toBeDisabled();
    expect(screen.getByTestId("review-panel-all")).toHaveTextContent(/^正在评审$/);
    expect(screen.getByTestId("review-progress")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByTestId("review-progress")).toHaveAttribute("aria-valuemax", "5");
    cleanup();
    panel(task([fresh]), { review: { ...running, done: 5, finished: { passed: 5, failed: 0, unfinished: 0, error: null } } });
    expect(screen.queryByTestId("review-progress")).toBeNull();
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^1 个条目还没有评审。$/);
  });

  it("顶上一行：全部通过时一个绿色的小对勾；还没有条目时只写一句；两种都没有按钮", () => {
    panel(task([CON2, UC1]));
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^全部条目都已经通过评审。$/);
    expect(screen.getByTestId("review-okmark")).toBeInTheDocument();
    expect(screen.queryByTestId("review-panel-all")).toBeNull();
    expect(screen.queryByTestId("review-todo")).toBeNull();
    expect(screen.queryByTestId("review-advice")).not.toBeNull();   // UC-001 的建议
    cleanup();
    panel(task([]));
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^还没有条目可以评审。$/);
    expect(screen.queryByTestId("review-panel-all")).toBeNull();
    expect(screen.queryByTestId("review-log")).not.toBeNull();   // 批次还在
  });

  it("规则改过：顶上一行写要重新评审的个数，不另有横幅与按钮；只有一部分是因为规则改过时两种一起写", () => {
    const t = task([UC4, UC1]);
    const changed = { ...t, definition: { collections: [{ ...t.definition.collections[0], rules_hash: "h2" }] } };
    expect(pendingReview(changed).map((i) => i.item_id)).toEqual(["UC-004", "UC-001"]);
    expect(needsRereview(changed)).toHaveLength(2);
    panel(changed);
    expect(screen.getByTestId("rules-changed")).toHaveTextContent(/^规则改过，2 个条目要重新评审。$/);
    expect(screen.getByTestId("review-panel-all")).toHaveTextContent(/^评审这 2 个条目$/);
    expect(screen.queryByTestId("review-todo")).toBeNull();
    cleanup();
    const mixed = { ...changed, items: [...changed.items, item({ item_id: "UC-008", reviews: [] })] };
    panel(mixed);
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^3 个条目还没有评审，其中 2 个是因为规则改过。$/);
  });

  it("要处理的：按条目分组，组头是编号与标题；每一处写位置（第几项从 1 起数）、说明、改法；标题后面不写个数", () => {
    const { onOpenFinding } = panel(all());
    const todo = screen.getByTestId("review-todo");
    expect(within(todo).getByText("要处理的").textContent).toBe("要处理的");
    const group = within(todo).getByTestId("review-group-UC-004");
    expect(within(group).getByTestId("finding-where")).toHaveTextContent(/^基本流程 第 2 项$/);   // 数据里 index 为 1
    expect(within(group).getByTestId("finding-problem")).toHaveTextContent("第 2 步没有主语。");
    expect(within(group).getByTestId("finding-problem")).toHaveTextContent("改法：写明主语。");
    expect(within(todo).queryByTestId("review-group-UC-003")).toBeNull();   // 已保留的不在这里
    expect(within(todo).queryByTestId("review-group-CON-002")).toBeNull();   // 已经改掉的不在这里
    fireEvent.click(within(group).getByTestId("finding-where"));
    expect(onOpenFinding).toHaveBeenLastCalledWith("UC-004", "基本流程");
    // 夹具里条目的标题就是编号：组头两处都能点，都只打开条目
    for (const e of within(group).getAllByText("UC-004")) {
      fireEvent.click(e);
      expect(onOpenFinding).toHaveBeenLastCalledWith("UC-004", null);
    }
  });

  it("位置：第几项从 0 起存、显示时加 1；不是列表里的某一项时只写字段名", () => {
    expect(findingWhere({ ...P("UC-R7", "x"), index: 0 })).toBe("基本流程 第 1 项");
    expect(findingWhere({ ...P("UC-R7", "x"), index: 4 })).toBe("基本流程 第 5 项");
    expect(findingWhere(A("UC-R12", "x"))).toBe("约束规则");
  });

  it("「让助手照这条改」预填对话框；「依据的规则」原地展开编号与条文、再点收起", () => {
    const { onPrefill } = panel(all());
    const group = screen.getByTestId("review-group-UC-004");
    fireEvent.click(within(group).getByTestId("fix-finding"));
    expect(onPrefill).toHaveBeenCalledWith("请照评审建议的改法改 UC-004 的基本流程第 2 项：写明主语。评审指出的问题是：第 2 步没有主语。");
    fireEvent.click(within(group).getByTestId("clause-UC-R7"));
    expect(within(group).getByTestId("clause-body")).toHaveTextContent(/^UC-R7每一步写明谁做了什么。$/);
    expect(within(group).getByTestId("clause-UC-R7")).toHaveTextContent("收起规则");
    fireEvent.click(within(group).getByTestId("clause-UC-R7"));
    expect(within(group).queryByTestId("clause-body")).toBeNull();
  });

  it("保留这种写法：原地填理由（可以不填），「保留」或回车发 waive_review，「取消」与 Esc 收起；两处以上问题时说明一起算通过", async () => {
    const { submit } = panel(all());
    const group = screen.getByTestId("review-group-UC-004");
    fireEvent.click(within(group).getByTestId("keep-finding"));
    expect(within(group).queryByTestId("keep-finding-note")).toBeNull();   // 只有 1 处
    expect(within(group).queryByTestId("fix-finding")).toBeNull();   // 这一行换成了输入框
    expect(within(group).queryByTestId("clause-UC-R7")).toBeNull();
    fireEvent.click(within(group).getByTestId("keep-finding-cancel"));
    expect(within(group).queryByTestId("keep-finding-reason")).toBeNull();
    fireEvent.click(within(group).getByTestId("keep-finding"));
    fireEvent.keyDown(within(group).getByTestId("keep-finding-reason"), { key: "Escape" });
    expect(within(group).queryByTestId("keep-finding-reason")).toBeNull();
    fireEvent.click(within(group).getByTestId("keep-finding"));
    fireEvent.change(within(group).getByTestId("keep-finding-reason"), { target: { value: "材料原话" } });
    fireEvent.keyDown(within(group).getByTestId("keep-finding-reason"), { key: "Enter" });
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: "waive_review", targets: [{ item_id: "UC-004", base_revision: 6 }],
      fields: { reason: "材料原话", source: "panel" }, notify_executor: false }, "保留 UC-004 现在的写法"));
    cleanup();
    const two = item({ item_id: "UC-009", reviews: [{ revision_no: 6, verdict: "不合规", findings: [P("UC-R7", "甲。"), { ...P("UC-R7", "乙。"), index: 0 }], batch_id: "ui-op-3", rules_hash: H }] });
    const r = panel(task([two]));
    fireEvent.click(screen.getAllByTestId("keep-finding")[1]);
    expect(screen.getByTestId("keep-finding-note")).toHaveTextContent("保留之后，这个条目的 2 处问题都按你的决定算通过。");
    fireEvent.click(screen.getByTestId("keep-finding-ok"));
    await waitFor(() => expect(r.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "waive_review", fields: { reason: "", source: "panel" } }),
      "保留 UC-009 现在的写法"));
  });

  it("你决定保留的：条目一组，逐处写问题、写理由，「撤销保留」发 unwaive_review；写入不可用时灰掉并说明原因", async () => {
    const { submit } = panel(all());
    fireEvent.click(screen.getByTestId("review-done-toggle"));
    const kept = screen.getByTestId("review-kept-UC-003");
    expect(kept).toHaveTextContent("基本流程 第 2 项：第 2 步用了「等」。");
    expect(kept).toHaveTextContent("理由：材料原话如此");
    fireEvent.click(within(kept).getByTestId("unwaive-finding"));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith({ kind: "unwaive_review", targets: [{ item_id: "UC-003", base_revision: 15 }], notify_executor: false },
      "撤销对 UC-003 的保留"));
    cleanup();
    const busy = panel(all(), { writesOff: true });
    expect(screen.getByTestId("keep-finding")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("keep-finding")).toHaveAttribute("title", BUSY_TEXT);
    fireEvent.click(screen.getByTestId("keep-finding"));
    expect(screen.queryByTestId("keep-finding-reason")).toBeNull();
    fireEvent.click(screen.getByTestId("review-done-toggle"));
    expect(screen.getByTestId("unwaive-finding")).toHaveAttribute("title", BUSY_TEXT);
    fireEvent.click(screen.getByTestId("unwaive-finding"));
    expect(busy.submit).not.toHaveBeenCalled();
    expect(screen.getByTestId("fix-finding")).not.toHaveAttribute("aria-disabled");   // 预填照常能用
  });

  it("建议、已经没事的、评审记录：默认收起，点标题展开；个数只在标题里出现一次", () => {
    panel(all());
    expect(screen.getByTestId("review-advice-toggle")).toHaveTextContent(/^建议 1 条不影响通过$/);
    expect(screen.getByTestId("review-done-toggle")).toHaveTextContent(/^已经没事的 3 个条目$/);
    expect(screen.getByTestId("review-log-toggle")).toHaveTextContent(/^评审记录$/);
    expect(screen.queryByTestId("finding-advice")).toBeNull();
    expect(screen.queryByTestId("review-passed-UC-001")).toBeNull();
    expect(screen.queryByTestId("batch-3")).toBeNull();
    fireEvent.click(screen.getByTestId("review-advice-toggle"));
    const advice = within(screen.getByTestId("review-advice")).getByTestId("finding-advice");
    expect(advice).toHaveTextContent("约束规则举了例子。");
    expect(within(advice).queryByTestId("keep-finding")).toBeNull();
    expect(within(advice).getByTestId("fix-finding")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("review-done-toggle"));
    const done = screen.getByTestId("review-done");
    expect(within(done).getByText("通过的")).toBeInTheDocument();
    expect(within(done).getByText("你决定保留的")).toBeInTheDocument();
    expect(within(done).getByTestId("review-passed-CON-002")).toBeInTheDocument();
    expect(within(done).getByTestId("review-passed-UC-001")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("review-log-toggle"));
    const log = screen.getByTestId("review-log");
    expect(within(log).getAllByTestId(/^batch-/).map((e) => e.dataset.testid)).toEqual(["batch-3", "batch-2"]);   // 最新的在上
    expect(screen.getByTestId("batch-3")).toHaveTextContent(`${formatTime(BATCH3.at)}评审了 4 个条目：1 个通过，3 个有问题。`);
    expect(screen.getByTestId("batch-3")).not.toHaveTextContent("由助手发起");
    expect(screen.getByTestId("batch-2")).toHaveTextContent("评审了 1 个条目：1 个通过。由助手发起");
    fireEvent.click(screen.getByTestId("review-advice-toggle"));
    expect(screen.queryByTestId("finding-advice")).toBeNull();
  });

  it("评审记录一行：个数为 0 的不写，没有评完的写在末尾", () => {
    expect(batchSentence({ ...BATCH3, total: 5, passed: 3, failed: 1, unfinished: 1 })).toBe("评审了 5 个条目：3 个通过，1 个有问题，1 个没有评完。");
    expect(batchSentence({ ...BATCH3, total: 2, passed: 0, failed: 2, unfinished: 0 })).toBe("评审了 2 个条目：2 个有问题。");
  });

  it("问题很多时只摊开前三个条目，其余每个折成一行写几处；点这一行在原地摊开，组头的「收起」再折回去", () => {
    const many = ["UC-011", "UC-012", "UC-013", "UC-014", "UC-015"].map((id, i) => item({ item_id: id, reviews: [{ revision_no: 6, verdict: "不合规",
      findings: Array.from({ length: i + 1 }, (_, j) => ({ ...P("UC-R7", `${id} 的第 ${j + 1} 处。`), index: j })), batch_id: "ui-op-3", rules_hash: H }] }));
    panel(task(many));
    const todo = screen.getByTestId("review-todo");
    expect(within(todo).getAllByTestId(/^review-group-/).map((e) => e.dataset.testid)).toEqual(["review-group-UC-011", "review-group-UC-012", "review-group-UC-013"]);
    expect(within(todo).getByTestId("review-folded-UC-014")).toHaveTextContent(/^UC-014UC-0144 处$/);
    expect(within(todo).getByTestId("review-folded-UC-015")).toHaveTextContent("5 处");
    expect(screen.getByTestId("review-now")).toHaveTextContent("有 15 处问题等你处理。");
    fireEvent.click(within(todo).getByTestId("review-folded-UC-014"));
    expect(within(screen.getByTestId("review-group-UC-014")).getAllByTestId("finding-problem")).toHaveLength(4);
    expect(screen.queryByTestId("review-folded-UC-014")).toBeNull();
    fireEvent.click(screen.getByTestId("review-refold-UC-014"));
    expect(screen.getByTestId("review-folded-UC-014")).toBeInTheDocument();
  });

  it("评审进行中：已经评完的条目的问题随评随出现，新出现的一组排在已有的后面，即使它在条目区里排得更前", () => {
    const fresh = (id: string) => item({ item_id: id, reviews: [] });
    const failed = (id: string, text: string) => item({ item_id: id, reviews: [{ revision_no: 6, verdict: "不合规", findings: [P("UC-R7", text)], batch_id: "op-1", rules_hash: H }] });
    const running: ReviewRun = { op_id: "op-1", done: 1, total: 3, current: ["UC-020"], finished: null };
    const view = (items: Item[], review: ReviewRun) => (
      <Wrap><ReviewPanel task={task(items)} review={review} readOnly={false} writesOff={false} onReview={vi.fn()} submit={vi.fn(async () => null)} onOpenFinding={vi.fn()} onPrefill={vi.fn()} /></Wrap>
    );
    const { rerender } = render(view([fresh("UC-020"), failed("UC-021", "甲。"), fresh("UC-022")], running));
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^正在评审，已经评完 1 个，共 3 个。有 1 处问题等你处理。$/);
    expect(within(screen.getByTestId("review-todo")).getAllByTestId(/^review-group-/)).toHaveLength(1);
    rerender(view([failed("UC-020", "乙。"), failed("UC-021", "甲。"), fresh("UC-022")], { ...running, done: 2, current: ["UC-022"] }));
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^正在评审，已经评完 2 个，共 3 个。有 2 处问题等你处理。$/);
    expect(within(screen.getByTestId("review-todo")).getAllByTestId(/^review-group-/).map((e) => e.dataset.testid)).toEqual(["review-group-UC-021", "review-group-UC-020"]);
    cleanup();
    // 重新打开页签时按条目区的顺序
    render(view([failed("UC-020", "乙。"), failed("UC-021", "甲。")], { ...running, done: 3, finished: { passed: 0, failed: 2, unfinished: 0, error: null } }));
    expect(within(screen.getByTestId("review-todo")).getAllByTestId(/^review-group-/).map((e) => e.dataset.testid)).toEqual(["review-group-UC-020", "review-group-UC-021"]);
  });

  it("条目改过之后还没有重新评审：旧的问题不放进要处理的，只算进还没有评审的个数", () => {
    const edited = { ...UC4, revision_no: 7, revisions: [6, 7] };
    panel(task([edited]));
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^1 个条目还没有评审。$/);
    expect(screen.queryByTestId("review-todo")).toBeNull();
    expect(text()).not.toContain("第 2 步没有主语");
  });

  it("评审规则：页签最下面一行写共几条、开着几条，点了滑出面板；「关闭」、点左边一窄条或 Esc 收回", () => {
    panel(all());
    expect(screen.queryByTestId("rules-area")).toBeNull();
    expect(screen.getByTestId("rules-link")).toHaveTextContent(/^评审规则（共 3 条，开着 2 条）$/);
    fireEvent.click(screen.getByTestId("rules-link"));
    expect(screen.getByTestId("rules-area")).toHaveTextContent("带锁的不能关；其余的可以关掉，只对这个任务生效。改动只影响之后的评审。");
    expect(within(screen.getByTestId("rules-area")).getByText("功能用例")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("rules-close"));
    expect(screen.queryByTestId("rules-area")).toBeNull();
    fireEvent.click(screen.getByTestId("rules-link"));
    fireEvent.click(screen.getByTestId("rules-scrim"));
    expect(screen.queryByTestId("rules-area")).toBeNull();
    fireEvent.click(screen.getByTestId("rules-link"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("rules-area")).toBeNull();
  });

  it("规则面板：每行只有开关、编号、条文，没有级别标签与升为必选的入口；必选的锁住；可选的开关发 set_review_rules，已关闭的可以打开", async () => {
    const { submit } = panel(task([UC4]));
    fireEvent.click(screen.getByTestId("rules-link"));
    for (const id of ["UC-R7", "UC-R12", "UC-R13"]) {
      expect(screen.getByTestId(`rule-${id}`).children).toHaveLength(3);
      expect(screen.getByTestId(`rule-${id}`)).not.toHaveTextContent(/必选|可选|已关闭/);
    }
    expect(screen.getByTestId("rules-area").querySelector(".chip")).toBeNull();
    fireEvent.click(screen.getByTestId("rule-switch-UC-R7"));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("rule-switch-UC-R12"));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith({ kind: "set_review_rules", targets: [],
      fields: { collection: "功能用例", off: ["UC-R13", "UC-R12"], promote: [] }, notify_executor: false }, "关闭规则 UC-R12"));
    fireEvent.click(screen.getByTestId("rule-switch-UC-R13"));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { collection: "功能用例", off: [], promote: [] } }), "打开规则 UC-R13"));
  });

  it("规则面板：已经升为必选的规则照开着的显示（绿色、不带锁），悬停提示写明已经升为必选；关掉时一并撤销升为必选", async () => {
    const t = task([UC4]);
    t.definition.collections[0].all_rules!.push({ id: "UC-R14", level: "可选", text: "原样写出数值。", state: "promoted" });
    t.definition.collections[0].rule_switches = { off: ["UC-R13"], promote: ["UC-R14"] };
    const { submit } = panel(t);
    fireEvent.click(screen.getByTestId("rules-link"));
    const sw = screen.getByTestId("rule-switch-UC-R14");
    expect(sw).toHaveClass("on");
    expect(sw).not.toHaveClass("lock");
    expect(sw).toHaveAttribute("title", "这条规则已经升为必选，违反它算问题。关掉它会同时撤销升为必选。");
    expect(sw).toHaveAttribute("aria-label", "规则 UC-R14：开着，已经升为必选");
    fireEvent.click(sw);
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { collection: "功能用例", off: ["UC-R13", "UC-R14"], promote: [] } }), "关闭规则 UC-R14"));
  });

  it("规则面板：必选规则的开关是开着的（绿色）并在圆点对面画锁，读屏说明写必选、不能关；别的三种状态不画锁", () => {
    const t = task([UC4]);
    t.definition.collections[0].all_rules!.push({ id: "UC-R14", level: "可选", text: "原样写出数值。", state: "promoted" });
    panel(t);
    fireEvent.click(screen.getByTestId("rules-link"));
    const req = screen.getByTestId("rule-switch-UC-R7");
    expect(req).toHaveClass("sw-switch", "on", "lock");
    expect(req).toHaveAttribute("aria-checked", "true");
    expect(req).toHaveAttribute("aria-disabled", "true");
    expect(req).toHaveAttribute("aria-label", "规则 UC-R7：必选，不能关");
    expect(req).toHaveAttribute("title", "必选规则不能关");
    expect(within(req).getByTestId("rule-lock")).toBeInTheDocument();
    for (const [id, on] of [["UC-R12", true], ["UC-R13", false], ["UC-R14", true]] as const) {
      const sw = screen.getByTestId(`rule-switch-${id}`);
      expect(sw).not.toHaveClass("lock");
      expect(sw.classList.contains("on")).toBe(on);
      expect(within(sw).queryByTestId("rule-lock")).toBeNull();
      expect(sw.getAttribute("aria-label")).toMatch(new RegExp(`^规则 ${id}：${on ? "开着" : "关着"}`));
    }
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

describe("规则改过之后按旧规则评出的发现", () => {
  // 集合的指纹从 h1 改成 h2。UC-004：只有旧规则下的不合规，还没重评；UC-005：旧规则下不合规，按新规则重评仍不合规；
  // UC-006：按新规则重评不合规、之后保留；UC-007：按新规则重评合规。
  const OLD = (id: string) => ({ revision_no: 6, verdict: "不合规", findings: [P("UC-R7", `${id} 旧规则下的问题。`)], batch_id: "ui-op-3", rules_hash: H, seq: 10 });
  const NEW_FAIL = (id: string) => ({ revision_no: 6, verdict: "不合规", findings: [P("UC-R7", `${id} 新规则下的问题。`)], batch_id: "ui-op-5", rules_hash: "h2", seq: 20 });
  const U4 = item({ item_id: "UC-004", reviews: [OLD("UC-004")] });
  const U5 = item({ item_id: "UC-005", reviews: [OLD("UC-005"), NEW_FAIL("UC-005")] });
  const U6 = item({ item_id: "UC-006", reviews: [OLD("UC-006"), NEW_FAIL("UC-006")],
    waivers: [{ revision_no: 6, reason: "照材料", source: "panel", revoked: false, seq: 30 }] });
  const U7 = item({ item_id: "UC-007", reviews: [OLD("UC-007"), { revision_no: 6, verdict: "合规", findings: [], batch_id: "ui-op-5", rules_hash: "h2", seq: 20 }] });
  const ids = ["UC-004", "UC-005", "UC-006", "UC-007"].map((item_id) => ({ item_id, revision_no: 6 }));
  const OLD_BATCH: ReviewBatch = { ...BATCH3, items: ids, total: 4, passed: 0, failed: 4, problems: 4, advice: 0 };
  const NEW_BATCH: ReviewBatch = { ...BATCH3, no: 5, batch_id: "ui-op-5", items: ids.slice(1), total: 3, passed: 1, failed: 2, problems: 2, advice: 0 };
  const changed = () => {
    const t = task([U4, U5, U6, U7], { review_batches: [OLD_BATCH, NEW_BATCH] });
    return { ...t, definition: { collections: [{ ...t.definition.collections[0], rules_hash: "h2" }] } };
  };

  it("处理状态：旧规则下的一律是按改之前的规则评出，不管后来是否重评、保留；新规则下的照旧", () => {
    const t = changed();
    for (const i of [U4, U5, U6, U7]) expect(findingStatus(i, i.reviews[0], t)).toEqual({ kind: "old_rules" });
    expect(findingStatus(U5, U5.reviews[1], t)).toEqual({ kind: "open" });
    expect(findingStatus(U6, U6.reviews[1], t)).toEqual({ kind: "kept", reason: "照材料" });
    // 不给任务（不按指纹区分）时照旧。
    expect(findingStatus(U4, U4.reviews[0])).toEqual({ kind: "open" });
  });

  it("页签：旧规则下的发现不显示、不算要处理的；只有旧规则下记录的条目算进要重新评审的个数；角标与顶上一行的处数相等", () => {
    const t = changed();
    panel(t);
    for (const key of ["advice", "done", "log"]) if (screen.queryByTestId(`review-${key}-toggle`)) fireEvent.click(screen.getByTestId(`review-${key}-toggle`));
    const badge = openProblems(t);
    expect(badge).toBe(1);   // 只有 UC-005 按新规则不合规、没有保留
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^规则改过，1 个条目要重新评审。有 1 处问题等你处理。$/);
    expect(screen.getAllByTestId("finding-problem")).toHaveLength(badge);
    expect(screen.getByTestId("review-group-UC-005")).toHaveTextContent("UC-005 新规则下的问题。");
    expect(screen.getByTestId("review-panel")).not.toHaveTextContent("旧规则下的问题");
    expect(screen.getByTestId("review-kept-UC-006")).toHaveTextContent("理由：照材料");
    expect(screen.getByTestId("review-passed-UC-007")).toBeInTheDocument();
  });
});

describe("条目详情", () => {
  it("发现旁写状态与第几次评审；「保留这种写法」带理由发 waive_review（来源 detail）；评过的条目「评审这条」灰化，没有再评的入口", async () => {
    const t = task([UC4]);
    const submit = vi.fn(async () => null);
    const onReview = vi.fn();
    render(<Wrap><ItemDetail task={t} item={UC4} def={t.definition.collections[0]} readOnly={false} pending={false} submit={submit} onReview={onReview} /></Wrap>);
    expect(screen.getByTestId("finding-problem")).toHaveTextContent("第 3 次评审指出");
    expect(screen.getByTestId("finding-status")).toHaveTextContent(/^未处理$/);
    fireEvent.click(screen.getByTestId("keep-finding"));
    fireEvent.change(screen.getByTestId("keep-finding-reason"), { target: { value: "先照抄" } });
    fireEvent.click(screen.getByTestId("keep-finding-ok"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: "waive_review", targets: [{ item_id: "UC-004", base_revision: 6 }],
      fields: { reason: "先照抄", source: "detail" }, notify_executor: false }, "保留 UC-004 现在的写法"));
    expect(screen.getByTestId("review-one")).toBeDisabled();
    expect(screen.getByTestId("review-one").getAttribute("title"))
      .toBe("这条在当前修订上已经评过，内容和规则都没变。没有通过：可以照发现修改之后再评，或者保留这种写法。");
    expect(screen.queryByTestId("review-again")).toBeNull();
    expect(screen.queryByText("仍要重评")).toBeNull();
    fireEvent.click(screen.getByTestId("review-one"));
    expect(onReview).not.toHaveBeenCalled();
  });

  it("评审通过或已保留的条目：「评审这条」灰化，说明只有前半句", () => {
    for (const one of [UC1, UC3]) {
      const t = task([one]);
      render(<Wrap><ItemDetail task={t} item={one} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} onReview={vi.fn()} /></Wrap>);
      expect(screen.getByTestId("review-one")).toBeDisabled();
      expect(screen.getByTestId("review-one").getAttribute("title")).toBe("这条在当前修订上已经评过，内容和规则都没变。");
      cleanup();
    }
  });

  it("全部问题都已保留时不显示横幅；理由与「撤销保留」只在发现行第二行；徽标写「评审不通过 N 处 · 已保留」", async () => {
    const t = task([UC3]);
    const submit = vi.fn(async () => null);
    render(<Wrap><ItemDetail task={t} item={UC3} def={t.definition.collections[0]} readOnly={false} pending={false} submit={submit} /></Wrap>);
    expect(screen.queryByTestId("review-banner")).toBeNull();
    expect(screen.queryByTestId("kept-banner")).toBeNull();
    expect(screen.getByTestId("state-UC-003")).toHaveTextContent("评审不通过 1 处 · 已保留");
    expect(screen.getByTestId("state-UC-003")).toHaveClass("kept");
    expect(screen.getByTestId("finding-fate")).toHaveTextContent("已保留 · 理由：材料原话如此");
    fireEvent.click(screen.getByTestId("unwaive-finding"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: "unwaive_review", targets: [{ item_id: "UC-003", base_revision: 15 }], notify_executor: false },
      "撤销对 UC-003 的保留"));
  });
});

// 同一修订上有几条记录只出现在「同一次修订只评一次」之前留下的数据里；以最后一条（事件序号最大）为准。
describe("同一修订上有几条记录：以最后一条为准", () => {
  const PASS6 = { revision_no: 6, verdict: "合规", findings: [], batch_id: "ui-op-2", rules_hash: H };
  const FAIL6 = { revision_no: 6, verdict: "不合规", findings: [P("UC-R7", "第 2 步没有主语。")], batch_id: "ui-op-3", rules_hash: H };
  // 先合规、后来强制重评成不合规（试跑里遇到的样子）
  const AGAIN = item({ item_id: "UC-005", reviews: [{ ...PASS6, seq: 10 }, { ...FAIL6, seq: 12, forced: true }] });
  // 先不合规、后来重评成合规
  const FIXED = item({ item_id: "UC-006", reviews: [{ ...FAIL6, seq: 10 }, { ...PASS6, seq: 12 }] });
  // 不合规、保留、又重评成不合规：保留针对的是前一条，不算
  const STALE = item({ item_id: "UC-007", reviews: [{ ...FAIL6, seq: 10 }, { ...FAIL6, batch_id: "ui-op-4", seq: 14 }],
    waivers: [{ revision_no: 6, reason: "第一次", source: "detail", revoked: false, seq: 12 }] });

  it("状态标签、筛选、角标、发现状态都按最后一条", () => {
    const t = task([AGAIN, FIXED, STALE]);
    expect(reviewState(AGAIN, t)).toEqual({ state: "failed", problems: 1, advice: 0, kept: null });
    expect(itemVerdict(AGAIN, t).basis).toBe(AGAIN.reviews[1]);
    expect(reviewState(FIXED, t)).toEqual({ state: "passed", advice: 0 });
    expect(findingStatus(FIXED, FIXED.reviews[0], t)).toEqual({ kind: "superseded" });
    expect(reviewState(STALE, t)).toMatchObject({ state: "failed", kept: null });
    expect(failedReview(t).map((i) => i.item_id)).toEqual(["UC-005", "UC-007"]);
    expect(openProblems(t)).toBe(2);
    // 保留在最后一条之后才算
    const kept = { ...STALE, waivers: [...STALE.waivers!, { revision_no: 6, reason: "第二次", source: "detail", revoked: false, seq: 16 }] };
    expect(reviewState(kept, t)).toMatchObject({ state: "failed", kept: { reason: "第二次" } });
    expect(findingStatus(kept, kept.reviews[0], t)).toEqual({ kind: "kept", reason: "第二次" });
  });

  it("条目详情：列出最后一条的发现，给「保留这种写法」；状态标签写评审不通过", async () => {
    const t = task([AGAIN]);
    const submit = vi.fn(async () => null);
    render(<Wrap><ItemDetail task={t} item={AGAIN} def={t.definition.collections[0]} readOnly={false} pending={false} submit={submit} onReview={vi.fn()} /></Wrap>);
    expect(screen.getByTestId("state-UC-005")).toHaveTextContent(/^评审不通过 1 处$/);
    expect(screen.getByTestId("finding-problem")).toHaveTextContent("第 2 步没有主语。");
    expect(screen.getByTestId("finding-status")).toHaveTextContent(/^未处理$/);
    fireEvent.click(screen.getByTestId("keep-finding"));
    fireEvent.click(screen.getByTestId("keep-finding-ok"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "waive_review", targets: [{ item_id: "UC-005", base_revision: 6 }] }),
      "保留 UC-005 现在的写法"));
  });

  it("评审页签：被后来的合规取代的不合规不显示；要处理的与顶上一行只数最后一条", () => {
    const t = task([FIXED, AGAIN], { review_batches: [{ ...BATCH3, no: 1, batch_id: "ui-op-3", items: [{ item_id: "UC-006", revision_no: 6 }], total: 1, passed: 0, failed: 1, problems: 1 },
      { ...BATCH3, no: 2, batch_id: "ui-op-2", items: [{ item_id: "UC-005", revision_no: 6 }], total: 1, passed: 1, failed: 0, problems: 0 }] });
    panel(t);
    expect(screen.getByTestId("review-now")).toHaveTextContent(/^有 1 处问题等你处理。$/);   // 只有 UC-005 最后一条不合规的那 1 处
    expect(screen.getByTestId("review-group-UC-005")).toBeInTheDocument();
    expect(screen.queryByTestId("review-group-UC-006")).toBeNull();
    fireEvent.click(screen.getByTestId("review-done-toggle"));
    expect(screen.getByTestId("review-passed-UC-006")).toBeInTheDocument();
    expect(screen.getAllByTestId("keep-finding")).toHaveLength(1);
  });

  it("完成条件面板：最后一条不合规的条目列在评审不通过一组", () => {
    const t = task([AGAIN, FIXED]);
    const completion: Completion = { all_met: false, unmet_count: 1, brief: "", hints: [], conditions: [
      { collection: "功能用例", name: "每个条目评审通过", met: false, state: "unmet", total: 2, done: 1, note: "UC-005 评审不合规。", missing: ["UC-005"] }] };
    render(<Wrap><CompletionPanel completion={completion} items={t.items} task={t} onOpen={vi.fn()} onReview={vi.fn()} /></Wrap>);
    expect(screen.getByTestId("cond-open-UC-005")).toBeInTheDocument();
    expect(screen.queryByTestId("cond-open-UC-006")).toBeNull();
  });
});

describe("完成条件与对话区", () => {
  it("完成条件评审一条三类分开写，保留的注明按你的决定算通过", () => {
    const completion: Completion = { all_met: false, unmet_count: 1, conditions: [
      { collection: "功能用例", name: "每个条目评审通过", met: false, state: "unmet", done: 2, total: 4, missing: ["UC-004", "UC-005"], note: "" }] };
    const UC5 = item({ item_id: "UC-005" });
    const t = task([UC1, UC3, UC4, UC5]);
    render(<CompletionPanel completion={completion} items={t.items} task={t} onReview={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByTestId("cond-review")).toHaveTextContent("还差 2 条，UC-005 待评审；UC-004 评审不通过；UC-003 评审不通过但你保留了（这条按你的决定算通过；条目再改动，评审要重做）。");
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
