/**
 * 分析提纲（任务类型 skill 目录里的 outline.md）的文字解析：维度、各维度的提纲条目、哪些维度不要求举例、元数据登记的固定页名字。
 * 平台不读维度与提纲条目的文字含义，只拿这些名字认页。只做字符串处理、不用 Node 模块：页面直接导入它画目录（web/src/model/outlineTree.ts），
 * 读文件的那一半在 outline_read.ts。
 */

/** 元数据里登记固定页名字的键：正文是综合的那几页。 */
export const SYNTHESIS_PAGE_KEYS = ["judgement", "ideas", "unsorted"] as const;

export interface OutlineTitles {
  /** 维度名，即二级小节的名字。 */
  dimensions: string[];
  /** 元数据里 SYNTHESIS_PAGE_KEYS 登记的固定页的名字。 */
  synthesisPages: string[];
  /** 写了 `examples: optional` 的维度：这些维度的页不要求举例。 */
  examplesOptional: string[];
  /** 每个维度下的提纲条目名（「- 条目名 —— ……」一行的开头），照提纲的先后。 */
  entries: Record<string, string[]>;
  /** 提纲条目下一行写了 `table: 列名、列名……` 的：条目名 → 这个条目页正文第一张表应有的表头，照写的先后。 */
  tables: Record<string, string[]>;
  /** 元数据里登记的各页固定页的名字，按键取；没有登记的键没有。 */
  fixedPages: Partial<Record<(typeof SYNTHESIS_PAGE_KEYS)[number], string>>;
}

/** 从分析提纲的文字里取维度名与固定页的名字。 */
export function outlineTitles(text: string): OutlineTitles {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const meta = new Map(head.split("\n").map((line) => /^(\w+):\s*(.+)$/.exec(line.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1], m[2].trim()]));
  const synthesisPages = SYNTHESIS_PAGE_KEYS.map((key) => meta.get(key)).filter((one): one is string => !!one);
  const sections = text.split(/^## /m).slice(1).map((part) => {
    const [name, ...rest] = part.split("\n");
    const body = rest.join("\n");
    return { name: name.trim(), optional: /^examples:\s*optional\s*$/m.test(body), entries: [...body.matchAll(/^- (.+?) ——/gm)].map((m) => m[1].trim()),
      tables: [...body.matchAll(/^- (.+?) ——.*\n\s+table:\s*(.+)$/gm)].map((m): [string, string[]] => [m[1].trim(), m[2].split("、").map((one) => one.trim()).filter(Boolean)]) };
  });
  return {
    dimensions: sections.map((one) => one.name),
    synthesisPages,
    examplesOptional: sections.filter((one) => one.optional).map((one) => one.name),
    entries: Object.fromEntries(sections.map((one) => [one.name, one.entries])),
    tables: Object.fromEntries(sections.flatMap((one) => one.tables)),
    fixedPages: Object.fromEntries(SYNTHESIS_PAGE_KEYS.filter((key) => meta.has(key)).map((key) => [key, meta.get(key)!])),
  };
}

/** 一页按名字该有哪种表头（OutlineTitles.tables）：名字是写了 table 的提纲条目名，或者「条目名 · 子系统名」；不该有时返回 null。 */
export function tableHeaderFor(outline: OutlineTitles, name: string): string[] | null {
  return outline.tables[name.split(" · ")[0].trim()] ?? null;
}

/**
 * 一页属于要求举例的维度吗（没有写 `examples: optional` 的维度）：它的名字是这种维度的维度名或提纲条目名，
 * 或者是「维度名 · 子系统名」「条目名 · 子系统名」。子主题页、候选页与固定页的名字对不上这几种，不算。
 */
export function examplesRequiredFor(outline: OutlineTitles, name: string): boolean {
  const head = name.split(" · ")[0].trim();
  return outline.dimensions.filter((dimension) => !outline.examplesOptional.includes(dimension))
    .some((dimension) => head === dimension || (outline.entries[dimension] ?? []).includes(head));
}

