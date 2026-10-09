/** 建库的三种情况：库不存在、已是新库、是旧库。 */

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "../src/lib/db.ts";
import { NewerTaskDatabase, NoDatabaseYet, TABLE_NAMES, TASK_DB_VERSION, TASK_JSON, upgradeTaskDatabase, withTaskDatabase } from "../src/lib/schema.ts";
import { makeWorkspace, query } from "./helpers.ts";

/** 库里记的格式版本（PRAGMA user_version）。 */
const version = (dir: string) => query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version;

/** 日志模式：被拒的库连日志模式都不该被切。 */
const journal = (dir: string) => query<{ journal_mode: string }>(dir, "PRAGMA journal_mode")[0].journal_mode;

function tables(dir: string): string[] {
  return query<{ name: string }>(dir, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
}

test("库文件不存在时建齐十六张表", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  assert.deepEqual(tables(dir), [...TABLE_NAMES].sort());
});

test("加模型调用表之前建的库没有这张表：第一次被写入一侧打开时补上，原有的行都还在", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => db.exec("DROP TABLE model_call; PRAGMA user_version = 0"));
  assert.ok(!tables(dir).includes("model_call"));
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.ok(tables(dir).includes("model_call"));
});

test("早期版本建的库没有评审发现表：第一次被写入一侧打开时补上", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => db.exec("DROP TABLE review_finding; PRAGMA user_version = 0"));
  assert.ok(!tables(dir).includes("review_finding"));
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.ok(tables(dir).includes("review_finding"));
});

test("建表语句里每一列都带着中文注释存进了库里", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  const sql = query<{ sql: string }>(dir, "SELECT sql FROM sqlite_master WHERE name = 'item_version'")[0].sql;
  assert.match(sql, /条目在某次修订下的内容/);
  assert.match(sql, /PRIMARY KEY \(task_id, item_id, revision_no\)/);
  assert.doesNotMatch(sql, /version_no/);
});

test("修订统一之前的库（条目内容表还有 version_no 列）被拒绝，说明是旧格式、本版本不支持", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  const db = new DatabaseSync(databasePath(dir));
  db.exec("ALTER TABLE item_version ADD COLUMN version_no INTEGER; PRAGMA user_version = 0");
  db.close();
  assert.throws(() => withTaskDatabase(dir, { createIfMissing: false }, () => null), /旧格式.*本版本不支持.*请新建一个任务/);
});

test("来源表带字段一级的列：支持的第几处、字段名、列表里的第几项", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  const columns = query<{ name: string }>(dir, "PRAGMA table_info(item_source)").map((r) => r.name);
  for (const name of ["support_no", "field", "field_index"]) assert.ok(columns.includes(name), `缺 ${name} 列`);
  const sql = query<{ sql: string }>(dir, "SELECT sql FROM sqlite_master WHERE name = 'item_source'")[0].sql;
  assert.match(sql, /PRIMARY KEY \(task_id, element_kind, item_id, revision_no, position, support_no\)/);
  for (const name of ["element_kind", "depends_revision"]) assert.ok(columns.includes(name), `缺 ${name} 列`);
});

test("最早格式的库（来源表没有字段一级的列）被拒绝并说明换一个新的任务目录", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  const db = new DatabaseSync(databasePath(dir));
  db.exec("DROP TABLE item_source; CREATE TABLE item_source (task_id TEXT, item_id TEXT, revision_no INTEGER, position INTEGER, kind TEXT, locator TEXT, excerpt TEXT, event_seq INTEGER)");
  db.exec("PRAGMA user_version = 0");
  db.close();
  assert.throws(() => withTaskDatabase(dir, { createIfMissing: true }, () => null), /最早的格式.*support_no、field、field_index.*请换一个新的任务目录/);
});

test("任务表带任务名与领域标签两列；缺这两列的旧库被拒绝并说明新建一个任务", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  const columns = query<{ name: string }>(dir, "PRAGMA table_info(task)").map((r) => r.name);
  for (const name of ["task_name", "domain_tag"]) assert.ok(columns.includes(name), `缺 ${name} 列`);
  const db = new DatabaseSync(databasePath(dir));
  db.exec("ALTER TABLE task DROP COLUMN domain_tag; PRAGMA user_version = 0");
  db.close();
  assert.throws(() => withTaskDatabase(dir, { createIfMissing: true }, () => null), /任务表 task 没有 domain_tag.*请新建一个任务/);
});

test("已是新库时什么都不做，原有的行都还在", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => {
    db.prepare("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (1,'t','s','c','X','{}','模型','now')").run();
  });
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  assert.equal(query(dir, "SELECT * FROM event").length, 1);
});

