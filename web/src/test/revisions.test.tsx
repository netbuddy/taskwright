// 工作视图的这几样行为：单一写入者的两种禁用状态、对话严格轮替、字段修订标识（以上次确认为基准）、
// 右侧栏「修订」页签与点选高亮、回复底部的修订标签、按修订生成文档、字号三档。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";

import type { AssistantReply, Item, RevisionLogEntry, Task, WorkSummary } from "../api/types";
import { api } from "../api/client";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ItemDetail } from "../components/work/ItemDetail";
import { Conversation, WorkSummaryLine } from "../components/work/Conversation";
import { ReplyCard } from "../components/work/ReplyCard";
import { SidePanel } from "../components/work/SidePanel";
import { DocumentModal } from "../components/DocumentModal";
import { aliveAt, justChangedItems, markedFields, marksByItem, revisionsOfReply, triggerText, undoBlocked } from "../model/revisions";
import { readFontTier, saveFontTier } from "../model/fontScale";
import { isUnread, matchesFilter, needsReading, unreadItems, viewTarget } from "../model/items";
import { initialWorkState, workReducer } from "../state/workState";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
afterEach(() => { vi.restoreAllMocks(); });

const noop = () => {};

function item(over: Partial<Item> & Pick<Item, "item_id">): Item {
  return {
    collection: "用例", title: "买家申请退款", revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
    fields: { 名称: "买家申请退款", 功能: "买家发起退款", 步骤: ["提交申请"] }, sources: [], reviews: [], confirmations: [], confirmation_stale: false,
    ...over,
  };
}

function task(items: Item[]): Task {
  return {
    task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "用例", prefix: "UC", fields: [
        { name: "名称", type: "文本", required: true, values: null },
        { name: "功能", type: "文本", required: false, values: null },
        { name: "步骤", type: "文本列表", required: true, values: null }] },
      { name: "问题", prefix: "TBD", fields: [
        { name: "事项", type: "文本", required: true, values: null },
        { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] }] }] },
    completion: null, items, latest_revision: 4,
  };
}

/** 修订 1 执行者新增 UC-001、UC-002 与 TBD-001；修订 2 用户改了 UC-002 的名称；修订 4 执行者改了 UC-001 的步骤与 TBD-001。 */
const LOG: RevisionLogEntry[] = [
  { revision_no: 4, at: "2026-09-22T21:40:00+08:00", by: "executor", session_id: "s", work_id: "w-u2", op_id: null, undo_of_revision: null,
    trigger: { kind: "typed", text: "寒暑假借期统一为 60 天。", message_id: "u2" },
    operations: [
      { op: "update", item_id: "UC-001", collection: "用例", title: "买家申请退款", revision_before: 1, revision_after: 4, fields_changed: ["步骤"] },
      { op: "update", item_id: "TBD-001", collection: "问题", title: "退款时限", revision_before: 1, revision_after: 4, fields_changed: ["状态"] }] },
  { revision_no: 2, at: "2026-09-22T21:12:00+08:00", by: "user", session_id: "s", work_id: null, op_id: "ui-op-1", undo_of_revision: null,
    trigger: { kind: "user_action", action: "edit_fields", text: "你改了 UC-002 的「名称」" },
    operations: [{ op: "update", item_id: "UC-002", collection: "用例", title: "卖家处理退款", revision_before: 1, revision_after: 2, fields_changed: ["名称"] }] },
  { revision_no: 1, at: "2026-09-22T21:10:00+08:00", by: "executor", session_id: "s", work_id: "w-u1", op_id: null, undo_of_revision: null,
    trigger: { kind: "typed", text: "整理一下这份材料", message_id: "u1" },
    operations: [
      { op: "add", item_id: "UC-001", collection: "用例", title: "买家申请退款", revision_before: null, revision_after: 1, fields_changed: [] },
      { op: "add", item_id: "UC-002", collection: "用例", title: "卖家处理退款", revision_before: null, revision_after: 1, fields_changed: [] },
      { op: "add", item_id: "TBD-001", collection: "问题", title: "退款时限", revision_before: null, revision_after: 1, fields_changed: [] }] },
];

const UC1 = item({ item_id: "UC-001", revision_no: 4, revisions: [1, 4], fields: { 名称: "买家申请退款", 功能: "买家发起退款", 步骤: ["提交申请", "系统登记"] } });
const UC2 = item({ item_id: "UC-002", title: "卖家处理退款", revision_no: 2, revision_by: "user", revisions: [1, 2], fields: { 名称: "卖家处理退款", 功能: "卖家审核", 步骤: ["审核"] } });
const TBD = item({ item_id: "TBD-001", collection: "问题", title: "退款时限", revision_no: 4, revisions: [1, 4], fields: { 事项: "退款时限", 状态: "未解决" } });

function panel(props: Partial<Parameters<typeof ItemsPanel>[0]> = {}) {
  const t = task([UC1, UC2, TBD]);
  const submit = vi.fn(async () => null);
  render(<Wrap><ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={noop}
    submit={submit} onGenerateDoc={noop} marks={marksByItem(t.items, LOG)} just={justChangedItems(t.items, LOG)} {...props} /></Wrap>);
  return submit;
}

