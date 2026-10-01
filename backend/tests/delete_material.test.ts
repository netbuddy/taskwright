/**
 * 删除材料：本体连同 Word 材料的派生文件一起删、发 material_removed；助手正在工作时拒绝；路径不在材料目录里、
 * 或者是派生文件的路径时拒绝；任务已结束时拒绝。条目上引用它的来源不动（后端不改来源数据）。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { dispatch } from "../src/http.ts";
import { Service } from "../src/service.ts";
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
