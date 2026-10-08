/**
 * 来源提到要素层的迁移：早期版本建的库（来源表没有 element_kind、depends_revision 两列，种类叫「执行者补充」「领域说明」）
 * 在写入一侧下一次打开时迁成现在的样子。行数不变，内容除种类名之外不变；可以重复打开；中途出错整体回退。
 * 迁移之前，只读的一侧（readSources）照迁移的规矩现算，读到的与迁过之后一样。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { unlinkedDomainNotes } from "../src/lib/conditions.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { getItem } from "../src/lib/task_query.ts";
import { itemKey, readSources } from "../src/lib/task_read.ts";
import { DEFINITION_PATH, SOURCE, callIn, demoDefinition, makeWorkspace, query } from "./helpers.ts";

/** 早期版本的来源表。check 为 false 时不带种类的检查，用来放进一行迁不过去的数据。 */
const oldSourceSql = (check = true) => `CREATE TABLE item_source (
  task_id TEXT NOT NULL, item_id TEXT NOT NULL, revision_no INTEGER NOT NULL, position INTEGER NOT NULL, support_no INTEGER NOT NULL,
  kind TEXT NOT NULL ${check ? "CHECK (kind IN ('文档原文', '用户的话', '执行者补充', '领域说明', '用户直接修改'))" : ""},
  locator TEXT NOT NULL, excerpt TEXT NOT NULL, field TEXT, field_index INTEGER, event_seq INTEGER NOT NULL, normalized_value TEXT,
  PRIMARY KEY (task_id, item_id, revision_no, position, support_no)
)`;

const OLD_COLUMNS = "task_id, item_id, revision_no, position, support_no, kind, locator, excerpt, field, field_index, event_seq, normalized_value";

/**
 * 建一个任务再把它的来源表退回早期版本的样子。修订 1：UC-001、UC-002；修订 2：DN-001（来源是助手补充）；
 * 修订 3：UC-001 引用 DN-001；修订 4：DN-001 改了内容；修订 5：UC-002 引用 DN-001；另有一行早期版本写的「用户直接修改」。
 */
function oldWorkspace(check = true): string {
  const def = demoDefinition() as Record<string, any>;
  def.交付物.条目集合.push({ 名称: "领域说明", 编号前缀: "DN", 字段: [{ 名: "标题", 类型: "文本", 必填: true }, { 名: "内容", 类型: "文本", 必填: true }] });
  const dir = makeWorkspace(def);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] },
    { op: "add", collection: "用例", fields: { 名称: "退出", 步骤: ["点退出"] }, sources: [SOURCE] },
  ] });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "领域说明", fields: { 标题: "口令", 内容: "口令是登录时输入的一串字符。" },
    sources: [{ kind: "助手补充", excerpt: "按常识解释这个词" }] }] });
  const cite = (item: string, base: number) => ({ op: "update", item, base_revision: base, fields: { 名称: `${item} 用口令` },
    sources: [{ kind: "条目", locator: "DN-001", excerpt: "登录时输入的一串字符", supports: [{ field: "名称" }] }] });
  saveRevision(callIn(dir), { operations: [cite("UC-001", 1)] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "DN-001", base_revision: 2, fields: { 内容: "口令是登录时输入的一串字符，至少八位。" } }] });
  saveRevision(callIn(dir), { operations: [cite("UC-002", 1)] });
  const db = new DatabaseSync(databasePath(dir));
  db.exec("ALTER TABLE item_source RENAME TO item_source_now");
  db.exec(oldSourceSql(check));
  db.exec(`INSERT INTO item_source (${OLD_COLUMNS}) SELECT task_id, item_id, revision_no, position, support_no,
    CASE kind WHEN '助手补充' THEN '执行者补充' WHEN '条目' THEN '领域说明' ELSE kind END,
    CASE WHEN kind = '助手补充' THEN '执行者补充' ELSE locator END, excerpt, field, field_index, event_seq, normalized_value FROM item_source_now`);
  db.exec(`INSERT INTO item_source (${OLD_COLUMNS}) SELECT task_id, 'UC-002', 5, 9, 1, '用户直接修改', 'op-1', '用户改的', '名称', NULL, 1, NULL FROM task`);
  db.exec("DROP TABLE item_source_now");
  db.close();
  return dir;
}

const rows = (dir: string) => query<any>(dir, `SELECT ${OLD_COLUMNS} FROM item_source ORDER BY item_id, revision_no, position, support_no`).map((row) => ({ ...row }));
const columnsOf = (dir: string) => query<{ name: string }>(dir, "PRAGMA table_info(item_source)").map((row) => row.name);

