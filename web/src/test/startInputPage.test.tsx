// 活动输入页：按这一项读哪几类资产显示哪几块输入；点主按钮先发启动的请求（一律新建会话）、再替用户发第一句话、然后进工作台；
// 不能启动、还缺输入时主按钮点不动并写原因，已有流程工作项时给「打开它的会话」；从三种常见起点进来时先看哪一块。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { AssetCell, CatalogActivity, CatalogFlow, KnowledgeLibrary, Material, ServiceInfo, SessionListEntry, TaskDetail, TaskStatusView } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { blockedLine, existingFlowItem, firstMessage, inputBlocks, missingInput, startButton, startFields, startSubtitle, startTarget } from "../model/startInput";
import { StartInputPage } from "../pages/StartInputPage";
import { parseRoute, href } from "../router";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

const info = (knowledge = true): ServiceInfo => ({
  ok: true, app: "taskwright", version: "0.6.0", mode: "server", pid: 1, port: 8950,
  capabilities: { exit: false, model: true, knowledge },
  upload: { max_bytes: 10, too_large_text: "单个文件不能超过 5 MB。", extensions: [".md", ".txt", ".docx"], types_text: ".md、.txt 与 Word 的 .docx", unsupported_type_text: "只接受 .md、.txt 与 Word 的 .docx 文件。" },
  knowledge_upload: { max_bytes: 40, too_large_text: "单个文件不能超过 20 MB。", extensions: [".md"], types_text: ".md", unsupported_type_text: "只接受 .md 文件。", kinds: [{ kind: "other", name: "其他" }] },
});
const lib = (id: string, name: string, docs: number): KnowledgeLibrary =>
  ({ id, name, created_at: "", used_by_tasks: 0, documents: Array.from({ length: docs }, (_, i) => ({ name: `d${i}.md`, kind: "other", bytes: 1, uploaded_at: "" })) });
const LIBS = [lib("general", "通用知识库", 3), lib("lib-hy", "行业规范", 4)];
const session = (id: string, name: string, last: string): SessionListEntry =>
  ({ session_id: id, name, started_at: last, last_active_at: last, message_count: 3, active: false, revision_count: 0 });
const material = (path: string): Material => ({ path, bytes: 2048, modified_at: "2026-10-13T09:00:00", deletable: true }) as Material;

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task_id: "TASK-P", task_name: "图书借阅", task_type: "软件需求规格说明编制", domain_tag: null, started_at: "2026-10-13T08:00:00",
    definition: { collections: [] }, items: [], completion: null, latest_revision: 0, sessions: [], materials: [], knowledge_libraries: ["general"], ...over,
  } as unknown as TaskDetail;
}

const cell = (key: string, name: string, count: number): AssetCell => ({ key, name, count, unit: "", text: String(count), note: "", produced_by: [] });
const assets = (counts: Record<string, number> = {}): AssetCell[] =>
  ["materials", "description", "models", "items", "review", "versions"].map((key) => cell(key, key, counts[key] ?? 0));
