/**
 * 材料的槽位与角色（任务库的材料表，格式 11）：经接口上传时可以带 slot（流程声明里收材料的槽位键），角色取那个槽位的；
 * 不带时槽位空、角色「证据」；带了不存在的槽位键拒绝，什么都不写。替换时新文件沿用被换掉的那份的槽位与角色，旧行写上删除的时刻；
 * 删除时那一行写上删除的时刻。材料清单每份带 slot 与 role，material_added 事件也带这两项；材料表里没有行的材料按「证据」算。
 */

import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { dispatch } from "../src/http.ts";
import { Service } from "../src/service.ts";
import { captureConsole, sqlRun, tempDir } from "./helpers.ts";
import { DatabaseSync } from "node:sqlite";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

async function withTask(body: (service: Service, t: ReturnType<Service["task"]>) => Promise<void> | void) {
  const root = join(tmp, `case-${++n}`);
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    await body(service, service.task(service.create({ task_type: "requirements-engineering", task_name: "材料槽位" }).task_id));
  } finally {
    await service.close();
  }
}

/** 一个文件，另可带 slot 字段。 */
function multipart(filename: string, data: string, slot: string | null): [Buffer, Record<string, string>] {
  const parts: Buffer[] = [];
  if (slot !== null) parts.push(Buffer.from(`--B\r\nContent-Disposition: form-data; name="slot"\r\n\r\n${slot}\r\n`));
  parts.push(Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(Buffer.from(data), Buffer.from("\r\n--B--\r\n"));
  return [Buffer.concat(parts), { "content-type": "multipart/form-data; boundary=B" }];
}

async function upload(service: Service, taskId: string, filename: string, data: string, slot: string | null = null) {
  const [body, headers] = multipart(filename, data, slot);
  const reply = (await dispatch(service, { method: "POST", path: `/api/v1/tasks/${taskId}/materials`, query: {}, headers, body })) as any;
  return { status: reply.status as number, body: JSON.parse(reply.body.toString()) };
}

async function replace(service: Service, taskId: string, path: string, filename: string, data: string) {
  const [body, headers] = multipart(filename, data, null);
  const reply = (await dispatch(service, { method: "POST", path: `/api/v1/tasks/${taskId}/materials/replace`, query: { path }, headers, body })) as any;
  return { status: reply.status as number, body: JSON.parse(reply.body.toString()) };
}

async function listed(service: Service, taskId: string) {
  const reply = (await dispatch(service, { method: "GET", path: `/api/v1/tasks/${taskId}`, query: {}, headers: {}, body: Buffer.alloc(0) })) as any;
  return (JSON.parse(reply.body.toString()).materials as Record<string, any>[]).map((m) => [m.path, m.slot, m.role]);
}

function rows(dir: string): Record<string, any>[] {
  const db = new DatabaseSync(join(dir, "task.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT path, slot, role, added_at, removed_at FROM material ORDER BY material_id").all() as Record<string, any>[]).map((one) => ({ ...one }));
  } finally {
    db.close();
  }
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

test("不带 slot 上传：槽位空、角色「证据」；带 slot=spec：角色取槽位的「既有规格说明」；两份各记一行", () => withTask(async (service, t) => {
  assert.equal((await upload(service, t.taskId, "纪要.md", "评审纪要。")).status, 200);
  assert.equal((await upload(service, t.taskId, "规格说明.md", "旧版规格说明。", "spec")).status, 200);
  assert.deepEqual(await listed(service, t.taskId), [["inputs/纪要.md", null, "证据"], ["inputs/规格说明.md", "spec", "既有规格说明"]]);
  const got = rows(t.dir);
  assert.deepEqual(got.map((one) => [one.path, one.slot, one.role, one.removed_at]), [["inputs/纪要.md", null, "证据", null], ["inputs/规格说明.md", "spec", "既有规格说明", null]]);
  for (const one of got) assert.match(one.added_at, LOCAL_TIME);
}));

test("带不存在的槽位键、或收文字的槽位键：拒绝，材料目录里没有文件，材料表没有行，不发 material_added", () => withTask(async (service, t) => {
  const [sub] = t.hub.subscribe(null, null);
  for (const slot of ["nothing", "goal"]) {
    const got = await upload(service, t.taskId, "规格说明.md", "旧版规格说明。", slot);
    assert.deepEqual([got.status, got.body.error.code, got.body.error.message], [400, "bad_request", `没有叫「${slot}」的材料槽位。`]);
  }
  let names: string[] = [];
  try {
    names = readdirSync(join(t.dir, "inputs"));
  } catch {
    // 材料目录还没有建
  }
  assert.deepEqual(names, []);
  assert.deepEqual(rows(t.dir), []);
  const events = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) events.push(item);
  assert.deepEqual(events.filter((e) => e[0] === "material_added"), []);
}));

