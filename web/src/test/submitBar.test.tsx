// 提交交付物的提示条（model/submit.ts 与条目区）：什么时候显示、问句照实写、只有一个按钮、点了先弹确认框，
// 点「提交」才发 submit_deliverable（带页面看到的修订号），被拒时把说明写在提示条上；对话里有没回应的提交卡片时不显示。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Completion, ConversationMessage, Item, Task } from "../api/types";
import { ApiError } from "../api/client";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { pendingSubmitCard, showSubmitBar, submitQuestion } from "../model/submit";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
afterEach(() => cleanup());
const noop = () => {};

function item(id: string, collection = "功能用例"): Item {
  return {
    item_id: id, collection, title: id, revision_no: 3, revision_by: "executor", revision_at: "", revisions: [3],
    fields: { 用例名称: id }, sources: [], reviews: [{ revision_no: 3, verdict: "合规", findings: [] }],
    confirmations: [{ revision_no: 3, accepted: true, basis: "viewed" }], confirmation_stale: false,
  };
}

const cond = (collection: string, name: string, state: "met" | "empty" = "met") =>
  ({ collection, name, met: true, state, done: 0, total: 0, missing: [], note: "" });
const MET: Completion = { all_met: true, unmet_count: 0, brief: "", hints: [], conditions: [
  cond("功能用例", "至少一个条目"), cond("功能用例", "每个条目评审通过"), cond("功能用例", "每个条目用户确认"),
  cond("约束", "每个条目评审通过"), cond("约束", "每个条目用户确认"),
  cond("问题", "没有状态为未解决的条目", "empty"), cond("领域说明", "每个条目用户确认", "empty")] };

function task(over: Partial<Task> = {}): Task {
  const collection = (name: string, prefix: string) => ({ name, prefix, needs_review: false, review_rules: null, fields: [{ name: "用例名称", type: "文本", required: true, values: null }] });
  return {
    task_id: "TASK-001", task_name: "图书借阅", task_type: "软件需求规格说明编制", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [collection("功能用例", "UC"), collection("约束", "CON"),
      { name: "问题", prefix: "TBD", needs_review: false, review_rules: null, fields: [
        { name: "事项", type: "文本", required: true, values: null }, { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] }] },
      collection("领域说明", "DN")] },
    completion: MET, items: [item("UC-001"), item("UC-002"), item("CON-001", "约束")], latest_revision: 3, ...over,
  };
}

const card = (keys: string[]): ConversationMessage => ({ type: "assistant_reply", session_id: "s", message_id: "a1", at: "", text: "……", informs: [],
  act: { kind: "choose", text: "这个任务是否已经完成？", options: keys.map((key) => ({ key, text: key })) } } as unknown as ConversationMessage);
const said: ConversationMessage = { type: "user_message", session_id: "s", message_id: "u1", at: "", text: "我选：已完成，提交交付物", origin: "card_choice" } as unknown as ConversationMessage;

describe("提示条显示的条件与问句", () => {
  it("问句照实写：有条目的集合与条目总数、评审、看过、没有未解决的问题，末尾写后果", () => {
    expect(submitQuestion(task())).toBe("功能用例、约束一共 3 个条目，都已经评审通过或者由你保留了写法，你也都看过了，没有未解决的问题。" +
      "这个任务是否已经完成？提交之后交付物不能再改，仍然可以生成文档。");
  });

  it("任务进行中、完成条件全部满足、助手不在工作、没有未回应的提交卡片才显示", () => {
    expect(showSubmitBar(task(), false, [])).toBe(true);
    expect(showSubmitBar(task({ status: "已完成" }), false, [])).toBe(false);
    expect(showSubmitBar(task({ completion: { ...MET, all_met: false } }), false, [])).toBe(false);
    expect(showSubmitBar(task({ completion: null }), false, [])).toBe(false);
    expect(showSubmitBar(task(), true, []), "助手在工作").toBe(false);
    expect(showSubmitBar(task(), false, [card(["complete", "continue"])]), "助手的提交卡片还没回应").toBe(false);
    expect(showSubmitBar(task(), false, [card(["complete", "continue"]), said]), "卡片回应过了（比如点了继续修改）").toBe(true);
    expect(showSubmitBar(task(), false, [card(["a", "b"])]), "别的卡片不算").toBe(true);
  });

  it("以最近一张提交卡片为准", () => {
    expect(pendingSubmitCard([card(["complete", "continue"]), said, card(["complete", "continue"])])).toBe(true);
    expect(pendingSubmitCard([card(["complete", "continue"]), said])).toBe(false);
  });
});

describe("条目区的提示条与确认框", () => {
  function panel(submit = vi.fn(async (): Promise<ApiError | null> => null), props: Partial<Parameters<typeof ItemsPanel>[0]> = {}) {
    render(<Wrap><ItemsPanel task={task()} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={noop}
      submit={submit} onGenerateDoc={noop} latestRevision={3} submitBar {...props} /></Wrap>);
    return submit;
  }

  it("只有一个按钮「已完成，提交交付物」；点了先弹确认框，点「取消」什么都不发", async () => {
    const submit = panel();
    const bar = screen.getByTestId("submit-bar");
    expect(bar).toHaveTextContent(/^完成条件都满足了。功能用例、约束一共 3 个条目/);
    expect(bar.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("submit-deliverable"));
    expect(await screen.findByText("提交之后这个任务变成只读，交付物不能再改，仍然可以生成文档。确定提交吗？")).toBeInTheDocument();
    expect(screen.getByText("提交交付物", { selector: ".ant-modal-title" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("确认框里点「提交」：发 submit_deliverable，带页面看到的修订号", async () => {
    const submit = panel();
    fireEvent.click(screen.getByTestId("submit-deliverable"));
    fireEvent.click(await screen.findByRole("button", { name: "提交" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: "submit_deliverable", targets: [], fields: { revision_no: 3 }, notify_executor: false }, "提交交付物"));
  });

  it("被拒时把说明写在提示条上", async () => {
    const text = "这次没有提交：你看到的是修订 3，交付物现在已经是修订 4。请看过现在的内容再提交。";
    panel(vi.fn(async () => new ApiError("rejected", text)));
    fireEvent.click(screen.getByTestId("submit-deliverable"));
    fireEvent.click(await screen.findByRole("button", { name: "提交" }));
    expect(await screen.findByTestId("submit-error")).toHaveTextContent(text);
  });

  it("没有交 submitBar、只读时不显示", () => {
    panel(undefined, { submitBar: false });
    expect(screen.queryByTestId("submit-bar")).toBeNull();
    cleanup();
    panel(undefined, { readOnly: true });
    expect(screen.queryByTestId("submit-bar")).toBeNull();
  });
});
