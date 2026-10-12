/**
 * 把整份生成文档写成一份 Word 文件（.docx）。纯读取，不写库。
 *
 * 文档先照模板渲染成 Markdown（src/render.ts），再用共用的分块函数切成块（agent/src/lib/document_blocks.ts），这里照块写：
 * 页面的预览用的是同一批块，所以 Word 里的章节次序、表格与文字和预览一样。
 * - 一个井号的标题是文档标题；两个、三个、四个井号依次是标题 1、标题 2、标题 3。「目录」之后的第一个标题 1 另起一页。
 * - 列表照层次缩进，无序的前面是圆点，有序的前面是序号。
 * - 表格用「网格型」，表头加粗。
 * - 图：后端没有浏览器，画不了图。页面在下载时把文档里用到的图各转成一张 PNG 随请求交来（images，键是图的编号），这里嵌进去，
 *   宽度不超过版心；没有交来图片的图（不经页面直接调接口时）写一句说明，后面是它的 Mermaid 文本。
 * 字体、字号与导出条目的 Word 文件相同（src/export_docx.ts）。
 */

import { type DocBlock, type DocRun, documentBlocks } from "../../agent/src/lib/document_blocks.ts";
import { ApiError } from "./errors.ts";
import { BODY_SIZE, DOCX_MISSING_TEXT, FONT, HEADING1_SIZE, HEADING2_SIZE, TABLE_GRID_STYLES, loadDocx } from "./export_docx.ts";
import { TOC_TITLE } from "./render_chapters.ts";

type Dict = Record<string, any>;

/** 页面随请求交来的一张图：PNG 的内容与它的像素宽高。 */
export interface FigureImage {
  data: Buffer;
  width: number;
  height: number;
}

/** 图在版心里最宽多少（像素，按 96 点每英寸：A4 纸去掉缺省页边距约 6 英寸）。 */
export const FIGURE_MAX_WIDTH = 576;
/** 一次请求最多带多少张图、图片合计最多多少字节。 */
export const MAX_IMAGES = 80;
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const HEADING3_SIZE = 23;
const TITLE_SIZE = 40;
const MONO = { ascii: "Consolas", hAnsi: "Consolas", eastAsia: "宋体", cs: "Consolas" };
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const noImageText = (diagramId: string | null): string =>
  `（${diagramId ? `图 ${diagramId} ` : "这张图"}没有附上图片：从页面上的「生成文档」下载 Word 时图会画出来。下面是它的 Mermaid 文本。）`;

/** 从请求体取出页面交来的图片：images 是 [{diagram_id, png（base64）, width, height}]。不写就是一张都没有。 */
export function imagesOf(body: Dict): Map<string, FigureImage> {
  const out = new Map<string, FigureImage>();
  const list = body.images ?? [];
  if (!Array.isArray(list)) throw new ApiError("bad_request", "images 要写图片的列表，或者不写。");
  if (list.length > MAX_IMAGES) throw new ApiError("bad_request", `images 最多 ${MAX_IMAGES} 张。`);
  let total = 0;
  for (const one of list as Dict[]) {
    const ok = one && typeof one.diagram_id === "string" && one.diagram_id !== "" && typeof one.png === "string"
      && Number.isFinite(one.width) && Number.isFinite(one.height) && one.width > 0 && one.height > 0;
    if (!ok) throw new ApiError("bad_request", "images 的每一项要写 diagram_id、png（PNG 文件内容的 base64）、width 与 height（像素，大于 0）。");
    const data = Buffer.from(one.png, "base64");
    if (data.length < PNG_HEAD.length || !data.subarray(0, PNG_HEAD.length).equals(PNG_HEAD)) throw new ApiError("bad_request", `images 里 ${one.diagram_id} 的 png 不是一张 PNG 图片。`);
    total += data.length;
    if (total > MAX_IMAGE_BYTES) throw new ApiError("too_large", `随请求交来的图片合计超过了 ${MAX_IMAGE_BYTES / 1024 / 1024} MB。`);
    out.set(one.diagram_id, { data, width: one.width, height: one.height });
  }
  return out;
}

/** 文件名「任务名-修订N.docx」：任务名里不能作文件名的字符换成下划线，太长的截短。 */
export function documentFileName(taskName: string, revisionNo: number): string {
  const cleaned = Array.from(taskName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().replace(/^\.+/, "")).slice(0, 60).join("").trim();
  return `${cleaned || "任务"}-修订${revisionNo}.docx`;
}

