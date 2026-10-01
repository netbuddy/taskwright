// 任务页的六块：任务头、完成条件横条、交付物的集合卡、会话清单、材料卡、选用的知识库。
// 集合卡上的数字与悬停提示另见 boardText.test.tsx 与 reviewCounts.test.tsx；随助手做完一轮重读见 taskPageEvents.test.tsx。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { Completion, CompletionCondition, Item, KnowledgeLibrary, ServiceInfo, SessionListEntry, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { NO_SESSION_TITLE } from "../components/task/CollectionCards";
import { completionLines, completionScore } from "../model/completionLines";
import { formatTimeShort } from "../model/format";
import { TaskPage } from "../pages/TaskPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

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
    task_id: "TASK-P", task_name: "退款需求走查", task_type: "软件需求规格说明编制", domain_tag: null, status: "进行中",
    started_at: "2026-09-28T17:49:00", ended_at: null,
    definition: { collections: COLLECTIONS }, items: [], completion: null, latest_revision: 0, sessions: [],
    materials: [], knowledge_libraries: ["general", "lib-cb"], ...over,
  } as unknown as TaskDetail;
}

function page(task: TaskDetail = detail(), serviceInfo: ServiceInfo = info) {
  const calls = {
    get: vi.spyOn(api, "getTask").mockResolvedValue(task),
    material: vi.spyOn(api, "uploadMaterial").mockResolvedValue({ path: "inputs/a.md" }),
    document: vi.spyOn(api, "uploadDocument").mockResolvedValue({ name: "a.md", kind: "other", bytes: 1, uploaded_at: "" }),
    select: vi.spyOn(api, "setTaskKnowledge").mockImplementation(async (_t, ids) => ids),
    remove: vi.spyOn(api, "deleteMaterial").mockResolvedValue({ ok: true, path: "inputs/借阅说明.md" }),
    newSession: vi.spyOn(api, "createSession").mockResolvedValue({ session_id: "S-new" }),
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

describe("任务头", () => {
  it("写面包屑、任务名、状态、任务类型和两个按钮；创建时刻与最近一次活动合成一句", async () => {
    page(detail({ domain_tag: "电商售后", sessions: [session("S1", "第一句", "2026-09-28T18:02:00"), session("S2", "第二句", "2026-09-29T10:02:00")] }));
    const root = await ready();
    expect(text(root.querySelector(".tp-crumb"))).toBe("任务›退款需求走查");
    expect(root.querySelector(".tp-crumb a")).toHaveAttribute("href", "#/tasks");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("退款需求走查");
    expect(screen.getByTestId("task-status")).toHaveTextContent("进行中");
    expect(screen.getByTestId("task-status")).toHaveClass("on");
    expect([...root.querySelectorAll(".tp-ttype")].map(text)).toEqual(["软件需求规格说明编制", "电商售后"]);
    expect(screen.getByTestId("task-meta").textContent).toBe("创建于 2026-09-28 17:49，最近一次活动在 2026-09-29 10:02。");
    expect(screen.getByRole("button", { name: "生成文档" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建会话/ })).toBeInTheDocument();
  });

  it("还没有会话时只写创建时刻；点「新建会话」调新建接口并进入那条会话的工作视图", async () => {
    const calls = page();
    await ready();
    expect(screen.getByTestId("task-meta").textContent).toBe("创建于 2026-09-28 17:49。");
    fireEvent.click(screen.getByRole("button", { name: /新建会话/ }));
    await waitFor(() => expect(calls.newSession).toHaveBeenCalledWith("TASK-P"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
  });

  it("任务已完成：状态是灰底，写明整页只读，没有「新建会话」、上传区、材料的「删除」与知识库的改选用", async () => {
    page(detail({ status: "已完成", materials: [{ path: "inputs/借阅说明.md", bytes: 5, modified_at: "2026-09-28T17:50:00", derived_from: null, deletable: false }] }));
    await ready();
    expect(screen.getByTestId("task-status")).toHaveTextContent("已完成");
    expect(screen.getByTestId("task-status")).not.toHaveClass("on");
    expect(screen.getByText("这个任务已完成，整页只读：不能新建会话、上传材料或修改条目，生成文档照常可用。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新建会话/ })).toBeNull();
    expect(screen.queryByTestId("upload-hint")).toBeNull();
    expect(screen.queryByTestId("material-delete")).toBeNull();
    await screen.findByTestId("kb-row-lib-cb");
    expect(screen.queryByTestId("kb-pick")).toBeNull();
    expect(screen.queryByText("不再选用")).toBeNull();
    expect(screen.getByRole("button", { name: "生成文档" })).toBeInTheDocument();
  });
});

describe("完成条件横条", () => {
  const items = [
    item("UC-001", "功能用例"), item("UC-002", "功能用例", { confirmations: [] }),
  ];
  const conditions = [
    cond("功能用例", "至少一个条目", "met", [], "现在有 2 个条目。"),
    cond("功能用例", "每个条目评审通过", "unmet", ["UC-001", "UC-002"], "UC-001、UC-002 还没评审。"),
    cond("功能用例", "每个条目用户确认", "unmet", ["UC-002"], "有 1 个条目用户还没看过这个条目（未读）。"),
    cond("非功能需求", "每个条目评审通过", "empty"),
    cond("非功能需求", "每个条目用户确认", "empty"),
    cond("问题", "没有状态为未解决的条目", "empty"),
  ];

  it("分数只数用得上的条件；已满足、还差、暂时不用核对各写一句，带集合名与条目编号", async () => {
    page(detail({ items, completion: completionOf(conditions) }));
    await ready();
    expect(screen.getByTestId("completion-score").textContent).toBe("1/3");
    const bar = screen.getByTestId("completion-bar");
    expect([...bar.querySelectorAll(".tp-conds li")].map((li) => `${li.getAttribute("data-testid")}：${text(li)}`)).toEqual([
      "cond-met：功能用例至少有一个条目，这一条已经满足。",
      "cond-unmet：功能用例的每个条目都要评审通过，UC-001 和 UC-002 还在等评审。",
      "cond-unmet：功能用例的每个条目都要经你确认，UC-002 你还没有读过。",
      "cond-empty：非功能需求的每个条目都要评审通过，现在还没有条目，这一条暂时不用核对。",
      "cond-empty：非功能需求的每个条目都要经你确认，现在还没有条目，这一条暂时不用核对。",
      "cond-empty：问题里不能有状态为未解决的条目，现在还没有条目，这一条暂时不用核对。",
    ]);
    // 条目编号用等宽字写；三种记号各是各的：勾、圈、短横。
    expect([...bar.querySelectorAll(".tp-conds .unmet .mono")].map(text)).toEqual(["UC-001", "UC-002", "UC-002"]);
    expect(bar.querySelectorAll(".met .anticon-check").length).toBe(1);
    expect(bar.querySelectorAll(".unmet .ring").length).toBe(2);
    expect(bar.querySelectorAll(".empty .anticon-minus").length).toBe(3);
    expect(bar.textContent).not.toContain("用户");
  });

  it("全部满足时整块换成一句话，不再列条件与分数；任务已完成时那句话写已经标记为完成", async () => {
    const all = completionOf([cond("功能用例", "至少一个条目", "met"), cond("功能用例", "每个条目评审通过", "met"), cond("问题", "没有状态为未解决的条目", "empty")]);
    page(detail({ items, completion: all }));
    await ready();
    expect(screen.getByTestId("completion-all-met")).toHaveTextContent("完成条件已全部满足，可以在会话里请助手标记完成。");
    expect(screen.queryByTestId("completion-score")).toBeNull();
    expect(screen.queryByTestId("cond-met")).toBeNull();
    cleanup(); vi.restoreAllMocks();
    page(detail({ status: "已完成", items, completion: all }));
    await ready();
    expect(screen.getByTestId("completion-all-met").textContent).toBe("完成条件已全部满足，任务已经标记为完成。");
  });

  it("完成条件之外的提示列在末尾，写明不挡完成任务；完成条件没有算出来时照实写", async () => {
    const hint = { kind: "unlinked_domain_notes" as const, collection: "问题", items: ["DN-003"], summary: "有 1 条领域说明还没有和任何条目关联：DN-003。" };
    page(detail({ items, completion: completionOf(conditions, [hint]) }));
    await ready();
    const rows = screen.getByTestId("completion-bar").querySelectorAll(".tp-conds li");
    expect(rows[rows.length - 1]).toHaveAttribute("data-testid", "cond-hint");
    expect(text(rows[rows.length - 1])).toBe("提示：有 1 条领域说明还没有和任何条目关联：DN-003。这一条不挡完成任务，只是告诉你哪些还没用上。");
    cleanup(); vi.restoreAllMocks();
    page(detail({ completion: null }));
    await ready();
    expect(screen.getByTestId("completion-bar")).toHaveTextContent("完成条件这次没有算出来。");
  });

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
      cond("功能用例", "每个条目都有来源", "empty"),
    ])).toEqual([
      "功能用例的每个条目都要评审通过，UC-001 还在等评审，UC-002 评审不通过；UC-003 评审不通过，但你保留了写法。",
      "功能用例的每个条目都要评审通过，这一条已经满足；UC-003 评审不通过，但你保留了写法。",
      "功能用例的每个条目都要经你确认，有 7 个条目你还没有读过。",
      "功能用例的每个条目都要经你确认，这一条已经满足。",
      "功能用例至少要有一个条目，现在一个也没有。",
      "问题里不能有状态为未解决的条目，TBD-001 还没有解决。",
      "问题里不能有状态为未解决的条目，这一条已经满足。",
      "功能用例：每个条目都有来源，UC-001 没有来源。",
      "功能用例：每个条目都有来源，这个集合现在还没有条目，这一条暂时不用核对。",
    ]);
    expect(completionScore(completionOf([cond("甲", "x", "met"), cond("甲", "y", "unmet"), cond("乙", "x", "empty")]))).toEqual({ met: 1, total: 2 });
  });
});

describe("交付物", () => {
  it("写「最后改在修订 N」；有会话时集合卡是链接，进最近活动的那条会话的工作视图并带上集合名", async () => {
    page(detail({ latest_revision: 4, items: [item("UC-001", "功能用例")],
      sessions: [session("S-old", "早的", "2026-09-28T18:02:00"), session("S-new", "晚的", "2026-09-29T10:02:00"), session("S-blank", null, null)] }));
    await ready();
    expect(screen.getByTestId("latest-revision").textContent).toBe("最后改在修订 4");
    const card = screen.getByTestId("board-功能用例");
    expect(card.tagName).toBe("A");
    expect(card).toHaveAttribute("href", `#/tasks/TASK-P/sessions/S-new?collection=${encodeURIComponent("功能用例")}`);
    expect(card.getAttribute("title")).toContain("点这张卡进入工作视图，只看功能用例。");
    expect(screen.getByTestId("board-问题")).toHaveAttribute("href", `#/tasks/TASK-P/sessions/S-new?collection=${encodeURIComponent("问题")}`);
    // 每个集合一种颜色，按先后取。
    expect(["功能用例", "非功能需求", "问题"].map((name) => screen.getByTestId(`board-${name}`).className.match(/\bc\d\b/)?.[0])).toEqual(["c1", "c2", "c3"]);
  });

  it("还没有会话时集合卡不可点，悬停提示写明原因；还没有修订时不写「最后改在」", async () => {
    page(detail({ items: [] }));
    await ready();
    const card = screen.getByTestId("board-功能用例");
    expect(card.tagName).toBe("DIV");
    expect(card).not.toHaveAttribute("href");
    expect(card.getAttribute("title")).toBe(`功能用例还没有条目。${NO_SESSION_TITLE}`);
    expect(NO_SESSION_TITLE).toBe("还没有会话，新建会话之后可以从这里进入工作视图。");
    expect(screen.queryByTestId("latest-revision")).toBeNull();
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
    expect(screen.getByTestId("session-empty").textContent).toBe("还没有会话。点右上角「新建会话」开始。");
    cleanup(); vi.restoreAllMocks();
    page(detail({ sessions: [
      session("S1", "第一句", "2026-09-28T18:02:00", { revision_count: undefined, message_count: 7 }),
      session("S2", null, null, { message_count: 0 }),
    ] }));
    await ready();
    expect(screen.getAllByTestId("session-row").map(text)).toEqual([
      "新会话，还没有说过话。还没有活动·这条会话还没有产生修订。打开", "第一句最近活动在 2026-09-28 18:02·一共 7 条消息。打开"]);
  });
});

describe("材料", () => {
  const materials = [
    { path: "inputs/借阅说明.md", bytes: 181, modified_at: "2026-09-28T17:49:00", derived_from: null, deletable: false },
    { path: "inputs/补充说明.docx", bytes: 24 * 1024, modified_at: "2026-09-28T17:52:00", derived_from: null, deletable: true },
    { path: "inputs/补充说明.docx.md", bytes: 9, modified_at: "2026-09-28T17:52:00", derived_from: "inputs/补充说明.docx", deletable: false },
  ];

  it("材料表列出名称、大小、上传时间与「查看」；只有 deletable 为真的那份另有「删除」；由 Word 材料生成的文件不列", async () => {
    page(detail({ materials }));
    await ready();
    expect(screen.getByTestId("material-count").textContent).toBe("2 份");
    const rows = screen.getAllByTestId("material-row");
    expect(rows.map((r) => [...r.querySelectorAll("td")].map(text))).toEqual([
      ["借阅说明.md", "181 字节", "2026-09-28 17:49", "查看"],
      ["补充说明.docx", "24.0 KB", "2026-09-28 17:52", "查看删除"],
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