const kind = (key: string, name: string) => ({ key, name });
function activityOf(key: string, name: string, over: Partial<CatalogActivity> = {}): CatalogActivity {
  return {
    key, name, mode: "batch", mode_name: "批处理", purpose: `${name}的目的。`, reads: [kind("description", "业务说明")], writes: [kind("models", "分析模型"), kind("description", "业务说明")],
    prerequisite_text: "前置条件：业务说明至少一节。", example: `${name}的例子。`, enabled: true, state: "可以启动", recommended: false, ...over,
  };
}
const NODES = [kind("reading", "核读材料"), kind("clarifying", "澄清"), kind("modeling", "整理建模"), kind("publish", "发布")];
function flowOf(over: Partial<CatalogFlow> = {}): CatalogFlow {
  return {
    key: "analysis", name: "需求分析", purpose: "需求分析的目的。", applies: "项目尚无需求资产。", nodes: NODES, inputs: "项目材料（可选）、目标系统描述",
    prerequisite_text: "无前置条件；可从空白开始。", example: "经过。", enabled: true, state: "可以启动", recommended: true, at: null, start: "clarifying", ...over,
  };
}
const READING = activityOf("reading", "核读材料", { reads: [kind("materials", "材料与证据"), kind("knowledge", "知识库")], writes: [kind("description", "业务说明")], prerequisite_text: "前置条件：至少一份项目材料。" });
const CLARIFYING = activityOf("clarifying", "澄清", { mode: "dialogue", mode_name: "逐项对话", writes: [kind("description", "业务说明")], prerequisite_text: "无前置条件；可从空白开始。" });
const MODELING = activityOf("modeling", "整理建模");
const DOCUMENT = activityOf("document", "编写文档", { reads: [kind("all", "全部资产")] });
const TEXTS = {
  lead: "定位的话。", guide_note: "主按钮下面的一句",
  cases: [{ title: "有调研材料", text: "上传会议记录。", focus: "materials" as const }, { title: "只有口头想法", text: "用三句话描述。", focus: "description" as const }],
  intake: {
    lead: "项目材料与目标系统描述至少提供一项。", material_kinds: ["需求调研记录、访谈纪要", "现行制度、业务规则、办法"],
    describe_note: "说明三点：建设什么系统、服务哪些用户、解决什么问题。", describe_placeholder: "建设什么系统……",
    describe_examples: ["建设图书馆借阅管理系统。", "现行借阅依靠人工登记。"], after: ["有材料：助手核读材料。", "无材料：助手依据描述复述理解。"],
  },
};
const IDLE = { kind: "idle" as const, key: "idle" as const, name: "空闲", ordinal: null, flow: null, moved_by: null, moved_at: null, reason: null };
function statusOf(over: Partial<TaskStatusView> = {}): TaskStatusView {
  return {
    generated_at: "2026-10-13T09:00:00", activity: IDLE, description: { sections: 0, chapters: [], unsorted: 0, open_questions: 0 }, models: [], items: [],
    missing: [], proposal: null, versions: [], launch: null, assets: assets(), start_page: TEXTS,
    catalog: { flows: [flowOf()], activities: [READING, CLARIFYING, MODELING, DOCUMENT] }, ...over,
  } as TaskStatusView;
}

/** 画出这一页，记下各次请求的先后。 */
function page(key: string, task: TaskDetail = detail(), status: TaskStatusView | null = statusOf(), options: { startCase?: number | null; knowledge?: boolean; pick?: string[] } = {}) {
  const order: string[] = [];
  const calls = {
    order,
    startNew: vi.spyOn(api, "startInNewSession").mockImplementation(async () => { order.push("start_new"); return { ok: true, op_id: "ui-op-1", session_id: "S-new" }; }),
    action: vi.spyOn(api, "action").mockImplementation(async () => { order.push("start_current"); return { ok: true, client_id: "c", op_id: "ui-op-2" }; }),
    say: vi.spyOn(api, "sendMessage").mockImplementation(async () => { order.push("say"); return { ok: true, client_id: "c", queued: false }; }),
    select: vi.spyOn(api, "setTaskKnowledge").mockImplementation(async (_t, ids) => ids),
    get: vi.spyOn(api, "getTask").mockResolvedValue(task),
    status: vi.spyOn(api, "taskStatus").mockResolvedValue({ ok: true, status }),
  };
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info(options.knowledge ?? true));
  vi.spyOn(api, "knowledge").mockResolvedValue(LIBS);
  render(<ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
    <StartInputPage taskId="TASK-P" startKey={key} startCase={options.startCase ?? null} pick={options.pick ?? []} />
  </ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  return calls;
}
const submit = () => screen.findByTestId("start-submit");
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe("活动输入页的地址", () => {
  it("#/tasks/{任务}/start/{键}，可以带 ?case=序号；序号不是数字就当没有带", () => {
    expect(parseRoute("#/tasks/TASK-P/start/analysis")).toEqual({ page: "start", taskId: "TASK-P", key: "analysis", startCase: null });
    expect(parseRoute("#/tasks/TASK-P/start/analysis?case=2")).toEqual({ page: "start", taskId: "TASK-P", key: "analysis", startCase: 2 });
    expect(parseRoute("#/tasks/TASK-P/start/modeling?case=x")).toEqual({ page: "start", taskId: "TASK-P", key: "modeling", startCase: null });
    expect([href.start("TASK-P", "analysis"), href.start("TASK-P", "analysis", 0)]).toEqual(["#/tasks/TASK-P/start/analysis", "#/tasks/TASK-P/start/analysis?case=0"]);
    expect(parseRoute("#/tasks/TASK-P")).toEqual({ page: "task", taskId: "TASK-P" });
    // 从起点页「待处理事项」进澄清的输入页：?pick=编号,编号 是预先勾好的几项，可以与 case 一起带。
    expect(parseRoute("#/tasks/TASK-P/start/clarifying?pick=TBD-001,OA-003")).toEqual({ page: "start", taskId: "TASK-P", key: "clarifying", startCase: null, pick: ["TBD-001", "OA-003"] });
    expect(href.start("TASK-P", "clarifying", null, ["TBD-001", "OA-003"])).toBe("#/tasks/TASK-P/start/clarifying?pick=TBD-001,OA-003");
    expect(href.start("TASK-P", "analysis", 1, [])).toBe("#/tasks/TASK-P/start/analysis?case=1");
  });
});

