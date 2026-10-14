/**
 * 版本记录（src/lib/versions.ts）与任务库格式 7 升 8 那一步（src/lib/schema.ts 的 addVersionRecords）：
 * 记一次发布写什么、怎样读出各版；早先「已完成」的任务升级时补第 1 版；任务定义里缺「总体分析」集合的早先任务照模板补上。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { TASK_DB_VERSION, UPGRADED_VERSION_NOTE, type OverallTemplate, upgradeTaskDatabase, withTaskDatabase } from "../src/lib/schema.ts";
import { stageOf } from "../src/lib/stage_read.ts";
import { EVENT_VERSION_PUBLISHED, nextVersionNo, recordVersion, versionCount, versionRecords } from "../src/lib/versions.ts";
import { DEFINITION_PATH, callIn, demoDefinition, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition()): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
const write = <T>(dir: string, body: (db: DatabaseSync) => T) => withTaskDatabase(dir, { createIfMissing: false }, body);

/** 把一个现在格式的库退回格式 7 的样子：没有版本记录表，版本号记 7；可以顺手改任务的状态与结束时刻。 */
function asVersion7(dir: string, change: (db: DatabaseSync) => void = () => {}): void {
  const db = new DatabaseSync(databasePath(dir));
  try {
    db.exec("DROP TABLE version_record");
    change(db);
    db.exec("PRAGMA user_version = 7");
  } finally {
    db.close();
  }
}

/** 往库里直接写几行修订与一条事件（格式 7 的库，助手一侧的写函数会先把它升级，所以这里不经它们）。 */
function addRevision(db: DatabaseSync, taskId: string, no: number, at: string): number {
  const seq = Number((db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM event").get() as { n: number }).n);
  db.prepare("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (?, ?, 's', ?, 'REVISION_SAVED', '{}', 'executor', ?)")
    .run(seq, taskId, `call-r${no}`, at);
  db.prepare("INSERT INTO revision (task_id, revision_no, session_id, call_id, event_seq, created_at, summary) VALUES (?, ?, 's', ?, ?, ?, '[]')")
    .run(taskId, no, `call-r${no}`, seq, at);
  return seq;
}

test("新建的库带着版本记录表；记一次发布写一条事件与一行记录，版本号从 1 起递增；读出来按版本号从小到大", () => {
  const { dir, taskId } = workspace();
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
  assert.equal(TASK_DB_VERSION, 8);
  assert.deepEqual(write(dir, (db) => [versionRecords(db, taskId), versionCount(db, taskId), nextVersionNo(db, taskId)]), [[], 0, 1]);
  const first = write(dir, (db) => recordVersion(db, { taskId, sessionId: "sess-1", callId: "ui-op-1", actor: "user", revisionNo: 4, note: "  首版 ",
    markdownPath: "versions/v1/document.md", docxPath: "versions/v1/document.docx", figures: { count: 3, pictures: 2 } }));
  const second = write(dir, (db) => recordVersion(db, { taskId, sessionId: "sess-1", callId: "call-9", revisionNo: 7, figures: { count: 0, pictures: 0 } }));
  assert.deepEqual([first.version_no, second.version_no], [1, 2]);
  const rows = write(dir, (db) => versionRecords(db, taskId));
  assert.deepEqual(rows.map((one) => [one.version_no, one.actor, one.revision_no, one.note, one.markdown_path, one.docx_path, one.figure_count, one.figure_pictures, one.event_seq]), [
    [1, "user", 4, "首版", "versions/v1/document.md", "versions/v1/document.docx", 3, 2, first.event_seq],
    [2, "executor", 7, null, null, null, null, null, second.event_seq], // 一张图都没有：图数不写
  ]);
  const events = query<{ name: string; payload: string; actor: string }>(dir, "SELECT name, payload, actor FROM event WHERE name = ? ORDER BY seq", EVENT_VERSION_PUBLISHED);
  assert.deepEqual(events.map((one) => [JSON.parse(one.payload), one.actor]), [
    [{ version_no: 1, revision_no: 4, actor: "user", note: "首版" }, "user"],
    [{ version_no: 2, revision_no: 7, actor: "executor", note: null }, "executor"],
  ]);
  // 调用方定好的版本号已经被占用：报错，整个事务回退，不多出事件。
  assert.throws(() => write(dir, (db) => recordVersion(db, { taskId, sessionId: "s", callId: "c", revisionNo: 8, versionNo: 2 })), /第 2 版已经发布过了/);
  assert.equal(query(dir, "SELECT seq FROM event WHERE name = ?", EVENT_VERSION_PUBLISHED).length, 2);
});

test("格式 7 升到 8：早先「已完成」的任务补一条第 1 版——时刻取完成的时刻，修订号取完成之前的最后一次，谁发布取完成那条事件的发起方，没有存档；再升一次不补第二条", () => {
  const { dir, taskId } = workspace();
  asVersion7(dir, (db) => {
    addRevision(db, taskId, 1, "2026-10-01T09:00:00");
    addRevision(db, taskId, 2, "2026-10-01T10:00:00");
    const seq = Number((db.prepare("SELECT MAX(seq) + 1 AS n FROM event").get() as { n: number }).n);
    db.prepare("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (?, ?, 's', 'ui-op-done', 'TASK_COMPLETED', '{}', 'user', ?)")
      .run(seq, taskId, "2026-10-01T11:00:00");
    addRevision(db, taskId, 3, "2026-10-02T09:00:00");  // 完成之后的修订（早先只读，测试里硬写一条）不算进第 1 版
    db.prepare("UPDATE task SET status = '已完成', ended_at = '2026-10-01T11:00:00'").run();
  });
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 7, to: 8, notes: ["补了第 1 版的版本记录（早先已完成，修订 2）"] });
  const rows = query<Record<string, unknown>>(dir, "SELECT * FROM version_record").map((one) => ({ ...one }));
  const done = query<{ seq: number }>(dir, "SELECT seq FROM event WHERE name = 'TASK_COMPLETED'")[0].seq;
  assert.deepEqual(rows, [{ version_no: 1, task_id: taskId, published_at: "2026-10-01T11:00:00", actor: "user", revision_no: 2, note: UPGRADED_VERSION_NOTE,
    markdown_path: null, docx_path: null, figure_count: null, figure_pictures: null, event_seq: done }]);
  // 状态一列照旧留着，不读不改；没有新的事件。
  assert.deepEqual(query(dir, "SELECT status FROM task").map((one) => ({ ...one })), [{ status: "已完成" }]);
  assert.equal(query(dir, "SELECT seq FROM event WHERE name = ?", EVENT_VERSION_PUBLISHED).length, 0);
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 8, to: 8, notes: [] });
  assert.equal(query(dir, "SELECT * FROM version_record").length, 1);
});

