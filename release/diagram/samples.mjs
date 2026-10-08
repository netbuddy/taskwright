// Mermaid texts that release/diagram/prune.mjs runs through the bundled check engine: one that parses and one
// that does not for each diagram type the product accepts (a use case diagram is written as a flowchart), and
// one whose type mermaid does not recognize. `type` is what the engine must report, `error` whether it must
// report a syntax error, `line` the line mermaid must name.
export const SAMPLES = [
  { name: "flowchart", type: "flowchart-v2", error: false, text: "flowchart TD\n  A([买家提交售后申请]) --> B{是否可退}\n  B -- 是 --> C[售后专员审核]\n  subgraph sys[\"售后系统\"]\n    C\n  end\n  B -. 否 .-> D[(记录)]" },
  { name: "flowchart, bracket not closed", type: "flowchart-v2", error: true, line: 2, text: "flowchart TD\n  A[买家提交售后申请 --> B[审核]\n  B --> C[退款]" },
  { name: "flowchart written as graph", type: "flowchart-v2", error: false, text: "graph LR\n  buyer([\"买家\"]) --- UC001([\"UC-001 提交售后申请\"])" },
  { name: "class diagram", type: "classDiagram", error: false, text: "classDiagram\n  class AfterSale[\"售后单\"] {\n    +String 售后单号\n    +提交()\n  }\n  class Refund[\"退款单\"]\n  AfterSale \"1\" --> \"0..1\" Refund : 产生\n  note for Refund \"原路退回\"" },
  { name: "class diagram, brace not closed", type: "classDiagram", error: true, line: 4, text: "classDiagram\n  class AfterSale[\"售后单\"] {\n    +String 售后单号\n  class Refund[\"退款单\"] {\n    +Decimal 金额\n  }" },
  { name: "state diagram", type: "stateDiagram", error: false, text: "stateDiagram-v2\n  [*] --> 待审核 : 买家提交\n  state 待审核 {\n    [*] --> 初审\n    初审 --> 复核\n  }\n  待审核 --> 待退款 : 审核通过\n  note right of 待退款 : 两个工作日内\n  待退款 --> [*]" },
  { name: "state diagram, wrong arrow", type: "stateDiagram", error: true, line: 3, text: "stateDiagram-v2\n  [*] --> 待审核 : 买家提交\n  待审核 -> 待退款 : 审核通过" },
  { name: "sequence diagram", type: "sequence", error: false, text: "sequenceDiagram\n  autonumber\n  actor 买家\n  participant 系统 as 售后系统\n  买家->>系统: 提交售后申请\n  alt 不可退\n    系统-->>买家: 拦下并告知原因\n  else 可退\n    系统-->>买家: 通知审核结果\n  end\n  Note over 买家,系统: 全程留痕" },
  { name: "sequence diagram, colon missing", type: "sequence", error: true, line: 3, text: "sequenceDiagram\n  actor 买家\n  买家->>系统 提交售后申请\n  系统-->>买家: 通知" },
  { name: "not a diagram", type: null, error: false, text: "买家提交售后申请之后，售后专员审核。" },
];
