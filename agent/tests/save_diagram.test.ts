/**
 * 「保存图」的核心逻辑（lib/save_diagram.ts）与图的读法（lib/diagram.ts）：新增、修改、删除各记一次图自己的修订；
 * 参数与来源的核对；图里写的条目编号与来源对得上；校验不过退回、连续三次之后不再试、校验没有做成时拦下；
 * 同一次调用重发不写第二遍；图的来源与条目的来源在读取处分得开。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { DIAGRAM_KINDS, drawnItemIds, liveDiagrams, readDiagrams } from "../src/lib/diagram.ts";
import {
  GIVE_UP_TEXT, OVER_LIMIT_TEXT, TELL_USER_TEXT, VALIDATION_FAILED_TEXT, type DiagramCheck, type SaveDiagramParams,
  consecutiveDiagramFailures, saveDiagram,
} from "../src/lib/save_diagram.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { rejectionOf } from "../src/lib/tool_rejection.ts";
import { itemKey, readSources } from "../src/lib/task_read.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, demoDefinition, makeWorkspace, query } from "./helpers.ts";

const USER_SAID = "把登录和退出画成一张用例图";
const ok = async (): Promise<DiagramCheck> => ({ ok: true });
const bad = (message = "Mermaid 文本第 2 行附近写得不对，改了再存。"): (() => Promise<DiagramCheck>) =>
  async () => ({ ok: false, reason: "syntax", line: 2, message });

/** 任务里有 UC-001「登录」、UC-002「退出」（修订 1）。 */
function workspace(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] },
    { op: "add", collection: "用例", fields: { 名称: "退出", 步骤: ["点退出"] }, sources: [SOURCE] },
  ] });
  return dir;
}

const call = (dir: string) => ({ ...callIn(dir), userMessages: [{ entryId: "u1", text: `${USER_SAID}，谢谢。` }] });

const MERMAID = 'flowchart LR\n  user(["读者"])\n  a(["UC-001 登录"])\n  b(["UC-002 退出"])\n  user --> a\n  user --> b';
const SOURCES = [{ kind: "用户的话", excerpt: USER_SAID }, { kind: "条目", locator: "UC-001" }, { kind: "条目", locator: "UC-002", excerpt: "退出" }];
const fresh = (over: Partial<SaveDiagramParams> = {}): SaveDiagramParams =>
  ({ name: "登录与退出", kind: "use_case", mermaid: MERMAID, note: "读者能做的两件事。", sources: SOURCES, ...over });

const save = (dir: string, params: SaveDiagramParams, validate = ok, priorFailures = 0) => saveDiagram(call(dir), params, { validate, priorFailures });
const versions = (dir: string, id = "D-001") =>
  query<any>(dir, "SELECT revision_no, op, name, kind, note, actor FROM diagram_version WHERE diagram_id = ? ORDER BY revision_no", id).map((row) => ({ ...row }));
const sourceRows = (dir: string, id: string, revisionNo: number) =>
  query<any>(dir, "SELECT element_kind, position, support_no, kind, locator, excerpt, field, depends_revision FROM item_source WHERE item_id = ? AND revision_no = ? ORDER BY position", id, revisionNo)
    .map((row) => ({ ...row }));

test("新画一张图：编号由工具生成，是这张图的修订 1；来源写在来源表里，产出方是图，依据条目的记下引用时它的修订号、可以不写摘录", async () => {
  const dir = workspace();
  const out = await save(dir, fresh());
  assert.equal(out.text, "已保存图 D-001「登录与退出」（用例图），现在是修订 1。要再改这张图时 diagram 写 D-001、base_revision 写 1。图里画了 2 个条目：UC-001、UC-002。");
  assert.deepEqual({ ...out.details, task_id: null, event_seq: null },
    { task_id: null, diagram_id: "D-001", revision_no: 1, op: "add", name: "登录与退出", kind: "use_case", event_seq: null, saved: true, drawn: ["UC-001", "UC-002"] });
  assert.deepEqual(versions(dir), [{ revision_no: 1, op: "add", name: "登录与退出", kind: "use_case", note: "读者能做的两件事。", actor: "executor" }]);
  assert.deepEqual(sourceRows(dir, "D-001", 1), [
    { element_kind: "图", position: 1, support_no: 1, kind: "用户的话", locator: "session-test#u1", excerpt: USER_SAID, field: null, depends_revision: null },
    { element_kind: "图", position: 2, support_no: 1, kind: "条目", locator: "UC-001", excerpt: "", field: null, depends_revision: 1 },
    { element_kind: "图", position: 3, support_no: 1, kind: "条目", locator: "UC-002", excerpt: "退出", field: null, depends_revision: 1 },
  ]);
  // 图不占任务的修订序号；记了一条图的事件。
  assert.equal(count(dir, "revision"), 1);
  assert.deepEqual(query<any>(dir, "SELECT name, payload FROM event ORDER BY seq DESC LIMIT 1").map((row) => [row.name, JSON.parse(row.payload)]),
    [["DIAGRAM_SAVED", { diagram_id: "D-001", revision_no: 1, op: "add", name: "登录与退出", kind: "use_case" }]]);
  // 第二张图是 D-002，说明可以不写。
  const second = await save(dir, fresh({ name: "只有登录", note: undefined, mermaid: 'flowchart TD\n  a["UC-001 登录"]', sources: [SOURCES[0], SOURCES[1]] }));
  assert.equal(second.details.diagram_id, "D-002");
  assert.deepEqual(versions(dir, "D-002").map((one) => one.note), [""]);
});

