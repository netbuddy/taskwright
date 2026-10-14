// 任务起点页：任务头、「三步开始」与三种常见起点、需求资产现状六格、工作流程、单项活动、会话清单、材料卡、选用的知识库；
// 从任务列表打开一个任务时去哪里。随助手做完一轮重读见 taskPageEvents.test.tsx。完成条件的句子（model/completionLines.ts）也在这里测。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { AssetCell, CatalogActivity, CatalogFlow, Completion, CompletionCondition, Item, KnowledgeLibrary, ServiceInfo, SessionListEntry, TaskDetail, TaskStatusView, WorkItemView } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { completionLines, completionScore, emptyLineText } from "../model/completionLines";
import { formatTimeShort } from "../model/format";
import { allAssetsEmpty, openTask, stateLine, taskEntryHref } from "../model/startPage";
import { TaskPage, taskTypeVersionNote } from "../pages/TaskPage";
import { docxEntry, resetDocxStore } from "../state/docxStore";
import { pdfBytesEntry, resetPdfStore } from "../state/pdfStore";

afterEach(() => { cleanup(); vi.restoreAllMocks(); resetDocxStore(); window.location.hash = ""; });

const info: ServiceInfo = {
  ok: true, app: "taskwright", version: "0.4.1", mode: "server", pid: 1, port: 8950,
  capabilities: { exit: false, model: true, knowledge: true },
  upload: { max_bytes: 10, too_large_text: "单个文件不能超过 5 MB。", extensions: [".md", ".txt", ".docx"], types_text: ".md、.txt 与 Word 的 .docx", unsupported_type_text: "只接受 .md、.txt 与 Word 的 .docx 文件。" },
  knowledge_upload: { max_bytes: 40, too_large_text: "单个文件不能超过 20 MB。", extensions: [".md", ".txt", ".docx"], types_text: ".md、.txt 与 Word 的 .docx",
    unsupported_type_text: "只接受 .md、.txt 与 Word 的 .docx 文件。", kinds: [{ kind: "other", name: "其他" }] },
};
const lib = (id: string, name: string, used = 0, docs = 0): KnowledgeLibrary =>
  ({ id, name, created_at: "", used_by_tasks: used, documents: Array.from({ length: docs }, (_, i) => ({ name: `d${i}.md`, kind: "other", bytes: 1, uploaded_at: "" })) });
const LIBS = [lib("general", "通用知识库", 2, 3), lib("lib-hy", "行业规范", 1, 4), lib("lib-cb", "城北区图书馆的资料", 0, 5)];

const FIELD = { name: "名称", type: "文本", required: true, values: null };
const COLLECTIONS = [
  { name: "功能用例", prefix: "UC", needs_review: true, rules_hash: "h1", review_rules: [], fields: [FIELD] },
  { name: "非功能需求", prefix: "NFR", needs_review: true, rules_hash: "h1", review_rules: [], fields: [FIELD] },
  { name: "问题", prefix: "TBD", needs_review: false, review_rules: null, fields: [FIELD] },
];
const ok = { revision_no: 2, verdict: "合规", findings: [], rules_hash: "h1", seq: 5 };
const bad = { revision_no: 2, verdict: "不合规", findings: [{ rule_id: "R1", level: "必选", field: "名称", index: null, problem: "没有写目的。", suggestion: "写明目的。" }], rules_hash: "h1", seq: 5 };
const waiver = { revision_no: 2, reason: null, source: "panel", revoked: false, seq: 9 };

function item(id: string, collection: string, over: Partial<Item> = {}): Item {
  return {
    item_id: id, collection, title: id, revision_no: 2, revision_by: "executor", revision_at: "", revisions: [2],
    fields: {}, sources: [], reviews: [], waivers: [], confirmations: [{ revision_no: 2, accepted: true, basis: "viewed" }],
    confirmation_stale: false, ...over,
  };
}
function cond(collection: string, name: string, state: "met" | "unmet" | "empty", missing: string[] = [], note = ""): CompletionCondition {
  return { collection, name, met: state !== "unmet", state, done: 0, total: 0, missing, note };
}
const completionOf = (conditions: CompletionCondition[], hints: Completion["hints"] = []): Completion =>
  ({ all_met: conditions.every((c) => c.met), unmet_count: conditions.filter((c) => c.state === "unmet").length, conditions, hints });
const session = (id: string, name: string | null, last: string | null, over: Partial<SessionListEntry> = {}): SessionListEntry =>
  ({ session_id: id, name: name as string, started_at: last as string, last_active_at: last as string, message_count: 3, active: false, revision_count: 0, ...over });

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task_id: "TASK-P", task_name: "退款需求走查", task_type: "软件需求规格说明编制", domain_tag: null,
    started_at: "2026-09-28T17:49:00",
    definition: { collections: COLLECTIONS }, items: [], completion: null, latest_revision: 0, sessions: [],
    materials: [], knowledge_libraries: ["general", "lib-cb"], ...over,
  } as unknown as TaskDetail;
}

