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
  // SQLite 自己的表（记录号自增计数用的 sqlite_sequence）不算任务库的表。
  return query<{ name: string }>(dir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' ORDER BY name").map((r) => r.name);
}

test("库文件不存在时建齐十七张表", () => {
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
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 0, to: TASK_DB_VERSION, notes: [] });
  assert.ok(tables(dir).includes("tool_rejection"));
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION, notes: [] });
  const empty = makeWorkspace();
  assert.throws(() => upgradeTaskDatabase(empty), NoDatabaseYet);
  assert.equal(existsSync(databasePath(empty)), false);
});

/** 格式版本 2 及更早的库里图的内容表：种类一列带着只许五种的检查。 */
const OLD_DIAGRAM_VERSION_SQL = `
CREATE TABLE diagram_version (
  task_id      TEXT NOT NULL,
  diagram_id   TEXT NOT NULL,
  revision_no  INTEGER NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('add', 'update', 'delete')),
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('use_case', 'class', 'state', 'sequence', 'flowchart')),
  mermaid      TEXT NOT NULL,
  note         TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('executor', 'user')),
  session_id   TEXT NOT NULL,
  call_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  event_seq    INTEGER NOT NULL,
  PRIMARY KEY (task_id, diagram_id, revision_no)
);`;
const INSERT_DIAGRAM_VERSION =
  "INSERT INTO diagram_version (task_id, diagram_id, revision_no, op, name, kind, mermaid, note, actor, session_id, call_id, created_at, event_seq) VALUES ('T', ?, 1, 'add', ?, ?, 'flowchart LR\n a --> b', '', 'executor', 's', 'c', '2026-01-01T00:00:00', 1)";
const diagramVersionSql = (dir: string) => query<{ sql: string }>(dir, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'diagram_version'")[0].sql;

test("格式版本：新建的库里图的内容表不检查种类，五种之外的写法库也收", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => db.prepare(INSERT_DIAGRAM_VERSION).run("D-001", "系统边界", "context"));
  assert.doesNotMatch(diagramVersionSql(dir), /CHECK\s*\(\s*kind/i);
  assert.match(diagramVersionSql(dir), /CHECK \(op IN/);
});

test("格式版本 2 的库里图的内容表检查种类：升到版本 3 时去掉这条检查，原有的行一行不少、内容不变；再升一次什么都不改", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => {
    db.exec(`DROP TABLE diagram_version; ${OLD_DIAGRAM_VERSION_SQL}`);
    db.prepare(INSERT_DIAGRAM_VERSION).run("D-001", "借书流程", "flowchart");
    db.prepare(INSERT_DIAGRAM_VERSION).run("D-002", "借阅记录的状态", "state");
    db.exec("PRAGMA user_version = 2");
  });
  const before = query(dir, "SELECT * FROM diagram_version ORDER BY diagram_id");
  // 还没有升级时，库自己拒绝五种之外的种类。
  const raw = new DatabaseSync(databasePath(dir));
  assert.throws(() => raw.prepare(INSERT_DIAGRAM_VERSION).run("D-003", "系统边界", "context"), /CHECK constraint failed/);
  raw.close();
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 2, to: TASK_DB_VERSION, notes: [] });
  assert.equal(version(dir), TASK_DB_VERSION);
  assert.deepEqual(query(dir, "SELECT * FROM diagram_version ORDER BY diagram_id"), before);
  assert.doesNotMatch(diagramVersionSql(dir), /CHECK\s*\(\s*kind/i);
  assert.match(diagramVersionSql(dir), /CHECK \(op IN/, "别的检查还在");
  assert.deepEqual(tables(dir), [...TABLE_NAMES].sort(), "没有留下重建时用的那张表");
  withTaskDatabase(dir, { createIfMissing: false }, (db) => db.prepare(INSERT_DIAGRAM_VERSION).run("D-003", "系统边界", "context"));
  assert.equal(query(dir, "SELECT * FROM diagram_version").length, 3);
  const sql = diagramVersionSql(dir);
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION, notes: [] });
  assert.equal(diagramVersionSql(dir), sql);
});

