/** 助手一侧读知识库：出处的写法与拆法、任务选用的知识库与文档清单、出处指向的文件、最近一次变动的时刻。 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KNOWLEDGE_ROOT_ENV, envKnowledgeRoot, knowledgeChangedAt, knowledgeFilePath, selectedKnowledge, selectedLibraryIds } from "../src/lib/knowledge.ts";
import { isKnowledgeLocator, knowledgeLocator, parseKnowledgeLocator } from "../src/lib/knowledge_locator.ts";

/** 建一个知识库根目录：通用知识库里一份术语表，另一个知识库里一份 Word 规范（带投影）。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tw-kb-"));
  writeFileSync(join(root, "libraries.json"), JSON.stringify({ version: 1, libraries: [{ id: "general", name: "通用知识库" }, { id: "lib-a1", name: "行业规范" }] }));
  mkdirSync(join(root, "general", "files"), { recursive: true });
  writeFileSync(join(root, "general", "files", "术语.md"), "原路退回：把钱退到买家付款时用的那个账户。\n");
  writeFileSync(join(root, "general", "documents.json"), JSON.stringify({ version: 1, documents: [{ name: "术语.md", kind: "glossary", bytes: 64 }] }));
  mkdirSync(join(root, "lib-a1", "files"), { recursive: true });
  writeFileSync(join(root, "lib-a1", "files", "规范.docx"), "");
  writeFileSync(join(root, "lib-a1", "files", "规范.docx.md"), "[p1] 退款在 3 个工作日内到账。\n");
  writeFileSync(join(root, "lib-a1", "documents.json"), JSON.stringify({ version: 1, documents: [{ name: "规范.docx", kind: "standard", bytes: 2048 }] }));
  return root;
}

const makeTask = (libraries?: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "tw-kb-task-"));
  if (libraries !== undefined) writeFileSync(join(dir, "knowledge.json"), JSON.stringify({ version: 1, libraries, notes: [] }));
  return dir;
};

test("知识库来源的出处：以 knowledge/ 开头，拆成知识库编号、文档名与段落号；写法不对的拆不出来", () => {
  assert.equal(knowledgeLocator("lib-a1", "规范.docx"), "knowledge/lib-a1/规范.docx");
  assert.equal(isKnowledgeLocator("knowledge/general/术语.md"), true);
  assert.equal(isKnowledgeLocator("inputs/knowledge/术语.md"), false);
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/术语.md"), { library: "general", name: "术语.md", paragraph: null });
  assert.deepEqual(parseKnowledgeLocator("knowledge/lib-a1/规范.docx#p12"), { library: "lib-a1", name: "规范.docx", paragraph: 12 });
  assert.deepEqual(parseKnowledgeLocator("knowledge/lib-a1/规范.docx.md"), { library: "lib-a1", name: "规范.docx.md", paragraph: null });
  for (const bad of ["inputs/术语.md", "knowledge/", "knowledge/general", "knowledge/general/", "knowledge//术语.md", "knowledge/../术语.md",
    "knowledge/general/..", "knowledge/general/a/b.md", "knowledge/general/a\\b.md"]) {
    assert.equal(parseKnowledgeLocator(bad), null, bad);
  }
});

test("知识库根目录取自环境变量；没设或是空的就当作没有知识库", () => {
  assert.equal(envKnowledgeRoot({}), null);
  assert.equal(envKnowledgeRoot({ [KNOWLEDGE_ROOT_ENV]: "  " }), null);
  assert.equal(envKnowledgeRoot({ [KNOWLEDGE_ROOT_ENV]: "/data/knowledge" }), "/data/knowledge");
});

test("任务选用的知识库：没有 knowledge.json 的旧任务按只选用通用知识库算；带路径分隔符的编号不认", () => {
  assert.deepEqual(selectedLibraryIds(makeTask()), ["general"]);
  assert.deepEqual(selectedLibraryIds(makeTask(["lib-a1", "general"])), ["lib-a1", "general"]);
  assert.deepEqual(selectedLibraryIds(makeTask([])), []);
  assert.deepEqual(selectedLibraryIds(makeTask(["../别处", "a/b", "..", 3, "lib-a1"])), ["lib-a1"]);
});

test("选用的知识库与文档清单：照任务选用的先后；Word 文档读投影；种类写中文；已经删除的知识库跳过", () => {
  const root = makeRoot();
  const libraries = selectedKnowledge(makeTask(["lib-a1", "lib-gone", "general"]), root);
  assert.deepEqual(libraries, [
    { id: "lib-a1", name: "行业规范", documents: [
      { name: "规范.docx", kindName: "规范", bytes: 2048, readPath: join(root, "lib-a1", "files", "规范.docx.md"), locator: "knowledge/lib-a1/规范.docx", word: true },
    ] },
    { id: "general", name: "通用知识库", documents: [
      { name: "术语.md", kindName: "术语表", bytes: 64, readPath: join(root, "general", "files", "术语.md"), locator: "knowledge/general/术语.md", word: false },
    ] },
  ]);
});

test("没有知识库根目录、根目录不存在、文档清单读不出来时都不报错", () => {
  const task = makeTask(["general"]);
  assert.deepEqual(selectedKnowledge(task, null), []);
  assert.deepEqual(selectedKnowledge(task, join(tmpdir(), "tw-kb-没有这个目录")), []);
  const root = mkdtempSync(join(tmpdir(), "tw-kb-"));
  writeFileSync(join(root, "libraries.json"), JSON.stringify({ libraries: [{ id: "general", name: "通用知识库" }] }));
  assert.deepEqual(selectedKnowledge(task, root), [{ id: "general", name: "通用知识库", documents: [] }]);
});

test("出处指向的文件在知识库根目录下的「编号/files/文件名」；写法不对时指不到文件", () => {
  assert.equal(knowledgeFilePath("/data/kb", "knowledge/general/术语.md"), join("/data/kb", "general", "files", "术语.md"));
  assert.equal(knowledgeFilePath("/data/kb", "knowledge/lib-a1/规范.docx.md"), join("/data/kb", "lib-a1", "files", "规范.docx.md"));
  assert.equal(knowledgeFilePath("/data/kb", "knowledge/../../etc/passwd"), null);
  assert.equal(knowledgeFilePath("/data/kb", "inputs/术语.md"), null);
});

test("最近一次变动的时刻：取任务的选用、知识库清单与各选用知识库的文档清单里最晚的修改时刻；没有知识库时为 0", () => {
  const root = makeRoot();
  const task = makeTask(["general"]);
  assert.equal(knowledgeChangedAt(task, null), 0);
  const at = (path: string, seconds: number) => utimesSync(path, seconds, seconds);
  at(join(task, "knowledge.json"), 1000);
  at(join(root, "libraries.json"), 2000);
  at(join(root, "general", "documents.json"), 3000);
  at(join(root, "lib-a1", "documents.json"), 9000);
  assert.equal(knowledgeChangedAt(task, root), 3000 * 1000, "没有选用的知识库不算");
  at(join(task, "knowledge.json"), 5000);
  assert.equal(knowledgeChangedAt(task, root), 5000 * 1000);
});
