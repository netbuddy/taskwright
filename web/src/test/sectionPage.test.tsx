// 业务说明的一节（一页主题）：面包屑（第几章 › 节号）、标题、一行小字、标签与待核实；
// 各块（说明、异常分支、示例、适用规则、待澄清事项）有内容才画；材料原句与助手补的字句各有标注，出处写在每一处下面；
// 待澄清的问题可以在这里回答或者暂不处理；上一条、下一条照目录的次序；「看修订与全部来源」换成条目详情的样子，再回到这一节。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ToastProvider } from "../components/Toasts";
import { change, overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
Element.prototype.scrollTo ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);
type Spies = { submit?: ReturnType<typeof vi.fn>; send?: ReturnType<typeof vi.fn>; answer?: ReturnType<typeof vi.fn>; locate?: ReturnType<typeof vi.fn>; prefill?: ReturnType<typeof vi.fn> };
function Panel({ t, first = "OA-003", readOnly = false, writesOff = false, spies = {} }: { t: Task; first?: string | null; readOnly?: boolean; writesOff?: boolean; spies?: Spies }) {
  const [selected, setSelected] = useState<string | null>(first);
  return (
    <Wrap><div className="app">
      <ItemsPanel task={t} initialCollection="业务说明" readOnly={readOnly} writesOff={writesOff} recentlyChanged={[]} pendingItems={new Set()}
        selected={selected} onSelect={setSelected} submit={(spies.submit ?? vi.fn(async () => null)) as never} onGenerateDoc={() => {}}
        onSend={spies.send as never} onAnswer={spies.answer as never} onLocate={spies.locate as never} onPrefill={spies.prefill as never} />
    </div></Wrap>
  );
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("节的顶部", () => {
  it("面包屑是第几章与节号；标题里不写页的编号，编号在悬停说明里", () => {
    render(<Panel t={overallTask()} first="OA-004" />);
    expect(text(screen.getByTestId("topic-crumb"))).toContain("1 概述与范围›1.1");
    expect(text(screen.getByTestId("topic-title"))).toBe("闭馆日怎么算");
    expect(screen.getByTestId("topic-title").getAttribute("title")).toBe("OA-004");
    fireEvent.click(screen.getByTestId("toc-OA-003"));
    expect(text(screen.getByTestId("topic-crumb"))).toContain("3 业务流程›3.3");
    expect(text(screen.getByTestId("topic-title"))).toBe("预约取书");
  });

  it("一行小字：材料几处、澄清几条、你看过；后面是标签与几处待核实", () => {
    render(<Panel t={overallTask()} first="OA-002" />);
    expect(text(screen.getByTestId("topic-lead"))).toBe("材料 2 处 · 澄清 2 条 · 你看过");
    fireEvent.click(screen.getByTestId("toc-OA-003"));
    // 这一页用户看过的是早先的修订，现在的内容还没有看过：不写「你看过」。
    expect(text(screen.getByTestId("topic-lead"))).toBe("材料 1 处 · 澄清 2 条");
    const meta = screen.getByTestId("topic-meta");
    expect([...meta.querySelectorAll(".oa-tag:not(.add)")].map((one) => one.textContent)).toEqual(["概念", "流程"]);
    expect(screen.getByTestId("topic-add-label")).toHaveTextContent("＋ 标签");
    expect(screen.getByTestId("topic-pending")).toHaveTextContent("1 处待核实");
  });

  it("没有贴标签的页：面包屑写「未归类」，顶上一句说明，标签那里也写「未归类」；不待核实的页不写待核实", () => {
    render(<Panel t={overallTask()} first="OA-008" />);
    expect(text(screen.getByTestId("topic-crumb"))).toContain("未归类");
    expect(screen.getByTestId("topic-unsorted")).toHaveTextContent("这一节还没有归类，贴上标签之后会排进相应的章。");
    expect([...screen.getByTestId("topic-meta").querySelectorAll(".oa-tag:not(.add)")].map((one) => one.textContent)).toEqual(["未归类"]);
    expect(screen.queryByTestId("topic-pending")).toBeNull();
    expect(text(screen.getByTestId("topic-lead"))).toBe("澄清 1 条");
  });

  it("上一条、下一条照目录从上到下的次序；第一节没有上一条，最后一页没有下一条；回到目录", () => {
    // 目录的第一节是第 1 章的「闭馆日怎么算」，然后是第 2 章的两个角色，再是第 3 章。
    render(<Panel t={overallTask()} first="OA-004" />);
    expect(screen.getByTestId("topic-prev")).toBeDisabled();
    fireEvent.click(screen.getByTestId("topic-next"));
    expect(text(screen.getByTestId("topic-title"))).toBe("读者");
    fireEvent.click(screen.getByTestId("topic-next"));
    fireEvent.click(screen.getByTestId("topic-next"));
    expect(text(screen.getByTestId("topic-title"))).toBe("借阅");
    fireEvent.click(screen.getByTestId("topic-prev"));
    expect(text(screen.getByTestId("topic-title"))).toBe("馆员");
    fireEvent.click(screen.getByTestId("toc-OA-011"));
    expect(screen.getByTestId("topic-next")).toBeDisabled();
    fireEvent.click(screen.getByTestId("topic-back"));
    expect(screen.queryByTestId("topic-page")).toBeNull();
    expect(screen.getByTestId("overall-intro")).toBeInTheDocument();
  });
});

describe("节的各块", () => {
  it("它是什么：一段一段画出来，助手补的那几个字标出来，块尾写来源", () => {
    render(<Panel t={overallTask()} />);
    const what = screen.getByTestId("topic-what");
    expect(what.querySelectorAll(".oa-prose p").length).toBe(2);
    expect([...what.querySelectorAll(".oa-hl")].map((h) => h.textContent)).toEqual(["保留期是 3 天"]);
    expect(what.querySelector(".oa-prose")).not.toHaveClass("pending");
    const sources = [...what.querySelectorAll(".oa-src .one")];
    expect(sources.map((s) => s.textContent)).toEqual([
      // 原话长的截到 36 个字。
      "你说的「读者可以预约在架上的书，馆员先帮他拿下来放到预留架，过期不取就让给下一位…」",
      "助手补的 · 理由：「保留期是 3 天」是按高校图书馆常见做法补的，你只说了「留几天」，没有说几天。",
    ]);
    expect(sources[1]).toHaveClass("v");
  });

  it("它是什么：助手补充写了 inserted 时只标 inserted 里的字，理由里用引号引的别的词不标", () => {
    const t = change(overallTask(), "OA-003", (item) => {
      const one = item.sources.find((s) => s.kind === "助手补充")!;
      one.excerpt = "按高校图书馆常见做法补的；材料里只说「预留架」。";
      one.supports = [{ field: "它是什么", index: null, inserted: ["保留期是 3 天"] }, ...(one.supports ?? []).slice(1)];
    });
    render(<Panel t={t} />);
    const what = screen.getByTestId("topic-what");
    expect(what.textContent).toContain("预留架");
    expect([...what.querySelectorAll(".oa-hl")].map((h) => h.textContent)).toEqual(["保留期是 3 天"]);
  });

  it("说明：逐字出自材料的句子用底色标出，点它在右边的材料里看原文；支持整页的来源也列在来源那一行；正文里找不到的不标", () => {
    const locate = vi.fn();
    // OA-002 的「它是什么」里没有材料的原话（材料写的是「办理」，页里写的是「办」）：不标，来源照列。
    render(<Panel t={overallTask()} first="OA-002" spies={{ locate }} />);
    expect(screen.getByTestId("topic-what").querySelectorAll(".oa-qt").length).toBe(0);
    expect([...screen.getByTestId("topic-what").querySelectorAll(".oa-src .one")].map((s) => s.textContent)).toEqual(["材料 借阅规则.md「借书和还书都可以在自助借还机上办理，也可以到服务台办理。」"]);
    cleanup();
    // 把页里那半句改成与材料一字不差，再加一条支持整页的材料来源：两句都标出来，点一句定位到它自己的出处。
    const t = change(overallTask(), "OA-002", (p) => {
      p.fields["它是什么"] = "读者拿着书和借书证办理借还。借书和还书都可以在自助借还机上办理，也可以到服务台办理。借期都是 30 天。";
      p.sources.push({ kind: "文档原文", locator: "inputs/规定.md", excerpt: " 借期都是 30 天 ", supports: [] });
    });
    render(<Panel t={t} first="OA-002" spies={{ locate }} />);
    const quotes = [...screen.getByTestId("topic-what").querySelectorAll(".oa-qt")];
    expect(quotes.map((q) => q.textContent)).toEqual(["借书和还书都可以在自助借还机上办理，也可以到服务台办理。", "借期都是 30 天"]);
    fireEvent.click(quotes[1]);
    expect(locate).toHaveBeenCalledWith(" 借期都是 30 天 ", "inputs/规定.md");
    expect([...screen.getByTestId("topic-what").querySelectorAll(".oa-src .one")].map((s) => s.textContent)[1]).toBe("材料 规定.md「 借期都是 30 天 」");
  });

  it("它是什么：理由没有引原文、标不出是哪几个字时，整块旁边画一道边；确认之后都不标", () => {
    const t = overallTask();
    render(<Panel t={t} first="OA-005" />);
    const what = screen.getByTestId("topic-what");
    // OA-005 的理由引的「过了应还日期还没有归还就是逾期」在正文里找得到，所以标的是字。
    expect([...what.querySelectorAll(".oa-hl")].map((h) => h.textContent)).toEqual(["过了应还日期还没有归还就是逾期"]);
    cleanup();
    render(<Panel t={change(overallTask(), "OA-005", (p) => { p.sources[1].excerpt = "这一句是我按字面补的。"; })} first="OA-005" />);
    expect(screen.getByTestId("topic-what").querySelectorAll(".oa-hl").length).toBe(0);
    expect(screen.getByTestId("topic-what").querySelector(".oa-prose")).toHaveClass("pending");
    cleanup();
    render(<Panel t={change(overallTask(), "OA-003", (p) => { p.pending_verification = false; p.pending_sources = 0; })} />);
    expect(screen.getByTestId("topic-what").querySelectorAll(".oa-hl").length).toBe(0);
    expect(screen.getByTestId("topic-what").querySelector(".oa-prose")).not.toHaveClass("pending");
  });

  it("示例：一条一张卡片，反例是灰色卡片、写「这种不算」，正文里不带「反例：」", () => {
    render(<Panel t={overallTask()} />);
    expect(screen.getByTestId("topic-examples").querySelector("h3")).toHaveTextContent("示例");
    const first = screen.getByTestId("topic-example-0");
    const second = screen.getByTestId("topic-example-1");
    expect(first).not.toHaveClass("neg");
    expect(first.querySelector(".k")).toBeNull();
    expect(second).toHaveClass("neg");
    expect(second.querySelector(".k")).toHaveTextContent("这种不算");
    expect(second.querySelector("p")!.textContent).toBe("小李想借的《深入理解计算机系统》还在别人手上，他登记的是排队等书，不是预约取书。");
  });

  it("异常分支：以「例外：」开头的例子各一张小卡，正文里不带「例外：」，写出处；流程节末尾有「＋ 补一种例外」，点了进到修改", () => {
    const t = change(overallTask(), "OA-003", (p) => { (p.fields["例子"] as string[]).push("例外：读者的借书证过期了，不能预约。"); p.sources[2].supports!.push({ field: "例子", index: 2 }); });
    render(<Panel t={t} />);
    const block = screen.getByTestId("topic-exceptions");
    expect(block.querySelector("h3")).toHaveTextContent("异常分支");
    const card = within(block).getByTestId("topic-example-2");
    expect(card).toHaveClass("exc");
    expect(card.querySelector("p")!.textContent).toBe("读者的借书证过期了，不能预约。");
    expect(card.querySelector(".oa-src")).toHaveTextContent("你说的「有人预约的书不能续借。」");
    // 例外不再出现在示例里；平常的例子与反例还在。
    expect([...screen.getByTestId("topic-examples").querySelectorAll(".oa-card")].length).toBe(2);
    // 块的次序：说明、异常分支、示例、适用规则、待澄清事项，然后是相关角色与对象、对应的需求条目。
    expect([...screen.getByTestId("topic-page").querySelectorAll(".oa-blk > h3")].map((h) => h.firstChild!.textContent!.trim()))
      .toEqual(["说明", "异常分支", "示例", "适用规则", "待澄清事项", "相关角色与对象", "对应的需求条目"]);
    fireEvent.click(screen.getByTestId("topic-add-exception"));
    expect(screen.getByTestId("topic-edit")).toBeInTheDocument();
  });

  it("异常分支：流程节没有例外时这一块也在，只有「＋ 补一种例外」；不是流程的节没有例外时没有这一块", () => {
    render(<Panel t={overallTask()} first="OA-006" />);
    expect(screen.getByTestId("topic-exceptions").querySelectorAll(".oa-card.exc").length).toBe(0);
    expect(screen.getByTestId("topic-add-exception")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toc-OA-010"));
    expect(screen.queryByTestId("topic-exceptions")).toBeNull();
  });

  it("适用规则：规则表里标了冲突的那一条写明与哪一节的规则冲突，点节名打开那一节；对不上另一条时只说有冲突", () => {
    const row = (item_id: string, index: number, conflicts: string[]) => ({ item_id, title: "", index, text: "", sources: [], conflicts });
    const t = overallTask({ overall_views: {
      rules: { rows: [row("OA-003", 2, ["TBD-009"]), row("OA-006", 0, ["TBD-009"]), row("OA-003", 3, ["TBD-010"]), row("OA-003", 0, [])], conflicts: ["TBD-009", "TBD-010"], unmatched: [] },
      goals: { roots: [], loose: [] }, decisions: [],
    } });
    render(<Panel t={t} />);
    expect(screen.getByTestId("topic-settled-2")).toHaveClass("conflict");
    expect(text(screen.getByTestId("topic-conflict-2"))).toBe("与 3.4 续借 的一条规则冲突，已记为待澄清");
    expect(text(screen.getByTestId("topic-conflict-3"))).toBe("这条规则有冲突，已记为待澄清");
    expect(screen.queryByTestId("topic-conflict-0")).toBeNull();
    expect(screen.getByTestId("topic-settled-0")).not.toHaveClass("conflict");
    fireEvent.click(within(screen.getByTestId("topic-conflict-2")).getByRole("button"));
    expect(text(screen.getByTestId("topic-title"))).toBe("续借");
  });

  it("已经定下的：一句一条，每条下面是出处；助手补的那一条前面是琥珀点", () => {
    render(<Panel t={overallTask()} />);
    const rules = [...screen.getByTestId("topic-settled").querySelectorAll(".oa-rules li")];
    expect(rules.length).toBe(4);
    expect(rules.map((li) => li.classList.contains("pending"))).toEqual([false, false, false, true]);
    expect(text(rules[1].querySelector(".t"))).toBe("一本书同一时间只能被一个人预约。材料 借阅规则.md「同一册图书同一时间只接受一位读者的预约。」");
    expect(rules[3].querySelector(".oa-src .one")).toHaveClass("v");
  });

  it("确认过之后，助手补的那几处的出处不再是琥珀字，写明「你确认过」；理由仍在", () => {
    render(<Panel t={change(overallTask(), "OA-003", (p) => { p.pending_verification = false; p.pending_sources = 0; p.pending_places = []; })} />);
    const line = screen.getByTestId("topic-settled-3").querySelector(".oa-src .one")!;
    expect(line).not.toHaveClass("v");
    expect(line.textContent).toBe("助手补的，你确认过 · 理由：「保留期是 3 天」是按高校图书馆常见做法补的，你只说了「留几天」，没有说几天。");
    expect(screen.getByTestId("topic-settled-3")).not.toHaveClass("pending");
    expect(screen.getByTestId("topic-what").querySelector(".oa-src .one.v")).toBeNull();
  });

  it("出处是材料原文时点一下去右边的材料里看那句原文", () => {
    const locate = vi.fn();
    render(<Panel t={overallTask()} spies={{ locate }} />);
    fireEvent.click(within(screen.getByTestId("topic-settled-1")).getByText(/^材料 借阅规则\.md/));
    expect(locate).toHaveBeenCalledWith("同一册图书同一时间只接受一位读者的预约。", "inputs/借阅规则.md");
  });

  it("待澄清事项：挂在这一页上还没有了结的问题，带需要它的原因；问题的编号不写在正文里；写了回答点「记下」发给助手", () => {
    const send = vi.fn();
    render(<Panel t={overallTask()} spies={{ send }} />);
    const q = screen.getByTestId("topic-question-TBD-001");
    expect(screen.getByTestId("topic-open").querySelector("h3")).toHaveTextContent("待澄清事项");
    expect(text(q.querySelector(".q"))).toBe("保留的 3 天里遇到闭馆日，算不算在内？");
    expect(q.querySelector(".why")).toHaveTextContent("需要它的原因：小王周六预约、周一到架，如果周日闭馆而且算在 3 天里，他周二来取就只剩一天了。");
    fireEvent.change(within(q).getByLabelText("回答 TBD-001"), { target: { value: " 闭馆日不算，顺延 " } });
    fireEvent.click(screen.getByTestId("topic-answer-TBD-001"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("TBD-001");
    expect(send.mock.calls[0][0]).toContain("闭馆日不算，顺延");
    expect(within(q).getByLabelText("回答 TBD-001")).toHaveValue("");
  });

  it("待澄清事项：每个问题挂「阻断下游」或「不阻断」，阻断下游的排前面；不阻断的写何时回看；了结的列在下面，写落实到了哪里", () => {
    const task = overallTask();
    // 任务的定义里问题集合有这三个字段（新建的任务都有）。
    const def = task.definition.collections.find((c) => c.name === "问题")!;
    def.fields.push({ name: "是否阻断下游", type: "枚举", required: true, values: ["阻断下游", "不阻断"] } as never,
      { name: "何时回看", type: "文本", required: false } as never, { name: "落实到", type: "文本", required: false } as never);
    const first = task.items.find((one) => one.item_id === "TBD-001")!;
    const more = (id: string, title: string, fields: Record<string, unknown>) => ({ ...structuredClone(first), item_id: id, title, fields: { ...first.fields, 事项: title, ...fields } });
    first.fields = { ...first.fields, 是否阻断下游: "不阻断", 何时回看: "评审确认时" };
    task.items.push(more("TBD-020", "逾期的读者能不能预约？", { 是否阻断下游: "阻断下游", 何时回看: "写了也不显示" }) as never,
      more("TBD-021", "保留期满之后怎么办？", { 是否阻断下游: "阻断下游", 状态: "已解决", 处理结果: "期满自动取消", 落实到: "OA-001 已经定下的第 4 条" }) as never,
      more("TBD-022", "要不要短信通知？", { 状态: "已解决" }) as never);
    render(<Panel t={task} />);
    const open = [...screen.getByTestId("topic-open").querySelectorAll(".oa-open > li")].map((li) => li.getAttribute("data-testid"));
    expect(open).toEqual(["topic-question-TBD-020", "topic-question-TBD-001"]);
    expect(screen.getByTestId("topic-blocking-TBD-020")).toHaveTextContent(/^阻断下游$/);
    expect(screen.getByTestId("topic-blocking-TBD-020")).toHaveClass("block");
    expect(screen.getByTestId("topic-blocking-TBD-001")).toHaveTextContent(/^不阻断$/);
    expect(screen.getByTestId("topic-revisit-TBD-001")).toHaveTextContent("何时回看：评审确认时");
    expect(screen.queryByTestId("topic-revisit-TBD-020")).toBeNull();
    // 需要它的原因照旧取「建议的处理」，不会取成何时回看。
    expect(screen.getByTestId("topic-question-TBD-001").querySelector(".why")).toHaveTextContent(/^需要它的原因：小王周六预约/);
    // 已经了结的两个：一个写了落实到哪里，一个没有写。
    expect([...screen.getByTestId("topic-closed").querySelectorAll("li")].map((li) => text(li))).toEqual(
      ["已了结保留期满之后怎么办？落实到：OA-001 已经定下的第 4 条", "已了结要不要短信通知？"]);
    expect(screen.queryByTestId("topic-landed-TBD-022")).toBeNull();
  });

  it("待澄清事项：早先的任务（定义里没有「是否阻断下游」）不挂那枚标签；只剩已了结的问题时这一块只列它们", () => {
    const task = overallTask();
    render(<Panel t={task} />);
    expect(screen.queryByTestId("topic-blocking-TBD-001")).toBeNull();
    cleanup();
    const solved = change(overallTask(), "TBD-001", (item) => { item.fields = { ...item.fields, 状态: "已解决", 落实到: "OA-001 的例子" }; });
    render(<Panel t={solved} />);
    expect(screen.queryByTestId("topic-question-TBD-001")).toBeNull();
    expect(screen.getByTestId("topic-closed-TBD-001")).toHaveTextContent("落实到：OA-001 的例子");
    expect(screen.getByTestId("topic-open").querySelector("h3 small")).toBeNull();
  });

  it("待澄清事项：回答框空着点「记下」只把开头填进对话区的输入框；「暂不处理」把问题标为暂不处理", () => {
    const send = vi.fn();
    const answer = vi.fn();
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} spies={{ send, answer, submit }} />);
    fireEvent.click(screen.getByTestId("topic-answer-TBD-001"));
    expect(send).not.toHaveBeenCalled();
    expect(answer.mock.calls[0][0].item_id).toBe("TBD-001");
    expect(screen.getByTestId("topic-keep-TBD-001")).toHaveTextContent("暂不处理");
    fireEvent.click(screen.getByTestId("topic-keep-TBD-001"));
    expect(submit).toHaveBeenCalledWith({ kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }], notify_executor: false }, "把 TBD-001 标为暂不处理");
  });

  it("助手工作中、任务结束后，回答与暂不处理都不能点", () => {
    render(<Panel t={overallTask()} writesOff />);
    expect(screen.getByTestId("topic-answer-TBD-001")).toBeDisabled();
    expect(screen.getByTestId("topic-keep-TBD-001")).toBeDisabled();
    expect(screen.getByLabelText("回答 TBD-001")).toBeDisabled();
  });

  it("没有内容的块不显示：只有说明的页只画说明这一块", () => {
    render(<Panel t={overallTask()} first="OA-011" />);
    expect([...screen.getByTestId("topic-page").querySelectorAll(".oa-blk > h3")].map((h) => h.textContent)).toEqual(["说明"]);
    for (const id of ["topic-exceptions", "topic-examples", "topic-settled", "topic-open"]) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId("topic-what").querySelectorAll(".oa-prose p").length).toBe(1);
  });
});