test("格式 7 升到 8：进行中的任务不补版本；早先已完成而没有完成事件的，修订号取最后一次、谁发布写执行者、时刻取结束的时刻", () => {
  const active = workspace();
  asVersion7(active.dir);
  assert.deepEqual(upgradeTaskDatabase(active.dir), { from: 7, to: 8, notes: [] });
  assert.equal(query(active.dir, "SELECT * FROM version_record").length, 0);
  const bare = workspace();
  asVersion7(bare.dir, (db) => {
    addRevision(db, bare.taskId, 1, "2026-10-01T09:00:00");
    db.prepare("UPDATE task SET status = '已完成', ended_at = '2026-10-03T08:00:00'").run();
  });
  upgradeTaskDatabase(bare.dir);
  assert.deepEqual(query(bare.dir, "SELECT published_at, actor, revision_no FROM version_record").map((one) => ({ ...one })), [{ published_at: "2026-10-03T08:00:00", actor: "executor", revision_no: 1 }]);
});

/** 测试用的「任务类型模板」：取 overallDefinition 里那一节。 */
const TEMPLATE: OverallTemplate = (() => {
  const raw = overallDefinition();
  return { collection: raw.交付物.条目集合.find((one: Record<string, unknown>) => one["名称"] === "总体分析"), completion: raw.完成条件.总体分析 };
})();

test("格式 7 升到 8：任务定义里缺「总体分析」集合的早先任务，照模板补上这一集合与它的完成条件，库里的快照与任务目录里的副本一起改；升级之后有阶段", () => {
  const { dir, taskId } = workspace(demoDefinition());
  asVersion7(dir);
  const definition = () => JSON.parse(query<{ definition_text: string }>(dir, "SELECT definition_text FROM task")[0].definition_text);
  assert.equal(definition().交付物.条目集合.some((one: Record<string, unknown>) => one["名称"] === "总体分析"), false);
  const asked: string[] = [];
  const result = upgradeTaskDatabase(dir, { overallTemplate: (path) => { asked.push(path); return TEMPLATE; } });
  assert.deepEqual([result, asked], [{ from: 7, to: 8, notes: ["补了总体分析集合"] }, [DEFINITION_PATH]]);
  const patched = definition();
  // 只多了这一集合（排在最后）与完成条件里它那一项，别的照旧。
  assert.deepEqual(patched.交付物.条目集合.map((one: Record<string, unknown>) => one["名称"]), [...(demoDefinition() as any).交付物.条目集合.map((one: Record<string, unknown>) => one["名称"]), "总体分析"]);
  assert.deepEqual(patched.完成条件, { ...(demoDefinition() as any).完成条件, 总体分析: ["每个条目用户确认"] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, DEFINITION_PATH), "utf-8")), patched);
  // 补上之后是有阶段的任务：会话没有工作项时空闲，而不是 null（没有阶段）。
  const valid = validateDefinition(patched);
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, valid, "sess-1")), "idle");
  // 再升一次什么都不改。
  assert.deepEqual(upgradeTaskDatabase(dir, { overallTemplate: () => TEMPLATE }), { from: 8, to: 8, notes: [] });
});

test("格式 7 升到 8：没有给模板（助手写库时）、模板找不到、或者定义里本来就有「总体分析」时不补", () => {
  const plain = workspace(demoDefinition());
  asVersion7(plain.dir);
  const before = query<{ definition_text: string }>(plain.dir, "SELECT definition_text FROM task")[0].definition_text;
  assert.deepEqual(upgradeTaskDatabase(plain.dir, { overallTemplate: () => null }), { from: 7, to: 8, notes: [] });
  assert.equal(query<{ definition_text: string }>(plain.dir, "SELECT definition_text FROM task")[0].definition_text, before);
  const other = workspace(demoDefinition());
  asVersion7(other.dir);
  upgradeTaskDatabase(other.dir);
  assert.equal(JSON.parse(query<{ definition_text: string }>(other.dir, "SELECT definition_text FROM task")[0].definition_text).交付物.条目集合.length, 2);
  const has = workspace();
  asVersion7(has.dir);
  assert.deepEqual(upgradeTaskDatabase(has.dir, { overallTemplate: () => TEMPLATE }), { from: 7, to: 8, notes: [] });
});
