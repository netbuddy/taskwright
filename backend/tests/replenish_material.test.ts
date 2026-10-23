/**
 * 导入后补齐材料与知识库文档（service.ts 的 replenishMaterial、acceptReplenished，knowledge.ts 的 replenish）：
 * 一个带 Word 材料的任务导出成不带材料的数据包，导入到另一个数据目录，材料缺失；再把原件补上，与导入时写下的导出时指纹（.expected.json）核对。
 * - 同一份原件：已恢复（restored），原件与三样派生文件都相同；文件回到原路径，修改时刻设回放进来的时刻；
 * - 改过一个字的原件：与导出时不同（mismatch），说明原件校验值不同；接受之后记为已接受；再补一次原件（换回）变回已恢复；
 * - 原件相同而本机分段参数不同：派生文件不同，说明里写出导出时与本机的参数；
 * - 没有 .expected.json：没有可比的（unverified）；
 * - 边界：类型不同、材料表里没有、文件在而不需要补；经接口的两条路径；
 * - 知识库文档：校验值相同才收，不同拒绝。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { exportPack, importPack } from "../src/data_pack.ts";
import { ApiError } from "../src/errors.ts";
import { dispatch } from "../src/http.ts";
import { DOC_NOT_SAME_TEXT, KnowledgeStore } from "../src/knowledge.ts";
import { ORIGINAL_DIFFERENT_TEXT } from "../src/replenish.ts";
import { ACCEPT_NOT_MISMATCH_TEXT, REPLENISH_PRESENT_TEXT, Service } from "../src/service.ts";
import { captureConsole, keepGeneral, smallDocx, tempDir } from "./helpers.ts";
import { locations, sha256 } from "./pack_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);
const DOCX = smallDocx("买家可以在七天内申请退款。", "退款原路退回。", "客服在一个工作日内处理。");
const CHANGED = smallDocx("买家可以在十天内申请退款。", "退款原路退回。", "客服在一个工作日内处理。");
const PATH = "inputs/退款规格.docx";

type Profile = Record<string, unknown>;

/** 一个任务带一份 Word 材料，导出成不带材料的包，再导入到另一个数据目录；返回那边的服务与任务（profile 是那边服务的启动配置）。 */
async function importedTask(profile: Profile = {}) {
  const source = locations(fresh("source"));
  const before = new Service(source.tasksDir, source.runsDir, {}, { port: 1, knowledgeDir: source.knowledgeDir });
  const taskId = before.create({ task_type: "requirements-engineering", task_name: "补齐材料" }).task_id as string;
  before.upload(before.task(taskId), "退款规格.docx", DOCX);
  await before.close();
  const pack = join(fresh("packs"), "task.taskwright.zip");
  mkdirSync(join(pack, ".."), { recursive: true });
  await exportPack(source, { scope: "task", taskId, to: pack });
  const target = locations(fresh("target"));
  assert.equal((await importPack(target, { file: pack })).fatal, null);
  const service = new Service(target.tasksDir, target.runsDir, profile, { port: 1, knowledgeDir: target.knowledgeDir });
  after(() => service.close());
  return { service, t: service.task(taskId), dir: join(target.tasksDir, taskId), source: join(source.tasksDir, taskId) };
}

async function rejected(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("没有被拒绝");
}

const expected = (dir: string) => JSON.parse(readFileSync(join(dir, "inputs", ".expected.json"), "utf-8"));
const materialRow = (service: Service, t: ReturnType<Service["task"]>) => (service.taskPage(t) as any).materials.find((m: any) => m.path === PATH);

