// 问题跟着条目走：由问题条目的「关联条目」派生出每个条目挂着的问题，列表行的「问题 N」，详情顶部的问题区，从问题跳到条目。

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Item, Task } from "../api/types";
import { issueAnswerText, issueRefs, issuesOf, unresolvedIssuesOf, BUSY_TEXT } from "../model/items";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ItemIssues } from "../components/work/ItemIssues";
import { HOLD_TEXT } from "../components/work/ReplyCard";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);

const base = { revision_by: "executor", revision_at: "", revisions: [1], sources: [], reviews: [], confirmations: [], confirmation_stale: false };

function uc(id: string, title: string): Item {
  return { ...base, item_id: id, collection: "功能用例", title, revision_no: 1, fields: { 用例名称: title, 用例功能: `${title}的说明` } } as Item;
}
function tbd(id: string, matter: string, status: string, refs: string[], extra: Record<string, string> = {}, revision = 1): Item {
  return { ...base, item_id: id, collection: "问题", title: matter, revision_no: revision, revisions: [revision],
    fields: { 事项: matter, 种类: "待澄清", 建议的处理: "", 状态: status, 处理结果: "", 关联条目: refs, ...extra } } as Item;
}

function task(over: Partial<Task> = {}): Task {
  return {
    task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "功能用例", prefix: "UC", fields: [
        { name: "用例名称", type: "文本", required: true, values: null },
        { name: "用例功能", type: "文本", required: true, values: null }] },
      { name: "问题", prefix: "TBD", fields: [
        { name: "事项", type: "文本", required: true, values: null },
        { name: "种类", type: "枚举", required: true, values: ["待澄清", "范围外", "后续迭代"] },
        { name: "建议的处理", type: "文本", required: false, values: null },
        { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] },
        { name: "处理结果", type: "文本", required: false, values: null },
        { name: "关联条目", type: "条目引用", required: false, values: null }] }] },
    completion: null,
    items: [
      uc("UC-001", "借阅图书"), uc("UC-003", "归还图书"), uc("UC-005", "发送到期提醒"),
      tbd("TBD-010", "续借次数有没有上限，材料没说。", "未解决", ["UC-003"]),
      tbd("TBD-002", "逾期费用有没有上限，材料没说。", "未解决", ["UC-003", "UC-005"], { 建议的处理: "向图书馆确认逾期费用是否封顶。" }),
      tbd("TBD-001", "罚款怎么缴，材料没说。", "已解决", ["UC-003"], { 处理结果: "罚款在服务台缴纳" }, 9),
      tbd("TBD-003", "要不要支持邮件提醒。", "用户决定保留", ["UC-003"], {}, 12),
      tbd("TBD-004", "系统叫什么名字。", "未解决", []),
    ],
    ...over,
  } as Task;
}

describe("问题与条目的关系由关联条目派生", () => {
  it("issuesOf 取牵涉这个条目的全部问题，按编号的数值排序；unresolvedIssuesOf 不算已解决与用户决定保留", () => {
    const t = task();
    expect(issuesOf(t, "UC-003").map((i) => i.item_id)).toEqual(["TBD-001", "TBD-002", "TBD-003", "TBD-010"]);
    expect(unresolvedIssuesOf(t, "UC-003").map((i) => i.item_id)).toEqual(["TBD-002", "TBD-010"]);
    expect(unresolvedIssuesOf(t, "UC-005").map((i) => i.item_id)).toEqual(["TBD-002"]);
    expect(issuesOf(t, "UC-001")).toEqual([]);
    expect(issueRefs(t, t.items.find((i) => i.item_id === "TBD-002")!)).toEqual(["UC-003", "UC-005"]);
  });

  it("回答发出的话固定写成「回答 编号：用户输入」", () => {
    expect(issueAnswerText("TBD-002", "  封顶 50 元 ")).toBe("回答 TBD-002：封顶 50 元");
  });
});

