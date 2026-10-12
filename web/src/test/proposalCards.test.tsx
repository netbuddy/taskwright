// 助手提议的另两种卡片：提议退回前面的阶段（「退回某阶段」「留在本段」），编写文档阶段请用户过目补写的页（「看过了，生成文档」「需要修改」）。
// 退回的那一项照进入卡片的做法替用户发一句带选项键的话；「留在本段」「需要修改」只发界面操作 continue_stage，各显示自己的文字；
// 「看过了，生成文档」不发话，交给页面做三件事（留通知、标已读、打开生成文档）。输入框上方「待决定」一行按提议的种类各有写法。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Act, ConversationMessage, StageProposal } from "../api/types";
import { Conversation, answeredByStaying, answeredStayKey, answeredText } from "../components/work/Conversation";
import { PendingProposal, actOnProposal, pendingParts } from "../components/work/PendingProposal";
import { BACK_CARD_TITLE, REVIEW_CARD_TITLE, ReplyCard, proposalKindOfCard } from "../components/work/ReplyCard";
import {
  BACK_KEYS, DOCUMENT_REVIEWED_KEY, DOCUMENT_REVISE_KEY, ENTER_KEYS, REVIEWED_HINT, REVISE_HINT, STAY_HERE_HINT, STAY_HERE_KEY, continueStageLine, isActingKey,
  isQuietKey, proposalCardKind, quietChoiceText, quietText,
} from "../model/stage";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const BACK: Act = { kind: "choose", text: "用户放进了一份新材料，前面几页的理解要重来。退回澄清吗？",
  options: [{ key: "back_to_clarify", text: "退回澄清" }, { key: "stay_in_stage", text: "先不退" }], items: [{ item_id: "OA-001", revision_no: 1 }] };
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
  it("进入的键五个、退回的键五个；一张卡片照进入、退回、请过目的先后认种类", () => {
    expect(ENTER_KEYS).toEqual({ enter_clarify: "clarifying", enter_consolidate: "modeling", start_items: "writing", enter_review: "reviewing", enter_document: "document" });
    expect(BACK_KEYS).toEqual({ back_to_reading: "reading", back_to_clarify: "clarifying", back_to_consolidate: "modeling", back_to_writing: "writing", back_to_review: "reviewing" });
    expect([STAY_HERE_KEY, DOCUMENT_REVIEWED_KEY, DOCUMENT_REVISE_KEY]).toEqual(["stay_in_stage", "document_reviewed", "document_revise"]);
    expect([proposalKindOfCard(BACK), proposalKindOfCard(REVIEW), proposalCardKind([{ key: "enter_document" }, { key: "continue_review" }]), proposalCardKind([{ key: "a" }]), proposalCardKind(null)])
      .toEqual(["back", "review", "enter", null, null]);
    expect(proposalKindOfCard({ kind: "ask", text: "？" })).toBeNull();
    expect(["back_to_clarify", "enter_document", "document_reviewed", "stay_in_stage", "document_revise", "continue_review"].map((key) => [isActingKey(key), isQuietKey(key)]))
      .toEqual([[true, false], [true, false], [true, false], [false, true], [false, true], [false, true]]);
    expect([quietText("stay_in_stage"), quietText("document_revise"), quietText("continue_review"), quietChoiceText("document_reviewed"), quietChoiceText(undefined)])
      .toEqual(["留在本段", "需要修改", "继续本阶段", "看过了，生成文档", "继续本阶段"]);
  });
});

describe("提议退回前面的阶段的卡片", () => {
  it("标题写退回；「退回澄清」是主按钮，点了替用户发一句带键的话；「留在本段」不管助手写成什么都显示这四个字", () => {
    const handlers = card(BACK);
    const act = screen.getByTestId("act-choose");
    expect(act.querySelector(".tt")).toHaveTextContent(BACK_CARD_TITLE);
    expect(BACK_CARD_TITLE).toBe("退回前面的阶段 · 请决定");
    expect(act).toHaveAttribute("data-proposal", "back");
    expect(act).not.toHaveAttribute("data-stage-card");
    expect(screen.getByTestId("card-look-first")).toHaveTextContent("牵涉到：");
    expect(screen.getByTestId("card-option-back_to_clarify")).toHaveClass("pri");
    expect(screen.getByTestId("card-option-stay_in_stage")).toHaveTextContent(/^留在本段$/);
    fireEvent.click(screen.getByTestId("card-option-back_to_clarify"));
    expect(handlers.onMessage.mock.calls).toEqual([["我选：退回澄清", { reply_message_id: "msg-1", kind: "choose", choice: "back_to_clarify" }]]);
    expect(handlers.onAction).not.toHaveBeenCalled();
  });

  it("点「留在本段」：只发界面操作，卡片留着两个选项，「留在本段」带勾，小字说提议仍然开着", () => {
    const handlers = card(BACK);
    fireEvent.click(screen.getByTestId("card-option-stay_in_stage"));
    expect(handlers.onAction.mock.calls).toEqual([[
      { kind: "continue_stage", targets: [], fields: { reply_message_id: "msg-1", option_key: "stay_in_stage" }, notify_executor: false }, "选择留在本段"]]);
    expect(handlers.onMessage).not.toHaveBeenCalled();
    const stayed = screen.getByTestId("card-stayed");
    expect(within(stayed).getByTestId("card-option-stay_in_stage")).toHaveTextContent("留在本段 ✓");
    expect(within(stayed).getByTestId("card-option-back_to_clarify")).toHaveClass("faded");
    expect(screen.getByTestId("card-stay-hint")).toHaveTextContent(STAY_HERE_HINT);
  });

  it("对话记录里的通知：写成「界面操作：用户选择留在本段」，卡片是已选的样子", () => {
    const messages = [reply("r1", "退回澄清吗？", BACK), note("n1", "r1", "stay_in_stage"), said("u1", "先把手上的写完。")];
    show(messages);
    expect(screen.getByTestId("continue-stage-note")).toHaveTextContent(/^界面操作：用户选择留在本段$/);
    expect(screen.getByTestId("card-option-stay_in_stage")).toHaveTextContent("留在本段 ✓");
    expect([answeredText(messages as ConversationMessage[], 0), answeredByStaying(messages as ConversationMessage[], 0), answeredStayKey(messages as ConversationMessage[], 0)])
      .toEqual(["你选了「留在本段」", true, "stay_in_stage"]);
    // 早先的通知没有记点的是哪一项：取卡片上不生效的那一项。
    cleanup();
    show([reply("r1", "退回澄清吗？", BACK), note("n1", "r1")]);
    expect(screen.getByTestId("card-option-stay_in_stage")).toHaveTextContent("留在本段 ✓");
    expect(continueStageLine(undefined)).toBe("界面操作：用户选择继续本阶段");
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
