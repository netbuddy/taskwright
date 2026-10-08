/**
 * 知识库目录对自带的 grep、find、ls 关门（lib/knowledge_gate.ts）：范围包含知识库目录时拦下，两个方向都算；材料目录与任务目录照常放行；
 * 没有知识库根目录时什么都不拦；经符号链接指到知识库目录也拦；read 与别的工具不管；拦下时经状态栏报一行。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BLOCKED_STATUS_KEY, GATED_TOOLS, blockedCall, blockedText, coversKnowledge, reportBlocked, scopeOf } from "../src/lib/knowledge_gate.ts";

/** 一处用户数据目录的样子：tasks/TASK-001 是任务目录（里面有材料目录 inputs/），knowledge/ 是知识库根目录，两者并列。 */
function makeDirs(): { base: string; task: string; root: string; doc: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tw-gate-")));
  const task = join(base, "tasks", "TASK-001");
  const root = join(base, "knowledge");
  mkdirSync(join(task, "inputs"), { recursive: true });
  mkdirSync(join(root, "general", "files"), { recursive: true });
  writeFileSync(join(task, "inputs", "材料.md"), "逾期罚款按馆里的规定执行。\n");
  const doc = join(root, "general", "files", "借阅规范.md");
  writeFileSync(doc, "第 6 条 逾期每册每天罚款 0.5 元。\n");
  return { base, task, root, doc };
}

test("拦下时交还助手的话：每个工具一句，只换工具名", () => {
  assert.deepEqual([...GATED_TOOLS], ["grep", "find", "ls"]);
  assert.equal(blockedText("grep"), "知识库请用 search_knowledge：grep 不能用于知识库目录（搜索范围包含知识库目录时也一样）。材料目录照常可以用 grep。");
  assert.equal(blockedText("find"), "知识库请用 search_knowledge：find 不能用于知识库目录（搜索范围包含知识库目录时也一样）。材料目录照常可以用 find。");
  assert.equal(blockedText("ls"), "知识库请用 search_knowledge：ls 不能用于知识库目录（搜索范围包含知识库目录时也一样）。材料目录照常可以用 ls。");
});

test("范围在知识库目录之下、就是知识库目录、或者是它的上级：grep、find、ls 都拦，交还的话各用自己的工具名", () => {
  const { base, task, root, doc } = makeDirs();
  const scopes = [root, join(root, "general"), join(root, "general", "files"), doc, base, "/", "../../knowledge", "../..", "../../knowledge/general/files/借阅规范.md"];
  for (const toolName of GATED_TOOLS) {
    for (const path of scopes) {
      const blocked = blockedCall(toolName, { path }, task, root);
      assert.ok(blocked, `${toolName} ${path}`);
      assert.equal(blocked.reason, blockedText(toolName));
      assert.equal(blocked.scope, resolve(task, path));
    }
  }
});

test("材料目录、任务目录、任务目录的上一级、不存在的路径：照常放行；不写 path 就是任务目录", () => {
  const { task, root } = makeDirs();
  for (const toolName of GATED_TOOLS) {
    for (const path of [undefined, "", ".", "inputs", "inputs/材料.md", join(task, "inputs"), "..", "没有这个目录", "../../knowledge-旁边的目录"]) {
      assert.equal(blockedCall(toolName, { path }, task, root), null, `${toolName} ${String(path)}`);
    }
    assert.equal(blockedCall(toolName, {}, task, root), null);
    assert.equal(blockedCall(toolName, null, task, root), null);
  }
  // 名字只是以知识库目录的名字开头的并列目录不算在它之下。
  assert.equal(coversKnowledge(`${root}-旁边的目录`, root), false);
  assert.equal(scopeOf(task, undefined), task);
});

