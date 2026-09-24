// 改动块的拼装（实时与刷新后重建）、放在对话里的位置、「第 N 版 · 刚改」、过程摘要的渲染与替换。

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";

import type { ConversationMessage, ItemVersion, Snapshot, Task } from "../api/types";
import { api } from "../api/client";
import { initialWorkState, workReducer, type WorkState } from "../state/workState";
import { entryView, justChanged, placeBlocks, rebuildBlocks, type ChangeBlock } from "../model/changes";
import { Conversation } from "../components/work/Conversation";
import { ItemStatus } from "../components/work/ItemStatus";
import { ItemDetail } from "../components/work/ItemDetail";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const SESSION = "s-1";

function task(): Task {
  return {
    task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "用例", prefix: "UC", fields: [
        { name: "名称", type: "文本", required: true, values: null },
        { name: "步骤", type: "文本列表", required: true, values: null }] },
      { name: "待定事项", prefix: "TBD", fields: [
        { name: "事项", type: "文本", required: true, values: null },
        { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] },
        { name: "处理结果", type: "文本", required: false, values: null }] }] },
    completion: null,
    items: [
      { item_id: "UC-001", collection: "用例", title: "登录", version_no: 1, version_by: "executor", version_at: "", version_count: 1,
        fields: { 名称: "登录", 步骤: ["输入账号"] }, sources: [], reviews: [], confirmations: [], confirmation_stale: false },
      { item_id: "TBD-001", collection: "待定事项", title: "密码规则", version_no: 1, version_by: "executor", version_at: "", version_count: 1,
        fields: { 事项: "密码规则", 状态: "未解决", 处理结果: "" }, sources: [], reviews: [], confirmations: [], confirmation_stale: false },
    ],
  };
}

function snapshot(): Snapshot {
  return {
    seq: 4, generated_at: "", executor: { state: "idle", text: "", active_session: SESSION },
    session: { session_id: SESSION, name: "会话", started_at: "", last_active_at: "" },
    task: task(), materials: [], conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null,
  };
}

const sse = (event: string, data: Record<string, unknown>) => ({ type: "sse" as const, event, data });
const run = (state: WorkState, ...actions: Parameters<typeof workReducer>[1][]) => actions.reduce(workReducer, state);

/** 执行者在 w1 这次工作里改了 UC-001（加一步）与 TBD-001（状态改成已解决、写上处理结果）。 */
const executorRevision = (seq: number, actor = "executor") => sse("deliverable_changed", {
  seq, at: "2026-09-22T10:00:05+08:00", task_id: "TASK-001", revision_no: seq - 3, actor, op_id: actor === "user" ? "ui-op-1" : null,
  undo_of_revision: null, completion: null, operations: [
    { op: "update", collection: "用例", item_id: "UC-001", title: "登录", version_before: 1, version_after: 2,
      fields: { 名称: "登录", 步骤: ["输入账号", "输入密码"] }, sources: [] },
    { op: "update", collection: "待定事项", item_id: "TBD-001", title: "密码规则", version_before: 1, version_after: 2,
      fields: { 事项: "密码规则", 状态: "已解决", 处理结果: "至少八位" }, sources: [] },
  ],
});

