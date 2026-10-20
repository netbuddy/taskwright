// 左边的导航栏：展开态各段（任务、工作、待处理事项、参考、底部）、三种页面的形态、待处理事项三行为零与不为零、红点、
// 开合按视口宽度（1280px）的默认与记忆优先、库事件带来的阶段让计数就地变化、各行点了去哪里。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DiagramRow, FieldDef, Item, KnowledgeLibrary, SessionListEntry, Snapshot, StageLamp, StageView, Task } from "../api/types";
import { LeftNav } from "../components/work/LeftNav";
import { flowProgress, initialLeftNavOpen, pendingLines, readLeftNav } from "../model/leftNav";
import { initialWorkState, workReducer } from "../state/workState";
import { href, parseRoute } from "../router";

const KEY = "taskwright.leftNav";
const setWidth = (px: number) => Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
beforeEach(() => { window.localStorage.clear(); setWidth(1900); });
afterEach(() => { cleanup(); window.location.hash = ""; window.localStorage.clear(); });

const f = (name: string, type: string, values: string[] | null = null): FieldDef => ({ name, type, required: false, values }) as FieldDef;
const QUESTIONS = { name: "问题", prefix: "TBD", fields: [
  f("事项", "文本"), f("种类", "枚举", ["待澄清", "范围外", "后续迭代"]), f("是否阻断下游", "枚举", ["阻断下游", "不阻断"]), f("何时回看", "文本"),
  f("状态", "枚举", ["未解决", "已解决", "用户决定保留"]), f("关联条目", "条目引用")] };
const OVERALL = { name: "业务说明", prefix: "OA", fields: [f("标题", "文本")] };
const USE_CASES = { name: "功能用例", prefix: "UC", fields: [f("用例名称", "文本")] };
const item = (id: string, collection: string, title: string, fields: Record<string, unknown> = {}, over: Partial<Item> = {}): Item =>
  ({ item_id: id, collection, title, revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1], fields, sources: [], reviews: [], waivers: [], confirmations: [], ...over }) as Item;
const question = (id: string, title: string, block: string) =>
  item(id, "问题", title, { 事项: title, 种类: "待澄清", 是否阻断下游: block, 状态: "未解决", 关联条目: [] });
const lamp = (key: string, ok: boolean | null, items: string[] = []): StageLamp => ({ key, ok, items, summary: `${key} 的一句。` });
const LAMPS: StageView["lamps"] = {
  reading: [lamp("materials_cited", true)],
  clarifying: [lamp("decisions_have_goal", false, ["OA-003"])],
  modeling: [],
  writing: [lamp("no_pending_items", false, ["UC-001"]), lamp("no_pending_marks", false, ["D-001"]), lamp("no_blocking_questions", false, ["TBD-001"])],
  reviewing: [],
  document: [],
};
const CALM: StageView["lamps"] = { reading: [], clarifying: [lamp("decisions_have_goal", true)], modeling: [], writing: [lamp("no_pending_items", true), lamp("no_pending_marks", true)], reviewing: [], document: [] };
const DIAGRAM = { diagram_id: "D-001", name: "自助借书流程", kind: "flowchart", kind_name: "流程图", revision_no: 3, revision_by: "executor", revision_at: "", viewed: false } as DiagramRow;
const stage = (lamps = LAMPS, over: Partial<StageView> = {}): StageView =>
  ({ current: "idle", node: null, flow_node: null, moved_by: null, moved_at: null, reason: null, lamps, ...over }) as StageView;

function taskOf(lamps = LAMPS, questions = true): Task {
  return {
    task_id: "TASK-L", task_name: "图书借阅", task_type: "需求工程", domain_tag: null, started_at: "",
    definition: { collections: [QUESTIONS, OVERALL, USE_CASES] }, completion: null,
    items: [
      item("OA-003", "业务说明", "逾期不能续借"), item("UC-001", "功能用例", "自助借书", {}, { pending_verification: true }),
      ...(questions ? [question("TBD-001", "续借次数是否设上限", "阻断下游"), question("TBD-003", "预约保留期多长", "不阻断")] : []),
    ],
    diagrams: lamps === CALM ? [] : [DIAGRAM], review_batches: [], stage: stage(lamps),
  } as unknown as Task;
}
const session = (id: string, name: string, started: string, over: Partial<SessionListEntry> = {}): SessionListEntry =>
  ({ session_id: id, name, started_at: started, last_active_at: started, message_count: 3, active: false, work_item: null, ...over }) as SessionListEntry;
