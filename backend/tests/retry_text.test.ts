/**
 * 模型服务不可用、pi 自动重试时发给页面的提示：pi 给了第几次就写第几次；没给时写「正在重试」，不把空值写成「None」。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Executor } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { captureConsole, makeWorkspace, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
captureConsole();

type Dict = Record<string, any>;
let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

async function problemOf(event: Dict): Promise<Dict> {
  const hub = new Hub(ws);
  const executor = new Executor("TASK-001", ws, join(tmp, "runs"), {}, hub);
  const pi = { alive: () => true, note() {}, async request() { return {}; }, async getState() { return {}; } };
  executor.pi = pi as any;
  executor.activeSession = "S1";
  const [sub] = hub.subscribe(null, null);
  await (executor as any).handle(pi, event);
  const out: Dict[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "problem") out.push(item[2]);
  hub.close();
  return out[0];
}

test("自动重试的提示：给了次数写第几次；没给次数写「正在重试」，不出现 None", async () => {
  assert.equal((await problemOf({ type: "auto_retry_start", attempt: 3, delayMs: 1000 })).text, "模型服务暂时不可用，正在第 3 次重试。");
  const without = await problemOf({ type: "auto_retry_start" });
  assert.equal(without.text, "模型服务暂时不可用，正在重试。");
  assert.deepEqual(without.retry, { attempt: null, delay_ms: null });
});
