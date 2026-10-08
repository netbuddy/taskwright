/**
 * 图在助手读取的一侧：「查看条目」认图的编号，给出图名、种类、说明、Mermaid 文本、来源与改它时要写的修订号；
 * 「查询任务状态」里有一行图；保存图之前向任务服务问校验（lib/diagram_check.ts）的各种结局。
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { UNREACHABLE_WHY, checkWithService, validatePath } from "../src/lib/diagram_check.ts";
import { LOCK_NAME } from "../src/lib/knowledge_search.ts";
import { saveDiagram } from "../src/lib/save_diagram.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { getItem, getTaskStatus } from "../src/lib/task_query.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace } from "./helpers.ts";

const SAID = "把登录和退出画成一张用例图";
const MERMAID = 'flowchart LR\n  a(["UC-001 登录"])\n  b(["UC-002 退出"])';
const ok = async () => ({ ok: true as const });

async function workspace(): Promise<string> {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] },
    { op: "add", collection: "用例", fields: { 名称: "退出", 步骤: ["点退出"] }, sources: [SOURCE] },
  ] });
  await saveDiagram({ ...callIn(dir), userMessages: [{ entryId: "u1", text: SAID }] },
    { name: "登录与退出", kind: "use_case", mermaid: MERMAID, note: "读者能做的两件事。",
      sources: [{ kind: "用户的话", excerpt: SAID }, { kind: "条目", locator: "UC-001" }, { kind: "条目", locator: "UC-002", excerpt: "退出" }] }, { validate: ok });
  return dir;
}

test("查看条目写图的编号：给出这张图的内容、来源与依据的现状、图里画了谁，以及改它时用哪个工具、base_revision 写几", async () => {
  const dir = await workspace();
  // UC-001 之后改过，UC-002 之后删了；再把图的说明改一次（图的修订 2）。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }, { op: "delete", item: "UC-002", base_revision: 1 }] });
  await saveDiagram(callIn(dir), { diagram: "D-001", base_revision: 1, note: "读者能做的事。" }, { validate: ok });
  const now = getItem(dir, { item_id: "d-001" });
  assert.equal(now.text, [
    "图 D-001「登录与退出」（用例图），修订 2，是最新内容。图的修订号是图自己的，与条目的修订号无关。",
    "  改动过的修订：修订 1（发起方 executor）、修订 2（发起方 executor）。",
    "",
    "说明：读者能做的事。",
    "Mermaid 文本：",
    "<<<",
    MERMAID,
    ">>>",
    "",
    "来源（3 条）：",
    `  1. 用户的话：「${SAID}」`,
    "  2. 条目，出处 UC-001（依据已变：引用时 UC-001 是修订 1，现在是修订 2）",
    "  3. 条目，出处 UC-002：「退出」（UC-002 已经删除）",
    "图里画了 2 个条目：UC-001、UC-002。",
    "",
    "D-001 现在是修订 2。要修改或删除这张图时用 save_diagram，diagram 写 D-001，base_revision 写 2；修改时只写要改的那几项。",
  ].join("\n"));
  assert.deepEqual([now.details.diagram_id, now.details.revision_no, now.details.current_revision, now.details.revisions, now.details.kind, now.details.drawn],
    ["D-001", 2, 2, [1, 2], "use_case", ["UC-001", "UC-002"]]);
  // 看旧的一次修订；没有的修订号说明它有哪几次。
  const old = getItem(dir, { item_id: "D-001", revision_no: 1 });
  assert.match(old.text, /^图 D-001「登录与退出」（用例图），修订 1，是旧内容。/);
  assert.match(old.text, /说明：读者能做的两件事。/);
  assert.match(old.text, /这是旧内容；D-001 现在是修订 2，要修改时先看最新内容，base_revision 写 2。$/);
  assert.throws(() => getItem(dir, { item_id: "D-001", revision_no: 5 }), /图 D-001 没有修订 5；它有这些修订：修订 1、修订 2（图的修订号是图自己的）。/);
  assert.throws(() => getItem(dir, { item_id: "D-009" }), /这个任务里没有图 D-009。现有的图是：D-001。/);
  await saveDiagram(callIn(dir), { diagram: "D-001", base_revision: 2, delete: true }, { validate: ok });
  assert.throws(() => getItem(dir, { item_id: "D-001" }), /图 D-001 已经在它的修订 3 删除了。现有的图是：（一张都没有）。/);
  // 条目照旧。
  assert.match(getItem(dir, { item_id: "UC-001" }).text, /^条目 UC-001（集合「用例」）/);
});

test("查询任务状态：有图时多一行，写有几张、各是哪一张；一张都没有时不写这一行", async () => {
  const dir = await workspace();
  const line = "图 1 张：D-001「登录与退出」（用例图，修订 1）。图不是条目，不评审，不算进完成条件；要看一张图的 Mermaid 文本，用 get_item 写它的编号。";
  const status = getTaskStatus(dir, undefined, null);
  assert.ok(status.text.split("\n").includes(line), status.text);
  assert.deepEqual(status.details.diagrams, [{ diagram_id: "D-001", revision_no: 1 }]);
  await saveDiagram(callIn(dir), { diagram: "D-001", base_revision: 1, delete: true }, { validate: ok });
  const none = getTaskStatus(dir, undefined, null);
  assert.ok(!none.text.includes("图不是条目"), none.text);
  assert.deepEqual(none.details.diagrams, []);
});

test("向任务服务问校验：通过、不通过照原样、联系不上与回答了错误都算校验没有做成，不抛异常", async () => {
  const dir = makeWorkspace();
  // 没有占用标记：联系不上。
  const none = await checkWithService(dir, "TASK-1", "class", "classDiagram");
  assert.deepEqual([none.ok, !none.ok && none.reason], [false, "unavailable"]);
  assert.match(!none.ok ? none.message : "", new RegExp(`这一次没有办法校验 Mermaid 文本（${UNREACHABLE_WHY}）。这是程序这边的问题，不是文本写错了，请告诉用户。`));
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ port: 18999, host: "taskhost" }));
  const seen: [string, any][] = [];
  const answer = (status: number, body: unknown, failFirst = false): typeof fetch => (async (url: any, init: any) => {
    seen.push([String(url), JSON.parse(init.body)]);
    if (failFirst && seen.length === 1) throw new Error("连不上");
    return { status, json: async () => body } as Response;
  }) as typeof fetch;
  // 先连本机回环地址，连不上再按标记里的主机名连；请求体是种类与文本。
  assert.deepEqual(await checkWithService(dir, "TASK-1", "class", "classDiagram\n  class A", { fetch: answer(200, { ok: true, valid: true }, true) }), { ok: true });
  assert.deepEqual(seen, [
    [`http://127.0.0.1:18999${validatePath("TASK-1")}`, { kind: "class", mermaid: "classDiagram\n  class A" }],
    [`http://taskhost:18999${validatePath("TASK-1")}`, { kind: "class", mermaid: "classDiagram\n  class A" }],
  ]);
  assert.equal(validatePath("TASK-1"), "/api/v1/tasks/TASK-1/diagrams/validate");
  // 不通过：原因、行号、给助手看的话照任务服务给的原样。
  assert.deepEqual(await checkWithService(dir, "T", "class", "x", { fetch: answer(200, { ok: true, valid: false, reason: "syntax", line: 3, message: "第 3 行附近写得不对。" }) }),
    { ok: false, reason: "syntax", line: 3, message: "第 3 行附近写得不对。" });
  // 任务服务回答了错误：校验没有做成。
  const failed = await checkWithService(dir, "T", "class", "x", { fetch: answer(500, { ok: false, error: { message: "内部出错" } }) });
  assert.deepEqual([!failed.ok && failed.reason, !failed.ok && failed.message.includes("系统回答了错误：内部出错")], ["unavailable", true]);
  // 两个地址都连不上。
  const down = await checkWithService(dir, "T", "class", "x", { fetch: (async () => { throw new Error("连不上"); }) as typeof fetch });
  assert.deepEqual([!down.ok && down.reason, !down.ok && down.message.includes(UNREACHABLE_WHY)], ["unavailable", true]);
  // 这次调用被取消。
  const cancelled = await checkWithService(dir, "T", "class", "x", { fetch: answer(200, { ok: true, valid: true }), signal: AbortSignal.abort() });
  assert.deepEqual([!cancelled.ok && cancelled.reason, !cancelled.ok && cancelled.message.includes("这次调用被取消了")], ["unavailable", true]);
});
