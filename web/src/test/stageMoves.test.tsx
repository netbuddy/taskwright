// 对话区里说阶段移动的那一行：用户在卡片上点了进入下一段，那句话下面多一行「界面操作：用户把工作项从某阶段移到某阶段。」（界面操作记号的样子）。
// 阶段只由用户移动，助手的回复上面没有这样的一行。没有移动阶段的消息照旧，不多任何一行。
// 用户点了一张进入某个阶段的卡片而阶段没有移动时，卡片上「✓ 你选了…」下面多一句小字「这次点击没有改变阶段：工作项当时在某阶段。」
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { activityDoneLine, stageMoveLine, stageUnmovedLine } from "../model/stage";

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
  it("助手的回复上面不写阶段移动：回复里带着早先留下的那一项也不多一行", () => {
    show([reply("r1", "「自助机」这个词还没说清，先退回澄清。", { stage_move: { from: "modeling", to: "clarifying", actor: "executor", reason: "「自助机」这个词还没说清。" } })]);
    expect(screen.getByTestId("assistant-reply")).toHaveTextContent("「自助机」这个词还没说清，先退回澄清。");
    expect(document.querySelector(".proc")).toBeNull();
    expect(screen.queryByTestId("stage-move-user")).toBeNull();
  });

  it("用户在卡片上点了进入下一段：那句话下面一行写从哪到哪，样子与界面操作记号相同", () => {
    show([said("u1", "我选：进入澄清", { origin: "card_choice", stage_move: { from: "reading", to: "clarifying", actor: "user" } })]);
    const line = screen.getByTestId("stage-move-user");
    expect(line).toHaveTextContent("界面操作：用户把工作项从核读材料移到澄清。");
    expect(line).toHaveClass("selfnote");
    const bubble = document.querySelector(".m.user")!;
    expect(bubble).toHaveTextContent("我选：进入澄清");
    expect(bubble.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("没有移动阶段的回复与用户的话照旧，不多任何一行", () => {
    show([said("u1", "预约的书留三天。"), reply("r1", "记下了。"), said("u2", "我选：继续澄清", { origin: "card_choice" })]);
    expect(screen.queryByTestId("stage-move-user")).toBeNull();
  });

  it("点了一张进入某个阶段的卡片而阶段没有移动：卡片上「✓ 你选了…」下面多一句小字，写任务当时在哪个阶段；用户那句话下面不多一行", () => {
    const card = { kind: "choose", text: "现在进入整理建模吗？", options: [{ key: "enter_consolidate", text: "进入整理建模" }, { key: "continue_clarify", text: "继续澄清" }] };
    show([reply("r1", "要问的都问到了。", { act: card }), said("u1", "我选：进入整理建模", { origin: "card_choice",
      annotation: { reply_message_id: "r1", option_key: "enter_consolidate", option_text: "进入整理建模" }, stage_unmoved: { at: "reading" } })]);
    const note = screen.getByTestId("card-stage-unmoved");
    expect(note).toHaveTextContent("这次点击没有改变阶段：工作项当时在核读材料。");
    expect(note).toHaveClass("done", "pale");
    const done = document.querySelector(".act .done:not(.pale)")!;
    expect(done).toHaveTextContent("✓ 你选了「进入整理建模」");
    expect(done.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("stage-move-user")).toBeNull();
  });

  it("记了移动的点击、不带这一项的点击（留在这一段的选项、早先留下的点击）、用户在卡片的文本框里打字答的卡片：都没有那句小字", () => {
    const card = { kind: "choose", text: "现在进入整理建模吗？", options: [{ key: "enter_consolidate", text: "进入整理建模" }, { key: "continue_clarify", text: "继续澄清" }] };
    const click = (over: Record<string, unknown>) => said("u1", "我选：进入整理建模", { origin: "card_choice",
      annotation: { reply_message_id: "r1", option_key: "enter_consolidate", option_text: "进入整理建模" }, ...over });
    for (const answer of [click({ stage_move: { from: "clarifying", to: "modeling", actor: "user" } }), click({}),
      said("u1", "再等等。", { annotation: { reply_message_id: "r1", option_key: "typed", option_text: null }, stage_unmoved: { at: "reading" } })]) {
      show([reply("r1", "要问的都问到了。", { act: card }), answer]);
      expect(document.querySelector(".act .done")).not.toBeNull();
      expect(screen.queryByTestId("card-stage-unmoved")).toBeNull();
      cleanup();
    }
    // 那句话只跟着答这张卡片的那一次点击：后面另一张卡片不受影响。
    show([reply("r1", "要问的都问到了。", { act: card }), click({ stage_unmoved: { at: "reading" } }), reply("r2", "还在核读材料。", { act: card })]);
    expect(screen.getAllByTestId("card-stage-unmoved")).toHaveLength(1);
    expect(screen.getAllByTestId("act-choose")[1].querySelector(".done")).toBeNull();
  });

  it("那句小字的说法：写任务当时所在阶段的名字", () => {
    expect(stageUnmovedLine("reading")).toBe("这次点击没有改变阶段：工作项当时在核读材料。");
    expect(stageUnmovedLine("reviewing")).toBe("这次点击没有改变阶段：工作项当时在评审确认。");
  });

  it("那一行的说法：写用户把工作项从哪个阶段移到哪个阶段，往前、往后都是这一句", () => {
    expect(stageMoveLine({ from: "modeling", to: "writing", actor: "user" })).toBe("界面操作：用户把工作项从整理建模移到写条目。");
    expect(stageMoveLine({ from: "writing", to: "clarifying", actor: "user" })).toBe("界面操作：用户把工作项从写条目移到澄清。");
  });

  it("任务空闲时点了「开始核读材料」：那一行写启动首次分析（走过一段的写继续）；早先的消息没有写怎样开始的，照移动写", () => {
    expect(stageMoveLine({ from: "idle", to: "reading", actor: "user", how: "launch" })).toBe("界面操作：用户启动工作流程「首次分析」，从「核读材料」开始。");
    expect(stageMoveLine({ from: "idle", to: "reading", actor: "user", how: "resume" })).toBe("界面操作：用户继续工作流程「首次分析」，从「核读材料」接着。");
    expect(stageMoveLine({ from: "reading", to: "clarifying", actor: "user", how: "move" })).toBe("界面操作：用户把工作项从核读材料移到澄清。");
    show([said("u1", "我选：开始核读材料", { origin: "card_choice", stage_move: { from: "idle", to: "reading", actor: "user", how: "launch" } })]);
    expect(screen.getByTestId("stage-move-user")).toHaveTextContent("界面操作：用户启动工作流程「首次分析」，从「核读材料」开始。");
  });

  it("会话不在做流程的工作项时点了进入或退回的卡片：卡片上的小字说这次点击没有生效、本会话是什么情形、请从任务起点页启动一个工作项", () => {
    expect(stageUnmovedLine("idle", "not_in_flow")).toBe("这次点击没有生效：本会话没有在进行的工作流程。要进入某个阶段，请从任务起点页启动一个工作项。");
    expect(stageUnmovedLine("clarifying", "not_in_flow")).toBe("这次点击没有生效：本会话的工作项是单项活动「澄清」。要进入某个阶段，请从任务起点页启动一个工作项。");
    expect(stageUnmovedLine("clarifying", null)).toBe("这次点击没有改变阶段：工作项当时在澄清。");
    const card = { kind: "choose", text: "现在进入整理建模吗？", options: [{ key: "enter_consolidate", text: "进入整理建模" }, { key: "continue_clarify", text: "继续澄清" }] };
    show([reply("r1", "要问的都问到了。", { act: card }), said("u1", "我选：进入整理建模", { origin: "card_choice",
      annotation: { reply_message_id: "r1", option_key: "enter_consolidate", option_text: "进入整理建模" }, stage_unmoved: { at: "idle", why: "not_in_flow" } })]);
    expect(screen.getByTestId("card-stage-unmoved")).toHaveTextContent("这次点击没有生效：本会话没有在进行的工作流程。要进入某个阶段，请从任务起点页启动一个工作项。");
  });

  it("助手汇报工作项做完：那条回复下面一行写做完的是哪一项、这条会话此后怎样办；别的回复没有这一行", () => {
    expect(activityDoneLine("modeling")).toBe("助手汇报这个工作项做完：整理建模。本会话此后按自由讨论办；要再做，从任务起点页再启动一次。");
    show([reply("r1", "五张图都画好了。", { activity_done: { activity: "modeling" } }), reply("r2", "记下了。")]);
    const lines = screen.getAllByTestId("activity-done");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("助手汇报这个工作项做完：整理建模。本会话此后按自由讨论办；要再做，从任务起点页再启动一次。");
    expect(lines[0]).toHaveClass("selfnote");
    const first = screen.getAllByTestId("assistant-reply")[0];
    expect(first.compareDocumentPosition(lines[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