test("没有编过版本号、图的内容表带着种类检查的库：一次升到现在的版本，检查一并去掉", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => {
    db.exec(`DROP TABLE diagram_version; ${OLD_DIAGRAM_VERSION_SQL}; PRAGMA user_version = 0`);
  });
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 0, to: TASK_DB_VERSION, notes: [] });
  assert.doesNotMatch(diagramVersionSql(dir), /CHECK\s*\(\s*kind/i);
});

/** 格式版本 3 及更早的库里的阶段记录表：两列阶段带着只许五个阶段的检查。 */
const OLD_STAGE_RECORD_SQL = `
CREATE TABLE stage_record (
  record_id    INTEGER PRIMARY KEY,
  task_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  run_id       TEXT,
  call_id      TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('executor', 'user')),
  stage        TEXT NOT NULL CHECK (stage IN ('reading', 'clarifying', 'modeling', 'writing', 'reviewing')),
  from_stage   TEXT NOT NULL CHECK (from_stage IN ('reading', 'clarifying', 'modeling', 'writing', 'reviewing')),
  reason       TEXT NOT NULL,
  event_seq    INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);`;
const INSERT_STAGE_RECORD =
  "INSERT INTO stage_record (task_id, session_id, run_id, call_id, actor, stage, from_stage, reason, event_seq, created_at) VALUES ('T', 's', NULL, ?, 'user', ?, ?, '用户点的', ?, ?)";
const INSERT_ACTIVITY_RECORD =
  "INSERT INTO activity_record (task_id, session_id, run_id, call_id, actor, activity, node, flow, reason, started_at, started_seq) VALUES ('T', 's', NULL, ?, ?, ?, ?, 'analysis', '用户点的', '2026-10-11T10:00:00', 1)";
/** 格式版本 5 的活动记录表：一行是一项活动的一段，带结束的时刻与序号，还没有范围说明一列。 */
const V5_ACTIVITY_RECORD_SQL = `
CREATE TABLE activity_record (
  record_id    INTEGER PRIMARY KEY,
  task_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  run_id       TEXT,
  call_id      TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('executor', 'user')),
  activity     TEXT NOT NULL,
  node         TEXT,
  flow         TEXT,
  reason       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  started_seq  INTEGER NOT NULL,
  ended_seq    INTEGER
);`;
const tableSql = (dir: string, name: string) => query<{ sql: string }>(dir, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name)[0]?.sql ?? null;

test("格式版本：新建的库里活动记录表不检查活动的取值，六个阶段之外的写法库也收；谁开始的那一列照旧检查；早先的阶段记录表不在", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => db.prepare(INSERT_ACTIVITY_RECORD).run("op-1", "user", "publishing", "publishing"));
  assert.doesNotMatch(tableSql(dir, "activity_record")!, /CHECK\s*\(\s*(activity|node|flow)/i);
  assert.match(tableSql(dir, "activity_record")!, /CHECK \(actor IN/);
  const raw = new DatabaseSync(databasePath(dir));
  assert.throws(() => raw.prepare(INSERT_ACTIVITY_RECORD).run("op-2", "reviewer", "writing", "writing"), /CHECK constraint failed/);
  raw.close();
  assert.equal(tableSql(dir, "stage_record"), null);
});

