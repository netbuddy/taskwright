// 助手提议的另两种卡片：提议退回前面的阶段（「回到：某活动」「继续本步」），编写文档阶段请用户过目补写的页（「看过了，生成文档」「需要修改」）。
// 退回的那一项照进入卡片的做法替用户发一句带选项键的话；「继续本步」「需要修改」只发界面操作 continue_stage，各显示自己的文字；
// 「看过了，生成文档」不发话，交给页面做三件事（留通知、标已读、打开生成文档）。输入框上方「待决定」一行按提议的种类各有写法。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Act, ConversationMessage, StageProposal } from "../api/types";
import { Conversation, answeredByStaying, answeredStayKey, answeredText } from "../components/work/Conversation";
import { PendingProposal, actOnProposal, pendingParts } from "../components/work/PendingProposal";
import { BACK_CARD_TITLE, REVIEW_CARD_TITLE, ReplyCard, START_CARD_TITLE, proposalKindOfCard } from "../components/work/ReplyCard";
import {
  DOCUMENT_REVIEWED_KEY, DOCUMENT_REVISE_KEY, REVIEWED_HINT, REVISE_HINT, STAY_HINT, continueStageLine, forwardTarget, isActingKey,
  isBackOption, isForwardOption, isQuietKey, proposalCardKind, quietChoiceText, quietText,
} from "../model/stage";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const BACK: Act = { kind: "choose", text: "用户放进了一份新材料，前面几页的理解要重来。退回澄清吗？",
  options: [{ key: "goto:clarifying", text: "回到：澄清" }, { key: "stay", text: "先不退" }], items: [{ item_id: "OA-001", revision_no: 1 }] };
const REVIEW: Act = { kind: "choose", text: "补写了两章的导语，请过目。",
  options: [{ key: "document_reviewed", text: "看过了，生成文档" }, { key: "document_revise", text: "需要修改" }],
  items: [{ item_id: "OA-001", revision_no: 1 }, { item_id: "OA-002", revision_no: 1 }] };
function card(act: Act, over: Record<string, unknown> = {}, more: Record<string, unknown> = {}) {
  const handlers = { onAction: vi.fn(), onMessage: vi.fn(), ...more };
  render(<Wrap><ReplyCard act={act} replyMessageId="msg-1" task={overallTask()} handlers={handlers} {...over} /></Wrap>);
  return handlers;
}
const reply = (id: string, text: string, act: Act | null = null) =>
  ({ type: "assistant_reply", message_id: id, at: "", work_id: null, via_reply_tool: true, informs: [], act, text });
const said = (id: string, text: string) => ({ type: "user_message", message_id: id, at: "", text, origin: "typed", annotation: null, queued: false });
const note = (id: string, replyId: string, optionKey?: string) => ({ type: "ui_action_noted", message_id: id, at: "", event_seq: null, undoable: false, kind: "continue_stage",
  reply_message_id: replyId, stage: "clarifying", ...(optionKey ? { option_key: optionKey } : {}), text: "界面操作（不是用户打的字）：……" });
const show = (messages: unknown[]) => render(<Wrap><Conversation messages={messages as ConversationMessage[]} currentWork={null} outgoing={[]} task={overallTask()}
  disabled={false} disabledReason={null} handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
  hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);

