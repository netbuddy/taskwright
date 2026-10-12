// 章首页上要算的东西（model/chapterHeads.ts）：角色与用例对照表、业务目标摘要、决策记录一行点了去哪里。数据是图书馆借阅的夹具。
import { describe, expect, it } from "vitest";
import { diagramGraph } from "../../../agent/src/lib/diagram_scan.ts";
import { toc } from "../model/chapters";
import { CELL_TAKES_PART, decisionTarget, goalSummary, useCaseTable } from "../model/chapterHeads";
import { change, overallTask } from "./fixtures/overallTask";

const PREFIXES = ["UC", "TBD", "OA"];
// 夹具里的角色：OA-007 读者（2.1）、OA-009 馆员（2.2）。流程：OA-001 借阅、OA-002 借书与还书、OA-003 预约取书、OA-006 续借。
// UC-002 续借、UC-003 预约图书是依据 OA-003 写的条目。
const graph = (text: string) => diagramGraph(text, PREFIXES);
const USE_CASES = graph([
  "flowchart LR",
  '  r(["OA-007 读者"])', '  l(["馆员"])', '  a(["OA-006 续借"])', '  b(["UC-003 预约图书"])', '  c(["缴纳罚款"])', '  d(["OA-005 逾期与罚款"])',
  "  r -->|发起| a", "  r --> b", "  l -->|上架| b", "  l -->|放回| b", "  r --> c", "  a --> c", "  r --> l",
].join("\n"));
const shape = (table: ReturnType<typeof useCaseTable>) => table.rows.map((row) => `${row.label}|${row.cells.join(",")}|${row.flows.map((flow) => flow.item_id).join("+")}|${row.item?.item_id ?? ""}`);

describe("角色与用例对照表", () => {
  it("列是第 2 章在用的角色；行是与角色有连线、自己不是角色的节点；格子是线上写的字，没有写字的写「参与」", () => {
    const task = overallTask();
    change(task, "UC-003", (item) => { item.sources = [{ kind: "条目", locator: "OA-003", excerpt: "", supports: [] }]; });
    const table = useCaseTable(task, toc(task), [USE_CASES]);
    expect(table.roles.map((role) => role.item_id)).toEqual(["OA-007", "OA-009"]);
    expect(shape(table)).toEqual([
      // 流程节自己就是所属流程。
      `续借|发起,|OA-006|OA-006`,
      // 依据流程节写的条目：所属流程是那一节；同一个角色的两根线写的字不同，都列出来。
      `预约图书|${CELL_TAKES_PART},上架、放回|OA-003|UC-003`,
      // 没有写编号的节点照节点上的字，没有所属流程。
      `缴纳罚款|${CELL_TAKES_PART},||`,
    ]);
  });

  it("两头都不是角色的线、两头都是角色的线不进表；节点上的字正好是角色的标题也认作角色", () => {
    const task = overallTask();
    const table = useCaseTable(task, toc(task), [USE_CASES]);
    // 「续借 → 缴纳罚款」「读者 → 馆员」两根线都没有产生行或格子；「馆员」没有写编号也认出来了。
    expect(table.rows.map((row) => row.label)).toEqual(["续借", "预约图书", "缴纳罚款"]);
    expect(table.rows[1].cells[1]).toBe("上架、放回");
  });

  it("几张用例图合成一张表；已废弃的角色不占列；图里没有画角色时一行都没有", () => {
    const task = overallTask();
    const second = graph('flowchart LR\n  x(["OA-009 馆员"])\n  y(["OA-006 续借"])\n  x -->|审核| y');
    expect(shape(useCaseTable(task, toc(task), [USE_CASES, second]))[0]).toBe("续借|发起,审核|OA-006|OA-006");
    change(task, "OA-009", (page) => { page.fields.状态 = "已废弃"; });
    const table = useCaseTable(task, toc(task), [USE_CASES]);
    expect(table.roles.map((role) => role.item_id)).toEqual(["OA-007"]);
    expect(table.rows.map((row) => row.cells)).toEqual([["发起"], [CELL_TAKES_PART], [CELL_TAKES_PART], [CELL_TAKES_PART]]);
    expect(useCaseTable(task, toc(task), [graph("flowchart LR\n  a --> b")]).rows).toEqual([]);
    expect(useCaseTable(task, toc(task), []).rows).toEqual([]);
  });
});

describe("业务目标摘要", () => {
  it("取目标树的前两层；没有目标树时是空的", () => {
    const leaf = (id: string, title: string, goals: unknown[] = []) => ({ item_id: id, title, goals, decisions: [{ item_id: "OA-090", title: "决定", why: "" }] });
    const tree = { roots: [leaf("OA-020", "借还更省事", [leaf("OA-021", "自助办理", [leaf("OA-022", "第三层")])]), leaf("OA-023", "少丢书")], loose: [] };
    expect(goalSummary(tree as never)).toEqual([
      { item_id: "OA-020", title: "借还更省事", goals: [{ item_id: "OA-021", title: "自助办理" }] },
      { item_id: "OA-023", title: "少丢书", goals: [] },
    ]);
    expect(goalSummary(undefined)).toEqual([]);
  });
});

describe("决策记录与待澄清事项的一行点了去哪里", () => {
  it("决定去它自己那一节；问题去它牵涉的第一节；没有牵涉业务说明的节的问题打开问题自己；任务里没有的不去", () => {
    const task = overallTask();
    expect(decisionTarget(task, { entry: "decision", item_id: "OA-004" })).toEqual({ kind: "section", itemId: "OA-004" });
    // 夹具里 TBD-001 挂在 OA-003 上。
    expect(decisionTarget(task, { entry: "question", item_id: "TBD-001" })).toEqual({ kind: "section", itemId: "OA-003" });
    const refs = task.definition.collections.find((one) => one.name === "问题")!.fields.find((field) => field.type === "条目引用")!.name;
    change(task, "TBD-002", (issue) => { issue.fields[refs] = ["UC-001"]; });
    expect(decisionTarget(task, { entry: "question", item_id: "TBD-002" })).toEqual({ kind: "item", itemId: "TBD-002" });
    expect(decisionTarget(task, { entry: "question", item_id: "TBD-404" })).toBeNull();
  });
});
