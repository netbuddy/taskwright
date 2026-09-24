/**
 * WAL 模式与忙等待超时：读事务开着时写入仍然成功；多个进程同时写不报 database is locked、序号不重；
 * 旧的回滚日志模式的库被写入一侧打开后切成了 WAL；旧格式（有 slot 表）的库不动。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { SCHEMA_SQL } from "../src/lib/schema.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, query } from "./helpers.ts";

const LIB = join(import.meta.dirname, "..", "src", "lib");

function journalMode(dir: string): string {
  return String(query<{ journal_mode: string }>(dir, "PRAGMA journal_mode")[0].journal_mode);
}

const addOne = (name: string) => ({
  op: "add",
  collection: "用例",
  fields: { 名称: name, 步骤: ["一步"] },
  sources: [SOURCE],
});

test("新建的库是 WAL 模式", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  assert.equal(journalMode(dir), "wal");
});

test("另一个连接开着读事务时，写入工具仍然成功，读事务里看到的还是开始时的样子", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const reader = new DatabaseSync(databasePath(dir), { readOnly: true });
  reader.exec("BEGIN");
  const before = (reader.prepare("SELECT COUNT(*) AS n FROM revision").get() as { n: number }).n;
  saveRevision(callIn(dir), { operations: [addOne("读着的时候写")] });
  const during = (reader.prepare("SELECT COUNT(*) AS n FROM revision").get() as { n: number }).n;
  reader.exec("COMMIT");
  const after = (reader.prepare("SELECT COUNT(*) AS n FROM revision").get() as { n: number }).n;
  reader.close();
  assert.deepEqual([before, during, after], [0, 0, 1]);
});

test("旧的回滚日志模式的库，被写入一侧打开后切成了 WAL", () => {
  const dir = makeWorkspace();
  const db = new DatabaseSync(databasePath(dir));
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec(SCHEMA_SQL);
  db.close();
  assert.equal(journalMode(dir), "delete");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  assert.equal(journalMode(dir), "wal");
});

test("旧格式（有 slot 表）的库被拒绝时，日志模式也不改", () => {
  const dir = makeWorkspace();
  const db = new DatabaseSync(databasePath(dir));
  db.exec("CREATE TABLE slot (name TEXT)");
  db.close();
  assert.throws(() => createTask(callIn(dir), { definition_path: DEFINITION_PATH }), /旧格式/);
  assert.equal(journalMode(dir), "delete");
});

/** 在子进程里跑一段脚本，返回它打印的最后一行。 */
function runChild(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim().split("\n").pop() ?? ""));
  });
}

test("六个进程同时写同一个库：全部成功，不报 database is locked，修订序号与事件序号不重不断", async () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const script = `
    import { saveRevision } from ${JSON.stringify(join(LIB, "save_revision.ts"))};
    const [dir, name] = process.argv.slice(1);
    try {
      saveRevision({ workspaceDir: dir, sessionId: "并发", callId: name },
        { operations: [{ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["一步"] },
          sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "并发" }] }] });
      console.log("成功");
    } catch (error) { console.log("失败：" + error.message); }`;
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) => runChild(script, [dir, `进程${index + 1}`])),
  );
  assert.deepEqual(results, Array(6).fill("成功"));
  const revisions = query<{ revision_no: number }>(dir, "SELECT revision_no FROM revision ORDER BY revision_no").map((r) => r.revision_no);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5, 6]);
  const seqs = query<{ seq: number }>(dir, "SELECT seq FROM event ORDER BY seq").map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(count(dir, "item"), 6);
});

test("另一个进程占着写锁一秒时，写入等锁放开后成功，而不是当场报 database is locked", async () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const holder = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE"); console.log("占住了");
    setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", holder, databasePath(dir)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const started = Date.now();
  saveRevision(callIn(dir), { operations: [addOne("等锁")] });
  const waited = Date.now() - started;
  await new Promise((resolve) => child.on("close", resolve));
  assert.ok(waited >= 500, `应当等了一阵，实际等了 ${waited} 毫秒`);
  assert.equal(count(dir, "revision"), 1);
});
