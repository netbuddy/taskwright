/**
 * 静态扫描：后端不写库。
 *
 * 1. backend/ 下的任何文件（源码、对照脚本、测试）从 agent/src/lib 导入的名字都必须在下面的白名单里：只读函数、常量，
 *    以及唯一允许的写入——建任务的 createTask。保存修订、界面操作、评审等写入函数一律不许导入；也不许整个模块导入或动态导入。
 * 2. backend/src 下的源码里不出现写库的 SQL（INSERT、UPDATE、DELETE、REPLACE、CREATE、DROP、ALTER）。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 允许从 agent/src/lib 导入的名字，按模块列。 */
const ALLOWED: Record<string, string[]> = {
  "task_read.ts": ["DEFAULT_MATERIALS_DIR", "ParsedDefinition", "Row", "SourceRow", "columnNames", "itemKey", "jsonOrText", "materialsDir",
    "openReadonly", "parseDefinition", "readSources", "splitUserWordsLocator", "tableNames"],
  "conditions.ts": ["checkCompletion", "completionBrief", "completionHints"],
  "db.ts": ["DB_NAME", "ACTOR_USER", "ACTOR_EXECUTOR"],
  "create_task.ts": ["createTask"],
  "docx_markdown.ts": ["docxProjection", "PROJECTION_SUFFIX", "MEDIA_SUFFIX"],
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? files(path) : /\.(m?ts|m?js)$/.test(e.name) ? [path] : [];
  });
}

/** 一个文件里从 agent/src/lib 导入的每一项：[模块文件名, 名字]；整模块导入与动态导入记为名字 "*"。 */
export function agentImports(source: string): [string, string][] {
  const out: [string, string][] = [];
  const statement = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (let m = statement.exec(source); m; m = statement.exec(source)) {
    const spec = m[3];
    if (!spec.includes("agent/src/lib/")) continue;
    const module = spec.slice(spec.lastIndexOf("/") + 1);
    const clause = m[2];
    const named = /\{([\s\S]*)\}/.exec(clause);
    if (!named || /\*\s+as/.test(clause) || /^[A-Za-z_$][\w$]*\s*,?/.test(clause.replace(/^\{[\s\S]*\}$/, "").trim()) && !clause.trim().startsWith("{")) {
      out.push([module, "*"]);
      continue;
    }
    for (const part of named[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) out.push([module, name]);
    }
  }
  for (const m of source.matchAll(/import\(\s*[`"']([^`"']*agent\/src\/lib\/[^`"']*)[`"']\s*\)/g)) out.push([m[1].slice(m[1].lastIndexOf("/") + 1), "*"]);
  return out;
}

test("扫描规则本身：认得出具名导入、类型导入、改名导入、整模块导入与动态导入", () => {
  const lib = "../../agent/src/" + "lib";   // 拆开写，免得本文件自己被下一条测试扫到
  const source = [
    `import { createTask } from "${lib}/create_task.ts";`,
    `import { type Row, jsonOrText as j } from "${lib}/task_read.ts";`,
    `import * as all from "${lib}/save_revision.ts";`,
    `import runUserOperation from "${lib}/user_ops.ts";`,
    `const m = await import("${lib}/review.ts");`,
    'import { join } from "node:path";',
  ].join("\n");
  assert.deepEqual(agentImports(source), [["create_task.ts", "createTask"], ["task_read.ts", "Row"], ["task_read.ts", "jsonOrText"],
    ["save_revision.ts", "*"], ["user_ops.ts", "*"], ["review.ts", "*"]]);
});

test("backend/ 下的文件不导入 agent 的写入函数（建任务的 createTask 除外）", () => {
  const bad: string[] = [];
  for (const file of files(BACKEND)) {
    for (const [module, name] of agentImports(readFileSync(file, "utf-8"))) {
      if (!(ALLOWED[module] ?? []).includes(name)) bad.push(`${relative(BACKEND, file)}：${module} 的 ${name}`);
    }
  }
  assert.deepEqual(bad, [], "不在白名单里的导入");
});

test("backend/src 的源码里没有写库的 SQL", () => {
  const bad: string[] = [];
  for (const file of files(join(BACKEND, "src"))) {
    readFileSync(file, "utf-8").split("\n").forEach((line, n) => {
      if (/["'`]\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\s/i.test(line)) bad.push(`${relative(BACKEND, file)}:${n + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
