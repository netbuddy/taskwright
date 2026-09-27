/**
 * 测试文件的总时限（tests/deadline.ts）：结束时留着监听服务器的测试文件，到时限被报为失败并点出文件名；正常结束的文件不受影响。
 * 另起一次 node --test，时限设成 1 秒，整例两三秒跑完。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEADLINE_ENV, DEFAULT_DEADLINE_SECONDS, deadlineSeconds } from "./deadline.ts";
import { tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

test("时限：缺省 300 秒，环境变量给正数时用它，写错时用缺省值", () => {
  assert.equal(DEFAULT_DEADLINE_SECONDS, 300);
  assert.equal(deadlineSeconds({}), 300);
  assert.equal(deadlineSeconds({ [DEADLINE_ENV]: "900" }), 900);
  assert.equal(deadlineSeconds({ [DEADLINE_ENV]: "0.5" }), 0.5);
  for (const bad of ["", "0", "-3", "十秒"]) assert.equal(deadlineSeconds({ [DEADLINE_ENV]: bad }), 300, bad);
});

test("结束时留着监听服务器的测试文件到时限被报为失败，写明文件名与多半的原因；正常的文件照常通过", () => {
  writeFileSync(join(tmp, "leak.test.mjs"), [
    'import { test } from "node:test";',
    'import { createServer } from "node:net";',
    'test("起了服务器没有关", async () => { const s = createServer(); await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); });',
  ].join("\n"));
  writeFileSync(join(tmp, "fine.test.mjs"), 'import { test } from "node:test";\ntest("什么都不留", () => {});\n');
  // 本进程自己就是测试框架起的子进程，带着 NODE_TEST_CONTEXT；另起的 node --test 不能继承它，否则会把自己当成子进程。
  const env: NodeJS.ProcessEnv = { ...process.env, [DEADLINE_ENV]: "1" };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const done = spawnSync(process.execPath, ["--test", "--import", join(import.meta.dirname, "deadline.ts"), "leak.test.mjs", "fine.test.mjs"],
    { cwd: tmp, env, encoding: "utf-8", timeout: 30_000 });
  const out = done.stdout + done.stderr;
  assert.equal(done.signal, null, `另起的测试没有自己结束：${out}`);
  assert.notEqual(done.status, 0, out);
  assert.ok(Date.now() - started < 20_000, "到时限就结束，不等外面的 30 秒");
  assert.match(out, /测试文件 leak\.test\.mjs 超过 1 秒还没有结束，按失败处理。多半是有服务器、连接或子进程没有关/);
  assert.match(out, /✖ leak\.test\.mjs/);
  assert.match(out, /✔ 什么都不留/);
  assert.doesNotMatch(out, /测试文件 fine\.test\.mjs/);
});
