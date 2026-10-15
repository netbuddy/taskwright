/**
 * 给模型或用户看的整句文字的模板。模板放在 agent/prompts/tools/（工具的说明）与 agent/prompts/runtime/（运行时的文字：
 * 状况消息、界面操作说明、拒绝语等）下的 Markdown 文件里，一个键一段；文件怎样写见 agent/prompts/README.md。
 *
 * 模板里只有 {{名字}} 这一种占位。选哪一句由代码定，这里只按键取出模板、填上值：
 * 键不存在、少给或多给了值都抛错，文件写得不合规矩时读入就抛错。
 * 代码里引用键一律写字面的字符串：直接取文字用 fillText("键", {…})，要先存下键、之后再取的用 textKey("键")，
 * 认一句话的开头用 textPrefix("键")（正文在第一个占位之前的那一段），认整句并取出其中的值用 textPattern("键")（转成正则的文字）。
 * 守护测试（agent/tests/texts_guard.test.ts）按这几种写法扫代码，核对代码用的键都在、模板没有闲置、占位都被填了。
 *
 * 本文件读文件，页面导入不了。页面也导入的助手库文件（例如 lib/stage.ts）改用 lib/shared_texts.ts：同名的几个函数，
 * 模板只有 agent/prompts/runtime/shared.md 里的那些，取自由它生成的 lib/shared_texts.gen.ts。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type Template, TextsError, fill, parseTemplates, patternOf, prefixOf } from "./texts_core.ts";

export { KEY_PATTERN, type Template, TextsError, fill, parseTemplates, patternOf, prefixOf } from "./texts_core.ts";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

/** 放模板的两个目录（相对 agent/prompts/）。 */
export const TEXT_DIRS = ["tools", "runtime"] as const;

/** 读入一个提示词目录下的全部模板；同一个键出现两次时抛错。dir 缺省是产品自带的 agent/prompts/，测试里换成别的。 */
export function loadTemplates(dir: string = PROMPTS_DIR): Map<string, Template> {
  const all = new Map<string, Template>();
  for (const sub of TEXT_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(dir, sub)).filter((name) => name.endsWith(".md") && name !== "README.md").sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, sub, name);
      for (const one of parseTemplates(relative(dir, path), readFileSync(path, "utf-8"))) {
        const seen = all.get(one.key);
        if (seen) throw new TextsError(`键「${one.key}」写了两次：${seen.file} 与 ${one.file}`);
        all.set(one.key, one);
      }
    }
  }
  return all;
}

let loaded: Map<string, Template> | null = null;
/** 这个进程里实际取过的键（运行时登记），守护测试用它核对跑到的调用。 */
const used = new Set<string>();

/** 产品自带的全部模板；第一次用时读入，之后同一个进程里不再读文件。 */
export function templates(): Map<string, Template> {
  return (loaded ??= loadTemplates());
}

function templateOf(key: string): Template {
  const one = templates().get(key);
  if (!one) throw new TextsError(`没有键为「${key}」的模板（agent/prompts/tools/ 与 agent/prompts/runtime/ 下都没有）`);
  return one;
}

/** 取一个键的文字并填上值。键要写字面的字符串，守护测试才扫得到。 */
export function fillText(key: string, values: Record<string, string | number> = {}): string {
  used.add(key);
  return fill(templateOf(key), values);
}

/** 一个键的模板正文在第一个占位之前的那一段（认一句话的开头用）。键要写字面的字符串，守护测试才扫得到。 */
export function textPrefix(key: string): string {
  return prefixOf(templateOf(key));
}

/** 一个键的模板正文转成的正则文字（占位换成捕获组）。键要写字面的字符串，守护测试才扫得到。 */
export function textPattern(key: string): string {
  return patternOf(templateOf(key));
}

/** 先存下一个键，之后再用 fillText 取。键不存在时当场抛错；键要写字面的字符串，守护测试才扫得到。 */
export function textKey(key: string): string {
  templateOf(key);
  return key;
}

/** 这个进程里 fillText 取过的键。 */
export function usedTextKeys(): ReadonlySet<string> {
  return used;
}
