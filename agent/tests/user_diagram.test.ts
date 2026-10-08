/**
 * 用户在页面上改图（lib/user_diagram.ts）与它在 /tw-user 里的那一路（hooks/user_commands.ts）：改了记作这张图自己的一次新修订，
 * 发起方是用户，来源沿用上一次的；不核对文本里的条目编号与来源；修订号过时、文本没变、图不在、任务结束、参数不对各有各的拒绝。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { USER_COMMAND, USER_EDIT_CUSTOM_TYPE, USER_RESULT_KEY, registerUserCommands } from "../src/hooks/user_commands.ts";
import { saveDiagram } from "../src/lib/save_diagram.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DIAGRAM_OP_KIND, diagramEditNote, editDiagram } from "../src/lib/user_diagram.ts";
import { UserOpError } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace, query } from "./helpers.ts";

const USER_SAID = "把登录和退出画成一张用例图";
const MERMAID = 'flowchart LR\n  user(["读者"])\n  a(["UC-001 登录"])\n  b(["UC-002 退出"])\n  user --> a\n  user --> b';
const SOURCES = [{ kind: "用户的话", excerpt: USER_SAID }, { kind: "条目", locator: "UC-001" }, { kind: "条目", locator: "UC-002" }];

/** 任务里有 UC-001、UC-002 与助手画的 D-001（修订 1，三条来源）。 */
async function workspace(): Promise<string> {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] },
    { op: "add", collection: "用例", fields: { 名称: "退出", 步骤: ["点退出"] }, sources: [SOURCE] },
  ] });
  await saveDiagram({ ...callIn(dir), userMessages: [{ entryId: "u1", text: `${USER_SAID}，谢谢。` }] },
    { name: "登录与退出", kind: "use_case", mermaid: MERMAID, sources: SOURCES }, { validate: async () => ({ ok: true }) });
  return dir;
}

const ctx = (dir: string) => ({ workspaceDir: dir, sessionId: "sess-ui" });
const request = (mermaid: string, over: Record<string, unknown> = {}) =>
  ({ op_id: "ui-op-1", kind: DIAGRAM_OP_KIND, targets: [{ diagram_id: "D-001", base_revision: 1 }], fields: { mermaid }, ...over });
const versions = (dir: string) =>
  query<any>(dir, "SELECT revision_no, op, name, kind, mermaid, actor, call_id FROM diagram_version WHERE diagram_id = 'D-001' ORDER BY revision_no").map((row) => ({ ...row }));
const sourcesAt = (dir: string, revisionNo: number) =>
  query<any>(dir, "SELECT kind, locator FROM item_source WHERE element_kind = '图' AND item_id = 'D-001' AND revision_no = ? ORDER BY position", revisionNo).map((row) => ({ ...row }));
const rejected = async (run: () => Promise<unknown>): Promise<UserOpError> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof UserOpError, String(error));
    return error;
  }
  throw new Error("应当被拒绝");
};

test("用户改了 Mermaid 文本：记作图自己的一次新修订，发起方是用户，图名、种类与来源沿用上一次的", async () => {
  const dir = await workspace();
  const changed = `${MERMAID}\n  a -. 包含 .-> b`;
  const result = await editDiagram(ctx(dir), request(changed));
  assert.deepEqual({ ...result, event_seqs: result.event_seqs.length }, {
    op_id: "ui-op-1", kind: "edit_diagram", event_seqs: 1, results: [{ diagram_id: "D-001", revision_no: 2 }], revision_no: null,
    note: diagramEditNote("D-001", "登录与退出", 2), undoable: false,
  });
  assert.equal(result.note, "界面操作（不是用户打的字）：用户在界面上改了图 D-001「登录与退出」的 Mermaid 文本，D-001 现在是修订 2。要看现在的文本，用 get_item 写 D-001。");
  const rows = versions(dir);
  assert.deepEqual(rows.map((row) => [row.revision_no, row.op, row.name, row.kind, row.actor, row.call_id]),
    [[1, "add", "登录与退出", "use_case", "executor", rows[0].call_id], [2, "update", "登录与退出", "use_case", "user", "ui-op-1"]]);
  assert.equal(rows[1].mermaid, changed);
  assert.deepEqual(sourcesAt(dir, 2), sourcesAt(dir, 1));
  assert.equal(sourcesAt(dir, 2).length, 3);
  // 图的修订不占任务的修订序号。
  assert.deepEqual(query<any>(dir, "SELECT MAX(revision_no) AS n FROM revision").map((row) => row.n), [1]);
  const event = query<any>(dir, "SELECT name, actor, call_id, payload FROM event WHERE seq = ?", result.event_seqs[0])[0];
  assert.deepEqual([event.name, event.actor, event.call_id], ["DIAGRAM_SAVED", "user", "ui-op-1"]);
});

test("用户改图不核对条目编号与来源：多画一个没有来源的条目、写了任务里没有的编号、去掉了原来画着的条目，都存得上", async () => {
  const dir = await workspace();
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "改口令", 步骤: ["输入旧口令"] }, sources: [SOURCE] }] });
  const changed = 'flowchart LR\n  a(["UC-001 登录"])\n  c(["UC-003 改口令"])\n  x(["UC-404 不存在的"])\n  a --> c\n  a --> x';
  const result = await editDiagram(ctx(dir), request(changed));
  assert.equal(result.results[0].revision_no, 2);
  // 来源还是原来那三条（其中 UC-002 已经不在图里），没有因为画了 UC-003 而要求补来源。
  assert.deepEqual(sourcesAt(dir, 2).map((row) => [row.kind, row.locator]), [["用户的话", "session-test#u1"], ["条目", "UC-001"], ["条目", "UC-002"]]);
  // 助手照旧两条都拦。
  await assert.rejects(saveDiagram({ ...callIn(dir), userMessages: [] }, { diagram: "D-001", base_revision: 2, mermaid: `${changed}\n  x --> a` }, { validate: async () => ({ ok: true }) }),
    /UC-404 在这个任务里不存在/);
});

