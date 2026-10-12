/**
 * 从 Mermaid 文本里扫东西（src/lib/diagram_scan.ts）：只按写法找，不解析整张图；认不准的往宽里算。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classLinked, contextShape, diagramGraph, drawnItemIds, hasBranch } from "../src/lib/diagram_scan.ts";

const lines = (...rows: string[]) => rows.join("\n");

test("系统边界图：数出子图，找出只在子图之外的节点", () => {
  const text = lines(
    "flowchart LR",
    '  reader(["OA-001 读者"])',
    '  bank["支付平台"]',
    '  subgraph sys["图书馆系统"]',
    '    desk["办理借还"]',
    '    fine["收取罚款"]',
    "  end",
    "  reader -- 借书申请 --> desk",
    "  fine -. 扣款请求 .-> bank",
    "  desk --> fine",
  );
  assert.deepEqual(contextShape(text), { subgraphs: 1, outside: ["reader", "bank"] });
});

test("系统边界图：没有子图时子图数是 0；节点都在子图里时外面一个都没有", () => {
  assert.deepEqual(contextShape(lines("flowchart LR", "  a[读者] --> b[柜台]")), { subgraphs: 0, outside: ["a", "b"] });
  assert.deepEqual(contextShape(lines("graph TD", "  subgraph 系统", "    a[受理] --> b[退款]", "  end", "  a --> b")), { subgraphs: 1, outside: [] });
});

test("系统边界图：注释、样式、点击这几种语句不算节点；子图的名字不算外面的节点；一行里用分号隔开的几句各算各的", () => {
  const text = lines(
    "%% 系统与外面",
    "flowchart LR",
    "  subgraph sys [图书馆系统]",
    "    direction TB",
    "    desk[办理借还]",
    "  end",
    "  classDef outer fill:#eee",
    "  class reader outer",
    "  style desk fill:#fff",
    "  reader([读者]):::outer --> sys; sys --> sms[短信平台]",
    "  click reader callback",
  );
  assert.deepEqual(contextShape(text), { subgraphs: 1, outside: ["reader", "sms"] });
});

test("系统边界图：连线上的字（夹在竖线里、夹在连线中间）不算节点；用 & 并列的几个节点都算", () => {
  const text = lines(
    "flowchart LR",
    "  subgraph 系统",
    "    core[核心]",
    "  end",
    "  reader -->|借书申请| core",
    "  admin == 上架 ==> core",
    "  core -- 通知 --> mail & sms",
  );
  assert.deepEqual(contextShape(text), { subgraphs: 1, outside: ["reader", "admin", "mail", "sms"] });
});

test("系统边界图：节点的文字里有括号、引号、分号、箭头也不乱", () => {
  const text = lines(
    "flowchart LR",
    '  subgraph s1["系统（一期）"]',
    '    a["受理; 审核 --> 归档"]',
    "  end",
    '  u(["用户 [外部]"]) --> a',
  );
  assert.deepEqual(contextShape(text), { subgraphs: 1, outside: ["u"] });
});

test("流程图有没有判断节点：花括号的菱形算，双花括号的六边形、文字里的花括号、注释里的都不算", () => {
  assert.equal(hasBranch(lines("flowchart TD", '  a["OA-001 提交申请"] --> c{"金额大于 500？"}', "  c -- 是 --> d[主管复核]")), true);
  assert.equal(hasBranch(lines("flowchart TD", "  A([开始]) --> B{是否可退}")), true);
  assert.equal(hasBranch(lines("flowchart TD", "  a[提交] --> b[审核] --> c([结束])")), false);
  assert.equal(hasBranch(lines("flowchart TD", "  a{{准备材料}} --> b[审核]")), false);
  assert.equal(hasBranch(lines("flowchart TD", '  a["返回 {code: 0}"] --> b[结束]', "  %% c{判断}")), false);
  assert.equal(hasBranch(lines("flowchart TD", "  a{{准备}} --> b{够不够}")), true);
});

test("对象关系图里有连线的条目：按类的声明把关系线两端的名字对回编号；孤零零的类不算", () => {
  const text = lines(
    "classDiagram",
    '  class Loan["OA-003 借阅记录"] {',
    "    +Date 借出日期",
    "    +续借() -- 最多一次",
    "  }",
    '  class Reader["OA-001 读者"]',
    '  class Book["OA-002 图书"]',
    '  class Card["OA-004 借书证"]',
    '  class Fine["OA-005 罚款"]',
    '  Reader "1" --> "0..*" Loan : 办理',
    "  Loan --> Book",
    "  Reader *-- Card",
  );
  assert.deepEqual(classLinked(text, ["OA"]), ["OA-001", "OA-003", "OA-002", "OA-004"]);
  assert.deepEqual(drawnItemIds(text, ["OA"]), ["OA-003", "OA-001", "OA-002", "OA-004", "OA-005"]);
});

test("对象关系图：各种关系线、不带空格的写法、反引号括起来的名字、写在说明里的编号都认；没有前缀可认时是空的", () => {
  const each = (relation: string) => classLinked(lines("classDiagram", '  class A["OA-001 甲"]', '  class B["OA-002 乙"]', `  ${relation}`), ["OA"]);
  for (const relation of ["A <|-- B", "A --|> B", "A *-- B", "A o-- B", "A --> B", "A -- B", "A ..> B", "A ..|> B", "A .. B", "A<|--B", "A-->B", 'A "1" -- "*" B', "A --> B : 包含"]) {
    assert.deepEqual(each(relation), ["OA-001", "OA-002"], relation);
  }
  assert.deepEqual(classLinked(lines("classDiagram", "  `OA-001 读者` --> `OA-002 图书` : 借"), ["OA"]), ["OA-001", "OA-002"]);
  // 两端的类没有写编号，编号写在关系线的说明里。
  assert.deepEqual(classLinked(lines("classDiagram", "  Reader --> Book : OA-007 借阅"), ["OA"]), ["OA-007"]);
  // 只声明、没有关系线；成员用冒号写在类外面；注释里的关系线。
  assert.deepEqual(classLinked(lines("classDiagram", '  class A["OA-001 甲"]', "  A : +String 名称", "  %% A --> B", "  note for A \"OA-001 --> OA-002\""), ["OA"]), []);
  assert.deepEqual(classLinked("classDiagram\n  A --> B", []), []);
});

test("一张图的节点与连线（流程图写法）：节点的文字与里面的条目编号，连线的两端与线上写的字", () => {
  const graph = diagramGraph(lines(
    "flowchart LR",
    '  reader(["OA-002 读者"])',
    '  clerk(["OA-009 借还台馆员"]):::role',
    "  subgraph 图书馆系统",
    '    borrow(["OA-001 借书"])',
    '    reserve(["预约取书"])',
    "  end",
    "  classDef role fill:#eee",
    "  reader -- 发起 --> borrow",
    "  clerk -->|办理| borrow",
    "  reader --> reserve",
    '  clerk -. "上架、放回" .-> reserve',
    "  reader & clerk == 都能查 ==> q[查询]; q --> log[(日志)] --> done{{完成}}",
  ), ["OA", "UC"]);
  assert.deepEqual(graph.nodes, [
    { name: "reader", text: "OA-002 读者", items: ["OA-002"] },
    { name: "clerk", text: "OA-009 借还台馆员", items: ["OA-009"] },
    { name: "borrow", text: "OA-001 借书", items: ["OA-001"] },
    { name: "reserve", text: "预约取书", items: [] },
    { name: "q", text: "查询", items: [] },
    { name: "log", text: "日志", items: [] },
    { name: "done", text: "完成", items: [] },
  ]);
  assert.deepEqual(graph.edges, [
    { from: "reader", to: "borrow", label: "发起" },
    { from: "clerk", to: "borrow", label: "办理" },
    { from: "reader", to: "reserve", label: "" },
    { from: "clerk", to: "reserve", label: "上架、放回" },
    { from: "reader", to: "q", label: "都能查" },
    { from: "clerk", to: "q", label: "都能查" },
    { from: "q", to: "log", label: "" },
    { from: "log", to: "done", label: "" },
  ]);
});

test("一张图的节点与连线：不带空格的连线、没有另写文字的节点、文字里的括号与箭头、判断节点", () => {
  const graph = diagramGraph(lines(
    "graph TD",
    "  A-->B",
    '  B --> c{"金额大于 500（含）--> 复核？"}',
    "  c -- 是 --> d[\"UC-002 主管复核 [加急]\"]",
    "  c -- 否 --> e([结束])",
    "  style d fill:#fff",
    "  click e callback",
  ), ["UC"]);
  assert.deepEqual(graph.nodes.map((one) => [one.name, one.text, one.items]), [
    ["A", "A", []], ["B", "B", []], ["c", "金额大于 500（含）--> 复核？", []], ["d", "UC-002 主管复核 [加急]", ["UC-002"]], ["e", "结束", []],
  ]);
  assert.deepEqual(graph.edges.map((one) => `${one.from}>${one.to}:${one.label}`), ["A>B:", "B>c:", "c>d:是", "c>e:否"]);
});

test("一张图的节点与连线（类图写法）：类的文字里的条目编号，关系线的两端与冒号后面的说明；成员不算", () => {
  const graph = diagramGraph(lines(
    "classDiagram",
    '  class Loan["OA-003 借阅记录"] {',
    "    +Date 借出日期",
    "  }",
    '  class Book["OA-002 图书"]',
    '  Reader "1" --> "0..*" Loan : 办理',
    "  Loan --> Book",
    "  `OA-007 馆藏副本` *-- Book : 属于",
  ), ["OA"]);
  assert.deepEqual(graph.nodes, [
    { name: "Loan", text: "OA-003 借阅记录", items: ["OA-003"] },
    { name: "Book", text: "OA-002 图书", items: ["OA-002"] },
    { name: "Reader", text: "Reader", items: [] },
    { name: "`OA-007 馆藏副本`", text: "OA-007 馆藏副本", items: ["OA-007"] },
  ]);
  assert.deepEqual(graph.edges, [
    { from: "Reader", to: "Loan", label: "办理" }, { from: "Loan", to: "Book", label: "" }, { from: "`OA-007 馆藏副本`", to: "Book", label: "属于" },
  ]);
  // 对象关系图里有连线的条目照旧算得出（与拆出来的关系线是同一份）。
  assert.deepEqual(classLinked(lines("classDiagram", '  class Loan["OA-003 借阅记录"]', '  class Book["OA-002 图书"]', "  Loan --> Book"), ["OA"]), ["OA-003", "OA-002"]);
});

test("一张图的节点与连线：状态图、时序图与空文本给空的；没有前缀可认时节点照有、条目编号是空的", () => {
  assert.deepEqual(diagramGraph("stateDiagram-v2\n  [*] --> 在架\n  在架 --> 借出 : 借书", ["OA"]), { nodes: [], edges: [] });
  assert.deepEqual(diagramGraph("sequenceDiagram\n  a->>b: 说", ["OA"]), { nodes: [], edges: [] });
  assert.deepEqual(diagramGraph("", ["OA"]), { nodes: [], edges: [] });
  assert.deepEqual(diagramGraph('%% 注释\nflowchart LR\n  a["OA-001 借书"] --> b', []), { nodes: [{ name: "a", text: "OA-001 借书", items: [] }, { name: "b", text: "b", items: [] }], edges: [{ from: "a", to: "b", label: "" }] });
});
