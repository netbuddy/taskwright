// pi 的参数校验失败（模型写的参数不合格式，在 pi 里就被拦下）与任务服务的核对被拒在对话区里分开：
// 前者淡色、不画成被拒的颜色；连续多次时醒目。后端在步骤行与过程摘要的阶段上带 note（backend/src/work_summary.ts 的 argsInvalidNote）。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage, CurrentWork, WorkSummary } from "../api/types";
import { Conversation } from "../components/work/Conversation";

afterEach(cleanup);

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const noop = () => {};

function show(messages: ConversationMessage[], currentWork: CurrentWork | null) {
  render(<Wrap><Conversation messages={messages} currentWork={currentWork} outgoing={[]} task={null} disabled={false} disabledReason={null}
    handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop} hasEarlier={false}
    onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);
}

const line = (text: string) => screen.getByText(text).closest(".pline")!;

describe("参数校验失败与被拒分开显示", () => {
  it("实时步骤行：参数校验失败淡色、不用被拒的颜色；连续多次醒目；被拒照旧是被拒的颜色", () => {
    show([], { work_id: "w-1", started_at: "", triggered_by: null, steps: [
      { work_id: "w-1", step_key: 1, text: "助手写的参数不合格式，已自行改正", in_progress: false, failed: false, note: "args_invalid" },
      { work_id: "w-1", step_key: 2, text: "模型多次写错参数格式，建议换模型或缩短输入资料", in_progress: false, failed: false, note: "args_invalid_repeated" },
      { work_id: "w-1", step_key: 3, text: "保存修订被拒：摘录找不到。", in_progress: false, failed: true },
    ] });
    expect(line("助手写的参数不合格式，已自行改正")).toHaveClass("faint");
    expect(line("助手写的参数不合格式，已自行改正").getAttribute("style")).toBeNull();
    expect(line("模型多次写错参数格式，建议换模型或缩短输入资料")).toHaveClass("warn");
    expect(line("保存修订被拒：摘录找不到。")).not.toHaveClass("faint");
    expect(line("保存修订被拒：摘录找不到。").getAttribute("style")).toContain("var(--gap)");
  });

  it("过程摘要展开后：参数校验失败那一行淡色，别的行照旧", () => {
    const summary = { type: "work_summary", message_id: "summary-u1", work_id: "w-u1", at: "", seconds: 3, step_count: 2, outcome: "replied",
      stages: [{ text: "助手写的参数不合格式，已自行改正", count: 1, note: "args_invalid" }, { text: "保存修订被拒：摘录找不到。", count: 1, reasons: ["摘录找不到。"] }] } as WorkSummary;
    show([{ type: "user_message", message_id: "u1", at: "", text: "整理" }, summary] as ConversationMessage[], null);
    fireEvent.click(screen.getByTestId("work-summary"));
    expect(line("助手写的参数不合格式，已自行改正")).toHaveClass("faint");
    expect(line("保存修订被拒：摘录找不到。")).not.toHaveClass("faint");
    expect(line("保存修订被拒：摘录找不到。")).not.toHaveClass("warn");
  });
});
