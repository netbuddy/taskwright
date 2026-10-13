// 提议进入下一个阶段的卡片上留在这一段的那一项：一律显示成「继续本阶段」；点了只发一个界面操作（continue_stage），不替用户发话；
// 卡片不收成一句，两个选项留着：进入的那一项变淡，「继续本阶段」带勾，下面一句小字说提议仍然开着。
// 对话记录里那条界面操作通知（种类 continue_stage）画成一行「界面操作：用户选择继续本阶段」，它指着的那张卡片显示为已选。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Act, ConversationMessage } from "../api/types";
import { Conversation, STAYED_TEXT, answeredByStaying, answeredText } from "../components/work/Conversation";
import { ReplyCard } from "../components/work/ReplyCard";
import { CONTINUE_STAGE_LINE, STAY_HINT, STAY_KEYS, STAY_TEXT } from "../model/stage";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const CARD: Act = { kind: "choose", text: "材料核读完了，进入澄清吗？", options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "continue_reading", text: "再核读一遍" }] };
function card(act: Act = CARD, over: Record<string, unknown> = {}) {
  const handlers = { onAction: vi.fn(), onMessage: vi.fn() };
  render(<Wrap><ReplyCard act={act} replyMessageId="msg-1" task={overallTask()} handlers={handlers} {...over} /></Wrap>);
  return handlers;
}
const reply = (id: string, text: string, act: Act | null = null) =>
  ({ type: "assistant_reply", message_id: id, at: "", work_id: null, via_reply_tool: true, informs: [], act, text });
const said = (id: string, text: string, over: Record<string, unknown> = {}) =>
  ({ type: "user_message", message_id: id, at: "", text, origin: "typed", annotation: null, queued: false, ...over });
const stayNote = (id: string, replyId: string) => ({ type: "ui_action_noted", message_id: id, at: "", event_seq: null, undoable: false, kind: "continue_stage",
  reply_message_id: replyId, stage: "clarifying", text: "界面操作（不是用户打的字）：用户在提议「进入澄清」的卡片上选了「继续本阶段」，没有进入澄清。" });
const show = (messages: unknown[]) => render(<Wrap><Conversation messages={messages as ConversationMessage[]} currentWork={null} outgoing={[]} task={overallTask()}
  disabled={false} disabledReason={null} handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
  hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);

describe("卡片上的「继续本阶段」", () => {
  it("留在这一段的五个键都认；文字是固定的一句", () => {
    expect([...STAY_KEYS].sort()).toEqual(["continue_clarify", "continue_consolidate", "continue_reading", "continue_review", "continue_writing"]);
    expect(STAY_TEXT).toBe("继续本阶段");
  });

  it("点了只发一个界面操作，带卡片所在的回复与点的键；不替用户发话；两个选项留着，进入的变淡，「继续本阶段」带勾", () => {
    const handlers = card();
    fireEvent.click(screen.getByTestId("card-option-continue_reading"));
    expect(handlers.onMessage).not.toHaveBeenCalled();
    expect(handlers.onAction.mock.calls).toEqual([[
      { kind: "continue_stage", targets: [], fields: { reply_message_id: "msg-1", option_key: "continue_reading" }, notify_executor: false }, "选择继续本阶段"]]);
    const stayed = screen.getByTestId("card-stayed");
    expect(within(stayed).getByTestId("card-option-enter_clarify")).toBeDisabled();
    expect(within(stayed).getByTestId("card-option-enter_clarify")).toHaveClass("faded");
    expect(within(stayed).getByTestId("card-option-continue_reading")).toHaveTextContent("继续本阶段 ✓");
    expect(within(stayed).getByTestId("card-option-continue_reading")).toHaveClass("picked");
    expect(screen.getByTestId("card-stay-hint")).toHaveTextContent(STAY_HINT);
    // 不收成「✓ 你选了…」那一句，卡片里的输入框也收起来了。
    expect(screen.getByTestId("act-choose")).not.toHaveTextContent("你选了");
    expect(screen.queryByTestId("card-input")).toBeNull();
  });

  it("对话记录里已经有那条通知的卡片：一打开就是已选的样子", () => {
    card(CARD, { answered: STAYED_TEXT, stayed: true });
    expect(screen.getByTestId("card-stayed")).toBeInTheDocument();
    expect(screen.getByTestId("card-option-continue_reading")).toHaveTextContent("继续本阶段 ✓");
  });

  it("点进入的那一项照旧发话；不是进入卡片的请选择里，键碰巧是 continue_reading 的选项照它写的文字显示、照旧发话", () => {
    const handlers = card();
    fireEvent.click(screen.getByTestId("card-option-enter_clarify"));
    expect(handlers.onMessage.mock.calls[0]).toEqual(["我选：进入澄清", { reply_message_id: "msg-1", kind: "choose", choice: "enter_clarify" }]);
    expect(handlers.onAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("card-stayed")).toBeNull();
    cleanup();
    const other = card({ kind: "choose", text: "要不要再读一遍？", options: [{ key: "continue_reading", text: "再读一遍" }, { key: "no", text: "不用" }] });
    expect(screen.getByTestId("card-option-continue_reading")).toHaveTextContent("再读一遍");
    fireEvent.click(screen.getByTestId("card-option-continue_reading"));
    expect(other.onMessage.mock.calls[0][0]).toBe("我选：再读一遍");
    expect(other.onAction).not.toHaveBeenCalled();
  });
});

describe("对话区里的「继续本阶段」", () => {
  it("那条通知画成一行短的；它指着的卡片是已选的样子，之后用户再说话也不变", () => {
    const messages = [said("u1", "读一下材料"), reply("r1", "进入澄清吗？", CARD), stayNote("n1", "r1"), said("u2", "「借书」那一节漏了一句。"), reply("r2", "已补上。")];
    show(messages);
    const line = screen.getByTestId("continue-stage-note");
    expect(line).toHaveTextContent(/^界面操作：用户选择继续本阶段$/);
    expect(CONTINUE_STAGE_LINE).toBe("界面操作：用户选择继续本阶段");
    expect(line).toHaveClass("selfnote");
    expect(line).not.toHaveTextContent("不是用户打的字");
    expect(screen.getByTestId("card-stayed")).toBeInTheDocument();
    expect(answeredText(messages as ConversationMessage[], 1)).toBe("你选了「继续本阶段」");
    expect(answeredByStaying(messages as ConversationMessage[], 1)).toBe(true);
  });

  it("通知指着的是别的回复：不算选了继续本阶段；用户在底部输入框说了别的话，卡片仍然开着，之后指着它的通知照样算", () => {
    const elsewhere = [reply("r1", "进入澄清吗？", CARD), stayNote("n1", "r0"), said("u2", "先等等。")];
    expect(answeredText(elsewhere as ConversationMessage[], 0)).toBeNull();
    expect(answeredByStaying(elsewhere as ConversationMessage[], 0)).toBe(false);
    const unanswered = [reply("r1", "进入澄清吗？", CARD)];
    expect(answeredText(unanswered as ConversationMessage[], 0)).toBeNull();
    // 卡片没有答就一直开着：用户说了别的事、助手又说了一条之后，他从「待决定」一行选了继续本阶段，通知指着这张卡片，算它答过了。
    const later = [reply("r1", "进入澄清吗？", CARD), said("u2", "先等等。"), reply("r2", "我再补一句。"), stayNote("n1", "r1")];
    expect(answeredText(later as ConversationMessage[], 0)).toBe("你选了「继续本阶段」");
    expect(answeredByStaying(later as ConversationMessage[], 0)).toBe(true);
  });
});
