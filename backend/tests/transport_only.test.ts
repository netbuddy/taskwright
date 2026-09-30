// 收发数据这一层的边界：backend/src 里只有子进程实现 transport_rpc.ts 可以导入与子进程和按行读管道有关的模块
// （node:child_process、node:readline，写不写 node: 前缀都算，静态导入、再导出、动态导入与 require 都算，只导入类型也算）。
// 别的文件经 transport.ts 的接口收发；一处直接导入就意味着又有代码知道「这是一个子进程」，由这里守着。
// 范围只是 backend/src：演练程序、打包脚本与后端的测试本来就要在后端之外起进程。
// 例外一处：model_config.ts 起一次助手的程序列出订阅账号能用的模型目录（不是会话，不收发事件）；以后改用助手程序的命令接口读目录时去掉这一处例外。

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "backend", "src");
const TRANSPORT_RPC = join(SRC, "transport_rpc.ts");
const ALLOWED = [TRANSPORT_RPC, join(SRC, "model_config.ts")];
const FORBIDDEN = ["child_process", "readline"];

/** 一个文件里导入、再导出、动态导入与 require 写的模块名。 */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) found.push(m[1]);
  for (const m of text.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[1]);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

const forbidden = (spec: string) => FORBIDDEN.includes(spec.replace(/^node:/, ""));

test("backend/src 里只有 transport_rpc.ts（与例外的 model_config.ts）导入 node:child_process 与 node:readline", () => {
  const offenders = sourceFiles(SRC).filter((file) => !ALLOWED.includes(file))
    .flatMap((file) => specifiers(readFileSync(file, "utf-8")).filter(forbidden).map((spec) => `${relative(ROOT, file)} 导入了 ${spec}`));
  assert.deepEqual(offenders, [], "这些文件应当经 transport.ts 的接口收发，不直接用子进程或按行读管道");
  assert.ok(specifiers(readFileSync(TRANSPORT_RPC, "utf-8")).some((spec) => spec === "node:child_process"), "子进程实现本身在 transport_rpc.ts 里");
});

test("认得出几种写法：带不带 node: 前缀、只导入类型、动态导入、require；注释里提到模块名不算", () => {
  const text = [
    'import { spawn } from "node:child_process";',
    'import type { Interface } from "readline";',
    'const cp = await import("child_process");',
    'const rl = require("node:readline");',
    "// node:readline 会在 U+2028 处断行",
  ].join("\n");
  assert.deepEqual(specifiers(text).filter(forbidden), ["node:child_process", "readline", "child_process", "node:readline"]);
});
