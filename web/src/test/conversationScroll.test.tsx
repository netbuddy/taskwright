// 对话区刷新之后停在最下面：修订小标签要等修订日志读回来才画出，内容又长高一截；修订日志变了时，用户停在最底部就再滚到底，
// 用户自己往上翻过就不动。测试环境不算布局，这里给对话区元素手工设内容高、可见高与滚动位置。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage } from "../api/types";
import { Conversation } from "../components/work/Conversation";

afterEach(() => cleanup());
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const MESSAGES = [{ type: "user_message", message_id: "u1", at: "", text: "请整理材料。" }] as unknown as ConversationMessage[];

function view(revisionCount: number) {
  return (
    <Wrap><Conversation messages={MESSAGES} currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
      handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
      hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} revisionCount={revisionCount} /></Wrap>
  );
}

/** 给对话区元素设内容高与可见高，滚动位置可读可写。 */
function layout(el: HTMLElement, box: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => box.scrollTop, set: (v: number) => { box.scrollTop = v; } });
}

describe("对话区跟着留在最底部", () => {
  it("修订日志读回来、内容长高之后，停在最底部的对话区再滚到底", () => {
    const { rerender } = render(view(0));
    const box = { scrollHeight: 470, clientHeight: 485, scrollTop: 0 };
    layout(screen.getByTestId("conversation"), box);
    box.scrollHeight = 495;   // 修订小标签画出来了
    rerender(view(1));
    expect(box.scrollTop).toBe(495);
  });

  it("用户往上翻过时，修订日志变了也不把他拽回最底部；翻回最底部之后照旧跟着", () => {
    const { rerender } = render(view(1));
    const el = screen.getByTestId("conversation");
    const box = { scrollHeight: 900, clientHeight: 485, scrollTop: 415 };
    layout(el, box);
    box.scrollTop = 100;
    fireEvent.scroll(el);
    rerender(view(2));
    expect(box.scrollTop).toBe(100);
    box.scrollTop = 415;
    fireEvent.scroll(el);
    box.scrollHeight = 925;
    rerender(view(3));
    expect(box.scrollTop).toBe(925);
  });
});
