// PDF 材料的位置表、原始字节与投影里的各块，按「任务编号 + 材料路径」各读一次、缓存起来（材料上传后不再改：同名的文件再上传会被拒绝，不会覆盖）。
// 例外是删除与替换：还没有进入对话的材料可以删掉、可以换成另一个文件（可以同名），这时由 forgetPdf 丢掉这一份的缓存。
//
// 三样分开读：条目区的来源标签只要位置表（「第 N 页」后面的章节取自它的书签目录），不必为了一个标签把整份 PDF 取回来；
// 材料区显示时三样都要。位置表是上传时任务服务写的 x.pdf.locations.json（格式见 agent/src/lib/pdf_locations.ts）；
// 投影是给助手读的那份文字（每块一行，行首是「[p页-块]」），页面用它来算一段摘录落在哪几块的哪里，与保存修订时的核对
// 用同一个函数（agent/src/lib/pdf_source.ts）。

import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api/client";
import { PDF_LOCATIONS_SUFFIX, type PdfLocationFile } from "../../../agent/src/lib/pdf_locations";
import { type PdfUnit, pdfProjectionUnits } from "../../../agent/src/lib/pdf_source";

export interface PdfLocationsEntry {
  status: "loading" | "ready";
  /** 位置表；读不到、不是合法的位置表时为 null：来源标签就不写章节，材料区按第一页的大小给每一页留位置、没有目录。 */
  locations: PdfLocationFile | null;
}

export interface PdfBytesEntry {
  /** error：读不到文件（接口出错），error 是任务服务给的说明。 */
  status: "loading" | "ready" | "error";
  bytes?: ArrayBuffer;
  error?: string;
}

export interface PdfUnitsEntry {
  status: "loading" | "ready";
  /** 投影里的各块；投影读不到时为 null：来源点过去只能框出那一块，摘录不逐字标，被引用的句子不画底线。 */
  units: PdfUnit[] | null;
}

const locations = new Map<string, PdfLocationsEntry>();
const units = new Map<string, PdfUnitsEntry>();
const bytes = new Map<string, PdfBytesEntry>();
const listeners = new Set<() => void>();
const keyOf = (taskId: string, path: string) => `${taskId}\u0000${path}`;
const notify = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** 读完了：只有缓存里还是开始读时放的那一项才写进去。读的过程中这一项被 forgetPdf 丢掉了（材料被删除或替换），读到的旧文件就不要了。 */
function settle<T>(map: Map<string, T>, key: string, started: T, entry: T): void {
  if (map.get(key) !== started) return;
  map.set(key, entry);
  notify();
}

/** 位置表的文字 → 位置表；不是合法的位置表（没有各页、没有书签目录这两项）时为 null。 */
export function parsePdfLocations(text: string): PdfLocationFile | null {
  try {
    const table = JSON.parse(text) as PdfLocationFile;
    return Array.isArray(table?.pages) && Array.isArray(table?.headings) ? table : null;
  } catch {
    return null;
  }
}

/** 取这份 PDF 材料的位置表；还没读过就开始读（读完通知订阅者）。 */
export function pdfLocationsEntry(taskId: string, path: string): PdfLocationsEntry {
  const key = keyOf(taskId, path);
  let entry = locations.get(key);
  if (!entry) {
    entry = { status: "loading", locations: null };
    locations.set(key, entry);
    const started = entry;
    api.materialContent(taskId, `${path}${PDF_LOCATIONS_SUFFIX}`).then((r) => parsePdfLocations(r.text), () => null)
      .then((table) => settle(locations, key, started, { status: "ready", locations: table }));
  }
  return entry;
}

/** 取这份 PDF 材料的原始字节；还没读过就开始读（读完通知订阅者）。 */
export function pdfBytesEntry(taskId: string, path: string): PdfBytesEntry {
  const key = keyOf(taskId, path);
  let entry = bytes.get(key);
  if (!entry) {
    entry = { status: "loading" };
    bytes.set(key, entry);
    const started = entry;
    api.materialRaw(taskId, path).then(
      (data) => settle(bytes, key, started, { status: "ready", bytes: data }),
      (e: unknown) => settle(bytes, key, started, { status: "error", error: e instanceof ApiError ? e.message : String(e) }),
    );
  }
  return entry;
}

/** 取这份 PDF 材料投影里的各块；还没读过就开始读（读完通知订阅者）。 */
export function pdfUnitsEntry(taskId: string, path: string): PdfUnitsEntry {
  const key = keyOf(taskId, path);
  let entry = units.get(key);
  if (!entry) {
    entry = { status: "loading", units: null };
    units.set(key, entry);
    const started = entry;
    api.materialContent(taskId, path).then((r) => pdfProjectionUnits(r.text), () => null)
      .then((list) => settle(units, key, started, { status: "ready", units: list }));
  }
  return entry;
}

/** 组件里用：位置表。taskId 或 path 为空时不读，返回 null。 */
export function usePdfLocations(taskId: string | null | undefined, path: string | null | undefined): PdfLocationsEntry | null {
  return useSyncExternalStore(subscribe, () => (taskId && path ? pdfLocationsEntry(taskId, path) : null));
}

/** 组件里用：原始字节。taskId 或 path 为空时不读，返回 null。 */
export function usePdfBytes(taskId: string | null | undefined, path: string | null | undefined): PdfBytesEntry | null {
  return useSyncExternalStore(subscribe, () => (taskId && path ? pdfBytesEntry(taskId, path) : null));
}

/** 组件里用：投影里的各块。taskId 或 path 为空时不读，返回 null。 */
export function usePdfUnits(taskId: string | null | undefined, path: string | null | undefined): PdfUnitsEntry | null {
  return useSyncExternalStore(subscribe, () => (taskId && path ? pdfUnitsEntry(taskId, path) : null));
}

/**
 * 这份材料被删除或者被替换了：丢掉它的三项缓存（位置表、原始字节、投影里的各块），下次要显示时重新读，同名的新文件不会显示成旧的。
 * 不通知订阅者：正显示着它的地方不因此重读（材料没了的话，清单会先把它换掉）。
 */
export function forgetPdf(taskId: string, path: string): void {
  const key = keyOf(taskId, path);
  locations.delete(key);
  bytes.delete(key);
  units.delete(key);
}

/** 测试用：清空缓存。 */
export function resetPdfStore(): void {
  units.clear();
  locations.clear();
  bytes.clear();
}