test("补齐同一份原件：已恢复，原件与三样派生文件都相同；文件回到原路径、修改时刻是放进来的时刻；材料行带核对结果；再补就拒绝", async () => {
  const { service, t, dir, source } = await importedTask();
  assert.equal(existsSync(join(dir, PATH)), false);
  assert.equal(materialRow(service, t).missing, true);
  const done = await service.replenishMaterial(t, PATH, "随便什么名字.docx", DOCX);
  assert.deepEqual([done.path, done.check.original, done.check.verdict, done.check.accepted, done.check.reasons], [PATH, "same", "restored", false, []]);
  assert.deepEqual(done.check.derived.map((one) => [one.name, one.result]),
    [[`${PATH}.locations.json`, "same"], [`${PATH}.md`, "same"], [`${PATH}.segments.json`, "same"]]);
  for (const suffix of ["", ".md", ".segments.json", ".locations.json"]) {
    assert.equal(sha256(readFileSync(join(dir, PATH + suffix))), sha256(readFileSync(join(source, PATH + suffix))), suffix);
  }
  const row = materialRow(service, t);
  assert.deepEqual([row.missing, row.replenish.verdict], [false, "restored"]);
  // 设回的修改时刻与放进来的时刻至多差 1 毫秒（文件系统记时刻的精度）。
  assert.ok(Math.abs(statSync(join(dir, PATH)).mtimeMs - new Date(expected(dir).materials[0].added_at).getTime()) <= 1);
  assert.deepEqual(expected(dir).materials[0].check, done.check);
  assert.equal(readFileSync(join(dir, "inputs", ".expected.json"), "utf-8").includes('"verdict": "restored"'), true);
  // 材料清单不列 .expected.json。
  assert.deepEqual((service.taskPage(t) as any).materials.filter((m: any) => m.derived_from === null).map((m: any) => m.path), [PATH]);
  const again = await rejected(service.replenishMaterial(t, PATH, "退款规格.docx", DOCX));
  assert.deepEqual([again.code, again.message], ["rejected", REPLENISH_PRESENT_TEXT]);
  // 已恢复的没有不同可接受。
  assert.deepEqual([(await rejected(Promise.resolve().then(() => service.acceptReplenished(t, PATH)))).message], [ACCEPT_NOT_MISMATCH_TEXT]);
});

test("补齐改过一个字的原件：与导出时不同，说原件校验值不同；接受之后记为已接受；再补一次原件（换回）变回已恢复", async () => {
  const { service, t, dir } = await importedTask();
  const changed = await service.replenishMaterial(t, PATH, "退款规格.docx", CHANGED);
  assert.deepEqual([changed.check.original, changed.check.verdict, changed.check.accepted, changed.check.reasons], ["different", "mismatch", false, [ORIGINAL_DIFFERENT_TEXT]]);
  assert.equal(sha256(readFileSync(join(dir, PATH))), sha256(CHANGED));
  const accepted = service.acceptReplenished(t, PATH);
  assert.deepEqual([accepted.check.verdict, accepted.check.accepted], ["mismatch", true]);
  assert.equal(expected(dir).materials[0].check.accepted, true);
  const back = await service.replenishMaterial(t, PATH, "退款规格.docx", DOCX);
  assert.deepEqual([back.check.verdict, back.check.accepted], ["restored", false]);
  assert.equal(sha256(readFileSync(join(dir, PATH))), sha256(DOCX));
  assert.equal(existsSync(join(dir, ".replacing")), false, "暂放目录用完删掉");
});

test("原件相同而本机的分段参数与导出时不同：派生文件不同，说明里写出导出时与本机的参数", async () => {
  const { service, t } = await importedTask({ 材料分段: { heading_depth: 3, max_paragraphs: 1, min_paragraphs: 1 } });
  const done = await service.replenishMaterial(t, PATH, "退款规格.docx", DOCX);
  assert.deepEqual([done.check.original, done.check.verdict], ["same", "mismatch"]);
  assert.ok(done.check.derived.some((one) => one.name === `${PATH}.segments.json` && one.result === "different"), JSON.stringify(done.check.derived));
  assert.deepEqual(done.check.reasons, [
    "本机的解析规则或参数与导出时不同（导出时 分段参数 标题层级 3、每块至多 300 段、至少 3 段；本机 分段参数 标题层级 3、每块至多 1 段、至少 1 段）",
  ]);
});

test("没有导出时的指纹（.expected.json 不在）：照样补上，结论是没有可比的", async () => {
  const { service, t, dir } = await importedTask();
  rmSync(join(dir, "inputs", ".expected.json"));
  const done = await service.replenishMaterial(t, PATH, "退款规格.docx", DOCX);
  assert.deepEqual([done.check.verdict, done.check.original, done.check.derived], ["unverified", null, []]);
  assert.equal(existsSync(join(dir, PATH)), true);
});

