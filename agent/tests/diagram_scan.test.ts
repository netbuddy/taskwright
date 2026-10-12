/**
 * 从 Mermaid 文本里扫东西（src/lib/diagram_scan.ts）：只按写法找，不解析整张图；认不准的往宽里算。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { contextShape } from "../src/lib/diagram_scan.ts";

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
