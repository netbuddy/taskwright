/**
 * 知识库目录对自带的 grep、find、ls 关门，接线这一层：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * 助手先后对知识库目录 grep、对它的上级目录 find、对它 ls，三次都没有执行，各拿到一句请它改用 search_knowledge 的话；
 * 随后 ls 材料目录照常返回文件名。三次拦下各在助手输出的归档里留一条状态栏记录（观测台从这里读）。
 * 该不该拦的各种情形由 agent/tests/knowledge_gate.test.ts 逐一核对，这里只看这道门确实接上了。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { BLOCKED_STATUS_KEY, blockedText } from "../../agent/src/lib/knowledge_gate.ts";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const NAME = "gate";
/** 验证栈把知识库目录放在任务目录的旁边（helpers.ts 的 spawnBackend）。 */
const STACK = join(tmp, NAME);
const KNOWLEDGE = join(STACK, "knowledge");
const RULE = "第 6 条 逾期每册每天罚款 0.5 元。";

const SCRIPT = {
  sequence: [
    { tool_calls: [{ id: "call-grep-kb", name: "grep", arguments: { pattern: "罚款", path: KNOWLEDGE } }] },
    { tool_calls: [{ id: "call-find-up", name: "find", arguments: { pattern: "*.md", path: STACK } }] },
    { tool_calls: [{ id: "call-ls-kb", name: "ls", arguments: { path: join(KNOWLEDGE, "general", "files") } }] },
    { tool_calls: [{ id: "call-ls-inputs", name: "ls", arguments: { path: "inputs" } }] },
    reply("看过了。", "call-done"),
  ],
};

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

test("grep、find、ls 的范围包含知识库目录时没有执行，助手拿到请它改用 search_knowledge 的话；材料目录照常；三次拦下都留痕", { skip: NO_PI, timeout: 120_000 }, async () => {
  // 知识库里放一份文档：没有拦住的话，grep 与 ls 会把它的正文或名字交给助手。
  mkdirSync(join(KNOWLEDGE, "general", "files"), { recursive: true });
  writeFileSync(join(KNOWLEDGE, "general", "files", "借阅规范.md"), `${RULE}\n`);
  await withStack(tmp, NAME, SCRIPT, async (s) => {
    await s.send({ client_id: "m-1", task_id: s.taskId, text: "看一下知识库里有什么。" });
    const requests = s.requests();
    assert.equal(toolResult(requests, "call-grep-kb"), blockedText("grep"));
    assert.equal(toolResult(requests, "call-find-up"), blockedText("find"));
    assert.equal(toolResult(requests, "call-ls-kb"), blockedText("ls"));
    for (const id of ["call-grep-kb", "call-find-up", "call-ls-kb"]) {
      assert.ok(!toolResult(requests, id).includes("借阅规范") && !toolResult(requests, id).includes(RULE), id);
    }
    assert.match(toolResult(requests, "call-ls-inputs"), /材料\.md/);

    // 留痕：助手输出的归档里三条状态栏记录，各写着工具与范围。
    const noted = filesUnder(join(s.dir, "runs")).filter((path) => path.endsWith(".jsonl"))
      .flatMap((path) => readFileSync(path, "utf-8").split("\n").filter((line) => line.includes(`"statusKey":"${BLOCKED_STATUS_KEY}"`)))
      .map((line) => JSON.parse(JSON.parse(line).statusText));
    assert.deepEqual(noted.map((one) => [one.结果, one.工具, one.搜索范围]), [
      ["搜索范围包含知识库目录，已经拦下", "grep", KNOWLEDGE],
      ["搜索范围包含知识库目录，已经拦下", "find", STACK],
      ["搜索范围包含知识库目录，已经拦下", "ls", join(KNOWLEDGE, "general", "files")],
    ]);
  });
});
