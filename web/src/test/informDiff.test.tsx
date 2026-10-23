// 告知里点名的条目：点名的修订正是这条回复改出来的，点它进那次修订的比对；别的照旧打开条目。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Act, ConversationMessage } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const CHOOSE: Act = { kind: "choose", text: "接着走下一个维度吗？", options: [{ key: "go", text: "接着走" }, { key: "stop", text: "先停在这里" }] };
const reply = (informs: unknown[]) =>
  ({ type: "assistant_reply", message_id: "r1", at: "", work_id: "w1", via_reply_tool: true, informs, act: CHOOSE, text: "改好了。" });

function show(informs: unknown[], withDiff = true) {
  const onOpenItem = vi.fn();
  const onOpenDiff = vi.fn();
  render(<Wrap><Conversation messages={[reply(informs)] as ConversationMessage[]} currentWork={null} outgoing={[]} task={overallTask()}
    disabled={false} disabledReason={null} handlers={{ onAction: vi.fn(), onMessage: vi.fn() }} onSend={vi.fn()} onUndo={noop} onOpenItem={onOpenItem} onAttach={noop}
    hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} revisionsOfReply={() => [7]} onOpenDiff={withDiff ? onOpenDiff : undefined} /></Wrap>);
  return { onOpenItem, onOpenDiff };
}

describe("告知里的条目链接", () => {
  it("点名的修订是这条回复改出来的：点它进那次修订的比对", () => {
    const { onOpenItem, onOpenDiff } = show([{ text: "改了「起因与现状问题」：原来……，现在……", items: [{ item_id: "OA-002", revision_no: 7 }] }]);
    fireEvent.click(screen.getByTestId("inform-item-OA-002"));
    expect(onOpenDiff).toHaveBeenCalledWith("OA-002", 7);
    expect(onOpenItem).not.toHaveBeenCalled();
  });

  it("点名的修订不是这条回复改出来的、或者没给比对入口：照旧打开条目", () => {
    const first = show([{ text: "输入资料里写着。", items: [{ item_id: "OA-002", revision_no: 3 }] }]);
    fireEvent.click(screen.getByTestId("inform-item-OA-002"));
    expect(first.onOpenItem).toHaveBeenCalledWith("OA-002");
    expect(first.onOpenDiff).not.toHaveBeenCalled();
    cleanup();
    const second = show([{ text: "改了。", items: [{ item_id: "OA-002", revision_no: 7 }] }], false);
    fireEvent.click(screen.getByTestId("inform-item-OA-002"));
    expect(second.onOpenItem).toHaveBeenCalledWith("OA-002");
  });
});
