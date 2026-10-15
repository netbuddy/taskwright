/** 用户 agent 眼里的图：条目区后面那一段（每张一行）、打开一张图看到的文字、打开时要记的目标。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type TaskView, renderDiagram, renderDiagrams, renderItems, sourcePagesOf, viewOnLookDiagram } from "../lib/screen.ts";

const page = (id: string, title: string, figures: string[]) => ({
  item_id: id, collection: "业务说明", title, revision_no: 1, fields: { 标题: title, 标签: ["流程"], 状态: "在用" },
  depended_by: [...figures.map((figure) => ({ element_kind: "图", id: figure })), { element_kind: "条目", id: "UC-001" }],
});
const task: TaskView = {
  definition: { collections: [{ name: "业务说明", fields: [{ name: "标题" }] }, { name: "功能用例", fields: [{ name: "用例名称" }] }] },
  items: [page("OA-001", "借书", ["D-001", "D-002"]), page("OA-002", "预约", ["D-002"]),
    { item_id: "UC-001", collection: "功能用例", title: "借书", revision_no: 2, fields: {}, depended_by: [{ element_kind: "图", id: "D-001" }] }],
  diagrams: [
    { diagram_id: "D-001", name: "借书流程图", kind: "flowchart", kind_name: "流程图", revision_no: 2, viewed: true },
    { diagram_id: "D-002", name: "预约状态图", kind: "state", kind_name: "状态图", revision_no: 1, viewed: false },
    { diagram_id: "D-003", name: "读者提的草图", kind: "sequence", kind_name: "时序图", revision_no: 1 },
  ],
};

test("图那一段：每张一行，写编号、图名、种类、画自哪几页、现在这一版看没看过；画自哪页只数业务说明的页", () => {
  assert.deepEqual(sourcePagesOf(task, "D-001"), ["OA-001"]);
  assert.deepEqual(sourcePagesOf(task, "D-002"), ["OA-001", "OA-002"]);
  assert.equal(renderDiagrams(task), [
    "助手画的图 3 张（想看哪一张，look 时在 diagram_id 里写它的编号）：",
    "  D-001「借书流程图」（流程图）：画自 OA-001；你看过现在这一版了",
    "  D-002「预约状态图」（状态图）：画自 OA-001、OA-002；你还没看过现在这一版",
    "  D-003「读者提的草图」（时序图）：没有写画自哪一页；你还没看过现在这一版",
  ].join("\n"));
});

test("一张图都没有、旧后端没有这一项、还没有任务时，图那一段是空的；条目区的文字不带图", () => {
  assert.equal(renderDiagrams({ ...task, diagrams: [] }), "");
  assert.equal(renderDiagrams({ definition: task.definition, items: task.items }), "");
  assert.equal(renderDiagrams(null), "");
  assert.ok(!renderItems(task).includes("D-001"));
});

test("打开一张图：图名、种类、修订、说明、画自哪几页与 Mermaid 文本；要记的目标是用户看到的那一次修订", () => {
  const detail = { ...task.diagrams![0], mermaid: "flowchart TD\n  a[\"OA-001 借书\"] --> b{\"超过上限？\"}", note: "读者借一本书的经过。",
    sources: [{ kind: "条目", locator: "OA-001" }, { kind: "用户的话", locator: "" }] };
  assert.equal(renderDiagram(detail, "D-001"), [
    "D-001「借书流程图」，流程图，修订 2（你正在看它现在这一版，看过就记为看过）：",
    "  说明：读者借一本书的经过。",
    "  画自：OA-001",
    "  图的文本（Mermaid 写法）：",
    "    flowchart TD",
    "      a[\"OA-001 借书\"] --> b{\"超过上限？\"}",
  ].join("\n"));
  assert.deepEqual(viewOnLookDiagram(detail), { diagram_id: "D-001", base_revision: 2 });
  assert.match(renderDiagram({ ...task.diagrams![2], mermaid: "sequenceDiagram" }, "D-003"), /说明：（空）\n  画自：（没有写）/);
});

test("没有这张图：说没有，不记", () => {
  assert.equal(renderDiagram(null, "D-009"), "助手画的图里没有 D-009。");
  assert.equal(viewOnLookDiagram(null), null);
});