describe("确认待核实", () => {
  it("待核实的页顶部有「确认待核实的 N 处」，点了在这一页现在的修订上记一条已读；助手工作中也能点", () => {
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} writesOff spies={{ submit }} />);
    const button = screen.getByTestId("topic-confirm");
    expect(button).toHaveTextContent("确认待核实的 1 处");
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledWith({ kind: "mark_viewed", targets: [{ item_id: "OA-003", base_revision: 12 }], notify_executor: false }, "确认 OA-003 待核实的 1 处");
  });

  it("不待核实的页没有这个按钮；任务不能写时按钮是灰的", () => {
    render(<Panel t={overallTask()} first="OA-002" />);
    expect(screen.queryByTestId("topic-confirm")).toBeNull();
    cleanup();
    render(<Panel t={overallTask()} readOnly />);
    expect(screen.getByTestId("topic-confirm")).toBeDisabled();
  });

  it("整页只有一处待核实时，助手补的那一条旁边有「对」，点了等于确认；多于一处时那里没有「对」，统一用顶部的按钮", () => {
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} spies={{ submit }} />);
    fireEvent.click(screen.getByTestId("topic-settled-ok-3"));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "mark_viewed", targets: [{ item_id: "OA-003", base_revision: 12 }] }), expect.any(String));
    expect(screen.queryByTestId("topic-settled-ok-0")).toBeNull();
    cleanup();
    render(<Panel t={change(overallTask(), "OA-003", (p) => { p.pending_sources = 2; })} />);
    expect(screen.getByTestId("topic-confirm")).toHaveTextContent("确认待核实的 2 处");
    expect(screen.queryByTestId("topic-settled-ok-3")).toBeNull();
  });
});

