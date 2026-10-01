// 知识库在页面上的几种说法：文档份数、有几个任务在用、种类的中文叫法、上传前的大小检查。
// 种类的叫法与上传上限都来自服务信息（GET /api/v1/service 的 knowledge_upload），前端不另写一份。

import type { KnowledgeKind, KnowledgeLibrary, ServiceInfo } from "../api/types";
import { isKnowledgeLocator, parseKnowledgeLocator } from "../../../agent/src/lib/knowledge_locator.ts";

export { isKnowledgeLocator };

/** 通用知识库的编号：每个任务都选用它，不能删除、不能改名。 */
export const GENERAL = "general";

/** 通用知识库排第一，其余照后端给的先后。 */
export function sortedLibraries(libs: KnowledgeLibrary[]): KnowledgeLibrary[] {
  return [...libs.filter((l) => l.id === GENERAL), ...libs.filter((l) => l.id !== GENERAL)];
}

export const docCountText = (lib: KnowledgeLibrary) => `${lib.documents.length} 份文档`;

/**
 * 有几个任务在用这个库。通用知识库写「每个任务都会用到」。thisTask 给了时按这个任务是否选用了它说：
 * 只有这个任务在用时写「只有这个任务在用」。
 */
export function usageText(lib: KnowledgeLibrary, thisTask?: { selected: boolean }): string {
  if (lib.id === GENERAL) return "每个任务都会用到";
  if (lib.used_by_tasks === 0) return "没有任务在用";
  if (thisTask?.selected && lib.used_by_tasks === 1) return "只有这个任务在用";
  return `${lib.used_by_tasks} 个任务在用`;
}

/** 种类的中文叫法；服务信息里没有时写种类本身。 */
export function kindName(info: ServiceInfo | null, kind: KnowledgeKind): string {
  return info?.knowledge_upload?.kinds.find((k) => k.kind === kind)?.name ?? kind;
}

/** 放进知识库的文件超过上限时返回后端给的那句话；不超过或还没取到服务信息时返回 null（这时照常发给后端，由后端拒绝）。 */
export function knowledgeTooLargeText(info: ServiceInfo | null, file: { size: number }): string | null {
  const upload = info?.knowledge_upload;
  if (!upload) return null;
  return file.size > upload.max_bytes ? upload.too_large_text : null;
}

/** 知识库上传框说明里写大小的那半句，例如「单个文件不超过 20 MB」。 */
export function knowledgeLimitText(info: ServiceInfo | null): string | null {
  const upload = info?.knowledge_upload;
  return upload ? `单个文件不超过 ${upload.max_bytes / 1024 / 1024} MB` : null;
}

/** 一条知识库来源给人看的出处。 */
export interface KnowledgePlace {
  /** 知识库编号；出处的写法不对、拆不出来时是空的。 */
  library: string;
  name: string;
  /** Word 文档的段落号；没有时为 null。 */
  paragraph: number | null;
  /** 「知识库名 / 文档名」，Word 文档再写第几段。知识库已经不在清单里时写它的编号。 */
  label: string;
  /** 「知识库名 / 文档名」，不带段落号。 */
  title: string;
  /** 这份文档已经不在那个知识库的清单里（知识库本身不在了也算）。没有清单时不判断，为 false。 */
  gone: boolean;
}

/** 把知识库来源的出处（knowledge/知识库编号/文档名）换成给人看的写法，并按清单判断文档还在不在。 */
export function knowledgePlace(locator: string, libraries: KnowledgeLibrary[] | null): KnowledgePlace {
  const parsed = parseKnowledgeLocator(locator);
  if (!parsed) return { library: "", name: locator, paragraph: null, label: locator, title: locator, gone: libraries !== null };
  const library = libraries?.find((one) => one.id === parsed.library);
  const title = `${library?.name ?? parsed.library} / ${parsed.name}`;
  return {
    ...parsed, title,
    label: parsed.paragraph !== null ? `${title} · 第 ${parsed.paragraph} 段` : title,
    gone: libraries !== null && !library?.documents.some((doc) => doc.name === parsed.name),
  };
}

/**
 * 摘录在文档正文里的起止位置，找不到为 null。Word 文档给了段落号时先在那一段所在的行里找（正文每段一行，行里写着 [pN]），
 * 行里找不到就取整行；没有段落号或正文里没有那一段时，取摘录在全文里第一次出现的位置。
 */
export function excerptSpan(text: string, excerpt: string, paragraph: number | null): [number, number] | null {
  const want = excerpt.trim();
  if (paragraph !== null) {
    const mark = text.indexOf(`[p${paragraph}]`);
    if (mark >= 0) {
      const start = text.lastIndexOf("\n", mark) + 1;
      const end = text.indexOf("\n", mark) < 0 ? text.length : text.indexOf("\n", mark);
      const at = want ? text.slice(start, end).indexOf(want) : -1;
      return at >= 0 ? [start + at, start + at + want.length] : [start, end];
    }
  }
  const at = want ? text.indexOf(want) : -1;
  return at >= 0 ? [at, at + want.length] : null;
}
