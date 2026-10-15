/**
 * 模板的三条守护（agent/prompts/tools/ 与 agent/prompts/runtime/，加载器在 agent/src/lib/texts.ts）：
 * 代码用的每个键都在；没有哪个模板闲着；代码填的值与模板的占位一一对上。另核对索引 agent/prompts/README.md 列了每一份模板文件。
 *
 * 代码怎样用键靠静态扫描：扫助手库与后端的源码里 fillText("键", …) 与 textKey("键") 这两种写法（键是字面的字符串）。
 * fillText 的第二个参数写成对象字面量时，逐个比对象的键与模板的占位；写成变量、带展开（...）时扫不出来，
 * 留给运行时登记：fillText 每次调用都核对给的值与占位，对不上就抛错，跑到它的测试会失败。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { TEXT_DIRS, fillText, templates, textKey, usedTextKeys } from "../src/lib/texts.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SCANNED = ["agent/src", "backend/src"];
/** 加载器自己的说明里举了写法的例子，不算引用。 */
const SKIPPED = new Set(["agent/src/lib/texts.ts"]);

interface Call {
  file: string;
  line: number;
  fn: "fillText" | "textKey";
  /** 第一个参数是字面的字符串时是那个键，否则为 null。 */
  key: string | null;
  /** fillText 的第二个参数：没有给是空数组；对象字面量是它的键；别的写法（变量、带展开）为 null。 */
  values: string[] | null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(ts|mts)$/.test(entry.name) && !SKIPPED.has(rel) ? [rel] : [];
  });
}

/** src[i] 是引号时，返回这个字符串之后的位置；模板字符串里的 ${…} 整段跳过。 */
function skipQuoted(src: string, i: number): number {
  const quote = src[i++];
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (quote === "`" && c === "$" && src[i + 1] === "{") { i = skipBalanced(src, i + 1); continue; }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

/** src[i] 是左括号（圆、方、花）时，返回与它配对的右括号之后的位置。 */
function skipBalanced(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\"" || c === "'" || c === "`") { i = skipQuoted(src, i); continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

/** src[i] 是对象字面量的左花括号时，它最外一层的键；有展开时为 null。 */
function objectKeys(src: string, i: number): string[] | null {
  const end = skipBalanced(src, i) - 1;
  const parts: string[] = [];
  let start = i + 1;
  let j = i + 1;
  while (j < end) {
    const c = src[j];
    if (c === "\"" || c === "'" || c === "`") { j = skipQuoted(src, j); continue; }
    if ("([{".includes(c)) { j = skipBalanced(src, j); continue; }
    if (c === ",") { parts.push(src.slice(start, j)); start = j + 1; }
    j++;
  }
  parts.push(src.slice(start, end));
  const keys: string[] = [];
  for (const part of parts.map((one) => one.trim()).filter(Boolean)) {
    if (part.startsWith("...")) return null;
    const hit = /^(?:"([^"]+)"|'([^']+)'|([\p{L}\p{N}_$]+))\s*(?::|$)/u.exec(part);
    if (!hit) return null;
    keys.push(hit[1] ?? hit[2] ?? hit[3]);
  }
  return keys;
}

/** 一段源码里的调用；行号从 1 起。 */
function scanText(src: string, file = ""): Call[] {
  const calls: Call[] = [];
  for (const m of src.matchAll(/(?<![\w$.])(fillText|textKey)\(/g)) {
    const fn = m[1] as Call["fn"];
    const line = src.slice(0, m.index).split("\n").length;
    let i = m.index + m[0].length;
    while (/\s/.test(src[i])) i++;
    const literal = /^"([^"\\]*)"/.exec(src.slice(i));
    if (!literal) { calls.push({ file, line, fn, key: null, values: null }); continue; }
    i += literal[0].length;
    while (/\s/.test(src[i])) i++;
    let values: string[] | null = [];
    if (src[i] === ",") {
      i++;
      while (/\s/.test(src[i])) i++;
      values = src[i] === ")" ? [] : src[i] === "{" ? objectKeys(src, i) : null;
    }
    calls.push({ file, line, fn, key: literal[1], values: fn === "fillText" ? values : [] });
  }
  return calls;
}

