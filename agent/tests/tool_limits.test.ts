/**
 * 自带工具的返回定量（lib/tool_limits.ts）：grep 的返回超过 40 行或 6144 字节时截短并加一句话，没有超过的一个字不动；
 * read 读知识库目录下的文件、没有写要读几行时补成 120 行，别的 read 不动；截短时经状态栏报一行。不拦任何调用。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  GREP_CAPPED_STATUS_KEY, GREP_MAX_BYTES, GREP_MAX_LINES, KNOWLEDGE_READ_LINES, capGrep, cappedText, knowledgeReadLimit, reportCapped, resolvedPath,
} from "../src/lib/tool_limits.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf-8");
/** grep 返回的样子：命中的行是「文件:行号: 内容」。 */
const matches = (n: number, text = "逾期每册每天罚款 0.5 元。") => Array.from({ length: n }, (_, i) => `规范.md:${i + 1}: ${text}`);

test("限量的数：最多 40 行、6144 字节；知识库文件缺省读 120 行；截短之后加的那句话", () => {
  assert.deepEqual([GREP_MAX_LINES, GREP_MAX_BYTES, KNOWLEDGE_READ_LINES], [40, 6144, 120]);
  assert.equal(cappedText(40), "命中太多，只显示了前 40 行；换更具体的词，或者分次搜。");
});

test("grep 的返回没有超过限量：原样不动（末尾有方括号提示的也一样；没有命中的一句话也一样）", () => {
  assert.equal(capGrep(matches(40).join("\n")), null);
  assert.equal(capGrep(matches(3).join("\n")), null);
  assert.equal(capGrep("No matches found"), null);
  assert.equal(capGrep(`${matches(40).join("\n")}\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]`), null);
});

test("grep 的返回超过 40 行：只留前 40 行，末尾加一句话；原来末尾方括号里的提示去掉，它不算行；context 带出来的行也算行", () => {
  const all = matches(100);
  const raw = `${all.join("\n")}\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]`;
  const got = capGrep(raw)!;
  assert.equal(got.text, `${all.slice(0, 40).join("\n")}\n\n${cappedText(40)}`);
  assert.deepEqual([got.total_lines, got.shown_lines, got.total_bytes, got.shown_bytes], [100, 40, bytes(raw), bytes(got.text)]);
  assert.ok(!got.text.includes("matches limit reached"));
  // 15 处命中、每处带前后各一行：45 行，超过了。
  const withContext = Array.from({ length: 15 }, (_, i) => [`规范.md-${i * 3 + 1}- 前一行`, `规范.md:${i * 3 + 2}: 罚款`, `规范.md-${i * 3 + 3}- 后一行`]).flat();
  const cut = capGrep(withContext.join("\n"))!;
  assert.deepEqual([cut.total_lines, cut.shown_lines], [45, 40]);
  assert.equal(cut.text.split("\n")[39], withContext[39]);
  // 41 行就截。
  assert.equal(capGrep(matches(41).join("\n"))!.shown_lines, 40);
});

test("grep 的返回超过 6144 字节：按整行减到连同末尾那句话放得下，那句话里写的是实际留下的行数；连第一行都放不下时把第一行截短", () => {
  // 每行约 500 字节，30 行约 15 KB：行数没有超过，字节超过了。
  const wide = matches(30, "规".repeat(160));
  const got = capGrep(wide.join("\n"))!;
  assert.ok(got.shown_lines < 30 && got.shown_lines >= 10, String(got.shown_lines));
  assert.ok(got.shown_bytes <= GREP_MAX_BYTES);
  assert.equal(got.text, `${wide.slice(0, got.shown_lines).join("\n")}\n\n${cappedText(got.shown_lines)}`);
  // 再多留一行就放不下了：留的是放得下的最多的行数。
  assert.ok(bytes(`${wide.slice(0, got.shown_lines + 1).join("\n")}\n\n${cappedText(got.shown_lines + 1)}`) > GREP_MAX_BYTES);
  // 行数与字节都超过：先留 40 行，再按字节减。
  const both = capGrep(matches(100, "规".repeat(160)).join("\n"))!;
  assert.ok(both.shown_lines < 40 && both.shown_bytes <= GREP_MAX_BYTES);
  // 一行就超过上限（限量调小来试）：这一行截短。
  const one = capGrep("规".repeat(500), 40, 300)!;
  assert.deepEqual([one.shown_lines, one.shown_bytes <= 300, one.text.endsWith(`\n\n${cappedText(1)}`)], [1, true, true]);
});

