/**
 * 去掉写死的「通用知识库」之后的就地升级：服务启动时，先前版本留下的通用知识库（编号 general）是空的就删掉，
 * 有文档的留下成为普通的库（可以改名、可以删除，名字还是旧名「通用库」时改成「通用知识库」）。
 * 没有 knowledge.json 的旧任务仍按选用 general 算：库还在就照旧用到它，库已经删掉时各处都跳过它。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { selectedKnowledge } from "../../agent/src/lib/knowledge.ts";
import { GENERAL } from "../src/knowledge.ts";
import { Service } from "../src/service.ts";
import { captureConsole, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
const logs = captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** 先前版本留下的知识库目录：清单里有通用知识库与一个别的库；docs 给了时通用知识库里有这几份文档。 */
function oldKnowledge(docs: Record<string, string>, name = "通用知识库"): string {
  const dir = join(tmp, `case-${++n}`, "knowledge");
  const rows = [{ id: GENERAL, name, created_at: "2026-09-29T10:00:00+08:00" }, { id: "lib-a1", name: "行业规范", created_at: "2026-09-29T11:00:00+08:00" }];
  mkdirSync(join(dir, GENERAL, "files"), { recursive: true });
  mkdirSync(join(dir, "lib-a1", "files"), { recursive: true });
  writeFileSync(join(dir, "libraries.json"), JSON.stringify({ version: 1, libraries: rows }));
  const entries = Object.entries(docs);
  for (const [file, text] of entries) writeFileSync(join(dir, GENERAL, "files", file), text);
  if (entries.length) {
    writeFileSync(join(dir, GENERAL, "documents.json"), JSON.stringify({ version: 1, documents: entries.map(([file, text]) => ({ name: file, kind: "standard", bytes: Buffer.byteLength(text), sha256: "x", uploaded_at: "2026-09-29T12:00:00+08:00" })) }));
  }
  return dir;
}

const start = (dir: string) => new Service(join(dir, "..", "tasks"), join(dir, "..", "runs"), {}, { port: 1, knowledgeDir: dir });

test("带文档的通用知识库：升级后留下，成为普通的库，可以改名、可以删除；旧名「通用库」改成「通用知识库」；再启动不再改动", async () => {
  const dir = oldKnowledge({ "借阅规则.md": "每位读者最多借 5 本。\n" }, "通用库");
  const service = start(dir);
  const store = service.knowledge!;
  assert.deepEqual(store.libraries().map((l) => [l.id, l.name]), [[GENERAL, "通用知识库"], ["lib-a1", "行业规范"]]);
  assert.deepEqual(readdirSync(store.filesDir(GENERAL)), ["借阅规则.md"]);
  const before = readFileSync(join(dir, "libraries.json"), "utf-8");
  const again = start(dir);
  assert.equal(readFileSync(join(dir, "libraries.json"), "utf-8"), before, "已经升级过的不再改写清单");

  assert.equal(store.rename(GENERAL, "馆内规章").name, "馆内规章");
  const t = service.task(service.create({ task_type: "requirements-engineering", task_name: "旧任务" }).task_id);
  service.setTaskKnowledge(t, { libraries: [GENERAL, "lib-a1"] });
  assert.deepEqual(service.removeLibrary(GENERAL), { ok: true, id: GENERAL });
  assert.deepEqual(store.libraries().map((l) => l.id), ["lib-a1"]);
  assert.equal(existsSync(join(dir, GENERAL)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(t.dir, "knowledge.json"), "utf-8")).libraries, ["lib-a1"]);
  await again.close();
  await service.close();
});

test("空的通用知识库：升级时从清单里去掉并删掉目录，日志里记一句；别的库不动；没有 knowledge.json 的旧任务等于一个都没选", async () => {
  const dir = oldKnowledge({});
  const service = start(dir);
  assert.deepEqual(service.knowledge!.libraries().map((l) => l.id), ["lib-a1"]);
  assert.equal(existsSync(join(dir, GENERAL)), false);
  assert.equal(existsSync(join(dir, "lib-a1", "files")), true);
  assert.ok(logs.some((line) => line.includes("以前的通用知识库是空的，已经删掉。")));

  // 旧任务没有 knowledge.json：仍按选用 general 算，那个库已经不在，助手一侧跳过它，查不到任何库。
  const t = service.task(service.create({ task_type: "requirements-engineering", task_name: "旧任务" }).task_id);
  unlinkSync(join(t.dir, "knowledge.json"));
  assert.deepEqual(service.taskPage(t).knowledge_libraries, [GENERAL]);
  assert.deepEqual(selectedKnowledge(t.dir, dir), []);
  assert.deepEqual(service.knowledgeOverview().map((l) => [l.id, l.used_by_tasks]), [["lib-a1", 0]]);
  await service.close();
});

test("有文档的通用知识库留下时，没有 knowledge.json 的旧任务照旧用到它；新建的任务一个都不选", async () => {
  const dir = oldKnowledge({ "借阅规则.md": "每位读者最多借 5 本。\n" });
  const service = start(dir);
  const old = service.task(service.create({ task_type: "requirements-engineering", task_name: "旧任务" }).task_id);
  unlinkSync(join(old.dir, "knowledge.json"));
  assert.deepEqual(selectedKnowledge(old.dir, dir).map((l) => [l.id, l.documents.map((d) => d.name)]), [[GENERAL, ["借阅规则.md"]]]);
  const fresh = service.task(service.create({ task_type: "requirements-engineering", task_name: "新任务" }).task_id);
  assert.deepEqual(JSON.parse(readFileSync(join(fresh.dir, "knowledge.json"), "utf-8")).libraries, []);
  assert.deepEqual(selectedKnowledge(fresh.dir, dir), []);
  await service.close();
});