const FLOW = { record_id: 1, kind: "flow" as const, name: "需求分析", activity: "writing" as const, flow: "analysis" };
const SESSIONS = [
  session("S1", "写条目", "2026-10-15T10:00:00", { work_item: FLOW }),
  session("S2", "核读与澄清", "2026-10-15T19:22:00", { work_item: { ...FLOW, record_id: 2, kind: "activity", name: "澄清", activity: "clarifying", flow: null } }),
  session("S3", "问几个问题", "2026-10-14T09:00:00"),
];
const LIBRARIES = [{ id: "L1", documents: [{}, {}] }, { id: "L2", documents: [{}] }] as unknown as KnowledgeLibrary[];

function nav(over: Partial<Parameters<typeof LeftNav>[0]> = {}) {
  const task = taskOf();
  return render(<LeftNav taskId="TASK-L" taskName="图书借阅" stage={task.stage} task={task} sessions={SESSIONS} currentSessionId="S1"
    onNewSession={() => undefined} libraries={LIBRARIES} {...over} />);
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("展开态五段", () => {
  it("任务一组：「任务列表」回列表，任务名去任务起点页；工作视图里两行都不高亮，没有单独的任务头", () => {
    nav();
    expect(screen.getByTestId("nav-tasks")).toHaveAttribute("href", "#/tasks");
    expect(text(screen.getByTestId("nav-tasks"))).toBe("任务列表");
    expect(screen.getByTestId("nav-task")).toHaveAttribute("href", "#/tasks/TASK-L");
    expect(text(screen.getByTestId("nav-task"))).toBe("图书借阅");
    expect(screen.getByTestId("nav-tasks")).not.toHaveClass("on");
    expect(screen.getByTestId("nav-task")).not.toHaveClass("on");
    expect(screen.queryByTestId("nav-back")).toBeNull();
    expect(screen.getByTestId("left-nav")).toHaveClass("open");
  });

  it("任务起点页高亮任务名一行；任务列表页只有「任务列表」一行并高亮，没有工作与待处理事项；知识库页高亮「知识库」", () => {
    nav({ here: "task" });
    expect(screen.getByTestId("nav-task")).toHaveClass("on");
    cleanup();
    render(<LeftNav here="tasks" libraries={LIBRARIES} />);
    expect(screen.getByTestId("nav-tasks")).toHaveClass("on");
    expect(screen.queryByTestId("nav-task")).toBeNull();
    expect(screen.queryByTestId("nav-work")).toBeNull();
    expect(screen.queryByTestId("nav-pending")).toBeNull();
    expect(screen.getByTestId("nav-knowledge")).not.toHaveClass("on");
    expect(screen.getByTestId("rail-settings")).toBeInTheDocument();
    cleanup();
    render(<LeftNav here="knowledge" libraries={LIBRARIES} />);
    expect(screen.getByTestId("nav-knowledge")).toHaveClass("on");
    expect(screen.getByTestId("nav-tasks")).not.toHaveClass("on");
  });

  it("底部「本机用户」：服务没有退出能力时是一行不能点的「本机用户」", () => {
    nav();
    expect(screen.getByTestId("user-row")).toHaveTextContent("本机用户");
    expect(screen.queryByTestId("user-menu-button")).toBeNull();
  });

  it("工作：流程名与第几站、还差几件；六格进度条；会话按建立时间倒序，当前会话在它的位置上高亮，其余带工作项种类与时刻；末尾新会话与归档开关", () => {
    nav();
    const flow = screen.getByTestId("nav-flow");
    expect(flow).toHaveTextContent("需求分析");
    expect(text(screen.getByTestId("nav-flow-line"))).toBe("第 4 站 · 写条目 · 还差 3 件才能进评审确认");
    expect([...flow.querySelectorAll(".bar i")].map((one) => one.className)).toEqual(["done", "done", "done", "current", "ahead", "ahead"]);
    expect(text(screen.getByTestId("nav-current-session"))).toBe("当前会话 · 写条目");
    expect(screen.getAllByTestId("nav-session").map(text)).toEqual(["核读与澄清单项活动10-15 19:22", "问几个问题自由讨论10-14 09:00"]);
    const order = [...screen.getByTestId("nav-work").querySelectorAll("[data-testid=nav-session], [data-testid=nav-current-session]")].map((one) => one.getAttribute("title"));
    expect(order).toEqual(["核读与澄清", "当前会话 · 写条目", "问几个问题"]);
    expect(screen.getByTestId("nav-new-session")).toBeInTheDocument();
    expect(screen.getByTestId("nav-archived")).toHaveTextContent("显示已归档的会话");
  });

  it("待处理事项：待决定「N 项」、待澄清问题「N 条 · 阻断 K」、请过目列前两个编号；各带红点", () => {
    nav();
    const pending = screen.getByTestId("nav-pending");
    expect(within(pending).getByText("待处理事项")).toBeInTheDocument();
    expect(text(screen.getByTestId("nav-pending-decisions"))).toBe("待决定2 项");
    expect(text(screen.getByTestId("nav-pending-questions"))).toBe("待澄清问题2 条 · 阻断 1");
    expect(text(screen.getByTestId("nav-pending-review"))).toBe("请过目UC-001、D-001");
    expect(within(pending).getAllByTestId("nav-dot")).toHaveLength(3);
    expect(screen.queryByTestId("nav-nothing")).toBeNull();
  });

  it("参考：知识库「N 库 M 份」去知识库页；查找是不能点的灰行；服务没有知识库能力时没有知识库一行", () => {
    nav();
    expect(screen.getByTestId("nav-knowledge")).toHaveAttribute("href", "#/knowledge");
    expect(screen.getByTestId("nav-knowledge")).toHaveTextContent("2 库 3 份");
    const search = screen.getByTestId("nav-search");
    expect(search).toHaveClass("off");
    expect(search).toHaveAttribute("title", "全局查找还没有做");
    expect(search).toHaveAttribute("aria-disabled", "true");
    cleanup();
    nav({ libraries: undefined });
    expect(screen.queryByTestId("nav-knowledge")).toBeNull();
  });

  it("底部：设置进设置页面；「收起」收成只留图标，再点展开；开合记在浏览器本地", () => {
    nav();
    window.location.hash = "#/tasks/TASK-L/sessions/S1";
    fireEvent.click(screen.getByTestId("rail-settings"));
    expect(window.location.hash).toBe("#/settings/models");
    fireEvent.click(screen.getByTestId("nav-toggle"));
    expect(screen.getByTestId("left-nav")).toHaveClass("closed");
    expect(readLeftNav()).toBe("closed");
    fireEvent.click(screen.getByTestId("nav-toggle"));
    expect(screen.getByTestId("left-nav")).toHaveClass("open");
    expect(window.localStorage.getItem(KEY)).toBe("open");
  });
});

describe("待处理事项为零与不为零", () => {
  it("三行都为零时整段只有一行「没有要你处理的事」，没有红点", () => {
    const task = taskOf(CALM, false);
    nav({ task, stage: task.stage });
    expect(text(screen.getByTestId("nav-nothing"))).toBe("没有要你处理的事");
    expect(screen.queryByTestId("nav-dot")).toBeNull();
    expect(screen.queryByTestId("nav-pending-decisions")).toBeNull();
  });

  it("为零的那一行不显示；请过目多于两个编号写「等 N 项」", () => {
    const lamps = { ...CALM, writing: [lamp("no_pending_items", false, ["UC-001", "UC-002", "UC-003"])] };
    const task = { ...taskOf(lamps, false), diagrams: [] } as Task;
    expect(pendingLines(task).map((one) => [one.key, one.text])).toEqual([["review", "UC-001、UC-002 等 3 项"]]);
    nav({ task, stage: task.stage });
    expect(screen.queryByTestId("nav-pending-decisions")).toBeNull();
    expect(screen.queryByTestId("nav-pending-questions")).toBeNull();
    expect(screen.getByTestId("nav-pending-review")).toHaveAttribute("title", "请过目 · UC-001、UC-002 等 3 项：UC-001、UC-002、UC-003");
  });

  it("页面没有给任务（任务一级的整页数据不全）时没有待处理事项一段；没有给会话清单时没有工作一段", () => {
    nav({ task: null, sessions: null });
    expect(screen.queryByTestId("nav-pending")).toBeNull();
    expect(screen.queryByTestId("nav-work")).toBeNull();
    expect(screen.getByTestId("nav-reference")).toBeInTheDocument();
  });
});

describe("收起态", () => {
  it("收起时红点保留，图标悬停出全名", () => {
    window.localStorage.setItem(KEY, "closed");
    nav();
    expect(screen.getByTestId("left-nav")).toHaveClass("closed");
    expect(screen.getAllByTestId("nav-dot")).toHaveLength(3);
    expect(screen.getByTestId("nav-pending-questions")).toHaveAttribute("title", "待澄清问题 · 2 条 · 阻断 1");
    expect(screen.getByTestId("nav-current-session")).toHaveAttribute("title", "当前会话 · 写条目");
    expect(screen.getByTestId("nav-toggle")).toHaveAttribute("title", "展开导航栏");
  });
});

describe("开合的默认与记忆", () => {
  it("没有记忆时视口不到 1280px 默认收起，1280px 及以上展开（按像素，不看字号档位）", () => {
    for (const [width, open] of [[1100, false], [1279, false], [1280, true], [1900, true]] as const) {
      setWidth(width);
      expect(initialLeftNavOpen()).toBe(open);
    }
    setWidth(1100);
    nav();
    expect(screen.getByTestId("left-nav")).toHaveClass("closed");
    cleanup();
    setWidth(1280);
    nav();
    expect(screen.getByTestId("left-nav")).toHaveClass("open");
  });

  it("有记忆时以记忆为准，不按视口宽度", () => {
    setWidth(1100);
    window.localStorage.setItem(KEY, "open");
    nav();
    expect(screen.getByTestId("left-nav")).toHaveClass("open");
    cleanup();
    setWidth(1900);
    window.localStorage.setItem(KEY, "closed");
    nav();
    expect(screen.getByTestId("left-nav")).toHaveClass("closed");
  });

  it("浏览器不让读写本地存储时照视口宽度定，开合照样能点", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    nav();
    expect(screen.getByTestId("left-nav")).toHaveClass("open");
    fireEvent.click(screen.getByTestId("nav-toggle"));
    expect(screen.getByTestId("left-nav")).toHaveClass("closed");
    get.mockRestore(); set.mockRestore();
  });
});

