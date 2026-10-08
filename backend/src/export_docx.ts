/**
 * 把选中的条目导出成一份 Word 文件（.docx）。纯读取，不写库。
 *
 * 导出的总是每个条目最新的修订；已经删除的条目不导出。条目按集合分段：集合照任务定义里的先后，集合名作标题 1；
 * 段内按编号排，每个条目一行标题 2「编号 名称」（名称是集合声明的第一个字段的值，与页面列表里的标题同一个算法），
 * 接一张两列的表：左列字段名、右列字段值，这个集合声明的字段每个一行、照声明的先后。空字段写「（空）」；文本列表每项一段、
 * 前面带序号；条目引用与别的多值用顿号连起来。带来源时表的最后一行是「来源」，一条来源一段，写成「种类 · 出处：摘录」
 * （叫法与生成文档相同，见 render.ts 的 sourceEntries）；条目没有来源时写「（无）」。
 *
 * 字体：中文宋体，西文与数字 Calibri（Word 文件里字体分中文、西文几处写，没有「找不到就换一种」的写法）。
 * 表格引用 Word 内置的「网格型」样式，并把这一条样式的定义带进文件；表上另写着框线，不认表格样式的软件里也有线。
 * 页边距用 Word 的缺省值。
 *
 * 写 Word 文件用 docx 包（版本固定）。头一次导出时才加载：安装包里从 backend/vendor/docx/ 取构建时打好的那一份，
 * 仓库里经 docx_lib.mjs 从仓根的 node_modules 取。
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FIELD_ITEM_REF, FIELD_TEXT_LIST } from "../../agent/src/lib/definition.ts";
import { ApiError } from "./errors.ts";
import { type Library, titleOf } from "./library.ts";
import { fromRoot } from "./paths.ts";
import { or } from "./py.ts";
import { NO_SOURCES_TEXT, sourceEntries } from "./render.ts";

type Dict = Record<string, any>;
type Locate = (locator: string) => string | null;
type LibraryName = (id: string) => string | null;

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const EMPTY_TEXT = "（空）";
export const SOURCES_LABEL = "来源";
/** 文件名里任务名最多留这么多个字。 */
const NAME_LIMIT = 60;
/** 表的两列各占的宽度（百分比）。 */
const LABEL_WIDTH = 22;
const VALUE_WIDTH = 78;
/** 字体：中文宋体，其余 Calibri。字号以半磅计：正文 10.5 磅（五号），标题 1 是 16 磅，标题 2 是 13 磅。 */
const FONT = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "宋体", cs: "Calibri" };
const BODY_SIZE = 21;
const HEADING1_SIZE = 32;
const HEADING2_SIZE = 26;