describe("改动块：实时拼装", () => {
  it("同一次工作里执行者的修订拼成一块；变了哪些字段由前后两版比出，待定事项单列状态变化与处理结果", () => {
    const s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot() },
      sse("work_started", { session_id: SESSION, work_id: "w1", at: "", triggered_by: "u1" }),
      executorRevision(5),
      sse("assistant_reply", { session_id: SESSION, message_id: "r1", at: "", work_id: "w1", via_reply_tool: true, informs: [], act: null, text: "改好了" }));
    expect(s.changeBlocks.map((b) => [b.key, b.revisions, b.entries.map((e) => e.item_id)])).toEqual([["work-w1", [2], ["UC-001", "TBD-001"]]]);
    const [uc, tbd] = s.changeBlocks[0].entries;
    expect(entryView(s.task, uc)).toEqual({ fields: ["步骤"], status: null, notes: [] });
    expect(entryView(s.task, tbd)).toEqual({ fields: ["状态", "处理结果"], status: { field: "状态", before: "未解决", after: "已解决" },
      notes: [{ field: "处理结果", value: "至少八位" }] });
    expect(justChanged(s.changeBlocks)).toEqual({ "UC-001": 2, "TBD-001": 2 });
  });

  it("用户直接操作的修订不进改动块；同一次工作里同一条目改两次合成一条，改前取最早那次", () => {
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot() }, executorRevision(5, "user"));
    expect(s.changeBlocks).toEqual([]);
    s = run(s, sse("work_started", { session_id: SESSION, work_id: "w2", at: "", triggered_by: null }),
      sse("deliverable_changed", { seq: 6, at: "", task_id: "TASK-001", revision_no: 3, actor: "executor", op_id: null, undo_of_revision: null, completion: null,
        operations: [{ op: "update", collection: "用例", item_id: "UC-001", title: "登录", version_before: 2, version_after: 3, fields: { 名称: "登录", 步骤: ["输入账号", "输入密码", "点登录"] }, sources: [] }] }),
      sse("deliverable_changed", { seq: 7, at: "", task_id: "TASK-001", revision_no: 4, actor: "executor", op_id: null, undo_of_revision: null, completion: null,
        operations: [{ op: "update", collection: "用例", item_id: "UC-001", title: "用户登录", version_before: 3, version_after: 4, fields: { 名称: "用户登录", 步骤: ["输入账号", "输入密码", "点登录"] }, sources: [] }] }));
    const [entry] = s.changeBlocks[0].entries;
    expect([s.changeBlocks[0].revisions, entry.version_before, entry.version_after, entry.title]).toEqual([[3, 4], 2, 4, "用户登录"]);
    expect(entryView(s.task, entry).fields).toEqual(["名称", "步骤"]);
  });

  it("后端的过程摘要换掉 work_ended 时前端先拼的那一条；先到的摘要不会被 work_ended 再拼一次", () => {
    const summary = { session_id: SESSION, work_id: "w1", at: "", seconds: 12, step_count: 3, stages: [{ text: "读了材料《甲.md》、《乙.md》" }] };
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot() },
      sse("work_started", { session_id: SESSION, work_id: "w1", at: "", triggered_by: null }),
      sse("step", { session_id: SESSION, work_id: "w1", step_key: "w1-0", text: "读了材料《甲.md》", in_progress: false, failed: false }),
      sse("work_ended", { session_id: SESSION, work_id: "w1", at: "", seconds: 12, step_count: 3, outcome: "replied" }),
      sse("work_summary", summary));
    expect(s.messages.filter((m) => m.type === "work_summary")).toEqual([{ ...summary, type: "work_summary" }]);
    s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot() },
      sse("work_started", { session_id: SESSION, work_id: "w1", at: "", triggered_by: null }), sse("work_summary", summary),
      sse("work_ended", { session_id: SESSION, work_id: "w1", at: "", seconds: 12, step_count: 3, outcome: "replied" }));
    expect(s.messages.filter((m) => m.type === "work_summary")).toHaveLength(1);
    expect(s.currentWork).toBeNull();
  });
});

describe("改动块：刷新后从条目版本历史重建", () => {
  const version = (no: number, revision: number, at: string, fields: Record<string, string | string[]>, by = "executor"): ItemVersion =>
    ({ version_no: no, revision_no: revision, by, at, fields, sources: [], reviews: [], confirmations: [] });
  const messages: ConversationMessage[] = [
    { type: "user_message", message_id: "u1", at: "2026-09-22T10:00:00+08:00", text: "整理", origin: "typed", annotation: null, queued: false },
    { type: "work_summary", message_id: "summary-u1", work_id: "w-u1", at: "2026-09-22T10:00:20+08:00", seconds: 20, step_count: 3, stages: [] },
    { type: "assistant_reply", message_id: "r1", at: "2026-09-22T10:00:20+08:00", work_id: "w-u1", via_reply_tool: true, informs: [], act: null, text: "好了" },
    { type: "user_message", message_id: "u2", at: "2026-09-22T10:05:00+08:00", text: "再改", origin: "typed", annotation: null, queued: false },
  ];
  const versions = {
    "UC-001": [version(1, 1, "2026-09-22T10:00:05+08:00", { 名称: "登录", 步骤: ["输入账号"] }),
      version(2, 2, "2026-09-22T10:00:15+08:00", { 名称: "登录", 步骤: ["输入账号", "输入密码"] }),
      version(3, 3, "2026-09-22T10:03:00+08:00", { 名称: "登录", 步骤: ["输入账号", "输入密码", "改过"] }, "user"),
      version(4, 4, "2026-09-22T10:08:00+08:00", { 名称: "登录", 步骤: ["输入账号"] })],
    "TBD-001": [version(1, 1, "2026-09-22T10:00:05+08:00", { 事项: "密码规则", 状态: "未解决", 处理结果: "" })],
  };

  it("落在工作时间范围里的修订归到那次工作；用户的版本不算；对不上工作的按修订序号单独成块", () => {
    const blocks = rebuildBlocks(task(), versions, messages);
    expect(blocks.map((b) => [b.key, b.revisions])).toEqual([["work-w-u1", [1, 2]], ["rev-4", [4]]]);
    const uc = blocks[0].entries.find((e) => e.item_id === "UC-001")!;
    expect([uc.op, uc.version_before, uc.version_after]).toEqual(["add", null, 2]);
    const late = blocks[1].entries[0];
    expect([late.op, late.version_before, late.version_after]).toEqual(["update", 3, 4]);
    // 最近一块是 rev-4：UC-001 被改回去，算「刚改」；第一块里的新增不算。
    expect(justChanged(blocks)).toEqual({ "UC-001": 4 });
  });

  it("放的位置：有工作编号的放在这次工作的回复之前；单独成块的按时刻插进去", () => {
    const placed = placeBlocks(rebuildBlocks(task(), versions, messages), messages);
    expect([...placed.entries()].map(([i, bs]) => [i, bs.map((b) => b.key)])).toEqual([[2, ["work-w-u1"]], [4, ["rev-4"]]]);
  });
});

