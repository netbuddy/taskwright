// 任务起点页「待处理事项」一节：五类怎样从任务详情（条目、图、评审批次、各阶段的灯）与任务状况（工作项、活动目录）算出来，
// 有阻断问题时这一节的样子与各行的动作，推进建议的几种写法，澄清输入页勾选块的次序与写进范围说明的那一句。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CatalogActivity, DiagramRow, FieldDef, Item, StageLamp, StageView, TaskDetail, TaskStatusView, WorkItemView } from "../api/types";
import { PendingWorkSection } from "../components/task/PendingWork";
import { adviceLine, composeScope, notBlockingLine, pendingWork, pickRows, pickedScope, showsPendingWork } from "../model/pendingWork";

afterEach(() => { cleanup(); window.location.hash = ""; });

const f = (name: string, type: string, values: string[] | null = null): FieldDef => ({ name, type, required: false, values }) as FieldDef;
const QUESTIONS = { name: "问题", prefix: "TBD", fields: [
  f("事项", "文本"), f("种类", "枚举", ["待澄清", "范围外", "后续迭代"]), f("是否阻断下游", "枚举", ["阻断下游", "不阻断"]), f("何时回看", "文本"),
  f("状态", "枚举", ["未解决", "已解决", "用户决定保留"]), f("关联条目", "条目引用")] };
const OVERALL = { name: "总体分析", prefix: "OA", fields: [f("标题", "文本"), f("它是什么", "文本"), f("标签", "文本列表")] };
const USE_CASES = { name: "功能用例", prefix: "UC", fields: [f("用例名称", "文本")] };

const item = (id: string, collection: string, title: string, fields: Record<string, unknown> = {}, over: Partial<Item> = {}): Item =>
  ({ item_id: id, collection, title, revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1], fields, sources: [], reviews: [], waivers: [], confirmations: [], ...over }) as Item;
const question = (id: string, title: string, block: string, over: Record<string, unknown> = {}) =>
  item(id, "问题", title, { 事项: title, 种类: "待澄清", 是否阻断下游: block, 状态: "未解决", 关联条目: ["OA-001"], ...over });
const lamp = (key: string, ok: boolean | null, items: string[] = [], summary = `${key} 的一句。`): StageLamp => ({ key, ok, items, summary });
const LAMPS: StageView["lamps"] = {
  reading: [lamp("materials_cited", true)],
  clarifying: [lamp("tagged_pages_no_open_questions", false, ["OA-001"]), lamp("decisions_have_goal", false, ["OA-003"])],
  modeling: [lamp("flows_have_flowchart_with_branch", false, ["OA-001"], "有 1 页流程还没有带判断分叉的流程图：OA-001。")],
  writing: [lamp("no_pending_items", false, ["UC-001"]), lamp("no_pending_marks", false, ["OA-003", "D-001"]), lamp("no_blocking_questions", false, ["TBD-001", "TBD-002"])],
  reviewing: [lamp("reviews_no_open_findings", false, [])],
  document: [],
};
const DIAGRAM = { diagram_id: "D-001", name: "自助借书流程", kind: "flowchart", kind_name: "流程图", revision_no: 3, revision_by: "executor", revision_at: "", viewed: false } as DiagramRow;

function taskOf(over: Partial<TaskDetail> = {}, lamps: StageView["lamps"] = LAMPS): TaskDetail {
  return {
    task_id: "TASK-P", task_name: "图书借阅", task_type: "需求工程", domain_tag: null, started_at: "",
    definition: { collections: [QUESTIONS, OVERALL, USE_CASES] }, completion: null, latest_revision: 9,
    items: [
      item("OA-001", "总体分析", "自助借书"), item("OA-003", "总体分析", "逾期不能续借"),
      question("TBD-001", "续借次数是否设上限", "阻断下游"), question("TBD-002", "逾期罚款按日累计还是按次计", "阻断下游"),
      question("TBD-003", "预约保留期多长", "不阻断", { 何时回看: "评审确认时" }),
      question("TBD-004", "已经答了的", "阻断下游", { 状态: "已解决" }), question("TBD-005", "以后再说的", "不阻断", { 种类: "后续迭代" }),
      item("UC-001", "功能用例", "自助借书", {}, { pending_verification: true }),
    ],
    diagrams: [DIAGRAM, { ...DIAGRAM, diagram_id: "D-002", name: "看过的图", viewed: true }], review_batches: [],
    stage: { current: "idle", moved_by: null, moved_at: null, reason: null, lamps } as StageView,
    sessions: [{ session_id: "S-latest", name: "需求分析", started_at: "", last_active_at: "2026-10-13T09:00:00", message_count: 3, active: false }],
    materials: [], ...over,
  } as unknown as TaskDetail;
}
const work = (over: Partial<WorkItemView>): WorkItemView => ({
  record_id: 1, kind: "flow", name: "需求分析", activity: "clarifying", activity_name: "澄清", node: "clarifying", ordinal: 2, flow: "analysis", scope: null, started_at: "",
  session_ids: ["S-flow"], session_count: 1, latest_session: { session_id: "S-flow", name: "需求分析", last_active_at: "" }, last_active_at: "", session_name: "", ...over,
}) as WorkItemView;
const activity = (key: string, enabled = true) => ({ key, name: key, enabled }) as CatalogActivity;
const NODES = [["reading", "核读材料"], ["clarifying", "澄清"], ["modeling", "整理建模"], ["writing", "写条目"], ["reviewing", "评审确认"], ["document", "编写文档"], ["publish", "发布"]]
  .map(([key, name]) => ({ key, name }));
