/**
 * 观测台读 TypeScript 版后端写的归档，读出的会话列表与会话详情与读 Python 版写的归档一样。
 * TypeScript 版这边当场跑一段对话（真实的 pi，模型换成 TypeScript 版假端点）；Python 版那边读留存的 fixtures/py/observatory_view.json
 * （生成方法见那里的 README.md）。观测台是 Python 包，经子进程调用它的读取函数。本机找不到 pi 或 python3 时跳过。
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { which } from "../src/launch.ts";
import { observatoryView, runConversation } from "./fixtures/py/observatory.ts";
import { ROOT, tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const missing = which("pi") === null ? "本机找不到 pi" : which(process.env.TASKWRIGHT_PYTHON || "python3") === null ? "本机找不到 python3" : false;

test("TypeScript 版后端写的归档，观测台读出的会话列表与会话详情与 Python 版留存的一样", { skip: missing }, async () => {
  const root = join(tmp, "typescript");
  const [archive, tasks] = await runConversation("typescript", root);
  const ours = observatoryView(archive, tasks, root) as Record<string, any>;
  const python = JSON.parse(readFileSync(join(ROOT, "backend", "tests", "fixtures", "py", "observatory_view.json"), "utf-8")).view;
  assert.ok(python.会话详情.length, "Python 版的归档里读出了会话");
  assert.deepEqual(ours.会话列表, python.会话列表);
  assert.deepEqual(ours.会话详情, python.会话详情);
});