describe("字段修订标识：以上次确认的修订为基准", () => {
  it("没确认过的条目以新增的修订为基准；助手之后改过的字段算，用户自己改的不算", () => {
    expect(markedFields(UC1, LOG)).toEqual(["步骤"]);
    expect(markedFields(UC2, LOG)).toEqual([]); // 用户在界面上改的字段不标
    expect(marksByItem([UC1, UC2, TBD], LOG)).toEqual({ "UC-001": ["步骤"], "TBD-001": ["状态"] });
  });

  it("确认了当前修订，标识消失；撤回确认不让它回来", () => {
    const confirmed = { ...UC1, confirmations: [{ revision_no: 4, accepted: true }] };
    expect(markedFields(confirmed, LOG)).toEqual([]);
    const withdrawn = { ...UC1, confirmations: [{ revision_no: 4, accepted: true }, { revision_no: 4, accepted: false }] };
    expect(markedFields(withdrawn, LOG)).toEqual([]);
    const confirmedEarlier = { ...UC1, confirmations: [{ revision_no: 1, accepted: true }] };
    expect(markedFields(confirmedEarlier, LOG)).toEqual(["步骤"]); // 确认的是修订 1，修订 4 的改动照样标
  });

  it("运行结束：被改条目带「修订 N · 刚改」，详情里改过的字段加框，顶部说明与哪次修订比", async () => {
    vi.spyOn(api, "itemRevisions").mockResolvedValue([
      { revision_no: 1, by: "executor", at: "", fields: { 名称: "买家申请退款", 功能: "买家发起退款", 步骤: ["提交申请"] }, sources: [], reviews: [], confirmations: [] },
      { revision_no: 4, by: "executor", at: "", fields: UC1.fields, sources: [], reviews: [], confirmations: [] },
    ]);
    panel();
    expect(screen.getByTestId("just-UC-001")).toHaveTextContent("修订 4 · 刚改");
    expect(screen.queryByTestId("just-UC-002")).toBeNull();
    cleanup();
    const t = task([UC1, UC2, TBD]);
    render(<Wrap><ItemDetail task={t} item={UC1} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} marked={["步骤"]} /></Wrap>);
    expect(screen.getByTestId("marked-步骤")).toHaveClass("sw-revmark");
    expect(document.querySelectorAll(".sw-revmark")).toHaveLength(1);
    expect(screen.getByTestId("mark-banner")).toHaveTextContent("这个条目还没有确认过；与它新增时的修订 1 相比，改了这几处");
    // 划掉与加线：和修订 1 比，「系统登记」是新加的
    await waitFor(() => expect(screen.getByTestId("marked-步骤").querySelector(".diff-new")?.textContent).toBe("系统登记"));
    // 没有「确认」按钮：打开就记为已读（由页面发 mark_viewed），这里还没收到库事件，状态是未读。
    expect(screen.queryByTestId("detail-confirm")).toBeNull();
    expect(screen.getByTestId("read-UC-001")).toHaveTextContent("未读");
  });

  it("看过之后（当前修订有接受的标记）再打开，边框与「刚改」都不再出现，状态是「已读 · 修订 N」", () => {
    const confirmed = { ...UC1, confirmations: [{ revision_no: 4, accepted: true }] };
    const t = task([confirmed, UC2, TBD]);
    render(<Wrap><ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected="UC-001" onSelect={noop}
      submit={vi.fn(async () => null)} onGenerateDoc={noop} marks={marksByItem(t.items, LOG)} just={justChangedItems(t.items, LOG)} /></Wrap>);
    expect(document.querySelectorAll(".sw-revmark")).toHaveLength(0);
    expect(screen.queryByTestId("just-UC-001")).toBeNull();
    expect(screen.queryByTestId("mark-banner")).toBeNull();
    expect(screen.queryByTestId("detail-unconfirm")).toBeNull();
    expect(screen.getByTestId("read-UC-001")).toHaveTextContent("已读 · 修订 4");
  });
});

describe("「刚改」只标执行者最近一次运行改过的条目", () => {
  it("最近一次运行改过的算；用户改的、新增的、更早运行改的不算", () => {
    expect([...justChangedItems([UC1, UC2, TBD], LOG)].sort()).toEqual(["TBD-001", "UC-001"]);
    // 再来一次运行，只改了 UC-002：上一次运行的 UC-001、TBD-001 不再带「刚改」，边框照样累计
    const next: RevisionLogEntry = { revision_no: 6, at: "", by: "executor", session_id: "s", work_id: "w-u3", op_id: null, undo_of_revision: null,
      trigger: { kind: "typed", text: "再改一处", message_id: "u3" },
      operations: [{ op: "update", item_id: "UC-002", collection: "用例", title: "卖家处理退款", revision_before: 2, revision_after: 6, fields_changed: ["功能"] }] };
    const uc2 = { ...UC2, revision_no: 6, revisions: [1, 2, 6] };
    expect([...justChangedItems([UC1, uc2, TBD], [next, ...LOG])]).toEqual(["UC-002"]);
    expect(markedFields(UC1, [next, ...LOG])).toEqual(["步骤"]);
  });

  it("确认了当前修订就不再带「刚改」，撤回确认也不回来；之后又被用户改过的也不带", () => {
    const confirmed = { ...UC1, confirmations: [{ revision_no: 4, accepted: true }] };
    expect(justChangedItems([confirmed], LOG).has("UC-001")).toBe(false);
    const withdrawn = { ...UC1, confirmations: [{ revision_no: 4, accepted: true }, { revision_no: 4, accepted: false }] };
    expect(justChangedItems([withdrawn], LOG).has("UC-001")).toBe(false); // 撤回确认不让它回来
    const userAfter = { ...UC1, revision_no: 7, revisions: [1, 4, 7] };
    expect(justChangedItems([userAfter], LOG).has("UC-001")).toBe(false);
  });
});

