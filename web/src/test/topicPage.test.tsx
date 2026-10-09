// 总体分析的一页主题：面包屑、标题、标签、待核实与依据提到的计数；四块（它是什么、例子、已经定下的、还没定的）各画出来；
// 助手补的字句与那一条已定带标注，出处写在每一处下面；还没定的问题可以在这里回答或者先放着；
// 上一条、下一条照提纲的次序；「看修订与全部来源」换成条目详情的样子，再回到主题页。
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
type Spies = { submit?: ReturnType<typeof vi.fn>; send?: ReturnType<typeof vi.fn>; answer?: ReturnType<typeof vi.fn>; locate?: ReturnType<typeof vi.fn> };
function Panel({ t, first = "OA-003", readOnly = false, writesOff = false, spies = {} }: { t: Task; first?: string | null; readOnly?: boolean; writesOff?: boolean; spies?: Spies }) {
  const [selected, setSelected] = useState<string | null>(first);
  return (
    <Wrap><div className="app">
      <ItemsPanel task={t} initialCollection="总体分析" readOnly={readOnly} writesOff={writesOff} recentlyChanged={[]} pendingItems={new Set()}
        selected={selected} onSelect={setSelected} submit={(spies.submit ?? vi.fn(async () => null)) as never} onGenerateDoc={() => {}}
        onSend={spies.send as never} onAnswer={spies.answer as never} onLocate={spies.locate as never} />
    </div></Wrap>
  );
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("主题页的顶部", () => {
  it("面包屑是它上面的各级主题，点一级打开那一页；标题前面是编号", () => {
    render(<Panel t={overallTask()} first="OA-004" />);
    expect(text(screen.getByTestId("topic-crumb"))).toContain("借阅›预约取书›闭馆日怎么算");
    expect(text(screen.getByTestId("topic-title"))).toBe("OA-004闭馆日怎么算");
    fireEvent.click(screen.getByText("预约取书", { selector: ".oa-crumb .up" }));
    expect(text(screen.getByTestId("topic-title"))).toBe("OA-003预约取书");
  });

  it("标签、几处待核实、几个条目依据它与被几处提到", () => {
    render(<Panel t={overallTask()} />);
    const meta = screen.getByTestId("topic-meta");
    expect([...meta.querySelectorAll(".oa-tag:not(.add)")].map((t) => t.textContent)).toEqual(["概念", "流程"]);
    expect(screen.getByTestId("topic-add-label")).toHaveTextContent("＋ 标签");
    expect(screen.getByTestId("topic-pending")).toHaveTextContent("1 处待核实");
    expect(screen.getByTestId("topic-counts")).toHaveTextContent("2 个条目依据它 · 被 3 处提到");
  });

  it("没有贴标签的页写「未归类」；不待核实的页不写待核实", () => {
    render(<Panel t={overallTask()} first="OA-008" />);
    expect([...screen.getByTestId("topic-meta").querySelectorAll(".oa-tag:not(.add)")].map((t) => t.textContent)).toEqual(["未归类"]);
    expect(screen.queryByTestId("topic-pending")).toBeNull();
    expect(screen.getByTestId("topic-counts")).toHaveTextContent("0 个条目依据它 · 被 0 处提到");
  });

  it("上一条、下一条照提纲从上到下的次序；第一页没有上一条，最后一页没有下一条；回到提纲", () => {
    render(<Panel t={overallTask()} first="OA-001" />);
    expect(screen.getByTestId("topic-prev")).toBeDisabled();
    fireEvent.click(screen.getByTestId("topic-next"));
    expect(text(screen.getByTestId("topic-title"))).toBe("OA-002借书与还书");
    fireEvent.click(screen.getByTestId("topic-next"));
    fireEvent.click(screen.getByTestId("topic-next"));
    expect(text(screen.getByTestId("topic-title"))).toBe("OA-004闭馆日怎么算"); // 「预约取书」下面的页排在「逾期与罚款」之前
    fireEvent.click(screen.getByTestId("topic-prev"));
    expect(text(screen.getByTestId("topic-title"))).toBe("OA-003预约取书");
    fireEvent.click(screen.getByTestId("outline-OA-011"));
    expect(screen.getByTestId("topic-next")).toBeDisabled();
    fireEvent.click(screen.getByTestId("topic-back"));
    expect(screen.queryByTestId("topic-page")).toBeNull();
    expect(screen.getByTestId("overall-intro")).toBeInTheDocument();
  });
});

describe("主题页的四块", () => {
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

  it("例子：一条一张卡片，反例是灰色卡片、写「这种不算」，正文里不带「反例：」", () => {
    render(<Panel t={overallTask()} />);
    const first = screen.getByTestId("topic-example-0");
    const second = screen.getByTestId("topic-example-1");
    expect(first).not.toHaveClass("neg");
    expect(first.querySelector(".k")).toHaveTextContent("例子 1");
    expect(second).toHaveClass("neg");
    expect(second.querySelector(".k")).toHaveTextContent("这种不算");
    expect(second.querySelector("p")!.textContent).toBe("小李想借的《深入理解计算机系统》还在别人手上，他登记的是排队等书，不是预约取书。");
  });

  it("已经定下的：一句一条，每条下面是出处；助手补的那一条前面是琥珀点", () => {
    render(<Panel t={overallTask()} />);
    const rules = [...screen.getByTestId("topic-settled").querySelectorAll(".oa-rules li")];
    expect(rules.length).toBe(4);
    expect(rules.map((li) => li.classList.contains("pending"))).toEqual([false, false, false, true]);
    expect(text(rules[1].querySelector(".t"))).toBe("一本书同一时间只能被一个人预约。材料 借阅规则.md「同一册图书同一时间只接受一位读者的预约。」");
    expect(rules[3].querySelector(".oa-src .one")).toHaveClass("v");
  });

  it("出处是材料原文时点一下去右边的材料里看那句原文", () => {
    const locate = vi.fn();
    render(<Panel t={overallTask()} spies={{ locate }} />);
    fireEvent.click(within(screen.getByTestId("topic-settled-1")).getByText(/^材料 借阅规则\.md/));
    expect(locate).toHaveBeenCalledWith("同一册图书同一时间只接受一位读者的预约。", "inputs/借阅规则.md");
  });

  it("还没定的：挂在这一页上还没有了结的问题，带助手问的原因；写了回答点「记下」发给助手", () => {
    const send = vi.fn();
    render(<Panel t={overallTask()} spies={{ send }} />);
    const q = screen.getByTestId("topic-question-TBD-001");
    expect(q.querySelector(".q")).toHaveTextContent("TBD-001保留的 3 天里遇到闭馆日，算不算在内？");
    expect(q.querySelector(".why")).toHaveTextContent("助手问的原因：小王周六预约、周一到架，如果周日闭馆而且算在 3 天里，他周二来取就只剩一天了。");
    fireEvent.change(within(q).getByLabelText("回答 TBD-001"), { target: { value: " 闭馆日不算，顺延 " } });
    fireEvent.click(screen.getByTestId("topic-answer-TBD-001"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("TBD-001");
    expect(send.mock.calls[0][0]).toContain("闭馆日不算，顺延");
    expect(within(q).getByLabelText("回答 TBD-001")).toHaveValue("");
  });

  it("还没定的：回答框空着点「记下」只把开头填进对话区的输入框；「这件事先放着」把问题标为先不管", () => {
    const send = vi.fn();
    const answer = vi.fn();
    const submit = vi.fn(async () => null);
    render(<Panel t={overallTask()} spies={{ send, answer, submit }} />);
    fireEvent.click(screen.getByTestId("topic-answer-TBD-001"));
    expect(send).not.toHaveBeenCalled();
    expect(answer.mock.calls[0][0].item_id).toBe("TBD-001");
    fireEvent.click(screen.getByTestId("topic-keep-TBD-001"));
    expect(submit).toHaveBeenCalledWith({ kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }], notify_executor: false }, "把 TBD-001 标为先不管");
  });

  it("助手工作中、任务结束后，回答与先放着都不能点", () => {
    render(<Panel t={overallTask()} writesOff />);
    expect(screen.getByTestId("topic-answer-TBD-001")).toBeDisabled();
    expect(screen.getByTestId("topic-keep-TBD-001")).toBeDisabled();
    expect(screen.getByLabelText("回答 TBD-001")).toBeDisabled();
  });

  it("哪一块没有内容就写一句话，四块都在", () => {
    render(<Panel t={overallTask()} first="OA-011" />);
    expect(screen.getByTestId("topic-examples")).toHaveTextContent("还没有例子");
    expect(screen.getByTestId("topic-settled")).toHaveTextContent("还没有定下什么");
    expect(screen.getByTestId("topic-open")).toHaveTextContent("现在没有挂在这一页上的问题");
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

describe("提到它的地方", () => {
  it("别处说到它的句子在前，命中的词上色；依据它写的条目在后，依据在那之后改过的带「依据已变」", () => {
    render(<Panel t={overallTask()} />);
    const rows = [...screen.getByTestId("topic-mentions").querySelectorAll(".oa-mentions li")];
    expect(rows.map((li) => `${li.getAttribute("data-kind")}｜${text(li.querySelector(".from"))}`)).toEqual([
      "mention｜借书与还书主题 · 它是什么",
      "mention｜续借主题 · 已经定下的第 2 条",
      "mention｜UC-002 续借功能用例 · 约束规则第 1 条",
      "basis｜UC-002 续借功能用例 · 依据它",
      "basis｜UC-003 预约图书功能用例 · 依据它",
    ]);
    expect(rows[0].querySelector("mark")!.textContent).toBe("预约取书");
    expect(rows[1].querySelector("q")!.textContent).toBe("有人预约的书不能续借。");
    expect(rows[1].querySelector("mark")!.textContent).toBe("预约");
    expect(rows[3].querySelector("mark")).toBeNull();
    expect(screen.getByTestId("topic-stale-UC-003")).toHaveTextContent("依据已变");
    expect(screen.queryByTestId("topic-stale-UC-002")).toBeNull();
  });

  it("点出处打开那一页主题；点条目的出处切到它所在的页签并打开它", () => {
    render(<Panel t={overallTask()} />);
    fireEvent.click(screen.getByTestId("topic-mention-1").querySelector(".from")!);
    expect(text(screen.getByTestId("topic-title"))).toBe("OA-006续借");
    fireEvent.click(screen.getByTestId("outline-OA-003"));
    fireEvent.click(screen.getByTestId("topic-mention-4").querySelector(".from")!);
    expect(screen.queryByTestId("overall-pane")).toBeNull();
    expect(document.querySelector(".itab.on")!.textContent).toBe("功能用例3");
    expect(screen.getByTestId("item-detail")).toHaveTextContent("UC-003");
  });

  it("没有别处提到、也没有条目依据的页写一句话", () => {
    render(<Panel t={overallTask()} first="OA-011" />);
    expect(screen.getByTestId("topic-mentions")).toHaveTextContent("还没有别处提到它，也没有条目依据它。");
  });
});

describe("按条目的样子看", () => {
  it("点「看修订与全部来源」换成条目详情，上面有「回到主题页」；换一页又是主题页", () => {
    render(<Panel t={overallTask()} />);
    fireEvent.click(screen.getByTestId("topic-raw"));
    expect(screen.queryByTestId("topic-page")).toBeNull();
    expect(screen.getByTestId("item-detail")).toBeInTheDocument();
    expect(screen.getByTestId("outline")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("back-to-topic"));
    expect(screen.getByTestId("topic-page")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("topic-raw"));
    fireEvent.click(screen.getByTestId("outline-OA-002"));
    expect(text(screen.getByTestId("topic-title"))).toBe("OA-002借书与还书");
  });
});