describe("修改与贴标签", () => {
  const field = (name: string) => screen.getByTestId("topic-edit").querySelector(`[data-f="${name}"]`)!;

  it("点「修改」四块换成一张表，各个字段都能改；没有改动时「保存」是灰的；保存只带改过的字段，作为直接修改发出去", async () => {
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} spies={{ submit }} />);
    fireEvent.click(screen.getByTestId("topic-edit-open"));
    expect(screen.queryByTestId("topic-what")).toBeNull();
    expect([...screen.getByTestId("topic-edit").querySelectorAll(".fld .k")].map((k) => k.textContent!.replace(" *", "")))
      .toEqual(["标题", "别名", "它是什么", "例子", "已经定下的", "标签", "上级主题", "状态", "改看"]);
    expect(screen.getByTestId("topic-save")).toBeDisabled();
    // 已经定下的逐项编辑：四条各一个框。
    const settled = [...field("已经定下的").querySelectorAll("textarea")] as HTMLTextAreaElement[];
    expect(settled.map((t) => t.value)).toEqual(["只有在架的书才能预约取书。", "一本书同一时间只能被一个人预约。", "保留期内这本书不能被别人借走，也不能续借给原借阅人。", "保留期是 3 天。"]);
    fireEvent.change(settled[3], { target: { value: "保留期是 5 天。" } });
    fireEvent.change(field("标题").querySelector("textarea")!, { target: { value: "预约取书 " } });
    expect(screen.getByTestId("topic-save")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("topic-save"));
    expect(submit).toHaveBeenCalledWith({
      kind: "edit_fields", targets: [{ item_id: "OA-003", base_revision: 12 }], notify_executor: false,
      fields: { 标题: "预约取书 ", 已经定下的: ["只有在架的书才能预约取书。", "一本书同一时间只能被一个人预约。", "保留期内这本书不能被别人借走，也不能续借给原借阅人。", "保留期是 5 天。"] },
    }, "修改 OA-003 的标题、已经定下的");
    // 保存成了：回到主题页（内容等库事件到了才变）。
    expect(await screen.findByTestId("topic-what")).toBeInTheDocument();
  });

  it("每条已定右边的小字操作不借用对话区卡片的类名（否则会带上卡片的底色）", () => {
    render(<Panel t={overallTask()} />);
    expect(screen.getByTestId("topic-page").querySelector(".act")).toBeNull();
    expect(screen.getByTestId("topic-settled-edit-0").parentElement).toHaveClass("oa-ract");
  });

  it("取消回到主题页，什么都不发；每条已定旁边的「改」也进到修改", () => {
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} spies={{ submit }} />);
    fireEvent.click(screen.getByTestId("topic-settled-edit-0"));
    expect(screen.getByTestId("topic-edit")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("topic-cancel"));
    expect(screen.getByTestId("topic-what")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("修改里的「标签」是一组可以多选的小标签，取值来自任务定义", () => {
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} spies={{ submit }} />);
    fireEvent.click(screen.getByTestId("topic-edit-open"));
    const chips = [...field("标签").querySelectorAll(".sw-pick .chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["概念", "角色", "流程", "场景", "目标", "范围", "假设", "决定"]);
    expect(chips.filter((c) => c.getAttribute("aria-checked") === "true").map((c) => c.textContent)).toEqual(["概念", "流程"]);
    fireEvent.click(screen.getByTestId("pick-标签-流程"));
    fireEvent.click(screen.getByTestId("topic-save"));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "edit_fields", fields: { 标签: ["概念"] } }), "修改 OA-003 的标签");
  });

  it("「＋ 标签」在标题下面打开一行小标签，选好点保存：只改标签这一个字段，次序照任务定义里取值的先后", async () => {
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} first="OA-008" spies={{ submit }} />);
    expect(screen.queryByTestId("topic-label-pick")).toBeNull();
    fireEvent.click(screen.getByTestId("topic-add-label"));
    expect(screen.getByTestId("topic-label-save")).toBeDisabled(); // 还没有改动
    fireEvent.click(screen.getByTestId("pick-标签-假设"));
    fireEvent.click(screen.getByTestId("pick-标签-概念"));
    fireEvent.click(screen.getByTestId("topic-label-save"));
    expect(submit).toHaveBeenCalledWith(
      { kind: "edit_fields", targets: [{ item_id: "OA-008", base_revision: 1 }], fields: { 标签: ["概念", "假设"] }, notify_executor: false }, "修改 OA-008 的标签");
    await vi.waitFor(() => expect(screen.queryByTestId("topic-label-pick")).toBeNull());
  });

  it("助手工作中、任务不能写时，「修改」「＋ 标签」「改」都是灰的", () => {
    render(<Panel t={overallTask()} writesOff />);
    expect(screen.getByTestId("topic-edit-open")).toBeDisabled();
    expect(screen.getByTestId("topic-add-label")).toBeDisabled();
    expect(screen.getByTestId("topic-settled-edit-0")).toBeDisabled();
  });

  it("被后端拒绝时留在修改里，改的东西还在", async () => {
    const { ApiError } = await import("../api/client");
    const submit = vi.fn(async () => new ApiError("stale_revision", "修订过期"));
    render(<Panel t={overallTask()} spies={{ submit }} />);
    fireEvent.click(screen.getByTestId("topic-edit-open"));
    fireEvent.change(field("它是什么").querySelector("textarea")!, { target: { value: "改过的说明。" } });
    fireEvent.click(screen.getByTestId("topic-save"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("topic-edit")).toBeInTheDocument();
    expect((field("它是什么").querySelector("textarea") as HTMLTextAreaElement).value).toBe("改过的说明。");
  });
});