test("material_added 事件带 slot 与 role", () => withTask(async (service, t) => {
  const [sub] = t.hub.subscribe(null, null);
  await upload(service, t.taskId, "规格说明.md", "旧版规格说明。", "spec");
  await upload(service, t.taskId, "纪要.md", "评审纪要。");
  const events = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) events.push(item);
  assert.deepEqual(events.filter((e) => e[0] === "material_added").map((e) => [(e[2] as any).path, (e[2] as any).slot, (e[2] as any).role]),
    [["inputs/规格说明.md", "spec", "既有规格说明"], ["inputs/纪要.md", null, "证据"]]);
}));

test("替换：新文件沿用旧的槽位与角色，旧行写上删除的时刻；删除：那一行写上删除的时刻，清单里没有它", () => withTask(async (service, t) => {
  await upload(service, t.taskId, "规格说明.md", "旧版规格说明。", "spec");
  const done = await replace(service, t.taskId, "inputs/规格说明.md", "规格说明第二版.md", "改过的规格说明。");
  assert.equal(done.status, 200);
  assert.deepEqual(await listed(service, t.taskId), [["inputs/规格说明第二版.md", "spec", "既有规格说明"]]);
  let got = rows(t.dir);
  assert.deepEqual(got.map((one) => [one.path, one.slot, one.role]), [["inputs/规格说明.md", "spec", "既有规格说明"], ["inputs/规格说明第二版.md", "spec", "既有规格说明"]]);
  assert.match(got[0].removed_at, LOCAL_TIME);
  assert.equal(got[1].removed_at, null);
  service.deleteMaterial(t, "inputs/规格说明第二版.md");
  assert.deepEqual(await listed(service, t.taskId), []);
  got = rows(t.dir);
  assert.match(got[1].removed_at, LOCAL_TIME);
  // 同一路径删了再传是新的一行，不经槽位就是「证据」。
  await upload(service, t.taskId, "规格说明第二版.md", "又传了一次。");
  assert.deepEqual(rows(t.dir).map((one) => [one.path, one.role, one.removed_at === null]),
    [["inputs/规格说明.md", "既有规格说明", false], ["inputs/规格说明第二版.md", "既有规格说明", false], ["inputs/规格说明第二版.md", "证据", true]]);
}));

test("材料表里没有行的材料（升级前就有的）：清单里槽位空、角色「证据」；替换它时新文件也是「证据」", () => withTask(async (service, t) => {
  writeFileSync(join(t.dir, "inputs", "旧材料.md"), "升级前放进来的。");
  assert.deepEqual(await listed(service, t.taskId), [["inputs/旧材料.md", null, "证据"]]);
  await replace(service, t.taskId, "inputs/旧材料.md", "新材料.md", "换上来的。");
  assert.deepEqual(rows(t.dir).map((one) => [one.path, one.slot, one.role]), [["inputs/新材料.md", null, "证据"]]);
  // 早于格式 11 的库没有材料表：读清单不出错，照样按「证据」算。
  sqlRun(t.dir, [["DROP TABLE material"]]);
  assert.deepEqual(await listed(service, t.taskId), [["inputs/新材料.md", null, "证据"]]);
}));
