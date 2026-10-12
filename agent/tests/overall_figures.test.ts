/**
 * 业务说明里图放在哪里、角色与用例对照表的行（lib/overall_figures.ts）：页面与生成文档共用的两条规则。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { diagramGraph } from "../src/lib/diagram_scan.ts";
import { CELL_TAKES_PART, figureSlot, headChapterOfKind, useCaseMatrix } from "../src/lib/overall_figures.ts";

test("三种图放在章首：系统边界图第 1 章、用例图第 2 章、对象关系图第 4 章；别的不在章首", () => {
  assert.deepEqual(["context", "use_case", "class", "flowchart", "state", "sequence", "别的"].map(headChapterOfKind), [1, 2, 4, null, null, null, null]);
});

test("图在来源页的节里放进哪一块：流程图进流程节的流程步骤，状态图进对象节的状态图，对象关系图进对象节的关系；对不上章的进第一个来源页的其他图", () => {
  // 流程图：来源页在第 3 章就是流程步骤；来源里有第 3 章的页时，别的来源页不放；来源里没有第 3 章的页时，放进第一个来源页的其他图。
  assert.deepEqual([figureSlot("flowchart", 3, [3, 4], true), figureSlot("flowchart", 4, [3, 4], false), figureSlot("flowchart", 4, [4, 2], true), figureSlot("flowchart", 2, [4, 2], false)],
    ["steps", null, "other", null]);
  assert.deepEqual([figureSlot("state", 4, [4], true), figureSlot("state", 3, [3], true), figureSlot("state", 3, [3, 4], true)], ["state", "other", null]);
  assert.deepEqual([figureSlot("class", 4, [4, 3], false), figureSlot("class", 3, [4, 3], true)], ["relations", null]);
  // 系统边界图与用例图不进任何一节；时序图与认不出的种类只进第一个来源页；未归类的页（章是空的）同样照「第一个来源页」算。
  assert.deepEqual([figureSlot("context", 1, [1], true), figureSlot("use_case", 2, [2], true)], [null, null]);
  assert.deepEqual([figureSlot("sequence", 3, [3, 4], true), figureSlot("sequence", 4, [3, 4], false), figureSlot("别的", null, [null], true)], ["other", null, "other"]);
});

test("角色与用例对照表的行：只收一头是角色的线；格子是线上写的字，没有写字的写「参与」，几根线写的字不同都列出来；写了编号的认条目，没有写的照节点上的字", () => {
  const roles = [{ item_id: "OA-002", title: "读者" }, { item_id: "OA-003", title: "馆员" }];
  const graph = diagramGraph([
    "flowchart LR",
    '  r(["OA-002 读者"])',
    '  l(["馆员"])',
    '  b(["OA-001 自助借书"])',
    '  v(["UC-009 预约"])',
    '  x(["盘点"])',
    "  r -- 发起 --> b",
    "  r --> b",
    "  l --> b",
    "  r --> v",
    "  l -- 执行 --> x",
    "  b --> v",
    "  r --> l",
  ].join("\n"), ["OA", "UC"]);
  const rows = useCaseMatrix(roles, [graph], (id) => id === "OA-001");
  assert.equal(CELL_TAKES_PART, "参与");
  assert.deepEqual(rows, [
    // 读者到自助借书有两根线：一根写了「发起」，一根没有写字。馆员那一头的节点没有写编号，靠节点上的字正好是角色页的标题认出来。
    { item_id: "OA-001", text: "自助借书", cells: ["发起、参与", "参与"] },
    // 节点上写的编号任务里没有：照节点上的字算一行。
    { item_id: null, text: "预约", cells: ["参与", ""] },
    { item_id: null, text: "盘点", cells: ["", "执行"] },
  ]);
  // 图里没有画任何角色：没有行。
  assert.deepEqual(useCaseMatrix(roles, [diagramGraph('flowchart LR\n  a["甲"] --> b["乙"]', ["OA"])], () => true), []);
  assert.deepEqual(useCaseMatrix([], [graph], () => true), []);
});
