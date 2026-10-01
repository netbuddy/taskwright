/** 任务现状消息与「查询任务状态」里的知识库一段：选用的知识库与文档清单，续接时只在变过之后重写。 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { taskStatusMessage } from "../src/lib/task_status.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace } from "./helpers.ts";

const FRESH = { hasUserMessage: false, hasStatusMessage: false, lastMessageAt: null };

/** 知识库根目录：通用知识库里一份术语表，「行业规范」里一份 Word 规范（带投影），「空的」里没有文档。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tw-kb-"));
  writeFileSync(join(root, "libraries.json"), JSON.stringify({ libraries: [{ id: "general", name: "通用知识库" }, { id: "lib-a1", name: "行业规范" }, { id: "lib-e0", name: "空的" }] }));
  for (const id of ["general", "lib-a1", "lib-e0"]) mkdirSync(join(root, id, "files"), { recursive: true });
  writeFileSync(join(root, "general", "documents.json"), JSON.stringify({ documents: [{ name: "术语.md", kind: "glossary", bytes: 64 }] }));
  writeFileSync(join(root, "lib-a1", "documents.json"), JSON.stringify({ documents: [{ name: "规范.docx", kind: "standard", bytes: 2048 }] }));
  return root;
}

function makeTask(libraries: string[]): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  writeFileSync(join(dir, "knowledge.json"), JSON.stringify({ version: 1, libraries, notes: [] }));
  return dir;
}

const section = (root: string) => [
  "这个任务选用的知识库（参考资料，不整理成条目；需要时用 grep 按字面查找、用 read 读相关的一段；引用时来源种类写「文档原文」，出处照抄每份文档后面的写法）：",
  "知识库「通用知识库」有 1 份文档：",
  `- 术语.md（术语表，64 字节）：读 ${join(root, "general", "files", "术语.md")}；出处写 knowledge/general/术语.md`,
  "知识库「行业规范」有 1 份文档：",
  `- 规范.docx（规范，2.0 KB）：这是 Word 文档，读由它生成的投影 ${join(root, "lib-a1", "files", "规范.docx.md")}（每段一行，段落号写在方括号里）；出处写 knowledge/lib-a1/规范.docx 加段落号，例如 knowledge/lib-a1/规范.docx#p12`,
  "知识库「空的」现在没有文档。",
].join("\n");

test("新会话的现状另起一行列出这个任务选用的知识库：每个知识库的名字与文档个数，每份文档的名字、种类、大小、可以读的绝对路径与出处的写法", () => {
  const root = makeRoot();
  const dir = makeTask(["general", "lib-a1", "lib-e0"]);
  const message = taskStatusMessage(dir, FRESH, "s", root)!;
  const without = taskStatusMessage(dir, FRESH, "s", null)!;
  assert.equal(message.text.replace(/（\d\d:\d\d:\d\d）/, ""), `${without.text.replace(/（\d\d:\d\d:\d\d）/, "")}\n${section(root)}`);
  assert.deepEqual(message.details.knowledge, [
    { id: "general", name: "通用知识库", documents: [{ name: "术语.md", kind: "术语表", bytes: 64, locator: "knowledge/general/术语.md" }] },
    { id: "lib-a1", name: "行业规范", documents: [{ name: "规范.docx", kind: "规范", bytes: 2048, locator: "knowledge/lib-a1/规范.docx" }] },
    { id: "lib-e0", name: "空的", documents: [] },
  ]);
});

test("选用的知识库里一份文档都没有、选用的知识库已经删除、没有知识库根目录：现状里都不写知识库一段，消息与没有知识库时相同", () => {
  const root = makeRoot();
  const plain = (dir: string, knowledgeRoot: string | null) => {
    const message = taskStatusMessage(dir, FRESH, "s", knowledgeRoot)!;
    return { text: message.text.replace(/（\d\d:\d\d:\d\d）/, ""), keys: Object.keys(message.details) };
  };
  for (const libraries of [["lib-e0"], ["lib-gone"], []]) {
    const dir = makeTask(libraries);
    assert.deepEqual(plain(dir, root), plain(dir, null), JSON.stringify(libraries));
    assert.doesNotMatch(plain(dir, root).text, /知识库/);
    assert.equal(plain(dir, root).keys.includes("knowledge"), false);
  }
  assert.doesNotMatch(taskStatusMessage(makeTask(["general"]), FRESH, "s", join(tmpdir(), "tw-kb-没有这个目录"))!.text, /知识库/);
});

test("续接：上次之后知识库没有变就不写；任务的选用或文档清单变过，才把知识库一段再写一遍；交付物同时有变化时接在后面", () => {
  const root = makeRoot();
  const dir = makeTask(["general", "lib-a1", "lib-e0"]);
  const last = Date.now() + 5;   // 这条会话最后一条消息的时刻（比刚建的材料文件晚）
  const facts = { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: last };
  const at = (path: string, ms: number) => utimesSync(path, ms / 1000, ms / 1000);
  for (const file of [join(dir, "knowledge.json"), join(root, "libraries.json"), join(root, "general", "documents.json"), join(root, "lib-a1", "documents.json")]) at(file, last - 60_000);
  assert.equal(taskStatusMessage(dir, facts, "s", root), null, "知识库没有变，交付物也没有变");

  at(join(root, "general", "documents.json"), last + 60_000);   // 通用知识库里上传或删除过文档
  const only = taskStatusMessage(dir, facts, "s", root)!;
  assert.equal(only.kind, "变化");
  assert.equal(only.text.replace(/（\d\d:\d\d:\d\d）/, "（时刻）"),
    "【执行者续接这条会话时（时刻）看到的、上次之后交付物的变化：由扩展写入，不是用户打的字】交付物没有变化。\n" +
    `上次之后，这个任务选用的知识库或其中的文档有变化，现在是这样。${section(root)}`);
  assert.equal((only.details.knowledge as unknown[]).length, 3);
  assert.deepEqual(only.details.added, []);

  while (Date.now() <= last + 2) { /* 等过这条会话最后一刻 */ }
  saveRevision(callIn(dir, "other-session"), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["一步"] }, sources: [SOURCE] }] });
  const both = taskStatusMessage(dir, facts, "s", root)!;
  assert.match(both.text, /新增 1 个条目（UC-001）。[^\n]*\n上次之后，这个任务选用的知识库或其中的文档有变化，现在是这样。这个任务选用的知识库/);

  // 没有选用的知识库变了不算；只有交付物的变化
  at(join(root, "general", "documents.json"), last - 60_000);
  at(join(root, "lib-a1", "documents.json"), last - 60_000);
  const narrowed = makeTask(["lib-e0"]);
  at(join(narrowed, "knowledge.json"), last - 60_000);
  at(join(narrowed, "inputs/材料.md"), last - 60_000);   // 这个任务目录是刚建的，材料文件不算上次之后新放进来的
  at(join(root, "general", "documents.json"), last + 60_000);
  assert.equal(taskStatusMessage(narrowed, facts, "s", root), null);
  // 任务的选用改了，而现在选用的知识库里没有文档：只说一句
  at(join(narrowed, "knowledge.json"), last + 60_000);
  assert.match(taskStatusMessage(narrowed, facts, "s", root)!.text, /交付物没有变化。\n上次之后，这个任务选用的知识库或其中的文档有变化：现在选用的知识库里没有文档。$/);
});