/** 带选中状态的条目区，与工作页里一样由外面管着选中哪个条目。 */
function Panel({ t = task(), submit = vi.fn(async () => null), onSend = vi.fn(), onAnswer = vi.fn(), writesOff = false }: {
  t?: Task; submit?: (...args: never[]) => Promise<null>; onSend?: (text: string) => void; onAnswer?: (item: Item) => void; writesOff?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Wrap>
      <ItemsPanel task={t} readOnly={false} writesOff={writesOff} recentlyChanged={[]} pendingItems={new Set()} selected={selected} onSelect={setSelected}
        submit={submit as never} onGenerateDoc={() => undefined} onSend={onSend} onAnswer={onAnswer} />
    </Wrap>
  );
}

describe("条目列表行的「问题 N」", () => {
  it("N 只数没了结的问题，为 0 不显示", () => {
    render(<Panel />);
    expect(screen.getByTestId("issues-UC-003")).toHaveTextContent("问题 2");
    expect(screen.getByTestId("issues-UC-005")).toHaveTextContent("问题 1");
    expect(screen.queryByTestId("issues-UC-001")).toBeNull();
  });

  it("问题都了结之后徽标消失", () => {
    const t = task();
    t.items = t.items.map((i) => (i.collection === "问题" ? { ...i, fields: { ...i.fields, 状态: "已解决" } } : i));
    render(<Panel t={t} />);
    expect(screen.queryByTestId("issues-UC-003")).toBeNull();
  });
});

describe("条目详情顶部「挂在这条上的问题」", () => {
  it("标题写明个数；未解决的卡片带建议与输入框，已了结的变淡并写明处理结果与修订；没有问题的条目不渲染这一块", () => {
    render(<Panel />);
    fireEvent.click(screen.getByTestId("item-UC-003"));
    const area = screen.getByTestId("item-issues");
    expect(area).toHaveTextContent("挂在这条上的问题 4 个，2 个未解决");
    expect(within(area).getAllByTestId(/^issue-card-/).map((e) => e.dataset.testid)).toEqual(
      ["issue-card-TBD-001", "issue-card-TBD-002", "issue-card-TBD-003", "issue-card-TBD-010"]);
    const open = screen.getByTestId("issue-card-TBD-002");
    expect(open).toHaveTextContent("逾期费用有没有上限，材料没说。");
    expect(open).toHaveTextContent("助手建议的处理：向图书馆确认逾期费用是否封顶。");
    expect(within(open).getByPlaceholderText("回答这个问题，助手会改到牵涉的条目里…")).toBeInTheDocument();
    expect(within(open).queryByText("修改")).toBeNull();
    const done = screen.getByTestId("issue-card-TBD-001");
    expect(done).toHaveClass("closed");
    expect(screen.getByTestId("issue-outcome-TBD-001")).toHaveTextContent("处理结果：罚款在服务台缴纳（修订 9）");
    expect(screen.getByTestId("issue-outcome-TBD-003")).toHaveTextContent("在修订 12 标为用户决定保留");
    expect(within(done).queryByTestId("issue-input-TBD-001")).toBeNull();
    // 详情标题行上也有徽标
    expect(within(screen.getByTestId("item-detail")).getByTestId("issues-UC-003")).toHaveTextContent("问题 2");

    fireEvent.click(screen.getByText("‹ 回到列表"));
    fireEvent.click(screen.getByTestId("item-UC-001"));
    expect(screen.queryByTestId("item-issues")).toBeNull();
  });

  it("「回答」把固定句式直接发到对话区并清空输入框；输入框为空时只预填、不发送", () => {
    const onSend = vi.fn();
    const onAnswer = vi.fn();
    render(<Panel onSend={onSend} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId("item-UC-003"));
    fireEvent.click(screen.getByTestId("issue-answer-TBD-002"));
    expect(onSend).not.toHaveBeenCalled();
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ item_id: "TBD-002" }));
    const input = screen.getByTestId("issue-input-TBD-002");
    fireEvent.change(input, { target: { value: "封顶 50 元" } });
    fireEvent.click(screen.getByTestId("issue-answer-TBD-002"));
    expect(onSend).toHaveBeenCalledWith("回答 TBD-002：封顶 50 元");
    expect(input).toHaveValue("");
  });

  it("「先不管，保留」走 keep_pending，不通知助手", async () => {
    const submit = vi.fn(async () => null);
    render(<Panel submit={submit} />);
    fireEvent.click(screen.getByTestId("item-UC-003"));
    fireEvent.click(screen.getByTestId("issue-keep-TBD-010"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(
      { kind: "keep_pending", targets: [{ item_id: "TBD-010", base_revision: 1 }], notify_executor: false }, expect.any(String)));
  });

  it("助手工作中两个按钮都灰化并说明原因；有未保存的编辑时「回答」灰化；任务已结束时输入框也不能用", () => {
    render(<Panel writesOff />);
    fireEvent.click(screen.getByTestId("item-UC-003"));
    expect(screen.getByTestId("issue-answer-TBD-002")).toBeDisabled();
    expect(screen.getByTestId("issue-answer-TBD-002")).toHaveAttribute("title", BUSY_TEXT);
    expect(screen.getByTestId("issue-keep-TBD-002")).toBeDisabled();
    expect(screen.getByTestId("issue-keep-TBD-002")).toHaveAttribute("title", BUSY_TEXT);

    const t = task();
    const { unmount } = render(<Wrap><ItemIssues task={t} itemId="UC-005" readOnly={false} hold pendingItems={new Set()} submit={vi.fn() as never} /></Wrap>);
    expect(screen.getAllByTestId("issue-answer-TBD-002").at(-1)).toBeDisabled();
    expect(screen.getAllByTestId("issue-answer-TBD-002").at(-1)).toHaveAttribute("title", HOLD_TEXT);
    expect(screen.getAllByTestId("issue-keep-TBD-002").at(-1)).toBeEnabled();
    unmount();

    render(<Wrap><ItemIssues task={task({ status: "已完成" })} itemId="UC-005" readOnly pendingItems={new Set()} submit={vi.fn() as never} /></Wrap>);
    expect(screen.getAllByTestId("issue-input-TBD-002").at(-1)).toBeDisabled();
    expect(screen.getAllByTestId("issue-keep-TBD-002").at(-1)).toHaveAttribute("title", "任务已结束，不能再改。");
  });
});

