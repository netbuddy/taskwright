// 工作视图左边导航栏的会话一段：会话清单在助手做完一轮时（执行者状态从工作中变为不在工作）、以及浏览器窗口重新得到焦点时重读，
// 不停在打开页面的那一刻。不用定时轮询。每条会话旁标所属工作项；列表末尾「显示已归档的会话」开关。顶栏不再有「会话 ▾」菜单。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { ExecutorState, SessionListEntry, Task } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";
import { sessionTag } from "../model/sessionTag";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
// jsdom 没有元素的 scrollTo 与 scrollIntoView：打开条目、去业务说明的图都会调用。
Element.prototype.scrollTo ??= function () {};
Element.prototype.scrollIntoView ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);

const task = {
  task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, started_at: "",
  definition: { collections: [{ name: "用例", prefix: "UC", fields: [{ name: "名称", type: "文本", required: true, values: null }] }] },
  completion: null, items: [],
} as unknown as Task;

const session = (count: number, at: string): SessionListEntry =>
  ({ session_id: "S1", name: "整理材料", started_at: "2026-09-28T01:00:00Z", last_active_at: at, message_count: count, active: true }) as SessionListEntry;

function view(executor: ExecutorState) {
  (useWorkView as Mock).mockReturnValue({
    state: { ...initialWorkState("S1"), phase: "ready", task, executor },
    log: [], dispatch: vi.fn(), stream: "open", loadError: null, reload: vi.fn(),
  });
  return <Wrap><WorkViewPage taskId="TASK-001" sessionId="S1" /></Wrap>;
}
const WORKING: ExecutorState = { state: "working", text: "", active_session: "S1" };
const IDLE: ExecutorState = { state: "idle", text: "", active_session: "S1" };
const work = () => screen.getByTestId("nav-work");