test("新画一张图缺项、种类不对、图名太长、写了 base_revision、没有来源，都拒绝并说明，什么都不写", async () => {
  const dir = workspace();
  await assert.rejects(save(dir, { kind: "use_case" }), /这张图没有保存：新画一张图缺少 name（图名）、mermaid（Mermaid 文本）。/);
  await assert.rejects(save(dir, fresh({ kind: "用例图" })), /kind（图的种类）写的是 "用例图"[\s\S]*kind 只能是 use_case（用例图）、class（类图）、state（状态图）、sequence（时序图）、flowchart（流程图） 之一/);
  await assert.rejects(save(dir, fresh({ name: "图".repeat(61) })), /图名有 61 个字，超过了 60 个字/);
  await assert.rejects(save(dir, fresh({ base_revision: 1 })), /新画一张图时写了 base_revision/);
  await assert.rejects(save(dir, fresh({ sources: undefined })), /缺少 sources，至少要有一条来源[\s\S]*用户要你画图的那句话写一条「用户的话」/);
  await assert.rejects(save(dir, fresh({ sources: [{ kind: "用户的话", excerpt: USER_SAID, supports: [{ field: "名称" }] }, SOURCES[1], SOURCES[2]] })),
    /第 1 条来源写了 supports；图没有字段，图的来源不写 supports/);
  await assert.rejects(save(dir, fresh({ sources: [SOURCES[0], SOURCES[1], { kind: "条目", locator: "UC-002", excerpt: "不在里面的话" }] })), /在 UC-002 的当前修订里找不到/);
  await assert.rejects(save(dir, fresh({ sources: [...SOURCES, { kind: "图", locator: "D-001", excerpt: "x" }] })), /种类写成了「图」，这个任务里现在还没有图，这一种还不能用/);
  await assert.rejects(save(dir, fresh({ delete: true })), /要删除图，但没有写是哪一张/);
  assert.equal(count(dir, "diagram"), 0);
  assert.equal(query(dir, "SELECT 1 FROM item_source WHERE element_kind = '图'").length, 0);
  // 拒绝带着事实与指引两层，记拒绝的那一层取得到。
  const error = await save(dir, fresh({ kind: "用例图" })).catch((e: unknown) => e);
  assert.deepEqual(rejectionOf(error)?.reasonKind, "input");
  assert.match(rejectionOf(error)!.guidance, /kind 只能是/);
});

test("图里写的条目编号必须是现有的条目，画进图里的条目必须各有一条种类为「条目」的来源", async () => {
  const dir = workspace();
  await assert.rejects(save(dir, fresh({ mermaid: `${MERMAID}\n  c(["UC-009 续借"])` })),
    /Mermaid 文本里写的条目编号UC-009 在这个任务里不存在[\s\S]*图里只写任务里现有的条目编号/);
  await assert.rejects(save(dir, fresh({ sources: [SOURCES[0], SOURCES[1]] })),
    /图里画了 UC-002，来源里没有写它[\s\S]*各写一条种类为「条目」的来源，出处写条目编号，不用写摘录，例如 \{"kind": "条目", "locator": "UC-002"\}/);
  await assert.rejects(save(dir, fresh({ sources: [SOURCES[0]] })), /图里画了 UC-001、UC-002，来源里没有写它们/);
  // 已经删除的条目也不能画。
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_revision: 1 }] });
  await assert.rejects(save(dir, fresh({ sources: [SOURCES[0], SOURCES[1]] })), /Mermaid 文本里写的条目编号UC-002 已经删除/);
  // 把已经删除的条目写成来源，在来源那一步就拒绝了。
  await assert.rejects(save(dir, fresh()), /第 3 条来源的种类是「条目」，出处 UC-002 指向的条目已在修订 2 删除/);
  assert.equal(count(dir, "diagram"), 0);
  // 依据了没有画进图里的条目是可以的（图的来源不限于画出来的）。
  const out = await save(dir, fresh({ mermaid: 'flowchart LR\n  a(["登录"])', sources: [SOURCES[0], SOURCES[1]] }));
  assert.deepEqual(out.details.drawn, []);
});