describe("从「问题」页签跳到条目", () => {
  function jump() {
    render(<Panel />);
    fireEvent.click(screen.getByRole("tab", { name: /问题/ }));
    const card = screen.getByTestId("item-TBD-010");
    fireEvent.click(within(card).getByText("UC-003"));
  }

  it("顶部给「回到问题列表」与来源说明；那张问题卡片排第一并高亮，其余折叠成一行，点开展开", () => {
    jump();
    expect(screen.getByTestId("from-issue")).toHaveTextContent("‹ 回到问题列表你从 TBD-010 跳过来，它牵涉这条。");
    expect(screen.queryByText("‹ 回到列表")).toBeNull();
    const cards = within(screen.getByTestId("item-issues")).getAllByTestId(/^issue-card-/);
    expect(cards.map((e) => e.dataset.testid)).toEqual(["issue-card-TBD-010"]);
    expect(cards[0]).toHaveClass("hi");
    expect(screen.getByTestId("issues-more")).toHaveTextContent("还有 3 个问题 ▸");
    fireEvent.click(screen.getByTestId("issues-more"));
    expect(within(screen.getByTestId("item-issues")).getAllByTestId(/^issue-card-/).map((e) => e.dataset.testid)).toEqual(
      ["issue-card-TBD-010", "issue-card-TBD-001", "issue-card-TBD-002", "issue-card-TBD-003"]);
  });

  it("点「回到问题列表」切回问题页签并闪一下那张问题卡片，来源随之清掉", () => {
    jump();
    fireEvent.click(screen.getByTestId("back-to-issues"));
    expect(screen.queryByTestId("item-detail")).toBeNull();
    expect(screen.getByTestId("item-TBD-010")).toHaveClass("flash");
    fireEvent.click(within(screen.getByTestId("item-TBD-002")).getByText("UC-003"));
    expect(screen.getByTestId("from-issue")).toHaveTextContent("你从 TBD-002 跳过来");
  });

  it("换到别的条目时来源清掉，顶部回到「回到列表」，问题区不再折叠", () => {
    jump();
    fireEvent.click(screen.getByText("下一条 ›"));
    expect(screen.queryByTestId("from-issue")).toBeNull();
    expect(screen.getByText("‹ 回到列表")).toBeInTheDocument();
    expect(screen.queryByTestId("issues-more")).toBeNull();
  });
});