/** 画出这一页。status 是任务状况：不给是读不到（照没有阶段的任务画），给 null 是后端答没有状况。 */
function page(task: TaskDetail = detail(), serviceInfo: ServiceInfo = info, status?: TaskStatusView | null) {
  const calls = {
    get: vi.spyOn(api, "getTask").mockResolvedValue(task),
    status: status === undefined ? vi.spyOn(api, "taskStatus").mockRejectedValue(new ApiError("not_found", "没有这个接口。", 404))
      : vi.spyOn(api, "taskStatus").mockResolvedValue({ ok: true, status }),
    start: vi.spyOn(api, "startInNewSession").mockResolvedValue({ ok: true, op_id: "ui-op-1", session_id: "S-started" }),
    action: vi.spyOn(api, "action").mockResolvedValue({ ok: true, client_id: "c", op_id: "ui-op-2" }),
    material: vi.spyOn(api, "uploadMaterial").mockResolvedValue({ path: "inputs/a.md" }),
    document: vi.spyOn(api, "uploadDocument").mockResolvedValue({ name: "a.md", kind: "other", bytes: 1, uploaded_at: "" }),
    select: vi.spyOn(api, "setTaskKnowledge").mockImplementation(async (_t, ids) => ids),
    remove: vi.spyOn(api, "deleteMaterial").mockResolvedValue({ ok: true, path: "inputs/借阅说明.md" }),
    replace: vi.spyOn(api, "replaceMaterial").mockResolvedValue({ ok: true, path: "inputs/补充说明第二版.docx", replaced: "inputs/补充说明.docx" }),
    newSession: vi.spyOn(api, "createSession").mockResolvedValue({ session_id: "S-new" }),
    continueItem: vi.spyOn(api, "continueWorkItem").mockResolvedValue({ ok: true, session_id: "S-fresh", activity_record_id: 1 }),
    deleteItem: vi.spyOn(api, "deleteWorkItem").mockResolvedValue({ ok: true, op_id: "ui-op-3", activity_record_id: 2, archived_sessions: 1 }),
  };
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockResolvedValue(serviceInfo);
  vi.spyOn(api, "knowledge").mockResolvedValue(LIBS);
  render(<ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-P" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  return calls;
}
const ready = () => screen.findByTestId("task-page");
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

// ───── 任务状况的夹具：资产现状六格、活动目录、起点页的几段话 ─────

const cell = (key: string, name: string, count: number, unit: string, shown: string, note = "", produced_by: string[] = []): AssetCell =>
  ({ key, name, count, unit, text: shown, note, produced_by });
const EMPTY_ASSETS = [
  cell("materials", "材料与证据", 0, "份", "0 份"), cell("description", "业务说明", 0, "节", "0 节", "", ["核读材料", "澄清", "整理建模", "编写文档"]),
  cell("models", "分析模型", 0, "张", "0 张", "", ["整理建模"]), cell("items", "需求条目", 0, "条", "0 条", "", ["写条目", "评审确认"]),
  cell("review", "评审与确认", 0, "轮", "未评审", "", ["评审确认"]), cell("versions", "文档与版本", 0, "版", "未发布", "", ["编写文档", "发布"]),
];
const FILLED_ASSETS = [
  cell("materials", "材料与证据", 2, "份", "2 份", "均已核读"), cell("description", "业务说明", 9, "节", "9 节", "1 处待澄清", ["核读材料", "澄清", "整理建模", "编写文档"]),
  cell("models", "分析模型", 4, "张", "4 张", "1 未查看", ["整理建模"]), cell("items", "需求条目", 6, "条", "6 条", "6 未读 · 1 待核实", ["写条目", "评审确认"]),
  cell("review", "评审与确认", 0, "轮", "未评审", "", ["评审确认"]), cell("versions", "文档与版本", 0, "版", "未发布", "", ["编写文档", "发布"]),
];
const kind = (key: string, name: string) => ({ key, name });
function activityOf(key: string, name: string, over: Partial<CatalogActivity> = {}): CatalogActivity {
  return {
    key, name, mode: "batch", mode_name: "批处理", purpose: `${name}的目的。`, reads: [kind("description", "业务说明")], writes: [kind("items", "需求条目")],
    prerequisite_text: "前置条件：业务说明至少一节。", example: `${name}的例子。`, enabled: true, state: "可以启动", recommended: false, ...over,
  };
}
const NODES = [kind("reading", "核读材料"), kind("clarifying", "澄清"), kind("writing", "写条目"), kind("publish", "发布")];
function flowOf(key: string, name: string, over: Partial<CatalogFlow> = {}): CatalogFlow {
  return {
    key, name, purpose: `${name}的目的。`, applies: `${name}的适用情形。`, nodes: NODES, inputs: "项目材料（可选）、目标系统描述",
    prerequisite_text: "无前置条件；可从空白开始。", example: `${name}的经过。`, enabled: true, state: "可以启动", recommended: false, at: null, start: "clarifying", ...over,
  };
}
const CHANGE = flowOf("change", "需求变更", { enabled: false, state: "还没有已发布的版本", prerequisite_text: "前置条件：存在已发布的版本。", start: null });
const PUBLISH = activityOf("publish", "发布", { mode: "user_only", mode_name: "仅限用户发起", enabled: false, state: "此版本尚未提供", prerequisite_text: "前置条件：评审无未处理发现，确认记录待处理为 0。" });
const TEXTS = { lead: "本任务用于编制并持续维护「退款需求走查」的需求规格说明。", guide_note: "预计首轮产出：业务说明初稿与待澄清问题清单",
  cases: [{ title: "有调研材料", text: "上传会议记录。" }, { title: "只有口头想法", text: "用三句话描述。" }, { title: "已有旧版规格说明", text: "把旧文档作为材料上传。" }] };
const IDLE_ACTIVITY = { kind: "idle" as const, key: "idle" as const, name: "空闲", ordinal: null, flow: "analysis", moved_by: null, moved_at: null, reason: null };
/** 任务状况里的一个工作项。 */
function workItem(recordId: number, over: Partial<WorkItemView> = {}): WorkItemView {
  return {
    record_id: recordId, kind: "activity", name: "澄清", activity: "clarifying", activity_name: "澄清", node: null, ordinal: null, flow: null, scope: null,
    started_at: "2026-10-11T15:00:00", session_ids: [`S-${recordId}`], session_count: 1,
    latest_session: { session_id: `S-${recordId}`, name: "澄清 · 续借规则", last_active_at: "2026-10-11T15:30:00" }, last_active_at: "2026-10-11T15:30:00",
    session_name: "澄清", ...over,
  };
}
const FLOW_ITEM = workItem(1, { kind: "flow", name: "需求分析", activity: "writing", activity_name: "写条目", node: "writing", ordinal: 4, flow: "analysis",
  scope: "覆盖借阅主流程。", started_at: "2026-10-08T09:00:00", session_ids: ["S1", "S2"], session_count: 2,
  latest_session: { session_id: "S2", name: "需求分析 · 写条目", last_active_at: "2026-10-13T09:10:00" }, last_active_at: "2026-10-13T09:10:00", session_name: "需求分析 · 写条目" });
const TAKEN = { record_id: 1, name: "需求分析", node: "writing" as const };
function statusOf(over: Partial<TaskStatusView> = {}): TaskStatusView {
  return {
    generated_at: "2026-10-13T09:00:00", activity: IDLE_ACTIVITY, description: { sections: 0, chapters: [], unsorted: 0, open_questions: 0 }, models: [], items: [],
    missing: [], proposal: null, versions: [], launch: null, assets: EMPTY_ASSETS, start_page: TEXTS, work_items: [],
    catalog: {
      flows: [flowOf("analysis", "需求分析", { recommended: true }), CHANGE],
      activities: [
        activityOf("reading", "核读材料", { enabled: false, state: "还没有项目材料", prerequisite_text: "前置条件：至少一份项目材料。" }),
        activityOf("clarifying", "澄清", { mode: "dialogue", mode_name: "逐项对话", prerequisite_text: "无前置条件；可从空白开始。", writes: [kind("description", "业务说明")] }),
        activityOf("writing", "写条目", { enabled: false, state: "业务说明还没有内容；有 1 张分析模型还没有查看", prerequisite_text: "前置条件：业务说明至少一节，分析模型均已查看。" }),
        PUBLISH,
      ],
    },
    ...over,
  };
}

describe("任务头", () => {
  it("写面包屑、任务类型与时刻一行、任务名；外框是工作视图的顶栏加导航条，顶栏写任务名与「任务起点」，不写会话名", async () => {
    page(detail({ domain_tag: "电商售后", sessions: [session("S1", "第一句", "2026-09-28T18:02:00"), session("S2", "第二句", "2026-09-29T10:02:00")] }));
    const root = await ready();
    expect(text(root.querySelector(".tp-crumb"))).toBe("任务›退款需求走查");
    expect(root.querySelector(".tp-crumb a")).toHaveAttribute("href", "#/tasks");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("退款需求走查");
    expect(screen.getByTestId("task-meta").textContent).toBe("任务类型：软件需求规格说明编制 · 电商售后 · 创建于 2026-09-28 17:49，最近一次活动在 2026-09-29 10:02。");
    const frame = screen.getByTestId("task-frame");
    expect(text(frame.querySelector(".topbar .tname"))).toBe("退款需求走查");
    expect(text(frame.querySelector(".topbar .sname"))).toBe("任务起点");
    expect(frame.querySelector(".rail .ico.on")).toHaveAttribute("href", "#/tasks/TASK-P");
    // 这一页没有对话区，也没有原来任务页的「生成文档」「新建会话」两个按钮。
    expect(frame.querySelector(".chat")).toBeNull();
    expect(screen.queryByRole("button", { name: "生成文档" })).toBeNull();
    expect(screen.queryByRole("button", { name: /新建会话/ })).toBeNull();
    // 「会话」菜单列出这个任务的会话，点一条进它的工作台。
    fireEvent.click(screen.getByTestId("session-menu-button"));
    const rows = [...screen.getByTestId("session-menu").querySelectorAll(".srow")];
    expect(rows.map((one) => text(one.querySelector(".sn")))).toEqual(["第一句", "第二句"]);
    fireEvent.click(rows[1]);
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S2");
  });

  it("任务类型说明的版本与产品自带的不同时，在创建时刻后面写一句；相同、或者有一个没有记时不写", async () => {
    expect(taskTypeVersionNote({ copied: 1, current: 2 })).toBe("任务类型说明是 1 版，当前产品自带的是 2 版。");
    for (const same of [undefined, { copied: 1, current: 1 }, { copied: null, current: 2 }, { copied: 1, current: null }]) expect(taskTypeVersionNote(same)).toBeNull();
    page(detail({ task_type_versions: { copied: 1, current: 2 } }));
    await ready();
    expect(screen.getByTestId("task-type-version")).toHaveTextContent("任务类型说明是 1 版，当前产品自带的是 2 版。");
    expect(screen.getByTestId("task-meta").textContent).toBe("任务类型：软件需求规格说明编制 · 创建于 2026-09-28 17:49。任务类型说明是 1 版，当前产品自带的是 2 版。");
    cleanup();
    page(detail({ task_type_versions: { copied: 1, current: 1 } }));
    await ready();
    expect(screen.queryByTestId("task-type-version")).toBeNull();
    expect(screen.getByTestId("task-meta").textContent).toBe("任务类型：软件需求规格说明编制 · 创建于 2026-09-28 17:49。");
  });

  it("发布过版本的任务照常可以做：任务名旁没有状态、没有只读说明；有活动目录、「进入工作台」、上传区与知识库的改选用", async () => {
    page(detail({ versions: [{ version_no: 1, revision_no: 3, published_at: "2026-10-13T09:00:00", actor: "user", note: null, figure_count: null, figure_pictures: null, has_markdown: true, has_docx: true }],
      materials: [{ path: "inputs/借阅说明.md", bytes: 5, modified_at: "2026-09-28T17:50:00", derived_from: null, deletable: true }] }),
      info, statusOf({ assets: FILLED_ASSETS }));
    await ready();
    expect(screen.queryByTestId("task-status")).toBeNull();
    expect(screen.queryByText(/整页只读/)).toBeNull();
    expect(await screen.findByTestId("flow-analysis")).toBeInTheDocument();
    expect(screen.getByTestId("enter-workbench")).toBeEnabled();
    expect(screen.getByTestId("upload-hint")).toBeInTheDocument();
    expect(screen.getByTestId("material-delete")).toBeInTheDocument();
    await screen.findByTestId("kb-row-lib-cb");
    expect(screen.getByTestId("kb-pick")).toBeInTheDocument();
  });
});

describe("起点页：空任务", () => {
  it("任务名旁写「尚无需求资产」，下面是一段定位的话、「三步开始」与三种常见起点；六格都是零，各写由哪些活动产出", async () => {
    page(detail(), info, statusOf());
    await ready();
    expect(await screen.findByTestId("task-state")).toHaveTextContent("尚无需求资产");
    expect(screen.getByTestId("task-lead")).toHaveTextContent("本任务用于编制并持续维护「退款需求走查」的需求规格说明。");
    const guide = screen.getByTestId("start-guide");
    expect([...guide.querySelectorAll(".tp-steps li")].map(text)).toEqual([
      "1选择工作流程从头编制或整体复查请启动「需求分析」流程。", "2提供输入上传项目材料，或直接描述目标系统。", "3由助手推进助手逐站完成并提议下一站，每一步由你确认。"]);
    expect(screen.getByTestId("guide-start")).toHaveTextContent("启动需求分析");
    expect(screen.queryByTestId("work-items")).toBeNull();
    expect(guide).toHaveTextContent("预计首轮产出：业务说明初稿与待澄清问题清单");
    expect([...screen.getByTestId("start-cases").querySelectorAll(".tp-case b")].map(text)).toEqual(["有调研材料", "只有口头想法", "已有旧版规格说明"]);
    const cells = [...screen.getByTestId("asset-cells").querySelectorAll(".tp-cell")];
    expect(cells.map((one) => [text(one.querySelector(".n")), text(one.querySelector(".v")), text(one.querySelector(".w"))])).toEqual([
      ["材料与证据", "0 份", "来源：上传"], ["业务说明", "0 节", "核读材料、澄清、整理建模、编写文档"], ["分析模型", "0 张", "整理建模"],
      ["需求条目", "0 条", "写条目、评审确认"], ["评审与确认", "未评审", "评审确认"], ["文档与版本", "未发布", "编写文档、发布"]]);
    expect(cells.every((one) => one.querySelector(".v")!.classList.contains("zero") && one.querySelector(".s") === null)).toBe(true);
  });

  it("工作流程两张卡：推荐的那条带「推荐」，整张卡可点、进它的输入页，右下角写「启动 →」；不能启动的那条变淡、不可点，写「前置条件未满足」与它的前置条件", async () => {
    page(detail(), info, statusOf());
    await ready();
    const analysis = await screen.findByTestId("flow-analysis");
    expect(analysis).toHaveClass("rec");
    expect(text(analysis.querySelector(".t"))).toBe("需求分析推荐");
    expect([...analysis.querySelectorAll(".tp-kv dd")].map(text)).toEqual(["需求分析的适用情形。", "核读材料 › 澄清 › 写条目 › 发布", "项目材料（可选）、目标系统描述"]);
    expect(text(analysis.querySelector(".eg"))).toBe("示例需求分析的经过。");
    expect([analysis.tagName, analysis.getAttribute("href"), analysis.classList.contains("go")]).toEqual(["A", "#/tasks/TASK-P/start/analysis", true]);
    expect(text(analysis.querySelector(".tp-arrow"))).toBe("启动 →");
    expect(analysis.querySelector("button")).toBeNull();
    const change = screen.getByTestId("flow-change");
    expect(change).toHaveClass("off");
    expect(text(change.querySelector(".t"))).toBe("需求变更前置条件未满足");
    expect(text(change.querySelector(".tp-need"))).toBe("前置条件：存在已发布的版本。");
    expect([change.tagName, change.classList.contains("go"), change.querySelector(".tp-arrow")]).toEqual(["DIV", false, null]);
  });

  it("单项活动每项一张卡：方式、目的、例子、输入与产出、前置条件；能启动的整张卡可点、进它的输入页，缺前提的变淡、不可点，前置条件是琥珀色并说明缺什么；末尾另起一行是「自由讨论」", async () => {
    page(detail(), info, statusOf());
    await ready();
    const clarifying = await screen.findByTestId("activity-clarifying");
    expect(text(clarifying.querySelector(".t"))).toBe("澄清逐项对话");
    expect([text(clarifying.querySelector(".d")), text(clarifying.querySelector(".ex"))]).toEqual(["澄清的目的。", "例：澄清的例子。"]);
    expect(text(clarifying.querySelector(".tp-rw"))).toBe("输入业务说明产出业务说明");
    expect(clarifying.querySelector(".tp-rw .w")).toHaveTextContent("业务说明");
    expect(text(clarifying.querySelector(".tp-quiet"))).toBe("无前置条件；可从空白开始。");
    expect([clarifying.tagName, clarifying.getAttribute("href"), text(clarifying.querySelector(".tp-arrow"))]).toEqual(["A", "#/tasks/TASK-P/start/clarifying", "启动 →"]);
    expect(screen.queryByTestId("activity-count")).toBeNull();
    expect(clarifying.querySelector("button")).toBeNull();
    const writing = screen.getByTestId("activity-writing");
    expect(writing).toHaveClass("off");
    expect(text(writing.querySelector(".tp-need"))).toBe("前置条件：业务说明至少一节，分析模型均已查看。");
    expect(writing.querySelector(".tp-need")).toHaveAttribute("title", "业务说明还没有内容；有 1 张分析模型还没有查看。");
    expect([writing.tagName, writing.classList.contains("go"), writing.querySelector(".tp-arrow")]).toEqual(["DIV", false, null]);
    // 发布现在还不能启动：写那一句状态，不是琥珀色。
    const publish = screen.getByTestId("activity-publish");
    expect([publish.classList.contains("off"), text(publish.querySelector(".tp-quiet")), publish.querySelector(".tp-need")]).toEqual([true, "此版本尚未提供。", null]);
    // 「自由讨论」不是活动：不在活动卡的网格里，方式写「对话」，按钮是「进入工作台」。
    const free = screen.getByTestId("free-talk");
    expect(free.closest(".tp-acts")).toBeNull();
    expect(text(free.querySelector(".t"))).toBe("自由讨论对话");
    expect(text(free.querySelector(".d"))).toBe("新建一条不属于任何工作项的会话，直接进入工作台与助手讨论。助手可解答问题、把定下的事记入业务说明，但不写需求条目，也不提议下一站。随时可用，不影响已有的工作项。");
    // 起点页上不再出现「开展」。
    expect(screen.getByTestId("task-page").textContent).not.toMatch(/开展/);
    expect(screen.getByTestId("enter-workbench")).toHaveTextContent("进入工作台");
    expect(screen.getByTestId("enter-workbench")).toBeEnabled();
  });

  it("点「启动需求分析」进需求分析的输入页；三种常见起点各是一个链接，进同一页并带上是第几种；这一页上不发启动请求", async () => {
    const calls = page(detail(), info, statusOf());
    await ready();
    expect([0, 1, 2].map((index) => screen.getByTestId(`start-case-${index}`).getAttribute("href"))).toEqual([
      "#/tasks/TASK-P/start/analysis?case=0", "#/tasks/TASK-P/start/analysis?case=1", "#/tasks/TASK-P/start/analysis?case=2"]);
    fireEvent.click(await screen.findByTestId("guide-start"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/start/analysis"));
    expect(calls.start).not.toHaveBeenCalled();
    expect(calls.action).not.toHaveBeenCalled();
  });

  it("推荐的流程现在不能启动时：主按钮是灰的，三种常见起点不可点", async () => {
    page(detail(), info, statusOf({ catalog: { flows: [flowOf("analysis", "需求分析", { recommended: true, enabled: false, state: "活动的定义读不出来", start: null }), CHANGE], activities: [] } }));
    await ready();
    expect(await screen.findByTestId("guide-start")).toBeDisabled();
    expect(screen.queryByTestId("start-case-0")).toBeNull();
    expect(screen.getByTestId("start-cases").querySelectorAll("a")).toHaveLength(0);
  });

  it("点「自由讨论」的「进入工作台」：只新建会话、不启动工作项，直接进工作台；请求回来之前按钮点不动；没有建成照写后端的原话，留在这一页", async () => {
    const calls = page(detail(), info, statusOf());
    let done: (value: { session_id: string }) => void = () => {};
    calls.newSession.mockReturnValueOnce(new Promise((resolve) => { done = resolve; }));
    await ready();
    fireEvent.click(await screen.findByTestId("enter-workbench"));
    await waitFor(() => expect(screen.getByTestId("enter-workbench")).toBeDisabled());
    done({ session_id: "S-new" });
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
    expect(calls.newSession).toHaveBeenCalledWith("TASK-P");
    expect(calls.start).not.toHaveBeenCalled();
    window.location.hash = "";
    calls.newSession.mockRejectedValueOnce(new ApiError("session_busy", "助手正在另一条会话里工作，做完才能在这里继续。", 409));
    await waitFor(() => expect(screen.getByTestId("enter-workbench")).toBeEnabled());
    fireEvent.click(screen.getByTestId("enter-workbench"));
    expect(await screen.findByText("助手正在另一条会话里工作，做完才能在这里继续。")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });
});

describe("起点页：有内容的任务", () => {
  const sessions = [session("S1", "第一句", "2026-09-28T18:02:00"), session("S2", "第二句", "2026-09-29T10:02:00")];

  it("有内容、没有工作项：没有「三步开始」，也没有「工作项」一节；任务名旁写「没有工作项 · 未发布」，发布过写第几版；格子里有数的写那一句", async () => {
    page(detail({ sessions }), info, statusOf({ assets: FILLED_ASSETS }));
    await ready();
    expect(await screen.findByTestId("task-state")).toHaveTextContent("没有工作项 · 未发布");
    expect(screen.queryByTestId("start-guide")).toBeNull();
    expect(screen.queryByTestId("start-cases")).toBeNull();
    expect(screen.queryByTestId("work-items")).toBeNull();
    expect([...screen.getByTestId("asset-cells").querySelectorAll(".tp-cell")].map((one) => [text(one.querySelector(".v")), text(one.querySelector(".s"))])).toEqual([
      ["2 份", "均已核读"], ["9 节", "1 处待澄清"], ["4 张", "1 未查看"], ["6 条", "6 未读 · 1 待核实"], ["未评审", ""], ["未发布", ""]]);
    expect(text(screen.getByTestId("flow-analysis").querySelector(".tp-go"))).toBe("启动 →");
    cleanup(); vi.restoreAllMocks();
    const released = FILLED_ASSETS.map((one) => (one.key === "versions" ? cell("versions", "文档与版本", 1, "版", "第 1 版") : one));
    page(detail({ sessions }), info, statusOf({ assets: released }));
    await ready();
    expect(await screen.findByTestId("task-state")).toHaveTextContent("没有工作项 · 已发布第 1 版");
  });

  it("有工作项：任务名旁写个数；「工作项」一节在六格之上，照状况给的次序一个一张卡，写种类、启动的日子、流程在第几站、范围、会话与最近的那一条，三个按钮", async () => {
    const lonely = workItem(3, { name: "整理建模", activity: "modeling", activity_name: "整理建模", scope: null, started_at: "2026-10-13T08:00:00", session_count: 1,
      latest_session: { session_id: "S-3", name: null, last_active_at: null }, last_active_at: null, session_name: "整理建模" });
    page(detail({ sessions }), info, statusOf({ assets: FILLED_ASSETS, work_items: [FLOW_ITEM, workItem(2, { scope: "只问续借规则。" }), lonely] }));
    await ready();
    expect(await screen.findByTestId("task-state")).toHaveTextContent("3 个工作项 · 未发布");
    const section = screen.getByTestId("work-items");
    // 在六格之上：文档里先出现工作项一节。
    expect(section.compareDocumentPosition(screen.getByTestId("asset-cells")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.closest(".tp-sec")!.querySelector("h2")).toHaveTextContent("工作项");
    const cards = [...section.querySelectorAll(".tp-run")];
    expect(cards.map((one) => text(one.querySelector(".t")))).toEqual([
      "需求分析工作流程10-08 启动 · 本任务唯一的流程工作项", "澄清单项活动10-11 启动", "整理建模单项活动10-13 启动"]);
    expect([text(cards[0].querySelector(".pos")), text(cards[0].querySelector(".scope")), text(cards[0].querySelector(".sess"))])
      .toEqual(["现在在第 4 站「写条目」。", "范围覆盖借阅主流程。", `2 条会话 · 最近 ${formatTimeShort("2026-10-13T09:10:00")}「需求分析 · 写条目」`]);
    expect([cards[1].querySelector(".pos"), text(cards[1].querySelector(".scope"))]).toEqual([null, "范围只问续借规则。"]);
    expect([cards[2].querySelector(".scope"), text(cards[2].querySelector(".sess"))]).toEqual([null, "1 条会话 · 还没有说过话"]);
    expect([...cards[0].querySelectorAll("button")].map(text)).toEqual(["打开最新会话", "换一条干净的会话接着", "删除这个工作项"]);
    // 没有「已做完」之类的卡，也没有变淡的卡。
    expect(section.textContent).not.toMatch(/已做完|已放弃|已结束/);
    // 「打开最新会话」进最近有动静的那一条。
    fireEvent.click(within(cards[0] as HTMLElement).getByTestId("work-item-open"));
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S2");
  });

  it("「换一条干净的会话接着」：让后端新建一条属于这个工作项的会话，进去，不替用户发话；没有建成照写后端的原话", async () => {
    const calls = page(detail({ sessions }), info, statusOf({ assets: FILLED_ASSETS, work_items: [FLOW_ITEM] }));
    await ready();
    fireEvent.click(within(await screen.findByTestId("work-item-1")).getByTestId("work-item-continue"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-fresh"));
    expect(calls.continueItem).toHaveBeenCalledWith("TASK-P", 1);
    expect(calls.action).not.toHaveBeenCalled();
    window.location.hash = "";
    calls.continueItem.mockRejectedValueOnce(new ApiError("session_busy", "助手正在另一条会话里工作，做完才能在这里继续。", 409));
    await waitFor(() => expect(screen.getByTestId("work-item-1").querySelector("[data-testid=work-item-continue]")).toBeEnabled());
    fireEvent.click(within(screen.getByTestId("work-item-1")).getByTestId("work-item-continue"));
    expect(await screen.findByText("助手正在另一条会话里工作，做完才能在这里继续。")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("「删除这个工作项」：先弹确认，写明会归档几条会话；取消什么都不做；确认之后删、提示归档了几条、重读这一页", async () => {
    const calls = page(detail({ sessions }), info, statusOf({ assets: FILLED_ASSETS, work_items: [FLOW_ITEM, workItem(2)] }));
    await ready();
    fireEvent.click(within(await screen.findByTestId("work-item-2")).getByTestId("work-item-delete"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("删除工作项「澄清」？");
    expect(dialog).toHaveTextContent("它的 1 条会话将归档：会话列表里默认不再列出，打开后按自由讨论办。需求资产与修订都不受影响。删除之后不能恢复。");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(calls.deleteItem).not.toHaveBeenCalled();
    const reads = calls.status.mock.calls.length;
    // 关掉的确认框在动画走完之前还留在页面里：取最后弹出的那一个。
    const latestDialog = async () => (await screen.findAllByRole("dialog")).at(-1)!;
    fireEvent.click(within(screen.getByTestId("work-item-2")).getByTestId("work-item-delete"));
    await waitFor(async () => expect(await latestDialog()).not.toBe(dialog));
    fireEvent.click(within(await latestDialog()).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(calls.deleteItem).toHaveBeenCalledWith("TASK-P", 2));
    expect(await screen.findByText("已删除工作项「澄清」，归档了 1 条会话。")).toBeInTheDocument();
    await waitFor(() => expect(calls.status.mock.calls.length).toBeGreaterThan(reads));
    // 流程的工作项：确认框另说明删了之后可以重新启动，但原来所在的一站不保留。
    fireEvent.click(within(screen.getByTestId("work-item-1")).getByTestId("work-item-delete"));
    await waitFor(async () => expect(await latestDialog()).toHaveTextContent("删除工作项「需求分析」？"));
    expect(await latestDialog()).toHaveTextContent("它的 2 条会话将归档：会话列表里默认不再列出，打开后按自由讨论办。需求资产与修订都不受影响。删除之后可以重新启动「需求分析」，但原来所在的一站不保留。删除之后不能恢复。");
  });

  it("已有流程工作项：那条流程的卡写「已在进行」、在第几站，不能再启动，另有「打开它的会话」；另一条流程写原因；已有工作项的活动标个数、照样可以再启动", async () => {
    const changeTaken = flowOf("change", "需求变更", { enabled: false, state: "已有流程工作项「需求分析」，位于「写条目」", start: null, work_item: TAKEN });
    page(detail({ sessions }), info, statusOf({
      assets: FILLED_ASSETS, work_items: [FLOW_ITEM, workItem(2)],
      catalog: { flows: [flowOf("analysis", "需求分析", { recommended: true, enabled: false, state: "已有流程工作项「需求分析」，位于「写条目」", work_item: TAKEN, active_count: 1 }), changeTaken],
        activities: [activityOf("clarifying", "澄清", { active_count: 1 }), activityOf("writing", "写条目")] },
    }));
    await ready();
    const analysis = await screen.findByTestId("flow-analysis");
    expect([analysis.tagName, analysis.classList.contains("off"), analysis.classList.contains("now"), text(analysis.querySelector(".t"))]).toEqual(["DIV", false, true, "需求分析已在进行"]);
    expect(text(screen.getByTestId("flow-position"))).toBe("已在进行，位于第 3 站「写条目」（见上）。一个任务同一时刻只有一条流程工作项。");
    expect(analysis.querySelector(".tp-arrow")).toBeNull();
    expect(analysis.textContent).not.toMatch(/前置条件未满足|无前置条件/);
    fireEvent.click(screen.getByTestId("flow-open-work-item"));
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S2");
    // 另一条流程因此不能启动：不写「前置条件未满足」，底部写原因。
    const change = screen.getByTestId("flow-change");
    expect([change.classList.contains("off"), text(change.querySelector(".t")), text(change.querySelector(".tp-need"))]).toEqual([true, "需求变更", "已有流程工作项「需求分析」，位于「写条目」。"]);
    // 单项活动：澄清已有一个工作项，标出来，照样可以再启动。
    const clarifying = screen.getByTestId("activity-clarifying");
    expect([text(clarifying.querySelector("[data-testid=activity-count]")), clarifying.getAttribute("href"), clarifying.classList.contains("now")]).toEqual(["1 个工作项", "#/tasks/TASK-P/start/clarifying", true]);
    expect(screen.getByTestId("activity-writing").querySelector("[data-testid=activity-count]")).toBeNull();
  });

  it("有需求资产时「待处理事项」一节排在「工作项」之上；六类资产都空着时没有这一节", async () => {
    page(detail({ sessions, stage: { current: "idle", moved_by: null, moved_at: null, reason: null, lamps: { reading: [], clarifying: [], modeling: [], writing: [], reviewing: [], document: [] } } } as unknown as Partial<TaskDetail>),
      info, statusOf({ assets: FILLED_ASSETS, work_items: [workItem(1)] }));
    await ready();
    const pending = await screen.findByTestId("pending-work");
    expect(pending.compareDocumentPosition(screen.getByTestId("work-items")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text(pending.closest("section")!.querySelector("h2"))).toBe("待处理事项");
    expect(text(screen.getByTestId("todo-findings"))).toBe("评审发现0尚未发起评审。");
    cleanup(); vi.restoreAllMocks();
    page(detail({ sessions, stage: { current: "idle", lamps: {} } } as unknown as Partial<TaskDetail>), info, statusOf({ work_items: [workItem(1)] }));
    await ready();
    await screen.findByTestId("work-items");
    expect(screen.queryByTestId("pending-work")).toBeNull();
  });

  it("六类资产都空着而已经有工作项（刚启动、还没有记下内容）：不再显示「三步开始」，显示「工作项」一节，任务名旁写个数", async () => {
    page(detail({ sessions }), info, statusOf({ work_items: [workItem(1)] }));
    await ready();
    expect(await screen.findByTestId("task-state")).toHaveTextContent("1 个工作项 · 未发布");
    expect(screen.getByTestId("work-items")).toBeInTheDocument();
    expect(screen.queryByTestId("start-guide")).toBeNull();
    expect(screen.queryByTestId("start-cases")).toBeNull();
  });

  it("工作项卡上三个按钮都在：打开最新会话、换一条干净的会话接着、删除这个工作项", async () => {
    page(detail({ sessions }), info, statusOf({ assets: FILLED_ASSETS, work_items: [FLOW_ITEM] }));
    await ready();
    const card = await screen.findByTestId("work-item-1");
    expect([...card.querySelectorAll("button")].map(text)).toEqual(["打开最新会话", "换一条干净的会话接着", "删除这个工作项"]);
  });

  it("没有任务状况（没有阶段的任务、早先的后端）：只有任务头、「进入工作台」、会话与材料，不画资产现状与活动目录", async () => {
    page(detail(), info, null);
    await ready();
    expect(await screen.findByTestId("enter-workbench")).toBeEnabled();
    expect(screen.queryByTestId("asset-cells")).toBeNull();
    expect(screen.queryByTestId("flow-analysis")).toBeNull();
    expect(screen.queryByTestId("task-state")).toBeNull();
    expect(screen.getByTestId("session-count")).toBeInTheDocument();
  });
});

describe("打开一个任务时去哪里", () => {
  const withSections = (count: number) => ({ ok: true, status: statusOf({ assets: EMPTY_ASSETS.map((one) => (one.key === "description" ? cell("description", "业务说明", count, "节", `${count} 节`) : one)) }) });

  it("业务说明已经有内容、又有会话：进最近活动的那条会话的工作台；与有没有活动在进行无关", async () => {
    vi.spyOn(api, "taskStatus").mockResolvedValue(withSections(3));
    vi.spyOn(api, "listSessions").mockResolvedValue([session("S1", "第一句", "2026-09-28T18:02:00"), session("S2", "第二句", "2026-09-29T10:02:00")]);
    expect(await taskEntryHref("TASK-P")).toBe("#/tasks/TASK-P/sessions/S2");
    const to = vi.fn();
    openTask("TASK-P", to);
    await waitFor(() => expect(to).toHaveBeenCalledWith("#/tasks/TASK-P/sessions/S2"));
  });

  it("业务说明还没有内容、一条会话都没有、或者取不到任务状况：进任务起点页", async () => {
    vi.spyOn(api, "taskStatus").mockResolvedValue(withSections(0));
    const sessions = vi.spyOn(api, "listSessions").mockResolvedValue([session("S1", "第一句", "2026-09-28T18:02:00")]);
    expect(await taskEntryHref("TASK-P")).toBe("#/tasks/TASK-P");
    expect(sessions).not.toHaveBeenCalled();
    vi.spyOn(api, "taskStatus").mockResolvedValue(withSections(2));
    sessions.mockResolvedValue([]);
    expect(await taskEntryHref("TASK-P")).toBe("#/tasks/TASK-P");
    vi.spyOn(api, "taskStatus").mockRejectedValue(new ApiError("not_found", "没有这个任务。", 404));
    expect(await taskEntryHref("TASK-P")).toBe("#/tasks/TASK-P");
    vi.spyOn(api, "taskStatus").mockResolvedValue({ ok: true, status: null });
    expect(await taskEntryHref("TASK-P")).toBe("#/tasks/TASK-P");
  });

  it("任务名旁那一句的几种情形：没有状况不写；空任务写尚无需求资产；别的写工作项的个数与发布的情形", () => {
    expect(stateLine(null)).toBe("");
    expect(stateLine(statusOf())).toBe("尚无需求资产");
    expect(stateLine(statusOf({ assets: FILLED_ASSETS }))).toBe("没有工作项 · 未发布");
    expect(stateLine(statusOf({ assets: FILLED_ASSETS, work_items: [FLOW_ITEM, workItem(2)] }))).toBe("2 个工作项 · 未发布");
    expect(stateLine(statusOf({ work_items: [workItem(2)] }))).toBe("1 个工作项 · 未发布");
    expect(allAssetsEmpty(undefined)).toBe(false);
  });
});

describe("完成条件的句子", () => {

  it("句子的写法：评审不通过的与还在等评审的分开写，保留了写法的另提一句；多于 6 个只写个数；认不出的条件退回接口的说明", () => {
    const many = Array.from({ length: 7 }, (_, i) => `UC-10${i}`);
    const task = detail({ items: [
      item("UC-001", "功能用例"), item("UC-002", "功能用例", { reviews: [bad] }), item("UC-003", "功能用例", { reviews: [bad], waivers: [waiver] }),
      item("UC-004", "功能用例", { reviews: [ok] }), item("TBD-001", "问题"),
    ] });
    const lines = (list: CompletionCondition[]) => completionLines(completionOf(list), task)
      .map((line) => line.parts.map((p) => (typeof p === "string" ? p : p.id)).join(""));
    expect(lines([
      cond("功能用例", "每个条目评审通过", "unmet", ["UC-001", "UC-002"]),
      cond("功能用例", "每个条目评审通过", "met"),
      cond("功能用例", "每个条目用户确认", "unmet", many),
      cond("功能用例", "每个条目用户确认", "met"),
      cond("功能用例", "至少一个条目", "unmet"),
      cond("问题", "没有状态为未解决的条目", "unmet", ["TBD-001"]),
      cond("问题", "没有状态为未解决的条目", "met"),
      cond("功能用例", "每个条目都有来源", "unmet", ["UC-001"], "UC-001 没有来源。"),
    ])).toEqual([
      "功能用例的每个条目都要评审通过，UC-001 还在等评审，UC-002 评审不通过；UC-003 评审不通过，但你保留了写法。",
      "功能用例的每个条目都要评审通过，这一条已经满足；UC-003 评审不通过，但你保留了写法。",
      "功能用例的每个条目都要经你确认，有 7 个条目你还没有读过。",
      "功能用例的每个条目都要经你确认，这一条已经满足。",
      "功能用例至少要有一个条目，现在一个也没有。",
      "问题里不能有状态为未解决的条目，TBD-001 还没有解决。",
      "问题里不能有状态为未解决的条目，这一条已经满足。",
      "功能用例：每个条目都有来源，UC-001 没有来源。",
    ]);
    expect(completionScore(completionOf([cond("甲", "x", "met"), cond("甲", "y", "unmet"), cond("乙", "x", "empty")]))).toEqual({ met: 1, total: 2 });
  });
});

describe("完成条件里暂时不用核对的那一行", () => {
  const task = detail();
  const lines = (list: CompletionCondition[]) => completionLines(completionOf(list), task)
    .map((line) => `${line.state}：${line.parts.map((p) => (typeof p === "string" ? p : p.id)).join("")}`);

  it("只有一个集合还没有条目时写「某集合现在还没有条目，它的完成条件暂时不用核对。」，它有几条条件都只写一行", () => {
    expect(lines([cond("非功能需求", "每个条目评审通过", "empty"), cond("非功能需求", "每个条目用户确认", "empty")]))
      .toEqual(["empty：非功能需求现在还没有条目，它的完成条件暂时不用核对。"]);
    expect(emptyLineText(["问题"])).toBe("问题现在还没有条目，它的完成条件暂时不用核对。");
  });

  it("好几个集合还没有条目时用顿号连起来写一行「……它们的完成条件暂时不用核对。」，集合不重复、按接口给的先后；这一行排在已满足与还差的各行之后", () => {
    expect(lines([
      cond("功能用例", "至少一个条目", "unmet"),
      cond("功能用例", "每个条目评审通过", "empty"),
      cond("非功能需求", "每个条目评审通过", "empty"),
      cond("问题", "没有状态为未解决的条目", "met"),
      cond("非功能需求", "每个条目用户确认", "empty"),
      cond("约束", "每个条目用户确认", "empty"),
    ])).toEqual([
      "unmet：功能用例至少要有一个条目，现在一个也没有。",
      "met：问题里不能有状态为未解决的条目，这一条已经满足。",
      "empty：功能用例、非功能需求、约束现在还没有条目，它们的完成条件暂时不用核对。",
    ]);
  });

  it("没有暂时不用核对的条件时不写这一行；分数照旧不数它们", () => {
    expect(lines([cond("功能用例", "至少一个条目", "met")])).toEqual(["met：功能用例至少有一个条目，这一条已经满足。"]);
    expect(completionScore(completionOf([cond("功能用例", "至少一个条目", "met"), cond("约束", "每个条目评审通过", "empty"), cond("约束", "每个条目用户确认", "empty")])))
      .toEqual({ met: 1, total: 1 });
  });
});

describe("会话清单", () => {
  it("每行写第一句话、最近活动与修订次数，最近活动的排在前面；助手正接着的那条行前有圆点；点一行进入那条会话", async () => {
    page(detail({ sessions: [
      session("S1", "请把退款说明整理成功能用例。", "2026-09-28T18:02:00", { revision_count: 2 }),
      session("S2", "再补一条约束。", "2026-09-29T10:02:00", { active: true }),
    ] }));
    await ready();
    expect(screen.getByTestId("session-count").textContent).toBe("2");
    const rows = screen.getAllByTestId("session-row");
    expect(rows.map((r) => text(r.querySelector(".sfirst")))).toEqual(["●再补一条约束。", "请把退款说明整理成功能用例。"]);
    expect(rows.map((r) => text(r.querySelector(".smeta")))).toEqual([
      "最近活动在 2026-09-29 10:02·这条会话还没有产生修订。", "最近活动在 2026-09-28 18:02·这条会话产生了 2 次修订。"]);
    expect(within(rows[0]).getByTestId("session-active")).toHaveAttribute("title", "助手正接着这条会话。");
    expect(within(rows[1]).queryByTestId("session-active")).toBeNull();
    expect(within(rows[1]).getByText("打开").closest("a")).toHaveAttribute("href", "#/tasks/TASK-P/sessions/S1");
    fireEvent.click(rows[1]);
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S1");
  });

  it("还没有会话时写一句提示；刚新建还没说过话的会话排最前并照实写；旧后端没有修订次数时写消息条数", async () => {
    page();
    await ready();
    expect(screen.getByTestId("session-count").textContent).toBe("0");
    expect(screen.getByTestId("session-empty").textContent).toBe("还没有会话。启动工作项时自动建立。");
    cleanup(); vi.restoreAllMocks();
    page(detail({ sessions: [
      session("S1", "第一句", "2026-09-28T18:02:00", { revision_count: undefined, message_count: 7 }),
      session("S2", null, null, { message_count: 0 }),
    ] }));
    await ready();
    expect(screen.getAllByTestId("session-row").map(text)).toEqual([
      "新会话，还没有说过话。还没有活动·这条会话还没有产生修订。打开", "第一句最近活动在 2026-09-28 18:02·一共 7 条消息。打开"]);
  });

  it("会话名旁标所属工作项：流程的写流程名与所在的站，单项活动写活动名，不属于工作项的写自由讨论；没有「已做完」这种标签", async () => {
    page(detail({ sessions: [
      session("S1", "需求分析", "2026-10-13T09:10:00", { work_item: { record_id: 1, kind: "flow", name: "需求分析", activity: "writing", flow: "analysis" } }),
      session("S2", "整理建模 · 对象关系图", "2026-10-13T09:02:00", { work_item: { record_id: 5, kind: "activity", name: "整理建模", activity: "modeling", flow: null } }),
      session("S3", "问几个关于预约的问题", "2026-10-11T20:05:00", { work_item: null }),
    ] }), info, statusOf({ assets: FILLED_ASSETS }));
    await ready();
    expect(text(screen.getByText("每条会话属于一个工作项，或是自由讨论"))).toBe("每条会话属于一个工作项，或是自由讨论");
    expect(screen.getAllByTestId("session-tag").map(text)).toEqual(["需求分析 · 写条目", "整理建模", "自由讨论"]);
    expect(screen.getByTestId("session-count").textContent).toBe("3");
    expect(document.body.textContent).not.toMatch(/已做完/);
  });

  it("「显示已归档的会话」默认关着；勾上时另取带归档的清单，归档的会话接在后面、标「已归档」，点它照样进那条会话；再去掉勾就不列", async () => {
    const calls = page(detail({ sessions: [session("S1", "需求分析", "2026-10-13T09:10:00", { work_item: null })] }), info, statusOf({ assets: FILLED_ASSETS }));
    const list = vi.spyOn(api, "listSessions").mockResolvedValue([
      session("S1", "需求分析", "2026-10-13T09:10:00", { work_item: null, archived: false }),
      session("S9", "澄清 · 续借规则", "2026-10-11T15:30:00", { work_item: null, archived: true, archived_at: "2026-10-13T21:14:00", archived_record_id: 4 }),
    ]);
    await ready();
    expect(screen.getAllByTestId("session-row")).toHaveLength(1);
    expect(list).not.toHaveBeenCalled();
    const toggle = within(screen.getByTestId("show-archived")).getByRole("checkbox");
    expect(screen.getByTestId("show-archived")).toHaveTextContent("显示已归档的会话删除工作项时它的会话归档，默认不列出");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(2));
    expect(list).toHaveBeenCalledWith("TASK-P", true);
    const archived = screen.getAllByTestId("session-row")[1];
    expect(archived).toHaveClass("archived");
    expect(within(archived).getByTestId("session-tag")).toHaveTextContent("已归档");
    expect(screen.getByTestId("session-count").textContent).toBe("1");
    fireEvent.click(archived);
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S9");
    fireEvent.click(toggle);
    expect(screen.getAllByTestId("session-row")).toHaveLength(1);
    expect(calls.get).toHaveBeenCalled();
  });
});

describe("材料", () => {
  const materials = [
    { path: "inputs/借阅说明.md", bytes: 181, modified_at: "2026-09-28T17:49:00", derived_from: null, deletable: false },
    { path: "inputs/补充说明.docx", bytes: 24 * 1024, modified_at: "2026-09-28T17:52:00", derived_from: null, deletable: true },
    { path: "inputs/补充说明.docx.md", bytes: 9, modified_at: "2026-09-28T17:52:00", derived_from: "inputs/补充说明.docx", deletable: false },
  ];

  it("材料表列出名称、大小、上传时间与「查看」；deletable 为真的那份另有「替换」与「删除」，为假的那份只有灰色的「替换」；由 Word 材料生成的文件不列", async () => {
    page(detail({ materials }));
    await ready();
    expect(screen.getByTestId("material-count").textContent).toBe("2 份");
    const rows = screen.getAllByTestId("material-row");
    expect(rows.map((r) => [...r.querySelectorAll("td")].map(text))).toEqual([
      ["借阅说明.md", "181 字节", "2026-09-28 17:49", "查看替换"],
      ["补充说明.docx", "24.0 KB", "2026-09-28 17:52", "查看替换删除"],
    ]);
    expect(rows[0].querySelector(".anticon-file-text")).toBeTruthy();
    expect(rows[1].querySelector(".anticon-file-word")).toBeTruthy();
  });

  it("点「删除」先弹确认，写明删除之后助手不会再看到它；确定之后调删除接口并重读任务", async () => {
    const calls = page(detail({ materials }));
    fireEvent.click(await screen.findByTestId("material-delete"));
    expect(await screen.findByText("删除材料《补充说明.docx》？")).toBeInTheDocument();
    expect(screen.getByText("删除之后这份材料就没有了，助手下次开始会话时不会再看到它。")).toBeInTheDocument();
    expect(calls.remove).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    await waitFor(() => expect(calls.remove).toHaveBeenCalledWith("TASK-P", "inputs/补充说明.docx"));
    await waitFor(() => expect(calls.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("已删除材料《补充说明.docx》。")).toBeInTheDocument();
  });

  it("删除请求还没有回来时，确认框的「删除」转圈、「取消」不可点，再点「删除」不会发第二次请求；回来之后照常提示并重读任务", async () => {
    const calls = page(detail({ materials }));
    let finish: (value: { ok: true; path: string }) => void = () => {};
    calls.remove.mockImplementation(() => new Promise((ok) => { finish = ok; }));
    fireEvent.click(await screen.findByTestId("material-delete"));
    await screen.findByText("删除材料《补充说明.docx》？");
    const ok = () => document.querySelector(".ant-modal .ant-btn-primary") as HTMLButtonElement;
    const cancel = () => document.querySelector(".ant-modal .ant-btn-default") as HTMLButtonElement;
    fireEvent.click(ok());
    await waitFor(() => expect(ok()).toHaveClass("ant-btn-loading"));
    expect(cancel().disabled).toBe(true);
    fireEvent.click(ok());
    fireEvent.click(ok());
    fireEvent.click(cancel());
    expect(calls.remove).toHaveBeenCalledTimes(1);
    expect(screen.getByText("删除材料《补充说明.docx》？")).toBeInTheDocument();
    finish({ ok: true, path: "inputs/补充说明.docx" });
    expect(await screen.findByText("已删除材料《补充说明.docx》。")).toBeInTheDocument();
    await waitFor(() => expect(calls.get).toHaveBeenCalledTimes(2));
    expect(calls.remove).toHaveBeenCalledTimes(1);
  });

  it("删除被后端拒绝（材料刚进入了对话）：红色提示照写后端的原话，并重读任务，「删除」随新的数据消失", async () => {
    const calls = page(detail({ materials }));
    calls.remove.mockRejectedValue(new ApiError("rejected", "这份材料已经进入了对话，不能删除。", 422));
    fireEvent.click(await screen.findByTestId("material-delete"));
    await screen.findByText("删除材料《补充说明.docx》？");
    calls.get.mockResolvedValue(detail({ materials: materials.map((m) => ({ ...m, deletable: false })) }));
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    expect(await screen.findByText("这份材料已经进入了对话，不能删除。")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("material-delete")).toBeNull());
  });

  const pickReplacement = async (file: File) => {
    fireEvent.click(await screen.findByTestId("material-replace"));
    fireEvent.change(screen.getByTestId("material-replace-input"), { target: { files: [file] } });
  };
  const newer = () => new File(["x".repeat(9)], "补充说明第二版.docx");

  it("已经进入对话的材料：「替换」是灰的、点不动，鼠标停在上面说明请上传一份新材料并告诉助手以新的为准", async () => {
    const calls = page(detail({ materials }));
    await ready();
    const off = screen.getAllByTestId("material-row")[0].querySelector("[data-testid=material-replace-off]")!;
    expect(off).toHaveTextContent("替换");
    expect(off).toHaveClass("off");
    expect(off).toHaveAttribute("aria-disabled", "true");
    expect(off).toHaveAttribute("title", "这份材料已经进入了对话，不能替换；请上传一份新材料，并告诉助手以新的为准。");
    fireEvent.click(off);
    expect(document.querySelector(".ant-modal")).toBeNull();
    expect(calls.replace).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("material-replace")).toHaveLength(1);
    expect(screen.getAllByTestId("material-row")[1].querySelector("[data-testid=material-replace-off]")).toBeNull();
  });

  it("点「替换」选好文件后先弹确认，写明旧文件就没有了；确定之后调替换接口、提示把哪份换成了哪份并重读任务", async () => {
    const calls = page(detail({ materials }));
    const file = newer();
    await pickReplacement(file);
    expect(await screen.findByText("用《补充说明第二版.docx》替换材料《补充说明.docx》？")).toBeInTheDocument();
    expect(screen.getByText("用新文件替换这份材料，旧文件就没有了；助手下次开始会话时看到的是新文件。")).toBeInTheDocument();
    expect(calls.replace).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    await waitFor(() => expect(calls.replace).toHaveBeenCalledWith("TASK-P", "inputs/补充说明.docx", file));
    expect(await screen.findByText("已把材料《补充说明.docx》替换成《补充说明第二版.docx》。")).toBeInTheDocument();
    await waitFor(() => expect(calls.get).toHaveBeenCalledTimes(2));
    expect(calls.material).not.toHaveBeenCalled();
  });

  it("在确认框里点「取消」不调替换接口，也不重读任务", async () => {
    const calls = page(detail({ materials }));
    await pickReplacement(newer());
    await screen.findByText("用《补充说明第二版.docx》替换材料《补充说明.docx》？");
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-default")!);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(calls.replace).not.toHaveBeenCalled();
    expect(calls.get).toHaveBeenCalledTimes(1);
  });

  it("用同名的文件替换时提示只写「已替换」", async () => {
    const calls = page(detail({ materials }));
    calls.replace.mockResolvedValue({ ok: true, path: "inputs/补充说明.docx", replaced: "inputs/补充说明.docx" });
    await pickReplacement(new File(["y"], "补充说明.docx"));
    await screen.findByText("用《补充说明.docx》替换材料《补充说明.docx》？");
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    expect(await screen.findByText("已替换材料《补充说明.docx》。")).toBeInTheDocument();
    expect(calls.replace).toHaveBeenCalledTimes(1);
  });

  it("替换时选的文件类型不符或者超过上限：直接报后端给的那句话，不弹确认框，不调接口", async () => {
    const calls = page(detail({ materials }));
    await pickReplacement(new File(["x"], "表格.xlsx"));
    expect(await screen.findByText(info.upload!.unsupported_type_text!)).toBeInTheDocument();
    const big = new File(["x"], "很大.md");
    Object.defineProperty(big, "size", { value: info.upload!.max_bytes + 1 });
    await pickReplacement(big);
    expect(await screen.findByText(info.upload!.too_large_text)).toBeInTheDocument();
    expect(document.querySelector(".ant-modal")).toBeNull();
    expect(calls.replace).not.toHaveBeenCalled();
  });

  it("替换请求还没有回来时，确认框的「替换」转圈、「取消」不可点，再点不会发第二次请求", async () => {
    const calls = page(detail({ materials }));
    let finish: (value: { ok: true; path: string; replaced: string }) => void = () => {};
    calls.replace.mockImplementation(() => new Promise((ok) => { finish = ok; }));
    await pickReplacement(newer());
    await screen.findByText("用《补充说明第二版.docx》替换材料《补充说明.docx》？");
    const ok = () => document.querySelector(".ant-modal .ant-btn-primary") as HTMLButtonElement;
    const cancel = () => document.querySelector(".ant-modal .ant-btn-default") as HTMLButtonElement;
    fireEvent.click(ok());
    await waitFor(() => expect(ok()).toHaveClass("ant-btn-loading"));
    expect(cancel().disabled).toBe(true);
    fireEvent.click(ok());
    fireEvent.click(cancel());
    expect(calls.replace).toHaveBeenCalledTimes(1);
    finish({ ok: true, path: "inputs/补充说明第二版.docx", replaced: "inputs/补充说明.docx" });
    expect(await screen.findByText("已把材料《补充说明.docx》替换成《补充说明第二版.docx》。")).toBeInTheDocument();
    expect(calls.replace).toHaveBeenCalledTimes(1);
  });

  it("替换被后端拒绝（材料刚进入了对话）：红色提示照写后端的原话，并重读任务，「替换」随新的数据变灰", async () => {
    const calls = page(detail({ materials }));
    calls.replace.mockRejectedValue(new ApiError("rejected", "这份材料已经进入了对话，不能替换；请上传一份新材料，并告诉助手以新的为准。", 422));
    await pickReplacement(newer());
    await screen.findByText("用《补充说明第二版.docx》替换材料《补充说明.docx》？");
    calls.get.mockResolvedValue(detail({ materials: materials.map((m) => ({ ...m, deletable: false })) }));
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    expect(await screen.findByText("这份材料已经进入了对话，不能替换；请上传一份新材料，并告诉助手以新的为准。")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("material-replace")).toBeNull());
    expect(screen.getAllByTestId("material-replace-off")).toHaveLength(2);
  });

  /** 先让页面把这份 Word 材料读进缓存（接口报读不到，缓存里记成 error），返回读原始字节的那个接口，供数它被调了几次。 */
  const cached = async () => {
    const raw = vi.spyOn(api, "materialRaw").mockRejectedValue(new ApiError("not_found", "没有材料。", 404));
    vi.spyOn(api, "materialContent").mockRejectedValue(new ApiError("not_found", "没有材料。", 404));
    await ready();
    docxEntry("TASK-P", "inputs/补充说明.docx");
    await waitFor(() => expect(docxEntry("TASK-P", "inputs/补充说明.docx").status).toBe("error"));
    expect(docxEntry("TASK-P", "inputs/补充说明.docx").status).toBe("error");
    expect(raw).toHaveBeenCalledTimes(1);
    return raw;
  };

  it("用同名的文件替换成功之后丢掉这份 Word 材料在页面里的缓存，再显示它时重新读", async () => {
    const calls = page(detail({ materials }));
    calls.replace.mockResolvedValue({ ok: true, path: "inputs/补充说明.docx", replaced: "inputs/补充说明.docx" });
    const raw = await cached();
    await pickReplacement(new File(["y"], "补充说明.docx"));
    await screen.findByText("用《补充说明.docx》替换材料《补充说明.docx》？");
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    await screen.findByText("已替换材料《补充说明.docx》。");
    expect(docxEntry("TASK-P", "inputs/补充说明.docx").status).toBe("loading");
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(2));
  });

  it("删除成功之后同样丢掉缓存：再上传同名的文件，显示时重新读", async () => {
    page(detail({ materials }));
    const raw = await cached();
    fireEvent.click(await screen.findByTestId("material-delete"));
    await screen.findByText("删除材料《补充说明.docx》？");
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    await screen.findByText("已删除材料《补充说明.docx》。");
    expect(docxEntry("TASK-P", "inputs/补充说明.docx").status).toBe("loading");
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(2));
  });

  it("PDF 材料读过的那一份同样丢掉：替换成功之后，被替换的与换上来的两个路径上的都丢", async () => {
    // 缓存按「任务加路径」记，不看扩展名，材料卡也不分类型都丢；这里沿用上面 Word 的那两个路径。
    const calls = page(detail({ materials }));
    calls.replace.mockResolvedValue({ ok: true, path: "inputs/补充说明第二版.docx", replaced: "inputs/补充说明.docx" });
    vi.spyOn(api, "materialRaw").mockResolvedValue(new ArrayBuffer(4));
    await ready();
    const paths = ["inputs/补充说明.docx", "inputs/补充说明第二版.docx", "inputs/不相干.pdf"];
    paths.forEach((path) => pdfBytesEntry("TASK-P", path));
    await waitFor(() => expect(paths.map((path) => pdfBytesEntry("TASK-P", path).status)).toEqual(["ready", "ready", "ready"]));
    const before = paths.map((path) => pdfBytesEntry("TASK-P", path));
    await pickReplacement(newer());
    await screen.findByText("用《补充说明第二版.docx》替换材料《补充说明.docx》？");
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    await screen.findByText("已把材料《补充说明.docx》替换成《补充说明第二版.docx》。");
    const after = paths.map((path) => pdfBytesEntry("TASK-P", path));
    expect(after.map((entry, i) => entry === before[i])).toEqual([false, false, true]);
    resetPdfStore();
  });

  it("PDF 材料读过的那一份同样丢掉：删除成功之后那一份丢", async () => {
    page(detail({ materials }));
    vi.spyOn(api, "materialRaw").mockResolvedValue(new ArrayBuffer(4));
    await ready();
    pdfBytesEntry("TASK-P", "inputs/补充说明.docx");
    await waitFor(() => expect(pdfBytesEntry("TASK-P", "inputs/补充说明.docx").status).toBe("ready"));
    fireEvent.click(await screen.findByTestId("material-delete"));
    await screen.findByText("删除材料《补充说明.docx》？");
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    await screen.findByText("已删除材料《补充说明.docx》。");
    expect(pdfBytesEntry("TASK-P", "inputs/补充说明.docx").status).toBe("loading");
    resetPdfStore();
  });

  it("选好文件直接调材料上传接口：不问去向，不碰知识库，传完重读任务", async () => {
    const calls = page(detail({ materials }));
    await screen.findByTestId("kb-row-general");
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File(["x".repeat(5)], "术语.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(calls.material).toHaveBeenCalledTimes(1));
    expect(calls.material.mock.calls[0].slice(0, 2)).toEqual(["TASK-P", file]);
    expect(await screen.findByText("已上传：inputs/a.md")).toBeInTheDocument();
    await waitFor(() => expect(calls.get).toHaveBeenCalledTimes(2));
    expect(calls.document).not.toHaveBeenCalled();
    expect(calls.select).not.toHaveBeenCalled();
    expect(screen.queryByText("这份文件用来做什么？")).toBeNull();
    expect(document.querySelector(".ant-modal")).toBeNull();
  });

  it("没有材料时写一句话，不画空表；上传区的说明只说材料", async () => {
    page();
    await ready();
    expect(screen.getByText("这个任务还没有材料。")).toBeInTheDocument();
    expect(document.querySelector(".tp-mtable")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("upload-hint").textContent).toMatch(/^把文件拖到这里，或者点这里选择文件。只收 \.md、\.txt 与 Word 的 \.docx，单个不超过 /));
    expect(screen.getByTestId("upload-hint").textContent).not.toContain("知识库");
  });

  it("服务没有知识库时不显示知识库卡，材料卡独占一行", async () => {
    page(detail({ materials }), { ...info, capabilities: { exit: false, model: true }, knowledge_upload: undefined });
    await ready();
    await screen.findByText(/单个不超过/);
    expect(screen.queryByTestId("task-knowledge")).toBeNull();
    expect(document.querySelector(".tp-pair")).toHaveClass("single");
  });
});

describe("选用的知识库", () => {
  it("列出选用的知识库与个数：通用知识库注明每个任务都会用到、没有「不再选用」；别的知识库可以不再选用", async () => {
    const calls = page();
    const card = await screen.findByTestId("task-knowledge");
    const general = await within(card).findByTestId("kb-row-general");
    expect(screen.getByTestId("kb-count").textContent).toBe("2 个");
    expect(document.querySelector(".tp-pair")).not.toHaveClass("single");
    expect(text(general)).toBe("通用知识库3 份文档每个任务都会用到。查看");
    expect(general).toHaveClass("general");
    expect(within(general).getByText("查看")).toHaveAttribute("href", "#/knowledge/general");
    const other = within(card).getByTestId("kb-row-lib-cb");
    expect(text(other)).toBe("城北区图书馆的资料5 份文档查看不再选用");
    expect(card).toHaveTextContent("助手只在这几个知识库里查找。");
    fireEvent.click(within(other).getByText("不再选用"));
    await waitFor(() => expect(calls.select).toHaveBeenCalledWith("TASK-P", ["general"]));
  });

  it("「选用别的知识库」勾上一个、确定之后整体改选用；通用知识库勾着、不能去掉", async () => {
    const calls = page();
    await screen.findByTestId("kb-row-general");
    expect(screen.getByTestId("kb-pick")).toHaveTextContent("选用别的知识库");
    fireEvent.click(screen.getByTestId("kb-pick"));
    const picker = await screen.findByTestId("kb-picker");
    const boxes = within(picker).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[true, true], [false, false], [true, false]]);
    expect(picker.textContent).toContain("城北区图书馆的资料5 份文档 · 没有任务在用");
    fireEvent.click(boxes[1]);
    fireEvent.click(within(picker).getByTestId("kb-pick-ok"));
    await waitFor(() => expect(calls.select).toHaveBeenCalledWith("TASK-P", ["general", "lib-hy", "lib-cb"]));
  });
});

describe("时刻的写法", () => {
  it("落在今天的只写时与分，别的日子写全", () => {
    const now = new Date("2026-09-30T20:00:00");
    expect(formatTimeShort("2026-09-30T17:51:00", now)).toBe("17:51");
    expect(formatTimeShort("2026-09-29T17:51:00", now)).toBe("2026-09-29 17:51");
    expect(formatTimeShort(null, now)).toBe("未知");
  });
});