describe("活动输入页上算出来的东西", () => {
  const catalog = statusOf().catalog!;
  const flow = startTarget(catalog, "analysis")!;
  const of = (key: string) => startTarget(catalog, key)!;

  it("键在活动目录里找：先找工作流程，再找单项活动，没有就是没有", () => {
    expect([flow.kind, of("modeling").kind, startTarget(catalog, "nothing"), startTarget(null, "analysis")]).toEqual(["flow", "activity", null, null]);
  });

  it("显示哪几块：流程有项目材料与领域知识库，业务说明空着时另有目标系统描述；单项活动按它读哪几类资产，另有范围说明", () => {
    expect(inputBlocks(flow, assets(), true)).toEqual({ materials: true, knowledge: true, description: true, scope: false });
    expect(inputBlocks(flow, assets({ description: 3 }), false)).toEqual({ materials: true, knowledge: false, description: false, scope: false });
    expect(inputBlocks(of("reading"), assets({ materials: 1 }), true)).toEqual({ materials: true, knowledge: true, description: false, scope: true });
    // 澄清从空白开始时有目标系统描述，业务说明有了内容就没有。
    expect(inputBlocks(of("clarifying"), assets(), true)).toEqual({ materials: false, knowledge: false, description: true, scope: true });
    expect(inputBlocks(of("clarifying"), assets({ description: 1 }), true).description).toBe(false);
    expect(inputBlocks(of("modeling"), assets(), true)).toEqual({ materials: false, knowledge: false, description: false, scope: true });
    // 读「全部资产」的活动（编写文档）不显示材料与知识库两块。
    expect(inputBlocks(of("document"), assets({ description: 3 }), true)).toEqual({ materials: false, knowledge: false, description: false, scope: true });
  });

  it("启动时发的两项、标题旁的一句与主按钮上的字", () => {
    expect([startFields(flow), startFields(of("modeling"))]).toEqual([{ activity: "clarifying", in_flow: true }, { activity: "modeling", in_flow: false }]);
    expect(startFields({ kind: "flow", flow: flowOf({ enabled: false, start: null }) })).toBeNull();
    expect(startSubtitle(flow)).toBe("从「澄清」开始；上传项目材料后从「核读材料」开始");
    expect(startSubtitle({ kind: "flow", flow: flowOf({ start: "reading" }) })).toBe("从「核读材料」开始");
    expect(startSubtitle(of("clarifying"))).toBe("逐项对话");
    expect([startButton(flow), startButton(of("modeling"))]).toEqual(["启动需求分析", "启动整理建模"]);
  });

  it("不能启动的原因、已有的流程工作项、还缺的输入、替用户发的第一句话", () => {
    expect(blockedLine(flow)).toBeNull();
    expect(blockedLine({ kind: "activity", activity: activityOf("writing", "写条目", { enabled: false, state: "业务说明还没有内容" }) })).toBe("现在还不能启动：业务说明还没有内容。");
    const running = { kind: "flow" as const, flow: flowOf({ enabled: false, state: "已有流程工作项「需求分析」，位于「整理建模」", work_item: { record_id: 3, name: "需求分析", node: "modeling" } }) };
    expect(blockedLine(running)).toBe("现在还不能启动：已有流程工作项「需求分析」，位于「整理建模」。");
    expect([existingFlowItem(running), existingFlowItem(flow), existingFlowItem(of("modeling"))]).toEqual([3, null, null]);
    const blocks = inputBlocks(flow, assets(), true);
    expect(missingInput(flow, blocks, assets(), "  ")).toBe("请先上传项目材料，或填写目标系统描述。");
    expect([missingInput(flow, blocks, assets(), "建设借阅系统"), missingInput(flow, blocks, assets({ materials: 1 }), "")]).toEqual([null, null]);
    expect(missingInput(of("clarifying"), inputBlocks(of("clarifying"), assets(), true), assets(), "")).toBeNull();
    expect(firstMessage("clarifying", "  建设借阅系统。 ")).toBe("建设借阅系统。");
    expect([firstMessage("reading", ""), firstMessage("clarifying", ""), firstMessage("modeling", ""), firstMessage("document", " ")]).toEqual([
      "请通读材料，把材料里已经写明的概念、角色、流程与目标各立一页主题。", "请逐项澄清：一次只问一件事，先给出候选再问。", "请开始整理建模。", "请开始编写文档。"]);
  });
});