test("修改图：只写要改的几项，是它的下一次修订；不写来源就沿用、记的修订号不变，写了就整份替换；base_revision 不对拒绝", async () => {
  const dir = workspace();
  await save(dir, fresh());
  // UC-001 之后改过（任务修订 2）。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  await assert.rejects(save(dir, { diagram: "D-001", name: "改名" }), /修改图 D-001 时没有写 base_revision，或者写的不是整数[\s\S]*D-001 现在是修订 1，base_revision 写 1/);
  await assert.rejects(save(dir, { diagram: "D-001", base_revision: 3, name: "改名" }), /图 D-001 现在是修订 1，你写的 base_revision 是 3[\s\S]*先用 get_item 看 D-001 现在的样子/);
  await assert.rejects(save(dir, { diagram: "D-009", base_revision: 1, name: "改名" }), /这个任务里没有图 D-009[\s\S]*现有的图是：D-001/);
  await assert.rejects(save(dir, { diagram: "UC-001", base_revision: 1, name: "改名" }), /diagram 写的 "UC-001" 不是图的编号/);
  await assert.rejects(save(dir, { diagram: "D-001", base_revision: 1, name: "登录与退出" }), /与它在修订 1 的内容完全一样，没有改动任何东西/);
  // 只改图名：来源沿用，记的修订号还是引用时的 1；不校验（校验函数一调用就算错）。
  const never = async (): Promise<DiagramCheck> => { throw new Error("只改图名不应当校验"); };
  const renamed = await save(dir, { diagram: "D-001", base_revision: 1, name: "读者的两件事" }, never);
  assert.equal(renamed.text, "已修改图 D-001「读者的两件事」（用例图），现在是修订 2。要再改这张图时 diagram 写 D-001、base_revision 写 2。图里画了 2 个条目：UC-001、UC-002。");
  assert.deepEqual(sourceRows(dir, "D-001", 2).map((row) => [row.kind, row.locator, row.depends_revision]), [["用户的话", "session-test#u1", null], ["条目", "UC-001", 1], ["条目", "UC-002", 1]]);
  // 改 Mermaid 文本并重新写来源：整份替换，依据条目的修订号换成现在的。
  let validated: [string, string] | null = null;
  const text = 'flowchart LR\n  a(["UC-001 用口令登录"])';
  await save(dir, { diagram: "D-001", base_revision: 2, mermaid: text, sources: [{ kind: "条目", locator: "UC-001", excerpt: "用口令登录" }] },
    async (kind, mermaid) => { validated = [kind, mermaid]; return { ok: true }; });
  assert.deepEqual(validated, ["use_case", text]);
  assert.deepEqual(sourceRows(dir, "D-001", 3).map((row) => [row.kind, row.locator, row.excerpt, row.depends_revision]), [["条目", "UC-001", "用口令登录", 2]]);
  // 改了文本、画了新的条目而没有重写来源：拒绝。
  await assert.rejects(save(dir, { diagram: "D-001", base_revision: 3, mermaid: MERMAID }), /图里画了 UC-002，来源里没有写它[\s\S]*修改图时给了 sources 就是整份替换/);
  // 只改种类也要校验。
  await assert.rejects(save(dir, { diagram: "D-001", base_revision: 3, kind: "class" }, bad("写的是流程图，不是你说的类图。")), /写的是流程图，不是你说的类图。/);
  assert.deepEqual(versions(dir).map((one) => [one.revision_no, one.op, one.name]), [[1, "add", "登录与退出"], [2, "update", "读者的两件事"], [3, "update", "读者的两件事"]]);
});

