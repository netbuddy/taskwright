/**
 * 读取任务库的几处不再把读错吞掉：没有库时照旧是空的（0、空表、查不到），库在而读不出来（这里用 DROP TABLE 造出来）时抛出，
 * 不静默地当作没有数据。事件流的定时轮询自己接住这种错，记一行、这一轮跳过，不让进程退出。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hub, hubSettings } from "../src/hub.ts";
import * as library from "../src/library.ts";
import { captureConsole, copyWorkspace, makeWorkspace, sqlRun, tempDir } from "./helpers.ts";

const lines = captureConsole();

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("没有库时照旧为空：事件序号是 0，修订计数是空表，调用查不到", () => {
  const empty = makeWorkspace(tmp, "no-db", false);
  assert.equal(library.maxSeq(empty), 0);
  assert.equal(library.currentMax(empty), 0);
  assert.equal(library.revisionCountsBySession(empty).size, 0);
  assert.equal(library.callFacts(empty).diagram("call-x"), null);
});

test("库在而事件表被删掉时，两个取最大事件序号的函数抛出而不是返回 0", () => {
  const dir = copyWorkspace(ws, join(tmp, "no-event"));
  sqlRun(dir, [["DROP TABLE event"]]);
  assert.throws(() => library.maxSeq(dir), /no such table: event/);
  assert.throws(() => library.currentMax(dir), /no such table: event/);
});

test("库在而修订表被删掉时，修订计数抛出而不是返回空表", () => {
  const dir = copyWorkspace(ws, join(tmp, "no-revision"));
  sqlRun(dir, [["DROP TABLE revision"]]);
  assert.throws(() => library.revisionCountsBySession(dir), /no such table: revision/);
});

test("库在而图的修订表被删掉时，按调用编号查图抛出而不是当作没有图", () => {
  const dir = copyWorkspace(ws, join(tmp, "no-diagram"));
  sqlRun(dir, [["DROP TABLE diagram_version"]]);
  assert.throws(() => library.callFacts(dir).diagram("call-x"), /no such table: diagram_version/);
});

test("定时轮询读库出错时记一行、这一轮跳过，进程不退出，之后库恢复可读时照常推送", async () => {
  const dir = copyWorkspace(ws, join(tmp, "poll"));
  const saved = hubSettings.pollMs;
  hubSettings.pollMs = 20;
  const hub = new Hub(dir, () => true);
  hubSettings.pollMs = saved;
  try {
    const before = lines.length;
    sqlRun(dir, [["ALTER TABLE event RENAME TO event_hidden"]]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(hub.stats.轮询次数 >= 2);
    assert.ok(lines.slice(before).some((line) => line.includes("事件轮询读库出错，这一轮跳过")));
    sqlRun(dir, [["ALTER TABLE event_hidden RENAME TO event"],
      ["INSERT INTO event (task_id, session_id, call_id, name, payload, actor, at) SELECT task_id, 'S1', 'c1', 'NOTE', '{}', 'user', '2026-10-19 10:00:00' FROM task"]]);
    const top = library.currentMax(dir);
    assert.ok(top > hub.forwarded);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(hub.forwarded, top);
  } finally {
    hub.close();
  }
});