describe("活动输入页：需求分析", () => {
  it("空任务：标题、各站、摘要、一段话、项目材料、领域知识库、目标系统描述与「启动后」；没有范围说明，没有会话的选择；没有材料又没有描述时主按钮点不动并写原因", async () => {
    page("analysis");
    expect(await submit()).toHaveTextContent("启动需求分析");
    expect(screen.getByTestId("back-to-start")).toHaveAttribute("href", "#/tasks/TASK-P");
    expect(screen.getByTestId("start-subtitle")).toHaveTextContent("从「澄清」开始；上传项目材料后从「核读材料」开始");
    expect(text(screen.getByTestId("start-steps"))).toBe("提供输入›核读材料›澄清›整理建模›发布");
    expect([...screen.getByTestId("start-summary").querySelectorAll("dt, dd")].map(text)).toEqual(["目的", "需求分析的目的。", "适用", "项目尚无需求资产。", "前提", "无前置条件；可从空白开始。"]);
    expect(screen.getByTestId("start-lead")).toHaveTextContent("项目材料与目标系统描述至少提供一项。");
    const materials = screen.getByTestId("materials-card");
    expect(text(materials.querySelector(".tp-sec-h"))).toBe("项目材料0 份可选 · 推荐");
    expect([...materials.querySelectorAll(".tp-in-kinds li")].map(text)).toEqual(["需求调研记录、访谈纪要", "现行制度、业务规则、办法"]);
    expect(screen.getByTestId("upload-hint")).toBeInTheDocument();
    expect(text(screen.getByTestId("describe-block").querySelector(".aside"))).toBe("无材料时必填 · 作为会话的第一条消息发给助手");
    expect(screen.getByTestId("describe-input")).toHaveAttribute("placeholder", "建设什么系统……");
    expect(text(screen.getByTestId("start-after").querySelector("h2"))).toBe("启动后");
    expect([...screen.getByTestId("start-after").querySelectorAll("li")].map(text)).toEqual([
      "有材料：助手核读材料。", "无材料：助手依据描述复述理解。", "页面切换为工作台：左侧对话区、中间业务说明与需求条目、右侧材料与修订。"]);
    expect(screen.queryByTestId("scope-block")).toBeNull();
    expect(screen.queryByTestId("start-session")).toBeNull();
    expect(await submit()).toBeDisabled();
    expect(screen.getByTestId("start-missing")).toHaveTextContent("请先上传项目材料，或填写目标系统描述。");
  });

  it("点一句示例填进文本框；写了描述点主按钮：先在新会话里从澄清启动，再把描述作为第一句话发出，然后进那条会话的工作台", async () => {
    const calls = page("analysis");
    await submit();
    fireEvent.click(screen.getByText("现行借阅依靠人工登记。"));
    expect(screen.getByTestId("describe-input")).toHaveValue("现行借阅依靠人工登记。");
    type("describe-input", "  建设图书馆借阅管理系统。 ");
    expect(screen.getByTestId("start-where")).toHaveTextContent("将新建一个工作项和一条属于它的会话，并进入工作台。");
    fireEvent.click(await submit());
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
    expect(calls.order).toEqual(["start_new", "say"]);
    expect(calls.startNew).toHaveBeenCalledWith("TASK-P", { activity: "clarifying", in_flow: true });
    expect(calls.say.mock.calls[0].slice(0, 2)).toEqual(["TASK-P", "S-new"]);
    expect(calls.say.mock.calls[0][2]).toMatchObject({ text: "建设图书馆借阅管理系统。", attachments: [] });
  });

  it("有材料、没有写描述：从核读材料启动，替用户发核读材料的那句固定的话", async () => {
    const calls = page("analysis", detail({ materials: [material("inputs/调研记录.md")] }), statusOf({ assets: assets({ materials: 1 }), catalog: { flows: [flowOf({ start: "reading" })], activities: [] } }));
    expect(await submit()).toBeEnabled();
    expect(screen.getByTestId("start-subtitle")).toHaveTextContent("从「核读材料」开始");
    expect(screen.getByTestId("material-row")).toHaveTextContent("调研记录.md");
    fireEvent.click(await submit());
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
    expect(calls.startNew).toHaveBeenCalledWith("TASK-P", { activity: "reading", in_flow: true });
    expect(calls.say.mock.calls[0][2]).toMatchObject({ text: "请通读材料，把材料里已经写明的概念、角色、流程与目标各立一页主题。" });
  });

  it("业务说明已有内容：没有目标系统描述与那一段话；「启动后」写从哪一站开始", async () => {
    page("analysis", detail(), statusOf({ assets: assets({ materials: 1, description: 4 }), catalog: { flows: [flowOf({ start: "reading" })], activities: [] } }));
    expect(await submit()).toHaveTextContent("启动需求分析");
    expect(screen.queryByTestId("describe-block")).toBeNull();
    expect(screen.queryByTestId("start-lead")).toBeNull();
    expect(text(screen.getByTestId("start-after").querySelector("li"))).toBe("助手从「核读材料」开始，每站完成后在对话区汇报并提议下一站，由你确认后进入。");
    expect(await submit()).toBeEnabled();
  });

  it("任务里已有流程工作项：主按钮点不动，旁边写原因并给「打开它的会话」，进那个工作项最近有动静的会话", async () => {
    const work = { record_id: 3, kind: "flow", name: "需求分析", latest_session: { session_id: "S-flow", name: "需求分析 · 整理建模", last_active_at: "2026-10-13T08:30:00" } };
    page("analysis", detail(), statusOf({ assets: assets({ description: 4 }), work_items: [work] as unknown as TaskStatusView["work_items"],
      catalog: { flows: [flowOf({ enabled: false, start: null, state: "已有流程工作项「需求分析」，位于「整理建模」", work_item: { record_id: 3, name: "需求分析", node: "modeling" } })], activities: [] } }));
    expect(await submit()).toBeDisabled();
    expect(screen.getByTestId("start-blocked")).toHaveTextContent("现在还不能启动：已有流程工作项「需求分析」，位于「整理建模」。");
    expect(screen.getByTestId("start-open-flow-session")).toHaveAttribute("href", "#/tasks/TASK-P/sessions/S-flow");
  });

  it("勾选一个知识库：当场改这个任务选用的知识库；通用知识库勾着、不能去掉；服务没有知识库时没有这一块", async () => {
    const calls = page("analysis");
    await submit();
    const general = await screen.findByTestId("kb-check-general");
    expect([(general as HTMLInputElement).checked, (general as HTMLInputElement).disabled]).toEqual([true, true]);
    fireEvent.click(screen.getByTestId("kb-check-lib-hy"));
    await waitFor(() => expect(calls.select).toHaveBeenCalledWith("TASK-P", ["general", "lib-hy"]));
    cleanup(); vi.restoreAllMocks();
    page("analysis", detail(), statusOf(), { knowledge: false });
    await submit();
    expect(screen.queryByTestId("knowledge-choice")).toBeNull();
    expect(screen.getByTestId("materials-card")).toBeInTheDocument();
  });

  it("从三种常见起点进来：要先看的那一块描黑边，块里写那种起点的做法", async () => {
    page("analysis", detail(), statusOf(), { startCase: 0 });
    await submit();
    expect(screen.getByTestId("materials-card")).toHaveClass("marked");
    expect(text(screen.getByTestId("start-case-note"))).toBe("有调研材料上传会议记录。");
    expect(screen.getByTestId("describe-block")).not.toHaveClass("marked");
    cleanup(); vi.restoreAllMocks();
    page("analysis", detail(), statusOf(), { startCase: 1 });
    await submit();
    expect(screen.getByTestId("describe-block")).toHaveClass("marked");
    expect(screen.getByTestId("describe-block")).toContainElement(screen.getByTestId("start-case-note"));
    await waitFor(() => expect(screen.getByTestId("describe-input")).toHaveFocus());
    expect(screen.getByTestId("materials-card")).not.toHaveClass("marked");
  });
});

