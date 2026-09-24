// 卡片五种主行为的渲染与按钮走向，以及直接操作被拒时的错误显示（第 8 节）。

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";

import type { Act, Task } from "../api/types";
import { ApiError } from "../api/client";
import { ReplyCard, TEMPLATES } from "../components/work/ReplyCard";
import { ItemDetail } from "../components/work/ItemDetail";
import { MaterialPane } from "../components/work/MaterialPane";
import { Markdown } from "../components/work/Markdown";
import { Conversation } from "../components/work/Conversation";
import { api } from "../api/client";
import { PREFILL } from "../pages/WorkViewPage";

// 与应用里一样关掉按钮两个汉字之间自动加的空格，按文字找按钮才找得到。
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);

function task(reviewVerdict?: string): Task {
  return {
    task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "用例", prefix: "UC", fields: [
        { name: "名称", type: "文本", required: true, values: null },
        { name: "步骤", type: "文本列表", required: true, values: null }] },
      { name: "问题", prefix: "TBD", fields: [
        { name: "事项", type: "文本", required: true, values: null },
        { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] }] }] },
    completion: null,
    items: [
      { item_id: "UC-001", collection: "用例", title: "买家申请退款", revision_no: 2, revision_by: "executor", revision_at: "", revisions: [1, 2],
        fields: { 名称: "买家申请退款", 步骤: ["提交申请"] }, sources: [],
        reviews: reviewVerdict ? [{ revision_no: 2, verdict: reviewVerdict, findings: [{ field: "步骤", index: 0, problem: "缺主语", suggestion: null }] }] : [],
        confirmations: [], confirmation_stale: false },
      { item_id: "TBD-001", collection: "问题", title: "退款时限", revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
        fields: { 事项: "退款时限", 状态: "未解决" }, sources: [], reviews: [], confirmations: [], confirmation_stale: false },
    ],
  };
}

function card(act: Act, t = task()) {
  const handlers = { onAction: vi.fn(), onMessage: vi.fn() };
  render(<Wrap><ReplyCard act={act} replyMessageId="msg-7" task={t} handlers={handlers} /></Wrap>);
  return handlers;
}

