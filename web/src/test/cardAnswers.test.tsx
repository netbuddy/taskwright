// 卡片之外的话不自动算作对卡片的回答：底部输入框打的字不关卡片；卡片只在这几种情形下算答过——带着它的标识的话（点了选项，或者在它的
// 文本框里打了字）、助手后面的回复写明用户的话回答了它（answers_card）、助手在后面把它重发了一遍（resends_card）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Act, ConversationMessage } from "../api/types";
import { Conversation, answeredText } from "../components/work/Conversation";
import { ANSWERED_OUTSIDE_TEXT, CARD_TYPED_CHOICE, RESENT_TEXT, TYPED_IN_CARD_TEXT } from "../components/work/ReplyCard";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const ASK: Act = { kind: "ask", scope: "general", text: "借书证丢了怎样补办？" };
const CHOOSE: Act = { kind: "choose", text: "逾期按哪种办法处理？", options: [{ key: "fine", text: "罚款" }, { key: "suspend", text: "停借" }] };
const reply = (id: string, text: string, act: Act | null = null, over: Record<string, unknown> = {}) =>
  ({ type: "assistant_reply", message_id: id, at: "", work_id: null, via_reply_tool: true, informs: [], act, text, ...over });
const said = (id: string, text: string, over: Record<string, unknown> = {}) =>
  ({ type: "user_message", message_id: id, at: "", text, origin: "typed", annotation: null, queued: false, ...over });
const typedIn = (id: string, text: string, replyId: string) => said(id, text, { annotation: { reply_message_id: replyId, option_key: "typed", option_text: null } });
const clicked = (id: string, replyId: string | null, key: string, text: string) =>
  said(id, `我选：${text}`, { origin: "card_choice", annotation: { reply_message_id: replyId, option_key: key, option_text: text } });
const answered = (messages: unknown[], index: number) => answeredText(messages as ConversationMessage[], index);

function show(messages: unknown[]) {
  const handlers = { onAction: vi.fn(), onMessage: vi.fn() };
  const onSend = vi.fn();
  render(<Wrap><Conversation messages={messages as ConversationMessage[]} currentWork={null} outgoing={[]} task={overallTask()}
    disabled={false} disabledReason={null} handlers={handlers} onSend={onSend} onUndo={noop} onOpenItem={noop} onAttach={noop}
    hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);
  return { handlers, onSend };
}

