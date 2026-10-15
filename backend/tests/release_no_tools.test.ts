/**
 * 静态扫描：产品不用仓根 tools/ 下的东西（那里放开发与测试用的程序，例如假模型端点），所以它们不会进安装包。
 *
 * 安装包里后端的文件是从几个入口顺着导入关系取的，agent/src、agent/prompts、task-types、backend/prompts 是整个目录复制的
 * （release/build.mjs）。只要这些地方、页面的源码与构建脚本自己都不导入 tools/ 下的文件，tools/ 就进不了包。这里守着两件事：
 * 1. 这些文件里的导入，没有一个落在仓根的 tools/ 之下；
 * 2. 这些文件里不出现假模型端点目录的名字（现在的与迁走之前的两种写法）。
 * 测试文件不算产品：页面源码里的测试（src/test/ 与 *.test.*）不扫。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { ROOT } from "./helpers.ts";

const TOOLS = join(ROOT, "tools") + sep;
/** 安装包取文件的地方，加页面的源码与构建脚本。 */
const SHIPPED = ["backend/src", "agent/src", "agent/prompts", "task-types", "web/src", "release"];
const CODE = /\.(ts|mts|tsx|js|mjs|cjs)$/;
const TEXT = /\.(ts|mts|tsx|js|mjs|cjs|json|md)$/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "test" ? [] : files(path);
    return /\.test\.[a-z]+$/.test(entry.name) ? [] : [path];
  });
}
const shipped = SHIPPED.flatMap((dir) => files(join(ROOT, dir)));
const name = (path: string) => relative(ROOT, path);

/** 一个文件里写的导入：from "…"、import("…")、import "…"、require("…")。 */
function imports(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]);
}

test("假模型端点在仓根的 tools/ 下，不在后端目录里", () => {
  assert.ok(existsSync(join(ROOT, "tools", "fake-model", "server.ts")));
  assert.ok(!existsSync(join(ROOT, "backend", "fake_model")));
});

test("产品的代码、页面的源码与构建脚本没有一处导入仓根 tools/ 下的文件", () => {
  const code = shipped.filter((path) => CODE.test(path));
  assert.ok(code.length > 100, `只扫到 ${code.length} 个文件，扫描的范围不对`);
  const found = code.flatMap((path) => imports(readFileSync(path, "utf-8"))
    .filter((spec) => spec.startsWith(".") && (resolve(dirname(path), spec) + sep).startsWith(TOOLS))
    .map((spec) => `${name(path)} 导入了 ${spec}`));
  assert.deepEqual(found, []);
});

test("产品的代码、提示词、任务类型文件、页面的源码与构建脚本里不出现假模型端点目录的名字", () => {
  // release/README.md 是给人看的说明，写着安装包里不带什么，不算。
  const texts = shipped.filter((path) => TEXT.test(path) && name(path) !== join("release", "README.md"));
  const found = texts.filter((path) => /fake-model|fake_model/.test(readFileSync(path, "utf-8"))).map(name);
  assert.deepEqual(found, []);
});