describe("卡片五种主行为", () => {
  it("请确认：「这几条都看过了」走 actions 的 mark_viewed（条目与修订号取自卡片，notify_executor 为真），不发话", () => {
    const h = card({ kind: "confirm", text: "请确认 UC-001 修订 2。", items: [{ item_id: "UC-001", revision_no: 2 }] });
    // 卡片头部的上下文：条目编号小标签、标题、修订号与已读与否（从没看过写「未读」）
    expect(screen.getByTestId("card-context-UC-001")).toHaveTextContent("UC-001买家申请退款修订 2（未读）");
    expect(screen.getByTestId("card-confirm")).toHaveTextContent("这几条都看过了");
    fireEvent.click(screen.getByTestId("card-confirm"));
    expect(h.onAction).toHaveBeenCalledWith(
      { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 2 }], notify_executor: true }, expect.any(String));
    expect(h.onMessage).not.toHaveBeenCalled();
  });

  it("请确认：「不对」走 messages，用固定模板，并带上是哪条回复的哪个选项", () => {
    const h = card({ kind: "confirm", text: "请确认。", items: [{ item_id: "UC-001", revision_no: 2 }] });
    fireEvent.click(screen.getByTestId("card-wrong"));
    expect(h.onMessage).toHaveBeenCalledWith(TEMPLATES.confirmWrong, { reply_message_id: "msg-7", kind: "confirm", choice: "不对" });
    expect(h.onAction).not.toHaveBeenCalled();
  });

  it("请确认：评审没有通过的条目点「这几条都看过了」时先提示，不拦，点「仍然标为看过」才走 actions", async () => {
    const h = card({ kind: "confirm", text: "请确认。", items: [{ item_id: "UC-001", revision_no: 2 }] }, task("不合规"));
    fireEvent.click(screen.getByTestId("card-confirm"));
    expect(h.onAction).not.toHaveBeenCalled();
    expect(await screen.findByText(/评审没有通过，你仍然可以标为看过/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("仍然标为看过"));
    expect(h.onAction).toHaveBeenCalledTimes(1);
  });

  it("请选择：点一个选项走 messages，文字是「我选：选项的文字」", () => {
    const h = card({ kind: "choose", text: "先整理哪一块？", options: [{ key: "a", text: "退货流程" }, { key: "b", text: "退款到账" }] });
    fireEvent.click(screen.getByTestId("card-option-b"));
    expect(h.onMessage).toHaveBeenCalledWith("我选：退款到账", { reply_message_id: "msg-7", kind: "choose", choice: "b" });
    // 选过之后照原型收起按钮与输入框，留一句「你选了…」
    expect(screen.queryByTestId("card-option-a")).toBeNull();
    expect(screen.getByText("✓ 你选了「退款到账」")).toBeInTheDocument();
  });

  it("给建议值：显示建议值与依据；「采纳」「换一个」都走 messages", () => {
    const act: Act = { kind: "suggest", text: "时限建议七天。", value: "七天", basis: [{ kind: "文档原文", locator: "inputs/a.md", excerpt: "七天内处理" }] };
    const h = card(act);
    expect(screen.getByText("七天")).toBeInTheDocument();
    expect(screen.getByText(/七天内处理/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("card-adopt"));
    expect(h.onMessage).toHaveBeenCalledWith(TEMPLATES.adopt, expect.objectContaining({ choice: "采纳" }));
    const h2 = card(act);
    fireEvent.click(screen.getByTestId("card-another")); // 第一张卡片采纳之后按钮已收起，只剩第二张的
    expect(h2.onMessage).toHaveBeenCalledWith(TEMPLATES.another, expect.objectContaining({ choice: "换一个" }));
  });

  it("提议：显示预览；「就这样做」「不要」走 messages", () => {
    const h = card({ kind: "propose", text: "合并两条。", preview: [{ effect: "remove", text: "删掉 CON-003" }, { effect: "add", text: "新增一条" }] });
    expect(screen.getByText(/删掉 CON-003/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("card-no"));
    expect(h.onMessage).toHaveBeenCalledWith(TEMPLATES.proposeNo, expect.objectContaining({ choice: "不要" }));
    expect(h.onAction).not.toHaveBeenCalled();
  });

  it("提问：没有按钮，只有输入框；输入框发出的话是普通的一句话，不带卡片标注", () => {
    const h = card({ kind: "ask", text: "退款由谁审批？" });
    expect(screen.queryByTestId("card-confirm")).toBeNull();
    expect(screen.queryByTestId("card-adopt")).toBeNull();
    fireEvent.change(screen.getByTestId("card-input"), { target: { value: "财务主管" } });
    fireEvent.keyDown(screen.getByTestId("card-input"), { key: "Enter", code: "Enter", keyCode: 13 });
    expect(h.onMessage).toHaveBeenCalledWith("财务主管");
  });
});

describe("提问挂在条目上", () => {
  const pendingTask = () => {
    const t = task();
    t.definition.collections[1].fields.push({ name: "建议的处理", type: "文本", required: false, values: null });
    t.items[1].fields["建议的处理"] = "先按七天写，请用户确认";
    return t;
  };

  it("卡片头部显示关联对象的上下文（问题条目另列建议的处理），点它打开条目", () => {
    const onOpenItem = vi.fn();
    const handlers = { onAction: vi.fn(), onMessage: vi.fn() };
    render(<Wrap><ReplyCard act={{ kind: "ask", text: "你们打算怎样处理？", items: [{ item_id: "TBD-001", revision_no: 1 }] }}
      replyMessageId="msg-8" task={pendingTask()} handlers={handlers} onOpenItem={onOpenItem} /></Wrap>);
    expect(screen.getByTestId("card-context-TBD-001")).toHaveTextContent("TBD-001退款时限修订 1");
    expect(screen.getByTestId("card-context")).toHaveTextContent("建议的处理先按七天写，请用户确认");
    fireEvent.click(screen.getByTestId("card-context-TBD-001"));
    expect(onOpenItem).toHaveBeenCalledWith("TBD-001");
  });

  it("「先不管这条」走 actions 的 keep_pending 并通知执行者；「我不知道，你按常识补」走 messages 的模板句", () => {
    const h = card({ kind: "ask", text: "你们打算怎样处理？", items: [{ item_id: "TBD-001", revision_no: 1 }] }, pendingTask());
    fireEvent.click(screen.getByText("先不管这条"));
    expect(h.onAction).toHaveBeenCalledWith(
      { kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }], notify_executor: true }, expect.any(String));
    const h2 = card({ kind: "ask", text: "你们打算怎样处理？", items: [{ item_id: "TBD-001", revision_no: 1 }] }, pendingTask());
    fireEvent.click(screen.getByTestId("card-dont-know")); // 第一张卡片点过「先不管这条」之后按钮已收起
    expect(h2.onMessage).toHaveBeenCalledWith("关于 TBD-001，我不知道，你按常识补上并标明是你补的。",
      { reply_message_id: "msg-7", kind: "ask", choice: "不知道" });
  });

  it("挂在功能用例上的提问没有「先不管这条」；scope 为 general 或没有挂条目的提问只有输入框", () => {
    card({ kind: "ask", text: "UC-001 的步骤够吗？", items: [{ item_id: "UC-001", revision_no: 2 }] });
    expect(screen.queryByText("先不管这条")).toBeNull();
    expect(screen.getByTestId("card-dont-know")).toBeInTheDocument();
    cleanup();
    card({ kind: "ask", text: "你们用哪种支付渠道？", scope: "general" });
    expect(screen.queryByTestId("card-dont-know")).toBeNull();
    expect(screen.queryByTestId("card-context")).toBeNull();
    expect(screen.getByTestId("card-input")).toBeInTheDocument();
  });
});

