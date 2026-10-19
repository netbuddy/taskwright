/**
 * 系统提示的字节上限：每个位置（六个阶段在工作流里、六个阶段做单项活动、空闲）拼出来的系统提示都不超过上限，超过即失败。
 * 首版上限按重构第 1 期甲组实测的最大位置（编写文档，工作流里，66597 字节，不含 pi 接在后面的工作目录）加三成定，取整到百。
 * 加了文字要超过时，先删减或换成按条件进的模块，不要直接调高上限。
 */

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { composeContext } from "../src/lib/context_assemble.ts";
import { IDLE, STAGES, type Stage } from "../src/lib/stage.ts";

const SYSTEM_PROMPT_MAX_BYTES = 86600;

const SRS_TYPE = join(resolve(import.meta.dirname, "..", ".."), "task-types", "requirements-engineering");
const SKILLS = [{ name: "requirements-engineering", filePath: join(SRS_TYPE, ".pi", "skills", "requirements-engineering", "SKILL.md") }];
const bytesAt = (stage: Stage | typeof IDLE, inFlow = true): number =>
  Buffer.byteLength(composeContext({ stage, inFlow, workspaceDir: SRS_TYPE, skills: SKILLS, tail: "" }).text, "utf-8");

test("每个位置拼出来的系统提示都不超过字节上限", () => {
  const sizes: [string, number][] = [
    ...STAGES.map((stage): [string, number] => [`${stage}（工作流）`, bytesAt(stage)]),
    ...STAGES.map((stage): [string, number] => [`${stage}（单项活动）`, bytesAt(stage, false)]),
    ["空闲", bytesAt(IDLE)],
  ];
  const over = sizes.filter(([, bytes]) => bytes > SYSTEM_PROMPT_MAX_BYTES);
  assert.deepEqual(over, [], `上限 ${SYSTEM_PROMPT_MAX_BYTES} 字节；超出的位置见上`);
});
