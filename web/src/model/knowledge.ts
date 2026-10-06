// 知识库在页面上的几种说法：文档份数、有几个任务在用、种类的中文叫法、上传前的大小检查。
// 种类的叫法与上传上限都来自服务信息（GET /api/v1/service 的 knowledge_upload），前端不另写一份。

import type { DocumentEmbedding, EmbeddedLibrary, KnowledgeKind, KnowledgeLibrary, KnowledgeSearchHit, ServiceInfo } from "../api/types";
import { GENERAL, isKnowledgeLocator, parseKnowledgeLocator } from "../../../agent/src/lib/knowledge_locator.ts";

// 通用知识库的编号（每个任务都选用它，不能删除、不能改名）与「出处是不是指向知识库」的判断，定义在助手一侧，这里原样交出去。
export { GENERAL, isKnowledgeLocator };

/** 通用知识库排第一，其余照后端给的先后。 */
export function sortedLibraries<T extends KnowledgeLibrary>(libs: T[]): T[] {
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

/** 有文档在等待换算或者换算中时，知识库页面隔多久再取一次清单。 */
export const embeddingPolling = { intervalMs: 2000 };

/** 一份文档的换算状态给人看的写法。换算中带「算完了几个片段 / 一共几个」；没有文字的文档不用换算。 */
export function embeddingStatusText(e: DocumentEmbedding): string {
  if (e.status === "queued") return "等待换算";
  if (e.status === "running") return e.total === null ? "换算中" : `换算中（${e.done ?? 0} / ${e.total}）`;
  if (e.status === "done") return e.total === 0 ? "没有文字，不用换算" : "已换算";
  return e.status === "failed" ? "换算失败" : "未换算";
}

/** 嵌入模型「服务名/型号」里给人看的那一半：型号。 */
export function embeddingModelName(model: string): string {
  return model.slice(model.indexOf("/") + 1);
}

/** 这个知识库里有没有文档正在换算或者等着换算。 */
export function embeddingBusy(lib: EmbeddedLibrary): boolean {
  return lib.documents.some((d) => d.embedding.status === "queued" || d.embedding.status === "running");
}

/** 按意思查到的片段在文档的哪里：Word 文档写第几到几段，别的写第几到几行；起止相同时只写一个。 */
export function searchPlaceText(hit: Pick<KnowledgeSearchHit, "first_paragraph" | "last_paragraph" | "first_line" | "last_line">): string {
  const range = (from: number, to: number, unit: string) => (from === to ? `第 ${from} ${unit}` : `第 ${from} 到 ${to} ${unit}`);
  if (hit.first_paragraph !== null && hit.last_paragraph !== null) return range(hit.first_paragraph, hit.last_paragraph, "段");
  return hit.first_line !== null && hit.last_line !== null ? range(hit.first_line, hit.last_line, "行") : "";
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