/** Word 内置的「网格型」表格样式（Table Grid）的定义：docx 包没有定义表格样式的写法，经它的 externalStyles 带进样式表。 */
const TABLE_GRID_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders>'
  + ["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("")
  + "</w:tblBorders></w:tblPr></w:style></w:styles>";

let loading: Promise<Dict> | null = null;

export const DOCX_MISSING_TEXT = "导出 Word 要用的 docx 包没有装上，这一次没有导出。";

/** 加载 docx 包里用到的那几样：安装包里是构建时打好的那一份，仓库里是 docx_lib.mjs。没有加载成时下一次再试。 */
function loadDocx(): Promise<Dict> {
  const packed = fromRoot("backend/vendor/docx/docx_lib.mjs");
  loading ??= import(existsSync(packed) ? pathToFileURL(packed).href : new URL("./docx_lib.mjs", import.meta.url).href);
  loading.catch(() => { loading = null; });
  return loading;
}

/** 从请求体取出 [要导出的条目编号, 带不带来源]。 */
export function docxRequest(body: Dict): [string[], boolean] {
  if (body.revision_no !== undefined && body.revision_no !== null) {
    throw new ApiError("bad_request", "导出 Word 总是导出每个条目最新的修订，不能写 revision_no。");
  }
  const items = body.items;
  if (!Array.isArray(items) || !items.length || !items.every((i) => typeof i === "string" && i !== "")) {
    throw new ApiError("bad_request", "items 要写要导出的条目编号的列表，不能是空的。");
  }
  const withSources = body.with_sources ?? true;
  if (typeof withSources !== "boolean") throw new ApiError("bad_request", "with_sources 要写 true 或 false，或者不写（带上来源）。");
  return [[...new Set(items as string[])], withSources];
}

/** 文件名「任务名-条目-年-月-日.docx」：任务名里不能作文件名的字符换成下划线，太长的截短；日期取本机当天。 */
export function docxFileName(taskName: string, today: Date = new Date()): string {
  const cleaned = Array.from(taskName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().replace(/^\.+/, "")).slice(0, NAME_LIMIT).join("").trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${cleaned || "任务"}-条目-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.docx`;
}

/** 下载这份文件时的 Content-Disposition：文件名带中文，按 RFC 5987 写在 filename* 里；另给一个只有英文数字的 filename，给不认 filename* 的软件用。 */
export function docxDisposition(fileName: string, taskId: string): string {
  const plain = `${taskId.replace(/[^A-Za-z0-9._-]+/g, "_")}-items.docx`;
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

const blank = (value: unknown) => value === null || value === undefined || value === "";
const text = (value: unknown) => (typeof value === "object" ? JSON.stringify(value) : String(value));

/** 一个字段的值在右格里写成几段。 */
export function valueLines(value: unknown, fieldType: string): string[] {
  if (blank(value) || (Array.isArray(value) && value.length === 0)) return [EMPTY_TEXT];
  if (Array.isArray(value)) {
    const parts = value.map((one) => (blank(one) ? EMPTY_TEXT : text(one)));
    if (fieldType === FIELD_TEXT_LIST) return parts.map((one, n) => `${n + 1}. ${one}`);
    return [parts.join("、")];
  }
  // 一段文字里的换行各成一段；空行不要。
  const lines = text(value).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.length ? lines : [EMPTY_TEXT];
}

/** 一条来源写成一行「种类 · 出处：摘录」；没有出处的只写种类与摘录，没有摘录的不写冒号后面那半句。 */
export function sourceLine(entry: { kind: string; where: string; excerpt: string }): string {
  return `${entry.kind}${entry.where ? ` · ${entry.where}` : ""}${entry.excerpt ? `：${entry.excerpt}` : ""}`;
}

export interface DocxFile { fileName: string; data: Buffer }

/**
 * 导出。items 是要导出的条目编号（先后不论）；交付物里从来没有过的编号、交付物还没有修订、选中的都已删除，都报 bad_request。
 * load 是加载 docx 包的办法，测试里换成加载不了的，看那时怎样说。
 */
export async function exportItemsDocx(lib: Library, items: string[], withSources: boolean, wordsLocator: Locate | null = null,
  libraryName: LibraryName | null = null, today: Date = new Date(), load: () => Promise<Dict> = loadDocx): Promise<DocxFile> {
  const latest = lib.latestRevision();
  if (latest === 0) throw new ApiError("bad_request", "交付物还没有任何修订，没有东西可以导出。");
  const unknown = items.filter((id) => !lib.items.has(id));
  if (unknown.length) throw new ApiError("bad_request", `交付物里没有这些条目：${unknown.join("、")}。`, { items: unknown });
  const alive = new Map(lib.aliveAt(latest));
  const chosen = items.filter((id) => alive.has(id));
  if (!chosen.length) throw new ApiError("bad_request", "选中的条目都已经删除，没有可以导出的。");

  // 包没有装上（仓库里没有装依赖，或者安装包里缺文件）：说明白，不让它变成一句「后端出错了」。
  const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await load().catch((error: unknown) => {
    throw new ApiError("internal", DOCX_MISSING_TEXT, { detail: String((error as Error)?.message ?? error) });
  });
  const paragraph = (line: string) => new Paragraph({ children: [new TextRun(line)] });
  const cell = (lines: string[], width: number) => new TableCell({ width: { size: width, type: WidthType.PERCENTAGE }, children: lines.map(paragraph) });
  const row = (label: string, lines: string[]) => new TableRow({ children: [cell([label], LABEL_WIDTH), cell(lines, VALUE_WIDTH)] });

  const children: unknown[] = [];
  for (const [name, collection] of lib.collections) {
    const mine = chosen.filter((id) => lib.items.get(id)!.collection === name).sort((a, b) => lib.items.get(a)!.serial - lib.items.get(b)!.serial);
    if (!mine.length) continue;
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(name)] }));
    for (const id of mine) {
      const revisionNo = alive.get(id)!;
      const fields = (lib.fieldsOf(id, revisionNo) ?? {}) as Dict;
      const title = titleOf(fields, collection);
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(title ? `${id} ${title}` : id)] }));
      const rows = (collection["字段"] ?? []).map((field: Dict) => row(String(field["名"]), valueLines(fields[field["名"]], String(or(field["类型"], "")))));
      if (withSources) {
        const lines = sourceEntries(lib, id, revisionNo, wordsLocator, libraryName).map(sourceLine);
        rows.push(row(SOURCES_LABEL, lines.length ? lines : [NO_SOURCES_TEXT]));
      }
      children.push(new Table({ style: "TableGrid", width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      // 表与下一个标题之间空一行。
      children.push(new Paragraph({ children: [] }));
    }
  }

  const taskName = String(or(lib.data.task?.task_name, lib.definition["任务名"]) ?? lib.taskId);
  const document = new Document({
    creator: "Taskwright",
    title: `${taskName}-条目`,
    externalStyles: TABLE_GRID_STYLES,
    styles: { default: {
      document: { run: { font: FONT, size: BODY_SIZE } },
      heading1: { run: { font: FONT, size: HEADING1_SIZE, bold: true } },
      heading2: { run: { font: FONT, size: HEADING2_SIZE, bold: true } },
    } },
    sections: [{ children }],
  });
  return { fileName: docxFileName(taskName, today), data: await Packer.toBuffer(document) };
}
