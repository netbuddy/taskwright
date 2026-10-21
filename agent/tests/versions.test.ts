/**
 * 版本记录（src/lib/versions.ts）与任务库格式 7 升 8 那一步（src/lib/schema.ts 的 addVersionRecords）：
 * 记一次发布写什么、怎样读出各版；早先「已完成」的任务升级时补第 1 版；任务定义里缺「业务说明」集合的早先任务照模板补上。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { TASK_DB_VERSION, withTaskDatabase } from "../src/lib/schema.ts";
import { EVENT_VERSION_PUBLISHED, nextVersionNo, recordVersion, versionCount, versionRecords } from "../src/lib/versions.ts";
import { DEFINITION_PATH, callIn, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition()): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
const write = <T>(dir: string, body: (db: DatabaseSync) => T) => withTaskDatabase(dir, { createIfMissing: false }, body);

test("新建的库带着版本记录表；记一次发布写一条事件与一行记录，版本号从 1 起递增；读出来按版本号从小到大", () => {
  const { dir, taskId } = workspace();
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
  assert.equal(TASK_DB_VERSION, 11);
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