describe("流程进度的站", () => {
  it("在流程工作项的会话里取阶段的 flow_node；在别的会话里取会话清单里流程工作项的当前活动；任务没有流程工作项时不画", () => {
    expect(flowProgress(stage(LAMPS, { current: "reviewing", node: "reviewing", flow_node: "reviewing", work_item: { ...FLOW, activity: "reviewing", scope: null, started_at: null } }), SESSIONS)?.line)
      .toBe("第 5 站 · 评审确认 · 这一站的几项都齐了");
    expect(flowProgress(stage(), SESSIONS)?.stage).toBe("writing");
    expect(flowProgress(stage(), SESSIONS.slice(1))).toBeNull();
    expect(flowProgress(stage(LAMPS, { flow_node: "document" }), [])?.line).toBe("第 6 站 · 编写文档 · 已在最后一站");
    // 核读材料只有只报数的那一盏：不说齐了、也不说还差，写只报数、由用户判断（ok 是什么都一样）。
    expect(flowProgress(stage(LAMPS, { flow_node: "reading" }), [])?.line).toBe("第 1 站 · 核读材料 · 只报数，由你判断");
    expect(flowProgress(stage({ ...LAMPS, reading: [lamp("materials_cited", null)] }, { flow_node: "reading" }), [])?.line).toBe("第 1 站 · 核读材料 · 只报数，由你判断");
    nav({ sessions: SESSIONS.slice(1), currentSessionId: "S2" });
    expect(screen.queryByTestId("nav-flow")).toBeNull();
    expect(screen.getByTestId("nav-work")).toBeInTheDocument();
  });
});

