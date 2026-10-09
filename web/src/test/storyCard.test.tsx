// 助手复述时的那张卡片（请选择，三个选项的键是 story_ok、story_fix、story_again）：故事画成故事的样子，卡片不铺底色；
// 故事写在卡片正文里就画在卡片里，写在回复正文里就把回复正文画成故事；点选项照现有的做法替用户发一句与选项相同的话。
// 别的请选择卡片照旧。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Act } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { ReplyCard } from "../components/work/ReplyCard";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const noop = () => {};
const OPTIONS = [{ key: "story_ok", text: "这段对，记下" }, { key: "story_fix", text: "有一处不对" }, { key: "story_again", text: "换一个人物再讲" }];
const STORY = "周六上午，小王在家里预约了《算法导论》。周一馆员把书放到预留架，系统通知小王。\n书为他保留 3 天，周日闭馆那天不算。周二下午小王来取，办了借阅。";

function card(act: Act) {
  const handlers = { onAction: vi.fn(), onMessage: vi.fn() };
  render(<Wrap><ReplyCard act={act} replyMessageId="msg-1" task={overallTask()} handlers={handlers} /></Wrap>);
  return handlers;
}
const reply = (over: Record<string, unknown>) => render(<Wrap><Conversation
  messages={[{ type: "assistant_reply", message_id: "r1", at: "", work_id: null, via_reply_tool: true, informs: [], ...over } as never]}
  currentWork={null} outgoing={[]} task={overallTask()} disabled={false} disabledReason={null}
  handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
  hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);

describe("复述的卡片", () => {
  it("故事写在卡片正文里：一段一段画成故事，卡片不铺底色，顶上写「复述 · 你看哪里不对」，下面是三个选项", () => {
    card({ kind: "choose", text: STORY, options: OPTIONS });
    const act = screen.getByTestId("act-choose");
    expect(act).toHaveClass("retell");
    expect(act.querySelector(".tt")).toHaveTextContent("复述 · 你看哪里不对");
    expect([...screen.getByTestId("card-story").querySelectorAll("p")].map((p) => p.textContent)).toEqual(STORY.split("\n"));
    expect(act.querySelector(".fk")).toBeNull();
    expect(OPTIONS.map((o) => screen.getByTestId(`card-option-${o.key}`).textContent)).toEqual(["这段对，记下", "有一处不对", "换一个人物再讲"]);
  });

  it("点一个选项照现有的做法：替用户发一句与选项相同的话", () => {
    const handlers = card({ kind: "choose", text: STORY, options: OPTIONS });
    fireEvent.click(screen.getByTestId("card-option-story_ok"));
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(handlers.onMessage.mock.calls[0])).toContain("这段对，记下");
  });

  it("没有写死的键、第一个选项以「这段对」开头的，也认作复述", () => {
    card({ kind: "choose", text: STORY, options: [{ key: "a", text: "这段对，记下" }, { key: "b", text: "有一处不对" }] });
    expect(screen.getByTestId("card-story")).toBeInTheDocument();
  });

  it("故事写在回复正文里（卡片正文只是一句问话）：回复正文画成故事，卡片里只有问话与选项", () => {
    reply({ text: STORY, act: { kind: "choose", text: "你看这段对不对？", options: OPTIONS } });
    expect(screen.getByTestId("reply-story")).toHaveTextContent("周六上午，小王在家里预约了《算法导论》");
    expect(screen.queryByTestId("card-story")).toBeNull();
    expect(screen.getByTestId("act-choose")).toHaveClass("retell");
    expect(screen.getByTestId("act-choose").querySelector(".val")).toHaveTextContent("你看这段对不对？");
  });

  it("别的请选择卡片照旧：有「要定的事」，没有故事，也不算复述", () => {
    card({ kind: "choose", text: "保留的 3 天里遇到闭馆日，算不算在内？".repeat(4), options: [{ key: "a", text: "闭馆日不算，顺延" }, { key: "b", text: "算在内，按自然日" }] });
    const act = screen.getByTestId("act-choose");
    expect(act).not.toHaveClass("retell");
    expect(act.querySelector(".tt")).toHaveTextContent("请选择");
    expect(act.querySelector(".fk")).toHaveTextContent("要定的事");
    expect(screen.queryByTestId("card-story")).toBeNull();
    cleanup();
    reply({ text: "有一件事要你定。", act: { kind: "choose", text: "保留期遇到闭馆日怎么算？", options: [{ key: "a", text: "顺延" }, { key: "b", text: "不顺延" }] } });
    expect(screen.queryByTestId("reply-story")).toBeNull();
  });
});