describe("单一写入者：执行者工作中", () => {
  it("条目区顶部有横幅；改字段、删除、先不管都灰化并在悬停说明里写明原因；「让助手来改这一条」「回答这个问题」照常可用", () => {
    const t = task([UC1, UC2, TBD]);
    render(<Wrap><ItemDetail task={t} item={UC1} def={t.definition.collections[0]} readOnly={false} writesOff pending={false}
      submit={vi.fn(async () => null)} onAskAssistant={noop} /></Wrap>);
    expect(screen.getByTestId("edit-item")).toBeDisabled();
    expect(screen.getByTestId("edit-item")).toHaveAttribute("title", "助手正在工作，结束后你可以继续修改");
    expect(screen.getByTestId("delete-item")).toBeDisabled();
    expect(screen.getByTestId("delete-item")).toHaveAttribute("title", "助手正在工作，结束后你可以继续修改");
    expect(screen.queryByTestId("detail-confirm")).toBeNull();
    expect(screen.getByTestId("busy-why")).toHaveTextContent("助手正在工作，结束后你可以继续修改");
    expect(screen.getByTestId("ask-assistant")).toBeEnabled();
    cleanup();
    panel({ writesOff: true });
    expect(screen.getByTestId("busy-banner")).toHaveTextContent("助手正在工作，结束后你可以继续修改");
    expect(within(screen.getByTestId("item-UC-001")).getByRole("checkbox")).toBeDisabled();
    cleanup();
    panel({ writesOff: true, selected: null });
    fireEvent.click(screen.getByText("问题"));
    expect(screen.getByTestId("answer-TBD-001")).toBeEnabled();
    expect(screen.getByTestId("keep-TBD-001")).toBeDisabled();
    expect(screen.getByTestId("keep-TBD-001")).toHaveAttribute("title", "助手正在工作，结束后你可以继续修改");
  });

  it("另外三种灰化原因写在悬停说明里：正在保存、看的是旧修订、任务已结束", async () => {
    vi.spyOn(api, "itemRevisions").mockResolvedValue([
      { revision_no: 1, by: "executor", at: "", fields: { 名称: "买家申请退款", 步骤: ["提交申请"] }, sources: [], reviews: [], confirmations: [] },
      { revision_no: 4, by: "executor", at: "", fields: UC1.fields, sources: [], reviews: [], confirmations: [] },
    ]);
    const t = task([UC1, UC2, TBD]);
    const { rerender } = render(<Wrap><ItemDetail task={t} item={UC1} def={t.definition.collections[0]} readOnly={false} pending submit={vi.fn(async () => null)} /></Wrap>);
    expect(screen.getByTestId("edit-item")).toHaveAttribute("title", "正在保存上一次修改，存好之后再操作。");
    rerender(<Wrap><ItemDetail task={t} item={UC1} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} /></Wrap>);
    fireEvent.change(await screen.findByTestId("revision-select"), { target: { value: "1" } });
    expect(screen.getByTestId("edit-item")).toBeDisabled();
    expect(screen.getByTestId("edit-item")).toHaveAttribute("title", "你在看旧修订，回到最新才能改。");
    cleanup();
    const ended = { ...t, status: "已完成" };
    render(<Wrap><ItemDetail task={ended} item={UC1} def={t.definition.collections[0]} readOnly pending={false} submit={vi.fn(async () => null)} /></Wrap>);
    expect(screen.getByTestId("delete-item")).toHaveAttribute("title", "任务已结束，不能再改。");
  });

  it("修订列表没读到时不当作只有一次修订：下拉框上提示再打开一次试试", async () => {
    vi.spyOn(api, "itemRevisions").mockRejectedValue(new Error("网络断了"));
    const t = task([UC1, UC2, TBD]);
    render(<Wrap><ItemDetail task={t} item={UC1} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} /></Wrap>);
    expect(await screen.findByTestId("revisions-missed")).toHaveTextContent("修订列表没读到，再打开一次试试");
    expect(screen.getByTestId("edit-item")).toBeEnabled();
  });

  it("问题条目的详情没有「修改」，底部只留「先不管，保留」与「删除」", () => {
    const t = task([UC1, UC2, TBD]);
    render(<Wrap><ItemDetail task={t} item={TBD} def={t.definition.collections[1]} readOnly={false} pending={false} submit={vi.fn(async () => null)} /></Wrap>);
    expect(screen.queryByTestId("edit-item")).toBeNull();
    expect(screen.getByText("先不管，保留")).toBeEnabled();
    expect(screen.getByTestId("delete-item")).toBeEnabled();
  });

  it("对话严格轮替：发送键灰化，输入框照常能打字；界面操作说明里的撤销也不能点", () => {
    const onSend = vi.fn();
    const onUndo = vi.fn();
    render(<Wrap><Conversation messages={[{ type: "ui_action_noted", message_id: "n1", at: "", text: "界面操作（不是用户打的字）：用户改了 UC-002 的「名称」，产生修订 2，UC-002 现在是修订 2。", event_seq: 3, undoable: true, revision_no: 2 }]}
      currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null} working
      handlers={{ onAction: noop, onMessage: noop }} onSend={onSend} onUndo={onUndo} onOpenItem={noop} onAttach={noop}
      hasEarlier={false} onLoadEarlier={noop} revisionOf={(n) => n.revision_no ?? null} attachments={[]} /></Wrap>);
    const box = screen.getByTestId("chat-input");
    expect(box).toBeEnabled();
    fireEvent.change(box, { target: { value: "罚款能不能用微信缴纳？" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("send")).toHaveClass("off");
    expect(box).toHaveValue("罚款能不能用微信缴纳？");
    expect(screen.getByTestId("undo-link")).toHaveTextContent("撤销修订 2");
    fireEvent.click(screen.getByTestId("undo-link"));
    expect(onUndo).not.toHaveBeenCalled();
  });
});