describe("卡片的键与种类", () => {
  it("转移卡片的键三种：next_step 往前、goto:<活动标识符> 按字分往前往回、stay 不生效；早先按阶段的固定键照换算表照样认；一张卡片照进入、退回、请过目的先后认种类", () => {
    const next = { key: "next_step", text: "进入下一步：澄清" };
    const back = { key: "goto:reading", text: "回到：核读材料" };
    const jump = { key: "goto:writing", text: "转到：写条目" };
    expect([next, back, jump].map((one) => [isForwardOption(one), isBackOption(one), forwardTarget(one)]))
      .toEqual([[true, false, null], [false, true, null], [true, false, "writing"]]);
    // 早先的键：进入某段的往前、退回某段的往回，与卡片上写的字无关。
    expect([{ key: "enter_clarify", text: "回到澄清" }, { key: "back_to_clarify", text: "退回澄清" }, { key: "start_items", text: "开始写条目" }]
      .map((one) => [isForwardOption(one), isBackOption(one), forwardTarget(one)]))
      .toEqual([[true, false, "clarifying"], [false, true, null], [true, false, "writing"]]);
    expect([DOCUMENT_REVIEWED_KEY, DOCUMENT_REVISE_KEY]).toEqual(["document_reviewed", "document_revise"]);
    expect([proposalKindOfCard(BACK), proposalKindOfCard(REVIEW), proposalCardKind([next, { key: "stay", text: "继续本步" }]), proposalCardKind([back, { key: "stay" }]),
      proposalCardKind([{ key: "enter_document" }, { key: "continue_review" }]), proposalCardKind([{ key: "a" }]), proposalCardKind(null)])
      .toEqual(["back", "review", "enter", "back", "enter", null, null]);
    expect(proposalKindOfCard({ kind: "ask", text: "？" })).toBeNull();
    expect(["next_step", "goto:reading", "stay", "back_to_clarify", "enter_document", "document_reviewed", "stay_in_stage", "document_revise", "continue_review", "stay_idle"]
      .map((key) => [isActingKey(key), isQuietKey(key)]))
      .toEqual([[true, false], [true, false], [false, true], [true, false], [true, false], [true, false], [false, true], [false, true], [false, true], [false, true]]);
    // 不生效的那一项一律写「继续本步」（早先的「留在本段」「继续本阶段」「先不开始」也是），请过目卡片上是「需要修改」。
    expect([quietText("stay"), quietText("stay_in_stage"), quietText("document_revise"), quietText("continue_review"), quietText("stay_idle"), quietChoiceText("document_reviewed"), quietChoiceText(undefined)])
      .toEqual(["继续本步", "继续本步", "需要修改", "继续本步", "继续本步", "看过了，生成文档", "继续本步"]);
  });

  it("任务空闲时提议开始核读材料的早先卡片：标题写「开始核读材料 · 请决定」，「先不开始」是不生效的那一项、写成「继续本步」", () => {
    const card = { kind: "choose", text: "你上传了一份材料。现在开始核读材料吗？", options: [{ key: "enter_reading", text: "开始核读材料" }, { key: "stay_idle", text: "先不开始" }] };
    show([{ type: "assistant_reply", message_id: "r1", at: "", work_id: null, via_reply_tool: true, informs: [], act: card, text: "现在开始核读材料吗？" }]);
    const shown = screen.getByTestId("act-choose");
    expect(shown.querySelector(".tt")).toHaveTextContent(START_CARD_TITLE);
    expect(START_CARD_TITLE).toBe("开始核读材料 · 请决定");
    expect([...shown.querySelectorAll("button")].map((b) => b.textContent)).toEqual(expect.arrayContaining(["开始核读材料", "继续本步"]));
    expect([proposalCardKind(card.options), isActingKey("enter_reading"), isQuietKey("stay_idle")]).toEqual(["enter", true, true]);
  });
});

