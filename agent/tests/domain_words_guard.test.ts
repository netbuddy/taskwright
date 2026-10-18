/**
 * 平台零领域词的守护：平台的代码与提示词不该写死任务类型的词。词表在运行时取自 task-types/ 下每份任务定义：
 * 任务名、交付物名称、条目集合的名称、字段名、字段的取值（枚举与标签都算；「导语所属章」的取值就是章名）、界面里靠前的组。
 * 编号前缀（UC、NFR 这类短字母串）不收，它们会大量误中普通标识符。
 *
 * 扫描 agent/src/ 与 agent/prompts/（schemas/ 除外）下的全部文件，代码、注释、提示词正文都算；每个词各数各的，
 * 一个词是另一个词的一部分时（「约束」与「约束规则」）两个词各计一次。
 *
 * 现状记在 fixtures/domain_words_allowlist.json（文件 → 词 → 次数），只许减不许增：
 * 某个文件里某个词的次数超过名单、或者名单里没有，测试失败；次数减少时测试照样通过，但名单里有、代码里已经一次都没有的词
 * 也算失败，免得名单留着死条目。减量之后用 UPDATE_DOMAIN_WORDS_ALLOWLIST=1 跑一次本测试，按现状重写名单。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const ALLOWLIST = join(import.meta.dirname, "fixtures", "domain_words_allowlist.json");
const SCANNED = ["agent/src", "agent/prompts"];
const SKIPPED = new Set(["agent/prompts/schemas"]);

type Counts = Record<string, Record<string, number>>;

function files(dir: string, skipped = new Set<string>()): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (skipped.has(rel)) return [];
    return entry.isDirectory() ? files(rel, skipped) : [rel];
  });
}

/** 一份任务定义里的词。 */
function definitionWords(def: any): string[] {
  const words: string[] = [def.任务名, def.交付物?.名称];
  for (const set of def.交付物?.条目集合 ?? []) {
    words.push(set.名称, ...(set.界面?.靠前的组 ?? []));
    for (const field of set.字段 ?? []) words.push(field.名, ...(field.取值 ?? []));
  }
  return words.filter((word): word is string => typeof word === "string" && word.length > 0);
}

function vocabulary(): string[] {
  const definitions = readdirSync(join(ROOT, "task-types"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = `task-types/${entry.name}/docs/task-definitions`;
      try {
        return readdirSync(join(ROOT, dir)).filter((name) => name.endsWith(".json")).map((name) => `${dir}/${name}`);
      } catch {
        return [];
      }
    });
  const words = definitions.flatMap((file) => definitionWords(JSON.parse(readFileSync(join(ROOT, file), "utf-8"))));
  return [...new Set(words)].sort();
}

function occurrences(text: string, word: string): number {
  let count = 0;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) count++;
  return count;
}

const WORDS = vocabulary();

function scan(): Counts {
  const counts: Counts = {};
  for (const file of SCANNED.flatMap((dir) => files(dir, SKIPPED)).sort()) {
    const text = readFileSync(join(ROOT, file), "utf-8");
    const hits = Object.fromEntries(WORDS.map((word) => [word, occurrences(text, word)] as const).filter(([, n]) => n > 0));
    if (Object.keys(hits).length > 0) counts[file] = hits;
  }
  return counts;
}

const ACTUAL = scan();
if (process.env.UPDATE_DOMAIN_WORDS_ALLOWLIST === "1") writeFileSync(ALLOWLIST, `${JSON.stringify(ACTUAL, null, 2)}\n`);
const ALLOWED: Counts = JSON.parse(readFileSync(ALLOWLIST, "utf-8"));

test("the vocabulary is read from the task definitions", () => {
  assert.ok(WORDS.length > 0, "task-types/ 下没有读到任何任务定义的词");
  assert.deepEqual(definitionWords({
    任务名: "甲",
    交付物: { 名称: "乙", 条目集合: [{ 名称: "丙", 编号前缀: "X", 界面: { 靠前的组: ["丁"] }, 字段: [{ 名: "戊", 取值: ["己", "庚"] }, { 名: "辛" }] }] },
  }), ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"]);
});

test("no file uses a task-type word more often than the allowlist says", () => {
  const over: string[] = [];
  for (const [file, hits] of Object.entries(ACTUAL)) {
    for (const [word, n] of Object.entries(hits)) {
      const allowed = ALLOWED[file]?.[word] ?? 0;
      if (n > allowed) over.push(`${file}「${word}」${n} 次，名单允许 ${allowed} 次`);
    }
  }
  assert.deepEqual(over, [], "平台代码与提示词里的任务类型词只许减不许增；这些超出了 fixtures/domain_words_allowlist.json");
});

test("every allowlist entry is still used", () => {
  const stale: string[] = [];
  for (const [file, hits] of Object.entries(ALLOWED)) {
    for (const word of Object.keys(hits)) if (!ACTUAL[file]?.[word]) stale.push(`${file}「${word}」`);
  }
  assert.deepEqual(stale, [], "这些条目在代码里已经没有了；用 UPDATE_DOMAIN_WORDS_ALLOWLIST=1 跑一次本测试重写名单");
});