describe("计数随库事件就地变化", () => {
  it("一条条目改动的库事件带来新的阶段与灯：左栏的计数随之变化，不另取数据", () => {
    const snapshot = { seq: 4, generated_at: "", executor: { state: "idle", text: "", active_session: "S1" },
      session: { session_id: "S1", name: "写条目", started_at: "", last_active_at: "" }, task: taskOf(),
      materials: [], conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null } as unknown as Snapshot;
    let state = workReducer(initialWorkState("S1"), { type: "snapshot", snapshot });
    const show = () => render(<LeftNav taskId="TASK-L" taskName="图书借阅" stage={state.task!.stage} task={state.task} sessions={SESSIONS} currentSessionId="S1" />);
    const { unmount } = show();
    expect(text(screen.getByTestId("nav-pending-review"))).toBe("请过目UC-001、D-001");
    expect(text(screen.getByTestId("nav-flow-line"))).toBe("第 4 站 · 写条目 · 还差 3 件才能进评审确认");
    unmount();
    const verified = { ...LAMPS, writing: [lamp("no_pending_items", true), lamp("no_pending_marks", false, ["D-001"]), lamp("no_blocking_questions", false, ["TBD-001"])] };
    state = workReducer(state, { type: "sse", event: "deliverable_changed", data: {
      seq: 5, at: "", task_id: "TASK-L", revision_no: 2, actor: "user", op_id: null, undo_of_revision: null, completion: null, stage: stage(verified),
      operations: [{ op: "update", collection: "功能用例", item_id: "UC-001", title: "自助借书", revision_before: 1, revision_after: 2, fields: {}, sources: [] }] } });
    show();
    expect(text(screen.getByTestId("nav-pending-review"))).toBe("请过目D-001");
    expect(text(screen.getByTestId("nav-flow-line"))).toBe("第 4 站 · 写条目 · 还差 2 件才能进评审确认");
  });
});

