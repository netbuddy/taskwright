// 阶段条：六个阶段名（已过的、当前的、还没到的），当前阶段的灯（没通过的每盏一句、可以点；通过的收成一句；全部通过；全不适用），
// 一盏灯的句子取后端整句冒号之前的半句、数字加重、悬停是整句；点灯去清单里的第一个；任务没有阶段时不画。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Item, StageKey, StageLamp, StageView } from "../api/types";
import { StageBar } from "../components/work/StageBar";
import { ENTER_KEYS, IDLE_TEXT, STAGES, isAlone, isIdle, lampGroups, lampShort, lampTarget, splitNumbers, stageMarks } from "../model/stage";
import { workReducer, initialWorkState } from "../state/workState";

afterEach(cleanup);

const lamp = (key: string, ok: boolean | null, summary: string, items: string[] = []): StageLamp => ({ key, ok, summary, items });
const stage = (current: StageKey, lamps: StageLamp[]): StageView => ({
  current, moved_by: null, moved_at: null, reason: null,
  lamps: { reading: [], clarifying: [], modeling: [], writing: [], reviewing: [], document: [], [current]: lamps },
});
const item = (item_id: string): Item => ({ item_id, collection: "总体分析", title: item_id, fields: {}, revision_no: 1 } as unknown as Item);

