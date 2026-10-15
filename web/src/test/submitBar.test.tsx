// 发布版本的提示条（model/submit.ts 与条目区）：什么时候显示（发布过、之后又没改过时不显示）、标题写下一版是第几版、问句照实写、
// 只有一个按钮「发布版本」、点了先弹确认框（可以写发布说明），点「发布」才交给工作视图去发，被拒时把说明写在提示条上；
// 对话里有没回应的发布卡片时不显示。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Completion, ConversationMessage, Item, Task } from "../api/types";
import { ApiError } from "../api/client";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { pendingSubmitCard, showSubmitBar, submitQuestion, submitTitle } from "../model/submit";

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
    task_id: "TASK-001", task_name: "图书借阅", task_type: "需求工程", domain_tag: null, started_at: "",
    definition: { collections: [collection("功能用例", "UC"), collection("约束", "CON"),
      { name: "问题", prefix: "TBD", needs_review: false, review_rules: null, fields: [
        { name: "事项", type: "文本", required: true, values: null }, { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] }] },
      collection("领域说明", "DN")] },
    completion: MET, items: [item("UC-001"), item("UC-002"), item("CON-001", "约束")], latest_revision: 3, ...over,
  };
}

/** 问句最后两句是定稿，只有版本号随数据变。 */
const TAIL = "要发布第 1 版吗？发布之后仍然可以接着修改，以后再发布新的一版。";
/** 发布过的一版。 */
const version = (no: number, revision: number, at = "2026-10-13T09:00:00") =>
  ({ version_no: no, revision_no: revision, published_at: at, actor: "user" as const, note: null, figure_count: null, figure_pictures: null, has_markdown: true, has_docx: true });

const card = (keys: string[]): ConversationMessage => ({ type: "assistant_reply", session_id: "s", message_id: "a1", at: "", text: "……", informs: [],
  act: { kind: "choose", text: "这个任务是否已经完成？", options: keys.map((key) => ({ key, text: key })) } } as unknown as ConversationMessage);
const said: ConversationMessage = { type: "user_message", session_id: "s", message_id: "u1", at: "", text: "我选：已完成，发布版本", origin: "card_choice" } as unknown as ConversationMessage;

describe("提示条显示的条件与问句", () => {
  it("问句照实写：有条目的集合与条目总数、评审、看过，末尾写后果；没有问题条目时不写问题那一句", () => {
    expect(submitQuestion(task())).toBe("功能用例、约束一共 3 个条目，都已经评审通过或者由你保留了写法，你也都看过了。" + TAIL);
  });

  it("各种条目组合下的问句：领域说明单独点名并写个数，问题有条目时才写", () => {
    const issue = (id: string, state: string) => ({ ...item(id, "问题"), fields: { 事项: id, 状态: state } });
    const notes = [item("DN-001", "领域说明"), item("DN-002", "领域说明")];
    const issues = [issue("TBD-001", "已解决"), issue("TBD-002", "用户决定保留")];
    const base = [item("UC-001"), item("UC-002"), item("CON-001", "约束")];
    const q = (items: Item[]) => submitQuestion(task({ items }));
    expect(q([item("UC-001")])).toBe("功能用例一共 1 个条目，都已经评审通过或者由你保留了写法，你也都看过了。" + TAIL);
    expect(q([...base, ...notes])).toBe("功能用例、约束一共 3 个条目，都已经评审通过或者由你保留了写法，你也都看过了；2 条领域说明你也都看过了。" + TAIL);
    expect(q([...base, ...issues])).toBe("功能用例、约束一共 3 个条目，都已经评审通过或者由你保留了写法，你也都看过了；2 个问题都已经解决或者由你决定保留。" + TAIL);
    expect(q([...base, ...notes, ...issues])).toBe("功能用例、约束一共 3 个条目，都已经评审通过或者由你保留了写法，你也都看过了；" +
      "2 条领域说明你也都看过了；2 个问题都已经解决或者由你决定保留。" + TAIL);
    // 要评审的集合一个条目都没有、只有领域说明（任务类型不要求至少一个功能用例时会出现）
    expect(q(notes)).toBe("领域说明一共 2 个条目，你也都看过了。" + TAIL);
    expect(q([...notes, ...issues])).toBe("领域说明一共 2 个条目，你也都看过了；2 个问题都已经解决或者由你决定保留。" + TAIL);
    expect(q([])).toBe(TAIL);
  });

  it("完成条件全部满足、助手不在工作、没有未回应的提交卡片才显示", () => {
    expect(showSubmitBar(task(), false, [])).toBe(true);
    expect(showSubmitBar(task({ completion: { ...MET, all_met: false } }), false, [])).toBe(false);
    expect(showSubmitBar(task({ completion: null }), false, [])).toBe(false);
    expect(showSubmitBar(task(), true, []), "助手在工作").toBe(false);
    expect(showSubmitBar(task(), false, [card(["complete", "continue"])]), "助手的提交卡片还没回应").toBe(false);
    expect(showSubmitBar(task(), false, [card(["complete", "continue"]), said]), "卡片回应过了（比如点了继续修改）").toBe(true);
    expect(showSubmitBar(task(), false, [card(["a", "b"])]), "别的卡片不算").toBe(true);
  });

  it("用户在底部输入框说了别的事，提交卡片还开着：提示条仍不显示；助手的回复写明这句话回答了卡片之后才显示", () => {
    const typed = { type: "user_message", session_id: "s", message_id: "u2", at: "", text: "UC-002 再改一个字。", origin: "typed", annotation: null } as unknown as ConversationMessage;
    const reply = (over: Record<string, unknown>) => ({ type: "assistant_reply", session_id: "s", message_id: "a2", at: "", text: "好。", informs: [], act: null,
      via_reply_tool: true, ...over }) as unknown as ConversationMessage;
    expect(showSubmitBar(task(), false, [card(["complete", "continue"]), typed, reply({})])).toBe(false);
    expect(showSubmitBar(task(), false, [card(["complete", "continue"]), typed, reply({ answers_card: ["a1"] })])).toBe(true);
  });

  it("总体分析这个集合在问句里写页面上的叫法「业务说明」", () => {
    const t = task();
    const withOverall = { ...t, definition: { collections: [...t.definition.collections, { name: "总体分析", prefix: "OA", needs_review: false, review_rules: null, fields: [{ name: "标题", type: "文本", required: true, values: null }] }] },
      completion: { ...MET, conditions: [...MET.conditions, cond("总体分析", "每个条目用户确认")] }, items: [...t.items, item("OA-001", "总体分析")] } as Task;
    expect(submitQuestion(withOverall)).toBe("功能用例、约束一共 3 个条目，都已经评审通过或者由你保留了写法，你也都看过了；1 条业务说明你也都看过了。" + TAIL);
  });

  it("发布过第 1 版、之后什么都没改：不显示；之后又有了修订或者图改过：显示，标题与问句写第 2 版", () => {
    const published = task({ versions: [version(1, 3)] });
    expect(showSubmitBar(published, false, [])).toBe(false);
    expect(showSubmitBar({ ...published, latest_revision: 4 }, false, [])).toBe(true);
    const redrawn = { ...published, diagrams: [{ diagram_id: "D-001", name: "借书", kind: "flowchart", kind_name: "流程图", revision_no: 2, revision_by: "executor", revision_at: "2026-10-13T10:00:00" }] } as unknown as Task;
    expect(showSubmitBar(redrawn, false, [])).toBe(true);
    expect([submitTitle(task()), submitTitle({ ...published, latest_revision: 4 })]).toEqual(["可以发布第 1 版了。", "可以发布第 2 版了。"]);
    expect(submitQuestion({ ...published, latest_revision: 4 })).toMatch(/要发布第 2 版吗？发布之后仍然可以接着修改，以后再发布新的一版。$/);
  });

  it("以最近一张提交卡片为准", () => {
    expect(pendingSubmitCard([card(["complete", "continue"]), said, card(["complete", "continue"])])).toBe(true);
    expect(pendingSubmitCard([card(["complete", "continue"]), said])).toBe(false);
  });
});

