// 知识库在页面上的几种说法：文档份数、有几个任务在用、种类的中文叫法、上传前的大小检查。
// 种类的叫法与上传上限都来自服务信息（GET /api/v1/service 的 knowledge_upload），前端不另写一份。

import type { KnowledgeKind, KnowledgeLibrary, ServiceInfo } from "../api/types";

/** 通用库的编号：每个任务都选用它，不能删除、不能改名。 */
export const GENERAL = "general";

/** 通用库排第一，其余照后端给的先后。 */
export function sortedLibraries(libs: KnowledgeLibrary[]): KnowledgeLibrary[] {
  return [...libs.filter((l) => l.id === GENERAL), ...libs.filter((l) => l.id !== GENERAL)];
}

export const docCountText = (lib: KnowledgeLibrary) => `${lib.documents.length} 份文档`;

/**
 * 有几个任务在用这个库。通用库写「每个任务都会用到」。thisTask 给了时按这个任务是否选用了它说：
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