describe("单一写入者：空闲但有未保存的条目编辑", () => {
  it("编辑框内容与打开时不同才算：详情据此上报；只打开没改不算", () => {
    const onDirty = vi.fn();
    const t = task([UC1, UC2, TBD]);
    render(<Wrap><ItemDetail task={t} item={UC1} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} onDirty={onDirty} /></Wrap>);
    fireEvent.click(screen.getByTestId("edit-item"));
    expect(onDirty).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "买家申请部分退款" } });
    expect(onDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId("cancel-edit"));
    expect(onDirty).toHaveBeenLastCalledWith(false);
  });

  it("编辑中不能发送：发送键灰化、输入框上方提示；卡片上的确认、不对、选项与卡片内发送键都灰化并写明原因", () => {
    const onSend = vi.fn();
    const reply: AssistantReply = { type: "assistant_reply", message_id: "r1", at: "", work_id: "w-u1", via_reply_tool: true, informs: [],
      act: { kind: "confirm", text: "请确认。", items: [{ item_id: "UC-001", revision_no: 4 }] }, text: "改好了。" };
    render(<Wrap><Conversation messages={[reply]} currentWork={null} outgoing={[]} task={task([UC1])} disabled={false} disabledReason={null} hold
      handlers={{ onAction: noop, onMessage: noop }} onSend={onSend} onUndo={noop} onOpenItem={noop} onAttach={noop}
      hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);
    expect(screen.getByTestId("busy-note")).toHaveTextContent("先保存或取消正在编辑的条目");
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "一句话" } });
    fireEvent.keyDown(screen.getByTestId("chat-input"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("card-confirm")).toBeDisabled();
    expect(screen.getByTestId("card-wrong")).toBeDisabled();
    expect(screen.getByTestId("card-send")).toHaveClass("off");
    expect(screen.getByTestId("card-hold-hint")).toHaveTextContent("先保存或取消正在编辑的条目");
    expect(screen.getByTestId("card-input")).toBeEnabled();
  });

  it("请确认卡片的条目行写已读与否：看过更早的修订仍是已读，写明看过哪次；从没看过写未读", () => {
    const card = (it: Item) => render(<Wrap><ReplyCard act={{ kind: "confirm", text: "请确认。", items: [{ item_id: "UC-001", revision_no: 4 }] }} replyMessageId="r1"
      task={task([it])} handlers={{ onAction: noop, onMessage: noop }} /></Wrap>);
    card({ ...UC1, confirmations: [{ revision_no: 1, accepted: true }] });
    expect(screen.getByTestId("card-revision-UC-001")).toHaveTextContent("修订 4（已读 · 你看过修订 1，之后又改过）");
    cleanup();
    card({ ...UC1, confirmations: [{ revision_no: 4, accepted: true }] });
    expect(screen.getByTestId("card-revision-UC-001")).toHaveTextContent("修订 4（已读）");
    cleanup();
    card(UC1);
    expect(screen.getByTestId("card-revision-UC-001")).toHaveTextContent("修订 4（未读）");
  });
});

describe("回复底部的修订标签", () => {
  it("按工作编号取这次运行产生的修订；点标签交出这几次修订", () => {
    const reply: AssistantReply = { type: "assistant_reply", message_id: "r2", at: "", work_id: "w-u2", via_reply_tool: true, informs: [], act: null, text: "改好了。" };
    expect(revisionsOfReply(reply, LOG)).toEqual([4]);
    expect(revisionsOfReply({ ...reply, work_id: "w-none" }, LOG)).toEqual([]);
    const onTag = vi.fn();
    render(<Wrap><Conversation messages={[reply]} currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
      handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
      hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]}
      revisionsOfReply={(r) => revisionsOfReply(r, LOG)} onRevisionTag={onTag} /></Wrap>);
    fireEvent.click(screen.getByTestId("revision-tag"));
    expect(screen.getByTestId("revision-tag")).toHaveTextContent("产生了修订 4");
    expect(onTag).toHaveBeenCalledWith([4]);
    expect(document.querySelector(".chg")).toBeNull();
  });
});