test("迁移：写入一侧打开早期版本的库时来源表迁成现在的样子，行数不变，种类改名，别的内容一字不动", () => {
  const dir = oldWorkspace();
  const before = rows(dir);
  assert.ok(!columnsOf(dir).includes("element_kind"));
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.ok(["element_kind", "depends_revision"].every((name) => columnsOf(dir).includes(name)));
  const after = rows(dir);
  assert.equal(after.length, before.length);
  assert.deepEqual(after, before.map((row) => ({
    ...row,
    kind: row.kind === "执行者补充" ? "助手补充" : row.kind === "领域说明" ? "条目" : row.kind,
    locator: row.kind === "执行者补充" ? "助手补充" : row.locator,
  })));
  // 早期版本的两个种类名一行不剩；「用户直接修改」原样留着；产出方都是条目。
  assert.equal(query(dir, "SELECT 1 FROM item_source WHERE kind IN ('执行者补充', '领域说明')").length, 0);
  assert.equal(query(dir, "SELECT 1 FROM item_source WHERE kind = '用户直接修改' AND locator = 'op-1'").length, 1);
  assert.deepEqual(query<any>(dir, "SELECT DISTINCT element_kind FROM item_source").map((row) => row.element_kind), ["条目"]);
  // 依据条目的旧行：记下被引用的条目在这条来源所在修订当时的最新修订号。UC-001 是修订 3 引用的（DN-001 当时是修订 2），
  // UC-002 是修订 5 引用的（DN-001 已是修订 4）。别的种类为空。
  assert.deepEqual(query<any>(dir, "SELECT item_id, revision_no, depends_revision FROM item_source WHERE kind = '条目' ORDER BY item_id").map((row) => [row.item_id, row.revision_no, row.depends_revision]),
    [["UC-001", 3, 2], ["UC-002", 5, 4]]);
  assert.deepEqual(query<any>(dir, "SELECT DISTINCT depends_revision FROM item_source WHERE kind <> '条目'").map((row) => row.depends_revision), [null]);
});

test("迁移：迁过的库再打开不重做；之后照常保存，新来源按现在的种类写入", () => {
  const dir = oldWorkspace();
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  const once = query<any>(dir, "SELECT * FROM item_source ORDER BY item_id, revision_no, position, support_no").map((row) => ({ ...row }));
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.deepEqual(query<any>(dir, "SELECT * FROM item_source ORDER BY item_id, revision_no, position, support_no").map((row) => ({ ...row })), once);
  assert.equal(query(dir, "SELECT 1 FROM sqlite_master WHERE name = 'item_source_new'").length, 0);
  const out = saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 3, fields: { 步骤: ["打开页面", "输入口令"] },
    sources: [{ kind: "助手补充", excerpt: "登录总要输入口令", supports: [{ field: "步骤", index: 1 }] }] }] });
  assert.deepEqual(query<any>(dir, "SELECT kind, depends_revision FROM item_source WHERE item_id = 'UC-001' AND revision_no = ? ORDER BY position", out.details.revision_no).map((row) => [row.kind, row.depends_revision]),
    [["文档原文", null], ["条目", 2], ["助手补充", null]]);
});

test("迁移：没有做过迁移的库第一次保存时就迁，同一次保存照常写入", () => {
  const dir = oldWorkspace();
  const before = rows(dir).length;
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-002", base_revision: 5, fields: { 步骤: ["点退出", "回到首页"] } }] });
  assert.ok(columnsOf(dir).includes("element_kind"));
  // UC-002 修订 6 沿用了修订 5 的两条来源（「用户直接修改」不沿用）。
  assert.equal(rows(dir).length, before + 2);
});

test("迁移：中途出错整体回退，库还是早期版本的样子，一行不少", () => {
  const dir = oldWorkspace(false);
  const db = new DatabaseSync(databasePath(dir));
  db.exec(`INSERT INTO item_source (${OLD_COLUMNS}) SELECT task_id, 'UC-001', 1, 8, 1, '现在不认的种类', 'x', 'y', NULL, NULL, 1, NULL FROM task`);
  db.close();
  const before = rows(dir);
  assert.throws(() => withTaskDatabase(dir, { createIfMissing: false }, () => null), /CHECK constraint failed/);
  assert.ok(!columnsOf(dir).includes("element_kind"));
  assert.deepEqual(rows(dir), before);
  assert.equal(query(dir, "SELECT 1 FROM sqlite_master WHERE name = 'item_source_new'").length, 0);
});

test("迁移之前：只读的一侧读到的种类已经是现在的名字，依据的修订照迁移的规矩现算，与迁过之后读到的一样", () => {
  const dir = oldWorkspace();
  const read = () => {
    const db = new DatabaseSync(databasePath(dir), { readOnly: true });
    try {
      const taskId = (db.prepare("SELECT task_id FROM task").get() as { task_id: string }).task_id;
      const sources = readSources(db, taskId);
      return { uc1: sources.get(itemKey("UC-001", 3)), uc2: sources.get(itemKey("UC-002", 5)), dn: sources.get(itemKey("DN-001", 2)),
        unlinked: unlinkedDomainNotes(db, taskId) };
    } finally {
      db.close();
    }
  };
  const before = read();
  assert.deepEqual(before.uc1!.map((one) => [one.种类, one.出处, one.依据的修订]), [["文档原文", "inputs/材料.md", undefined], ["条目", "DN-001", 2]]);
  assert.deepEqual(before.uc2!.map((one) => [one.种类, one.出处, one.依据的修订]), [["文档原文", "inputs/材料.md", undefined], ["条目", "DN-001", 4]]);
  assert.deepEqual(before.dn!.map((one) => [one.种类, one.出处, one.摘录]), [["助手补充", "助手补充", "按常识解释这个词"]]);
  // 完成条件的提示照旧认得出 DN-001 已经被条目引用。
  assert.deepEqual(before.unlinked, []);
  // 给助手看的「查看条目」也是现在的名字。
  assert.match(getItem(dir, { item_id: "DN-001" }).text, /助手补充/);
  assert.doesNotMatch(getItem(dir, { item_id: "DN-001" }).text, /执行者补充/);
  assert.ok(!columnsOf(dir).includes("element_kind"), "只读的一侧不应当迁移");
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.deepEqual(read(), before);
});
