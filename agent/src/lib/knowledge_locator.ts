/**
 * 知识库的几样约定：文档的种类，以及来源的出处怎样指向知识库里的一份文档。助手一侧、后端与页面共用。
 *
 * 引用知识库文档的来源，种类仍是「文档原文」，出处写成 knowledge/<知识库编号>/<文档名>；Word 文档照材料的办法加段落号
 * （knowledge/<知识库编号>/<文档名>.docx#p12）。出处以 knowledge/ 开头的，就是知识库来源；其余的是材料。
 *
 * 本文件不导入任何模块：页面也直接导入它（agent/tests/web_imports.test.ts 守着）。
 */

/** 「通用库」的编号：每个任务默认选用。 */
export const GENERAL = "general";

/** 文档的种类：只是标签，不决定用法。界面上与给助手的清单里都显示中文。 */
export const KINDS = ["standard", "glossary", "template", "past_work", "other"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_NAMES: Record<Kind, string> = { standard: "规范", glossary: "术语表", template: "模板", past_work: "以往的成果", other: "其他" };

/** 知识库来源的出处的开头。 */
export const KNOWLEDGE_PREFIX = "knowledge/";

export interface KnowledgeLocator {
  /** 知识库编号。 */
  library: string;
  /** 文档名（不带段落号）。 */
  name: string;
  /** Word 文档的段落号；没写或不是 Word 文档时为 null。 */
  paragraph: number | null;
}

/** 这条出处是不是指向知识库里的文档。 */
export function isKnowledgeLocator(locator: string): boolean {
  return locator.startsWith(KNOWLEDGE_PREFIX);
}

/** 一份知识库文档的出处写法。 */
export function knowledgeLocator(library: string, name: string): string {
  return `${KNOWLEDGE_PREFIX}${library}/${name}`;
}

/**
 * 把知识库来源的出处拆成知识库编号、文档名与段落号。不以 knowledge/ 开头、缺编号或文档名、
 * 编号或文档名里带路径分隔符或是「.」「..」的，返回 null（这样的出处指不到知识库里的任何文件）。
 */
export function parseKnowledgeLocator(locator: string): KnowledgeLocator | null {
  if (!isKnowledgeLocator(locator)) return null;
  const rest = locator.slice(KNOWLEDGE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const library = rest.slice(0, slash);
  let name = rest.slice(slash + 1);
  let paragraph: number | null = null;
  const docx = /^(.+\.docx)#p(\d+)$/i.exec(name);
  if (docx) {
    name = docx[1];
    paragraph = Number(docx[2]);
  }
  const bad = (part: string) => part === "" || part === "." || part === ".." || part.includes("/") || part.includes("\\");
  if (bad(library) || bad(name)) return null;
  return { library, name, paragraph };
}