test("拒绝：修订号过时、文本没有改、图不存在或已删除、任务已经结束、参数不对；被拒时什么都不写", async () => {
  const dir = await workspace();
  const stale = await rejected(() => editDiagram(ctx(dir), request(`${MERMAID}\n`, { targets: [{ diagram_id: "D-001", base_revision: 3 }] })));
  assert.equal(stale.code, "stale_revision");
  assert.equal(stale.message, "图 D-001 刚被改过（可能是助手，也可能是另一个页面），现在是修订 1，请看最新内容后再改。");
  assert.deepEqual(stale.data, { diagrams: [{ diagram_id: "D-001", base_revision: 3, current_revision: 1, changed_by: "executor" }] });
  const same = await rejected(() => editDiagram(ctx(dir), request(MERMAID)));
  assert.deepEqual([same.code, same.message], ["rejected", "图 D-001 的 Mermaid 文本没有改动。"]);
  for (const id of ["D-009", "UC-001", "乱写"]) {
    const missing = await rejected(() => editDiagram(ctx(dir), request("flowchart LR\n  a --> b", { targets: [{ diagram_id: id, base_revision: 1 }] })));
    assert.deepEqual([missing.code, missing.message], ["rejected", `图 ${id} 不存在或已经删除。`]);
  }
  for (const bad of [
    { op_id: "op-1" }, { targets: [] }, { targets: [{ diagram_id: "D-001" }] }, { targets: [{ diagram_id: "D-001", base_revision: 1 }, { diagram_id: "D-001", base_revision: 1 }] },
    { fields: {} }, { fields: { mermaid: "  " } }, { fields: { mermaid: "flowchart LR\n  a --> b", name: "改名" } }, { task_id: "TASK-别的" },
  ]) {
    assert.equal((await rejected(() => editDiagram(ctx(dir), request("flowchart LR\n  a --> b", bad)))).code, "bad_request", JSON.stringify(bad));
  }
  assert.equal(versions(dir).length, 1);

  await saveDiagram({ ...callIn(dir), userMessages: [] }, { diagram: "D-001", base_revision: 1, delete: true }, { validate: async () => ({ ok: true }) });
  const gone = await rejected(() => editDiagram(ctx(dir), request("flowchart LR\n  a --> b", { targets: [{ diagram_id: "D-001", base_revision: 2 }] })));
  assert.deepEqual([gone.code, gone.message], ["rejected", "图 D-001 不存在或已经删除。"]);

  const closed = await workspace();
  completeTaskNow(closed);
  const late = await rejected(() => editDiagram(ctx(closed), request(`${MERMAID}\n  a --> b`)));
  assert.equal(late.code, "task_closed");
  assert.equal(versions(closed).length, 1);
});

/** 把任务标成已完成（直接改库里的状态：这里只要「任务已经结束」这个前提）。 */
function completeTaskNow(dir: string): void {
  const db = new DatabaseSync(databasePath(dir));
  try {
    db.prepare("UPDATE task SET status = '已完成'").run();
  } finally {
    db.close();
  }
}

test("/tw-user 里的 edit_diagram：改成了往会话里追加一句不可撤销的说明并回报成功；被拒时回报错误码与说明，不追加", async () => {
  const dir = await workspace();
  const sent: any[] = [];
  const commands = new Map<string, any>();
  registerUserCommands({ registerCommand: (name: string, spec: any) => commands.set(name, spec), sendMessage: (message: any) => sent.push(message), sendUserMessage() { throw new Error("改图不该另外发话"); } } as any);
  const status: Record<string, string> = {};
  const fake = { mode: "rpc", cwd: dir, sessionManager: { getSessionId: () => "sess-ui" }, ui: { setStatus: (key: string, value: string) => (status[key] = value), notify() {} } };
  const handler = commands.get(USER_COMMAND).handler as (args: string, ctx: any) => Promise<void>;

  await handler(JSON.stringify(request(`${MERMAID}\n  a --> b`, { op_id: "ui-op-7" })), fake);
  const done = JSON.parse(status[USER_RESULT_KEY]);
  assert.deepEqual({ ...done, event_seqs: done.event_seqs.length }, { op_id: "ui-op-7", ok: true, event_seqs: 1, results: [{ diagram_id: "D-001", revision_no: 2 }], revision_no: null });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, USER_EDIT_CUSTOM_TYPE);
  assert.equal(sent[0].content, diagramEditNote("D-001", "登录与退出", 2));
  assert.deepEqual({ ...sent[0].details, event_seqs: 1 }, { op_id: "ui-op-7", kind: "edit_diagram", event_seqs: 1, results: [{ diagram_id: "D-001", revision_no: 2 }], revision_no: null, undoable: false });

  await handler(JSON.stringify(request(`${MERMAID}\n  b --> a`, { op_id: "ui-op-8" })), fake);
  const refused = JSON.parse(status[USER_RESULT_KEY]);
  assert.deepEqual([refused.op_id, refused.ok, refused.error.code], ["ui-op-8", false, "stale_revision"]);
  assert.equal(sent.length, 1);
  assert.equal(versions(dir).length, 2);
});
