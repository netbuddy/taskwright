/**
 * 调试模式（启动参数 --debug，缺省关）：开关怎样传到服务信息与助手程序的环境里。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { serviceInfo } from "../src/http.ts";
import { DEBUG_MODE, ENV_DEBUG_SETTINGS, buildEnvironment } from "../src/launch.ts";
import { settingsFile } from "../src/product_settings.ts";
import { Service } from "../src/service.ts";
import { captureConsole, spawnBackend, tempDir } from "./helpers.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

test("调试模式缺省关：服务信息里 debug 为假，启动配置上没有标记；开着时两样都有", async () => {
  const off = new Service(join(tmp, "off", "tasks"), join(tmp, "off", "runs"), {});
  const on = new Service(join(tmp, "on", "tasks"), join(tmp, "on", "runs"), {}, { debug: true });
  try {
    assert.deepEqual([off.debug, serviceInfo(off).debug, DEBUG_MODE in off.profile], [false, false, false]);
    assert.deepEqual([on.debug, serviceInfo(on).debug, on.profile[DEBUG_MODE]], [true, true, true]);
  } finally {
    await off.close();
    await on.close();
  }
});

test("起助手的程序时：调试模式下环境里多一个变量，值是产品设置文件的路径；不是调试模式时这个变量一定不在，即使服务自己的环境里有", () => {
  const before = process.env[ENV_DEBUG_SETTINGS];
  try {
    delete process.env[ENV_DEBUG_SETTINGS];
    assert.equal(ENV_DEBUG_SETTINGS in buildEnvironment({}), false);
    assert.equal(buildEnvironment({ [DEBUG_MODE]: true })[ENV_DEBUG_SETTINGS], settingsFile(process.env));
    process.env[ENV_DEBUG_SETTINGS] = "/somewhere/else.json";
    assert.equal(ENV_DEBUG_SETTINGS in buildEnvironment({}), false);
    assert.equal(buildEnvironment({ [DEBUG_MODE]: true })[ENV_DEBUG_SETTINGS], settingsFile(process.env));
  } finally {
    if (before === undefined) delete process.env[ENV_DEBUG_SETTINGS];
    else process.env[ENV_DEBUG_SETTINGS] = before;
  }
});

test("命令行的 --debug：带了它启动，服务信息里 debug 为真，启动时的那一行说明调试模式已打开；不带就是假", async () => {
  const get = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/v1/service`)).json()) as Record<string, unknown>;
  const stop = (child: { kill: (signal: NodeJS.Signals) => boolean; once: (name: "exit", done: () => void) => unknown }) =>
    new Promise<void>((ok) => { child.once("exit", () => ok()); child.kill("SIGTERM"); });
  const plain = await spawnBackend(["--tasks", join(tmp, "plain", "tasks"), "--runs", join(tmp, "plain", "runs"), "--host", "127.0.0.1"]);
  try {
    assert.equal((await get(plain.port)).debug, false);
    assert.doesNotMatch(plain.output(), /调试模式/);
  } finally {
    await stop(plain.child);
  }
  const debug = await spawnBackend(["--tasks", join(tmp, "debug", "tasks"), "--runs", join(tmp, "debug", "runs"), "--host", "127.0.0.1", "--debug"]);
  try {
    assert.equal((await get(debug.port)).debug, true);
    assert.match(debug.output(), /调试模式已打开（只在自己的机器上用）/);
  } finally {
    await stop(debug.child);
  }
});