/** 一处用户数据目录的样子：tasks/TASK-001 是任务目录，knowledge/ 是知识库根目录。 */
function makeDirs(): { base: string; task: string; root: string; doc: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tw-limits-")));
  const task = join(base, "tasks", "TASK-001");
  const root = join(base, "knowledge");
  mkdirSync(join(task, "inputs"), { recursive: true });
  mkdirSync(join(root, "general", "files"), { recursive: true });
  writeFileSync(join(task, "inputs", "材料.md"), "材料。\n");
  const doc = join(root, "general", "files", "借阅规范.md");
  writeFileSync(doc, "规范。\n");
  return { base, task, root, doc };
}

test("read 读知识库目录下的文件、没有写要读几行：补成 120 行；写了的照写的；材料与别处的文件不动；没有知识库根目录时不动", () => {
  const { base, task, root, doc } = makeDirs();
  assert.equal(knowledgeReadLimit({ path: doc }, task, root), 120);
  assert.equal(knowledgeReadLimit({ path: doc, offset: 200 }, task, root), 120);
  assert.equal(knowledgeReadLimit({ path: "../../knowledge/general/files/借阅规范.md" }, task, root), 120);
  // 还不存在的文件也算（路径在知识库目录之下）。
  assert.equal(knowledgeReadLimit({ path: join(root, "general", "files", "没有这份.md") }, task, root), 120);
  // 助手自己写了 limit：不改，写多少是多少。
  for (const limit of [1, 120, 5000]) assert.equal(knowledgeReadLimit({ path: doc, limit }, task, root), null);
  // 材料、任务目录里别的文件、知识库目录旁边名字相近的目录、没有 path：不动。
  for (const path of ["inputs/材料.md", join(task, "inputs", "材料.md"), "task.sqlite", join(base, "knowledge-旁边", "a.md"), undefined, "", 7]) {
    assert.equal(knowledgeReadLimit({ path }, task, root), null, String(path));
  }
  assert.equal(knowledgeReadLimit(null, task, root), null);
  for (const none of [null, ""]) assert.equal(knowledgeReadLimit({ path: doc }, task, none), null);
  // 知识库根目录还没有建：按字面比较，不报错。
  const gone = join(base, "没有建的知识库");
  assert.equal(knowledgeReadLimit({ path: join(gone, "a.md") }, task, gone), 120);
  assert.equal(knowledgeReadLimit({ path: doc }, task, gone), null);
});

test("read 的 path 按自带工具的办法解析，再按真实路径比：符号链接指到知识库里的文件也补；开头的 @ 去掉，~ 展开", () => {
  const { base, task, root, doc } = makeDirs();
  symlinkSync(doc, join(task, "inputs", "规范的链接.md"));
  symlinkSync(root, join(base, "kb-alias"));
  assert.equal(knowledgeReadLimit({ path: "inputs/规范的链接.md" }, task, root), 120);
  assert.equal(knowledgeReadLimit({ path: join(base, "kb-alias", "general", "files", "借阅规范.md") }, task, root), 120);
  assert.equal(knowledgeReadLimit({ path: doc }, task, join(base, "kb-alias")), 120);
  assert.equal(knowledgeReadLimit({ path: `@${doc}` }, task, root), 120);
  assert.equal(resolvedPath(task, "@inputs/材料.md"), join(task, "inputs", "材料.md"));
  assert.equal(resolvedPath(task, "~", base), base);
  assert.equal(resolvedPath(task, "~/knowledge", base), root);
  assert.equal(knowledgeReadLimit({ path: "~/tasks" }, task, root, base), null);
});

test("留痕：截短时经状态栏报一行，写着前后各有几行、几个字节；报不出去不影响截短", () => {
  const capped = capGrep(matches(100).join("\n"))!;
  const seen: [string, string][] = [];
  reportCapped({ setStatus: (key, text) => seen.push([key, text]) }, capped);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0][0], GREP_CAPPED_STATUS_KEY], ["taskwright-grep-capped", "taskwright-grep-capped"]);
  const fact = JSON.parse(seen[0][1]);
  assert.deepEqual([fact.结果, fact.原来几行, fact.显示几行, fact.原来字节, fact.显示字节, typeof fact.时刻],
    ["grep 的返回超过了限量，已经截短", 100, 40, capped.total_bytes, capped.shown_bytes, "number"]);
  reportCapped(undefined, capped);
  reportCapped({ setStatus: () => { throw new Error("写不出去"); } }, capped);
});

test("扩展入口登记了这件事；对知识库目录的路径拦截已经撤掉，没有哪个钩子再拦调用", () => {
  const src = (...parts: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", ...parts), "utf-8");
  // 整行就是这一句：注释掉的不算。
  assert.match(src("extension.ts"), /^  registerToolLimits\(pi\);$/m);
  assert.doesNotMatch(src("extension.ts"), /knowledge_gate|registerKnowledgeGate/);
  const hook = src("hooks", "tool_limits.ts");
  assert.ok(hook.includes('pi.on("tool_call"') && hook.includes('pi.on("tool_result"') && hook.includes("input.limit = limit;"));
  assert.doesNotMatch(hook, /block: true/);
});
