/**
 * 内容检查用的平台说明：能力模块（agent/prompts/capabilities/）去掉头、按次序号接起来的整份，与按名字取一个模块的正文。
 * 早先平台说明是一份 common.md，检查它的测试改读这里。
 */

import { join } from "node:path";
import { PROMPTS_DIR } from "../src/lib/context_assemble.ts";
import { loadModules } from "../src/lib/prompt_modules.ts";

export const CAPABILITIES_DIR = join(PROMPTS_DIR, "capabilities");

/** 全部模块的正文，按次序号用空行接起来。 */
export function platformText(): string {
  return loadModules(CAPABILITIES_DIR).map((one) => one.body).join("\n\n");
}

/** 一个模块的正文；没有这个模块就抛错。 */
export function moduleText(name: string): string {
  const found = loadModules(CAPABILITIES_DIR).find((one) => one.name === name);
  if (!found) throw new Error(`没有模块 ${name}`);
  return found.body;
}
