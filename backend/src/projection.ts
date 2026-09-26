/**
 * Word 材料（.docx）的 Markdown 投影：上传 .docx 时在同一目录生成「文件名.docx.md」，文件里的图片抽到「文件名.docx.media/」。
 * 执行者读投影，保存修订时逐字核对也对着它。投影怎样写只在 agent 的 agent/src/lib/docx_markdown.ts 里写一份，这里在同一进程里调用它
 * （与命令行入口 agent/src/cli/docx_projection.mts 调用的是同一个函数，写文件的做法也与它相同）。
 *
 * 0.2 的任务里是纯文本投影「文件名.docx.txt」，照旧可读：找投影时先找 .md，没有再找 .txt。
 */

import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEDIA_SUFFIX, PROJECTION_SUFFIX, docxProjection } from "../../agent/src/lib/docx_markdown.ts";

export const SUFFIX = PROJECTION_SUFFIX;
export const LEGACY_SUFFIX = ".txt";

/** 投影失败（不是合法的 .docx，或者投影没有写成）。消息是给人看的一句中文。 */
export class ProjectionError extends Error {}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 以 .docx.md、.docx.txt 结尾的文件名留给由 Word 材料生成的投影。 */
export function isReserved(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".docx" + SUFFIX) || lower.endsWith(".docx" + LEGACY_SUFFIX);
}

/** 这份 .docx 的投影：有 Markdown 投影用它，只有 0.2 的纯文本投影时用那个，都没有时是 Markdown 投影该在的位置。 */
export function projectionPath(docx: string): string {
  const md = docx + SUFFIX;
  const legacy = docx + LEGACY_SUFFIX;
  return !isFile(md) && isFile(legacy) ? legacy : md;
}

function project(docx: string, rel: string) {
  let data: Buffer;
  try {
    data = readFileSync(docx);
  } catch {
    throw new ProjectionError(`读不到文件 ${docx}。`);
  }
  try {
    return docxProjection(data, rel);
  } catch (error) {
    throw new ProjectionError((error as Error).message);
  }
}

/** 在 .docx 旁边写投影（有图片时连同图片目录，先清空这个目录），返回投影的路径。不是合法的 .docx 时抛 ProjectionError。 */
export function writeProjection(docx: string, rel: string): string {
  const result = project(docx, rel);
  const projection = docx + SUFFIX;
  const media = docx + MEDIA_SUFFIX;
  try {
    rmSync(media, { recursive: true, force: true });
    if (result.media.size) {
      mkdirSync(media);
      for (const [name, bytes] of result.media) writeFileSync(join(media, name), bytes);
    }
    writeFileSync(projection, result.markdown, "utf-8");
  } catch (error) {
    throw new ProjectionError(`投影没有写成：${(error as Error).message}`);
  }
  return projection;
}

/** 不写文件，只算出投影全文（投影文件缺失时材料内容接口用）。 */
export function projectionText(docx: string, rel: string): string {
  return project(docx, rel).markdown;
}

/** 删掉这份 .docx 的 Markdown 投影与图片目录（上传失败时清理）。 */
export function removeProjection(docx: string): void {
  try {
    unlinkSync(docx + SUFFIX);
  } catch {
    // 本来就没有
  }
  rmSync(docx + MEDIA_SUFFIX, { recursive: true, force: true });
}
