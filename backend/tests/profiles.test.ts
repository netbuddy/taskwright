/**
 * 桌面包的启动配置 desktop.json：TypeScript 版能读它，除说明与 Langfuse 环境标签以外与 dev 相同，
 * 拼出的 pi 命令行与 dev 相同，交给 pi 的环境标签是 desktop；Langfuse 插件没有设环境变量时跳过。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildCommand, describeExtensions, loadProfile } from "../src/launch.ts";
import { ROOT, tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

test("desktop.json 能读，除说明与环境标签外与 dev 相同", () => {
  const dev = loadProfile("dev");
  const desktop = loadProfile("desktop");
  assert.deepEqual(desktop.langfuse, { environment: "desktop" });
  assert.match(desktop["说明"], /桌面包/);
  const strip = (p: Record<string, any>) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== "说明" && k !== "langfuse"));
  assert.deepEqual(strip(desktop), strip(dev), "改 dev 时要同步改 desktop");
});

test("desktop.json 拼出的命令行与 dev 相同，环境标签是 desktop；没设 Langfuse 插件的环境变量时跳过插件", () => {
  const saved = { plugin: process.env.TASKWRIGHT_LANGFUSE_PLUGIN, tag: process.env.LANGFUSE_TRACING_ENVIRONMENT, entry: process.env.TASKWRIGHT_PI_ENTRY };
  delete process.env.TASKWRIGHT_LANGFUSE_PLUGIN;
  delete process.env.LANGFUSE_TRACING_ENVIRONMENT;
  process.env.TASKWRIGHT_PI_ENTRY = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
  try {
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });
    const desktop = loadProfile("desktop");
    assert.deepEqual(describeExtensions(desktop).map(([, path]) => path === null), [false, true]);
    const ours = buildCommand(desktop, workspace, join(tmp, "sd"));
    const dev = buildCommand(loadProfile("dev"), workspace, join(tmp, "sd"));
    assert.deepEqual(ours.argv, dev.argv);
    assert.equal(ours.env.LANGFUSE_TRACING_ENVIRONMENT, "desktop");
  } finally {
    for (const [name, value] of [["TASKWRIGHT_LANGFUSE_PLUGIN", saved.plugin], ["LANGFUSE_TRACING_ENVIRONMENT", saved.tag], ["TASKWRIGHT_PI_ENTRY", saved.entry]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