function statusOf(items: WorkItemView[] = [work({})], activities = [activity("clarifying"), activity("writing"), activity("reviewing", false)]): TaskStatusView {
  return {
    assets: [{ key: "description", name: "业务说明", count: 2, unit: "节", text: "2 节", note: "", produced_by: [] }],
    work_items: items,
    catalog: { flows: [{ key: "analysis", name: "需求分析", nodes: NODES, work_item: items.find((one) => one.kind === "flow") ?? null }], activities },
  } as unknown as TaskStatusView;
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("待处理事项的五类", () => {
  it("待澄清问题只算种类为待澄清、还没了结的；阻断下游的列出来，不阻断的只注条数与回看时机；没有阻断的时列不阻断的", () => {
    const got = pendingWork(taskOf())!;
    expect(got.questions.map((one) => one.id)).toEqual(["TBD-001", "TBD-002"]);
    expect(got.questions[0]).toEqual({ id: "TBD-001", title: "续借次数是否设上限", note: "关联：OA-001「自助借书」" });
    expect([got.blocking, notBlockingLine(got)]).toEqual([2, "另有 1 条不阻断，评审确认时回看"]);
    const calm = taskOf({ items: taskOf().items.filter((one) => one.item_id !== "TBD-001" && one.item_id !== "TBD-002") });
    const quiet = pendingWork(calm)!;
    expect([quiet.blocking, quiet.questions.map((one) => one.note), notBlockingLine(quiet)]).toEqual([0, ["关联：OA-001「自助借书」 · 评审确认时回看"], null]);
  });

  it("待决定事项、待核实条目、评审发现取各阶段的灯列出的编号；未查看的模型取图清单里没看过的；同一个编号只列一次", () => {
    const got = pendingWork(taskOf())!;
    expect(got.decisions).toEqual([
      { id: "D-001", title: "自助借书流程", note: "还标着「待定」" },
      { id: "OA-003", title: "逾期不能续借", note: "「决定」还没有写为了哪个目标 · 还标着「待定」" }]);
    expect(got.pendingItems).toEqual([{ id: "UC-001", title: "自助借书", note: "有助手补的内容，等你核实" }]);
    expect(got.unviewedModels).toEqual([{ id: "D-001", title: "自助借书流程", note: "流程图 · 修订 3，现在的内容还没有看过" }]);
    expect([got.findings, got.reviewed]).toEqual([[], false]);
    // 通过了的灯、不适用的灯不列编号。
    const passed = pendingWork(taskOf({}, { ...LAMPS, writing: [lamp("no_pending_items", true, ["UC-001"])], clarifying: [lamp("decisions_have_goal", null, ["OA-003"])] }))!;
    expect([passed.pendingItems, passed.decisions]).toEqual([[], []]);
  });

  it("显示不显示：有阶段、有需求资产时显示；六格全空或者没有任务状况时不显示；没有阶段的任务算不出", () => {
    expect(showsPendingWork(taskOf(), statusOf())).toBe(true);
    expect(showsPendingWork(taskOf(), { ...statusOf(), assets: [{ key: "description", count: 0 }] } as unknown as TaskStatusView)).toBe(false);
    expect(showsPendingWork(taskOf(), null)).toBe(false);
    expect(pendingWork(taskOf({ stage: null }))).toBeNull();
  });
});

describe("推进建议", () => {
  const got = pendingWork(taskOf())!;
  it("在澄清及以后的站：先解决阻断下游的问题；在写条目及以后另要核实待核实的条目；写明之后可进入哪一站", () => {
    expect(adviceLine(taskOf(), statusOf(), got)).toBe("解决 TBD-001、TBD-002之后，需求分析可进入第 3 站「整理建模」。");
    expect(adviceLine(taskOf(), statusOf([work({ node: "writing", activity: "writing", ordinal: 4 })]), got))
      .toBe("解决 TBD-001、TBD-002并核实 UC-001之后，需求分析可进入第 5 站「评审确认」。");
  });

  it("没有要先处理的：看这一站的灯，没齐写还差什么，齐了写可以进入下一站；核读材料时阻断问题留给澄清，不算进来；没有流程工作项时没有这一句", () => {
    expect(adviceLine(taskOf(), statusOf([work({ node: "modeling", activity: "modeling", ordinal: 3 })]), { ...got, blocking: 0 }))
      .toBe("需求分析在第 3 站「整理建模」，这一站还差：有 1 页流程还没有带判断分叉的流程图。");
    expect(adviceLine(taskOf(), statusOf([work({ node: "reading", activity: "reading", ordinal: 1 })]), got)).toBe("第 1 站「核读材料」的几项都齐了，需求分析可进入第 2 站「澄清」。");
    expect(adviceLine(taskOf(), statusOf([work({ kind: "activity", node: null, ordinal: null, flow: null })]), got)).toBeNull();
  });
});

describe("有阻断问题时的待处理事项", () => {
  it("四张卡与推进建议；问题与待决定事项「启动澄清」进澄清的输入页并预先勾好，两条阻断的另有一并处理；待核实条目打开写条目的会话；模型「查看」进工作台打开那张图", () => {
    render(<PendingWorkSection task={taskOf()} status={statusOf([work({}), work({ record_id: 9, kind: "activity", name: "写条目", activity: "writing", node: null, ordinal: null, latest_session: { session_id: "S-writing", name: "写条目", last_active_at: "" } })])} />);
    const questions = screen.getByTestId("todo-questions");
    expect(text(questions.querySelector("h3"))).toBe("待澄清问题阻断下游 2另有 1 条不阻断，评审确认时回看");
    expect(within(questions).getByText("阻断下游 2")).toHaveClass("chip", "warn");
    fireEvent.click(within(screen.getByTestId("todo-TBD-002")).getByTestId("todo-clarify"));
    expect(window.location.hash).toBe("#/tasks/TASK-P/start/clarifying?pick=TBD-002");
    fireEvent.click(screen.getByTestId("todo-clarify-all"));
    expect(screen.getByTestId("todo-clarify-all")).toHaveTextContent("启动澄清（选择 2 条）");
    expect(window.location.hash).toBe("#/tasks/TASK-P/start/clarifying?pick=TBD-001,TBD-002");
    fireEvent.click(within(screen.getByTestId("todo-OA-003")).getByTestId("todo-clarify"));
    expect(window.location.hash).toBe("#/tasks/TASK-P/start/clarifying?pick=OA-003");
    fireEvent.click(within(screen.getByTestId("todo-UC-001")).getByRole("button"));
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-writing");
    fireEvent.click(within(within(screen.getByTestId("todo-models")).getByTestId("todo-D-001")).getByRole("button", { name: "查看" }));
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-latest?diagram=D-001");
    expect(text(screen.getByTestId("todo-findings"))).toBe("评审发现0尚未发起评审。");
    expect(text(screen.getByTestId("todo-advice"))).toBe("推进建议解决 TBD-001、TBD-002之后，需求分析可进入第 3 站「整理建模」。打开需求分析的会话");
    fireEvent.click(within(screen.getByTestId("todo-advice")).getByRole("button"));
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-flow");
  });

  it("没有写条目的工作项时待核实条目「启动写条目」；评审确认不能启动、又没有它的工作项时评审发现没有按钮", () => {
    const failing = taskOf({ review_batches: [{ no: 1 }] as never }, { ...LAMPS, reviewing: [lamp("reviews_no_open_findings", false, ["UC-001"])] });
    render(<PendingWorkSection task={failing} status={statusOf([work({})])} />);
    expect(within(within(screen.getByTestId("todo-decisions")).getByTestId("todo-UC-001")).getByRole("button")).toHaveTextContent("启动写条目");
    const finding = within(screen.getByTestId("todo-findings")).getByTestId("todo-UC-001");
    expect([text(finding), within(finding).queryByRole("button")]).toEqual(["UC-001自助借书评审不合规，还没有处理", null]);
  });
});

describe("澄清输入页的勾选块", () => {
  it("阻断下游的问题在前，然后是不阻断的问题，最后是待决定事项；各带一句小字", () => {
    expect(pickRows(taskOf()).map((one) => [one.id, one.kind, one.note])).toEqual([
      ["TBD-001", "blocking", "阻断下游 · 关联：OA-001「自助借书」"],
      ["TBD-002", "blocking", "阻断下游 · 关联：OA-001「自助借书」"],
      ["TBD-003", "question", "不阻断 · 关联：OA-001「自助借书」 · 评审确认时回看"],
      ["D-001", "decision", "待决定事项 · 还标着「待定」"],
      ["OA-003", "decision", "待决定事项 · 「决定」还没有写为了哪个目标 · 还标着「待定」"],
    ]);
    expect(pickRows(taskOf({ stage: null }))).toEqual([]);
  });

  it("勾选的编号写进范围说明的开头，用户写的接在后面；都没有是空串", () => {
    expect(pickedScope(["TBD-001", "OA-003"])).toBe("只澄清这几项：TBD-001、OA-003。");
    expect([composeScope(["TBD-001"], "  先问罚款。 "), composeScope([], " 只问续借 "), composeScope([], "  "), pickedScope([])])
      .toEqual(["只澄清这几项：TBD-001。\n先问罚款。", "只问续借", "", ""]);
  });
});
