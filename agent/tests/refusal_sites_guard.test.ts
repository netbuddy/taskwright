/**
 * 拒绝语出现位置的守护：agent/src/ 下只有名单里的文件可以出现 refusalText（定义、导入、调用都算，按整词匹配）。
 * 名单以现状为起点，只许减、不许增：新文件要写拒绝语，先想它该不该归到已在名单里的位置；
 * 名单里的文件不再出现 refusalText 时，测试同样失败，提醒把它从名单里删掉，免得名单只增不减地留着死条目。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");

/** 目标是缩到两处：守护层的目录与回复工具。texts.ts 与 shared_texts.ts 是两处定义。 */
const REFUSAL_SITES = [
  "agent/src/lib/dialogue_acts.ts",
  "agent/src/lib/overall_analysis.ts",
  "agent/src/lib/problem_consent.ts",
  "agent/src/lib/publish_version.ts",
  "agent/src/lib/reply.ts",
  "agent/src/lib/save_diagram.ts",
  "agent/src/lib/save_revision.ts",
  "agent/src/lib/shared_texts.ts",
  "agent/src/lib/speak.ts",
  "agent/src/lib/stage_read.ts",
  "agent/src/lib/stage.ts",
  "agent/src/lib/texts.ts",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(ts|mts|tsx)$/.test(entry.name) ? [rel] : [];
  });
}

const SITES = sourceFiles("agent/src").filter((file) => /(?<![\w$])refusalText(?![\w$])/.test(readFileSync(join(ROOT, file), "utf-8"))).sort();

test("refusalText appears only in the files on the list", () => {
  const extra = SITES.filter((file) => !REFUSAL_SITES.includes(file));
  assert.deepEqual(extra, [], "这些文件不在名单里却用了 refusalText；名单只许减不许增，把拒绝语放回名单里的位置");
});

test("every file on the list still uses refusalText", () => {
  const stale = REFUSAL_SITES.filter((file) => !SITES.includes(file));
  assert.deepEqual(stale, [], "这些文件已经不用 refusalText 了，把它们从 REFUSAL_SITES 里删掉");
});
