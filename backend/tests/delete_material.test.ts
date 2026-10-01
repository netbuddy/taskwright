/**
 * 删除材料：本体连同 Word 材料的派生文件一起删、发 material_removed；助手正在工作时拒绝；路径不在材料目录里、
 * 或者是派生文件的路径时拒绝；任务已结束时拒绝。
 * 已经进入对话的材料拒绝删除：材料上传之后（文件的修改时刻）任务里任何一条会话有过活动，就算进入了对话；按毫秒比，相等算进入。
 * 任务详情里每份材料带 deletable（同一个判据），每条会话带 revision_count（这条会话产生了几次修订）。
 * 会话文件在这里直接写出来（一行会话头，之后每行一条消息），不起助手。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { dispatch } from "../src/http.ts";
import { ENTERED_CONVERSATION_TEXT, Service } from "../src/service.ts";
import { ROOT, captureConsole, sqlRun, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

async function withTask(body: (service: Service, t: ReturnType<Service["task"]>) => Promise<void> | void) {
  const root = join(tmp, `case-${++n}`);
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    await body(service, service.task(service.create({ task_type: "srs-authoring", task_name: "删除材料" }).task_id));
  } finally {
    await service.close();
  }
}

function rejected(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("没有被拒绝");
}

const files = (t: { dir: string }) => readdirSync(join(t.dir, "inputs")).sort();

test("删除 Word 材料：本体、投影、分段清单、位置表与图片目录一起删，发一条 material_removed", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  service.upload(t, "补充.md", Buffer.from("补充说明。"));
  assert.ok(files(t).length > 2);
  const [sub] = t.hub.subscribe(null, null);
  assert.deepEqual(service.deleteMaterial(t, "inputs/需求.docx", "S1"), { ok: true, path: "inputs/需求.docx" });
  assert.deepEqual(files(t), ["补充.md"]);
  const events = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) events.push(item);
  const removed = events.filter((e) => e[0] === "material_removed");
  assert.equal(removed.length, 1);
  assert.equal((removed[0][2] as any).path, "inputs/需求.docx");
  assert.equal((removed[0][2] as any).session_id, "S1");
  assert.deepEqual(service.taskPage(t).materials.map((m: any) => m.path), ["inputs/补充.md"]);
}));

test("派生文件的路径、材料目录之外的路径、不存在的材料：一律拒绝，什么都不删", () => withTask((service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const before = files(t);
  const derived = rejected(() => service.deleteMaterial(t, "inputs/需求.docx.md"));
  assert.deepEqual([derived.code, derived.message], ["bad_request", "这是由 Word 材料生成的文件，不能单独删除。"]);
  const outside = rejected(() => service.deleteMaterial(t, "task.sqlite"));
  assert.deepEqual([outside.code, outside.message], ["bad_request", "路径 task.sqlite 不在材料目录 inputs/ 里。"]);
  assert.equal(rejected(() => service.deleteMaterial(t, "inputs/../task.sqlite")).code, "bad_request");
  assert.equal(rejected(() => service.deleteMaterial(t, "inputs/没有.md")).code, "not_found");
  assert.deepEqual(files(t), before);
}));

test("助手正在工作时拒绝删除，说明写明结束后再删", () => withTask((service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  t.executor.state = "working";
  try {
    const busy = rejected(() => service.deleteMaterial(t, "inputs/需求.md"));
    assert.deepEqual([busy.code, busy.status, busy.message, busy.data.reason], ["session_busy", 409, "助手正在工作，结束后才能删除材料。", "working"]);
    assert.deepEqual(files(t), ["需求.md"]);
  } finally {
    t.executor.state = "not_started";
  }
}));

test("任务已结束时拒绝删除", () => withTask((service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  sqlRun(t.dir, [["UPDATE task SET status = '已完成'"]]);
  assert.equal(rejected(() => service.deleteMaterial(t, "inputs/需求.md")).code, "task_closed");
  assert.deepEqual(files(t), ["需求.md"]);
}));

test("经接口 POST …/materials/delete {path}", () => withTask(async (service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  const reply = (await dispatch(service, {
    method: "POST", path: `/api/v1/tasks/${t.taskId}/materials/delete`, query: {}, headers: {}, body: Buffer.from(JSON.stringify({ path: "inputs/需求.md" })),
  })) as any;
  assert.deepEqual([reply.status, JSON.parse(reply.body.toString())], [200, { ok: true, path: "inputs/需求.md" }]);
  assert.deepEqual(files(t), []);
}));

// ───────────── 进入对话之后不许删除 ─────────────

type TaskOf = ReturnType<Service["task"]>;

/** 在任务的会话目录里写一条会话文件：开始时刻 start，之后在 messages 的每个时刻各有一条用户消息。 */
function writeSession(t: TaskOf, id: string, start: Date, messages: Date[] = []): void {
  const dir = t.executor.sessions.dir;
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session", id, timestamp: start.toISOString() },
    ...messages.map((at, i) => ({ type: "message", id: `${id}-m${i + 1}`, timestamp: at.toISOString(), message: { role: "user", content: "请整理。" } })),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

/** 上传一份材料，并把它的上传时刻（文件的修改时刻）定在 at。 */
function uploadAt(service: Service, t: TaskOf, name: string, at: Date): string {
  const { path } = service.upload(t, name, Buffer.from(`${name} 的内容。`));
  utimesSync(join(t.dir, path), at, at);
  return path;
}

const deletableOf = (service: Service, t: TaskOf) => Object.fromEntries(service.taskPage(t).materials.map((m: any) => [m.path, m.deletable]));
const at = (text: string) => new Date(text);

test("还没有任何会话活动时材料可以删除，任务详情里它的 deletable 为真", () => withTask((service, t) => {
  const path = uploadAt(service, t, "需求.md", at("2026-09-30T10:00:00.000Z"));
  assert.deepEqual(deletableOf(service, t), { [path]: true });
  assert.deepEqual(service.deleteMaterial(t, path), { ok: true, path });
  assert.deepEqual(files(t), []);
}));

test("材料上传之后新开的会话有过活动：删除被拒绝并写明已经进入了对话，文件还在，deletable 为假", () => withTask((service, t) => {
  const path = uploadAt(service, t, "需求.md", at("2026-09-30T10:00:00.000Z"));
  writeSession(t, "S1", at("2026-09-30T10:05:00.000Z"), [at("2026-09-30T10:05:30.000Z")]);
  assert.deepEqual(deletableOf(service, t), { [path]: false });
  const refused = rejected(() => service.deleteMaterial(t, path));
  assert.deepEqual([refused.code, refused.status, refused.message], ["rejected", 422, "这份材料已经进入了对话，不能删除。"]);
  assert.equal(refused.message, ENTERED_CONVERSATION_TEXT);
  assert.deepEqual(refused.data, { path, reasons: [ENTERED_CONVERSATION_TEXT] });
  assert.deepEqual(files(t), ["需求.md"]);
}));

test("在一条早已开始的会话里上传材料，之后这条会话又有活动：同样算进入了对话", () => withTask((service, t) => {
  writeSession(t, "S1", at("2026-09-30T09:00:00.000Z"), [at("2026-09-30T09:01:00.000Z"), at("2026-09-30T10:00:05.000Z")]);
  const path = uploadAt(service, t, "补充.md", at("2026-09-30T10:00:00.000Z"));
  assert.deepEqual(deletableOf(service, t), { [path]: false });
  assert.equal(rejected(() => service.deleteMaterial(t, path)).code, "rejected");
}));

test("全部会话的活动都在材料上传之前：材料还没有进入对话，可以删除", () => withTask((service, t) => {
  writeSession(t, "S1", at("2026-09-30T09:00:00.000Z"), [at("2026-09-30T09:01:00.000Z")]);
  writeSession(t, "S2", at("2026-09-30T09:30:00.000Z"));
  const path = uploadAt(service, t, "补充.md", at("2026-09-30T10:00:00.000Z"));
  assert.deepEqual(deletableOf(service, t), { [path]: true });
  assert.deepEqual(service.deleteMaterial(t, path), { ok: true, path });
}));

// 文件系统记的修改时刻比毫秒细，设进去的时刻也未必一丝不差，所以先上传、读回实际的修改时刻（截到毫秒），再按它造会话的时刻。
for (const [label, offset, deletable] of [["在同一毫秒：算进入了对话", 0, false], ["早一毫秒：不算进入", -1, true]] as const) {
  test(`按毫秒比较，会话的最近活动与材料的上传${label}`, () => withTask((service, t) => {
    const path = uploadAt(service, t, "需求.md", at("2026-09-30T10:00:00.250Z"));
    const uploaded = Math.floor(statSync(join(t.dir, path)).mtimeMs);
    writeSession(t, "S1", at("2026-09-30T09:00:00.000Z"), [new Date(uploaded + offset)]);
    assert.deepEqual(deletableOf(service, t), { [path]: deletable });
    if (deletable) assert.deepEqual(service.deleteMaterial(t, path), { ok: true, path });
    else assert.equal(rejected(() => service.deleteMaterial(t, path)).code, "rejected");
  }));
}

test("每份材料各按自己的上传时刻判断：会话活动之前上传的不可删除，之后上传的可以删除", () => withTask((service, t) => {
  const before = uploadAt(service, t, "先传的.md", at("2026-09-30T10:00:00.000Z"));
  writeSession(t, "S1", at("2026-09-30T10:05:00.000Z"), [at("2026-09-30T10:06:00.000Z")]);
  const after = uploadAt(service, t, "后传的.md", at("2026-09-30T10:10:00.000Z"));
  assert.deepEqual(deletableOf(service, t), { [before]: false, [after]: true });
}));

test("已经进入对话、助手又正在工作时，拒绝的原因写进入了对话，不写正在工作", () => withTask((service, t) => {
  const path = uploadAt(service, t, "需求.md", at("2026-09-30T10:00:00.000Z"));
  writeSession(t, "S1", at("2026-09-30T10:05:00.000Z"));
  t.executor.state = "working";
  try {
    assert.equal(rejected(() => service.deleteMaterial(t, path)).code, "rejected");
  } finally {
    t.executor.state = "not_started";
  }
}));

test("deletable 对派生文件与已结束的任务为假", () => withTask((service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const open = deletableOf(service, t);
  assert.equal(open["inputs/需求.docx"], true);
  assert.equal(open["inputs/需求.docx.md"], false);
  sqlRun(t.dir, [["UPDATE task SET status = '已完成'"]]);
  assert.ok(Object.values(deletableOf(service, t)).every((value) => value === false));
}));

test("经接口删除一份已经进入对话的材料：返回 422 与 rejected", () => withTask(async (service, t) => {
  const path = uploadAt(service, t, "需求.md", at("2026-09-30T10:00:00.000Z"));
  writeSession(t, "S1", at("2026-09-30T10:05:00.000Z"));
  const reply = (await dispatch(service, {
    method: "POST", path: `/api/v1/tasks/${t.taskId}/materials/delete`, query: {}, headers: {}, body: Buffer.from(JSON.stringify({ path })),
  })) as any;
  const body = JSON.parse(reply.body.toString());
  assert.deepEqual([reply.status, body.ok, body.error.code, body.error.message], [422, false, "rejected", "这份材料已经进入了对话，不能删除。"]);
  assert.deepEqual(files(t), ["需求.md"]);
}));

test("会话清单每条带 revision_count：按修订表里的会话编号计数，没有修订的会话是 0；任务详情与会话清单接口给的相同", () => withTask(async (service, t) => {
  writeSession(t, "S1", at("2026-09-30T09:00:00.000Z"), [at("2026-09-30T09:01:00.000Z")]);
  writeSession(t, "S2", at("2026-09-30T09:30:00.000Z"));
  const insert = "INSERT INTO revision (task_id, revision_no, session_id, call_id, event_seq, created_at, summary, intent_act_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)";
  sqlRun(t.dir, [
    [insert, t.taskId, 1, "S1", "call-1", 1, "2026-09-30T09:01:10", "[]"],
    [insert, t.taskId, 2, "S1", "call-2", 1, "2026-09-30T09:01:20", "[]"],
  ]);
  const counts = (rows: any[]) => Object.fromEntries(rows.map((row) => [row.session_id, row.revision_count]));
  assert.deepEqual(counts(service.taskPage(t).sessions), { S1: 2, S2: 0 });
  const reply = (await dispatch(service, { method: "GET", path: `/api/v1/tasks/${t.taskId}/sessions`, query: {}, headers: {}, body: Buffer.alloc(0) })) as any;
  assert.deepEqual(counts(JSON.parse(reply.body.toString()).sessions), { S1: 2, S2: 0 });
  assert.deepEqual(Object.keys(service.taskPage(t).sessions[0]).sort(),
    ["active", "last_active_at", "message_count", "name", "revision_count", "session_id", "started_at"]);
}));