describe("直接操作被拒时的错误显示", () => {
  function detail(submit: (...args: unknown[]) => Promise<ApiError | null>, itemIndex = 0) {
    const t = task();
    const item = t.items[itemIndex];
    render(<Wrap><ItemDetail task={t} item={item} def={t.definition.collections.find((c) => c.name === item.collection)!}
      readOnly={false} pending={false} submit={submit as never} /></Wrap>);
  }

  it("两个页面同时编辑的安全网（stale_revision）：只提示「这条已被改到修订 N，请重新打开」，不提供合并，刚填的内容留在编辑框", async () => {
    const submit = vi.fn(async () => new ApiError("stale_revision", "服务端的话", 409,
      { items: [{ item_id: "UC-001", base_revision: 2, current_revision: 3, changed_by: "executor" }] }));
    detail(submit);
    fireEvent.click(screen.getByText("修改"));
    const input = screen.getAllByRole("textbox")[0];
    fireEvent.change(input, { target: { value: "买家申请部分退款" } });
    fireEvent.click(screen.getByTestId("save-fields"));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("这条已被改到修订 3，请重新打开。"));
    expect(screen.queryByTestId("redo-on-latest")).toBeNull();
    expect(screen.getAllByDisplayValue("买家申请部分退款").length).toBeGreaterThan(0); // 还在编辑框里
    expect(submit).toHaveBeenCalledWith(
      { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 2 }], fields: { 名称: "买家申请部分退款" }, notify_executor: false },
      expect.any(String));
  });

  it("编辑期间条目被改到新修订：保存仍用打开编辑时所在的修订作 base_revision，只提交自己改过的字段", async () => {
    const t = task();
    const def = t.definition.collections[0];
    const submit = vi.fn(async () => null);
    const view = (item: typeof t.items[0]) => <Wrap><ItemDetail task={t} item={item} def={def} readOnly={false} pending={false} submit={submit as never} latestRevision={3} /></Wrap>;
    const { rerender } = render(view(t.items[0]));
    fireEvent.click(screen.getByText("修改"));
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "买家申请部分退款" } });
    const r3 = { ...t.items[0], revision_no: 3, revisions: [1, 2, 3], fields: { 名称: "买家申请退款", 步骤: ["提交申请", "系统登记"] } };
    rerender(view(r3));
    expect(screen.getAllByDisplayValue("买家申请部分退款").length).toBeGreaterThan(0); // 刚填的内容还在
    expect(screen.getByText("保存后立刻生效，产生修订 4")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("save-fields"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(
      { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 2 }], fields: { 名称: "买家申请部分退款" }, notify_executor: false },
      expect.any(String)));
  });

  it("编辑时换到另一个条目：退出编辑，草稿不会被保存到新条目上", () => {
    const t = task();
    const def = t.definition.collections[0];
    const submit = vi.fn(async () => null);
    const other = { ...t.items[0], item_id: "UC-002", title: "卖家处理退款", fields: { 名称: "卖家处理退款", 步骤: ["审核"] } };
    const view = (item: typeof t.items[0]) => <Wrap><ItemDetail task={t} item={item} def={def} readOnly={false} pending={false} submit={submit as never} /></Wrap>;
    const { rerender } = render(view(t.items[0]));
    fireEvent.click(screen.getByText("修改"));
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "买家申请部分退款" } });
    rerender(view(other));
    expect(screen.queryByTestId("edit-form")).toBeNull();
    expect(screen.queryByDisplayValue("买家申请部分退款")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("工具核对不通过（rejected）：把后端给的原因显示在编辑处", async () => {
    const submit = vi.fn(async () => new ApiError("rejected", "这次修改没有保存：必填字段「名称」不能为空。", 422, { reasons: ["必填字段「名称」不能为空"] }));
    detail(submit);
    fireEvent.click(screen.getByText("修改"));
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "" } });
    fireEvent.click(screen.getByTestId("save-fields"));
    expect(await screen.findByText("这次修改没有保存：必填字段「名称」不能为空。")).toBeInTheDocument();
  });

  it("响应被接受时不改界面（等库事件），编辑框收起；超时给出第 6 节规则 1 的提示", async () => {
    const ok = vi.fn(async () => null);
    detail(ok);
    fireEvent.click(screen.getByText("修改"));
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "新名称" } });
    fireEvent.click(screen.getByTestId("save-fields"));
    await waitFor(() => expect(screen.queryByTestId("save-fields")).toBeNull());
    expect(screen.getByRole("heading", { name: "买家申请退款" })).toBeInTheDocument(); // 标题没有被乐观地改掉
  });

  it("「先不管」按取值「用户决定保留」认出适用的集合，走 keep_pending", async () => {
    const submit = vi.fn(async () => null);
    detail(submit, 1);
    fireEvent.click(screen.getByText("先不管，保留"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(
      { kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }], notify_executor: false }, expect.any(String)));
  });

  it("改字段随修订自动确认之后，没有确认按钮也没有撤回按钮，右下角只留状态，确认记录写明是改出来的", () => {
    const t = task();
    const edited = { ...t.items[0], revision_by: "user", confirmations: [{ revision_no: 2, accepted: true, basis: "ui_edit", at: "" }] };
    render(<Wrap><ItemDetail task={{ ...t, items: [edited, t.items[1]] }} item={edited} def={t.definition.collections[0]}
      readOnly={false} pending={false} submit={vi.fn(async () => null) as never} /></Wrap>);
    expect(screen.queryByTestId("detail-confirm")).toBeNull();
    expect(screen.queryByTestId("detail-unconfirm")).toBeNull();
    expect(screen.getByTestId("read-UC-001")).toHaveTextContent("已读 · 修订 2");
    expect(screen.getByTestId("confirmations")).toHaveTextContent("你在界面上改了它，改出来的内容算作你已确认");
  });

  it("超时显示「还没有得到确认」", async () => {
    detail(vi.fn(async () => new ApiError("timeout", "等了太久", 0)), 1);
    fireEvent.click(screen.getByText("先不管，保留"));
    expect(await screen.findByText("这次修改还没有得到确认，请稍后看是否已经生效。")).toBeInTheDocument();
  });
});

