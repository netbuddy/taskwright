/**
 * 模板的拆读与填值，不读文件、不用 Node 的模块：页面也导入它（经 lib/shared_texts.ts）。
 * 读文件的那一半在 lib/texts.ts；模板文件怎样写见 agent/prompts/README.md。
 */

/** 键的写法：小写字母、数字与下划线，至少两段，用点隔开，例如 status.opening、save_revision.unknown_collection.fact。 */
export const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
/** 一段的标题行：二级标题，键写在反引号里。 */
const HEADING = /^## `([^`]*)`\s*$/;
/** 占位：两层花括号里一个名字（字母、数字或下划线）。 */
export const PLACEHOLDER = /\{\{([\p{L}\p{N}_]+)\}\}/gu;
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

/** 模板正文在第一个占位之前的那一段；没有占位时是整段。认一句话的开头用它，不另写一份开头。 */
export function prefixOf(one: Template): string {
  const at = one.body.indexOf("{{");
  return at < 0 ? one.body : one.body.slice(0, at);
}