describe("提议退回前面的阶段的卡片", () => {
  it("标题写退回；「回到：澄清」是主按钮，点了替用户发一句带键的话；「继续本步」不管助手写成什么都显示这四个字", () => {
    const handlers = card(BACK);
    const act = screen.getByTestId("act-choose");
    expect(act.querySelector(".tt")).toHaveTextContent(BACK_CARD_TITLE);
    expect(BACK_CARD_TITLE).toBe("退回前面的阶段 · 请决定");
    expect(act).toHaveAttribute("data-proposal", "back");
    expect(act).not.toHaveAttribute("data-stage-card");
    expect(screen.getByTestId("card-look-first")).toHaveTextContent("牵涉到：");
    expect(screen.getByTestId("card-option-goto:clarifying")).toHaveClass("pri");
    expect(screen.getByTestId("card-option-stay")).toHaveTextContent(/^继续本步$/);
    fireEvent.click(screen.getByTestId("card-option-goto:clarifying"));
    expect(handlers.onMessage.mock.calls).toEqual([["我选：回到：澄清", { reply_message_id: "msg-1", kind: "choose", choice: "goto:clarifying" }]]);
    expect(handlers.onAction).not.toHaveBeenCalled();
  });

  it("点「继续本步」：只发界面操作，卡片留着两个选项，「继续本步」带勾，小字说提议仍然开着", () => {
    const handlers = card(BACK);
    fireEvent.click(screen.getByTestId("card-option-stay"));
    expect(handlers.onAction.mock.calls).toEqual([[
      { kind: "continue_stage", targets: [], fields: { reply_message_id: "msg-1", option_key: "stay" }, notify_executor: false }, "选择继续本步"]]);
    expect(handlers.onMessage).not.toHaveBeenCalled();
    const stayed = screen.getByTestId("card-stayed");
    expect(within(stayed).getByTestId("card-option-stay")).toHaveTextContent("继续本步 ✓");
    expect(within(stayed).getByTestId("card-option-goto:clarifying")).toHaveClass("faded");
    expect(screen.getByTestId("card-stay-hint")).toHaveTextContent(STAY_HINT);
  });

  it("对话记录里的通知：写成「界面操作：用户选择继续本步」，卡片是已选的样子", () => {
    const messages = [reply("r1", "退回澄清吗？", BACK), note("n1", "r1", "stay"), said("u1", "先把手上的写完。")];
    show(messages);
    expect(screen.getByTestId("continue-stage-note")).toHaveTextContent(/^界面操作：用户选择继续本步$/);
    expect(screen.getByTestId("card-option-stay")).toHaveTextContent("继续本步 ✓");
    expect([answeredText(messages as ConversationMessage[], 0), answeredByStaying(messages as ConversationMessage[], 0), answeredStayKey(messages as ConversationMessage[], 0)])
      .toEqual(["你选了「继续本步」", true, "stay"]);
    // 早先的通知没有记点的是哪一项：取卡片上不生效的那一项。
    cleanup();
    show([reply("r1", "退回澄清吗？", BACK), note("n1", "r1")]);
    expect(screen.getByTestId("card-option-stay")).toHaveTextContent("继续本步 ✓");
    expect(continueStageLine(undefined)).toBe("界面操作：用户选择继续本步");
  });
});