describe("右侧栏「修订」页签", () => {
  function side(props: Partial<Parameters<typeof SidePanel>[0]> = {}) {
    const handlers = { onSelectRevision: vi.fn(), onDiff: vi.fn(), onUndo: vi.fn(), onGenerate: vi.fn() };
    render(<Wrap><SidePanel side="rev" onSide={noop} onCollapse={noop} onExpand={noop} taskId="TASK-001" materials={[]} focusPath={null}
      items={[UC1, UC2, TBD]} locate={null} currentItem={null} disabled={false} onOpenItem={noop} onSend={noop}
      log={LOG} messages={[{ type: "user_message", message_id: "u1", at: "", text: "整理一下这份材料", origin: "typed", annotation: null, queued: false }]}
      selectedRevision={null} scrollNonce={0} writesOff={false} readOnly={false} {...handlers} {...props} /></Wrap>);
    return handlers;
  }

  it("每次修订一张卡片，最新在上：标题、谁改的、触发它的事、碰到的条目与改了哪些字段、查看差异、撤销与生成文档", () => {
    const h = side();
    const cards = screen.getAllByTestId(/^rev-\d+$/);
    expect(cards.map((c) => c.getAttribute("data-testid"))).toEqual(["rev-4", "rev-2", "rev-1"]);
    expect(cards[0]).toHaveTextContent("修订 4");
    expect(cards[0]).toHaveTextContent("助手");
    expect(cards[0]).toHaveTextContent("回应你说的话：寒暑假借期统一为 60 天。");
    expect(cards[0]).toHaveTextContent("修改UC-001买家申请退款改了 步骤查看差异");
    expect(cards[1]).toHaveTextContent("你在界面上改的");
    expect(cards[1]).toHaveTextContent("你改了 UC-002 的「名称」");
    expect(cards[2]).toHaveTextContent("回应你的第 1 句话：整理一下这份材料");
    fireEvent.click(cards[0]);
    expect(h.onSelectRevision).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByTestId("rev-4-look-UC-001"));
    expect(h.onDiff).toHaveBeenCalledWith("UC-001", 4);
    fireEvent.click(screen.getByTestId("rev-2-undo"));
    expect(h.onUndo).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByTestId("rev-1-doc"));
    expect(h.onGenerate).toHaveBeenCalledWith(1);
    expect(h.onSelectRevision).toHaveBeenCalledTimes(1); // 点卡片里的按钮与「查看差异」不算选中卡片
  });

  it("撤销这次修订按不可撤预判灰化：碰到的条目之后又改过或已删掉的修订灰化并说明原因，其余可点", () => {
    side();
    // 修订 1 新增的三个条目在修订 2、修订 4 又改过；修订 2、修订 4 碰到的条目之后没再改。
    expect(screen.getByTestId("rev-1-undo")).toBeDisabled();
    expect(screen.getByTestId("rev-1-undo")).toHaveAttribute("title", "这次修订碰到的条目之后又改过，不能撤销；要改请直接改条目");
    expect(screen.getByTestId("rev-2-undo")).toBeEnabled();
    expect(screen.getByTestId("rev-4-undo")).toBeEnabled();
    expect(undoBlocked(LOG[0], LOG, [UC1, UC2])).toBe(true);   // TBD-001 已经删掉了
    // 删除操作撤销时是恢复：条目之后没再出现过就可以撤销，已经恢复（又出现了）就不行。
    const del: RevisionLogEntry = { ...LOG[1], revision_no: 5, operations: [{ ...LOG[1].operations[0], op: "delete", revision_before: 2, revision_after: null }] };
    expect(undoBlocked(del, [del, ...LOG], [UC1, TBD])).toBe(false);
    expect(undoBlocked(del, [del, ...LOG], [UC1, UC2, TBD])).toBe(true);
  });

  it("执行者工作中照常可看，撤销灰化", () => {
    side({ writesOff: true });
    expect(screen.getByTestId("rev-4-undo")).toBeDisabled();
    expect(screen.getByTestId("rev-4-doc")).toBeEnabled();
  });

  it("选中一次修订：条目区高亮它碰到的条目，集合页签上标出个数，筛选行加一个可点掉的提示", () => {
    const onClear = vi.fn();
    panel({ hit: { revision: 4, items: ["UC-001", "TBD-001"] }, onClearHit: onClear });
    expect(screen.getByTestId("item-UC-001")).toHaveClass("sw-hit");
    expect(screen.getByTestId("item-UC-002")).not.toHaveClass("sw-hit");
    expect(screen.getByTestId("hit-count-用例")).toHaveTextContent("1");
    expect(screen.getByTestId("hit-count-问题")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("hit-note"));
    expect(screen.getByTestId("hit-note")).toHaveTextContent("修订 4 碰到的条目 ✕");
    expect(onClear).toHaveBeenCalled();
  });

  it("触发它的事：点卡片发出的、界面操作之后发给助手的、找不到的，各有说法", () => {
    const base = LOG[0];
    expect(triggerText({ ...base, trigger: { kind: "card_choice", text: "我选：七天" } }, [])).toBe("回应你点的卡片：我选：七天");
    expect(triggerText({ ...base, trigger: { kind: "ui_request", text: "我已经在界面上确认了：UC-001。请接着往下做。" } }, []))
      .toBe("回应你在界面上的操作：我已经在界面上确认了：UC-001。请接着往下做。");
    expect(triggerText({ ...base, trigger: { kind: "none", text: "" } }, [])).toBe("助手自己开始的工作");
  });

  it("因为你说：修订对得上触发它的那项用户行为时，卡片副标题写功能的中文名与摘要", () => {
    const intent = { act_id: "r4-2", function: "correct", function_name: "纠正", summary: "UC-003 的参与者改为借还台管理员" };
    side({ log: [{ ...LOG[0], intent }, ...LOG.slice(1)] });
    const card = screen.getByTestId("rev-4");
    expect(card).toHaveTextContent("因为你说：纠正：UC-003 的参与者改为借还台管理员");
    expect(card).not.toHaveTextContent("回应你说的话");
  });

  it("对不上时（用户直接修改、旧任务没有理解记录）沿用原来的写法", () => {
    side({ log: [{ ...LOG[0], intent: null }, { ...LOG[1], intent: null }, LOG[2]] });
    expect(screen.getByTestId("rev-4")).toHaveTextContent("回应你说的话：寒暑假借期统一为 60 天。");
    expect(screen.getByTestId("rev-2")).toHaveTextContent("你改了 UC-002 的「名称」");
    expect(screen.getByTestId("rev-1")).toHaveTextContent("回应你的第 1 句话：整理一下这份材料");
  });
});