describe("文档区：新加的材料", () => {
  it("收到新材料后选中它并显示正文，不用刷新", async () => {
    const spy = vi.spyOn(api, "materialContent").mockImplementation(async (_t, path) => ({ path, text: `正文：${path}` }));
    const first = [{ path: "inputs/a.md", bytes: 1, modified_at: "" }];
    const { rerender } = render(<Wrap><MaterialPane taskId="TASK-001" materials={first} /></Wrap>);
    expect(await screen.findByText("正文：inputs/a.md")).toBeInTheDocument();
    const both = [...first, { path: "inputs/新材料.md", bytes: 2, modified_at: "" }];
    rerender(<Wrap><MaterialPane taskId="TASK-001" materials={both} focusPath="inputs/新材料.md" /></Wrap>);
    expect(await screen.findByText("正文：inputs/新材料.md")).toBeInTheDocument();
    expect(spy).toHaveBeenLastCalledWith("TASK-001", "inputs/新材料.md");
    spy.mockRestore();
  });
});

describe("助手回复的有限 Markdown", () => {
  it("开段落、列表、加粗、行内代码；标题与表格原样显示；尖括号当文字", () => {
    const { container } = render(<Markdown text={"整理好了 **3 个**用例：\n- UC-001 提交申请\n- 字段 `用例名称`\n\n## 下一步\n| 甲 | 乙 |\n<b>不是加粗</b>"} />);
    expect(container.querySelector("strong")?.textContent).toBe("3 个");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("用例名称");
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("## 下一步");
    expect(container.textContent).toContain("| 甲 | 乙 |");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>不是加粗</b>");
  });

  it("degraded 的回复照普通文字显示并加一行说明；用户消息不渲染", () => {
    const noop = () => {};
    render(<Wrap><Conversation
      messages={[
        { type: "user_message", message_id: "u1", at: "", text: "我说的 **不渲染**", origin: "typed", annotation: null, queued: false },
        { type: "assistant_reply", message_id: "r1", at: "", work_id: null, via_reply_tool: true, informs: [], act: null, text: "纯文字 **原样**", degraded: true },
      ]}
      currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
      handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
      hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} /></Wrap>);
    expect(screen.getByTestId("degraded-note")).toHaveTextContent("这条回复没有按结构发出。");
    expect(screen.getByText("纯文字 **原样**")).toBeInTheDocument();
    expect(screen.getByText("我说的 **不渲染**")).toBeInTheDocument();
    expect(document.querySelector("strong")).toBeNull();
  });
});