test("删除图：记作它的下一次修订，内容照删除之前的样子；删掉的图不能再改，编号不复用", async () => {
  const dir = workspace();
  await save(dir, fresh());
  await assert.rejects(save(dir, { diagram: "D-001", base_revision: 1, delete: true, name: "x" }), /删除图 D-001 时还写了 name[\s\S]*删除时只写 diagram、base_revision 与 delete/);
  await assert.rejects(save(dir, { diagram: "D-001", delete: true }), /删除图 D-001 时没有写 base_revision/);
  const out = await save(dir, { diagram: "D-001", base_revision: 1, delete: true });
  assert.equal(out.text, "已删除图 D-001「登录与退出」（删除记作它的修订 2）。");
  assert.deepEqual(versions(dir).map((one) => [one.revision_no, one.op, one.name]), [[1, "add", "登录与退出"], [2, "delete", "登录与退出"]]);
  assert.deepEqual(query<any>(dir, "SELECT deleted_in_revision FROM diagram").map((row) => row.deleted_in_revision), [2]);
  assert.equal(sourceRows(dir, "D-001", 2).length, 0);
  await assert.rejects(save(dir, { diagram: "D-001", base_revision: 2, name: "再改" }), /图 D-001 已经在它的修订 2 删除了[\s\S]*现有的图是：（一张都没有）/);
  assert.equal((await save(dir, fresh())).details.diagram_id, "D-002");
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    const taskId = (db.prepare("SELECT task_id FROM task").get() as { task_id: string }).task_id;
    const all = readDiagrams(db, taskId);
    assert.deepEqual(all.map((one) => [one.diagram_id, one.deleted_in_revision, one.versions.length]), [["D-001", 2, 2], ["D-002", null, 1]]);
    assert.deepEqual(liveDiagrams(all).map((one) => one.diagram_id), ["D-002"]);
  } finally {
    db.close();
  }
});

test("校验不过：不保存，把校验的话原样交还；这一轮的第三次加一句不要再试；已经三次之后不再校验、直接拒绝", async () => {
  const dir = workspace();
  const first = await save(dir, fresh(), bad()).catch((e: Error) => e);
  assert.equal((first as Error).message, `${VALIDATION_FAILED_TEXT}Mermaid 文本第 2 行附近写得不对，改了再存。\n照上面说的改了再保存。`);
  assert.equal(rejectionOf(first)?.reasonKind, "input");
  const third = await save(dir, fresh(), bad(), 2).catch((e: Error) => e);
  assert.equal((third as Error).message, `${VALIDATION_FAILED_TEXT}Mermaid 文本第 2 行附近写得不对，改了再存。\n${GIVE_UP_TEXT}`);
  assert.match(GIVE_UP_TEXT, /这一轮里图已经连续 3 次没有通过校验，不要再试：用 reply 告诉用户这张图哪里画不出来/);
  const never = async (): Promise<DiagramCheck> => { throw new Error("到了上限不应当再校验"); };
  const fourth = await saveDiagram(call(dir), fresh(), { validate: never, priorFailures: 3 }).catch((e: Error) => e);
  assert.equal((fourth as Error).message, OVER_LIMIT_TEXT);
  assert.equal(count(dir, "diagram"), 0);
  // 删除与只改图名不校验，到了上限也照做。
  await save(dir, fresh());
  await saveDiagram(call(dir), { diagram: "D-001", base_revision: 1, name: "换个名字" }, { validate: never, priorFailures: 3 });
  await saveDiagram(call(dir), { diagram: "D-001", base_revision: 2, delete: true }, { validate: never, priorFailures: 3 });
});

test("校验没有做成：不保存，说明这是程序这边的问题、让助手告诉用户；这种拒绝不算输入不合规", async () => {
  const dir = workspace();
  const unavailable = async (): Promise<DiagramCheck> =>
    ({ ok: false, reason: "unavailable", line: null, message: "这一次没有办法校验 Mermaid 文本（联系不上系统里负责校验的那一部分）。这是程序这边的问题，不是文本写错了，请告诉用户。" });
  const error = await save(dir, fresh(), unavailable).catch((e: Error) => e);
  assert.equal((error as Error).message,
    `这张图没有保存。这一次没有办法校验 Mermaid 文本（联系不上系统里负责校验的那一部分）。这是程序这边的问题，不是文本写错了，请告诉用户。${TELL_USER_TEXT}`);
  assert.ok(!(error as Error).message.includes(VALIDATION_FAILED_TEXT));
  assert.equal(rejectionOf(error), null);
  assert.equal(count(dir, "diagram"), 0);
});

test("同一次调用重发：第一次已经保存，就照第一次的结果交回，不写第二遍", async () => {
  const dir = workspace();
  const same = call(dir);
  const first = await saveDiagram(same, fresh(), { validate: ok });
  const again = await saveDiagram(same, fresh(), { validate: ok });
  assert.equal(again.text, "已保存图 D-001「登录与退出」（用例图），现在是修订 1。要再改这张图时 diagram 写 D-001、base_revision 写 1。\n这次调用之前已经保存过，没有重复写入。");
  assert.equal(again.details.replayed, true);
  assert.equal(again.details.event_seq, first.details.event_seq);
  assert.equal(count(dir, "diagram"), 1);
  assert.equal(count(dir, "diagram_version"), 1);
});