describe("活动输入页：单项活动", () => {
  const sessions = [session("S1", "早先的会话", "2026-10-12T10:00:00"), session("S2", "最近的会话", "2026-10-13T08:30:00")];
  const filled = statusOf({ assets: assets({ materials: 1, description: 3 }) });

  it("整理建模：只有范围说明一块；摘要写目的、产出、前提；任务已经有会话时也没有会话的选择，启动一律新建", async () => {
    page("modeling", detail({ sessions }), filled);
    expect(await submit()).toHaveTextContent("启动整理建模");
    expect(screen.getByTestId("start-subtitle")).toHaveTextContent("批处理");
    expect(screen.queryByTestId("start-steps")).toBeNull();
    expect([...screen.getByTestId("start-summary").querySelectorAll("dt, dd")].map(text)).toEqual(["目的", "整理建模的目的。", "产出", "分析模型、业务说明", "前提", "业务说明至少一节。"]);
    expect([screen.queryByTestId("materials-card"), screen.queryByTestId("knowledge-choice"), screen.queryByTestId("describe-block")]).toEqual([null, null, null]);
    expect(screen.getByTestId("scope-block")).toBeInTheDocument();
    expect([...screen.getByTestId("start-after").querySelectorAll("li")].map(text)).toEqual([
      "助手进行「整理建模」，完成后在对话区汇报结果，不提议下一站。", "页面切换为工作台：左侧对话区、中间业务说明与需求条目、右侧材料与修订。"]);
    expect([screen.queryByTestId("start-session"), screen.queryByTestId("session-current"), screen.queryByTestId("session-new")]).toEqual([null, null, null]);
    expect(screen.getByTestId("start-where")).toHaveTextContent("将新建一个工作项和一条属于它的会话，并进入工作台。");
  });

  it("任务已经有会话：照样新建一个工作项与一条会话，不在原来的会话里做；范围说明随启动的请求发出、不拼进第一句话；第一句话是这项活动的那句固定的话", async () => {
    const calls = page("modeling", detail({ sessions }), filled);
    await submit();
    type("scope-input", "  只整理「借书」一节的流程图。 ");
    fireEvent.click(await submit());
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
    expect(calls.order).toEqual(["start_new", "say"]);
    expect(calls.startNew).toHaveBeenCalledWith("TASK-P", { activity: "modeling", in_flow: false, scope: "只整理「借书」一节的流程图。" });
    expect(calls.action).not.toHaveBeenCalled();
    expect(calls.say.mock.calls[0].slice(0, 2)).toEqual(["TASK-P", "S-new"]);
    expect(calls.say.mock.calls[0][2]).toMatchObject({ text: "请开始整理建模。" });
  });

  it("没有写范围说明就不带这一项", async () => {
    const calls = page("modeling", detail({ sessions }), filled);
    fireEvent.click(await submit());
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
    expect(calls.startNew).toHaveBeenCalledWith("TASK-P", { activity: "modeling", in_flow: false });
    expect(calls.action).not.toHaveBeenCalled();
  });

  it("核读材料有项目材料与领域知识库两块；澄清从空白开始时有目标系统描述（可选）与范围说明，写了描述就把它作为第一句话", async () => {
    page("reading", detail({ materials: [material("inputs/调研记录.md")] }), statusOf({ assets: assets({ materials: 1 }) }));
    await submit();
    expect(text(screen.getByTestId("materials-card").querySelector(".tp-sec-h"))).toBe("项目材料1 份");
    expect(await screen.findByTestId("knowledge-choice")).toBeInTheDocument();
    expect([screen.queryByTestId("describe-block"), !!screen.queryByTestId("scope-block")]).toEqual([null, true]);
    cleanup(); vi.restoreAllMocks();
    const calls = page("clarifying");
    expect(await submit()).toBeEnabled();
    expect(text(screen.getByTestId("describe-block").querySelector(".aside"))).toBe("可选 · 作为会话的第一条消息发给助手");
    expect(screen.getByTestId("scope-block")).toBeInTheDocument();
    type("describe-input", "建设图书馆借阅管理系统。");
    fireEvent.click(await submit());
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
    expect(calls.startNew).toHaveBeenCalledWith("TASK-P", { activity: "clarifying", in_flow: false });
    expect(calls.say.mock.calls[0][2]).toMatchObject({ text: "建设图书馆借阅管理系统。" });
  });

  it("已经有别的工作项：「启动后」不说别的工作项怎样，它们各自留着", async () => {
    const work = { record_id: 2, kind: "flow", name: "需求分析", latest_session: { session_id: "S2", name: "需求分析 · 核读材料", last_active_at: "2026-10-13T08:30:00" } };
    page("modeling", detail({ sessions }), statusOf({ assets: assets({ description: 3 }), work_items: [work] as unknown as TaskStatusView["work_items"] }));
    await submit();
    expect(text(screen.getByTestId("start-after").querySelector("li"))).toBe("助手进行「整理建模」，完成后在对话区汇报结果，不提议下一站。");
    expect(screen.getByTestId("start-after").textContent).not.toMatch(/结束|开展/);
  });
});

