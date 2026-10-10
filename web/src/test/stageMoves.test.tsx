// 对话区里说阶段移动的两种行：助手在回复里把任务退回前面的阶段，回复上面多一行「助手把任务退回某阶段：理由」（过程行的样子）；
// 用户在卡片上点了进入下一段，那句话下面多一行「界面操作：用户把任务从某阶段移到某阶段。」（界面操作记号的样子）。
// 没有移动阶段的消息照旧，不多任何一行。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { stageMoveLine } from "../model/stage";

afterEach(cleanup);
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const show = (messages: unknown[]) => render(<Wrap><Conversation messages={messages as ConversationMessage[]} currentWork={null} outgoing={[]} task={null}
  disabled={false} disabledReason={null} handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
  hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);
const reply = (id: string, text: string, over: Record<string, unknown> = {}) =>
  ({ type: "assistant_reply", message_id: id, at: "", work_id: null, via_reply_tool: true, informs: [], act: null, text, ...over });
const said = (id: string, text: string, over: Record<string, unknown> = {}) =>
  ({ type: "user_message", message_id: id, at: "", text, origin: "typed", annotation: null, queued: false, ...over });

describe("对话区里的阶段移动", () => {
  it("助手退回阶段的那条回复：上面一行写退回到哪里与理由，样子与过程行相同，排在回复之前", () => {
    show([reply("r1", "「自助机」这个词还没说清，先退回澄清。", { stage_move: { from: "modeling", to: "clarifying", actor: "executor", reason: "「自助机」这个词还没说清。" } })]);
    const line = screen.getByTestId("stage-move-assistant");
    expect(line).toHaveTextContent("助手把任务退回澄清：「自助机」这个词还没说清。");
    expect(line).toHaveClass("pline");
    expect(line.parentElement).toHaveClass("proc");
    const answer = screen.getByTestId("assistant-reply");
    expect(line.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("stage-move-user")).toBeNull();
  });

  it("用户在卡片上点了进入下一段：那句话下面一行写从哪到哪，样子与界面操作记号相同", () => {
    show([said("u1", "我选：进入澄清", { origin: "card_choice", stage_move: { from: "reading", to: "clarifying", actor: "user" } })]);
    const line = screen.getByTestId("stage-move-user");
    expect(line).toHaveTextContent("界面操作：用户把任务从核读材料移到澄清。");
    expect(line).toHaveClass("selfnote");
    const bubble = document.querySelector(".m.user")!;
    expect(bubble).toHaveTextContent("我选：进入澄清");
    expect(bubble.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("没有移动阶段的回复与用户的话照旧，不多任何一行", () => {
    show([said("u1", "预约的书留三天。"), reply("r1", "记下了。"), said("u2", "我选：继续澄清", { origin: "card_choice" })]);
    expect(screen.queryByTestId("stage-move-assistant")).toBeNull();
    expect(screen.queryByTestId("stage-move-user")).toBeNull();
  });

  it("那一行的说法：助手只会退回，写「退回」；没有理由时不带冒号；用户的写从哪到哪", () => {
    expect(stageMoveLine({ from: "writing", to: "modeling", actor: "executor", reason: " 流程页缺例外。 " })).toBe("助手把任务退回整理建模：流程页缺例外。");
    expect(stageMoveLine({ from: "writing", to: "modeling", actor: "executor" })).toBe("助手把任务退回整理建模。");
    expect(stageMoveLine({ from: "modeling", to: "writing", actor: "user" })).toBe("界面操作：用户把任务从整理建模移到写条目。");
  });
});