/**
 * 把一份文档的 Markdown 文本写成 Word 文件。images 是页面交来的图片（键是图的编号）；title 写进文件的属性。
 */
export async function documentDocx(markdown: string, images: ReadonlyMap<string, FigureImage>, title: string, load: () => Promise<Dict> = loadDocx): Promise<Buffer> {
  const { Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await load().catch((error: unknown) => {
    throw new ApiError("internal", DOCX_MISSING_TEXT, { detail: String((error as Error)?.message ?? error) });
  });
  /** 一截一截的文字写成几个 TextRun：换行处另起一行。 */
  const textRuns = (runs: readonly DocRun[], more: Dict = {}): unknown[] => runs.flatMap((run) =>
    run.text.split("\n").map((line, n) => new TextRun({ text: line, bold: run.bold || undefined, ...(n > 0 ? { break: 1 } : {}), ...more })));
  const cell = (text: string, bold: boolean) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: bold || undefined })] })] });
  const levels = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

  const children: unknown[] = [];
  // 「目录」之后的第一个标题 1 另起一页。
  let afterContents = false;
  const blocks: DocBlock[] = documentBlocks(markdown);
  for (const block of blocks) {
    if (block.kind === "heading") {
      const breakBefore = block.level === 2 && afterContents;
      if (block.level === 2) afterContents = block.text === TOC_TITLE;
      children.push(new Paragraph({ heading: levels[block.level - 1], pageBreakBefore: breakBefore || undefined, children: [new TextRun(block.text)] }));
    } else if (block.kind === "paragraph") {
      children.push(new Paragraph({ children: textRuns(block.runs), spacing: { after: 120 } }));
    } else if (block.kind === "quote") {
      children.push(new Paragraph({ children: textRuns(block.runs, { italics: true }), indent: { left: 360 }, spacing: { after: 120 } }));
    } else if (block.kind === "list") {
      // 序号按层各自数：回到上一层时下一层从头数。
      const counters: number[] = [];
      for (const item of block.items) {
        counters.length = item.depth + 1;
        counters[item.depth] = (counters[item.depth] ?? 0) + 1;
        const mark = block.ordered ? `${counters[item.depth]}. ` : "• ";
        children.push(new Paragraph({ children: [new TextRun(mark), ...textRuns(item.runs)], indent: { left: 360 * (item.depth + 1), hanging: 280 } }));
      }
    } else if (block.kind === "table") {
      const width = Math.max(block.head.length, ...block.rows.map((row) => row.length));
      const padded = (row: string[]) => [...row, ...Array(width - row.length).fill("")];
      children.push(new Table({ style: "TableGrid", width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ tableHeader: true, children: padded(block.head).map((one) => cell(one, true)) }),
          ...block.rows.map((row) => new TableRow({ children: padded(row).map((one) => cell(one, false)) }))] }));
      children.push(new Paragraph({ children: [] }));
    } else if (block.kind === "figure") {
      const image = block.diagram_id ? images.get(block.diagram_id) : undefined;
      if (image) {
        const scale = Math.min(1, FIGURE_MAX_WIDTH / image.width);
        children.push(new Paragraph({ children: [new ImageRun({ type: "png", data: image.data,
          transformation: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) } })], spacing: { after: 120 } }));
      } else {
        children.push(new Paragraph({ children: [new TextRun({ text: noImageText(block.diagram_id), italics: true })] }));
        for (const line of block.mermaid.split("\n")) children.push(new Paragraph({ children: [new TextRun({ text: line, font: MONO, size: 18 })], indent: { left: 360 } }));
        children.push(new Paragraph({ children: [] }));
      }
    } else {
      for (const line of block.text.split("\n")) children.push(new Paragraph({ children: [new TextRun({ text: line, font: MONO, size: 18 })], indent: { left: 360 } }));
    }
  }

  const document = new Document({
    creator: "Taskwright",
    title,
    externalStyles: TABLE_GRID_STYLES,
    styles: { default: {
      document: { run: { font: FONT, size: BODY_SIZE } },
      title: { run: { font: FONT, size: TITLE_SIZE, bold: true } },
      heading1: { run: { font: FONT, size: HEADING1_SIZE, bold: true } },
      heading2: { run: { font: FONT, size: HEADING2_SIZE, bold: true } },
      heading3: { run: { font: FONT, size: HEADING3_SIZE, bold: true } },
    } },
    sections: [{ children }],
  });
  return Packer.toBuffer(document);
}
