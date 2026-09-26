/**
 * Word 材料的分段清单：把一份投影（lib/docx_markdown.ts 写的「x.docx.md」）按标题分成若干块，每块记起止段落号与起止行号，
 * 执行者先读清单，再按块 read 投影；任务状态里「还有几段没有被任何条目引用」也按块统计。
 *
 * 块怎样分（参数来自启动配置的「材料分段」一节，见 SegmentParams）：
 * - 标题行（以 1 到 6 个 # 开头、带段落号的行）的级别不超过 heading_depth 时，它开始一块；第一个这样的标题之前的段落是一块，标题为 null；
 *   没有这样的标题的材料整份一块。块按段落号首尾相接，覆盖 1 到段落总数。
 * - 有文字的段少于 min_paragraphs 的块并入下一块，最后一块不够时并入前一块；合并后的标题是各块标题依次用「；」连起来。
 * - 有文字的段多于 max_paragraphs 的块切成 ceil(段数 / max_paragraphs) 块，前面各块段数相同（ceil(段数 / 块数)），标题相同。
 * 段数只数有文字的段：空段落不写进投影、也不能被引用，但占着段落号。
 *
 * 清单存成材料旁边的「x.docx.segments.json」，文件头记参数的摘要：上传时随投影一起写；读时摘要与当前参数不一致或文件不在，
 * 就从投影重算并写回（readSegments，这是读侧唯一写文件的地方，写在材料目录里，不写库）。0.2 的任务只有纯文本投影「x.docx.txt」，
 * 清单照样能算，但不写文件。
 *
 * 引用情况（citationCounts）从来源表算：当前有效条目的当前修订里，种类为「文档原文」、出处是这份 Word 文件加段落号的来源，
 * 摘录跨段的（lib/docx_source.ts 的 placeExcerpt）算到它跨过的每一段；每块数的是引用到它的条目个数，与界面同一个口径。只读库。
 *
 * 本模块只用 Node 自带模块，不依赖 pi。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isLegacyProjection, placeExcerpt, projectionParagraphs } from "./docx_source.ts";

/** 分段清单跟在 Word 文件路径后面的后缀：x.docx → x.docx.segments.json。 */
export const SEGMENTS_SUFFIX = ".segments.json";

/** 后端把启动配置里的分段参数经这个环境变量交给 pi 里的扩展（一段 JSON）。 */
export const SEGMENTS_ENV = "TASKWRIGHT_SEGMENTS";

/** 清单文件的格式版本。 */
export const SEGMENTS_VERSION = 1;

/** 分段参数，含义见启动配置「材料分段」一节的说明。 */
export interface SegmentParams {
  heading_depth: number;
  max_paragraphs: number;
  min_paragraphs: number;
}

/** 启动配置没写某一项时用的值（后端 Python 版的 launch.SEGMENT_DEFAULTS 与它相同）。 */
export const SEGMENT_DEFAULTS: Readonly<SegmentParams> = Object.freeze({ heading_depth: 3, max_paragraphs: 300, min_paragraphs: 3 });

export interface SegmentBlock {
  /** 第几块，从 1 起。 */
  index: number;
  /** 开始这一块的标题文字（带段落号左边的自动编号，不带 # 与段落号），几块合并的用「；」连起来；第一个标题之前的那块、没有标题的材料是 null。 */
  heading: string | null;
  first_paragraph: number;
  last_paragraph: number;
  /** 这一块在投影文件里的起止行号（从 1 起，与 read 的 offset 同一个数法）。 */
  first_line: number;
  last_line: number;
  /** 有文字的段数。 */
  paragraphs: number;
  /** 各段文字的字数之和。 */
  chars: number;
}

export interface SegmentList {
  version: number;
  说明: string;
  params_digest: string;
  /** Word 文件相对任务目录的路径，例如 inputs/x.docx。 */
  source: string;
  /** 投影相对任务目录的路径，例如 inputs/x.docx.md。 */
  projection: string;
  /** 段落总数（与投影开头的「段落总数」相同，含空段落）。 */
  paragraphs: number;
  blocks: SegmentBlock[];
}

const NOTE = "行号只对同目录里当前这份投影文件有效；块里的 paragraphs 只数有文字的段。";

/** 把一段参数（JSON 文字或对象）整理成完整的参数：没写的一项用默认值；写了但不是正整数时抛异常。 */
export function segmentParams(raw?: string | Partial<SegmentParams> | null): SegmentParams {
  let given: Record<string, unknown> = {};
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      given = JSON.parse(raw);
    } catch {
      throw new Error(`分段参数不是合法的 JSON：${raw}`);
    }
  } else if (raw && typeof raw === "object") {
    given = raw as Record<string, unknown>;
  }
  const out = { ...SEGMENT_DEFAULTS };
  for (const name of Object.keys(SEGMENT_DEFAULTS) as (keyof SegmentParams)[]) {
    const value = given[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`分段参数 ${name} 应当是正整数，现在是 ${JSON.stringify(value)}`);
    out[name] = value;
  }
  return out;
}