describe("各行点了去哪里", () => {
  it("点会话进它的工作台，点当前会话不动；点待处理事项的一行交给页面；会话多于 8 条时折起，点「还有 N 条」展开", () => {
    const onPending = vi.fn();
    const many = Array.from({ length: 10 }, (_, i) => session(`M${i}`, `会话${i}`, `2026-10-0${i}T10:00:00`));
    nav({ onPending, sessions: [...SESSIONS, ...many] });
    fireEvent.click(screen.getAllByTestId("nav-session")[0]);
    expect(window.location.hash).toBe("#/tasks/TASK-L/sessions/S2");
    fireEvent.click(screen.getByTestId("nav-pending-questions"));
    expect(onPending).toHaveBeenCalledWith(expect.objectContaining({ key: "questions", ids: ["TBD-001"] }));
    // 13 条会话，先列 8 条（当前会话是其中第 2 条），其余 5 条折起。
    expect(screen.getAllByTestId("nav-session")).toHaveLength(7);
    expect(text(screen.getByTestId("nav-sessions-more"))).toBe("还有 5 条");
    fireEvent.click(screen.getByTestId("nav-sessions-more"));
    expect(screen.getAllByTestId("nav-session")).toHaveLength(12);
  });
});

describe("任务起点页的待处理事项地址", () => {
  it("「待决定」去的地址带 ?focus=pending，起点页的路由认得它；不带时照旧", () => {
    expect(href.task("TASK-L", "pending")).toBe("#/tasks/TASK-L?focus=pending");
    expect(parseRoute("#/tasks/TASK-L?focus=pending")).toEqual({ page: "task", taskId: "TASK-L", focus: "pending" });
    expect(parseRoute("#/tasks/TASK-L?focus=other")).toEqual({ page: "task", taskId: "TASK-L" });
    expect(href.task("TASK-L")).toBe("#/tasks/TASK-L");
  });
});

describe("折起时当前会话总留着", () => {
  it("当前会话排在第 8 条之后时，折起的列表里仍有它", () => {
    const many = Array.from({ length: 10 }, (_, i) => session(`M${i}`, `会话${i}`, `2026-10-2${i}T10:00:00`));
    nav({ sessions: [...many, session("OLD", "最早的一条", "2026-09-01T10:00:00")], currentSessionId: "OLD" });
    expect(screen.getAllByTestId("nav-session")).toHaveLength(8);
    expect(text(screen.getByTestId("nav-current-session"))).toBe("当前会话 · 最早的一条");
    expect(text(screen.getByTestId("nav-sessions-more"))).toBe("还有 2 条");
  });
});
