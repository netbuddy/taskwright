/**
 * 整份数据里的进行中的评审（review_in_progress）：取任务库里最后一条评审进度，同一个操作编号已经有评审结束时为 null；
 * 另外要求助手现在在运行，并且这条进度写于这个助手启动之后（助手在评审中途退出过时，刷新之后不应当一直显示「评审中」）。
 * 形状与评审进度事件里的 op_id、done、total、current 相同。
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadProfile } from "../src/launch.ts";
import * as library from "../src/library.ts";
import { Service } from "../src/service.ts";
import { ROOT, captureConsole, copyWorkspace, makeWorkspace, sqlGet, sqlRun, tempDir } from "./helpers.ts";

captureConsole();

const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
const ts = "2026-09-28T01:00:00.000Z";

let tmp: string;
let ws: string;
const savedEntry = process.env.TASKWRIGHT_PI_ENTRY;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
  delete process.env.TASKWRIGHT_PI_ENTRY;
});
after(() => {
  if (savedEntry !== undefined) process.env.TASKWRIGHT_PI_ENTRY = savedEntry;
  rmSync(tmp, { recursive: true, force: true });
});

/** 在任务库里记一条评审进度或评审结束事件，返回它的序号。 */
function record(dir: string, name: "REVIEW_PROGRESS" | "REVIEW_FINISHED", payload: Record<string, unknown>): number {
  const taskId = sqlGet(dir, "SELECT task_id FROM task")!.task_id;
  sqlRun(dir, [["INSERT INTO event (task_id, session_id, call_id, name, payload, actor, at) VALUES (?, 'S1', ?, ?, ?, 'user', '2026-09-28 10:00:00')",
    taskId, String(payload.op_id), name, JSON.stringify(payload)]]);
  return Number(sqlGet(dir, "SELECT MAX(seq) AS n FROM event")!.n);
}

const progress = (op: string, done: number, total: number, current: string[]) => ({ op_id: op, done, total, current, item_id: null });

test("读库：取最后一条进度；同一批已经结束时为 null，别的批结束不算；助手不在运行、进度写于助手启动之前都为 null", () => {
  const dir = copyWorkspace(ws, join(tmp, "ws-lib"));
  const base = Number(sqlGet(dir, "SELECT MAX(seq) AS n FROM event")!.n);
  assert.equal(library.taskSnapshot(dir, base)[2], null, "还没有评审");

  const first = record(dir, "REVIEW_PROGRESS", progress("ui-1", 0, 2, ["UC-001", "TBD-001"]));
  assert.deepEqual(library.taskSnapshot(dir, base)[2], { op_id: "ui-1", done: 0, total: 2, current: ["UC-001", "TBD-001"] });
  assert.equal(library.taskSnapshot(dir, null)[2], null, "助手不在运行");
  assert.equal(library.taskSnapshot(dir, first)[2], null, "进度写于助手启动之前");

  record(dir, "REVIEW_PROGRESS", progress("ui-1", 1, 2, ["TBD-001"]));
  assert.deepEqual(library.taskSnapshot(dir, base)[2], { op_id: "ui-1", done: 1, total: 2, current: ["TBD-001"] });

  record(dir, "REVIEW_FINISHED", { op_id: "ui-1", total: 2, passed: 2, failed: 0, unfinished: 0, results: [] });
  assert.equal(library.taskSnapshot(dir, base)[2], null, "这一批已经结束");

  record(dir, "REVIEW_FINISHED", { op_id: "ui-0", total: 1, passed: 1, failed: 0, unfinished: 0, results: [] });
  record(dir, "REVIEW_PROGRESS", progress("ui-2", 0, 1, ["UC-001"]));
  assert.deepEqual(library.taskSnapshot(dir, base)[2], { op_id: "ui-2", done: 0, total: 1, current: ["UC-001"] }, "别的批结束不影响这一批");
  assert.equal(library.maxSeq(dir), Number(sqlGet(dir, "SELECT MAX(seq) AS n FROM event")!.n));
});

test("整份数据：助手启动之前写下的进度不算；启动之后写下的算；助手退出之后为 null", async () => {
  const root = join(tmp, "svc");
  const tasks = join(root, "tasks");
  const dir = makeWorkspace(tasks, "ws", true);
  const taskId = String(sqlGet(dir, "SELECT task_id FROM task")!.task_id);
  const sessions = join(root, "runs", taskId, "pi-sessions", "service");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "s1.jsonl"), JSON.stringify({ type: "session", id: "S1", timestamp: ts, cwd: dir }) + "\n", "utf-8");
  const script = join(root, "pi-script");
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PI}" "$@"\n`, "utf-8");
  chmodSync(script, 0o755);
  const service = new Service(tasks, join(root, "runs"), { ...loadProfile("fake"), executable: script }, { port: null });
  const t = service.task(taskId);
  try {
    // 上一个助手在评审中途退出：进度留在库里，没有评审结束
    record(dir, "REVIEW_PROGRESS", progress("ui-old", 0, 1, ["UC-001"]));
    const opened = await service.snapshot(t, "S1");
    assert.ok(t.executor.running());
    assert.equal(opened.review_in_progress, null, "进度写于这个助手启动之前");

    record(dir, "REVIEW_PROGRESS", progress("ui-new", 1, 3, ["TBD-001"]));
    const during = await service.snapshot(t, "S1");
    assert.deepEqual(during.review_in_progress, { op_id: "ui-new", done: 1, total: 3, current: ["TBD-001"] });

    await t.executor.pi!.close();
    assert.equal(t.executor.running(), false);
    assert.equal((await service.snapshot(t, null)).review_in_progress, null, "助手不在运行");
  } finally {
    await service.close();
  }
});