describe("改动块与过程摘要的渲染", () => {
  const block: ChangeBlock = {
    key: "work-w1", work_id: "w1", revisions: [2], at: "2026-09-22T10:00:05+08:00",
    entries: [
      { item_id: "UC-001", collection: "用例", title: "登录", op: "update", version_before: 1, version_after: 2,
        before: { 名称: "登录", 步骤: ["输入账号"] }, after: { 名称: "登录", 步骤: ["输入账号", "输入密码"] } },
      { item_id: "TBD-001", collection: "待定事项", title: "密码规则", op: "update", version_before: 1, version_after: 2,
        before: { 事项: "密码规则", 状态: "未解决", 处理结果: "" }, after: { 事项: "密码规则", 状态: "已解决", 处理结果: "至少八位" } },
    ],
  };

  it("改动块在这次工作的回复上方，逐条写版本、改了哪些字段、状态与处理结果；「查看差异」打开条目", () => {
    const onOpenDiff = vi.fn();
    const noop = () => {};
    const messages: ConversationMessage[] = [
      { type: "user_message", message_id: "u1", at: "", text: "就这样做。", origin: "card_choice", annotation: null, queued: false },
      { type: "work_summary", message_id: "summary-u1", work_id: "w1", at: "", seconds: 75, step_count: 4, stages: [{ text: "读了材料《甲.md》、《乙.md》" }, { text: "组织并发出了回复" }] },
      { type: "assistant_reply", message_id: "r1", at: "", work_id: "w1", via_reply_tool: true, informs: [], act: null, text: "改好了" },
    ];
    render(<Wrap><Conversation messages={messages} currentWork={null} outgoing={[]} task={task()} disabled={false} disabledReason={null}
      handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
      hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} blocks={[block]} onOpenDiff={onOpenDiff} /></Wrap>);
    const chg = screen.getByTestId("change-block");
    const reply = screen.getByTestId("assistant-reply");
    expect(chg.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("change-UC-001")).toHaveTextContent("第 1 版 → 第 2 版");
    expect(screen.getByTestId("change-UC-001")).toHaveTextContent("改了 1 个字段：步骤");
    expect(screen.getByTestId("change-TBD-001")).toHaveTextContent("状态：未解决 → 已解决");
    expect(screen.getByTestId("change-TBD-001")).toHaveTextContent("处理结果：至少八位");
    fireEvent.click(screen.getByTestId("change-open-UC-001"));
    expect(onOpenDiff).toHaveBeenCalledWith("UC-001");
    // 过程摘要收成一行，点开是合并后的阶段
    expect(screen.getByTestId("work-summary")).toHaveTextContent("助手做了 4 步，用了 1 分 15 秒 ▸ 展开看做了什么");
    fireEvent.click(screen.getByTestId("work-summary"));
    expect(screen.getByTestId("work-summary-stages")).toHaveTextContent("读了材料《甲.md》、《乙.md》组织并发出了回复");
  });

  it("条目行与详情上的「第 N 版 · 刚改」只在版本对得上时出现", () => {
    const t = task();
    t.items[0] = { ...t.items[0], version_no: 2, version_count: 2 };
    const { rerender } = render(<Wrap><ItemStatus task={t} item={t.items[0]} justVersion={2} /></Wrap>);
    expect(screen.getByTestId("just-UC-001")).toHaveTextContent("第 2 版 · 刚改");
    rerender(<Wrap><ItemStatus task={t} item={t.items[0]} justVersion={1} /></Wrap>);
    expect(screen.queryByTestId("just-UC-001")).toBeNull();
  });

  it("详情默认落在版本比对：与上一版不同的地方画线，列表字段标出新加的一步", async () => {
    const t = task();
    const item = { ...t.items[0], version_no: 2, version_count: 2, fields: { 名称: "登录", 步骤: ["输入账号", "输入密码"] } };
    const spy = vi.spyOn(api, "itemVersions").mockResolvedValue([
      { version_no: 1, revision_no: 1, by: "executor", at: "", fields: { 名称: "登录", 步骤: ["输入账号"] }, sources: [], reviews: [], confirmations: [] },
      { version_no: 2, revision_no: 2, by: "executor", at: "", fields: item.fields, sources: [], reviews: [], confirmations: [] },
    ]);
    render(<Wrap><ItemDetail task={t} item={item} def={t.definition.collections[0]} readOnly={false} pending={false}
      submit={vi.fn(async () => null)} justVersion={2} /></Wrap>);
    await waitFor(() => expect(screen.getByTestId("compare-banner")).toHaveTextContent("是助手最近一次工作刚改的"));
    expect(document.querySelector(".diff-new")?.textContent).toBe("输入密码");
    expect(screen.getByText("（这一版新加的）")).toBeInTheDocument();
    spy.mockRestore();
  });
});