describe("修订页签「查看差异」打开条目详情", () => {
  const revs = [
    { revision_no: 1, by: "executor" as const, at: "", fields: { 名称: "卖家处理退款", 功能: "卖家查看", 步骤: ["审核"] }, sources: [], reviews: [], confirmations: [] },
    { revision_no: 2, by: "user" as const, at: "", fields: UC2.fields, sources: [], reviews: [], confirmations: [] },
  ];
  const detail = (view: { itemId: string; revision: number; nonce: number }) => {
    const t = task([UC1, UC2, TBD]);
    return <Wrap><ItemDetail task={t} item={UC2} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} marked={[]} view={view} /></Wrap>;
  };

  it("看的是条目当前所在的修订、又没有修订标识（用户自己改的）时，直接和上一次改动比对，画出差别", async () => {
    vi.spyOn(api, "itemRevisions").mockResolvedValue(revs);
    render(detail({ itemId: "UC-002", revision: 2, nonce: 1 }));
    expect(screen.getByTestId("compare-banner")).toHaveTextContent("正在和修订 1 比对");
    await waitFor(() => expect(document.querySelector(".diff-old")?.textContent).toBe("卖家查看"));
  });

  it("条目已经开着、比对被收起时，再点一次「查看差异」重新打开比对", () => {
    vi.spyOn(api, "itemRevisions").mockResolvedValue(revs);
    const { rerender } = render(detail({ itemId: "UC-002", revision: 2, nonce: 1 }));
    fireEvent.click(within(screen.getByTestId("compare-banner")).getByText("收起比对"));
    expect(screen.queryByTestId("compare-banner")).toBeNull();
    rerender(detail({ itemId: "UC-002", revision: 2, nonce: 2 }));
    expect(screen.getByTestId("compare-banner")).toHaveTextContent("正在和修订 1 比对");
  });

  it("看的是更早的修订时停在那次修订，横幅写明不是最新", () => {
    vi.spyOn(api, "itemRevisions").mockResolvedValue(revs);
    const t = task([UC1, UC2, TBD]);
    render(<Wrap><ItemDetail task={t} item={UC1} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} marked={["步骤"]}
      view={{ itemId: "UC-001", revision: 1, nonce: 1 }} /></Wrap>);
    expect(screen.getByTestId("old-banner")).toHaveTextContent("你在看修订 1 时这个条目的样子（不是最新）");
  });
});

