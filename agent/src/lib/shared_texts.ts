/**
 * 页面也导入的助手库文件取模板用的几个函数，与 lib/texts.ts 里的同名，只是不读文件：
 * 模板只有 agent/prompts/runtime/shared.md 里的那些，取自由它生成的 lib/shared_texts.gen.ts（node scripts/render-shared-texts.mts）。
 * 键同样要写字面的字符串，守护测试才扫得到。
 */

import { SHARED_TEMPLATES } from "./shared_texts.gen.ts";
import { type Template, TextsError, fill, prefixOf } from "./texts_core.ts";

const BY_KEY = new Map<string, Template>(SHARED_TEMPLATES.map((one) => [one.key, one]));

function templateOf(key: string): Template {
  const one = BY_KEY.get(key);
  if (!one) throw new TextsError(`没有键为「${key}」的共用模板（agent/prompts/runtime/shared.md 里没有，或者 lib/shared_texts.gen.ts 没有重新生成）`);
  return one;
}

/** 取一个键的文字并填上值；少给或多给值都抛错。 */
export function fillText(key: string, values: Record<string, string | number> = {}): string {
  return fill(templateOf(key), values);
}

/** 一个键的模板正文在第一个占位之前的那一段（认一句话的开头用）。 */
export function textPrefix(key: string): string {
  return prefixOf(templateOf(key));
}
