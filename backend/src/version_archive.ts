/**
 * 发布一个版本时，把这一版生成的文档存进任务目录：versions/v{N}/document.md 与 document.docx（agent/src/lib/versions.ts 的约定）。
 * 文档按发布时的那次修订整体生成，全部条目，与「生成文档」里同一个模板、同一个渲染（render.ts）；Word 与「下载 Word」同一个写法。
 * 页面发起的发布带着页面画好的图（PNG），存进 Word；助手发起的没有图，Word 里写它们的 Mermaid 文本。
 * 文档里的每一张图都有图片时（没有图也算）记「图存了」。
 *
 * 只写文件，不写任务库：版本记录由助手一侧的发布函数在核对通过之后记（agent/src/lib/publish_version.ts）。没有记成时调用方删掉这个目录。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { documentBlocks } from "../../agent/src/lib/document_blocks.ts";
import { ARCHIVED_DOCX, ARCHIVED_MARKDOWN, versionDir } from "../../agent/src/lib/versions.ts";
import { ApiError } from "./errors.ts";
import * as exportDocument from "./export_document_docx.ts";
import type { FigureImage } from "./export_document_docx.ts";
import * as library from "./library.ts";
import * as render from "./render.ts";
import type { Locate, LibraryName } from "./render.ts";

export interface WrittenArchive {
  markdown_path: string;
  docx_path: string;
  figures_archived: boolean;
}

/** 下一个版本号：已有的最大号加 1。 */
export function nextVersion(taskDir: string): number {
  return library.versionRows(taskDir).reduce((max, one) => Math.max(max, one.version_no), 0) + 1;
}

/**
 * 写第 versionNo 版的存档，按修订 revisionNo 生成。这一版已经发布过（有版本记录）时拒绝；目录里有上一次没有记成留下的文件时整个换掉。
 * locator 与 libraryName 与「生成文档」相同（出处的写法、知识库的名字）。
 */
export async function writeArchive(taskDir: string, versionNo: number, revisionNo: number, images: ReadonlyMap<string, FigureImage>,
  locator: Locate | null, libraryName: LibraryName | null): Promise<WrittenArchive> {
  if (library.versionRows(taskDir).some((one) => one.version_no === versionNo)) throw new ApiError("rejected", `第 ${versionNo} 版已经发布过了。`);
  const lib = library.libraryOf(taskDir);
  const latest = lib.latestRevision();
  if (revisionNo > latest) throw new ApiError("bad_request", `交付物现在是修订 ${latest}，没有修订 ${revisionNo}。`);
  // 还没有任何修订时（revisionNo 为 0）按最新生成，就是空的那一份。
  const text = render.render(taskDir, lib, revisionNo || null, null, locator, libraryName);
  const taskName = String(lib.data.task?.task_name || lib.definition["任务名"] || "");
  const docx = await exportDocument.documentDocx(text, images, taskName);
  const figures = documentBlocks(text).flatMap((block) => (block.kind === "figure" ? [block.diagram_id ?? ""] : []));
  const dir = versionDir(versionNo);
  const full = join(taskDir, dir);
  rmSync(full, { recursive: true, force: true });
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, ARCHIVED_MARKDOWN), text, "utf-8");
  writeFileSync(join(full, ARCHIVED_DOCX), docx);
  return {
    markdown_path: `${dir}/${ARCHIVED_MARKDOWN}`, docx_path: `${dir}/${ARCHIVED_DOCX}`,
    figures_archived: figures.every((id) => id !== "" && images.has(id)),
  };
}

/** 发布没有记成时删掉这一版的存档目录。 */
export function dropArchive(taskDir: string, versionNo: number): void {
  rmSync(join(taskDir, versionDir(versionNo)), { recursive: true, force: true });
}