describe("框选原文与高亮联动、「让助手改这一条」", () => {
  it("原文里被引用的句子画线，点来源标签过来的那句高亮；选中一段后三个动作发出第 7 节的模板句", async () => {
    const spy = vi.spyOn(api, "materialContent").mockResolvedValue({ path: "inputs/a.md", text: "第一句话。买家七天内可以退货。最后一句。" });
    const onSend = vi.fn();
    const t = task();
    t.items[0].sources = [{ kind: "文档原文", locator: "inputs/a.md", excerpt: "买家七天内可以退货。" }];
    const materials = [{ path: "inputs/a.md", bytes: 1, modified_at: "" }];
    const { rerender } = render(<Wrap><MaterialPane taskId="TASK-001" materials={materials} items={t.items} currentItem="UC-001" onSend={onSend} /></Wrap>);
    await screen.findByTestId("paper");
    expect(document.querySelector(".cited")?.textContent).toBe("买家七天内可以退货。");
    rerender(<Wrap><MaterialPane taskId="TASK-001" materials={materials} items={t.items} currentItem="UC-001" onSend={onSend}
      locate={{ excerpt: "最后一句。", locator: "inputs/a.md", nonce: 1 }} /></Wrap>);
    await waitFor(() => expect(document.querySelector("mark.hit")?.textContent).toBe("最后一句。"));
    // 选中「第一句话」：jsdom 里用 getSelection 的替身
    const paper = screen.getByTestId("paper");
    const sel = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "第一句话", anchorNode: paper.firstChild, removeAllRanges: () => {} } as unknown as Selection);
    fireEvent.mouseUp(paper);
    fireEvent.click(await screen.findByText("据此新建条目"));
    expect(onSend).toHaveBeenLastCalledWith("请根据材料 inputs/a.md 里的这段原文新建条目：「第一句话」");
    fireEvent.mouseUp(paper);
    fireEvent.click(screen.getByText("补到当前条目（UC-001）"));
    expect(onSend).toHaveBeenLastCalledWith("请把材料 inputs/a.md 里的这段原文补到 UC-001：「第一句话」");
    fireEvent.mouseUp(paper);
    fireEvent.click(screen.getByText("就这段提问"));
    fireEvent.change(screen.getByTestId("selection-question"), { target: { value: "七天从哪天算？" } });
    fireEvent.keyDown(screen.getByTestId("selection-question"), { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("关于材料 inputs/a.md 里的这段原文：「第一句话」，七天从哪天算？");
    sel.mockRestore();
    spy.mockRestore();
  });

  it("摘录把不相邻的几句用空行拼在一起时逐段高亮并滚到第一段；某段漏了字时退到前 12 个字；被引用的底线用同一套找法", async () => {
    const text = "第一段：买家在收货后七天内可以申请退货，超过七天不受理。\n\n中间一段无关的话。\n\n第三段：卖家在两个工作日内审核退货申请。";
    const spy = vi.spyOn(api, "materialContent").mockResolvedValue({ path: "inputs/a.md", text });
    const t = task();
    const joined = "买家在收货后七天内可以申请退货，超过七天不受理。\n\n卖家在两个工作日内审核退货申请。";
    t.items[0].sources = [{ kind: "文档原文", locator: "inputs/a.md", excerpt: joined }];
    const materials = [{ path: "inputs/a.md", bytes: 1, modified_at: "" }];
    const { rerender } = render(<Wrap><MaterialPane taskId="TASK-001" materials={materials} items={t.items} /></Wrap>);
    await screen.findByTestId("paper");
    expect([...document.querySelectorAll(".cited")].map((e) => e.textContent)).toEqual(
      ["买家在收货后七天内可以申请退货，超过七天不受理。", "卖家在两个工作日内审核退货申请。"]);
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    rerender(<Wrap><MaterialPane taskId="TASK-001" materials={materials} items={t.items}
      locate={{ excerpt: joined, locator: "inputs/a.md", nonce: 1 }} /></Wrap>);
    await waitFor(() => expect([...document.querySelectorAll("mark.hit")].map((e) => e.textContent)).toEqual(
      ["买家在收货后七天内可以申请退货，超过七天不受理。", "卖家在两个工作日内审核退货申请。"]));
    expect(scrolled.mock.contexts[0]).toBe(document.querySelector("mark.hit"));
    // 漏了一个字：逐字找不到，退到这一段的前 12 个字。
    rerender(<Wrap><MaterialPane taskId="TASK-001" materials={materials} items={t.items}
      locate={{ excerpt: "卖家在两个工作日内审核退货申。", locator: "inputs/a.md", nonce: 2 }} /></Wrap>);
    await waitFor(() => expect(document.querySelector("mark.hit")?.textContent).toBe("卖家在两个工作日内审核退"));
    expect(screen.queryByTestId("locate-miss")).toBeNull();
    spy.mockRestore();
  });

  it("一段都找不到时仍切到那份材料，顶部提示「没有在材料里找到这段原文」，2 秒后消失", async () => {
    const spy = vi.spyOn(api, "materialContent").mockImplementation(async (_t, path) => ({ path, text: path === "inputs/b.md" ? "乙材料的正文。" : "甲材料的正文。" }));
    const materials = [{ path: "inputs/a.md", bytes: 1, modified_at: "" }, { path: "inputs/b.md", bytes: 1, modified_at: "" }];
    const { rerender } = render(<Wrap><MaterialPane taskId="TASK-001" materials={materials} /></Wrap>);
    expect(await screen.findByText("甲材料的正文。")).toBeInTheDocument();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rerender(<Wrap><MaterialPane taskId="TASK-001" materials={materials} locate={{ excerpt: "材料里没有的话", locator: "inputs/b.md", nonce: 1 }} /></Wrap>);
    expect(await screen.findByText("乙材料的正文。")).toBeInTheDocument();
    expect(await screen.findByTestId("locate-miss")).toHaveTextContent("没有在材料里找到这段原文");
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => expect(screen.queryByTestId("locate-miss")).toBeNull());
    vi.useRealTimers();
    spy.mockRestore();
  });

  it("详情里「让助手来改这一条」交出条目编号，页面据此预填「请修改 {条目编号}：」；问题条目没有这个入口", () => {
    const onAsk = vi.fn();
    const t = task();
    render(<Wrap><ItemDetail task={t} item={t.items[0]} def={t.definition.collections[0]} readOnly={false} pending={false}
      submit={vi.fn(async () => null)} onAskAssistant={onAsk} /></Wrap>);
    fireEvent.click(screen.getByTestId("ask-assistant"));
    expect(onAsk).toHaveBeenCalledWith("UC-001");
    expect(PREFILL.revise("UC-001")).toBe("请修改 UC-001：");
    cleanup();
    render(<Wrap><ItemDetail task={t} item={t.items[1]} def={t.definition.collections[1]} readOnly={false} pending={false}
      submit={vi.fn(async () => null)} onAskAssistant={onAsk} /></Wrap>);
    expect(screen.queryByTestId("ask-assistant")).toBeNull();
  });
});
