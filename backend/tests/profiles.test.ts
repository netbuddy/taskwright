/**
 * 桌面包的启动配置 desktop.json：TypeScript 版能读它，除说明与 Langfuse 环境标签以外与 dev 相同，
 * 拼出的 pi 命令行与 dev 相同，交给 pi 的环境标签是 desktop；Langfuse 插件没有设环境变量时跳过。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("三个启动配置起助手时都带 --offline：助手的程序不自动访问外网；这个参数排在 --approve 后面", () => {
  const workspace = join(tmp, "ws-offline");
  mkdirSync(workspace, { recursive: true });
  for (const name of ["dev", "desktop", "fake"]) {
    const profile = loadProfile(name);
    assert.equal(profile.flags.offline, true, name);
    const args = buildCommand(profile, workspace, join(tmp, "sd-offline")).args;
    assert.equal(args.filter((arg) => arg === "--offline").length, 1, name);
    assert.equal(args[args.indexOf("--offline") - 1], "--approve", name);
  }
  // 配置里关掉时不带
  const online = { ...loadProfile("fake"), flags: { ...loadProfile("fake").flags, offline: false } };
  assert.equal(buildCommand(online, workspace, join(tmp, "sd-offline")).args.includes("--offline"), false);
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

test("桌面形态下 pi 的设置文件的 defaultProvider 与 defaultModel 两项都有时代替启动配置里的模型；命令行、启动记录、模型探测、服务信息都按它；服务器形态不变", async () => {
  const { PI_SETTINGS_MODEL, resolveModel, startupRecord } = await import("../src/launch.ts");
  const { probeModel } = await import("../src/model_probe.ts");
  const { Service } = await import("../src/service.ts");
  const { serviceInfo } = await import("../src/http.ts");
  const agentDir = join(tmp, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const settings = join(agentDir, "settings.json");
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, entry: process.env.TASKWRIGHT_PI_ENTRY };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TASKWRIGHT_PI_ENTRY = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
  try {
    const desktop = { ...loadProfile("desktop"), [PI_SETTINGS_MODEL]: true };
    const server = loadProfile("desktop");
    const original = server.model;
    assert.deepEqual(resolveModel(desktop, env), { model: original, from: "启动配置" }, "没有设置文件时用启动配置里的");
    writeFileSync(settings, JSON.stringify({ defaultProvider: "local" }));
    assert.equal(resolveModel(desktop, env).model, original, "两项缺一项时用启动配置里的");
    writeFileSync(settings, "{ 不是 JSON");
    assert.equal(resolveModel(desktop, env).model, original, "读不出时用启动配置里的");
    writeFileSync(settings, JSON.stringify({ theme: "light", defaultProvider: "local", defaultModel: "qwen" }));
    assert.deepEqual(resolveModel(desktop, env), { model: "local/qwen", from: "助手程序的设置", settings });
    assert.deepEqual(resolveModel(server, env), { model: original, from: "启动配置" }, "服务器形态不读 pi 的设置文件");

    const workspace = join(tmp, "ws2");
    mkdirSync(workspace, { recursive: true });
    const argv = buildCommand(desktop, workspace, join(tmp, "sd2")).argv;
    assert.equal(argv[argv.indexOf("--model") + 1], "local/qwen");
    const serverArgv = buildCommand(server, workspace, join(tmp, "sd2")).argv;
    assert.equal(serverArgv[serverArgv.indexOf("--model") + 1], original);

    const record = startupRecord(desktop, argv);
    assert.equal(record["模型"], "local/qwen");
    assert.equal(record["模型来自"], `助手程序的设置（${settings} 的 defaultProvider 与 defaultModel）`);
    assert.equal("模型来自" in startupRecord(server, serverArgv), false, "服务器形态的启动记录不加这一项");

    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { models: [{ id: "qwen" }] } } }));
    assert.deepEqual(probeModel(desktop, env), { name: "local/qwen", available: true,
      reason: `在模型登记文件 ${join(agentDir, "models.json")} 里找到了「local/qwen」（由助手程序的设置文件 ${settings} 指定）。` });

    const service = new Service(join(tmp, "t3"), join(tmp, "r3"), loadProfile("desktop"), { port: 8950, mode: "desktop" });
    const info = serviceInfo(service);
    assert.deepEqual([info.model.name, info.capabilities.model], ["local/qwen", true]);
    const serverService = new Service(join(tmp, "t4"), join(tmp, "r4"), loadProfile("desktop"), { port: 8951, mode: "server" });
    assert.equal(serviceInfo(serverService).model.name, original);
  } finally {
    for (const [name, value] of [["PI_CODING_AGENT_DIR", saved.dir], ["TASKWRIGHT_PI_ENTRY", saved.entry]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