describe("已读即确认", () => {
  const withCompletion = (items: Item[], unmet: string[]) => {
    const t = task(items);
    const names = ["至少一个条目", "每个条目评审通过", "每个条目用户确认"];
    return { ...t, completion: { all_met: unmet.length === 0, conditions: names.map((name) => ({
      collection: "用例", name, met: !unmet.includes(name), state: unmet.includes(name) ? "unmet" as const : "met" as const, done: 0, total: 2, missing: [], note: "" })) } };
  };
  const read = (item: Item) => ({ ...item, confirmations: [{ revision_no: item.revision_no, accepted: true, basis: "viewed" }] });

  it("未读：从没有接受的标记（条目级、单向）；只算完成条件要求用户确认的集合，问题条目不算", () => {
    const t = withCompletion([UC1, read(UC2), TBD], ["每个条目用户确认"]);
    expect([isUnread(UC1), isUnread(read(UC2))]).toEqual([true, false]);
    const seenEarlier = { ...UC1, confirmations: [{ revision_no: 1, accepted: true }] };
    expect(isUnread(seenEarlier)).toBe(false); // 看过修订 1，之后助手改到修订 4，仍是已读
    expect(matchesFilter(seenEarlier, "unread")).toBe(false);
    expect(matchesFilter(seenEarlier, "read")).toBe(true);
    expect(unreadItems(withCompletion([seenEarlier, read(UC2)], ["每个条目用户确认"]))).toEqual([]);
    expect(viewTarget(t, "UC-001")).toEqual({ item_id: "UC-001", base_revision: 4 });
    expect(viewTarget(withCompletion([seenEarlier], []), "UC-001")).toEqual({ item_id: "UC-001", base_revision: 4 }); // 再打开照样记下看过修订 4
    expect(needsReading(t, "用例")).toBe(true);
    expect(needsReading(t, "问题")).toBe(false);
    expect(unreadItems(t).map((i) => i.item_id)).toEqual(["UC-001"]);
  });

  it("打开详情要不要记为已读：进行中、要求看过的集合、现在未读才标，标的是条目当前所在的修订", () => {
    const t = withCompletion([UC1, read(UC2), TBD], ["每个条目用户确认"]);
    expect(viewTarget(t, "UC-001")).toEqual({ item_id: "UC-001", base_revision: 4 });
    expect(viewTarget(t, "UC-002")).toBeNull(); // 已读，幂等由后端再保一次
    expect(viewTarget(t, "TBD-001")).toBeNull(); // 问题条目靠状态收口，不要求看过
    expect(viewTarget({ ...t, status: "已完成" }, "UC-001")).toBeNull();
    expect(viewTarget(t, null)).toBeNull();
  });

  it("条目区：未读的行加粗；顶部「还有 N 条未读 · 筛出来看」，点它筛出未读；勾选几条标为已读走 mark_viewed", () => {
    const t = withCompletion([UC1, read(UC2), TBD], ["每个条目用户确认"]);
    const submit = vi.fn(async () => null);
    render(<Wrap><ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={noop}
      submit={submit} onGenerateDoc={noop} /></Wrap>);
    expect(screen.getByTestId("item-UC-001")).toHaveClass("unread");
    expect(screen.getByTestId("item-UC-002")).not.toHaveClass("unread");
    expect(screen.getByTestId("read-UC-001")).toHaveTextContent("未读");
    expect(screen.getByTestId("read-UC-002")).toHaveTextContent("已读 · 修订 2");
    expect(screen.getByTestId("unread-bar")).toHaveTextContent("还有 1 条未读");
    expect(screen.getByTestId("progress")).toHaveTextContent("3 个条目 · 待评审 2 · 评审不通过 0 · 1 条未读");
    fireEvent.click(within(screen.getByTestId("unread-bar")).getByText("筛出来看"));
    expect(screen.queryByTestId("item-UC-002")).toBeNull();
    expect(screen.queryByTestId("unread-bar")).toBeNull();
    fireEvent.click(within(screen.getByTestId("item-UC-001")).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("bulk-viewed"));
    expect(submit).toHaveBeenCalledWith({ kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 4 }], notify_executor: false }, expect.any(String));
  });

  it("旧任务的问题集合还叫旧名：按「用户决定保留」这个取值照样认出来，汇总行计数、不要求看过、卡片带「先不管，保留」", () => {
    const OLD = "待定与范围外事项";
    const base = task([]);
    const oldTbd = { ...TBD, collection: OLD };
    const t: Task = { ...base, items: [UC1, oldTbd],
      definition: { collections: [base.definition.collections[0], { ...base.definition.collections[1], name: OLD }] },
      completion: { all_met: false, conditions: [
        { collection: "用例", name: "每个条目用户确认", met: false, state: "unmet", done: 0, total: 1, missing: ["UC-001"], note: "" },
        { collection: OLD, name: "没有状态为未解决的条目", met: false, state: "unmet", done: 0, total: 1, missing: ["TBD-001"], note: "" }] } };
    expect(needsReading(t, OLD)).toBe(false);
    expect(viewTarget(t, "TBD-001")).toBeNull();
    expect(unreadItems(t).map((i) => i.item_id)).toEqual(["UC-001"]);
    render(<Wrap><ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={noop}
      submit={vi.fn(async () => null)} onGenerateDoc={noop} /></Wrap>);
    expect(screen.getByTestId("progress")).toHaveTextContent("2 个条目 · 待评审 0 · 评审不通过 0 · 1 条未读；问题 1 条未解决");
    fireEvent.click(screen.getByText(OLD));
    expect(screen.getByTestId("item-TBD-001")).toBeInTheDocument();
    expect(screen.getByTestId("keep-TBD-001")).toHaveTextContent("先不管，保留");
  });

  it("详情里的边框在打开那一刻冻结：已读标记到了、边框的依据没了，这次打开仍看得到；改到新修订才重新取", () => {
    vi.spyOn(api, "itemRevisions").mockResolvedValue([]);
    const t = task([UC1, UC2, TBD]);
    const detail = (item: Item, marked: string[]) =>
      <Wrap><ItemDetail task={t} item={item} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} marked={marked} /></Wrap>;
    const { rerender } = render(detail(UC1, ["步骤"]));
    expect(document.querySelectorAll(".sw-revmark")).toHaveLength(1);
    rerender(detail(read(UC1), []));
    expect(document.querySelectorAll(".sw-revmark")).toHaveLength(1);
    expect(screen.getByTestId("mark-banner")).toHaveTextContent("打开就算你看过了，下次再打开框就不再出现");
    expect(screen.queryByTestId("detail-unconfirm")).toBeNull();
    rerender(detail({ ...UC1, revision_no: 5, revisions: [1, 4, 5] }, []));
    expect(document.querySelectorAll(".sw-revmark")).toHaveLength(0);
  });

  it("详情开着时条目被改到新修订：修订日志晚一步到，边框也跟着画出来；变成已读之后停住", () => {
    vi.spyOn(api, "itemRevisions").mockResolvedValue([]);
    const t = task([UC1, UC2, TBD]);
    const detail = (item: Item, marked: string[]) =>
      <Wrap><ItemDetail task={t} item={item} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} marked={marked} /></Wrap>;
    const { rerender } = render(detail(UC1, []));
    expect(document.querySelectorAll(".sw-revmark")).toHaveLength(0);
    rerender(detail(UC1, ["步骤"]));
    expect(document.querySelectorAll(".sw-revmark")).toHaveLength(1);
    rerender(detail(read(UC1), []));
    expect(document.querySelectorAll(".sw-revmark")).toHaveLength(1);
  });

  it("确认记录写明依据：打开看过、改出来的、撤回", () => {
    vi.spyOn(api, "itemRevisions").mockResolvedValue([]);
    const t = task([UC1]);
    const item = { ...UC1, confirmations: [
      { revision_no: 4, accepted: true, basis: "viewed", at: "" }, { revision_no: 4, accepted: false, basis: "ui_click", at: "" },
      { revision_no: 4, accepted: true, basis: "ui_edit", at: "" }] };
    render(<Wrap><ItemDetail task={t} item={item} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} /></Wrap>);
    const text = screen.getByTestId("confirmations").textContent ?? "";
    expect(text).toContain("你打开看过（已读）");
    expect(text).toContain("你撤回了确认");
    expect(text).not.toContain("回到未读");
    expect(text).toContain("你在界面上改了它，改出来的内容算作你已确认");
  });

  it("完成前只剩未读挡着时，还没结掉的卡片下提示「还有 N 条未读」，点它请条目区筛出未读；别的条件还差时不提示", () => {
    const onShowUnread = vi.fn();
    const act = { kind: "choose" as const, text: "现在完成吗？", options: [{ key: "a", text: "现在完成" }, { key: "b", text: "还要再改" }] };
    render(<Wrap><ReplyCard act={act} replyMessageId="r1" task={withCompletion([UC1, read(UC2)], ["每个条目评审通过", "每个条目用户确认"])}
      handlers={{ onAction: noop, onMessage: noop, onShowUnread }} /></Wrap>);
    expect(screen.getByTestId("card-unread")).toHaveTextContent("还有 1 条未读");
    fireEvent.click(screen.getByTestId("card-show-unread"));
    expect(onShowUnread).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Wrap><ReplyCard act={act} replyMessageId="r1" task={withCompletion([UC1, read(UC2)], ["至少一个条目", "每个条目用户确认"])}
      handlers={{ onAction: noop, onMessage: noop, onShowUnread }} /></Wrap>);
    expect(screen.queryByTestId("card-unread")).toBeNull();
  });
});

describe("生成文档：选一个修订加条目勾选", () => {
  it("缺省最新修订、全选时不列条目；换到修订 1 按那时的条目列；去掉一个条目后只列勾着的", async () => {
    const preview = vi.spyOn(api, "previewDocument").mockResolvedValue({ text: "预览" });
    render(<Wrap><DocumentModal task={task([UC1, UC2, TBD])} log={LOG} open onClose={noop} /></Wrap>);
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith("TASK-001", { revision_no: 4 }));
    expect(aliveAt(LOG, 1).size).toBe(3);
    fireEvent.click(screen.getByTestId("doc-item-UC-002"));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith("TASK-001", { revision_no: 4, items: ["UC-001", "TBD-001"] }));
    cleanup();
    render(<Wrap><DocumentModal task={task([UC1, UC2, TBD])} log={LOG} open revision={1} onClose={noop} /></Wrap>);
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith("TASK-001", { revision_no: 1 }));
  });
});

