/**
 * 生成文档里的业务说明七章、追溯附录与目录（src/render_chapters.ts）：章与节号同页面的目录，图放在它说明的那一节，
 * 角色与用例对照表、规则表、目标树、决策记录都是算出来的；没了结的问题标【待澄清】，带「待定」的句子标【待定】。
 */

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as library from "../src/library.ts";
import * as render from "../src/render.ts";
import { tableOfContents } from "../src/render_chapters.ts";
import { makeTypedTask, tempDir } from "./helpers.ts";

const MATERIAL = ["读者凭借书证在自助机上借书。", "馆员把预约的书放到预留架。", "学生一次最多借 5 本。", "本期只做馆内借还。", "读者不用排队就能借书。"];
const doc = (n: number, supports?: unknown[]) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL[n], ...(supports ? { supports } : {}) });
const page = (fields: Record<string, unknown>, sources: unknown[]) => ({ op: "add", collection: "业务说明", fields: { 状态: "在用", ...fields }, sources });
const from = (...ids: string[]) => ids.map((id) => ({ kind: "条目", locator: id }));

let tmp: string;
let ws: string;
let text: string;
before(() => {
  tmp = tempDir();
  ws = makeTypedTask(tmp, "requirements-engineering", { "材料.md": `${MATERIAL.join("\n")}\n` }, [
    [
      page({ 标题: "自助借书", 标签: ["流程"], 它是什么: `${MATERIAL[0]}\n\n系统登记借出与应还日期。`, 例子: ["小陈周三借了两本书。", "例外：借书证过期时自助机拒绝借书。"],
        已经定下的: [MATERIAL[2], "待定：借书证丢失的读者能不能借书"] },
        [doc(0, [{ field: "它是什么" }, { field: "例子" }]), doc(2, [{ field: "已经定下的", index: 0 }]),
          { kind: "助手补充", excerpt: "这一条还没有定下来。", supports: [{ field: "已经定下的", index: 1, inserted: ["借书证丢失的读者能不能借书"] }] }]),                                  // OA-001
      page({ 标题: "读者", 标签: ["角色"], 它是什么: "办了借书证、来馆里借书的人。" }, [doc(0)]),                                                    // OA-002
      page({ 标题: "馆员", 标签: ["角色"], 它是什么: "在服务台与书库工作的人。" }, [doc(1)]),                                                        // OA-003
      page({ 标题: "借书证", 别名: ["读者证"], 标签: ["概念"], 它是什么: "读者在馆里的身份凭证。\n\n一人一证。", 例子: ["小陈的借书证是学生证。"] }, [doc(0)]),   // OA-004
      page({ 标题: "本期范围", 标签: ["范围"], 它是什么: MATERIAL[3] }, [doc(3)]),                                                                 // OA-005
      page({ 标题: "借还更省事", 标签: ["目标"], 它是什么: MATERIAL[4] }, [doc(4)]),                                                               // OA-006
      page({ 标题: "草稿", 它是什么: "还没有想清楚。" }, [doc(0)]),                                                                                // OA-007，没有贴标签
    ],
    [
      page({ 标题: "借书只在自助机上办", 标签: ["决定"], 上级主题: ["OA-006"], 它是什么: "不设人工借书窗口。", 已经定下的: ["借书不到服务台办。"] },
        [{ kind: "助手补充", excerpt: "据目标推出来的。", supports: [{ field: "它是什么", inserted: ["不设人工借书窗口"] }, { field: "已经定下的", index: 0 }] }]),                                                                                        // OA-008
      page({ 标题: "业务流程导语", 导语所属章: "业务流程", 它是什么: "这一章讲读者怎样借书。" }, [{ kind: "助手补充", excerpt: "据 OA-001 概括。", supports: [{ field: "它是什么", inserted: ["这一章讲读者怎样借书。"] }] }]),             // OA-009
      { op: "add", collection: "问题", sources: [{ kind: "条目", locator: "OA-001", excerpt: MATERIAL[0] }], fields: { 事项: "借书证丢失的读者能不能借书？", 种类: "待澄清", 是否阻断下游: "阻断下游", 状态: "未解决", 关联条目: ["OA-001"] } },
      { op: "add", collection: "问题", sources: [{ kind: "条目", locator: "OA-001", excerpt: MATERIAL[0] }], fields: { 事项: "自助机坏了能不能到服务台借？", 种类: "待澄清", 是否阻断下游: "不阻断", 何时回看: "评审确认时",
        状态: "未解决", 关联条目: ["OA-001"] } },
    ],
    { diagram: { name: "借阅系统的边界", kind: "context", sources: from("OA-002", "OA-003"),
      mermaid: 'flowchart LR\n  r(["OA-002 读者"])\n  subgraph sys["借阅系统"]\n    k["自助机"]\n  end\n  r -- 借书证 --> k' }, said: "画一下" },
    { diagram: { name: "读者与馆员的用例", kind: "use_case", sources: from("OA-002", "OA-003", "OA-001"),
      mermaid: 'flowchart LR\n  r(["OA-002 读者"])\n  l(["OA-003 馆员"])\n  b(["OA-001 自助借书"])\n  s(["上架预约的书"])\n  r -- 发起 --> b\n  l --> s' }, said: "画一下" },
    { diagram: { name: "借阅的对象", kind: "class", sources: from("OA-004"), mermaid: 'classDiagram\n  class Card["OA-004 借书证"]\n  class Loan["借阅记录"]\n  Card "1" --> "0..*" Loan : 留下' }, said: "画一下" },
    { diagram: { name: "自助借书的流程", kind: "flowchart", sources: from("OA-001"),
      mermaid: 'flowchart TD\n  a(["OA-001 自助借书"]) --> b{"借书证有没有过期"}\n  b -- 没有 --> c["登记借出"]\n  b -- 过期 --> d["拒绝借书"]' }, said: "画一下" },
    { diagram: { name: "借书证的状态", kind: "state", sources: from("OA-004"), mermaid: "stateDiagram-v2\n  [*] --> 有效\n  有效 --> 过期" }, said: "画一下" },
    { view: ["OA-001"] },
    [{ op: "add", collection: "功能用例", fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者刷借书证", "系统登记借出"] },
      sources: [{ kind: "条目", locator: "OA-001", excerpt: MATERIAL[0] }, { kind: "图", locator: "D-004", excerpt: "登记借出" }] }],
  ]);
  writeFileSync(join(ws, "docs", "templates", "srs.md"), "# 文档\n\n{{目录}}\n{{业务说明}}\n## 8 功能需求\n\n{{#每个 功能用例}}### {{编号}} {{用例名称}}\n{{/每个}}\n\n{{追溯附录}}\n", "utf-8");
  text = render.render(ws, library.libraryOf(ws));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const part = (from: string, to: string) => text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined);
const headings = () => [...text.matchAll(/^(##|###) (.+?)(?: ［.*］)?$/gm)].map((m) => `${m[1].length === 3 ? "  " : ""}${m[2]}`);

test("七章都在，节号与页面目录相同；没有贴标签的页不成节；第 4 章末尾是术语表；目录列出全部二、三级标题", () => {
  assert.deepEqual(headings(), [
    "目录",
    "1 概述与范围", "  1.1 本期范围",
    "2 角色", "  2.1 读者", "  2.2 馆员",
    "3 业务流程", "  3.1 自助借书",
    "4 业务对象", "  4.1 借书证", "  4.2 术语表",
    "5 业务规则",
    "6 业务目标", "  6.1 借还更省事", "  6.2 借书只在自助机上办",
    "7 决策记录与待澄清事项",
    "8 功能需求", "  UC-001 借书",
    "附录 追溯",
  ]);
  assert.doesNotMatch(text, /草稿|还没有想清楚/);
  // 目录在最前面，不含它自己；条目标题后面方括号里的修订与确认状态不进目录。
  const toc = part("## 目录", "## 1 概述与范围");
  assert.match(toc, /^## 目录\n\n- 1 概述与范围\n  - 1\.1 本期范围\n- 2 角色\n/);
  assert.match(toc, /- 8 功能需求\n  - UC-001 借书\n- 附录 追溯\n\n$/);
  assert.match(text, /^# 文档\n\n## 目录\n\n- 1 /);
  assert.doesNotMatch(toc, /［|目录\n- 目录/);
  // 没有标题的文档没有目录；代码块里以井号开头的行不算标题。
  assert.equal(tableOfContents("只有一段话。\n"), "");
  assert.equal(tableOfContents("## 甲\n\n```mermaid D-1\n## 不是标题\n```\n"), "## 目录\n\n- 甲\n");
});

test("第 1 章：系统边界图画在章首，后面是业务目标摘要与范围一节；图写成带编号的代码块", () => {
  const one = part("## 1 概述与范围", "## 2 角色");
  assert.match(one, /\*\*系统边界图\*\*（D-001 借阅系统的边界）\n\n```mermaid D-001\nflowchart LR\n[\s\S]*?\n```\n\n\*\*业务目标摘要\*\*\n\n- 借还更省事\n\n### 1\.1 本期范围 ［修订 1 · 未确认］\n\n本期只做馆内借还。/);
});

test("第 2 章：角色与用例对照表从用例图算，写明依据哪一张图；没有连线的格子是短横", () => {
  const two = part("## 2 角色", "## 3 业务流程");
  assert.match(two, /\*\*角色与用例对照\*\*\n\n\| 用例 \| 读者 \| 馆员 \| 所属流程 \|\n\|---\|---\|---\|---\|\n\| 自助借书 \| 发起 \| — \| 3\.1 自助借书 \|\n\| 上架预约的书 \| — \| 参与 \| — \|\n\n依据用例图：D-002 读者与馆员的用例。/);
  assert.match(two, /### 2\.1 读者 ［修订 1 · 未确认］\n\n办了借书证、来馆里借书的人。\n\n来源：文档原文，出处 inputs\/材料\.md/);
});

test("第 3 章：章导语在最前；流程节照固定的次序写说明、流程步骤、异常分支、示例、适用规则、待澄清事项、对应的需求条目、来源", () => {
  const three = part("## 3 业务流程", "## 4 业务对象");
  assert.match(three, /^## 3 业务流程\n\n这一章讲读者怎样借书。 ［修订 2 · 未确认］\n\n### 3\.1 自助借书 ［修订 1 · 已确认（已读）］\n\n/);
  const order = ["读者凭借书证在自助机上借书。\n\n系统登记借出与应还日期。", "**流程步骤**（D-004 自助借书的流程）", "```mermaid D-004", "**异常分支**\n\n- 借书证过期时自助机拒绝借书。",
    "**示例**\n\n- 小陈周三借了两本书。", "**适用规则**\n\n1. 学生一次最多借 5 本。\n2. 【待定】待定：借书证丢失的读者能不能借书",
    "**待澄清事项**\n\n- 【待澄清】（阻断下游）借书证丢失的读者能不能借书？（TBD-001）\n- 【待澄清】（不阻断，评审确认时回看）自助机坏了能不能到服务台借？（TBD-002）",
    "**对应的需求条目**\n\n- UC-001 借书", "来源：文档原文"];
  const places = order.map((one) => three.indexOf(one));
  assert.ok(places.every((at, i) => at > 0 && (i === 0 || at > places[i - 1])), JSON.stringify(places));
  // 导语页不成节。
  assert.doesNotMatch(three, /### .*业务流程导语/);
});

test("第 4 章：对象关系图在章首；对象节有示例与状态图，关系指到章首那张图；术语表列标签含概念的页", () => {
  const four = part("## 4 业务对象", "## 5 业务规则");
  assert.match(four, /^## 4 业务对象\n\n\*\*对象关系图\*\*（D-003 借阅的对象）\n\n```mermaid D-003\nclassDiagram/);
  assert.match(four, /### 4\.1 借书证 ［修订 1 · 未确认］\n\n读者在馆里的身份凭证。\n\n一人一证。\n\n\*\*状态图\*\*（D-005 借书证的状态）\n\n```mermaid D-005\nstateDiagram-v2\n[\s\S]*?```\n\n\*\*与其他对象的关系\*\*见第 4 章章首的对象关系图（D-003 借阅的对象）。\n\n\*\*示例\*\*\n\n- 小陈的借书证是学生证。/);
  assert.match(four, /### 4\.2 术语表\n\n\| 术语 \| 又叫 \| 说明 \|\n\|---\|---\|---\|\n\| 借书证 \| 读者证 \| 读者在馆里的身份凭证。 \|\n/);
});

test("第 5、6、7 章：规则表写规则出自哪一节；目标树上决定带着为什么；决策记录与待澄清事项按时间成表，问题标【待澄清】", () => {
  const five = part("## 5 业务规则", "## 6 业务目标");
  assert.match(five, /\| 规则 \| 出自 \| 冲突 \|\n\|---\|---\|---\|\n\| 学生一次最多借 5 本。 \| 3\.1 自助借书 \| — \|\n\| 【待定】待定：借书证丢失的读者能不能借书 \| 3\.1 自助借书 \| — \|\n\| 借书不到服务台办。 \| 6\.2 借书只在自助机上办 \| — \|/);
  const six = part("## 6 业务目标", "## 7 决策记录与待澄清事项");
  assert.match(six, /\*\*目标与决定\*\*\n\n- 借还更省事\n  - 决定：借书只在自助机上办（借书不到服务台办。）\n\n### 6\.1 借还更省事/);
  const seven = part("## 7 决策记录与待澄清事项", "## 8 功能需求");
  assert.match(seven, /\| 时间 \| 类别 \| 事项 \| 说明 \|\n/);
  assert.match(seven, /\| 决定 \| 借书只在自助机上办 \|/);
  assert.match(seven, /\| 待澄清 \| 【待澄清】借书证丢失的读者能不能借书？（TBD-001） \|/);
});

test("追溯附录：每个需求条目依据的节写节号，依据的图写编号与图名；模板里别的写法照旧", () => {
  const tail = part("## 8 功能需求", "");
  assert.match(tail, /^## 8 功能需求\n\n### UC-001 借书\n\n## 附录 追溯\n\n每个需求条目依据了业务说明的哪几节、哪几张图。\n\n\| 需求条目 \| 依据的节 \| 依据的图 \|\n\|---\|---\|---\|\n\| UC-001 借书 \| 3\.1 自助借书 \| D-004 自助借书的流程 \|\n\n$/);
});

test("只选一部分条目：没有选中的页不成节、节号顺延，没有选中的需求条目不进对应的需求条目与附录；一页都没选时七章不写", () => {
  const lib = library.libraryOf(ws);
  const some = render.render(ws, lib, null, ["OA-001", "OA-003", "OA-009"]);
  assert.deepEqual([...some.matchAll(/^### (.+?)(?: ［.*］)?$/gm)].map((m) => m[1]), ["2.1 馆员", "3.1 自助借书"]);
  assert.doesNotMatch(some, /\*\*对应的需求条目\*\*|## 附录 追溯|\*\*待澄清事项\*\*/);
  // 没有内容的章写一句话，不留空章。
  assert.match(some, /## 4 业务对象\n\n\*\*对象关系图\*\*/);
  assert.match(some, /## 6 业务目标\n\n这一章还没有内容。\n\n## 7 /);
  const none = render.render(ws, lib, null, ["UC-001"]);
  assert.doesNotMatch(none, /## 1 概述与范围/);
  assert.match(none, /## 8 功能需求\n\n### UC-001 借书\n\n## 附录 追溯[\s\S]*\| UC-001 借书 \| OA-001 \| D-004 自助借书的流程 \|/);
});

test("没有业务说明这个集合的任务：三个占位都不留痕迹", () => {
  const lib = library.libraryOf(ws);
  // 用同一个库、一份只有占位的模板，把业务说明从选中的条目里全去掉，就是没有内容的情形。
  writeFileSync(join(ws, "docs", "templates", "srs.md"), "开头\n{{目录}}\n{{业务说明}}\n{{追溯附录}}\n结尾\n", "utf-8");
  assert.equal(render.render(ws, lib, null, ["TBD-001"]), "开头\n结尾\n");
});
