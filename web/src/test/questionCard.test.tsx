// 问答卡片：选项带理由或标了多选的「请选择」画成它；选好按「发送」才发，合成一句话走在卡片里打字的通道；答过收成一行。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Act } from "../api/types";
import { QuestionCard, SKIP_TEXT, answeredSummary, composeAnswer, isQuestionCard } from "../components/work/QuestionCard";
import { CARD_TYPED_CHOICE } from "../components/work/ReplyCard";

afterEach(cleanup);

const single: Act = {
  kind: "choose", text: "你认为目前最要紧的现状问题是什么？", topic: "起因与现状问题",
  options: [
    { key: "a", text: "模型成本失控", reason: "出处：预算复函。" },
    { key: "b", text: "权限与日志各自为政", reason: "出处：现状调研第 3 节。" },
    { key: "c", text: "重复建设", reason: "同类平台通常如此。（助手补充）" },
  ],
};
const multi: Act = { ...single, text: "这一期必须做的是哪几项？", topic: "范围", multiple: true };

function setup(act: Act, extra: { answered?: string | null; answeredWith?: string | null } = {}) {
  const onMessage = vi.fn(() => Promise.resolve(true));
  render(<div className="app"><QuestionCard act={act} replyMessageId="msg-9" handlers={{ onAction: vi.fn(), onMessage }} {...extra} /></div>);
  return onMessage;
}

describe("问答卡片", () => {
  it("选项带理由、或者标了多选的请选择才是问答卡片；进入下一步一类只有文字的选项不是", () => {
    expect(isQuestionCard(single)).toBe(true);
    expect(isQuestionCard({ kind: "choose", text: "选哪个？", options: [{ key: "a", text: "甲" }, { key: "b", text: "乙" }], multiple: true })).toBe(true);
    expect(isQuestionCard({ kind: "choose", text: "选哪个？", options: [{ key: "next_step", text: "进入下一步：澄清" }, { key: "stay", text: "继续本步" }] })).toBe(false);
    expect(isQuestionCard({ kind: "ask", text: "现状问题是什么？", scope: "general" })).toBe(false);
  });

  it("顶上写「提问 · 标题」，候选标 A、B、C 并写理由，自由回答的序号接在后面是 D", () => {
    setup(single);
    expect(screen.getByText("提问 · 起因与现状问题")).toBeTruthy();
    expect(screen.getByTestId("question-option-a").textContent).toBe("A模型成本失控出处：预算复函。");
    expect(screen.getByText("同类平台通常如此。（助手补充）")).toBeTruthy();
    expect(screen.getByText("D")).toBeTruthy();
  });

  it("单选：点一项只是选上，再点另一项换成另一项；按「发送」才发，带补充，走在卡片里打字的通道", () => {
    const onMessage = setup(single);
    fireEvent.click(screen.getByTestId("question-option-a"));
    expect(onMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("question-option-b"));
    expect(screen.getByTestId("question-option-a").getAttribute("aria-checked")).toBe("false");
    fireEvent.change(screen.getByTestId("question-free"), { target: { value: "审计已经两次查不到人。" } });
    fireEvent.click(screen.getByTestId("question-send"));
    expect(onMessage).toHaveBeenCalledWith("我选：权限与日志各自为政。补充：审计已经两次查不到人。", { reply_message_id: "msg-9", kind: "choose", choice: CARD_TYPED_CHOICE });
    expect(screen.getByTestId("question-card-done").textContent).toBe("提问 · 起因与现状问题 · 已答：选 B · 有补充");
  });

  it("多选：几项可以同时选上，合成的话逐项列出；什么都没选也没写时「发送」不能按", () => {
    const onMessage = setup(multi);
    expect(screen.getByText("可以多选。")).toBeTruthy();
    expect((screen.getByTestId("question-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("question-option-a"));
    fireEvent.click(screen.getByTestId("question-option-c"));
    fireEvent.click(screen.getByTestId("question-send"));
    expect(onMessage).toHaveBeenCalledWith("我选：模型成本失控；重复建设。", expect.anything());
  });

  it("写了标题而没有选项的是开放问题：只有自由回答（序号 A）与「先跳过」，写的话原样发出", () => {
    const open: Act = { kind: "choose", topic: "起因与现状问题", text: "为了写清起因：你看最要紧的是什么？", options: [] };
    expect(isQuestionCard(open)).toBe(true);
    const onMessage = setup(open);
    expect(screen.queryByTestId("question-option-a")).toBeNull();
    expect(screen.getByText("A")).toBeTruthy();
    fireEvent.change(screen.getByTestId("question-free"), { target: { value: "费用分散最要紧。" } });
    fireEvent.click(screen.getByTestId("question-send"));
    expect(onMessage).toHaveBeenCalledWith("费用分散最要紧。", expect.anything());
    expect(screen.getByTestId("question-card-done").textContent).toBe("提问 · 起因与现状问题 · 已答：自己回答");
  });

  it("「先跳过这一问」发一句固定的话", () => {
    const onMessage = setup(single);
    fireEvent.click(screen.getByTestId("question-skip"));
    expect(onMessage).toHaveBeenCalledWith(SKIP_TEXT, expect.anything());
    expect(screen.getByTestId("question-card-done").textContent).toBe("提问 · 起因与现状问题 · 已跳过");
  });

  it("对话记录里已经答过：收成一行，据那句话写选了哪几项", () => {
    setup(multi, { answered: "你在卡片里回复了", answeredWith: "我选：模型成本失控；重复建设。" });
    expect(screen.getByTestId("question-card-done").textContent).toBe("提问 · 范围 · 已答：选 A、C");
  });

  it("合成与收起的写法：只写了自己的话就原样发；收起时写「自己回答」", () => {
    expect(composeAnswer([], "  先做服务台。 ")).toBe("先做服务台。");
    expect(composeAnswer([], "")).toBe("");
    expect(answeredSummary(single, "先做服务台。")).toBe("已答：自己回答");
    expect(answeredSummary(single, null)).toBe("已答");
  });
});
