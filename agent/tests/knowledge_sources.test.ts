/**
 * 出自知识库文档的来源怎样核对：出处写 knowledge/<知识库编号>/<文档名>，摘录照材料的规矩逐字核对；只能引用这个任务选用的
 * 知识库里的文档；读不到时新写的来源拒绝、旧来源原样再交的照收。另核对不是知识库的出处必须落在任务目录里。
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { docxProjection } from "../src/lib/docx_markdown.ts";
import { checkQuotes, saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, SAMPLE, SOURCE, callIn, count, makeWorkspace, query } from "./helpers.ts";

const TERMS = "# 退款术语\n\n原路退回：把钱退到买家付款时用的那个账户。\n部分退款：只退订单金额的一部分。\n";
const TERM = { kind: "文档原文", locator: "knowledge/general/术语.md", excerpt: "原路退回：把钱退到买家付款时用的那个账户。" };
const WORD = { kind: "文档原文", locator: "knowledge/lib-a1/规范.docx#p76", excerpt: "逾期的每本每天罚款一角" };

/** 知识库根目录：通用知识库里一份术语表；「行业规范」里一份 Word 文档与它的投影；「别的资料」里一份文本文档。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tw-kb-"));
  writeFileSync(join(root, "libraries.json"), JSON.stringify({ libraries: [{ id: "general", name: "通用知识库" }, { id: "lib-a1", name: "行业规范" }, { id: "lib-b2", name: "别的资料" }] }));
  for (const id of ["general", "lib-a1", "lib-b2"]) mkdirSync(join(root, id, "files"), { recursive: true });
  writeFileSync(join(root, "general", "files", "术语.md"), TERMS);
  copyFileSync(SAMPLE, join(root, "lib-a1", "files", "规范.docx"));
  writeFileSync(join(root, "lib-a1", "files", "规范.docx.md"), docxProjection(readFileSync(SAMPLE), "lib-a1/files/规范.docx").markdown);
  writeFileSync(join(root, "lib-b2", "files", "术语.md"), TERMS);
  return root;
}

/** 一个选用了通用知识库与「行业规范」的任务。 */
function makeTask(libraries: string[] = ["general", "lib-a1"]): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  writeFileSync(join(dir, "knowledge.json"), JSON.stringify({ version: 1, libraries, notes: [] }));
  return dir;
}

const add = (source: unknown, name = "退款") => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["一步"] }, sources: [source] });
const save = (dir: string, root: string | null, operation: unknown) => saveRevision({ ...callIn(dir), knowledgeRoot: root }, { operations: [operation] });
const sourcesAt = (dir: string, revision: number) =>
  query<any>(dir, "SELECT kind, locator, excerpt FROM item_source WHERE revision_no = ?", revision).map((r) => ({ ...r }));
const snapshot = (dir: string) => ["revision", "item", "item_source", "event"].map((t) => count(dir, t));

test("出处写 knowledge/知识库编号/文档名：摘录逐字出自那份文档就通过，种类仍是「文档原文」，出处原样存下", () => {
  const root = makeRoot();
  const dir = makeTask();
  assert.match(save(dir, root, add(TERM)).text, /新增了条目 UC-001/);
  assert.deepEqual(sourcesAt(dir, 1), [TERM]);
});

