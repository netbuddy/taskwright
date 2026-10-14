/**
 * 助手发布版本时请任务服务把这一版的文档写进任务目录：生成文档（Markdown 与 Word）的代码在任务服务那一边，
 * 助手这一侧只把版本号与修订号发给存档接口（POST /api/v1/tasks/{任务编号}/versions/archive），拿回两个文件的位置。
 * 任务服务在哪里，与校验图、查找知识库同一个办法（lib/knowledge_search.ts 的 backendAddresses）。
 * 助手发布时没有页面画好的图，Word 里的图都写成 Mermaid 文本：任务服务回答的图数里图片是 0 张。
 *
 * 存档没有做成（联系不上、回答了错误、到时间没有回答）时抛 archiveRefusal 的拒绝：这一版不发布，请用户在页面上再试。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { backendAddresses } from "./knowledge_search.ts";
import { type Archive, type PublishCheck, archiveRefusal } from "./publish_version.ts";

/** 等任务服务写好存档最多等多久：生成 Word 第一次要加载那一部分代码。 */
export const ARCHIVE_TIMEOUT_MS = 60_000;

/** 存档接口的路径（backend/src/http.ts 的路由，两边是一份约定）。 */
export const archivePath = (taskId: string): string => `/api/v1/tasks/${encodeURIComponent(taskId)}/versions/archive`;

export interface ArchiveOptions {
  signal?: AbortSignal;
  /** 发请求用的函数，缺省是自带的 fetch（测试里换成假的）。 */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** 请任务服务写第 N 版的存档（按修订 R 生成）。 */
export async function archiveWithService(taskDir: string, check: PublishCheck, options: ArchiveOptions = {}): Promise<Archive> {
  const addresses = backendAddresses(taskDir);
  if (!addresses.length) throw archiveRefusal(check.versionNo, "联系不上任务服务");
  const send = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? ARCHIVE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let status = 0;
  let body: any = null;
  for (const address of addresses) {
    try {
      const res = await send(address + archivePath(check.taskId), {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ version_no: check.versionNo, revision_no: check.revisionNo }), signal,
      });
      status = res.status;
      body = await res.json().catch(() => null);
      break;
    } catch {
      // 这个地址连不上（或者到时间没有回答）：试下一个
      if (signal.aborted) break;
    }
  }
  if (options.signal?.aborted) throw archiveRefusal(check.versionNo, "这次调用被取消了");
  if (status === 0) throw archiveRefusal(check.versionNo, timeout.aborted ? "等了很久没有等到任务服务写好" : "联系不上任务服务");
  if (status !== 200 || body?.ok !== true) {
    const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : `HTTP ${status}`;
    throw archiveRefusal(check.versionNo, `任务服务回答了错误：${message}`);
  }
  return {
    markdownPath: typeof body.markdown_path === "string" ? body.markdown_path : null,
    docxPath: typeof body.docx_path === "string" ? body.docx_path : null,
    figures: Number.isInteger(body.figure_count) && body.figure_count > 0 && Number.isInteger(body.figure_pictures)
      ? { count: body.figure_count, pictures: body.figure_pictures } : null,
  };
}
