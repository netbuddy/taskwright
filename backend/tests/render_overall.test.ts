/**
 * 文档模板的几种新写法（src/render.ts）：按列表字段的每个值归组（一个条目有几个值就进几个组，没有值的不进，组的先后照字段声明的取值，
 * 条件里可以按组名去掉某一组）；列表字段逐项输出；字段有内容才写的一段；取首段与用顿号连接。原有的写法不受影响。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import * as library from "../src/library.ts";
import * as render from "../src/render.ts";
import { makeTypedTask, tempDir } from "./helpers.ts";
import { DEFINITION, READY, build, page } from "./overall_stack.ts";

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = build(tmp, "task", DEFINITION, [
    [
      page({ 标题: "预约取书", 别名: ["预约", "预留"], 标签: ["流程", "概念"], 它是什么: "读者对在架的书办预约。\n\n它与排队等书不是一回事。",
        例子: ["小王周六预约了《算法导论》。", "反例：小李登记的是排队。"], 已经定下的: ["只有在架的书才能预约取书。"] }),
      page({ 标题: "读者", 标签: ["角色"], 它是什么: "持有借书证的人。" }),
      page({ 标题: "保留期", 标签: ["概念"], 它是什么: "书在预留架上留着的那几天。" }),
      page({ 标题: "草稿", 它是什么: "还没有想清楚。" }),                                    // 没有贴标签
    ],
    [READY],
    [{ op: "update", item: "OA-003", base_revision: 1, fields: { 状态: "已废弃" } }],
  ]);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function rendered(template: string): string {
  mkdirSync(join(ws, "docs", "templates"), { recursive: true });
  writeFileSync(join(ws, "docs", "templates", "demo.md"), template, "utf-8");
  return render.render(ws, library.libraryOf(ws));
}

test("按列表字段的每个值归组：有几个值进几个组，没有值的不进；组的先后照取值的声明；条件照常筛条目", () => {
  const text = rendered("{{#按 标签 逐值归组 总体分析 状态=在用}}### {{组名}}\n{{#组内每个}}- {{编号}} {{标题}}\n{{/组内每个}}{{/按}}");
  // 取值的声明次序是概念、角色、流程、场景、目标、范围……；已废弃的 OA-003 被条件筛掉，没有标签的 OA-004 不进任何组。
  assert.equal(text, "### 概念\n- OA-001 预约取书\n### 角色\n- OA-002 读者\n### 流程\n- OA-001 预约取书\n### 范围\n- OA-005 馆藏范围\n");
});

test("条件里按组名去掉或只留某一组", () => {
  assert.equal(rendered("{{#按 标签 逐值归组 总体分析 状态=在用 组!=概念 组!=范围}}[{{组名}}]{{#组内每个}}{{编号}} {{/组内每个}}\n{{/按}}"), "[角色]OA-002 [流程]OA-001 ");
  assert.equal(rendered("{{#按 标签 逐值归组 总体分析 组=概念}}[{{组名}}]{{#组内每个}}{{编号}} {{/组内每个}}\n{{/按}}"), "[概念]OA-001 OA-003 ");
  // 一个条目都没有时整段不输出。
  assert.equal(rendered("开头\n{{#按 标签 逐值归组 总体分析 组=决定}}[{{组名}}]\n{{/按}}结尾\n"), "开头\n结尾\n");
});

test("原来的按字段归组照旧：列表字段的几个值连成一个组名，没有值的归「（未填）」", () => {
  const text = rendered("{{#按 标签 归组 总体分析 状态=在用}}[{{组名}}]{{#组内每个}}{{编号}} {{/组内每个}}\n{{/按}}");
  assert.equal(text, "[流程、概念]OA-001 [角色]OA-002 [（未填）]OA-004 [范围]OA-005 ");
});

test("列表字段逐项输出：每一项一行，带序号；字段是空的时整段不输出", () => {
  const text = rendered("{{#每个 总体分析 状态=在用}}## {{标题}}\n{{#逐项 例子}}{{序号}}) {{项}}\n{{/逐项}}{{#逐项 已经定下的}}- {{项}}（{{编号}}）\n{{/逐项}}{{/每个}}");
  assert.equal(text, "## 预约取书\n1) 小王周六预约了《算法导论》。\n2) 反例：小李登记的是排队。\n- 只有在架的书才能预约取书。（OA-001）\n"
    + "## 读者\n## 草稿\n## 馆藏范围\n1) 《算法导论》在三楼科技书库。\n");
});

test("字段有内容才写的一段；取首段；用顿号连接（空的时候什么都不写）", () => {
  const text = rendered("{{#每个 总体分析 标签=概念 状态=在用}}- **{{标题}}**{{#有 别名}}（又叫{{别名|顿号}}）{{/有}}：{{它是什么|首段}}\n{{/每个}}"
    + "{{#每个 总体分析 标签=角色}}- {{标题}}[{{别名|顿号}}]{{#有 例子}}有例子{{/有}}\n{{/每个}}");
  assert.equal(text, "- **预约取书**（又叫预约、预留）：读者对在架的书办预约。\n- 读者[]\n");
  // 不带取法时照旧：整段文字（换行成空格），空的写「（空）」。
  assert.equal(rendered("{{#每个 总体分析 标签=流程}}{{它是什么}}|{{上级主题}}\n{{/每个}}"), "读者对在架的书办预约。  它与排队等书不是一回事。|（空）\n");
  assert.throws(() => rendered("{{#每个 总体分析}}{{标题|大写}}{{/每个}}"),
    (error: unknown) => error instanceof ApiError && error.code === "bad_request" && /文档模板里的「标题\|大写」写得不对：字段名后面只能跟「首段」或「顿号」。/.test(error.message));
});

test("几种写法合在一起：术语表一节与按标签归组的总体描述（照产品模板的样子）", () => {
  const text = rendered([
    "## 术语",
    "{{#每个 总体分析 标签=概念 状态=在用}}",
    "- **{{标题}}**{{#有 别名}}（又叫{{别名|顿号}}）{{/有}}：{{它是什么|首段}}",
    "{{/每个}}",
    "## 总体描述",
    "{{#按 标签 逐值归组 总体分析 状态=在用 组!=概念}}",
    "### {{组名}}",
    "{{#组内每个}}",
    "**{{标题}}**（{{编号}}）：{{它是什么}}",
    "{{#逐项 例子}}",
    "- 例：{{项}}",
    "{{/逐项}}",
    "{{#有 已经定下的}}",
    "已经定下的：",
    "{{#逐项 已经定下的}}",
    "{{序号}}. {{项}}",
    "{{/逐项}}",
    "{{/有}}",
    "{{/组内每个}}",
    "{{/按}}",
    "",
  ].join("\n"));
  assert.equal(text, [
    "## 术语",
    "- **预约取书**（又叫预约、预留）：读者对在架的书办预约。",
    "## 总体描述",
    "### 角色",
    "**读者**（OA-002）：持有借书证的人。",
    "### 流程",
    "**预约取书**（OA-001）：读者对在架的书办预约。  它与排队等书不是一回事。",
    "- 例：小王周六预约了《算法导论》。",
    "- 例：反例：小李登记的是排队。",
    "已经定下的：",
    "1. 只有在架的书才能预约取书。",
    "### 范围",
    "**馆藏范围**（OA-005）：本馆全部可以外借的纸质图书。",
    "- 例：《算法导论》在三楼科技书库。",
    "",
  ].join("\n"));
});

test("产品的任务类型：新建的任务按模板生成文档，术语与定义取标签含概念的主题，总体描述按别的标签归组，没有标签与已废弃的不进文档", () => {
  const material = "被借走的书可以预约。书还回来以后，系统通知预约的读者，这本书为他保留 3 天。读者凭借书证借书。";
  const source = (excerpt: string, supports?: unknown[]) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt, ...(supports ? { supports } : {}) });
  const topic = (fields: Record<string, unknown>, sources: unknown[]) => ({ op: "add", collection: "总体分析", fields: { 状态: "在用", ...fields }, sources });
  const typed = makeTypedTask(join(tmp, "typed"), "srs-authoring", { "材料.md": material }, [
    [
      topic({ 标题: "预约", 别名: ["预约取书"], 标签: ["概念", "流程"], 它是什么: "被借走的书可以预约。", 例子: ["书还回来以后，系统通知预约的读者"],
        已经定下的: ["这本书为他保留 3 天。"] }, [source("被借走的书可以预约。", [{ field: "它是什么" }]), source("书还回来以后，系统通知预约的读者", [{ field: "例子", index: 0 }]),
        source("这本书为他保留 3 天。", [{ field: "已经定下的", index: 0 }])]),
      topic({ 标题: "读者", 标签: ["角色"], 它是什么: "读者凭借书证借书。" }, [source("读者凭借书证借书。")]),
      topic({ 标题: "草稿", 它是什么: "读者凭借书证借书。" }, [source("读者凭借书证借书。")]),
    ],
    [{ op: "add", collection: "功能用例", fields: { 用例名称: "预约图书", 用例功能: "读者预约被借走的书。", 参与者: ["读者"], 基本流程: ["读者选书", "系统登记预约"] },
      sources: [{ kind: "条目", locator: "OA-001", excerpt: "被借走的书可以预约。" }] }],
  ]);
  const text = render.render(typed, library.libraryOf(typed));
  const section = (from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));
  assert.equal(section("## 1 术语与定义", "## 2 总体描述").trim(),
    "## 1 术语与定义\n\n- **预约**（OA-001），又叫预约取书：被借走的书可以预约。 ［修订 1 · 未确认］");
  const overall = section("## 2 总体描述", "## 3 功能需求");
  // 概念那一组不在总体描述里；取值的次序里角色在流程前面。
  assert.deepEqual([...overall.matchAll(/^### (.+)$/gm)].map((m) => m[1]), ["角色", "流程"]);
  assert.match(overall, /### 角色\n\n\*\*OA-002 读者\*\* ［修订 1 · 未确认］\n\n读者凭借书证借书。\n\n来源：文档原文，出处 inputs\/材料\.md（「读者凭借书证借书。」）/);
  assert.match(overall, /### 流程\n\n\*\*OA-001 预约\*\* ［修订 1 · 未确认］\n\n被借走的书可以预约。\n\n例子：\n\n- 书还回来以后，系统通知预约的读者\n\n已经定下的：\n\n1\. 这本书为他保留 3 天。\n\n来源：/);
  assert.doesNotMatch(text, /草稿/);
  // 依据主题的用例，来源写成集合名加编号。
  assert.match(section("## 3 功能需求", "## 4 非功能需求"), /来源：总体分析 OA-001（「被借走的书可以预约。」）/);
});