describe("导航栏会话清单的重读", () => {
  it("助手做完一轮（工作中变为空闲）时重读会话列表", async () => {
    const list = vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    const { rerender } = render(view(WORKING));
    await waitFor(() => expect(work()).toHaveTextContent("当前会话 · 整理材料"));
    list.mockResolvedValue([{ ...session(10, "2026-09-28T01:15:00Z"), name: "整理材料与核读" }]);
    rerender(view(IDLE));
    await waitFor(() => expect(work()).toHaveTextContent("当前会话 · 整理材料与核读"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("浏览器窗口重新得到焦点时重读一次", async () => {
    const list = vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    render(view(IDLE));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    fireEvent.focus(window);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("状态没有从工作中离开（空闲到空闲、空闲到工作中）时不重读", async () => {
    const list = vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    const { rerender } = render(view(IDLE));
    await waitFor(() => expect(work()).toHaveTextContent("当前会话 · 整理材料"));
    rerender(view({ ...IDLE, text: "助手空闲，可以开始。" }));
    rerender(view(WORKING));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("顶栏没有「会话 ▾」菜单与「设置」按钮", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    render(view(IDLE));
    await waitFor(() => expect(work()).toBeInTheDocument());
    expect(screen.queryByTestId("session-menu-button")).toBeNull();
    expect(screen.queryByTestId("session-menu")).toBeNull();
    expect(screen.queryByTestId("open-settings")).toBeNull();
  });
});

describe("新建会话被拒时的提示", () => {
  const busy = (active: string) => new ApiError("session_busy", "助手正在另一条会话里工作，做完才能在这里继续。", 409, { active_session: active });
  const clickNew = () => fireEvent.click(screen.getByTestId("nav-new-session"));

  it("助手就在用户现在所在的这条会话里工作：说这条会话", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    vi.spyOn(api, "createSession").mockRejectedValue(busy("S1"));
    render(view(WORKING));
    clickNew();
    await waitFor(() => expect(screen.getByTestId("toasts")).toHaveTextContent("助手正在这条会话里工作，等它做完这一轮再新建会话。"));
    expect(screen.getByTestId("toasts")).not.toHaveTextContent("另一条会话");
  });

  it("助手在另一条会话里工作：照旧说另一条会话", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    vi.spyOn(api, "createSession").mockRejectedValue(busy("S2"));
    render(view({ state: "working", text: "", active_session: "S2" }));
    clickNew();
    await waitFor(() => expect(screen.getByTestId("toasts")).toHaveTextContent("助手正在另一条会话里工作，做完才能在这里继续。"));
    expect(screen.getByTestId("toasts")).not.toHaveTextContent("这条会话里工作");
  });
});

describe("导航栏会话按工作项标注，末尾可显示已归档的会话", () => {
  const entry = (id: string, name: string, over: Partial<SessionListEntry> = {}): SessionListEntry =>
    ({ session_id: id, name, started_at: "2026-10-13T01:00:00Z", last_active_at: "2026-10-13T01:05:00Z", message_count: 3, active: false, ...over }) as SessionListEntry;
  const LIVE = [
    entry("S1", "需求分析", { work_item: { record_id: 1, kind: "flow", name: "需求分析", activity: "writing", flow: "analysis" }, archived: false }),
    entry("S2", "整理建模 · 对象关系图", { work_item: { record_id: 5, kind: "activity", name: "整理建模", activity: "modeling", flow: null }, archived: false }),
    entry("S3", "问几个关于预约的问题", { work_item: null, archived: false }),
  ];
  const ARCHIVED = entry("S9", "澄清 · 续借规则", { work_item: null, archived: true, archived_at: "2026-10-13T13:14:00Z", archived_record_id: 4 });

  it("会话按建立时间倒序，当前会话在它的位置上高亮，其余标工作项的种类；页面取的是带归档的清单，导航栏只列未归档的；新会话一行说明是自由讨论", async () => {
    const list = vi.spyOn(api, "listSessions").mockResolvedValue([...LIVE.map((one, i) => ({ ...one, started_at: `2026-10-13T0${i + 1}:00:00Z` })), ARCHIVED]);
    render(view(IDLE));
    await waitFor(() => expect(within(work()).getAllByTestId("nav-session")).toHaveLength(2));
    expect(list).toHaveBeenCalledWith("TASK-001", true);
    expect(screen.getByTestId("nav-current-session")).toHaveTextContent("当前会话 · 需求分析");
    expect(within(work()).getAllByTestId("nav-session-tag").map((one) => one.textContent)).toEqual(["自由讨论", "单项活动"]);
    expect(work().textContent).not.toMatch(/澄清 · 续借规则/);
    expect(screen.getByTestId("nav-new-session")).toHaveAttribute("title", "新建一条会话：自由讨论，不绑定活动；交付物还是这一份");
  });

  it("勾上「显示已归档的会话」：归档的接在后面、标「已归档」，点它进那条会话；去掉勾就不列", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([...LIVE, ARCHIVED]);
    render(view(IDLE));
    await waitFor(() => expect(within(work()).getAllByTestId("nav-session")).toHaveLength(2));
    const toggle = within(screen.getByTestId("nav-archived")).getByRole("checkbox");
    expect(screen.getByTestId("nav-archived")).toHaveTextContent("显示已归档的会话");
    fireEvent.click(toggle);
    await waitFor(() => expect(within(work()).getAllByTestId("nav-session")).toHaveLength(3));
    const last = within(work()).getAllByTestId("nav-session")[2];
    expect(last).toHaveClass("archived");
    expect(within(last).getByTestId("nav-session-tag")).toHaveTextContent("已归档");
    fireEvent.click(last);
    expect(window.location.hash).toBe("#/tasks/TASK-001/sessions/S9");
    fireEvent.click(toggle);
    expect(within(work()).getAllByTestId("nav-session")).toHaveLength(2);
  });
});

describe("工作视图里点导航栏待处理事项的一行", () => {
  const f = (name: string, type: string, values: string[] | null = null) => ({ name, type, required: false, values });
  const item = (id: string, collection: string, title: string, fields: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
    ({ item_id: id, collection, title, revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1], fields, sources: [], reviews: [], waivers: [], confirmations: [], ...over });
  const lamp = (key: string, ok: boolean, items: string[] = []) => ({ key, ok, items, summary: `${key} 的一句。` });
  const withStage = (review: string[]) => ({
    ...task,
    definition: { collections: [
      { name: "问题", prefix: "TBD", fields: [f("事项", "文本"), f("种类", "枚举", ["待澄清", "范围外"]), f("是否阻断下游", "枚举", ["阻断下游", "不阻断"]),
        f("状态", "枚举", ["未解决", "已解决", "用户决定保留"]), f("关联条目", "条目引用")] },
      { name: "业务说明", prefix: "OA", fields: [f("标题", "文本")] },
      { name: "功能用例", prefix: "UC", fields: [f("用例名称", "文本")] }] },
    items: [item("OA-003", "业务说明", "逾期不能续借"), item("UC-001", "功能用例", "自助借书", {}, { pending_verification: true }),
      item("TBD-001", "问题", "续借次数", { 事项: "续借次数", 种类: "待澄清", 是否阻断下游: "阻断下游", 状态: "未解决", 关联条目: [] })],
    diagrams: [{ diagram_id: "D-001", name: "借书流程", kind: "flowchart", kind_name: "流程图", revision_no: 1, revision_by: "executor", revision_at: "", viewed: false }],
    review_batches: [],
    stage: { current: "idle", node: null, flow_node: null, moved_by: null, moved_at: null, reason: null,
      lamps: { reading: [], clarifying: [lamp("decisions_have_goal", false, ["OA-003"])], modeling: [], writing: [lamp("no_pending_items", false, review)], reviewing: [], document: [] } },
  }) as unknown as Task;
  function viewWith(t: Task) {
    (useWorkView as Mock).mockReturnValue({
      state: { ...initialWorkState("S1"), phase: "ready", task: t, executor: IDLE },
      log: [], dispatch: vi.fn(), stream: "open", loadError: null, reload: vi.fn(),
    });
    vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    vi.spyOn(api, "action").mockResolvedValue({ op_id: "ui-op-1" } as never);
    return render(<Wrap><WorkViewPage taskId="TASK-001" sessionId="S1" /></Wrap>);
  }

  it("待决定去任务起点页的「待处理事项」一节", async () => {
    viewWith(withStage(["UC-001"]));
    fireEvent.click(await screen.findByTestId("nav-pending-decisions"));
    expect(window.location.hash).toBe("#/tasks/TASK-001?focus=pending");
  });

  it("待澄清问题切到中栏「问题」页签", async () => {
    viewWith(withStage(["UC-001"]));
    fireEvent.click(await screen.findByTestId("nav-pending-questions"));
    await waitFor(() => expect(screen.getByTestId("pane-issues")).toHaveClass("on"));
  });

  it("请过目的第一个编号是条目时打开它的详情；是图时在业务说明里打开那张图", async () => {
    viewWith(withStage(["UC-001"]));
    fireEvent.click(await screen.findByTestId("nav-pending-review"));
    await waitFor(() => expect(screen.getByTestId("pane-items")).toHaveClass("on"));
    cleanup();
    viewWith(withStage([]));
    expect(await screen.findByTestId("nav-pending-review")).toHaveTextContent("D-001");
    fireEvent.click(screen.getByTestId("nav-pending-review"));
    await waitFor(() => expect(screen.getByTestId("pane-description")).toHaveClass("on"));
  });
});

describe("会话旁的标签", () => {
  it("流程写「流程名 · 站名」：站名先取后端给的活动名（逆向解析），早先的后端不给时是阶段的名字，再没有就是活动标识符", () => {
    const of = (work_item: SessionListEntry["work_item"]) => ({ session_id: "S", name: "", started_at: "", last_active_at: "", message_count: 0, active: false, work_item }) as SessionListEntry;
    expect(sessionTag(of({ record_id: 1, kind: "flow", name: "需求再工程", activity: "parse_spec", activity_name: "逆向解析", flow: "rewrite" }))).toBe("需求再工程 · 逆向解析");
    expect(sessionTag(of({ record_id: 1, kind: "flow", name: "需求分析", activity: "writing", flow: "analysis" }))).toBe("需求分析 · 写条目");
    expect(sessionTag(of({ record_id: 1, kind: "flow", name: "需求再工程", activity: "parse_spec", flow: "rewrite" }))).toBe("需求再工程 · parse_spec");
  });
});
