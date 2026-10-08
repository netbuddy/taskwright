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
import { type PdfLocationFile, PDF_LOCATIONS_SUFFIX } from "../../agent/src/lib/pdf_locations.ts";
import { PDF_SEGMENTS_SUFFIX } from "../../agent/src/lib/pdf_segments.ts";
import { PDF_PROJECTION_SUFFIX } from "./pdf_projection.ts";

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

/** 由 PDF 材料生成的三个文件跟在 PDF 文件名后面的后缀：投影、分段清单、位置表。 */
export const PDF_DERIVED_SUFFIXES: readonly string[] = [PDF_PROJECTION_SUFFIX, PDF_SEGMENTS_SUFFIX, PDF_LOCATIONS_SUFFIX];

/** 这个文件名是由哪份 PDF 生成的（x.pdf.md、x.pdf.segments.json、x.pdf.locations.json 都是 x.pdf）；不是这三种时是 null。 */
export function pdfSourceName(name: string): string | null {
  const lower = name.toLowerCase();
  const suffix = PDF_DERIVED_SUFFIXES.find((one) => lower.endsWith(".pdf" + one));
  return suffix ? name.slice(0, -suffix.length) : null;
}

/**
 * 以 .docx.md、.docx.txt、.docx.segments.json、.docx.locations.json 结尾的文件名留给由 Word 材料生成的投影、分段清单与位置表；
 * 以 .pdf.md、.pdf.segments.json、.pdf.locations.json 结尾的留给由 PDF 材料生成的这三样。
 */
export function isReserved(name: string): boolean {
  const lower = name.toLowerCase();
  return [SUFFIX, LEGACY_SUFFIX, SEGMENTS_SUFFIX].some((suffix) => lower.endsWith(".docx" + suffix)) || isLocationTable(name) || pdfSourceName(name) !== null;
}

/** 上传的文件名是留用的名字时给用户看的那句话；noun 是「材料」或「文档」。 */
export const reservedNameText = (noun: string) =>
  `以 .docx.md、.docx.txt 或 .pdf.md 这类写法结尾的文件名留给由 Word、PDF ${noun}生成的文件用，请改个名字再上传。`;

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

// ───────────── PDF 材料 ─────────────

/** 一份 PDF 材料给页面看的三个数：总页数、块的总数、没有文字的页码。 */
export interface PdfFacts { pages: number; units: number; no_text_pages: number[] }

const factsCache = new Map<string, { stamp: string; facts: PdfFacts | null }>();

/** 从 PDF 旁边的位置表读出这三个数；位置表不在或者读不出来时是 null。位置表没有变（大小与修改时刻相同）时用上一次读的。 */
export function pdfFacts(pdf: string): PdfFacts | null {
  const file = pdf + PDF_LOCATIONS_SUFFIX;
  let stamp: string;
  try {
    const st = statSync(file, { bigint: true });
    stamp = `${st.size}:${st.mtimeNs}`;
  } catch {
    factsCache.delete(file);
    return null;
  }
  const cached = factsCache.get(file);
  if (cached && cached.stamp === stamp) return cached.facts;
  let facts: PdfFacts | null = null;
  try {
    const table = JSON.parse(readFileSync(file, "utf-8")) as PdfLocationFile;
    facts = {
      pages: table.pages.length,
      units: table.pages.reduce((sum, page) => sum + page.blocks.length, 0),
      no_text_pages: table.pages.filter((page) => page.no_text).map((page) => page.page),
    };
  } catch {
    // 读不出来按没有算
  }
  factsCache.set(file, { stamp, facts });
  return facts;
}