test("Word 文档照材料的办法按段落号核对：带段落号通过；不写段落号、写成投影、段落号不对都拒绝，说的是「文档」", () => {
  const root = makeRoot();
  const dir = makeTask();
  assert.match(save(dir, root, add(WORD)).text, /新增了条目 UC-001/);
  assert.deepEqual(sourcesAt(dir, 1), [WORD]);
  const before = snapshot(dir);
  assert.throws(() => save(dir, root, add({ ...WORD, locator: "knowledge/lib-a1/规范.docx" })),
    /出处 knowledge\/lib-a1\/规范\.docx 没有写段落号。\n\s*怎么办：Word 文档的出处要写段落号，例如 knowledge\/lib-a1\/规范\.docx#p12/);
  assert.throws(() => save(dir, root, add({ ...WORD, locator: "knowledge/lib-a1/规范.docx.md" })),
    /出处 knowledge\/lib-a1\/规范\.docx\.md 是由 Word 文件生成的投影，不是文档本身。\n\s*怎么办：出处写 Word 文件加段落号，例如 knowledge\/lib-a1\/规范\.docx#p12/);
  assert.throws(() => save(dir, root, add({ ...WORD, locator: "knowledge/lib-a1/规范.docx#p1" })), /摘录「逾期的每本每天罚款一角」在 规范\.docx 第 1 段里找不到/);
  assert.deepEqual(snapshot(dir), before);
});

test("摘录与文档原文不一致：拒绝，拒绝的文字说「文档」不说「材料」", () => {
  const root = makeRoot();
  const dir = makeTask();
  assert.throws(() => save(dir, root, add({ ...TERM, excerpt: "原路退回：把钱退回买家的账户。" })),
    /摘录「原路退回：把钱退回买家的账户。」在 术语\.md 里找不到。\n\s*怎么办：摘录必须与文档原文逐字一致，包括标点；不要自行补标点或改写；摘录必须逐字抄自文档里连续的一段，不要跳句拼接或改字；引了文档几处就写几条来源/);
  assert.equal(count(dir, "revision"), 0);
});

test("新写的来源读不到知识库文档时拒绝，并说明原因：文档找不到、知识库没有选用、知识库已经不在、写法不对、任务没有知识库", () => {
  const root = makeRoot();
  const dir = makeTask();
  const rejected = (locator: string, pattern: RegExp, knowledgeRoot: string | null = root) =>
    assert.throws(() => save(dir, knowledgeRoot, add({ ...TERM, locator })), pattern, locator);
  rejected("knowledge/general/没有这份.md", /出处 knowledge\/general\/没有这份\.md 指向的文档《没有这份\.md》在知识库「通用知识库」里找不到。\n\s*怎么办：出处照抄任务现状消息（或查询任务状态）里那份文档后面给出的写法；文档已经从知识库删除时，不要把它当作来源/);
  rejected("knowledge/lib-b2/术语.md", /出处 knowledge\/lib-b2\/术语\.md 指向知识库「别的资料」里的文档，而这个任务没有选用知识库「别的资料」。\n\s*怎么办：只能引用这个任务选用的知识库里的文档/);
  rejected("knowledge/lib-gone/术语.md", /出处 knowledge\/lib-gone\/术语\.md 指向的知识库 lib-gone 已经不在了/);
  for (const locator of ["knowledge/术语.md", "knowledge/general/../lib-b2/files/术语.md", "knowledge/../inputs/材料.md"]) {
    rejected(locator, /不是知识库文档的写法。\n\s*怎么办：出处写 knowledge\/知识库编号\/文档名/);
  }
  rejected("knowledge/general/术语.md", /出处 knowledge\/general\/术语\.md 指向知识库里的文档，但这个任务没有知识库。\n\s*怎么办：任务现状消息里没有列出知识库时，不要写 knowledge\/ 开头的出处/, null);
  assert.equal(count(dir, "revision"), 0);
});

test("材料目录里有同名文件时，知识库出处也不会被当成那份材料来核对", () => {
  const dir = makeTask();
  writeFileSync(join(dir, "inputs", "术语.md"), TERMS);
  assert.throws(() => save(dir, null, add(TERM)), /这个任务没有知识库/);
  const root = makeRoot();
  rmSync(join(root, "general", "files", "术语.md"));
  assert.throws(() => save(dir, root, add(TERM)), /在知识库「通用知识库」里找不到/);
});

test("旧来源原样再交一次：文档已经从知识库删除、知识库不再选用、服务没有知识库，都照收不核对；同样情形下新写的来源拒绝", () => {
  const root = makeRoot();
  const dir = makeTask();
  save(dir, root, add(TERM));
  save(dir, root, add(WORD, "罚款"));
  const again = (item: string, base: number, source: unknown, knowledgeRoot: string | null) =>
    save(dir, knowledgeRoot, { op: "update", item, base_revision: base, fields: { 备注: `补 ${base}` }, sources: [source] });

  // 文档已经从知识库删除
  rmSync(join(root, "general", "files", "术语.md"));
  rmSync(join(root, "lib-a1", "files", "规范.docx"));
  rmSync(join(root, "lib-a1", "files", "规范.docx.md"));
  assert.match(again("UC-001", 1, TERM, root).text, /UC-001 现在是修订 3/);
  assert.match(again("UC-002", 2, WORD, root).text, /UC-002 现在是修订 4/);
  assert.deepEqual(sourcesAt(dir, 3), [TERM]);
  assert.deepEqual(sourcesAt(dir, 4), [WORD]);
  assert.throws(() => again("UC-001", 3, { ...TERM, excerpt: "部分退款：只退订单金额的一部分。" }, root), /在知识库「通用知识库」里找不到/, "摘录不同就是新写的");

  // 知识库不再选用（文档还在）
  writeFileSync(join(root, "general", "files", "术语.md"), TERMS);
  writeFileSync(join(dir, "knowledge.json"), JSON.stringify({ version: 1, libraries: ["lib-a1"], notes: [] }));
  assert.match(again("UC-001", 3, TERM, root).text, /UC-001 现在是修订 5/);
  assert.throws(() => save(dir, root, add(TERM, "新的")), /这个任务没有选用知识库「通用知识库」/);

  // 服务没有知识库
  assert.match(again("UC-001", 5, TERM, null).text, /UC-001 现在是修订 6/);
  assert.throws(() => save(dir, null, add(TERM, "新的")), /这个任务没有知识库/);
});

test("不是知识库的出处必须落在任务目录里：任务目录之外的绝对路径、用 .. 绕出去的相对路径都拒绝；任务目录里的照常", () => {
  const root = makeRoot();
  const dir = makeTask();
  const outside = join(root, "general", "files", "术语.md");
  const twin = mkdtempSync(join(tmpdir(), "tw-kb-outside-"));
  writeFileSync(join(twin, "材料.md"), "用户可以登录。\n");
  for (const locator of [outside, join(twin, "材料.md"), `../${twin.split("/").pop()}/材料.md`, "inputs/../../etc/hosts", "."]) {
    assert.throws(() => save(dir, root, add({ kind: "文档原文", locator, excerpt: locator === outside ? TERM.excerpt : "用户可以登录。" })),
      /不是任务目录里能读到的材料文件/, locator);
  }
  assert.equal(count(dir, "revision"), 0);
  assert.match(save(dir, root, add(SOURCE)).text, /新增了条目 UC-001/);
  assert.match(save(dir, root, add({ ...SOURCE, locator: join(dir, "inputs", "材料.md") }, "绝对路径但在任务目录里")).text, /新增了条目 UC-002/);
  assert.match(save(dir, root, add({ ...SOURCE, locator: "inputs/../inputs/材料.md" }, "绕了一下但没有出去")).text, /新增了条目 UC-003/);
});

test("回复给建议值时的依据走同一套核对：知识库出处通过、摘录不符拒绝、没有知识库拒绝", () => {
  const root = makeRoot();
  const dir = makeTask();
  const check = (raw: unknown, knowledgeRoot: string | null) => {
    const errors: string[] = [];
    return { checked: checkQuotes(dir, "s", [], raw, errors, (i) => `第 ${i + 1} 条依据`, knowledgeRoot), errors };
  };
  assert.deepEqual(check([TERM, WORD], root), { checked: [TERM, WORD], errors: [] });
  const wrong = check([{ ...TERM, excerpt: "没有这句话。" }], root);
  assert.equal(wrong.checked, null);
  assert.match(wrong.errors[0], /第 1 条依据的摘录「没有这句话。」在 术语\.md 里找不到/);
  assert.match(check([TERM], null).errors[0], /这个任务没有知识库/);
});
