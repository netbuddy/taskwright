/**
 * 生成文档：按修订整体导出、如实标注确认与评审；文档请求的写法；「用户的话」与「用户直接修改」的出处换成读者看得懂的说法；
 * Word 材料的出处只写文件名；真实任务类型的模板里的领域说明两节；模板的按字段筛选与按字段归组。
 * 对应服务端 Python 测试 test_service_units（文档部分）、test_domain_notes_render、test_docx_material 的导出一条。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import * as library from "../src/library.ts";
import * as render from "../src/render.ts";
import { type Task, wordsLocator } from "../src/service.ts";
import { makeTypedTask, makeWorkspace, tempDir } from "./helpers.ts";

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function template(text: string): void {
  mkdirSync(join(ws, "docs", "templates"), { recursive: true });
  writeFileSync(join(ws, "docs", "templates", "demo.md"), text, "utf-8");
}

const expectApiError = (fn: () => unknown, code: string, pattern?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof ApiError && e.code === code && (!pattern || pattern.test(e.message)));

test("文档按修订整体导出，如实标注确认与评审", () => {
  template("按修订 {{文档修订号}} 生成。\n{{#每个 用例}}- {{编号}} {{名称}}［修订 {{修订号}} · {{确认状态}} · {{评审状态}}］步骤：{{步骤}}\n{{/每个}}" +
    "{{#没有 待定事项}}没有待定事项。\n{{/没有}}");
  const lib = library.libraryOf(ws);
  assert.equal(render.render(ws, lib), "按修订 3 生成。\n- UC-001 买家申请退款［修订 2 · 未确认 · 未评审］步骤：1. 提交申请；2. 系统受理\n");
  assert.equal(render.render(ws, lib, 1), "按修订 1 生成。\n- UC-001 申请退款［修订 1 · 未确认 · 未评审］步骤：1. 提交申请；2. 系统受理\n");
  const only = render.render(ws, lib, 2, ["UC-002"]);
  assert.match(only, /- UC-002 撤销申请［修订 2 · 未确认 · 未评审］/);
  assert.doesNotMatch(only, /UC-001/);
  assert.match(only, /没有待定事项。/);
  expectApiError(() => render.render(ws, lib, 9), "bad_request", /还没有修订 9，最新是修订 3/);
  expectApiError(() => render.render(ws, lib, 3, ["UC-002"]), "bad_request", /修订 3 时交付物里没有这些条目：UC-002/);
});

test("用户看过旧修订之后助手又改过：确认状态如实写最后看过的修订；整份数据里仍算已读", () => {
  template("{{#每个 用例}}- {{编号}}［修订 {{修订号}} · {{确认状态}}］\n{{/每个}}");
  const db = library.openRo(ws)!;
  let data;
  try {
    data = library.readAll(db);
  } finally {
    db.close();
  }
  data.confirmations!.push({ item_id: "UC-001", revision_no: 1, attitude: "接受", created_at: "2026-09-23T10:00:00.000", basis: '[{"依据": "已读"}]', call_id: "ui-op-9", judgement_id: 99 });
  const lib = new library.Library(data);
  assert.equal(render.render(ws, lib), "- UC-001［修订 2 · 用户最后看过修订 1，之后由助手改为修订 2］\n");
  assert.equal(render.render(ws, lib, 1), "- UC-001［修订 1 · 已确认（已读）］\n");
  const uc = lib.taskView().items.find((i) => i.item_id === "UC-001")!;
  assert.deepEqual([uc.viewed, uc.confirmation_basis, uc.confirmation_stale], [true, "viewed", true]);
});

test("文档请求的写法：旧的 selection 不再认，修订号要从 1 起的整数", () => {
  assert.deepEqual(render.documentRequest({}), [null, null]);
  assert.deepEqual(render.documentRequest({ revision_no: 2, items: ["UC-001"] }), [2, ["UC-001"]]);
  assert.deepEqual(render.documentRequest({ selection: [{ item_id: "UC-001", version_no: 1 }] }), [null, null]);
  expectApiError(() => render.documentRequest({ revision_no: 0 }), "bad_request");
  expectApiError(() => render.documentRequest({ revision_no: true }), "bad_request");
  expectApiError(() => render.documentRequest({ items: [1] }), "bad_request");
});

// ───────────── 出处的写法 ─────────────

describe("「用户的话」的出处换成会话名称与用户的第几句话", () => {
  const msg = (id: string, parentId: string | null, role: string, text: string) =>
    ({ type: "message", id, parentId, timestamp: "2026-09-22T10:00:00Z", message: { role, content: [{ type: "text", text }] } });
  const entries = [{ type: "session", id: "S1", timestamp: "2026-09-22T10:00:00Z" },
    msg("u1", null, "user", "请整理材料"), msg("a1", "u1", "assistant", "好的"), msg("u2", "a1", "user", "罚款在服务台缴纳"), msg("a2", "u2", "assistant", "记下了")];
  const fakeTask = (name: string | null) => ({
    executor: { entries: async (sid: string) => (sid === "S1" ? entries : []), listSessions: () => [{ session_id: "S1", name }] },
  }) as unknown as Task;
  const words = (locator: string) => ({ 种类: "用户的话", 出处: locator, 摘录: "", 第几条: 1, 事件序号: 1, 支持: [] });
  const lib = { data: { sources: new Map([["UC-001\u00001", [words("S1#u2"), words("S9#u1")]]]) } } as any;

  test("换算成会话名称与用户的第几句话；找不到时为空", async () => {
    const locate = await wordsLocator(fakeTask("整理需求"), lib);
    assert.equal(locate("S1#u2"), "会话「整理需求」里用户的第 2 句话");
    assert.equal((await wordsLocator(fakeTask(null), lib))("S1#u1"), "对话里用户的第 1 句话");
    assert.equal(locate("S1#不存在"), null);
    assert.equal(locate("S9#u1"), null);
    assert.equal(locate("没有井号"), null);
  });

  test("渲染不把内部编号印进文档", async () => {
    const fake = { sourcesOf: () => [{ kind: "用户的话", locator: "S1#u2", excerpt: "罚款在服务台缴纳" }, { kind: "文档原文", locator: "inputs/a.md", excerpt: "原文" }] } as any;
    assert.equal(render.sourcesText(fake, "UC-001", 1, await wordsLocator(fakeTask("整理需求"), lib)),
      "用户的话，出处 会话「整理需求」里用户的第 2 句话（「罚款在服务台缴纳」）；文档原文，出处 inputs/a.md（「原文」）");
    assert.equal(render.sourcesText(fake, "UC-001", 1), "用户的话，出处 对话里用户说的话（「罚款在服务台缴纳」）；文档原文，出处 inputs/a.md（「原文」）");
  });
});

describe("「用户直接修改」的出处换成用户在界面上的第几次修改", () => {
  const edit = (op: string, seq: number) => ({ 种类: "用户直接修改", 出处: op, 摘录: "新值", 第几条: 1, 事件序号: seq, 支持: [] });
  const fakeLib = () => {
    const sources = new Map<string, any[]>([
      ["UC-001\u00002", [edit("ui-op-b", 7)]], ["UC-001\u00003", [edit("ui-op-b", 7), edit("ui-op-c", 9)]],
      ["UC-002\u00002", [edit("ui-op-a", 5)]], ["UC-002\u00001", [{ 种类: "文档原文", 出处: "inputs/a.md", 摘录: "原文", 第几条: 1, 事件序号: 2, 支持: [] }]],
    ]);
    return {
      data: { sources, event_meta: new Map([[5, { at: "2026-09-22T17:55:20.939" }], [7, { at: "2026-09-22T18:01:02.000" }], [9, { at: "" }]]) },
      sourcesOf: (itemId: string, no: number) => (sources.get(`${itemId}\u0000${no}`) ?? []).map(library.sourceView),
    } as any;
  };

  test("按写入先后编号并带上时刻", () => {
    const locate = render.editLocator(fakeLib());
    assert.equal(locate("ui-op-a"), "用户在界面上的第 1 次修改（2026-09-22 17:55）");
    assert.equal(locate("ui-op-b"), "用户在界面上的第 2 次修改（2026-09-22 18:01）", "沿用到后一版的同一个来源不重复计数");
    assert.equal(locate("ui-op-c"), "用户在界面上的第 3 次修改", "没有时刻就不写括号");
    assert.equal(locate("ui-op-zzz"), null);
  });

  test("渲染不把操作编号印进文档", () => {
    const lib = fakeLib();
    assert.equal(render.sourcesText(lib, "UC-002", 2, null, render.editLocator(lib)), "用户直接修改，出处 用户在界面上的第 1 次修改（2026-09-22 17:55）（「新值」）");
    assert.equal(render.sourcesText(lib, "UC-002", 2), "用户直接修改，出处 用户在界面上的修改（「新值」）");
  });
});

test("导出文档里 Word 材料的出处只写文件名", () => {
  const lib = { sourcesOf: () => [{ kind: "文档原文", locator: "inputs/需求.docx#p76", excerpt: "逾期的每本每天罚款一角" }, { kind: "文档原文", locator: "inputs/a.md", excerpt: "原文" }] } as any;
  assert.equal(render.sourcesText(lib, "UC-001", 1), "文档原文，出处 inputs/需求.docx（「逾期的每本每天罚款一角」）；文档原文，出处 inputs/a.md（「原文」）");
});

// ───────────── 真实任务类型的模板：领域说明 ─────────────

describe("软件需求规格说明模板里的领域说明", () => {
  const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "读者凭口令登录。" };
  const note = (title: string, category: string, content: string) => ({ op: "add", collection: "领域说明", fields: { 标题: title, 内容: content, 类别: category }, sources: [SOURCE] });
  let text: string;
  let typed: string;
  before(() => {
    typed = makeTypedTask(join(tmp, "typed"), "srs-authoring", { "材料.md": "读者凭口令登录。管理员在服务台办理借还。" }, [
      [note("口令", "术语", "读者登录时输入的一串字符"), note("管理员", "角色", "在服务台办理借还的工作人员"), note("开学第一周", "背景", "借还量最大的一周"), note("借阅", "术语", "读者把书借走")],
      [{ op: "add", collection: "功能用例", fields: { 用例名称: "登录", 用例功能: "读者登录系统。", 参与者: ["读者"], 基本流程: ["输入口令"] },
        sources: [SOURCE, { kind: "领域说明", locator: "DN-001", excerpt: "读者登录时输入的一串字符", supports: [{ field: "基本流程", index: 0 }] }] }],
    ]);
    text = render.render(typed, library.libraryOf(typed));
  });
  const section = (title: string) => {
    const start = text.indexOf(`## ${title}`);
    const end = text.indexOf("\n## ", start + 1);
    return text.slice(start, end >= 0 ? end : undefined);
  };

  test("功能需求之前多了两节，后面的章节顺延编号", () => {
    assert.deepEqual(text.split("\n").filter((l) => l.startsWith("## ")), ["## 1 术语与定义", "## 2 总体描述", "## 3 功能需求", "## 4 非功能需求", "## 5 约束", "## 6 问题"]);
  });
  test("术语与定义只收类别为术语的，按编号排", () => {
    const terms = section("1 术语与定义");
    assert.ok(terms.includes("- **口令**（DN-001）：读者登录时输入的一串字符 ［修订 1 · 未确认］来源：文档原文，出处 inputs/材料.md（「读者凭口令登录。」）"));
    assert.ok(terms.indexOf("DN-001") < terms.indexOf("DN-004"));
    assert.ok(!terms.includes("DN-002") && !terms.includes("DN-003"));
  });
  test("总体描述收其余的，按类别归组，组的先后按每组第一个编号", () => {
    const overview = section("2 总体描述");
    assert.ok(overview.indexOf("### 角色") < overview.indexOf("### 背景"));
    assert.ok(overview.includes("- **DN-002 管理员**：在服务台办理借还的工作人员"));
    assert.ok(overview.includes("- **DN-003 开学第一周**：借还量最大的一周"));
    assert.ok(!overview.includes("DN-001") && !overview.includes("本文档没有总体描述。"));
  });
  test("定义视图带上集合的界面一项，没写的集合为空", () => {
    const view = library.definitionView(library.libraryOf(typed).definition).collections;
    const notes = view.find((c) => c.name === "领域说明")!;
    assert.deepEqual(notes.display, { side_tab: true, group_field: "类别", leading_groups: ["术语"], note: "材料里或你说明过的背景、术语、角色，供条目引用。" });
    assert.equal(view.find((c) => c.name === "功能用例")!.display, null);
    assert.equal(notes.needs_review, false);
  });
  test("领域说明作来源写成编号加摘录", () => {
    const uc = section("3 功能需求");
    assert.ok(uc.includes("领域说明 DN-001（「读者登录时输入的一串字符」）"));
    assert.ok(!uc.includes("出处 DN-001"));
  });
});

// ───────────── 模板写法本身：用最小的假交付物测，不经真库 ─────────────

describe("模板的按字段筛选与按字段归组", () => {
  const ROWS: [string, Record<string, unknown>][] = [["N-1", { 类别: "术语", 标签: ["甲"] }], ["N-2", { 类别: "角色", 标签: ["乙"] }],
    ["N-3", { 类别: "术语", 标签: ["甲", "乙"] }], ["N-4", { 类别: "", 标签: [] }], ["N-5", { 类别: "角色" }]];
  const run = (text: string, rows = ROWS) => {
    const dir = join(tmp, `tpl-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "t.md"), text, "utf-8");
    const fields = new Map(rows);
    const lib = {
      definition: { 文档模板: "t.md" },
      collections: new Map([["说明", { 字段: [{ 名: "类别", 类型: "文本" }, { 名: "标签", 类型: "文本列表" }] }]]),
      items: new Map(rows.map(([id], n) => [id, { collection: "说明", serial: n + 1 }])),
      contents: new Map(), data: { sources: new Map(), event_meta: new Map() },
      latestRevision: () => 1, aliveAt: () => rows.map(([id]) => [id, 1]), fieldsOf: (id: string) => fields.get(id),
      sourcesOf: () => [], reviewsOf: () => [], confirmationsOf: () => [], activeWaiver: () => null,
    } as any;
    return render.render(dir, lib);
  };

  test("按字段值筛选：等于与不等于、列表按含有比、几个条件同时成立", () => {
    assert.equal(run("{{#每个 说明 类别=术语}}{{编号}} {{/每个}}"), "N-1 N-3 ");
    assert.equal(run("{{#每个 说明 类别!=术语}}{{编号}} {{/每个}}"), "N-2 N-4 N-5 ");
    assert.equal(run("{{#每个 说明 标签=乙}}{{编号}} {{/每个}}"), "N-2 N-3 ");
    assert.equal(run("{{#每个 说明 类别=术语 标签!=乙}}{{编号}} {{/每个}}"), "N-1 ");
    assert.equal(run("{{#没有 说明 类别=例子}}没有例子{{/没有}}{{#没有 说明 类别=术语}}没有术语{{/没有}}"), "没有例子");
  });
  test("按字段归组：组名、组内每个、空值一组、没有条目时整段不输出", () => {
    assert.equal(run("{{#按 类别 归组 说明}}[{{组名}}]{{#组内每个}}{{编号}},{{/组内每个}}\n{{/按}}"), "[术语]N-1,N-3,[角色]N-2,N-5,[（未填）]N-4,");
    assert.equal(run("{{#按 类别 归组 说明 类别!=术语}}[{{组名}}]{{#组内每个}}{{编号}},{{/组内每个}}{{/按}}"), "[角色]N-2,N-5,[（未填）]N-4,");
    assert.equal(run("前{{#按 类别 归组 说明 类别=例子}}[{{组名}}]{{/按}}后"), "前后");
  });
  test("筛选条件写错时说清楚", () => {
    expectApiError(() => run("{{#每个 说明 类别}}{{编号}}{{/每个}}"), "bad_request", /「类别」写得不对/);
  });
  test("替换文字里的 $ 符号原样保留", () => {
    assert.equal(run("{{#每个 说明}}{{类别}}$&{{/每个}}", [["N-1", { 类别: "$1 与 $&" }]]), "$1 与 $&$&");
  });
});
