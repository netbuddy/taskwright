/**
 * Word 材料（.docx）的 Markdown 投影：上传 .docx 时在同一目录生成「文件名.docx.md」，文件里的图片抽到「文件名.docx.media/」。
 * 执行者读投影，保存修订时逐字核对也对着它。投影怎样写只在 agent 的 agent/src/lib/docx_markdown.ts 里写一份，这里在同一进程里调用它
 * （与命令行入口 agent/src/cli/docx_projection.mts 调用的是同一个函数，写文件的做法也与它相同）。
 *
 * 写投影时接着写分段清单「文件名.docx.segments.json」（agent/src/lib/segments.ts，参数是启动配置的「材料分段」一节）
 * 与位置表「文件名.docx.locations.json」（agent/src/lib/docx_location_input.ts，规则在 docx_locations.ts；现在只记章节）。
 *
 * 0.2 的任务里是纯文本投影「文件名.docx.txt」，照旧可读：找投影时先找 .md，没有再找 .txt。
 */

import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEDIA_SUFFIX, PROJECTION_SUFFIX, docxProjection } from "../../agent/src/lib/docx_markdown.ts";
import { SEGMENTS_SUFFIX, SEGMENT_DEFAULTS, type SegmentParams, buildSegments, writeSegments } from "../../agent/src/lib/segments.ts";
import { LOCATIONS_SUFFIX, isLocationTable } from "../../agent/src/lib/docx_locations.ts";
import { locationTable } from "../../agent/src/lib/docx_location_input.ts";

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

/** 以 .docx.md、.docx.txt、.docx.segments.json、.docx.locations.json 结尾的文件名留给由 Word 材料生成的投影、分段清单与位置表。 */
export function isReserved(name: string): boolean {
  const lower = name.toLowerCase();
  return [SUFFIX, LEGACY_SUFFIX, SEGMENTS_SUFFIX].some((suffix) => lower.endsWith(".docx" + suffix)) || isLocationTable(name);
}

/** 这份 .docx 的投影：有 Markdown 投影用它，只有 0.2 的纯文本投影时用那个，都没有时是 Markdown 投影该在的位置。 */
export function projectionPath(docx: string): string {
  const md = docx + SUFFIX;
  const legacy = docx + LEGACY_SUFFIX;
  return !isFile(md) && isFile(legacy) ? legacy : md;
}

function read(docx: string): Buffer {
  try {
    return readFileSync(docx);
  } catch {
    throw new ProjectionError(`读不到文件 ${docx}。`);
  }
}

function project(data: Buffer, rel: string) {
  try {
    return docxProjection(data, rel);
  } catch (error) {
    throw new ProjectionError((error as Error).message);
  }
}

/**
 * 在 .docx 旁边写投影（有图片时连同图片目录，先清空这个目录）、分段清单与位置表，返回投影的路径。
 * 不是合法的 .docx，或者三样里有一样没写成时抛 ProjectionError（上传因此被拒绝，已写的由 removeProjection 清掉）。
 */
export function writeProjection(docx: string, rel: string, segments: SegmentParams = SEGMENT_DEFAULTS): string {
  const data = read(docx);
  const result = project(data, rel);
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
  try {
    writeSegments(docx + SEGMENTS_SUFFIX, buildSegments(result.markdown, segments, rel, rel + SUFFIX));
  } catch (error) {
    throw new ProjectionError(`分段清单没有写成：${(error as Error).message}`);
  }
  try {
    writeFileSync(docx + LOCATIONS_SUFFIX, JSON.stringify(locationTable(data, rel, result), null, 2) + "\n", "utf-8");
  } catch (error) {
    throw new ProjectionError(`位置表没有写成：${(error as Error).message}`);
  }
  return projection;
}

/** 不写文件，只算出投影全文（投影文件缺失时材料内容接口用）。 */
export function projectionText(docx: string, rel: string): string {
  return project(read(docx), rel).markdown;
}

/** 删掉这份 .docx 的 Markdown 投影、分段清单、位置表与图片目录（上传失败时清理）。 */
export function removeProjection(docx: string): void {
  for (const file of [docx + SUFFIX, docx + SEGMENTS_SUFFIX, docx + LOCATIONS_SUFFIX]) {
    try {
      unlinkSync(file);
    } catch {
      // 本来就没有
    }
  }
  rmSync(docx + MEDIA_SUFFIX, { recursive: true, force: true });
}