describe("条目区的提示条与确认框", () => {
  function panel(onPublish = vi.fn(async (_note: string): Promise<string | null> => null), props: Partial<Parameters<typeof ItemsPanel>[0]> = {}) {
    const submit = vi.fn(async (): Promise<ApiError | null> => null);
    render(<Wrap><ItemsPanel task={task()} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={noop}
      submit={submit} onGenerateDoc={noop} latestRevision={3} submitBar onPublish={onPublish} {...props} /></Wrap>);
    return { onPublish, submit };
  }

  it("只有一个按钮「发布版本」；点了先弹确认框，写明把修订 3 记为第 1 版、存下 Markdown 与 Word，可以写发布说明；点「取消」什么都不发", async () => {
    const { onPublish, submit } = panel();
    const bar = screen.getByTestId("submit-bar");
    expect(bar).toHaveTextContent(/^可以发布第 1 版了。功能用例、约束一共 3 个条目/);
    expect(bar.querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByTestId("submit-deliverable")).toHaveTextContent(/^发布版本$/);
    fireEvent.click(screen.getByTestId("submit-deliverable"));
    expect(await screen.findByTestId("publish-what")).toHaveTextContent("把现在的交付物（修订 3）记为第 1 版，并存下这一版生成的 Markdown 与 Word");
    expect(screen.getByText("发布第 1 版", { selector: ".ant-modal-title" })).toBeInTheDocument();
    expect(screen.getByTestId("publish-note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onPublish).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("确认框里写了发布说明点「发布」：交给工作视图去发，带着这句说明；不经界面操作的通道", async () => {
    const { onPublish, submit } = panel();
    fireEvent.click(screen.getByTestId("submit-deliverable"));
    fireEvent.change(await screen.findByTestId("publish-note"), { target: { value: "首版" } });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith("首版"));
    expect(submit).not.toHaveBeenCalled();
  });

  it("被拒时把说明写在提示条上", async () => {
    const text = "这次没有发布：你看到的是修订 3，交付物现在已经是修订 4。请看过现在的内容再发布。";
    panel(vi.fn(async () => text));
    fireEvent.click(screen.getByTestId("submit-deliverable"));
    fireEvent.click(await screen.findByRole("button", { name: "发布" }));
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