describe("底部的动作与复述", () => {
  it("底部一排是「修改」「让助手照这条改条目」「标为已废弃」「复述一遍」", () => {
    render(<Panel t={overallTask()} />);
    expect([...screen.getByTestId("topic-actions").querySelectorAll("button")].map((b) => b.textContent)).toEqual(["修改", "让助手照这条改条目", "标为已废弃", "复述一遍"]);
    fireEvent.click(screen.getByTestId("topic-edit-bottom"));
    expect(screen.getByTestId("topic-edit")).toBeInTheDocument();
  });

  it("「复述一遍」把一句固定的话发给助手：讲这一页与它下面的主题", () => {
    const send = vi.fn();
    render(<Panel t={overallTask()} spies={{ send }} />);
    // 悬停提示说清点了之后会怎样：助手讲成一段故事，请用户核对。
    expect(screen.getByTestId("topic-retell")).toHaveAttribute("title", "请助手把对这一节及其下面各节的理解讲成一段故事，请核对这段复述");
    fireEvent.click(screen.getByTestId("topic-retell"));
    expect(send).toHaveBeenCalledWith("请把现在对「预约取书」及其下面主题的理解讲成一段故事");
  });

  it("提纲底部也有「复述一遍」：打开着一页就讲这一页，没有打开讲整个业务说明；未选主题时右边也有一个", () => {
    const send = vi.fn();
    render(<Panel t={overallTask()} first={null} spies={{ send }} />);
    fireEvent.click(screen.getByTestId("toc-retell"));
    expect(send).toHaveBeenLastCalledWith("请把现在对业务说明里各个主题的理解讲成一段故事");
    expect(screen.getByTestId("intro-retell")).toHaveAttribute("title", "请助手把对各节的理解讲成一段故事，请核对这段复述");
    fireEvent.click(screen.getByTestId("intro-retell"));
    expect(send).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("toc-OA-006"));
    fireEvent.click(screen.getByTestId("toc-retell"));
    expect(send).toHaveBeenLastCalledWith("请把现在对「续借」及其下面主题的理解讲成一段故事");
  });

  it("「让助手照这条改条目」只往对话区的输入框里预填一句话，不发送、不写库", () => {
    const send = vi.fn();
    const prefill = vi.fn();
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} spies={{ send, prefill, submit }} />);
    fireEvent.click(screen.getByTestId("topic-revise"));
    expect(prefill).toHaveBeenCalledWith("请照 OA-003「预约取书」现在的内容，把依据它写的条目改过来：");
    expect(send).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("「标为已废弃」先问一句、写明有几个条目依据它；点确定才作为直接修改保存，取消就什么都不发", async () => {
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} spies={{ submit }} />);
    fireEvent.click(screen.getByTestId("topic-retire"));
    expect(screen.getByTestId("topic-retire-ask")).toHaveTextContent("依据它写的 2 个条目会显示待核实");
    fireEvent.click(within(screen.getByTestId("topic-retire-ask")).getByText("取消"));
    expect(screen.queryByTestId("topic-retire-ask")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("topic-retire"));
    fireEvent.click(screen.getByTestId("topic-retire-yes"));
    expect(submit).toHaveBeenCalledWith(
      { kind: "edit_fields", targets: [{ item_id: "OA-003", base_revision: 12 }], fields: { 状态: "已废弃" }, notify_executor: false }, "把 OA-003 标为已废弃");
    await vi.waitFor(() => expect(screen.queryByTestId("topic-retire-ask")).toBeNull());
  });

  it("助手工作中不能复述、不能标为已废弃；预填那一个照常可用", () => {
    render(<Panel t={overallTask()} writesOff spies={{ send: vi.fn() }} />);
    expect(screen.getByTestId("topic-retell")).toBeDisabled();
    expect(screen.getByTestId("toc-retell")).toBeDisabled();
    expect(screen.getByTestId("topic-retire")).toBeDisabled();
    expect(screen.getByTestId("topic-revise")).not.toBeDisabled();
  });

  it("已废弃的页：顶上一句「这一页已废弃，改看某一节」，点它打开那一节；标题划掉，底部没有「标为已废弃」", () => {
    const t = change(overallTask(), "OA-011", (p) => { p.fields.状态 = "已废弃"; p.fields.改看 = ["OA-007"]; });
    render(<Panel t={t} first="OA-011" />);
    expect(text(screen.getByTestId("topic-gone"))).toBe("这一页已废弃。改看 2.1 读者。");
    expect(screen.getByTestId("topic-title")).toHaveClass("gone");
    expect(screen.queryByTestId("topic-retire")).toBeNull();
    fireEvent.click(screen.getByTestId("topic-see"));
    expect(text(screen.getByTestId("topic-title"))).toBe("读者");
    expect(screen.queryByTestId("topic-gone")).toBeNull();
  });

  it("已废弃而没有写改看哪一页的，照实说", () => {
    render(<Panel t={change(overallTask(), "OA-011", (p) => { p.fields.状态 = "已废弃"; })} first="OA-011" />);
    expect(text(screen.getByTestId("topic-gone"))).toBe("这一页已废弃。没有写改看哪一页。");
  });
});