test("是旧库（有 slot 表）时拒绝并说明换一个新的任务目录，旧库原样不动", () => {
  const dir = makeWorkspace();
  const db = new DatabaseSync(databasePath(dir));
  db.exec("CREATE TABLE slot (name TEXT); CREATE TABLE event (seq INTEGER)");
  db.close();
  assert.throws(
    () => withTaskDatabase(dir, { createIfMissing: true }, () => null),
    /这个任务目录的库是旧格式，请换一个新的任务目录/,
  );
  assert.deepEqual(tables(dir), ["event", "slot"]);
});

test("不允许新建时，库文件不存在就不建文件", () => {
  const dir = makeWorkspace();
  assert.throws(() => withTaskDatabase(dir, { createIfMissing: false }, () => null));
  assert.equal(existsSync(databasePath(dir)), false);
});

test("新建库之后调用被拒，新建出来的库文件被删掉", () => {
  const dir = makeWorkspace();
  assert.throws(() =>
    withTaskDatabase(dir, { createIfMissing: true }, () => {
      throw new Error("拒绝");
    }),
  );
  assert.equal(existsSync(databasePath(dir)), false);
});

test("只有一部分表时拒绝", () => {
  const dir = makeWorkspace();
  const db = new DatabaseSync(databasePath(dir));
  db.exec("CREATE TABLE task (task_id TEXT)");
  db.close();
  assert.throws(() => withTaskDatabase(dir, { createIfMissing: true }, () => null), /缺了 revision/);
});

test("格式版本：新建的库写上现在的版本；已经是现在版本的库不再逐张表去看", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  assert.equal(version(dir), TASK_DB_VERSION);
  // 版本号留着、手工删掉一张后来加的表：再打开不会去补，说明没有再探测。
  withTaskDatabase(dir, { createIfMissing: false }, (db) => db.exec("DROP TABLE model_call"));
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.ok(!tables(dir).includes("model_call"));
  assert.equal(version(dir), TASK_DB_VERSION);
});

test("格式版本：没有编过版本号的库（0.4.x 建的）第一次被写入一侧打开时升到现在的版本，原有的行都还在", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => {
    db.prepare("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (1,'t','s','c','X','{}','模型','now')").run();
    db.exec("PRAGMA user_version = 0");
  });
  assert.equal(version(dir), 0);
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.equal(version(dir), TASK_DB_VERSION);
  assert.equal(query(dir, "SELECT * FROM event").length, 1);
});

test("格式版本：步骤表拒绝的旧库版本号仍是 0，表一张不多一张不少", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => db.exec("ALTER TABLE task DROP COLUMN domain_tag; DROP TABLE model_call; PRAGMA user_version = 0"));
  const before = tables(dir);
  assert.throws(() => withTaskDatabase(dir, { createIfMissing: false }, () => null), /较早的格式.*domain_tag/);
  // 被拒之前步骤表已经补过 model_call，拒绝让整个事务回退：补的表与版本号都不留下。
  assert.deepEqual(tables(dir), before);
  assert.equal(version(dir), 0);
});

test("格式版本：比这个程序新的库被拒绝，库一个字节都不动；task.json 里有版本时话里写出是哪个版本写的", () => {
  const dir = makeWorkspace();
  const db = new DatabaseSync(databasePath(dir));
  db.exec(`CREATE TABLE future (x); PRAGMA user_version = ${TASK_DB_VERSION + 1}`);
  db.close();
  const refused = (pattern: RegExp) => assert.throws(() => withTaskDatabase(dir, { createIfMissing: true }, () => null),
    (error: Error) => error instanceof NewerTaskDatabase && pattern.test(error.message));
  refused(/^这份数据由更新的版本写入，请用更新的版本打开。$/);
  writeFileSync(join(dir, TASK_JSON), JSON.stringify({ created_by_version: "0.5.0", upgraded_by_version: "0.6.0" }), "utf-8");
  refused(/^这份数据由 0\.6\.0 写入，请用 0\.6\.0 或更新的版本打开。$/);
  writeFileSync(join(dir, TASK_JSON), JSON.stringify({ created_by_version: "0.6.1", upgraded_by_version: null }), "utf-8");
  refused(/^这份数据由 0\.6\.1 写入/);
  assert.throws(() => upgradeTaskDatabase(dir), NewerTaskDatabase);
  assert.deepEqual(tables(dir), ["future"]);
  assert.equal(version(dir), TASK_DB_VERSION + 1);
  assert.notEqual(journal(dir).toLowerCase(), "wal", "被拒的库不切日志模式");
});

test("数据升级用的入口：旧库从 0 升到现在的版本，已经是现在版本的原样返回，没有库文件时不建", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => db.exec("DROP TABLE tool_rejection; PRAGMA user_version = 0"));
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 0, to: TASK_DB_VERSION });
  assert.ok(tables(dir).includes("tool_rejection"));
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION });
  const empty = makeWorkspace();
  assert.throws(() => upgradeTaskDatabase(empty), NoDatabaseYet);
  assert.equal(existsSync(databasePath(empty)), false);
});
