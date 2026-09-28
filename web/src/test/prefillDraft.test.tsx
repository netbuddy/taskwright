// 预填对话区输入框（「让助手照这条改」「让助手来改这一条」「回答这个问题」、问题卡片上输入框空着时点「回答」都经这一处）：
// 输入框里已经有字时，预填的话接在已有的字后面，中间隔一个换行，不替换，用户打了一半的话不丢；输入框空着时照旧只放预填的话。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { Task } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { PREFILL, WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);

const task = {
  task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
  definition: { collections: [{ name: "问题", prefix: "TBD", fields: [
    { name: "事项", type: "文本", required: true, values: null },
    { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] }] }] },
  completion: null,
  items: [{ item_id: "TBD-001", collection: "问题", title: "罚款怎样缴纳", revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
    fields: { 事项: "罚款怎样缴纳", 状态: "未解决" }, sources: [], reviews: [], confirmations: [], confirmation_stale: false }],
} as unknown as Task;

function page() {
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  (useWorkView as Mock).mockReturnValue({
    state: { ...initialWorkState("S1"), phase: "ready", task, executor: { state: "idle", text: "", active_session: "S1" } },
    log: [], dispatch: vi.fn(), stream: "open", loadError: null, reload: vi.fn(),
  });
  render(<Wrap><WorkViewPage taskId="TASK-001" sessionId="S1" /></Wrap>);
}
const input = () => screen.getByTestId("chat-input") as HTMLTextAreaElement;
const PREFILLED = PREFILL.answer("TBD-001", "罚款怎样缴纳");

describe("预填不盖掉已经打好的草稿", () => {
  it("输入框里已经有字：预填的话接在后面，隔一个换行；光标在末尾", async () => {
    page();
    fireEvent.change(input(), { target: { value: "借期我还要再想想" } });
    fireEvent.click(screen.getByTestId("answer-TBD-001"));
    await waitFor(() => expect(input().value).toBe(`借期我还要再想想\n${PREFILLED}`));
    await waitFor(() => expect(input().selectionStart).toBe(input().value.length));
  });

  it("草稿末尾已经有换行时不再多加一个", async () => {
    page();
    fireEvent.change(input(), { target: { value: "借期我还要再想想\n" } });
    fireEvent.click(screen.getByTestId("answer-TBD-001"));
    await waitFor(() => expect(input().value).toBe(`借期我还要再想想\n${PREFILLED}`));
  });

  it("输入框空着（或只有空白）：照旧只放预填的话", async () => {
    page();
    fireEvent.click(screen.getByTestId("answer-TBD-001"));
    await waitFor(() => expect(input().value).toBe(PREFILLED));
    fireEvent.change(input(), { target: { value: "  " } });
    fireEvent.click(screen.getByTestId("answer-TBD-001"));
    await waitFor(() => expect(input().value).toBe(PREFILLED));
  });
});