describe("过程摘要：保存修订被拒附上原因", () => {
  it("原因多于一条的那一行可以点开逐条看全部原因，再点收起；只有一条原因的行不可点", () => {
    const summary = { type: "work_summary", message_id: "summary-u1", work_id: "w-u1", at: "", seconds: 12, step_count: 3, stages: [
      { text: "保存修订被拒，助手正在照原因改：操作 1 的摘录找不到。（还有 1 条）", count: 1, reasons: ["操作 1 的摘录找不到。", "操作 2 的修订号过期了。"] },
      { text: "保存修订被拒，助手正在照原因改：操作 1 缺来源。", count: 1, reasons: ["操作 1 缺来源。"] },
      { text: "写好并保存了修订 1：新增功能用例 1 个（UC-001）", count: 1 }] } as unknown as WorkSummary;
    render(<Wrap><WorkSummaryLine summary={summary} /></Wrap>);
    fireEvent.click(screen.getByTestId("work-summary"));
    const stages = screen.getByTestId("work-summary-stages");
    expect(stages).toHaveTextContent("保存修订被拒，助手正在照原因改：操作 1 的摘录找不到。（还有 1 条）");
    expect(screen.queryByTestId("stage-1")).toBeNull();
    expect(screen.queryByTestId("stage-0-reasons")).toBeNull();
    fireEvent.click(screen.getByTestId("stage-0"));
    const list = screen.getByTestId("stage-0-reasons");
    expect(list).toHaveTextContent("1. 操作 1 的摘录找不到。");
    expect(list).toHaveTextContent("2. 操作 2 的修订号过期了。");
    fireEvent.click(screen.getByTestId("stage-0"));
    expect(screen.queryByTestId("stage-0-reasons")).toBeNull();
  });
});

describe("过程摘要：理解为", () => {
  it("摘要不展开也显示「理解为」一行，用现有的过程行样式；工作结束时理解那一步单独取出，不算进做了的步骤", () => {
    const summary = { type: "work_summary", message_id: "summary-u1", work_id: "w-u1", at: "", seconds: 8, step_count: 2,
      understanding: "理解为：同意（affirm）UC-001、UC-002 的当前修订；纠正（correct）UC-003 参与者改为借还台管理员；告知（inform）寒暑假借期先不管（把握中）",
      stages: [{ text: "写好并保存了修订 6：修改功能用例 1 个（UC-003）", count: 1 }, { text: "组织并发出了回复", count: 1 }] } as unknown as WorkSummary;
    render(<Wrap><WorkSummaryLine summary={summary} /></Wrap>);
    const line = screen.getByTestId("work-summary-understanding");
    expect(line).toHaveTextContent("理解为：同意（affirm）UC-001、UC-002 的当前修订；纠正（correct）UC-003 参与者改为借还台管理员；告知（inform）寒暑假借期先不管（把握中）");
    expect(line.querySelector(".pline .ptxt")).not.toBeNull();
    expect(screen.getByTestId("work-summary")).toHaveTextContent("助手做了 2 步");
    cleanup();
    render(<Wrap><WorkSummaryLine summary={{ ...summary, understanding: null } as WorkSummary} /></Wrap>);
    expect(screen.queryByTestId("work-summary-understanding")).toBeNull();

    const SESSION = "S";
    let state = workReducer(initialWorkState(SESSION), { type: "sse", event: "work_started", data: { session_id: SESSION, work_id: "w-u1", at: "", triggered_by: "u1" } } as never);
    for (const step of [
      { step_key: "w-u1-intent", text: "助手的理解里有对不上的地方，正在重写", in_progress: true },
      { step_key: "w-u1-0", text: "写好并保存了修订 6", in_progress: false },
      { step_key: "w-u1-intent", text: "理解为：请求（request）整理材料", in_progress: false },
    ]) state = workReducer(state, { type: "sse", event: "step", data: { session_id: SESSION, work_id: "w-u1", failed: false, ...step } } as never);
    expect(state.currentWork!.steps.map((s) => s.text)).toEqual(["理解为：请求（request）整理材料", "写好并保存了修订 6"]);
    state = workReducer(state, { type: "sse", event: "work_ended", data: { session_id: SESSION, work_id: "w-u1", at: "", seconds: 3, step_count: 1, outcome: "replied" } } as never);
    const ended = state.messages.find((m) => m.type === "work_summary") as WorkSummary;
    expect(ended.understanding).toBe("理解为：请求（request）整理材料");
    expect(ended.stages!.map((s) => s.text)).toEqual(["写好并保存了修订 6"]);
  });
});

describe("字号三档", () => {
  it("选大档：html 加 fs-l，选择存在浏览器本地，下次打开照用；选中档去掉类", () => {
    saveFontTier("l");
    expect(document.documentElement).toHaveClass("fs-l");
    expect(readFontTier()).toBe("l");
    saveFontTier("s");
    expect(document.documentElement).toHaveClass("fs-s");
    expect(document.documentElement).not.toHaveClass("fs-l");
    saveFontTier("m");
    expect(document.documentElement).not.toHaveClass("fs-s");
    expect(readFontTier()).toBe("m");
  });

  it("浏览器不让存时照样生效，读出来是中档", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("不让存"); });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("不让读"); });
    saveFontTier("l");
    expect(document.documentElement).toHaveClass("fs-l");
    expect(readFontTier()).toBe("m");
    set.mockRestore(); get.mockRestore();
    saveFontTier("m");
  });
});