describe("节末尾的三块", () => {
  it("相关角色与对象：与这一页有关的节按角色、业务对象、相关流程分行，没有的行不画；点一个打开那一节", () => {
    render(<Panel t={overallTask()} first="OA-002" />);
    const block = screen.getByTestId("topic-related");
    expect([...block.querySelectorAll("dt")].map((one) => one.textContent)).toEqual(["业务对象", "相关流程"]);
    expect([...block.querySelectorAll("dd")].map((one) => text(one))).toEqual(["4.1 逾期与罚款", "3.3 预约取书"]);
    fireEvent.click(screen.getByTestId("related-OA-005"));
    expect(text(screen.getByTestId("topic-title"))).toBe("逾期与罚款");
  });

  it("对应的需求条目：一条一行，写标题、所在的集合与状态词；点一行打开那个条目", () => {
    const t = change(overallTask(), "UC-002", (item) => {
      item.reviews = [{ revision_no: item.revision_no, verdict: "不合规", findings: [{ rule_id: "R1", level: "必选", message: "缺前置条件" }] } as never];
    });
    render(<Panel t={t} />);
    const rows = [...screen.getByTestId("topic-requirements").querySelectorAll("li")];
    expect(rows.map((row) => text(row))).toEqual(["续借功能用例评审中 · 1 处发现", "预约图书功能用例草稿"]);
    fireEvent.click(screen.getByTestId("requirement-UC-003"));
    expect(screen.queryByTestId("topic-page")).toBeNull();
    expect(screen.getByTestId("item-detail")).toHaveTextContent("预约图书");
  });

  it("追溯：材料 › 澄清记录 › 条目 › 文档节号，没有内容的段不画；点材料在右边定位第一处原文，点澄清记录换成条目详情的样子", () => {
    const locate = vi.fn();
    render(<Panel t={overallTask()} spies={{ locate }} />);
    // 最后一段是这一节在生成的文档里的节号，与面包屑里的节号是同一个。
    const no = text(screen.getByTestId("topic-crumb")).match(/›(\d+\.\d+)/)![1];
    expect(text(screen.getByTestId("topic-trace"))).toBe(`追溯材料 借阅规则.md›澄清记录 2 条›条目 UC-002、UC-003›文档 ${no} 节`);
    expect(screen.queryByTestId("trace-figures")).toBeNull();
    fireEvent.click(within(screen.getByTestId("trace-materials")).getByRole("button"));
    expect(locate).toHaveBeenCalledWith("同一册图书同一时间只接受一位读者的预约。", "inputs/借阅规则.md");
    fireEvent.click(within(screen.getByTestId("trace-clarified")).getByRole("button"));
    expect(screen.getByTestId("item-detail")).toBeInTheDocument();
  });

  it("没有相关的节、没有条目依据、没有来源的页，这三块都不画", () => {
    const t = change(overallTask(), "OA-011", (page) => { page.sources = []; });
    render(<Panel t={t} first="OA-011" />);
    for (const id of ["topic-related", "topic-requirements", "topic-trace"]) expect(screen.queryByTestId(id)).toBeNull();
  });
});

describe("按条目的样子看", () => {
  it("点「看修订与全部来源」换成条目详情，上面有「回到这一节」；换一节又是节的版式", () => {
    render(<Panel t={overallTask()} />);
    fireEvent.click(screen.getByTestId("topic-raw"));
    expect(screen.queryByTestId("topic-page")).toBeNull();
    expect(screen.getByTestId("item-detail")).toBeInTheDocument();
    expect(screen.getByTestId("toc")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("back-to-topic"));
    expect(screen.getByTestId("topic-page")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("topic-raw"));
    fireEvent.click(screen.getByTestId("toc-OA-002"));
    expect(text(screen.getByTestId("topic-title"))).toBe("借书与还书");
  });
});