test("没有知识库根目录时什么都不拦，不报错；知识库根目录不存在时按字面比较，也不报错", () => {
  const { task, root, base } = makeDirs();
  for (const toolName of GATED_TOOLS) {
    for (const none of [null, ""]) assert.equal(blockedCall(toolName, { path: root }, task, none), null);
  }
  const gone = join(base, "没有建的知识库目录");
  assert.equal(blockedCall("grep", { path: "inputs" }, task, gone), null);
  assert.ok(blockedCall("grep", { path: gone }, task, gone));
  assert.ok(blockedCall("find", { path: base }, task, gone));
});

test("符号链接：任务目录里一个指向知识库目录的链接、知识库根目录本身经链接给出，都按真实路径比较", () => {
  const { base, task, root } = makeDirs();
  symlinkSync(join(root, "general", "files"), join(task, "inputs", "规范"));
  symlinkSync(root, join(task, "kb"));
  for (const toolName of GATED_TOOLS) {
    assert.equal(blockedCall(toolName, { path: "inputs/规范" }, task, root)?.scope, join(root, "general", "files"), toolName);
    assert.equal(blockedCall(toolName, { path: "kb/general" }, task, root)?.scope, join(root, "general"), toolName);
  }
  // 根目录经一个链接给出：范围写真实路径照样拦，范围写链接也拦。
  const alias = join(base, "kb-alias");
  symlinkSync(root, alias);
  assert.ok(blockedCall("grep", { path: join(root, "general") }, task, alias));
  assert.ok(blockedCall("grep", { path: join(alias, "general") }, task, root));
  // 任务目录本身不因为里面有链接而被拦：自带的搜索工具不跟着范围里面的链接走。
  assert.equal(blockedCall("grep", { path: "inputs" }, task, root), null);
});

test("path 的解析办法与自带工具相同：开头的 @ 去掉，~ 展开成用户主目录", () => {
  const { base, task, root } = makeDirs();
  assert.equal(scopeOf(task, "@inputs"), join(task, "inputs"));
  assert.equal(scopeOf(task, "~", base), base);
  assert.equal(scopeOf(task, "~/knowledge", base), root);
  assert.ok(blockedCall("grep", { path: "~/knowledge" }, task, root, base));
  assert.ok(blockedCall("ls", { path: "~" }, task, root, base));
  assert.ok(blockedCall("find", { path: `@${root}` }, task, root));
  assert.equal(blockedCall("grep", { path: "~/tasks" }, task, root, base), null);
});

test("read 与别的工具不归这里管：指到知识库里的文件也不拦", () => {
  const { task, root, doc } = makeDirs();
  for (const toolName of ["read", "search_knowledge", "save_revision", "reply"]) {
    assert.equal(blockedCall(toolName, { path: doc }, task, root), null, toolName);
  }
});

test("留痕：拦下时经状态栏报一行，写着工具与范围；报不出去不影响拦下", () => {
  const { task, root } = makeDirs();
  const blocked = blockedCall("grep", { path: root }, task, root)!;
  const seen: [string, string][] = [];
  reportBlocked({ setStatus: (key, text) => seen.push([key, text]) }, "grep", blocked);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], BLOCKED_STATUS_KEY);
  assert.equal(BLOCKED_STATUS_KEY, "taskwright-knowledge-blocked");
  const fact = JSON.parse(seen[0][1]);
  assert.deepEqual([fact.结果, fact.工具, fact.搜索范围, typeof fact.时刻], ["搜索范围包含知识库目录，已经拦下", "grep", root, "number"]);
  reportBlocked(undefined, "grep", blocked);
  reportBlocked({ setStatus: () => { throw new Error("写不出去"); } }, "grep", blocked);
});

test("扩展入口登记了这道门，接线只调判断函数", () => {
  const src = (...parts: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", ...parts), "utf-8");
  // 整行就是这一句：注释掉的不算。
  assert.match(src("extension.ts"), /^  registerKnowledgeGate\(pi\);$/m);
  const hook = src("hooks", "knowledge_gate.ts");
  assert.ok(hook.includes('pi.on("tool_call"') && hook.includes("blockedCall(event.toolName") && hook.includes("return { block: true, reason: blocked.reason };"));
});