test("格式版本 3 的库里阶段记录表检查阶段的取值：升到现在的版本时这几行先改写成活动记录（编号照抄）、再并成一个流程的工作项，阶段记录表不留；再升一次什么都不改", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => {
    db.exec(`DROP TABLE activity_record; ${OLD_STAGE_RECORD_SQL}`);
    db.prepare(INSERT_STAGE_RECORD).run("op-1", "clarifying", "reading", 11, "2026-10-11T10:00:00");
    db.prepare(INSERT_STAGE_RECORD).run("op-2", "modeling", "clarifying", 12, "2026-10-11T11:00:00");
    db.exec("DELETE FROM stage_record WHERE call_id = 'op-1'");   // 编号不从 1 连着排的时候也要照抄
    db.prepare(INSERT_STAGE_RECORD).run("op-3", "writing", "modeling", 13, "2026-10-11T12:00:00");
    db.exec("PRAGMA user_version = 3");
  });
  assert.deepEqual(query<{ record_id: number }>(dir, "SELECT record_id FROM stage_record ORDER BY record_id").map((row) => row.record_id), [2, 3]);
  // 还没有升级时，库自己拒绝五个阶段之外的写法。
  const raw = new DatabaseSync(databasePath(dir));
  assert.throws(() => raw.prepare(INSERT_STAGE_RECORD).run("op-4", "document", "reviewing", 14, "2026-10-11T13:00:00"), /CHECK constraint failed/);
  raw.close();
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 3, to: TASK_DB_VERSION, notes: [] });
  assert.equal(TASK_DB_VERSION, 8);
  assert.equal(version(dir), 8);
  // 两行都在需求分析里：并成一行，留最早那一行的编号与启动的时刻，现在的活动与所在的一站取最晚那一行的；流程的键改写成 analysis，结束的两列随重建去掉。
  assert.deepEqual(query(dir, "SELECT * FROM activity_record ORDER BY record_id").map((row) => ({ ...row })), [
    { record_id: 2, task_id: "T", session_id: "s", run_id: null, call_id: "op-2", actor: "user", activity: "writing", node: "writing", flow: "analysis",
      reason: "用户点的", started_at: "2026-10-11T11:00:00", started_seq: 12, scope: null },
  ]);
  assert.match(tableSql(dir, "activity_record")!, /AUTOINCREMENT/);
  assert.deepEqual(tables(dir), [...TABLE_NAMES].sort(), "阶段记录表与重建时用的那张表都没有留下");
  withTaskDatabase(dir, { createIfMissing: false }, (db) => db.prepare(INSERT_ACTIVITY_RECORD).run("op-4", "user", "document", "document"));
  assert.deepEqual(query<{ record_id: number }>(dir, "SELECT record_id FROM activity_record ORDER BY record_id").map((row) => row.record_id), [2, 3]);
  const sql = tableSql(dir, "activity_record");
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION, notes: [] });
  assert.equal(tableSql(dir, "activity_record"), sql);
});

test("格式版本 5 的库：活动记录表没有范围说明一列、带结束的两列；升到现在的版本时补上范围说明（为空）、去掉结束的两列，别的照抄；再升一次什么都不改", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => {
    db.exec(`DROP TABLE activity_record; ${V5_ACTIVITY_RECORD_SQL}`);
    db.exec("INSERT INTO activity_record (task_id, session_id, run_id, call_id, actor, activity, node, flow, reason, started_at, ended_at, started_seq, ended_seq) " +
      "VALUES ('T', 's', NULL, 'op-1', 'user', 'clarifying', NULL, NULL, '用户点的', '2026-10-11T10:00:00', '2026-10-11T10:30:00', 1, 2)");
    db.exec("PRAGMA user_version = 5");
  });
  assert.doesNotMatch(tableSql(dir, "activity_record")!, /scope/);
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 5, to: TASK_DB_VERSION, notes: [] });
  assert.equal(version(dir), TASK_DB_VERSION);
  assert.deepEqual(query(dir, "SELECT * FROM activity_record").map((row) => ({ ...row })), [
    { record_id: 1, task_id: "T", session_id: "s", run_id: null, call_id: "op-1", actor: "user", activity: "clarifying", node: null, flow: null,
      reason: "用户点的", started_at: "2026-10-11T10:00:00", started_seq: 1, scope: null },
  ]);
  const sql = tableSql(dir, "activity_record");
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION, notes: [] });
  assert.equal(tableSql(dir, "activity_record"), sql);
});

test("没有编过版本号、阶段记录表带着阶段检查的库：一次升到现在的版本，阶段记录表不留，活动记录表不带阶段的检查", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => {
    db.exec(`DROP TABLE activity_record; ${OLD_STAGE_RECORD_SQL}; PRAGMA user_version = 0`);
  });
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 0, to: TASK_DB_VERSION, notes: [] });
  assert.equal(tableSql(dir, "stage_record"), null);
  assert.doesNotMatch(tableSql(dir, "activity_record")!, /CHECK\s*\(\s*(activity|node|flow)/i);
});