describe("编写文档阶段请用户过目的卡片", () => {
  it("标题写请过目；「看过了，生成文档」是主按钮，点了不发话、不发界面操作，交给页面处理，带卡片所在的回复与点名的页", async () => {
    const onReviewed = vi.fn().mockResolvedValue(true);
    const handlers = card(REVIEW, {}, { onReviewed });
    const act = screen.getByTestId("act-choose");
    expect(act.querySelector(".tt")).toHaveTextContent(REVIEW_CARD_TITLE);
    expect(REVIEW_CARD_TITLE).toBe("补写的内容 · 请过目");
    expect(act).toHaveAttribute("data-proposal", "review");
    expect(screen.getByTestId("card-look-first")).toHaveTextContent("补写了这几页：");
    expect(screen.getByTestId("card-option-document_reviewed")).toHaveClass("pri");
    fireEvent.click(screen.getByTestId("card-option-document_reviewed"));
    expect(onReviewed.mock.calls).toEqual([["msg-1", REVIEW.items]]);
    expect(handlers.onMessage).not.toHaveBeenCalled();
    expect(handlers.onAction).not.toHaveBeenCalled();
    // 卡片收成一句，下面一句小字说可以去按「生成文档」。
    await vi.waitFor(() => expect(screen.getByTestId("card-reviewed-hint")).toHaveTextContent(REVIEWED_HINT));
    expect(screen.getByTestId("act-choose")).toHaveTextContent("✓ 你选了「看过了，生成文档」");
    expect(screen.queryByTestId("card-option-document_reviewed")).toBeNull();
  });

  it("没有做成：按钮放开，可以再点", async () => {
    const onReviewed = vi.fn().mockResolvedValue(false);
    card(REVIEW, {}, { onReviewed });
    fireEvent.click(screen.getByTestId("card-option-document_reviewed"));
    await vi.waitFor(() => expect(screen.getByTestId("card-option-document_reviewed")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("card-option-document_reviewed"));
    expect(onReviewed).toHaveBeenCalledTimes(2);
  });

  it("点「需要修改」：只发界面操作，卡片留着两个选项，小字请用户说要改哪里", () => {
    const handlers = card(REVIEW);
    fireEvent.click(screen.getByTestId("card-option-document_revise"));
    expect(handlers.onAction.mock.calls).toEqual([[
      { kind: "continue_stage", targets: [], fields: { reply_message_id: "msg-1", option_key: "document_revise" }, notify_executor: false }, "选择需要修改"]]);
    expect(handlers.onMessage).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("card-stayed")).getByTestId("card-option-document_revise")).toHaveTextContent("需要修改 ✓");
    expect(screen.getByTestId("card-stay-hint")).toHaveTextContent(REVISE_HINT);
  });

  it("对话记录里的通知：点了「看过了，生成文档」的卡片收成一句带小字；点了「需要修改」的留着两个选项", () => {
    const seen = [reply("r1", "请过目。", REVIEW), note("n1", "r1", "document_reviewed")];
    show(seen);
    expect(screen.getByTestId("continue-stage-note")).toHaveTextContent(/^界面操作：用户选择看过了，生成文档$/);
    expect(screen.getByTestId("card-reviewed-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("card-stayed")).toBeNull();
    expect(answeredText(seen as ConversationMessage[], 0)).toBe("你选了「看过了，生成文档」");
    cleanup();
    show([reply("r1", "请过目。", REVIEW), note("n1", "r1", "document_revise"), said("u1", "第二章的导语太长。")]);
    expect(screen.getByTestId("continue-stage-note")).toHaveTextContent(/^界面操作：用户选择需要修改$/);
    expect(screen.getByTestId("card-stayed")).toBeInTheDocument();
    expect(screen.queryByTestId("card-reviewed-hint")).toBeNull();
  });
});

describe("「待决定」一行的三种写法", () => {
  const base = { text: "", session_id: "s", reply_message_id: "reply-9", event_seq: 30, at: null };
  const back: StageProposal = { ...base, kind: "back", stage: "clarifying", enter: { key: "back_to_clarify", text: "退回澄清" }, stay: { key: "stay_in_stage", text: "留在本段" }, items: [] };
  const review: StageProposal = { ...base, kind: "review", stage: "document", enter: { key: "document_reviewed", text: "看过了，生成文档" },
    stay: { key: "document_revise", text: "需要修改" }, items: [{ item_id: "OA-020", revision_no: 1 }, { item_id: "OA-021", revision_no: 2 }, { item_id: "OA-022", revision_no: 1 }] };

  it("进入、退回、请过目各自的那句话；没有写种类的当作进入", () => {
    expect([pendingParts({ stage: "document" }).join(""), pendingParts({ kind: "enter", stage: "writing" }).join(""), pendingParts(back).join(""), pendingParts(review).join("")])
      .toEqual(["助手已提议进入编写文档阶段", "助手已提议进入写条目阶段", "助手已提议退回澄清阶段", "补写的 3 处待过目"]);
  });

  it("退回的提议：按钮是「退回澄清」，点了发那一句带键的话", () => {
    const onMessage = vi.fn();
    render(<Wrap><PendingProposal proposal={back} onMessage={onMessage} /></Wrap>);
    const row = screen.getByTestId("pending-proposal");
    expect(row).toHaveTextContent("待决定助手已提议退回澄清阶段退回澄清");
    expect(row).toHaveAttribute("data-kind", "back");
    fireEvent.click(screen.getByTestId("pending-enter"));
    expect(onMessage.mock.calls).toEqual([["我选：退回澄清", { reply_message_id: "reply-9", kind: "choose", choice: "back_to_clarify" }]]);
  });

  it("请过目的提议：写补写了几处，按钮是「看过了，生成文档」，点了不发话，交给页面处理；没有做成时按钮放开", async () => {
    const onMessage = vi.fn();
    const onReviewed = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<Wrap><PendingProposal proposal={review} onMessage={onMessage} onReviewed={onReviewed} /></Wrap>);
    const row = screen.getByTestId("pending-proposal");
    expect(row).toHaveTextContent("待决定补写的 3 处待过目看过了，生成文档");
    expect(row).toHaveAttribute("data-kind", "review");
    fireEvent.click(screen.getByTestId("pending-enter"));
    await vi.waitFor(() => expect(screen.getByTestId("pending-enter")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("pending-enter"));
    expect(onReviewed.mock.calls).toEqual([["reply-9", review.items], ["reply-9", review.items]]);
    expect(onMessage).not.toHaveBeenCalled();
    // 页面没有接这一种处理时算没有做成。
    expect(await actOnProposal(review, onMessage)).toBe(false);
    expect(await actOnProposal(back, vi.fn().mockReturnValue(true))).toBe(true);
  });
});