const CALLS = SCANNED.flatMap(sourceFiles).flatMap((file) => scanText(readFileSync(join(ROOT, file), "utf-8"), file));
const ALL = templates();
const at = (one: Call) => `${one.file}:${one.line}`;

test("代码用的每个键都有模板", () => {
  const missing = CALLS.filter((one) => one.key !== null && !ALL.has(one.key)).map((one) => `${at(one)} ${one.fn}("${one.key}")`);
  assert.deepEqual(missing, [], "这些键没有模板，到 agent/prompts/tools/ 或 agent/prompts/runtime/ 里补上");
});

test("没有闲置的模板：每个模板的键都在代码里以字面的字符串出现过", () => {
  const used = new Set(CALLS.map((one) => one.key));
  const idle = [...ALL.values()].filter((one) => !used.has(one.key)).map((one) => `${one.file} ${one.key}`);
  assert.deepEqual(idle, [], "这些模板没有代码用，删掉或接上");
});

test("占位都被填了：fillText 的值写成对象字面量的，对象的键与模板的占位一一对上；扫不出来的留给运行时核对", () => {
  const wrong: string[] = [];
  for (const one of CALLS) {
    if (one.fn !== "fillText" || one.key === null || one.values === null) continue;
    const template = ALL.get(one.key);
    if (!template) continue;
    const want = [...template.placeholders].sort();
    const got = [...one.values].sort();
    if (want.join(",") !== got.join(",")) wrong.push(`${at(one)} ${one.key}：模板要 [${want.join(", ")}]，代码给了 [${got.join(", ")}]`);
  }
  assert.deepEqual(wrong, []);
});

test("运行时登记：fillText 记下取过的键；值对不上、键不存在时抛错，textKey 对不存在的键当场抛错", () => {
  assert.throws(() => fillText("no_such.key"), /没有键为「no_such\.key」的模板/);
  assert.throws(() => textKey("no_such.key"), /没有键为「no_such\.key」的模板/);
  const first = [...ALL.values()][0];
  if (!first) return;
  const values = Object.fromEntries(first.placeholders.map((name) => [name, "x"]));
  fillText(first.key, values);
  assert.ok(usedTextKeys().has(first.key));
  assert.throws(() => fillText(first.key, { ...values, 多出来的: "y" }), /多给了 多出来的/);
});

test("扫描器认得几种写法：多行、简写的键、带引号的键、模板字符串与嵌套的括号；变量与展开记为扫不出来；前面带点的不算", () => {
  const src = [
    'fillText("a.b", { name, "count": n.length, stage: `第 ${f({ x: 1 })} 段`, list: [1, 2].join(",") })',
    'fillText(\n  "a.c",\n  {\n    name: one.name,\n  },\n)',
    'fillText("a.d")',
    "fillText(key, { name })",
    'fillText("a.e", values)',
    'fillText("a.f", { ...values })',
    'textKey("a.g")',
    'obj.fillText("a.h")',
  ].join("\n");
  const scanned = scanText(src);
  assert.deepEqual(scanned.map((one) => [one.line, one.key, one.values]), [
    [1, "a.b", ["name", "count", "stage", "list"]],
    [2, "a.c", ["name"]],
    [8, "a.d", []],
    [9, null, null],
    [10, "a.e", null],
    [11, "a.f", null],
    [12, "a.g", []],
  ]);
});

test("索引 agent/prompts/README.md 列了每一份模板文件", () => {
  const index = readFileSync(join(ROOT, "agent", "prompts", "README.md"), "utf-8");
  const files = [...new Set([...ALL.values()].map((one) => one.file))];
  for (const sub of TEXT_DIRS) assert.ok(index.includes(`${sub}/`), sub);
  const unlisted = files.filter((file) => !index.includes(`\`${file}\``));
  assert.deepEqual(unlisted, [], `这些模板文件索引里没有列：${unlisted.join("、")}（相对 ${relative(ROOT, join(ROOT, "agent", "prompts"))}）`);
});