describe("活动输入页：启动不了的情形", () => {
  const sessions = [session("S2", "最近的会话", "2026-10-13T08:30:00")];

  it("启动没有成（例如助手正在工作）：照写后端的原话，留在这一页，不发第一句话；请求回来之前主按钮点不动", async () => {
    const calls = page("modeling", detail(), statusOf({ assets: assets({ description: 3 }) }));
    let fail: (reason: unknown) => void = () => {};
    calls.startNew.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    fireEvent.click(await submit());
    await waitFor(() => expect(screen.getByTestId("start-submit")).toBeDisabled());
    fail(new ApiError("session_busy", "助手正在另一条会话里工作，做完才能在这里继续。", 409));
    expect(await screen.findByText("助手正在另一条会话里工作，做完才能在这里继续。")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("start-submit")).toBeEnabled());
    expect(calls.say).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("启动成了而第一句话没有发出去：写明原因，照样进工作台", async () => {
    const calls = page("modeling", detail(), statusOf({ assets: assets({ description: 3 }) }));
    calls.say.mockRejectedValue(new ApiError("session_busy", "助手正在工作。", 409));
    fireEvent.click(await submit());
    expect(await screen.findByText("已经启动「整理建模」，但第一句话没有发出去：助手正在工作。 请在对话区再说一遍。")).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
  });

  it("缺前提的活动：主按钮点不动，旁边写缺什么，没有「打开它的会话」", async () => {
    const calls = page("modeling", detail({ sessions }), statusOf({ catalog: { flows: [flowOf()], activities: [activityOf("modeling", "整理建模", { enabled: false, state: "业务说明还没有内容" })] } }));
    expect(await submit()).toBeDisabled();
    expect(screen.getByTestId("start-blocked")).toHaveTextContent("现在还不能启动：业务说明还没有内容。");
    expect(screen.queryByTestId("start-open-flow-session")).toBeNull();
    fireEvent.click(await submit());
    expect(calls.startNew).not.toHaveBeenCalled();
  });

  it("活动目录里没有这一项、任务已经结束：不画输入，写明原因，留着「返回任务起点」", async () => {
    page("nothing");
    expect(await screen.findByTestId("start-unknown")).toHaveTextContent("活动目录里没有这一项，请回任务起点重新选择。");
    expect(screen.getByTestId("back-to-start")).toBeInTheDocument();
    expect(screen.queryByTestId("start-submit")).toBeNull();
  });
});

describe("从待处理事项进入澄清的输入页", () => {
  const f = (name: string, type: string, values: string[] | null = null) => ({ name, type, required: false, values });
  const QUESTIONS = { name: "问题", prefix: "TBD", fields: [f("事项", "文本"), f("种类", "枚举", ["待澄清", "范围外", "后续迭代"]), f("是否阻断下游", "枚举", ["阻断下游", "不阻断"]),
    f("何时回看", "文本"), f("状态", "枚举", ["未解决", "已解决", "用户决定保留"]), f("关联条目", "条目引用")] };
  const q = (id: string, title: string, block: string) => ({ item_id: id, collection: "问题", title, revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
    fields: { 事项: title, 种类: "待澄清", 是否阻断下游: block, 状态: "未解决", 关联条目: [] }, sources: [], reviews: [], waivers: [], confirmations: [] });
  const lamps = { reading: [], clarifying: [{ key: "decisions_have_goal", ok: false, items: ["OA-003"], summary: "" }], modeling: [], writing: [], reviewing: [], document: [] };
  const withQuestions = detail({
    definition: { collections: [QUESTIONS] }, stage: { current: "idle", moved_by: null, moved_at: null, reason: null, lamps },
    items: [q("TBD-001", "续借次数是否设上限", "阻断下游"), q("TBD-002", "预约保留期多长", "不阻断"),
      { ...q("OA-003", "逾期不能续借", ""), collection: "总体分析", fields: {} }],
  } as unknown as Partial<TaskDetail>);
  const filled = statusOf({ assets: assets({ description: 3 }) });

  it("澄清的输入页在范围说明之上有「待澄清问题」勾选块：阻断的在前，待决定事项在后；地址带的几项预先勾好，勾选的编号写在范围说明的开头一起发出", async () => {
    const calls = page("clarifying", withQuestions, filled, { pick: ["TBD-001", "OA-003", "TBD-999"] });
    await submit();
    const block = screen.getByTestId("pick-block");
    expect([...block.querySelectorAll("label")].map((one) => [text(one), (one.querySelector("input") as HTMLInputElement).checked])).toEqual([
      ["TBD-001 续借次数是否设上限阻断下游", true], ["TBD-002 预约保留期多长不阻断", false], ["OA-003 逾期不能续借待决定事项 · 「决定」还没有写为了哪个目标", true]]);
    expect(block.compareDocumentPosition(screen.getByTestId("scope-block")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 地址里有、清单上没有的编号不算。
    expect(screen.getByTestId("pick-note")).toHaveTextContent("范围说明的开头将写：只澄清这几项：TBD-001、OA-003。");
    fireEvent.click(within(screen.getByTestId("pick-TBD-002")).getByRole("checkbox"));
    fireEvent.click(within(screen.getByTestId("pick-OA-003")).getByRole("checkbox"));
    type("scope-input", " 先问上限。 ");
    fireEvent.click(await submit());
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
    expect(calls.startNew).toHaveBeenCalledWith("TASK-P", { activity: "clarifying", in_flow: false, scope: "只澄清这几项：TBD-001、TBD-002。\n先问上限。" });
  });

  it("没有勾选时写一句提示；别的活动的输入页、没有可勾的问题时没有这一块", async () => {
    page("clarifying", withQuestions, filled);
    await submit();
    expect(screen.getByTestId("pick-note")).toHaveTextContent("没有勾选时，在下方范围说明里写明要澄清的范围。");
    cleanup(); vi.restoreAllMocks();
    page("modeling", withQuestions, filled, { pick: ["TBD-001"] });
    await submit();
    expect(screen.queryByTestId("pick-block")).toBeNull();
    cleanup(); vi.restoreAllMocks();
    page("clarifying", detail(), filled);
    await submit();
    expect(screen.queryByTestId("pick-block")).toBeNull();
  });
});