describe("卡片答过没有", () => {
  it("底部输入框打的字不关卡片：助手回了别的话之后卡片仍然开着，按钮与文本框照常可用", () => {
    const messages = [reply("r1", "先问一件事。", CHOOSE), said("u1", "输入资料里写了什么？"), reply("r2", "只写了一句话。")];
    expect(answered(messages, 0)).toBeNull();
    show(messages);
    const card = screen.getByTestId("act-choose");
    expect(within(card).queryByTestId("card-done")).toBeNull();
    expect(within(card).getByTestId("card-option-fine")).toBeEnabled();
    expect(within(card).getByTestId("card-input")).toBeEnabled();
    expect(card).not.toHaveTextContent("你直接写了回复");
    // 助手还没有回复时也一样：这句话是不是在回答卡片，要等助手的下一条回复。
    expect(answered([reply("r1", "先问一件事。", ASK), said("u1", "输入资料里写了什么？")], 0)).toBeNull();
  });

  it("在卡片的文本框里打的字带着它的标识：卡片收成「你在卡片里回复了」；带的是别的卡片的标识不算", () => {
    const messages = [reply("r1", "先问一件事。", ASK), typedIn("u1", "到服务台补办。", "r1")];
    expect(TYPED_IN_CARD_TEXT).toBe("你在卡片里回复了");
    expect(answered(messages, 0)).toBe(TYPED_IN_CARD_TEXT);
    show(messages);
    expect(screen.getByTestId("card-done")).toHaveTextContent(/^✓ 你在卡片里回复了$/);
    expect(screen.queryByTestId("card-input")).toBeNull();
    // 两张卡片都开着，用户在后一张的文本框里写了话：只有后一张答过。
    const two = [reply("r1", "先问一件事。", ASK), said("u1", "等一下。"), reply("r2", "再请你选一个。", CHOOSE), typedIn("u2", "罚款吧。", "r2")];
    expect([answered(two, 0), answered(two, 2)]).toEqual([null, TYPED_IN_CARD_TEXT]);
  });

  it("助手的下一条回复写明用户的话回答了这张卡片：收成「你回答了这张卡片」；写的是别的卡片不算", () => {
    const messages = [reply("r1", "先问一件事。", ASK), said("u1", "到服务台补办。"), reply("r2", "记下了。", null, { answers_card: ["r1"] })];
    expect(ANSWERED_OUTSIDE_TEXT).toBe("你回答了这张卡片");
    expect(answered(messages, 0)).toBe(ANSWERED_OUTSIDE_TEXT);
    show(messages);
    expect(screen.getByTestId("card-done")).toHaveTextContent(/^✓ 你回答了这张卡片$/);
    expect(screen.queryByTestId("card-input")).toBeNull();
    // 搁下了几轮之后才回答的也认；一句话答了两张卡片时两张都收起。
    const late = [reply("r1", "先问一件事。", ASK), said("u1", "等一下。"), reply("r2", "再请你选一个。", CHOOSE), said("u2", "别的事。"), reply("r3", "好。"),
      said("u3", "补办去服务台，逾期罚款。"), reply("r4", "都记下了。", null, { answers_card: ["r1", "r2"] })];
    expect([answered(late, 0), answered(late, 2)]).toEqual([ANSWERED_OUTSIDE_TEXT, ANSWERED_OUTSIDE_TEXT]);
    expect(answered([reply("r1", "先问一件事。", ASK), said("u1", "罚款。"), reply("r2", "好。", null, { answers_card: ["r0"] })], 0)).toBeNull();
  });

  it("助手在后面把这张卡片重发了一遍：原来那张收成「这个问题在后面重新问了」，不打勾；重发的那张开着", () => {
    const messages = [reply("r1", "先问一件事。", ASK), said("u1", "先说别的。"), reply("r2", "这个问题前面没有答，这一段结束前请确认。", ASK, { resends_card: "r1" })];
    expect(RESENT_TEXT).toBe("这个问题在后面重新问了");
    expect([answered(messages, 0), answered(messages, 2)]).toEqual([RESENT_TEXT, null]);
    show(messages);
    const [first, second] = screen.getAllByTestId("act-ask");
    expect(within(first).getByTestId("card-done")).toHaveTextContent(/^这个问题在后面重新问了$/);
    expect(within(first).getByTestId("card-done")).toHaveClass("pale");
    expect(within(first).queryByTestId("card-input")).toBeNull();
    expect(within(second).getByTestId("card-input")).toBeEnabled();
  });

  it("点卡片上的选项：带着这张卡片的标识就算，不管中间隔了什么；带着别的卡片的标识不算；早先没有带标识的只认紧跟在卡片后面的", () => {
    const later = [reply("r1", "请你选一个。", CHOOSE), said("u1", "先说别的。"), reply("r2", "好。"), clicked("u2", "r1", "fine", "罚款")];
    expect(answered(later, 0)).toBe("你选了「罚款」");
    const other = [reply("r1", "请你选一个。", CHOOSE), clicked("u1", "r0", "enter_clarify", "进入澄清")];
    expect(answered(other, 0)).toBeNull();
    expect(answered([reply("r1", "请你选一个。", CHOOSE), clicked("u1", null, "fine", "罚款")], 0)).toBe("你选了「罚款」");
    expect(answered([reply("r1", "请你选一个。", CHOOSE), said("u1", "先说别的。"), reply("r2", "好。"), clicked("u2", null, "fine", "罚款")], 0)).toBeNull();
  });

  it("界面操作之后发给助手的那句话（这几条都看过了）：只在助手还没有再回复之前算", () => {
    const viewed = said("u1", "我已经看过了：UC-001（修订 2）。请接着往下做。", { origin: "ui_request" });
    const confirm: Act = { kind: "confirm", text: "请看一下 UC-001。", items: [{ item_id: "UC-001", revision_no: 2 }] };
    expect(answered([reply("r1", "请过目。", confirm), viewed], 0)).toBe("你在卡片上表示看过了");
    expect(answered([reply("r1", "请过目。", confirm), said("u0", "先说别的。"), reply("r2", "好。"), viewed], 0)).toBeNull();
  });
});

describe("两个输入框发出的话", () => {
  it("卡片的文本框带这张卡片的标识；底部输入框不带", () => {
    const { handlers, onSend } = show([reply("r1", "先问一件事。", ASK)]);
    expect(CARD_TYPED_CHOICE).toBe("typed");
    fireEvent.change(screen.getByTestId("card-input"), { target: { value: "到服务台补办" } });
    fireEvent.click(screen.getByTestId("card-send"));
    expect(handlers.onMessage.mock.calls).toEqual([["到服务台补办", { reply_message_id: "r1", kind: "ask", choice: "typed" }]]);
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "输入资料里写了什么" } });
    fireEvent.click(screen.getByTestId("send"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe("输入资料里写了什么");
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
  });
});
