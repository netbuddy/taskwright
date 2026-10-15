/** 建库的三种情况：库不存在、已是新库、是旧库。 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "../src/lib/db.ts";
import { MIN_TASK_DB_VERSION, NewerTaskDatabase, NoDatabaseYet, OlderTaskDatabase, TABLE_NAMES, TASK_DB_VERSION, TASK_JSON, upgradeTaskDatabase, withTaskDatabase } from "../src/lib/schema.ts";
import { createTask } from "../src/lib/create_task.ts";
import { reviewSpecOf, rulesHash } from "../src/lib/review_state.ts";
import { asFormat8, callIn, makeWorkspace, query } from "./helpers.ts";

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

test("建表语句里每一列都带着中文注释存进了库里", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  const sql = query<{ sql: string }>(dir, "SELECT sql FROM sqlite_master WHERE name = 'item_version'")[0].sql;
  assert.match(sql, /条目在某次修订下的内容/);
  assert.match(sql, /PRIMARY KEY \(task_id, item_id, revision_no\)/);
  assert.doesNotMatch(sql, /version_no/);
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

test("已是新库时什么都不做，原有的行都还在", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => {
    db.prepare("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (1,'t','s','c','X','{}','模型','now')").run();
  });
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  assert.equal(query(dir, "SELECT * FROM event").length, 1);
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

const INSERT_DIAGRAM_VERSION =
  "INSERT INTO diagram_version (task_id, diagram_id, revision_no, op, name, kind, mermaid, note, actor, session_id, call_id, created_at, event_seq) VALUES ('T', ?, 1, 'add', ?, ?, 'flowchart LR\n a --> b', '', 'executor', 's', 'c', '2026-01-01T00:00:00', 1)";
const diagramVersionSql = (dir: string) => query<{ sql: string }>(dir, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'diagram_version'")[0].sql;

test("格式版本：新建的库里图的内容表不检查种类，五种之外的写法库也收", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => db.prepare(INSERT_DIAGRAM_VERSION).run("D-001", "系统边界", "context"));
  assert.doesNotMatch(diagramVersionSql(dir), /CHECK\s*\(\s*kind/i);
  assert.match(diagramVersionSql(dir), /CHECK \(op IN/);
});

const INSERT_ACTIVITY_RECORD =
  "INSERT INTO activity_record (task_id, session_id, run_id, call_id, actor, activity, node, flow, reason, started_at, started_seq) VALUES ('T', 's', NULL, ?, ?, ?, ?, 'analysis', '用户点的', '2026-10-11T10:00:00', 1)";
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


const columnsOf = (dir: string, table: string) => query<{ name: string }>(dir, `PRAGMA table_info(${table})`).map((one) => one.name);

test("格式 9：新建的库照现在的建表语句建齐，格式号是 9，工具拒绝表带原因码两列；本程序还能升级的最早格式是 8", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  assert.deepEqual([TASK_DB_VERSION, MIN_TASK_DB_VERSION, version(dir)], [9, 8, 9]);
  assert.deepEqual(columnsOf(dir, "tool_rejection").slice(-2), ["reason_code", "reason_codes"]);
});

test("格式 8 升到 9：写入一侧第一次打开时给工具拒绝表补上原因码两列，原有的拒绝记录还在、原因码为空；再打开不重做", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, (db) => db.prepare(
    "INSERT INTO tool_rejection (session_id, call_id, tool_name, reason_kind, fact, input_excerpt, created_at) VALUES ('s', 'c', 'reply', 'input', '旧的一条', '{}', '2026-10-14T10:00:00')").run());
  asFormat8(dir);
  assert.equal(version(dir), 8);
  assert.ok(!columnsOf(dir, "tool_rejection").includes("reason_code"));
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.equal(version(dir), 9);
  assert.deepEqual(query(dir, "SELECT fact, reason_code, reason_codes FROM tool_rejection").map((one) => ({ ...one })), [{ fact: "旧的一条", reason_code: null, reason_codes: null }]);
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.deepEqual(columnsOf(dir, "tool_rejection").filter((name) => name.startsWith("reason_code")), ["reason_code", "reason_codes"]);
});

test("格式早于 8 的库被拒绝，库原样不动：没有编过版本号而有表的（0.4 的库）与格式 1 到 7 的（0.5 的库）；话里写出格式号；日志模式也不切", () => {
  for (const [old, pattern] of [[0, /^这个任务库的格式是 0（没有编过版本号，0\.4 建的），本版本只能打开格式 8 及以后的任务库，更早的格式不再升级，库没有改动。请新建一个任务。$/],
    [5, /^这个任务库的格式是 5（0\.5 建的），本版本只能打开格式 8 及以后的任务库/], [7, /^这个任务库的格式是 7（0\.5 建的）/]] as const) {
    const dir = makeWorkspace();
    const db = new DatabaseSync(databasePath(dir));
    db.exec(`CREATE TABLE task (task_id TEXT); PRAGMA user_version = ${old}`);
    db.close();
    for (const open of [() => withTaskDatabase(dir, { createIfMissing: true }, () => null), () => upgradeTaskDatabase(dir)]) {
      assert.throws(open, (error: Error) => error instanceof OlderTaskDatabase && pattern.test(error.message), String(old));
    }
    assert.deepEqual([version(dir), tables(dir)], [old, ["task"]], String(old));
    assert.notEqual(journal(dir).toLowerCase(), "wal", "被拒的库不切日志模式");
  }
});

test("格式 8 升到 9：任务类型「软件需求规格说明编制」改名「需求工程」，任务目录里的定义文件、skill 目录与 task.json、库里的定义路径与快照一起改；再升一次不出错", () => {
  const root = join(import.meta.dirname, "..", "..", "task-types", "requirements-engineering");
  const dir = makeWorkspace();
  cpSync(root, dir, { recursive: true });
  rmSync(join(dir, "docs", "task-definitions", "requirements-engineering.json"));
  rmSync(join(dir, ".pi", "skills", "requirements-engineering"), { recursive: true });
  const oldDefinition = readFileSync(join(root, "docs", "task-definitions", "requirements-engineering.json"), "utf-8")
    .replace('"任务名": "需求工程"', '"任务名": "软件需求规格说明编制"').replace(".pi/skills/requirements-engineering/SKILL.md", ".pi/skills/srs-authoring/SKILL.md");
  writeFileSync(join(dir, "docs", "task-definitions", "srs-authoring.json"), oldDefinition, "utf-8");
  const oldSkill = readFileSync(join(root, ".pi", "skills", "requirements-engineering", "SKILL.md"), "utf-8")
    .replace("name: requirements-engineering", "name: srs-authoring").replace("# 需求工程", "# 软件需求规格说明编制");
  mkdirSync(join(dir, ".pi", "skills", "srs-authoring"), { recursive: true });
  writeFileSync(join(dir, ".pi", "skills", "srs-authoring", "SKILL.md"), oldSkill, "utf-8");
  writeFileSync(join(dir, TASK_JSON), JSON.stringify({ task_type: "srs-authoring", owner: "local" }, null, 2) + "\n", "utf-8");
  createTask(callIn(dir), { definition_path: "docs/task-definitions/srs-authoring.json" });
  asFormat8(dir);
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 8, to: 9, notes: ["任务类型改名为「需求工程」：docs/task-definitions/requirements-engineering.json、.pi/skills/requirements-engineering/"] });
  const definition = readFileSync(join(dir, "docs", "task-definitions", "requirements-engineering.json"), "utf-8");
  assert.equal(existsSync(join(dir, "docs", "task-definitions", "srs-authoring.json")), false);
  assert.match(definition, /"任务名": "需求工程"/);
  assert.match(definition, /"执行方法": "\.pi\/skills\/requirements-engineering\/SKILL\.md"/);
  assert.deepEqual(readdirSync(join(dir, ".pi", "skills")), ["requirements-engineering"]);
  const skill = readFileSync(join(dir, ".pi", "skills", "requirements-engineering", "SKILL.md"), "utf-8");
  assert.ok(skill.includes("\nname: requirements-engineering\n") && skill.includes("\n# 需求工程\n"));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, TASK_JSON), "utf-8")), { task_type: "requirements-engineering", owner: "local" });
  assert.deepEqual(query<any>(dir, "SELECT definition_path, definition_text FROM task").map((row) => [row.definition_path, row.definition_text]),
    [["docs/task-definitions/requirements-engineering.json", definition]]);
  // 再升一次：已经是 9，什么都不动。
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 9, to: 9, notes: [] });
});

test("格式 8 升到 9：集合「总体分析」改名「业务说明」——定义、条目、事件、随任务类型复制来的文件一起改，材料不动；评审规则文件改了字，评审记录的规则指纹换成新的", () => {
  const root = join(import.meta.dirname, "..", "..", "task-types", "requirements-engineering");
  const dir = makeWorkspace();
  cpSync(root, dir, { recursive: true });
  // 退回改名之前的样子：随任务类型复制来的文件里写的是「总体分析」；材料里也有这个词，它不该被改。
  const typeFiles = ["docs/task-definitions/requirements-engineering.json", "docs/review-rules/use-case.json", ".pi/skills/requirements-engineering/SKILL.md"];
  for (const file of typeFiles) writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf-8").replaceAll("业务说明", "总体分析"), "utf-8");
  writeFileSync(join(dir, "inputs", "材料.md"), "材料里提到总体分析这个词。\n", "utf-8");
  createTask(callIn(dir), { definition_path: "docs/task-definitions/requirements-engineering.json" });
  const definition = JSON.parse(readFileSync(join(dir, typeFiles[0]), "utf-8"));
  const spec = reviewSpecOf(JSON.stringify(definition), "功能用例")!;
  const oldHash = rulesHash(dir, spec);
  const db = new DatabaseSync(databasePath(dir));
  try {
    const task = (db.prepare("SELECT task_id FROM task").get() as { task_id: string }).task_id;
    db.prepare("INSERT INTO item VALUES (?, 'OA-001', '总体分析', 1, 1, NULL, 1, NULL), (?, 'UC-001', '功能用例', 1, 1, NULL, 1, NULL)").run(task, task);
    db.prepare("INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) VALUES (?, 's', 'c', 'REVISION_SAVED', 'executor', ?, 't')")
      .run(task, JSON.stringify({ operations: [{ op: "add", item: "OA-001", collection: "总体分析" }] }));
    db.prepare("INSERT INTO review (task_id, item_id, revision_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at, rules_hash) " +
      "VALUES (?, 'UC-001', 1, '合规', '', '', 's', 'c', 1, 't', ?)").run(task, oldHash);
  } finally {
    db.close();
  }
  asFormat8(dir);
  const { notes } = upgradeTaskDatabase(dir);
  assert.deepEqual(notes, ["集合「总体分析」改名为「业务说明」：1 个条目，任务目录里 3 份文件"]);
  for (const file of typeFiles) assert.ok(!readFileSync(join(dir, file), "utf-8").includes("总体分析"), file);
  assert.equal(readFileSync(join(dir, "inputs", "材料.md"), "utf-8"), "材料里提到总体分析这个词。\n");
  assert.deepEqual(query<any>(dir, "SELECT item_id, collection FROM item ORDER BY item_id").map((r) => [r.item_id, r.collection]), [["OA-001", "业务说明"], ["UC-001", "功能用例"]]);
  assert.ok(query<any>(dir, "SELECT definition_text FROM task")[0].definition_text.includes('"名称": "业务说明"'));
  assert.ok(query<any>(dir, "SELECT payload FROM event WHERE name = 'REVISION_SAVED'").every((r) => r.payload.includes('"collection":"业务说明"')));
  const newHash = rulesHash(dir, spec);
  assert.notEqual(newHash, oldHash, "规则文件改了字，指纹变了");
  assert.deepEqual(query<any>(dir, "SELECT rules_hash FROM review").map((r) => r.rules_hash), [newHash]);
});

test("数据升级用的入口：格式 8 升到 9 并说出升级前后的版本；已经是 9 的原样返回；没有库文件时不建", () => {
  const dir = makeWorkspace();
  withTaskDatabase(dir, { createIfMissing: true }, () => null);
  asFormat8(dir);
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 8, to: 9, notes: [] });
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 9, to: 9, notes: [] });
  const empty = makeWorkspace();
  assert.throws(() => upgradeTaskDatabase(empty), NoDatabaseYet);
  assert.equal(existsSync(databasePath(empty)), false);
});