/** 当前进程的分段参数：来自环境变量 TASKWRIGHT_SEGMENTS；没设或写错时用默认值（执行者这边不因为它停下）。 */
export function envSegmentParams(env: NodeJS.ProcessEnv = process.env): SegmentParams {
  try {
    return segmentParams(env[SEGMENTS_ENV]);
  } catch {
    return { ...SEGMENT_DEFAULTS };
  }
}

/** 参数的摘要：三项按固定顺序写成 JSON 的 sha256 前 16 位。 */
export function paramsDigest(params: SegmentParams): string {
  const canonical = JSON.stringify({ heading_depth: params.heading_depth, max_paragraphs: params.max_paragraphs, min_paragraphs: params.min_paragraphs });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const ANCHOR_G = /\[p(\d+)\]/g;
const LEGACY_LINE = /^\[第 (\d+) 段/;
const HEADING = /^(#{1,6}) /;

interface Draft {
  headings: string[];
  first: number;
  last: number;
}

/** 投影全文 → 分段清单。source 与 projection 是写进清单的两个相对路径。 */
export function buildSegments(text: string, params: SegmentParams, source: string, projection: string): SegmentList {
  const paragraphs = projectionParagraphs(text);
  const total = paragraphs.length;
  const hasText = (n: number) => (paragraphs[n - 1] ?? "").trim() !== "";
  const legacy = isLegacyProjection(text);
  const lines = text.split("\n");
  // 每段在第几行（表格一行里有好几段），以及可以作块界的标题段。开头的说明注释不算。
  const lineOf = new Map<number, number>();
  const headings: { n: number; text: string }[] = [];
  let inComment = false;
  let bodyStart = 0;
  lines.forEach((line, i) => {
    if (!legacy && inComment) {
      if (line.includes("-->")) inComment = false;
      return;
    }
    if (!legacy && line.trimStart().startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      return;
    }
    if (!bodyStart && line.trim() !== "") bodyStart = i + 1;
    if (legacy) {
      const m = LEGACY_LINE.exec(line);
      if (m && !lineOf.has(Number(m[1]))) lineOf.set(Number(m[1]), i + 1);
      return;
    }
    if (line.startsWith(">")) return;
    const found = [...line.matchAll(ANCHOR_G)].map((m) => Number(m[1]));
    for (const n of found) if (!lineOf.has(n)) lineOf.set(n, i + 1);
    const h = HEADING.exec(line);
    // 标题文字连同段落号左边的自动编号一起记（「1.2 范围」），去掉 # 与段落号。
    if (h && found.length && h[1].length <= params.heading_depth) {
      headings.push({ n: found[0], text: line.slice(h[0].length).replace(ANCHOR_G, "").replace(/\s+/g, " ").trim() });
    }
  });

  // 按标题切。
  let drafts: Draft[] = [];
  let start = 1;
  let heading: string[] = [];
  for (const h of headings) {
    if (h.n <= start) {
      if (h.n === start && h.text) heading = [h.text];
      continue;
    }
    drafts.push({ headings: heading, first: start, last: h.n - 1 });
    start = h.n;
    heading = h.text ? [h.text] : [];
  }
  if (total >= start) drafts.push({ headings: heading, first: start, last: total });
  const count = (d: Draft) => {
    let c = 0;
    for (let n = d.first; n <= d.last; n++) if (hasText(n)) c++;
    return c;
  };

  // 太小的并入下一块，最后一块不够时并入前一块。
  const merged: Draft[] = [];
  let carry: Draft | null = null;
  for (const d of drafts) {
    const cur: Draft = carry ? { headings: [...carry.headings, ...d.headings], first: carry.first, last: d.last } : d;
    if (count(cur) < params.min_paragraphs) carry = cur;
    else {
      merged.push(cur);
      carry = null;
    }
  }
  if (carry) {
    const prev = merged.pop();
    merged.push(prev ? { headings: [...prev.headings, ...carry.headings], first: prev.first, last: carry.last } : carry);
  }
  drafts = merged;

  // 太大的按段数平均切开。
  const cut: Draft[] = [];
  for (const d of drafts) {
    const n = count(d);
    if (n <= params.max_paragraphs) {
      cut.push(d);
      continue;
    }
    const pieces = Math.ceil(n / params.max_paragraphs);
    const size = Math.ceil(n / pieces);
    let first = d.first;
    let seen = 0;
    for (let p = d.first; p <= d.last; p++) {
      if (hasText(p)) seen++;
      if (seen === size && p < d.last) {
        cut.push({ headings: d.headings, first, last: p });
        first = p + 1;
        seen = 0;
      }
    }
    cut.push({ headings: d.headings, first, last: d.last });
  }

  // 起止行号：块从它第一段所在的行开始，到下一块开始之前最后一个非空行为止（段落之间的文本框、图片行算在前一块里）。
  const lastNonEmpty = (upTo: number) => {
    let i = upTo;
    while (i > 0 && lines[i - 1].trim() === "") i--;
    return i;
  };
  const firstLineOf = (d: Draft, k: number) => {
    if (k === 0) return bodyStart || 1;
    for (let n = d.first; n <= d.last; n++) if (lineOf.has(n)) return lineOf.get(n)!;
    return 0;
  };
  const starts = cut.map(firstLineOf);
  const blocks: SegmentBlock[] = cut.map((d, k) => {
    const first = starts[k] || (k > 0 ? starts[k - 1] : 1);
    const next = starts.slice(k + 1).find((s) => s > 0);
    let chars = 0;
    for (let n = d.first; n <= d.last; n++) chars += [...(paragraphs[n - 1] ?? "")].length;
    return {
      index: k + 1,
      heading: d.headings.length ? d.headings.join("；") : null,
      first_paragraph: d.first,
      last_paragraph: d.last,
      first_line: first,
      last_line: Math.max(first, lastNonEmpty(next ? next - 1 : lines.length)),
      paragraphs: count(d),
      chars,
    };
  });
  return { version: SEGMENTS_VERSION, 说明: NOTE, params_digest: paramsDigest(params), source, projection, paragraphs: total, blocks };
}

/**
 * 读一份 Word 材料的分段清单。projectionPath 是投影文件的路径（x.docx.md，或 0.2 的 x.docx.txt），
 * source 与 projection 是写进清单的相对路径。Markdown 投影：清单文件在、版本与参数摘要都对就用它，否则从投影重算并写回
 * （写不成也照样返回算出来的清单）；纯文本投影：现算，不写文件。投影读不到时返回 null。
 */
export function readSegments(projectionPath: string, params: SegmentParams, source: string, projection: string): SegmentList | null {
  let text: string;
  try {
    text = readFileSync(projectionPath, "utf-8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
  const legacy = /\.txt$/i.test(projectionPath);
  const file = projectionPath.replace(/\.(md|txt)$/i, "") + SEGMENTS_SUFFIX;
  const digest = paramsDigest(params);
  if (!legacy && existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf-8")) as SegmentList;
      if (saved.version === SEGMENTS_VERSION && saved.params_digest === digest && Array.isArray(saved.blocks)) return saved;
    } catch {
      // 坏了就重算
    }
  }
  const list = buildSegments(text, params, source, projection);
  if (!legacy) {
    try {
      writeSegments(file, list);
    } catch {
      // 写不成不影响这一次读
    }
  }
  return list;
}

/** 把清单写成文件（两格缩进的 JSON，末尾换行）。 */
export function writeSegments(file: string, list: SegmentList): void {
  writeFileSync(file, JSON.stringify(list, null, 2) + "\n", "utf-8");
}

/** 一块的引用情况。 */
export interface BlockCitations {
  index: number;
  /** 引用到这一块里某一段的条目个数（一个条目有几条来源引到这一块也只算一个）。 */
  items: number;
  /** 这一块里有文字、却没有被任何来源引用的段数。 */
  uncited: number;
}

export interface CitationCounts {
  blocks: BlockCitations[];
  /** 整份材料里有文字、没有被任何来源引用的段数。 */
  uncited: number;
  /** 整份材料里有文字的段数。 */
  text_paragraphs: number;
}

interface SourceRow {
  item_id: string;
  position: number;
  locator: string;
  excerpt: string;
}

/** 当前有效条目的当前修订里，种类为「文档原文」的来源（每条来源一行）。 */
export function currentDocumentSources(db: DatabaseSync, taskId: string): SourceRow[] {
  return db
    .prepare(
      "SELECT s.item_id, s.position, s.locator, s.excerpt FROM item_source s JOIN item i ON i.task_id = s.task_id AND i.item_id = s.item_id " +
        "WHERE s.task_id = ? AND s.kind = '文档原文' AND s.support_no = 1 AND i.deleted_in_revision IS NULL " +
        "AND s.revision_no = (SELECT MAX(revision_no) FROM item_version v WHERE v.task_id = s.task_id AND v.item_id = s.item_id) " +
        "ORDER BY s.item_id, s.position",
    )
    .all(taskId) as unknown as SourceRow[];
}

/** 出处的文件部分与材料路径是不是同一份（写全了相对路径，或只写了文件名）。 */
export function sameMaterial(locatorPath: string, rel: string): boolean {
  const a = locatorPath.replace(/^\.\//, "");
  return a === rel || basename(a) === basename(rel);
}

/**
 * 一份 Word 材料每块被引用的情况。rel 是 Word 文件相对任务目录的路径，projectionText 是投影全文（算摘录跨段用）。
 */
export function citationCounts(db: DatabaseSync, taskId: string, list: SegmentList, rel: string, projectionText: string): CitationCounts {
  const paragraphs = projectionParagraphs(projectionText);
  const cited = new Map<number, Set<string>>();
  for (const row of currentDocumentSources(db, taskId)) {
    const m = /^(.+\.docx)#p(\d+)$/i.exec(row.locator);
    if (!m || !sameMaterial(m[1], rel)) continue;
    const n = Number(m[2]);
    const place = placeExcerpt(paragraphs, n, row.excerpt);
    const last = place.kind === "span" ? place.last : n;
    for (let p = n; p <= last; p++) {
      if (!cited.has(p)) cited.set(p, new Set());
      cited.get(p)!.add(row.item_id);
    }
  }
  const hasText = (n: number) => (paragraphs[n - 1] ?? "").trim() !== "";
  let uncited = 0;
  let textParagraphs = 0;
  const blocks = list.blocks.map((b) => {
    const items = new Set<string>();
    let blank = 0;
    for (let p = b.first_paragraph; p <= b.last_paragraph; p++) {
      if (!hasText(p)) continue;
      textParagraphs++;
      const who = cited.get(p);
      if (who) for (const one of who) items.add(one);
      else blank++;
    }
    uncited += blank;
    return { index: b.index, items: items.size, uncited: blank };
  });
  return { blocks, uncited, text_paragraphs: textParagraphs };
}

/** 一份文本材料（.md、.txt）被引用的次数：出处（去掉 # 之后的部分）是这份文件的「文档原文」来源条数。 */
export function fileCitationCount(db: DatabaseSync, taskId: string, rel: string): number {
  return currentDocumentSources(db, taskId).filter((row) => sameMaterial(row.locator.replace(/#.*$/, ""), rel)).length;
}

/** 一份 Word 材料的分段与引用情况（任务现状消息与「查询任务状态」用）。 */
export interface WordMaterialFacts {
  kind: "word";
  /** Word 文件相对任务目录的路径。 */
  path: string;
  projection: string;
  /** 分段清单文件相对任务目录的路径；0.2 的任务（纯文本投影）没有这个文件，是 null。 */
  segments_file: string | null;
  /** 段落总数（含空段落）。 */
  paragraphs: number;
  text_paragraphs: number;
  uncited: number;
  blocks: (SegmentBlock & { items: number; uncited: number })[];
}

/** 一份文本材料（.md、.txt）被引用的次数。 */
export interface TextMaterialFacts {
  kind: "text";
  path: string;
  cited: number;
}

export type MaterialFacts = WordMaterialFacts | TextMaterialFacts;

const PROJECTION_OF = /\.docx\.(md|txt)$/i;

/**
 * 材料目录里每份材料的分段与引用情况，按 paths 的顺序：旁边有投影的 .docx 给分段明细（readSegments，必要时重算清单并写回），
 * 不是投影的 .md、.txt 给被引用次数；别的文件（投影、分段清单、没有投影的 .docx）不列。paths 是相对任务目录的路径。
 */
export function materialFacts(db: DatabaseSync, taskId: string, workspaceDir: string, paths: string[], params: SegmentParams): MaterialFacts[] {
  const present = new Set(paths);
  const out: MaterialFacts[] = [];
  for (const path of paths) {
    if (/\.docx$/i.test(path)) {
      const projection = present.has(`${path}.md`) ? `${path}.md` : present.has(`${path}.txt`) ? `${path}.txt` : null;
      if (!projection) continue;
      const full = join(workspaceDir, projection);
      const list = readSegments(full, params, path, projection);
      if (!list) continue;
      const counts = citationCounts(db, taskId, list, path, readFileSync(full, "utf-8").replace(/\r\n/g, "\n"));
      out.push({
        kind: "word",
        path,
        projection,
        segments_file: projection.endsWith(".md") ? `${path}${SEGMENTS_SUFFIX}` : null,
        paragraphs: list.paragraphs,
        text_paragraphs: counts.text_paragraphs,
        uncited: counts.uncited,
        blocks: list.blocks.map((b, i) => ({ ...b, items: counts.blocks[i].items, uncited: counts.blocks[i].uncited })),
      });
    } else if (/\.(md|txt)$/i.test(path) && !PROJECTION_OF.test(path)) {
      out.push({ kind: "text", path, cited: fileCitationCount(db, taskId, path) });
    }
  }
  return out;
}