test("校验等待的时候图被别人改了：写库之前重新核对，按新的情况拒绝", async () => {
  const dir = workspace();
  await save(dir, fresh());
  const during = async (): Promise<DiagramCheck> => {
    await saveDiagram(call(dir), { diagram: "D-001", base_revision: 1, note: "别人先改了" }, { validate: ok });
    return { ok: true };
  };
  await assert.rejects(save(dir, { diagram: "D-001", base_revision: 1, mermaid: MERMAID.replace("读者", "持证读者") }, during),
    /图 D-001 现在是修订 2，你写的 base_revision 是 1/);
  assert.deepEqual(versions(dir).map((one) => [one.revision_no, one.note]), [[1, "读者能做的两件事。"], [2, "别人先改了"]]);
});

test("图的来源与条目的来源在读取处分得开：按条目取的读不到图的，按图取的读不到条目的", async () => {
  const dir = workspace();
  await save(dir, fresh());
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    const taskId = (db.prepare("SELECT task_id FROM task").get() as { task_id: string }).task_id;
    const items = readSources(db, taskId);
    const figures = readSources(db, taskId, "图");
    assert.deepEqual([...items.keys()].sort(), [itemKey("UC-001", 1), itemKey("UC-002", 1)]);
    assert.deepEqual([...figures.keys()], [itemKey("D-001", 1)]);
    assert.deepEqual(figures.get(itemKey("D-001", 1))!.map((one) => [one.种类, one.出处, one.依据的修订]),
      [["用户的话", "session-test#u1", undefined], ["条目", "UC-001", 1], ["条目", "UC-002", 1]]);
  } finally {
    db.close();
  }
});

test("图里画了哪些条目：只认「集合的编号前缀-至少三位数字」，前后不挨着字母数字；按第一次出现的先后、不重复", () => {
  const text = 'flowchart LR\n  a(["UC-002 退出"]) --> b["TBD-001：口令几位"]\n  %% UC-001 写在注释里也算\n  c["XUC-003 不算"] --> d["UC-0041 四位也认"]\n  e["UC-01 两位不算，UC-002 重复不算"]\n  f["D-001 图的编号不是条目"]';
  assert.deepEqual(drawnItemIds(text, ["UC", "TBD"]), ["UC-002", "TBD-001", "UC-001", "UC-0041"]);
  assert.deepEqual(drawnItemIds(text, []), []);
  assert.deepEqual(drawnItemIds("classDiagram\n  class Reader", ["UC"]), []);
});

test("数这一轮里图连续几次没有通过校验：别的拒绝不算也不打断，做成一次或者用户说了话就从头数", () => {
  const result = (toolName: string, isError: boolean, text: string) => ({ type: "message", message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] } });
  const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
  const failed = result("save_diagram", true, `${VALIDATION_FAILED_TEXT}第 2 行……`);
  assert.equal(consecutiveDiagramFailures([]), 0);
  assert.equal(consecutiveDiagramFailures([user("画一张图"), failed, failed]), 2);
  // 参数不对的拒绝、校验没有做成、别的工具，都不算也不打断。
  assert.equal(consecutiveDiagramFailures([user("画一张图"), failed, result("save_diagram", true, "这张图没有保存：新画一张图缺少 name（图名）。"),
    result("get_item", false, "……"), result("save_diagram", true, "这张图没有保存。这一次没有办法校验……"), failed, result("save_diagram", true, OVER_LIMIT_TEXT)]), 3);
  // 做成一次就从头数；用户说了话也从头数。
  assert.equal(consecutiveDiagramFailures([user("画一张图"), failed, failed, result("save_diagram", false, "已保存图 D-001"), failed]), 1);
  assert.equal(consecutiveDiagramFailures([user("画一张图"), failed, failed, failed, user("那换成流程图"), failed]), 1);
});

test("图的五个种类", () => {
  assert.deepEqual([...DIAGRAM_KINDS], ["use_case", "class", "state", "sequence", "flowchart"]);
});

test("新建任务时集合的编号前缀不许单写 D（与图的编号同形）", () => {
  const def = demoDefinition() as Record<string, any>;
  def.交付物.条目集合[0].编号前缀 = "D";
  const dir = makeWorkspace(def);
  assert.throws(() => createTask(callIn(dir), { definition_path: DEFINITION_PATH }),
    /任务定义里集合「用例」的编号前缀是 D，与图的编号（D-001 这样）同形，所以没有创建任务。请把这个集合的编号前缀改成别的。/);
});
