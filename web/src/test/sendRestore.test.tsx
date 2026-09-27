// 发送失败时把原文放回输入框：失败且输入框还空着时放回；失败时用户已经接着打了新字就不放回；发送成功照常清空。
// 对话区、回复卡片、问题卡片三处输入框都按这个规矩。

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";

import type { Item, Task } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { ItemIssues } from "../components/work/ItemIssues";
import { ReplyCard } from "../components/work/ReplyCard";
import { ToastProvider } from "../components/Toasts";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);
const noop = () => undefined;

/** 一个由测试决定何时、以什么结果结束的发送。 */
function deferredSend() {
  let finish!: (sent: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>((ok) => (finish = ok)));
  return { send, finish: async (sent: boolean) => { await act(async () => finish(sent)); } };
}

function chat(onSend: (text: string) => Promise<boolean>) {
  render(<Wrap><Conversation messages={[]} currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
    handlers={{ onAction: noop, onMessage: noop }} onSend={onSend} onUndo={noop} onOpenItem={noop} onAttach={noop}
    hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);
  return screen.getByTestId("chat-input");
}

describe("对话区输入框", () => {
  it("发送失败、输入框还空着：把原文放回输入框", async () => {
    const { send, finish } = deferredSend();
    const box = chat(send);
    fireEvent.change(box, { target: { value: "罚款能不能用微信缴纳？" } });
    fireEvent.click(screen.getByTestId("send"));
    expect(send).toHaveBeenCalledWith("罚款能不能用微信缴纳？");
    expect(box).toHaveValue("");
    await finish(false);
    expect(box).toHaveValue("罚款能不能用微信缴纳？");
  });

  it("发送失败时用户已经接着打了新字：不放回，新字保留", async () => {
    const { send, finish } = deferredSend();
    const box = chat(send);
    fireEvent.change(box, { target: { value: "第一句" } });
    fireEvent.click(screen.getByTestId("send"));
    fireEvent.change(box, { target: { value: "接着打的新字" } });
    await finish(false);
    expect(box).toHaveValue("接着打的新字");
  });

  it("发送成功：输入框照常清空", async () => {
    const { send, finish } = deferredSend();
    const box = chat(send);
    fireEvent.change(box, { target: { value: "发得出去" } });
    fireEvent.click(screen.getByTestId("send"));
    await finish(true);
    expect(box).toHaveValue("");
  });
});

describe("卡片与问题的输入框", () => {
  it("回复卡片里自己打的话发送失败：放回卡片的输入框", async () => {
    const { send, finish } = deferredSend();
    render(<Wrap><ReplyCard act={{ kind: "ask", scope: "general", text: "你们打算怎样处理？" }} replyMessageId="msg-1" task={null}
      handlers={{ onAction: vi.fn(), onMessage: send }} /></Wrap>);
    const box = screen.getByTestId("card-input");
    fireEvent.change(box, { target: { value: "先按七天写" } });
    fireEvent.click(screen.getByTestId("card-send"));
    expect(box).toHaveValue("");
    await finish(false);
    expect(box).toHaveValue("先按七天写");
  });

  it("问题卡片的回答发送失败：放回回答框（放回的是用户打的字，不是加了前缀的整句）", async () => {
    const { send, finish } = deferredSend();
    const base = { revision_by: "executor", revision_at: "", revisions: [1], sources: [], reviews: [], confirmations: [], confirmation_stale: false };
    const t = {
      task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null, completion: null,
      definition: { collections: [
        { name: "功能用例", prefix: "UC", fields: [{ name: "用例名称", type: "文本", required: true, values: null }] },
        { name: "问题", prefix: "TBD", fields: [
          { name: "事项", type: "文本", required: true, values: null },
          { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] },
          { name: "关联条目", type: "条目引用", required: false, values: null }] }] },
      items: [
        { ...base, item_id: "UC-003", collection: "功能用例", title: "归还图书", revision_no: 1, fields: { 用例名称: "归还图书" } } as Item,
        { ...base, item_id: "TBD-002", collection: "问题", title: "逾期费用有没有上限", revision_no: 1,
          fields: { 事项: "逾期费用有没有上限", 状态: "未解决", 关联条目: ["UC-003"] } } as Item,
      ],
    } as Task;
    render(<Wrap><ItemIssues task={t} itemId="UC-003" readOnly={false} pendingItems={new Set()} submit={vi.fn(async () => null)} onSend={send} /></Wrap>);
    const box = screen.getByTestId("issue-input-TBD-002");
    fireEvent.change(box, { target: { value: "封顶 50 元" } });
    fireEvent.click(screen.getByTestId("issue-answer-TBD-002"));
    expect(send).toHaveBeenCalledWith("回答 TBD-002：封顶 50 元");
    expect(box).toHaveValue("");
    await finish(false);
    expect(box).toHaveValue("封顶 50 元");
  });
});