test("续接：新建、改名或删除与这个任务无关的知识库之后，续接消息不提知识库；删除任务选用的知识库（后端同时改写任务的选用）才提", () => {
  const root = makeRoot();
  const dir = makeTask(["general"]);
  const last = Date.now() + 5;
  const facts = { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: last };
  const at = (path: string, ms: number) => utimesSync(path, ms / 1000, ms / 1000);
  for (const file of [join(dir, "knowledge.json"), join(dir, "inputs/材料.md"), join(root, "general", "documents.json")]) at(file, last - 60_000);
  // 新建一个与任务无关的知识库：清单文件改写了，别的知识库多了文档
  writeFileSync(join(root, "libraries.json"), JSON.stringify({ libraries: [{ id: "general", name: "通用知识库" }, { id: "lib-a1", name: "行业规范（改过名）" }, { id: "lib-new", name: "刚建的" }] }));
  at(join(root, "libraries.json"), last + 60_000);
  at(join(root, "lib-a1", "documents.json"), last + 60_000);
  assert.equal(taskStatusMessage(dir, facts, "s", root), null, "与任务无关的知识库变了，不追加消息");
  // 任务选用的知识库被删除：后端改写了任务的 knowledge.json
  const both = makeTask(["general", "lib-a1"]);
  for (const file of [join(both, "knowledge.json"), join(both, "inputs/材料.md")]) at(file, last - 60_000);
  at(join(root, "lib-a1", "documents.json"), last - 60_000);
  assert.equal(taskStatusMessage(both, facts, "s", root), null);
  writeFileSync(join(both, "knowledge.json"), JSON.stringify({ version: 1, libraries: ["general"], notes: [] }));
  at(join(both, "knowledge.json"), last + 60_000);
  const message = taskStatusMessage(both, facts, "s", root)!;
  assert.match(message.text, /交付物没有变化。\n上次之后，这个任务选用的知识库或其中的文档有变化，现在是这样。这个任务选用的知识库/);
  assert.doesNotMatch(message.text, /行业规范/);
});

test("「查询任务状态」也列出选用的知识库与文档，写法与任务现状消息里的那一段相同；没有文档时不列", () => {
  const root = makeRoot();
  const dir = makeTask(["general", "lib-a1", "lib-e0"]);
  const outcome = getTaskStatus(dir, undefined, root);
  assert.ok(outcome.text.includes(`\n${section(root)}\n`));
  assert.equal((outcome.details.knowledge as unknown[]).length, 3);
  const none = getTaskStatus(makeTask(["lib-e0"]), undefined, root);
  assert.doesNotMatch(none.text, /知识库/);
  assert.equal("knowledge" in none.details, false);
});