test("补齐的边界：类型不同、材料表里没有这份材料都拒绝，什么都不写；与材料同名不算重名", async () => {
  const { service, t, dir } = await importedTask();
  const wrongType = await rejected(service.replenishMaterial(t, PATH, "退款规格.md", Buffer.from("x")));
  assert.deepEqual([wrongType.code, wrongType.message], ["bad_request", "补齐要上传与《退款规格.docx》同一种类型的文件。"]);
  const unknown = await rejected(service.replenishMaterial(t, "inputs/没有的.docx", "没有的.docx", DOCX));
  assert.equal(unknown.code, "not_found");
  assert.equal(existsSync(join(dir, PATH)), false);
  // 与缺失的材料同名：补齐不经重名检查，照常收下。
  assert.equal((await service.replenishMaterial(t, PATH, "退款规格.docx", DOCX)).check.verdict, "restored");
});

function multipart(filename: string, data: Buffer): [Buffer, Record<string, string>] {
  const head = Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return [Buffer.concat([head, data, Buffer.from("\r\n--B--\r\n")]), { "content-type": "multipart/form-data; boundary=B" }];
}

test("经接口：POST …/materials/replenish?path=… 收一份文件、回核对结果；POST …/materials/replenish/accept?path=… 接受", async () => {
  const { service, t } = await importedTask();
  const [body, headers] = multipart("退款规格.docx", CHANGED);
  const done = (await dispatch(service, { method: "POST", path: `/api/v1/tasks/${t.taskId}/materials/replenish`, query: { path: PATH }, headers, body })) as any;
  const result = JSON.parse(done.body.toString());
  assert.deepEqual([done.status, result.ok, result.path, result.check.verdict], [200, true, PATH, "mismatch"]);
  const accepted = (await dispatch(service, { method: "POST", path: `/api/v1/tasks/${t.taskId}/materials/replenish/accept`, query: { path: PATH }, headers: {}, body: Buffer.alloc(0) })) as any;
  assert.deepEqual([accepted.status, JSON.parse(accepted.body.toString()).check.accepted], [200, true]);
});

test("知识库文档：导入不带文档的库之后清单里的文档标缺失；校验值相同才收，补上之后不再缺失；不同就拒绝，什么都不写", async () => {
  const source = locations(fresh("lib-source"));
  keepGeneral(source.knowledgeDir);
  const store = new KnowledgeStore(source.knowledgeDir);
  const lib = store.create("售后规范");
  const text = Buffer.from("退款处理规范全文\n".repeat(20), "utf-8");
  await store.upload(lib.id, "退款处理规范.md", text, "standard");
  const pack = join(fresh("lib-packs"), "lib.taskwright.zip");
  mkdirSync(join(pack, ".."), { recursive: true });
  await exportPack(source, { scope: "library", libraryId: lib.id, to: pack });
  const target = locations(fresh("lib-target"));
  assert.equal((await importPack(target, { file: pack })).fatal, null);
  const service = new Service(target.tasksDir, target.runsDir, {}, { port: 1, knowledgeDir: target.knowledgeDir });
  after(() => service.close());
  const doc = () => service.knowledgeOverview().find((one) => one.id === lib.id)!.documents.find((one) => one.name === "退款处理规范.md")!;
  assert.equal(doc().missing, true);
  const wrong = await rejected(service.replenishDocument(lib.id, "退款处理规范.md", Buffer.from("别的内容", "utf-8")));
  assert.deepEqual([wrong.code, wrong.message], ["rejected", DOC_NOT_SAME_TEXT]);
  assert.equal(doc().missing, true);
  assert.deepEqual(await service.replenishDocument(lib.id, "退款处理规范.md", text), { ok: true, name: "退款处理规范.md" });
  assert.equal(doc().missing, false);
  assert.equal(sha256(readFileSync(join(target.knowledgeDir, lib.id, "files", "退款处理规范.md"))), sha256(text));
});