describe("阶段条", () => {
  it("六个阶段按次序排：当前的标出来，前面的算已经过了，后面的算还没到；六种当前阶段各对一遍", () => {
    for (const [index, current] of STAGES.entries()) {
      const { unmount } = render(<StageBar stage={stage(current, [])} items={[]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
      expect(STAGES.map((key) => screen.getByTestId(`stage-${key}`).className.replace("sb-s ", ""))).toEqual(
        STAGES.map((_, at) => (at < index ? "done" : at === index ? "current" : "ahead")));
      expect(screen.getByTestId(`stage-${current}`)).toHaveAttribute("aria-current", "step");
      unmount();
    }
    expect(stageMarks("modeling").map((one) => one.name)).toEqual(["核读材料", "澄清", "整理建模", "写条目", "评审确认", "编写文档"]);
    // 阶段名只是文字，没有可以点的样子。
    render(<StageBar stage={stage("clarifying", [])} items={[]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
    expect(screen.getByTestId("stage-writing")).not.toHaveAttribute("role");
  });

  it("会话空闲：没有当前的一格，写一句本会话没有在进行的工作项，不画灯；工作项是单项活动：只有那一格是当前，前面的不算做过，写明是单项活动，灯照那项活动的", () => {
    const idle = { ...stage("clarifying", [lamp("a", false, "有 1 页还差：OA-001。", ["OA-001"])]), current: "idle" as const, node: null };
    const { unmount } = render(<StageBar stage={idle} items={[]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
    expect(STAGES.map((key) => screen.getByTestId(`stage-${key}`).className.replace("sb-s ", ""))).toEqual(STAGES.map(() => "ahead"));
    expect(STAGES.every((key) => !screen.getByTestId(`stage-${key}`).hasAttribute("aria-current"))).toBe(true);
    expect(screen.getByTestId("stage-position")).toHaveTextContent(IDLE_TEXT);
    expect(IDLE_TEXT).toBe("本会话没有在进行的工作项：自由讨论，或者它的工作项已经结束。");
    expect(screen.queryByTestId("stage-lamps")).toBeNull();
    expect([isIdle(idle), isAlone(idle), lampGroups(idle)]).toEqual([true, false, { failing: [], passed: 0, applicable: 0 }]);
    unmount();
    const alone = { ...stage("writing", [lamp("a", false, "有 1 页还差：OA-001。", ["OA-001"])]), node: null };
    render(<StageBar stage={alone} items={[]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
    expect(STAGES.map((key) => screen.getByTestId(`stage-${key}`).className.replace("sb-s ", ""))).toEqual(["ahead", "ahead", "ahead", "current", "ahead", "ahead"]);
    expect(screen.getByTestId("stage-position")).toHaveTextContent("本会话的工作项是单项活动：写条目（不在工作流程里）。");
    expect(screen.getByTestId("lamp-a")).toHaveTextContent("有 1 页还差。");
    expect([isIdle(alone), isAlone(alone)]).toEqual([false, true]);
    // 在流程里的阶段（节点与阶段相同）、早先的后端不给节点：都不是单独开展，没有那一句。
    expect([isAlone({ ...alone, node: "writing" }), isAlone(stage("writing", []))]).toEqual([false, false]);
    expect(stageMarks("idle").every((one) => one.mark === "ahead")).toBe(true);
  });

  it("没通过的灯每盏一句（冒号之前的半句、数字加重、悬停是整句），通过的收成「其余 N 项已齐」，不适用的不显示也不计数", () => {
    const whole = "有 2 页标签为「流程」的主题还没有以「例外：」开头的例子：OA-003、OA-005。";
    render(<StageBar stage={stage("modeling", [
      lamp("flows_have_flowchart_with_branch", false, whole, ["OA-003", "OA-005"]),
      lamp("roles_in_context_and_use_cases", null, "还没有标签为「角色」的主题。"),
      lamp("no_duplicate_titles", true, "没有两页主题用了同一个标题或别名。"),
      lamp("no_untagged_pages", true, "在用的主题都贴了标签。"),
    ])} items={[item("OA-003")]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
    const failing = screen.getByTestId("lamp-flows_have_flowchart_with_branch");
    // 引号里的那个冒号（「例外：」）不算清单前面的冒号。
    expect(failing).toHaveTextContent("有 2 页标签为「流程」的主题还没有以「例外：」开头的例子。");
    expect(failing).not.toHaveTextContent("OA-003");
    expect(failing).toHaveAttribute("title", whole);
    expect([...failing.querySelectorAll("b")].map((b) => b.textContent)).toEqual(["2"]);
    expect(screen.getByTestId("lamps-rest-ok")).toHaveTextContent("其余 2 项已齐");
    expect(screen.queryByTestId("lamp-roles_in_context_and_use_cases")).toBeNull();
    expect(screen.getByTestId("stage-lamps")).toHaveTextContent("这一段还差：");
  });

  it("这一段的灯全部通过时只写一句；全都不适用时写还没有可以核对的内容", () => {
    const { unmount } = render(<StageBar stage={stage("clarifying", [lamp("a", true, "甲。"), lamp("b", null, "乙。"), lamp("c", true, "丙。")])}
      items={[]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
    expect(screen.getByTestId("lamps-all-ok")).toHaveTextContent("这一段的几项都齐了。");
    expect(screen.queryByTestId("lamps-rest-ok")).toBeNull();
    expect(screen.getByTestId("stage-lamps")).not.toHaveTextContent("这一段还差");
    unmount();
    render(<StageBar stage={stage("clarifying", [lamp("b", null, "乙。")])} items={[]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
    expect(screen.getByTestId("lamps-none")).toHaveTextContent("这一段还没有可以核对的内容。");
  });

  it("点一盏没通过的灯：清单里第一个是任务里的条目就打开它，是材料的路径就去材料页签；清单是空的这盏灯点不了", () => {
    const onOpenItem = vi.fn(), onOpenMaterial = vi.fn();
    render(<StageBar stage={stage("reading", [
      lamp("materials_cited", false, "有 1 份材料还没有被任何主题或问题引用：inputs/规则.md。", ["inputs/规则.md"]),
      lamp("pages", false, "有 2 页主题要看：OA-002、OA-004。", ["OA-002", "OA-004"]),
      lamp("bare", false, "还差一件说不出是哪一页的事。"),
    ])} items={[item("OA-002"), item("OA-004")]} onOpenItem={onOpenItem} onOpenMaterial={onOpenMaterial} />);
    fireEvent.click(screen.getByTestId("lamp-materials_cited"));
    expect(onOpenMaterial).toHaveBeenCalledWith("inputs/规则.md");
    fireEvent.keyDown(screen.getByTestId("lamp-pages"), { key: "Enter" });
    expect(onOpenItem).toHaveBeenCalledWith("OA-002");
    expect(screen.getByTestId("lamp-pages")).toHaveAttribute("role", "button");
    const bare = screen.getByTestId("lamp-bare");
    expect(bare).not.toHaveAttribute("role");
    expect(bare).toHaveTextContent("还差一件说不出是哪一页的事。");
    fireEvent.click(bare);
    expect(onOpenItem).toHaveBeenCalledTimes(1);
    expect(onOpenMaterial).toHaveBeenCalledTimes(1);
  });

  it("任务没有阶段（早先建的任务）时不画这一行", () => {
    const { container } = render(<StageBar stage={null} items={[]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    const again = render(<StageBar stage={undefined} items={[]} onOpenItem={() => {}} onOpenMaterial={() => {}} />);
    expect(again.container).toBeEmptyDOMElement();
  });

  it("读法的几个小函数：缩短句子、拆数字、分三类、点灯去哪里、六个进入键", () => {
    expect(lampShort("有 3 条条目依据的主题用户还没有看过：UC-001、UC-002、UC-003。")).toBe("有 3 条条目依据的主题用户还没有看过。");
    expect(lampShort("每份材料都被引用了。")).toBe("每份材料都被引用了。");
    expect(lampShort("每个标签为「流程」的主题都有一条以「例外：」开头的例子。")).toBe("每个标签为「流程」的主题都有一条以「例外：」开头的例子。");
    expect(lampShort("有 1 个标题或别名被两页以上的主题用了：「预约」（OA-001、OA-002）。")).toBe("有 1 个标题或别名被两页以上的主题用了。");
    expect(lampShort("有 1 页标签为「决定」的主题没有标签为「目标」的上级主题：OA-007。在「它是什么」里写了为什么的也算说清了。")).toBe("有 1 页标签为「决定」的主题没有标签为「目标」的上级主题。");
    expect(splitNumbers("有 12 页、3 条")).toEqual([{ text: "有 ", number: false }, { text: "12", number: true }, { text: " 页、", number: false },
      { text: "3", number: true }, { text: " 条", number: false }]);
    expect(lampGroups(stage("writing", [lamp("a", false, "甲"), lamp("b", true, "乙"), lamp("c", null, "丙")]))).toMatchObject({ passed: 1, applicable: 2 });
    expect(lampTarget(lamp("a", false, "甲", []), [])).toBeNull();
    expect(lampTarget(lamp("a", false, "甲", ["OA-001"]), [item("OA-001")])).toEqual({ kind: "item", itemId: "OA-001" });
    expect(lampTarget(lamp("a", false, "甲", ["inputs/x.md"]), [item("OA-001")])).toEqual({ kind: "material", path: "inputs/x.md" });
    expect(ENTER_KEYS).toEqual({ enter_reading: "reading", enter_clarify: "clarifying", enter_consolidate: "modeling", start_items: "writing", enter_review: "reviewing", enter_document: "document" });
  });

  it("点了说材料没有被引用的灯之后，状态里记下要在材料页签选中的那份材料", () => {
    const next = workReducer(initialWorkState("s-1"), { type: "focus_material", path: "inputs/规则.md" });
    expect(next.focusMaterial).toBe("inputs/规则.md");
  });
});
