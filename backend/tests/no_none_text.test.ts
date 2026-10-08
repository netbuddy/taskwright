/**
 * 给人看的文字里不把空值写成「None」：助手程序退出的说明、任务被占用的提示与日志、修订日志里的撤销、生成文档里的空项与来源、
 * 条目标题、启动配置的报错。其中生成文档、条目标题、撤销三处在正常写入路径下到不了（保存修订与界面修改都会核对），
 * 测试里直接构造异常数据，核对的是库数据异常时的兜底写法。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { titleOf } from "../src/library.ts";
import { resolveExtension } from "../src/launch.ts";
import * as occupancy from "../src/occupancy.ts";
import { PiExited } from "../src/pi_session.ts";
import { sourcesText, valueText } from "../src/render.ts";
import { Service, userActionText } from "../src/service.ts";
import { captureConsole, makeWorkspace, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
const logs = captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

test("助手程序退出的说明：拿不到退出码写「退出码未知」，没有错误内容时不写后半句，不出现 pi、进程、标准错误与 None", () => {
  assert.equal(new PiExited(null, "").message, "助手的程序已经退出（退出码未知）。");
  assert.equal(new PiExited(3, "  出错了\n").message, "助手的程序已经退出（退出码 3）。它报告的错误是：\n出错了");
  assert.equal(new PiExited(-9, "").message, "助手的程序已经退出（退出码 -9）。");
  for (const e of [new PiExited(null, ""), new PiExited(1, "x")]) assert.doesNotMatch(e.message, /None|pi|进程|标准错误/);
});

test("任务被占用的提示：标记里没写主机名时不写括号那半句；写了别的主机照旧写", () => {
  assert.equal(occupancy.occupiedText({ port: 8790, pid: 1, started_at: "", host: null } as any), "这个任务正被端口 8790 的服务占用，这里不能打开。");
  assert.equal(occupancy.occupiedText({ port: 8790, pid: 1, started_at: "" } as any), "这个任务正被端口 8790 的服务占用，这里不能打开。");
  assert.ok(occupancy.occupiedText({ port: 8790, pid: 1, started_at: "", host: "另一台主机" }).includes("（主机 另一台主机）"));
});

test("覆盖遗留占用标记的日志：标记里没写端口与进程号时不写这两项", () => {
  const dir = join(tmp, "stale");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.lock"), JSON.stringify({ started_at: "2026-09-27T00:00:00", host: hostname() }), "utf-8");
  const before = logs.length;
  assert.equal(occupancy.claim(dir, 1), null);
  const line = logs.slice(before).find((l) => l.includes("遗留的占用标记"))!;
  assert.equal(line, "任务目录 stale 里有一份遗留的占用标记（已经不在了），本服务覆盖它。");
  occupancy.release(dir);
});

test("不接手被占用的任务时的日志：标记里没写的主机、进程号不写", () => {
  const root = join(tmp, "svc");
  makeWorkspace(join(root, "tasks"), "T1", true);
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, claim: () => ({ port: 5 } as any), release: () => {} });
  const before = logs.length;
  service.scan();
  const line = logs.slice(before).find((l) => l.includes("本服务不接手它"))!;
  assert.match(line, /正被端口 5 的服务占用，本服务不接手它。$/);
  assert.doesNotMatch(line, /None/);
});

test("修订日志里的撤销：库里缺被撤销的修订号时（库数据异常）写「你撤销了一次修订」；有修订号照旧", () => {
  assert.equal(userActionText("undo", { operations: [], undo_of_revision: null }), "你撤销了一次修订");
  assert.equal(userActionText("undo", { operations: [] }), "你撤销了一次修订");
  assert.equal(userActionText(null, { operations: [], undo_of_revision: 4 }), "你撤销了修订 4");
});

test("生成文档里的空项（库数据异常）：列表与条目引用里的空项写「（空）」；来源没有摘录时不写书名号那半句，依据条目的来源没有出处时不写出处", () => {
  assert.equal(valueText(["提交申请", null, ""], "文本列表"), "1. 提交申请；2. （空）；3. （空）");
  assert.equal(valueText(["UC-001", null], "条目引用"), "UC-001、（空）");
  const lib = { sourcesOf: () => [
    { kind: "文档原文", locator: "inputs/a.md", excerpt: null },
    { kind: "条目", locator: null, excerpt: "" },
    { kind: "文档原文", locator: "inputs/b.md", excerpt: "买家可以退货。" },
  ] } as any;
  assert.equal(sourcesText(lib, "UC-001", 1), "文档原文，出处 inputs/a.md；条目；文档原文，出处 inputs/b.md（「买家可以退货。」）");
});

test("生成文档里出自知识库文档的来源：种类写「知识库」，出处写「知识库名 / 文档名」，Word 文档再写第几段；知识库已经不在时写编号；材料的出处照旧", () => {
  const lib = { sourcesOf: () => [
    { kind: "文档原文", locator: "knowledge/general/术语.md", excerpt: "原路退回：把钱退到买家付款时用的那个账户。" },
    { kind: "文档原文", locator: "knowledge/lib-a1/规范.docx#p12", excerpt: "退款在 3 个工作日内到账。" },
    { kind: "文档原文", locator: "knowledge/lib-gone/旧规范.md", excerpt: "旧的说法。" },
    { kind: "文档原文", locator: "inputs/材料.docx#p3", excerpt: "买家可以退货。" },
  ] } as any;
  const names: Record<string, string> = { general: "通用知识库", "lib-a1": "行业规范" };
  assert.equal(sourcesText(lib, "UC-001", 1, null, (id) => names[id] ?? null),
    "知识库，出处 通用知识库 / 术语.md（「原路退回：把钱退到买家付款时用的那个账户。」）；知识库，出处 行业规范 / 规范.docx 第 12 段（「退款在 3 个工作日内到账。」）；" +
    "知识库，出处 lib-gone / 旧规范.md（「旧的说法。」）；文档原文，出处 inputs/材料.docx（「买家可以退货。」）");
  // 服务没有知识库（不给名字的查法）：一律写编号
  assert.match(sourcesText(lib, "UC-001", 1), /^知识库，出处 general \/ 术语\.md（/);
});

test("条目标题：第一个字段是列表而有空项时（库数据异常）跳过空项", () => {
  const collection = { 名称: "用例", 字段: [{ 名: "名称", 类型: "文本列表" }] } as any;
  assert.equal(titleOf({ 名称: ["借书", null, "还书"] }, collection), "借书、还书");
});

test("启动配置里扩展的 source 没有写：报错写「现在没有写」；写错了照旧写出原值", () => {
  assert.throws(() => resolveExtension({ name: "甲" }), (e: Error) => e.message === "扩展「甲」的 source 只能写 repo 或 env，现在没有写。");
  assert.throws(() => resolveExtension({ name: "乙", source: "web" }), (e: Error) => e.message === "扩展「乙」的 source 只能写 repo 或 env，现在写的是 'web'。");
});
