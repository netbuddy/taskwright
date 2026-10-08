/**
 * 自带工具的返回定量，接线这一层：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * - read 读知识库目录下的文件而没有写要读几行：只读回 120 行，末尾是 pi 自己的接着读的提示；写了几行的照写的；读材料不受影响。
 * - grep 的返回太多：只留前 40 行并加一句话，归档里留一条状态栏记录；返回不多的原样不动。grep 要用 rg，本机没有时这一例跳过。
 * - 对知识库目录的路径拦截已经撤掉：ls 知识库目录照常执行。
 * 截短与补行数的各种情形由 agent/tests/tool_limits.test.ts 逐一核对，这里只看这两件确实接上了。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { GREP_CAPPED_STATUS_KEY, GREP_MAX_BYTES, cappedText } from "../../agent/src/lib/tool_limits.ts";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const NO_RG = spawnSync("rg", ["--version"], { encoding: "utf-8" }).error ? "本机 PATH 上没有 rg（pi 的 grep 要用它）" : false;

/** 验证栈把知识库目录放在任务目录的旁边（helpers.ts 的 spawnBackend）。 */
const knowledgeOf = (name: string) => join(tmp, name, "knowledge");
/** 一份 300 行的文档：每行写着自己是第几行，都有「罚款」两个字。 */
const LONG = Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 行 逾期罚款的规定。`).join("\n") + "\n";

function putKnowledge(name: string): string {
  const files = join(knowledgeOf(name), "general", "files");
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, "大文档.md"), LONG);
  return join(files, "大文档.md");
}

/** 一个目录下（含子目录）的全部文件。 */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** 模型收到的最后一个请求里，某次工具调用的结果文字。 */
function toolResult(requests: Dict[], callId: string): string {
  const messages: Dict[] = requests[requests.length - 1].请求体.messages;
  const found = messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
  assert.ok(found, `没有找到 ${callId} 的结果`);
  return typeof found.content === "string" ? found.content : (found.content as Dict[]).map((part) => part.text ?? "").join("");
}
const rowsOf = (text: string) => text.split("\n").filter((line) => /第 \d+ 行/.test(line));

test("read 读知识库里的文件不写要读几行时只读回 120 行；写了的照写的；读材料不受影响；ls 知识库目录不再被拦", { skip: NO_PI, timeout: 120_000 }, async () => {
  const name = "read";
  const doc = putKnowledge(name);
  const script = { sequence: [
    { tool_calls: [{ id: "call-read-kb", name: "read", arguments: { path: doc } }] },
    { tool_calls: [{ id: "call-read-kb-5", name: "read", arguments: { path: doc, offset: 200, limit: 5 } }] },
    { tool_calls: [{ id: "call-read-material", name: "read", arguments: { path: "inputs/长材料.md" } }] },
    { tool_calls: [{ id: "call-ls-kb", name: "ls", arguments: { path: join(knowledgeOf(name), "general", "files") } }] },
    reply("看过了。", "call-done"),
  ] };
  await withStack(tmp, name, script, async (s) => {
    writeFileSync(join(s.dir, "tasks", s.taskId, "inputs", "长材料.md"), LONG);
    await s.send({ client_id: "m-1", task_id: s.taskId, text: "读一下。" });
    const requests = s.requests();
    // 知识库里的文件：没有写 limit，只读回前 120 行；末尾是接着读的提示。
    const whole = toolResult(requests, "call-read-kb");
    assert.deepEqual([rowsOf(whole).length, rowsOf(whole)[0], rowsOf(whole).at(-1)], [120, "第 1 行 逾期罚款的规定。", "第 120 行 逾期罚款的规定。"]);
    assert.match(whole, /offset=121/);
    // 写了 limit 的照写的。
    assert.deepEqual(rowsOf(toolResult(requests, "call-read-kb-5")).map((line) => line.slice(0, 7)), ["第 200 行", "第 201 行", "第 202 行", "第 203 行", "第 204 行"]);
    // 材料：不写 limit 照样整份读回（300 行）。
    assert.equal(rowsOf(toolResult(requests, "call-read-material")).length, 300);
    // 路径拦截撤掉了：ls 知识库目录照常返回文件名。
    assert.match(toolResult(requests, "call-ls-kb"), /大文档\.md/);
  });
});

test("grep 的返回太多时只留前 40 行并加一句话，归档里留一条记录；返回不多的原样不动；材料与知识库一样", { skip: NO_PI || NO_RG, timeout: 120_000 }, async () => {
  const name = "grep";
  putKnowledge(name);
  const script = { sequence: [
    { tool_calls: [{ id: "call-grep-wide", name: "grep", arguments: { pattern: "罚款|规定", path: "inputs" } }] },
    { tool_calls: [{ id: "call-grep-kb", name: "grep", arguments: { pattern: "罚款", path: knowledgeOf(name) } }] },
    { tool_calls: [{ id: "call-grep-narrow", name: "grep", arguments: { pattern: "第 (7|8) 行 ", path: "inputs" } }] },
    reply("搜过了。", "call-done"),
  ] };
  await withStack(tmp, name, script, async (s) => {
    writeFileSync(join(s.dir, "tasks", s.taskId, "inputs", "长材料.md"), LONG);
    await s.send({ client_id: "m-1", task_id: s.taskId, text: "搜一下。" });
    const requests = s.requests();
    // 300 行都命中（pi 自己最多给 100 条）：只留前 40 行，末尾是那句话，原来的英文提示去掉了。
    for (const id of ["call-grep-wide", "call-grep-kb"]) {
      const wide = toolResult(requests, id);
      assert.equal(rowsOf(wide).length, 40, id);
      assert.ok(wide.endsWith(`\n\n${cappedText(40)}`), id);
      assert.ok(Buffer.byteLength(wide, "utf-8") <= GREP_MAX_BYTES, id);
      assert.doesNotMatch(wide, /matches limit reached/, id);
    }
    // 只命中两行：原样不动，没有那句话。
    const narrow = toolResult(requests, "call-grep-narrow");
    assert.deepEqual([rowsOf(narrow).length, narrow.includes("命中太多")], [2, false]);
    // 留痕：两次截短各一条状态栏记录。
    const noted = filesUnder(join(s.dir, "runs")).filter((path) => path.endsWith(".jsonl"))
      .flatMap((path) => readFileSync(path, "utf-8").split("\n").filter((line) => line.includes(`"statusKey":"${GREP_CAPPED_STATUS_KEY}"`)))
      .map((line) => JSON.parse(JSON.parse(line).statusText));
    assert.deepEqual(noted.map((one) => [one.结果, one.原来几行, one.显示几行]), [["grep 的返回超过了限量，已经截短", 100, 40], ["grep 的返回超过了限量，已经截短", 100, 40]]);
  });
});
