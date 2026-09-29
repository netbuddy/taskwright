/**
 * 观测台读后端写的归档：当场跑一段对话（真实的 pi，模型换成假端点），观测台读出的会话列表与会话详情与期望值
 * fixtures/expected/observatory_view.json 逐字一致（说明见那里的 README.md）。观测台按归档的写法读，这一例盯着后端不改动这个写法。
 * 观测台是 Python 包，经子进程调用它的读取函数。本机找不到 pi 或 python3 时跳过。
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { which } from "../src/launch.ts";
import { observatoryView, runConversation } from "./fixtures/expected/observatory.ts";
import { ROOT, tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const missing = which("pi") === null ? "本机找不到 pi" : which(process.env.TASKWRIGHT_PYTHON || "python3") === null ? "本机找不到 python3" : false;

test("后端写的归档，观测台读出的会话列表与会话详情与期望值一致", { skip: missing }, async () => {
  const root = join(tmp, "conversation");
  const [archive, tasks] = await runConversation(root);
  const ours = observatoryView(archive, tasks, root) as Record<string, any>;
  const expected = JSON.parse(readFileSync(join(ROOT, "backend", "tests", "fixtures", "expected", "observatory_view.json"), "utf-8")).view;
  assert.ok(expected.会话详情.length, "期望值里有会话");
  assert.deepEqual(ours.会话列表, expected.会话列表);
  assert.deepEqual(ours.会话详情, expected.会话详情);
});
