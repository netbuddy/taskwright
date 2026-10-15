/**
 * 给模型或用户看的整句文字的模板。模板放在 agent/prompts/tools/（工具的说明）与 agent/prompts/runtime/（运行时的文字：
 * 状况消息、界面操作说明、拒绝语等）下的 Markdown 文件里，一个键一段；文件怎样写见 agent/prompts/README.md。
 *
 * 模板里只有 {{名字}} 这一种占位。选哪一句由代码定，这里只按键取出模板、填上值：
 * 键不存在、少给或多给了值都抛错，文件写得不合规矩时读入就抛错。
 * 代码里引用键一律写字面的字符串：直接取文字用 fillText("键", {…})，要先存下键、之后再取的用 textKey("键")。
 * 守护测试（agent/tests/texts_guard.test.ts）按这两种写法扫代码，核对代码用的键都在、模板没有闲置、占位都被填了。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

/** 放模板的两个目录（相对 agent/prompts/）。 */
export const TEXT_DIRS = ["tools", "runtime"] as const;

/** 键的写法：小写字母、数字与下划线，至少两段，用点隔开，例如 status.opening、save_revision.unknown_collection.fact。 */
export const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
/** 一段的标题行：二级标题，键写在反引号里。 */
const HEADING = /^## `([^`]*)`\s*$/;
/** 占位：两层花括号里一个名字（字母、数字或下划线）。 */
const PLACEHOLDER = /\{\{([\p{L}\p{N}_]+)\}\}/gu;
const PURPOSE = "用途：";

export class TextsError extends Error {}

export interface Template {
  key: string;
  /** 模板文件，相对 agent/prompts/，例如 runtime/status.md。 */
  file: string;
  /** 「用途：」那一行冒号后面的话：这一句在哪里出现、给谁看。 */
  purpose: string;
  body: string;
  /** 正文里的占位名，按第一次出现的先后，不重复。 */
  placeholders: string[];
}

/**
 * 拆一份模板文件。第一个键之前的文字（文件标题、说明）不属于任何键。每一段是：标题行「## `键`」，
 * 下面第一个不空的行是「用途：……」，再往下到下一个标题行之前是正文（去掉首尾的空行，中间原样）。
 */
export function parseTemplates(file: string, source: string): Template[] {
  const out: Template[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const where = (i: number) => `${file} 第 ${i + 1} 行`;
  let i = lines.findIndex((line) => line.startsWith("## "));
  while (i >= 0 && i < lines.length) {
    const head = HEADING.exec(lines[i]);
    if (!head) throw new TextsError(`${where(i)}：二级标题只能写成「## \`键\`」`);
    const key = head[1];
    if (!KEY_PATTERN.test(key)) throw new TextsError(`${where(i)}：键「${key}」的写法不对，要写成小写字母、数字与下划线，用点隔成至少两段`);
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length || !lines[j].startsWith(PURPOSE) || !lines[j].slice(PURPOSE.length).trim()) {
      throw new TextsError(`${where(i)}：键「${key}」下面第一行要写「${PURPOSE}」加一句话`);
    }
    const purpose = lines[j].slice(PURPOSE.length).trim();
    let end = j + 1;
    while (end < lines.length && !lines[end].startsWith("## ")) end++;
    const bodyLines = lines.slice(j + 1, end);
    while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
    const body = bodyLines.join("\n");
    if (!body) throw new TextsError(`${where(i)}：键「${key}」没有正文`);
    const stray = body.replace(PLACEHOLDER, "");
    if (stray.includes("{{") || stray.includes("}}")) throw new TextsError(`${where(i)}：键「${key}」的正文里有写错的占位，占位只能写成 {{名字}}`);
    const placeholders = [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))];
    out.push({ key, file, purpose, body, placeholders });
    i = end;
  }
  return out;
}

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

/** 按模板填值。给的值与模板的占位必须一一对上：少给一个或多给一个都抛错。 */
export function fill(one: Template, values: Record<string, string | number> = {}): string {
  const given = Object.keys(values);
  const missing = one.placeholders.filter((name) => !Object.hasOwn(values, name));
  const extra = given.filter((name) => !one.placeholders.includes(name));
  if (missing.length || extra.length) {
    const parts = [missing.length ? `缺 ${missing.join("、")}` : "", extra.length ? `多给了 ${extra.join("、")}` : ""].filter(Boolean);
    throw new TextsError(`模板「${one.key}」（${one.file}）的值对不上：${parts.join("，")}`);
  }
  return one.body.replace(PLACEHOLDER, (_all, name: string) => String(values[name]));
}

/** 取一个键的文字并填上值。键要写字面的字符串，守护测试才扫得到。 */
export function fillText(key: string, values: Record<string, string | number> = {}): string {
  used.add(key);
  return fill(templateOf(key), values);
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
